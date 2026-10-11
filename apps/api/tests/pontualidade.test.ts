import { criarDb, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import {
  prepararFilaDeTeste,
  ownerPool,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import { AMOSTRA_MINIMA } from '@fliqo/core';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';
import type { RespostaPontualidade } from '../src/rotas/pontualidade';

/**
 * A tela de pontualidade e o ajuste de duração.
 *
 * O que mais precisa de teste aqui não é o número na tela: é a ESCRITA. Aceitar a
 * sugestão altera o cadastro de procedimento, que decide quantos pacientes cabem no
 * dia de todo mundo — e a rota faz isso sem receber número nenhum do cliente, o que
 * só vale se houver teste provando que o corpo do pedido é ignorado.
 */

const JWT_SECRET = 'segredo-jwt-da-pontualidade';
const segredo = new TextEncoder().encode(JWT_SECRET);
const DONA_DA_A = '11111111-1111-4111-8111-111111111111';
const DONA_DA_B = '22222222-2222-4222-8222-222222222222';
const RECEPCAO_DA_A = '44444444-4444-4444-8444-444444444444';

const config: Config = {
  DATABASE_URL: 'nao-usado',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app',
  META_APP_SECRET: 'segredo',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 4).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

async function token(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(segredo);
}

/**
 * As opções vão numa variável tipada, e o corpo é atribuído depois.
 *
 * Espalhamento condicional (`...(corpo === undefined ? {} : { payload })`) monta um
 * tipo que a sobrecarga do inject não resolve, e aí o lint para de conferir a
 * chamada inteira — foi assim que um nome de tipo errado passou pelo typecheck e só
 * apareceu no lint. Com `exactOptionalPropertyTypes`, `payload: undefined` também
 * não vale: a propriedade ou existe com valor, ou não existe.
 */
async function chamar(
  metodo: 'GET' | 'POST',
  url: string,
  o: { userId: string; clinica: string; corpo?: object },
): Promise<LightMyRequestResponse> {
  const opcoes: InjectOptions = {
    method: metodo,
    url,
    headers: { authorization: `Bearer ${await token(o.userId)}`, 'x-clinica': o.clinica },
  };
  if (o.corpo !== undefined) opcoes.payload = o.corpo;
  return app.inject(opcoes);
}

/** `quantos` atendimentos da Limpeza, todos com a mesma duração real. */
async function limpezasDe(quantos: number, duracaoMin: number): Promise<void> {
  const paciente = c.patients[0];
  if (paciente === undefined) throw new Error('o cenário não tem paciente');
  for (let i = 0; i < quantos; i++) {
    await owner.query(
      `with marcado as (
         select date_trunc('day', now() - make_interval(days => $5::int)) + interval '8 hours' as inicio
       )
       insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status, started_at, finished_at)
       select $1, $2, $3, $4, m.inicio, m.inicio + interval '1 hour', 25000, 'realizado',
              m.inicio, m.inicio + make_interval(mins => $6::int)
         from marcado m`,
      [c.clinicA, c.profA, paciente, c.procEletivo, i + 1, duracaoMin],
    );
  }
}

async function duracaoCadastrada(): Promise<number> {
  const { rows } = await owner.query<{ duration_minutes: number }>(
    'select duration_minutes from app.procedures where id = $1',
    [c.procEletivo],
  );
  return rows[0]?.duration_minutes ?? 0;
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role)
     values ($1,$2,'dono'), ($3,$4,'dono'), ($1,$5,'recepcao')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B, RECEPCAO_DA_A],
  );

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.appointments');
  // A Limpeza volta ao cadastro original, sem carimbo: cada teste começa do zero.
  await owner.query(
    `update app.procedures
        set duration_minutes = 60, duration_updated_at = null, duration_updated_by = null
      where id = $1`,
    [c.procEletivo],
  );
});

describe('quem pode ver', () => {
  it('a dona da clínica vê', async () => {
    const r = await chamar('GET', '/api/pontualidade', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);
  });

  it('a dona da B não vê a pontualidade da A', async () => {
    const r = await chamar('GET', '/api/pontualidade', {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    // E o 403 não conta nada sobre a clínica de quem pediu.
    expect(r.json()).toEqual({ erro: 'nao_e_membro_da_clinica' });
  });

  /**
   * A recepção é membro e leva 403 mesmo assim. Não é segredo: a tela compara
   * pessoas da equipe pelo nome, e a única ação que ela oferece muda o cadastro
   * da clínica.
   */
  it('a recepção da própria clínica também não vê', async () => {
    const r = await chamar('GET', '/api/pontualidade', {
      userId: RECEPCAO_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'apenas_dono_ve_pontualidade' });
  });

  it('a dona da B não ajusta procedimento da A, e o cadastro não se move', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    expect(await duracaoCadastrada(), 'o cadastro da A se moveu por pedido da B').toBe(60);
  });

  it('a recepção não ajusta duração', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: RECEPCAO_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    expect(await duracaoCadastrada()).toBe(60);
  });
});

