import { criarDb, withClinic, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { createHmac } from 'node:crypto';
import { Writable } from 'node:stream';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';

/**
 * Erro inesperado responde com corpo fixo; o detalhe vai só para o log.
 *
 * O handler padrão do Fastify devolvia `error.message` no corpo do 500. No webhook, com o
 * banco fora, isso entregou host e porta internos a um chamador não autenticado — e mensagem
 * de erro do Postgres pode carregar nome de tabela, de coluna e valor de linha.
 */

const SEGREDO = 'segredo-do-app-da-meta-de-teste';
const CORPO_DO_500 = { erro: 'erro_interno' };

const config: Config = {
  DATABASE_URL: 'nao-usado-no-teste',
  WHATSAPP_APP_SECRET: SEGREDO,
  WHATSAPP_VERIFY_TOKEN: 'token-de-verificacao',
  SUPABASE_JWT_SECRET: 'segredo-jwt-de-teste',
  META_APP_ID: 'app-de-teste',
  META_APP_SECRET: 'segredo-do-app-de-teste',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

/** O log da app, inteiro, para conferir que o detalhe que saiu do corpo chegou aqui. */
function capturarLog(): { fluxo: Writable; texto: () => string } {
  const linhas: string[] = [];
  return {
    fluxo: new Writable({
      write(pedaco, _cod, pronto) {
        linhas.push(String(pedaco));
        pronto();
      },
    }),
    texto: () => linhas.join(''),
  };
}

function eventoAssinado(): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '109876543210987' },
              messages: [
                {
                  id: 'wamid.ERRO-GENERICO',
                  from: '5511900000000',
                  type: 'text',
                  text: { body: 'oi' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SEGREDO).update(payload).digest('hex')}`,
    },
  };
}

describe('webhook com o banco fora: a rota real', () => {
  let app: FastifyInstance;
  let db: Db;
  const log = capturarLog();

  beforeAll(async () => {
    // Porta 1, ninguém escuta: o primeiro acesso ao banco falha com ECONNREFUSED.
    const url = 'postgresql://ninguem@127.0.0.1:1/nada';
    db = criarDb(url);
    app = construirApp({ config, db, boss: criarFila(url), fluxoDeLog: log.fluxo });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('responde 500 com o corpo fixo, e nada do erro', async () => {
    const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', ...eventoAssinado() });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual(CORPO_DO_500);
    for (const agulha of ['ECONNREFUSED', '127.0.0.1', 'connect', 'stack', 'message']) {
      expect(r.body, `o corpo conta "${agulha}"`).not.toContain(agulha);
    }
  });

  it('e o log tem o erro inteiro', () => {
    expect(log.texto()).toContain('ECONNREFUSED');
    expect(log.texto()).toContain('erro inesperado');
  });
});

describe('erro do Postgres de verdade, com tabela, coluna e valor de linha', () => {
  let app: FastifyInstance;
  let db: Db;
  let owner: pg.Pool;
  let c: Scenario;
  let telefoneDoSeed: string;
  const log = capturarLog();

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();
    c = await seed(owner);
    db = criarDb(urlDoTester());
    const r = await owner.query<{ phone_e164: string }>(
      'select phone_e164 from app.patients where id = $1',
      [c.patients[0]],
    );
    telefoneDoSeed = r.rows[0]?.phone_e164 ?? '';

    app = construirApp({ config, db, boss: criarFila(urlDoTester()), fluxoDeLog: log.fluxo });
    /*
     * Rotas que só este teste registra, na app REAL: o que se testa é o tratamento de erro de
     * `construirApp`, e provocar estes dois erros por uma rota de produção exigiria sabotar o
     * esquema. Rodam como `fliqo_app`, dentro de `withClinic`, como toda rota.
     */
    app.get('/teste/coluna-inexistente', () =>
      withClinic(
        c.clinicA,
        (trx) => sql`select coluna_que_nao_existe from app.patients`.execute(trx),
        db,
      ),
    );
    app.get('/teste/telefone-repetido', () =>
      withClinic(
        c.clinicA,
        (trx) =>
          trx
            .insertInto('app.patients')
            .values({ clinic_id: c.clinicA, name: 'Repetido', phone_e164: telefoneDoSeed })
            .execute(),
        db,
      ),
    );
    /*
     * A mesma violação por uma conexão SEM RLS efetiva. Pela `fliqo_app`, com RLS ativa, o
     * próprio Postgres omite o `detail` (conferido: "detail ausente"). Sem RLS — o caso das
     * funções `security definer`, que rodam como dono do schema — ele vem com a linha:
     * "Key (clinic_id, phone_e164)=(…, +55…) already exists". É esse que a redação segura.
     */
    app.get('/teste/telefone-repetido-sem-rls', () =>
      owner.query('insert into app.patients (clinic_id, name, phone_e164) values ($1, $2, $3)', [
        c.clinicA,
        'Repetido',
        telefoneDoSeed,
      ]),
    );
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await owner.end();
  });

  it('coluna inexistente: o corpo não diz tabela, coluna nem mensagem', async () => {
    const r = await app.inject({ method: 'GET', url: '/teste/coluna-inexistente' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual(CORPO_DO_500);
    for (const agulha of ['patients', 'coluna_que_nao_existe', 'does not exist', '42703']) {
      expect(r.body, `o corpo conta "${agulha}"`).not.toContain(agulha);
    }
    // E o log conta: é lá que quem investiga vai olhar.
    expect(log.texto()).toContain('coluna_que_nao_existe');
  });

  it('telefone repetido: o corpo não diz a restrição nem o telefone', async () => {
    expect(telefoneDoSeed).toMatch(/^\+55/);
    const r = await app.inject({ method: 'GET', url: '/teste/telefone-repetido' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual(CORPO_DO_500);
    for (const agulha of ['patients', 'phone_e164', 'duplicate key', telefoneDoSeed]) {
      expect(r.body, `o corpo conta "${agulha}"`).not.toContain(agulha);
    }
  });

  it('sem RLS o `detail` traz o telefone: o corpo não conta, e o log tem tudo MENOS ele', async () => {
    const r = await app.inject({ method: 'GET', url: '/teste/telefone-repetido-sem-rls' });
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual(CORPO_DO_500);
    expect(r.body).not.toContain(telefoneDoSeed);

    // A mensagem e o nome da restrição bastam para investigar; telefone não entra em log.
    expect(log.texto()).toContain('"detail":"[redigido]"');
    expect(log.texto()).toContain('duplicate key');
    expect(log.texto()).toContain('phone_e164');
    expect(log.texto()).not.toContain(telefoneDoSeed);
  });
});

describe('recusa do próprio Fastify (4xx)', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    const url = 'postgresql://ninguem@127.0.0.1:1/nada';
    db = criarDb(url);
    app = construirApp({ config, db, boss: criarFila(url) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('corpo grande demais mantém o 413, e o corpo também é fixo', async () => {
    // O código é a informação útil para quem chamou; a mensagem do framework fica de fora.
    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: `{"x":"${'a'.repeat(3 * 1024 * 1024)}"}`,
    });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ erro: 'requisicao_recusada' });
  });

  it('e rota que funciona continua igual', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });
});
