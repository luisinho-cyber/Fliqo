import { criarDb, withClinic, type Db } from '@fliqo/db';
import { criarFila, FILA_ATRASOS, SCHEMA_FILA } from '@fliqo/db/fila';
import {
  prepararFilaDeTeste,
  ownerPool,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';

const JWT_SECRET = 'segredo-jwt-do-supabase-para-teste';
const segredo = new TextEncoder().encode(JWT_SECRET);

const config: Config = {
  DATABASE_URL: 'nao-usado-no-teste',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app-de-teste',
  META_APP_SECRET: 'segredo-do-app-de-teste',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

// Usuários do Supabase (o `sub` do token).
const DONA_DA_A = '11111111-1111-4111-8111-111111111111';
const DONA_DA_B = '22222222-2222-4222-8222-222222222222';
const SEM_CLINICA = '33333333-3333-4333-8333-333333333333';

async function token(userId: string, expiraEm = '1h'): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiraEm)
    .sign(segredo);
}

async function chamar(
  metodo: 'GET' | 'POST',
  url: string,
  opcoes: { userId?: string; clinica?: string; corpo?: unknown; tokenCru?: string } = {},
) {
  const jwt = opcoes.tokenCru ?? (opcoes.userId ? await token(opcoes.userId) : undefined);
  return app.inject({
    method: metodo,
    url,
    headers: {
      ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
      ...(opcoes.clinica === undefined ? {} : { 'x-clinica': opcoes.clinica }),
      ...(opcoes.corpo === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(opcoes.corpo === undefined ? {} : { payload: JSON.stringify(opcoes.corpo) }),
  });
}

const BASE = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
const emHoras = (h: number): Date => new Date(BASE.getTime() + h * 3_600_000);

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);

  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role) values ($1,$2,'dono'), ($3,$4,'dono')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B],
  );

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });
  await app.ready();

  // Uma consulta na clínica A, para haver o que enxergar (ou não).
  await withClinic(
    c.clinicA,
    (trx) =>
      trx
        .insertInto('app.appointments')
        .values({
          clinic_id: c.clinicA,
          professional_id: c.profA,
          patient_id: c.patients[0]!,
          procedure_id: c.procEletivo,
          starts_at: emHoras(0),
          ends_at: emHoras(1),
          price_cents: 25000,
        })
        .execute(),
    db,
  );
}, 90_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

const periodo = `de=${emHoras(-24).toISOString()}&ate=${emHoras(48).toISOString()}`;