describe('a sugestão só aparece quando a medida sustenta', () => {
  it(`com ${String(AMOSTRA_MINIMA - 1)} atendimentos não sugere, e o motivo é a amostra`, async () => {
    await limpezasDe(AMOSTRA_MINIMA - 1, 90);
    const r = await chamar('GET', '/api/pontualidade', { userId: DONA_DA_A, clinica: c.clinicA });
    const { procedimentos } = r.json<RespostaPontualidade>();
    const limpeza = procedimentos.find((p) => p.id === c.procEletivo);
    expect(limpeza?.amostra).toBe(AMOSTRA_MINIMA - 1);
    expect(limpeza?.sugestao).toEqual({ sugerir: false, motivo: 'amostra_pequena' });
  });

  it(`com ${String(AMOSTRA_MINIMA)} sugere`, async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    const r = await chamar('GET', '/api/pontualidade', { userId: DONA_DA_A, clinica: c.clinicA });
    const { procedimentos } = r.json<RespostaPontualidade>();
    expect(procedimentos.find((p) => p.id === c.procEletivo)?.sugestao).toMatchObject({
      sugerir: true,
      cadastradaMin: 60,
      novaDuracaoMin: 90,
    });
  });

  it('amostra grande e divergência pequena também não sugere — e o motivo é outro', async () => {
    // Cadastrado em 60, leva 65: o cadastro está certo o bastante.
    await limpezasDe(AMOSTRA_MINIMA + 4, 65);
    const r = await chamar('GET', '/api/pontualidade', { userId: DONA_DA_A, clinica: c.clinicA });
    const { procedimentos } = r.json<RespostaPontualidade>();
    expect(procedimentos.find((p) => p.id === c.procEletivo)?.sugestao).toEqual({
      sugerir: false,
      motivo: 'divergencia_pequena',
    });
  });

  it('com poucos atendimentos o POST recusa, e não grava nada', async () => {
    await limpezasDe(AMOSTRA_MINIMA - 1, 90);
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ erro: 'sem_sugestao_para_este_procedimento' });
    expect(await duracaoCadastrada()).toBe(60);
  });
});

describe('aceitar a sugestão', () => {
  it('muda a duração cadastrada, carimba quem foi, e a sugestão sai da lista', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);

    const antes = await chamar('GET', '/api/pontualidade', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(
      antes.json<RespostaPontualidade>().procedimentos.filter((p) => p.sugestao.sugerir),
    ).toHaveLength(1);

    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, duracaoMin: 90 });
    expect(await duracaoCadastrada()).toBe(90);

    const { rows } = await owner.query<{ by: string | null; at: Date | null }>(
      `select duration_updated_by as by, duration_updated_at as at
         from app.procedures where id = $1`,
      [c.procEletivo],
    );
    expect(rows[0]?.by, 'o ajuste ficou sem autor').toBe(DONA_DA_A);
    expect(rows[0]?.at).toBeInstanceOf(Date);

    // E some da lista: agora o cadastro coincide com a medida.
    const depois = await chamar('GET', '/api/pontualidade', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    const { procedimentos } = depois.json<RespostaPontualidade>();
    expect(procedimentos.filter((p) => p.sugestao.sugerir)).toEqual([]);
    expect(procedimentos.find((p) => p.id === c.procEletivo)?.sugestao).toEqual({
      sugerir: false,
      motivo: 'divergencia_pequena',
    });
    expect(procedimentos.find((p) => p.id === c.procEletivo)?.ajustadaEm).not.toBeNull();
  });

  /**
   * O ponto sensível da rota. "Um toque" não pode ser uma porta para escrever
   * qualquer duração no cadastro: o corpo do pedido é ignorado, e o valor gravado
   * é o que o servidor recalculou.
   */
  it('o corpo do pedido é ignorado: quem decide o número é o servidor', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { minutos: 5, duracaoMin: 5, duration_minutes: 5 },
    });
    expect(r.statusCode).toBe(200);
    expect(await duracaoCadastrada(), 'o número do cliente entrou no cadastro').toBe(90);
  });

  it('aceitar duas vezes: a segunda não acha mais sugestão', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    const r = await chamar('POST', `/api/procedimentos/${c.procEletivo}/duracao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(409);
    expect(await duracaoCadastrada()).toBe(90);
  });

  it('id que não é uuid é recusado antes do banco', async () => {
    const r = await chamar('POST', '/api/procedimentos/nao-e-uuid/duracao', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(400);
  });

  it('procedimento de outra clínica dá 409, não ajuste', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1, 'Da outra', 30, 10000) returning id`,
      [c.clinicB],
    );
    const daB = rows[0]?.id ?? '';
    const r = await chamar('POST', `/api/procedimentos/${daB}/duracao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    // A RLS não acha a linha: para a clínica A aquele procedimento não existe.
    expect(r.statusCode).toBe(409);
    const { rows: depois } = await owner.query<{ duration_minutes: number }>(
      'select duration_minutes from app.procedures where id = $1',
      [daB],
    );
    expect(depois[0]?.duration_minutes).toBe(30);
  });
});

describe('o card na tela Hoje', () => {
  it('chega para a dona, com a divergência maior primeiro', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    const r = await chamar('GET', '/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    const { sugestoesDeDuracao } = r.json<{
      sugestoesDeDuracao: { procedimentoId: string; novaDuracaoMin: number }[];
    }>();
    expect(sugestoesDeDuracao).toHaveLength(1);
    expect(sugestoesDeDuracao[0]).toMatchObject({
      procedimentoId: c.procEletivo,
      novaDuracaoMin: 90,
    });
  });

  /** A rota que aplica nega 403 à recepção: oferecer o card seria prometer um botão que não funciona. */
  it('não chega para a recepção', async () => {
    await limpezasDe(AMOSTRA_MINIMA, 90);
    const r = await chamar('GET', '/api/hoje', { userId: RECEPCAO_DA_A, clinica: c.clinicA });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ sugestoesDeDuracao: unknown[] }>().sugestoesDeDuracao).toEqual([]);
  });
});
