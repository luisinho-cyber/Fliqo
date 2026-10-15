import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { SCHEMA_FILA, criarFila, FILA_ATRASOS } from '@fliqo/db/fila';
import {
  ownerPool,
  prepararFilaDeTeste,
  resetDatabase,
  seed,
  urlDoTester,
} from '@fliqo/db/testing';
import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * O worker de verdade, subido como processo, consumindo um job de verdade.
 *
 * Os outros testes de apps/worker chamam as funções direto — provam a regra, não
 * a ligação. `boss.work` só existe em src/index.ts, e nada provava que o papel da
 * aplicação (fliqo_app, com `migrate: false` e sem direito de criar schema)
 * consegue TIRAR trabalho da fila, só colocar. Se um grant do schema `pgboss`
 * faltasse, todo teste continuaria verde e nenhum paciente seria respondido.
 *
 * O job escolhido é o de atrasos numa clínica sem consulta no dia: `varrerClinica`
 * volta na primeira linha, sem WhatsApp e sem modelo. O que está sob teste é o
 * caminho — start, work, claim, completed — não o que a varredura decide.
 */

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));
const BOOT_TIMEOUT_MS = 60_000;
const SAIDA_TIMEOUT_MS = 30_000;

/**
 * O worker recusa qualquer DATABASE_URL que não conecte como `fliqo_app`
 * (URL_DA_APLICACAO, em packages/core) — e está certo: o dono do schema não
 * passa pela RLS. Então o teste faz com o papel do banco de teste o que o
 * `db:papel-app` faz em produção: dá login e senha. O afterAll devolve o
 * `nologin`, para nenhum teste seguinte entrar com a senha deste arquivo.
 */
const PAPEL_DA_APLICACAO = 'fliqo_app';
const SENHA_DO_PAPEL = 'senha-de-teste-do-worker-que-sobe';

let owner: pg.Pool;
let boss: PgBoss;
let worker: ChildProcess;
let porta: number;
let clinicA: string;
/** Tudo que o worker escreveu, para o teste que falha dizer por quê. */
let saidaDoWorker = '';

/** Porta livre do sistema: dois testes de porta fixa brigam no mesmo runner. */
async function portaLivre(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const endereco = s.address();
  if (endereco === null || typeof endereco === 'string') throw new Error('sem porta');
  const { port } = endereco;
  await new Promise<void>((resolve, reject) => {
    s.close((e) => (e ? reject(e) : resolve()));
  });
  return port;
}

async function health(): Promise<Response> {
  return fetch(`http://127.0.0.1:${porta}/health`);
}

/** Espera o /health responder 200 — é isto que significa "o worker subiu". */
async function esperarDePe(): Promise<void> {
  const limite = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (worker.exitCode !== null) {
      throw new Error(
        `o worker saiu antes de subir (código ${worker.exitCode}):\n${saidaDoWorker}`,
      );
    }
    try {
      const r = await health();
      if (r.status === 200) return;
    } catch {
      // ainda não está ouvindo
    }
    if (Date.now() > limite) {
      throw new Error(`o worker não subiu em ${BOOT_TIMEOUT_MS} ms:\n${saidaDoWorker}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A conexão do worker: mesmo banco de teste, mas pelo papel da aplicação. */
function urlDaAplicacao(): string {
  const u = new URL(urlDoTester());
  u.username = PAPEL_DA_APLICACAO;
  u.password = SENHA_DO_PAPEL;
  return u.toString();
}

async function estadoDoJob(id: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ state: string }>(
    `select state from ${SCHEMA_FILA}.job where id = $1`,
    [id],
  );
  return rows[0]?.state;
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  ({ clinicA } = await seed(owner));
  await owner.query(`alter role ${PAPEL_DA_APLICACAO} with login password '${SENHA_DO_PAPEL}'`);
  porta = await portaLivre();

  // O ambiente do worker é montado como em produção, e não herdado do runner:
  // `recusarAdminUrl` recusa subir com DATABASE_ADMIN_URL no ambiente, e os
  // testes de banco a têm definida. Passar o ambiente do runner inteiro seria
  // dar ao worker a conexão de dono — exatamente o que a regra 2 proíbe.
  const ambiente = { ...process.env };
  delete ambiente.DATABASE_ADMIN_URL;
  worker = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/worker/src/index.ts'], {
    cwd: RAIZ,
    env: {
      ...ambiente,
      DATABASE_URL: urlDaAplicacao(),
      // Segredos de mentira: nenhum caminho deste teste chega a uma rede externa.
      WHATSAPP_TOKEN: 'token-de-teste',
      ANTHROPIC_API_KEY: 'chave-de-teste',
      PORT: String(porta),
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout?.on('data', (c: Buffer) => (saidaDoWorker += c.toString()));
  worker.stderr?.on('data', (c: Buffer) => (saidaDoWorker += c.toString()));

  boss = criarFila(urlDaAplicacao());
  await boss.start();
}, 120_000);

afterAll(async () => {
  // Se o teste de SIGTERM não chegou a rodar, o processo ainda está de pé.
  if (worker.exitCode === null) worker.kill('SIGKILL');
  await boss.stop();
  // Devolve o `nologin` que a migração 0001 dá ao papel: a senha deste arquivo
  // não pode servir para nenhum teste seguinte nem para um script rodado sem querer.
  await owner.query(`alter role ${PAPEL_DA_APLICACAO} with nologin`);
  await owner.end();
});

describe('o worker sobe e tira trabalho da fila', () => {
  it('um job enfileirado pela aplicação sai da fila concluído', async () => {
    await esperarDePe();

    const id = await boss.send({ name: FILA_ATRASOS, data: { clinicId: clinicA } });
    if (id === null) throw new Error('o enfileiramento não devolveu id de job');

    // O job existe desde o commit do send. Se o worker for rápido já estará
    // 'active' ou 'completed' — o que não pode é não existir.
    expect(await estadoDoJob(id)).toBeDefined();

    const limite = Date.now() + 30_000;
    let estado = await estadoDoJob(id);
    while (estado !== 'completed' && Date.now() < limite) {
      if (estado === 'failed') {
        throw new Error(`o worker pegou o job e ele falhou:\n${saidaDoWorker}`);
      }
      await new Promise((r) => setTimeout(r, 200));
      estado = await estadoDoJob(id);
    }

    expect(estado, `o job não saiu da fila:\n${saidaDoWorker}`).toBe('completed');

    // E o worker continua de pé depois de trabalhar.
    expect((await health()).status).toBe(200);
  }, 120_000);

  it('SIGTERM encerra o worker sem código de erro', async () => {
    const saiu = new Promise<number | null>((resolve) => {
      worker.once('exit', (codigo) => resolve(codigo));
    });
    worker.kill('SIGTERM');

    const codigo = await Promise.race([
      saiu,
      new Promise<'prazo'>((r) => setTimeout(() => r('prazo'), SAIDA_TIMEOUT_MS)),
    ]);

    expect(codigo, `o worker não encerrou em ${SAIDA_TIMEOUT_MS} ms:\n${saidaDoWorker}`).toBe(0);
  }, 60_000);
});