describe('autenticação', () => {
  it('sem token devolve 401', async () => {
    const r = await chamar('GET', `/api/agenda?${periodo}`, { clinica: c.clinicA });
    expect(r.statusCode).toBe(401);
  });

  it('token assinado com outro segredo devolve 401', async () => {
    const outro = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(DONA_DA_A)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('segredo-errado'));
    const r = await chamar('GET', `/api/agenda?${periodo}`, {
      tokenCru: outro,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(401);
  });

  it('token expirado devolve 401', async () => {
    const vencido = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(DONA_DA_A)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(segredo);
    const r = await chamar('GET', `/api/agenda?${periodo}`, {
      tokenCru: vencido,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(401);
  });

  it('sem informar a clínica devolve 400', async () => {
    const r = await chamar('GET', `/api/agenda?${periodo}`, { userId: DONA_DA_A });
    expect(r.statusCode).toBe(400);
  });
});

describe('isolamento entre clínicas', () => {
  it('usuário da clínica A NÃO lê a clínica B', async () => {
    // Token válido, clínica existente — e ainda assim negado, porque quem decide
    // é a linha em clinic_members, não o que o cliente pediu.
    const r = await chamar('GET', `/api/agenda?${periodo}`, {
      userId: DONA_DA_A,
      clinica: c.clinicB,
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'nao_e_membro_da_clinica' });
  });

  it('usuário da clínica B não enxerga a consulta da A', async () => {
    const naPropria = await chamar('GET', `/api/agenda?${periodo}`, {
      userId: DONA_DA_B,
      clinica: c.clinicB,
    });
    expect(naPropria.statusCode).toBe(200);
    expect(naPropria.json()).toEqual([]);

    const naAlheia = await chamar('GET', `/api/agenda?${periodo}`, {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(naAlheia.statusCode).toBe(403);
  });

  it('usuário sem clínica nenhuma é negado', async () => {
    const r = await chamar('GET', `/api/agenda?${periodo}`, {
      userId: SEM_CLINICA,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
  });

  it('a dona da A enxerga a agenda da A', async () => {
    const r = await chamar('GET', `/api/agenda?${periodo}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
  });

  it('usuário da B não escreve na agenda da A', async () => {
    const r = await chamar('POST', '/api/agenda', {
      userId: DONA_DA_B,
      clinica: c.clinicA,
      corpo: {
        profissionalId: c.profA,
        pacienteId: c.patients[1],
        procedimentoId: c.procEletivo,
        inicio: emHoras(30).toISOString(),
      },
    });
    expect(r.statusCode).toBe(403);

    const { rows } = await owner.query('select id from app.appointments where starts_at = $1', [
      emHoras(30),
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('agenda pelo painel', () => {
  it('marca, e um segundo pedido no mesmo horário devolve 409', async () => {
    const pedido = {
      profissionalId: c.profA,
      pacienteId: c.patients[1],
      procedimentoId: c.procEletivo,
      inicio: emHoras(10).toISOString(),
    };
    const primeiro = await chamar('POST', '/api/agenda', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(primeiro.statusCode).toBe(201);

    const segundo = await chamar('POST', '/api/agenda', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { ...pedido, pacienteId: c.patients[2] },
    });
    // Conflito é resposta de negócio, não erro do servidor.
    expect(segundo.statusCode).toBe(409);
    expect(segundo.json()).toEqual({ erro: 'horario_ocupado' });
  });

  it('remarcar para horário ocupado devolve 409 e não mexe na original', async () => {
    const criada = await chamar('POST', '/api/agenda', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: {
        profissionalId: c.profA,
        pacienteId: c.patients[3],
        procedimentoId: c.procEletivo,
        inicio: emHoras(20).toISOString(),
      },
    });
    expect(criada.statusCode).toBe(201);
    const id = criada.json().id;

    const r = await chamar('POST', `/api/agenda/${id}/remarcar`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { novoInicio: emHoras(10).toISOString() },
    });
    expect(r.statusCode).toBe(409);

    const { rows } = await owner.query<{ status: string }>(
      'select status from app.appointments where id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('agendado');
  });
});

describe('conversas', () => {
  it('assumir silencia a IA e devolver a traz de volta', async () => {
    const conversaId = await withClinic(
      c.clinicA,
      async (trx) => {
        const r = await trx
          .insertInto('app.conversations')
          .values({ clinic_id: c.clinicA, patient_id: c.patients[0]! })
          .returningAll()
          .executeTakeFirstOrThrow();
        return r.id;
      },
      db,
    );

    const assumir = await chamar('POST', `/api/conversas/${conversaId}/assumir`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(assumir.statusCode).toBe(200);
    expect(assumir.json().mode).toBe('humano');

    const devolver = await chamar('POST', `/api/conversas/${conversaId}/devolver`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(devolver.json().mode).toBe('ia');
  });

  it('usuário da B não assume conversa da A', async () => {
    const conversaId = await withClinic(
      c.clinicA,
      async (trx) => {
        const r = await trx
          .selectFrom('app.conversations')
          .select(['id'])
          .executeTakeFirstOrThrow();
        return r.id;
      },
      db,
    );
    const r = await chamar('POST', `/api/conversas/${conversaId}/assumir`, {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('pacientes e consentimento', () => {
  it('busca por telefone acha com ou sem o nono dígito', async () => {
    const comNove = await chamar('GET', '/api/pacientes?telefone=%2B5511999990001', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(comNove.json()).toHaveLength(1);

    // Mesmo número, escrito sem o 9 — tem que achar a mesma ficha.
    const semNove = await chamar('GET', '/api/pacientes?telefone=551199990001', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(semNove.json()).toHaveLength(1);
    expect(semNove.json()[0]?.id).toBe(comNove.json()[0]?.id);
  });

  it('a recepção registra o consentimento e a segunda vez devolve 409', async () => {
    const pacienteId = c.patients[0];
    const primeira = await chamar('POST', `/api/pacientes/${pacienteId}/consentimento`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: {},
    });
    expect(primeira.statusCode).toBe(200);
    expect(primeira.json().whatsapp_consent_at).not.toBeNull();

    const segunda = await chamar('POST', `/api/pacientes/${pacienteId}/consentimento`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: {},
    });
    expect(segunda.statusCode).toBe(409);
  });
});

describe('os três toques da tela Hoje', () => {
  // Cada caso pega um horário próprio: a mesma agenda não aceita duas consultas
  // no mesmo horário com o mesmo profissional (no_double_booking).
  let horaLivre = 1;

  /** A consulta de hoje, que é o que a recepção tem na frente. */
  async function consultaDeHoje(): Promise<string> {
    const daqui = horaLivre;
    horaLivre += 2;
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
       values ($1,$2,$3,$4,
               now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 1), 25000)
       returning id`,
      [c.clinicA, c.profA, c.patients[1]!, c.procEletivo, daqui],
    );
    return rows[0]!.id;
  }

  async function jobsDeAtraso(): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from ${SCHEMA_FILA}.job where name = $1`,
      [FILA_ATRASOS],
    );
    return Number(rows[0]?.n ?? 0);
  }

  it('grava chegada, início e fim, um toque cada', async () => {
    const id = await consultaDeHoje();

    const chegou = await chamar('POST', `/api/agenda/${id}/chegou`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(chegou.statusCode).toBe(200);
    expect(chegou.json().checked_in_at).not.toBeNull();

    const iniciou = await chamar('POST', `/api/agenda/${id}/iniciar`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(iniciou.json().started_at).not.toBeNull();

    const finalizou = await chamar('POST', `/api/agenda/${id}/finalizar`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(finalizou.json().finished_at).not.toBeNull();
    // Finalizar fecha o atendimento: é daí que sai a duração real.
    expect(finalizou.json().status).toBe('realizado');
  });

  it('cada toque enfileira a varredura de atrasos', async () => {
    await owner.query(`delete from ${SCHEMA_FILA}.job where name = $1`, [FILA_ATRASOS]);
    const id = await consultaDeHoje();

    await chamar('POST', `/api/agenda/${id}/chegou`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });

    // Sem isso, o aviso só sairia na próxima volta de 2 minutos.
    expect(await jobsDeAtraso()).toBeGreaterThan(0);
  });

  it('não deixa tocar em consulta de outra clínica', async () => {
    const id = await consultaDeHoje();
    const r = await chamar('POST', `/api/agenda/${id}/iniciar`, {
      userId: DONA_DA_B,
      clinica: c.clinicB,
    });
    // A RLS não enxerga a linha: para a clínica B ela não existe.
    expect(r.statusCode).toBe(404);
  });

  it('sem token não toca em nada', async () => {
    const id = await consultaDeHoje();
    const r = await chamar('POST', `/api/agenda/${id}/chegou`, { clinica: c.clinicA });
    expect(r.statusCode).toBe(401);
  });

  it('id que não é uuid é recusado antes de tocar no banco', async () => {
    const r = await chamar('POST', '/api/agenda/nao-e-uuid/chegou', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(400);
  });
});
