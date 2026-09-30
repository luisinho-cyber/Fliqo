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
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';

/**
 * As rotas que a queda de WhatsApp acrescenta, e a regra do telefone.
 *
 * A mais sensível é a revelação: é o ÚNICO endpoint que devolve telefone inteiro,
 * e por isso é o que mais precisa de teste de isolamento entre clínicas.
 */

const JWT_SECRET = 'segredo-jwt-da-queda';
const segredo = new TextEncoder().encode(JWT_SECRET);
const DONA_DA_A = '11111111-1111-4111-8111-111111111111';
const DONA_DA_B = '22222222-2222-4222-8222-222222222222';

/** Telefone plantado: é o valor que a varredura procura no corpo das listagens. */
const TELEFONE_PLANTADO = '+5511987654321';

const config: Config = {
  DATABASE_URL: 'nao-usado',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app',
  META_APP_SECRET: 'segredo',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 3).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;
let pacienteDaA: string;
let consultaDaA: string;

async function token(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(segredo);
}

async function chamar(metodo: 'GET' | 'POST', url: string, o: { userId: string; clinica: string }) {
  return app.inject({
    method: metodo,
    url,
    headers: { authorization: `Bearer ${await token(o.userId)}`, 'x-clinica': o.clinica },
  });
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role) values ($1,$2,'dono'), ($3,$4,'dono')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B],
  );

  pacienteDaA = c.patients[0]!;
  await owner.query('update app.patients set phone_e164 = $2 where id = $1', [
    pacienteDaA,
    TELEFONE_PLANTADO,
  ]);

  const { rows } = await owner.query<{ id: string }>(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
     values ($1,$2,$3,$4, now() + interval '3 hours', now() + interval '4 hours', 25000)
     returning id`,
    [c.clinicA, c.profA, pacienteDaA, c.procEletivo],
  );
  consultaDaA = rows[0]!.id;

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

/** Uma ação descartada da clínica A, para as rotas terem o que encontrar. */
async function descartada(kind = 'confirmacao'): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.scheduled_actions (clinic_id, kind, appointment_id, due_at, status, last_error)
     values ($1, $2::app.action_kind, $3, now() - interval '1 hour', 'sem_proposito', 'afirmacao_venceu')
     returning id`,
    [c.clinicA, kind, consultaDaA],
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  await owner.query('delete from app.scheduled_actions');
});

describe('o telefone inteiro sai de um lugar só', () => {
  it('a dona da A revela o telefone de um paciente dela', async () => {
    const r = await chamar('GET', `/api/pacientes/${pacienteDaA}/telefone`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ telefone: TELEFONE_PLANTADO });
  });

  it('a dona da B não revela o telefone de paciente da A, e o 403 não conta nada', async () => {
    const r = await chamar('GET', `/api/pacientes/${pacienteDaA}/telefone`, {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain(TELEFONE_PLANTADO);
    expect(r.body).not.toContain('98765');
  });

  it('pedir na própria clínica um paciente de outra dá 404, não o telefone', async () => {
    // A RLS não acha a linha: da clínica B, o paciente da A simplesmente não existe.
    const r = await chamar('GET', `/api/pacientes/${pacienteDaA}/telefone`, {
      userId: DONA_DA_B,
      clinica: c.clinicB,
    });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain(TELEFONE_PLANTADO);
  });

  it('id que não é uuid é recusado antes do banco', async () => {
    const r = await chamar('GET', '/api/pacientes/nao-e-uuid/telefone', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(400);
  });

  /**
   * A regra: nenhum endpoint de LISTAGEM devolve telefone inteiro. O teste casa o
   * valor plantado — não um padrão de número —, e por isso o número da clínica em
   * /api/whatsapp/status nunca fica vermelho aqui: é outro número, de outro dono.
   */
  it('o telefone plantado não aparece no corpo de nenhuma listagem', async () => {
    await descartada();
    const listagens = ['/api/hoje', '/api/conversas', '/api/alertas', '/api/agenda/semana'];

    for (const caminho of listagens) {
      const r = await chamar('GET', caminho, { userId: DONA_DA_A, clinica: c.clinicA });
      expect(r.statusCode, `${caminho} não respondeu`).toBeLessThan(500);
      expect(r.body, `${caminho} devolveu o telefone inteiro`).not.toContain(TELEFONE_PLANTADO);
      // E nem só os dígitos, sem o +: vazamento reformatado escapa de comparação
      // literal única.
      expect(r.body, `${caminho} devolveu o telefone só com dígitos`).not.toContain(
        TELEFONE_PLANTADO.slice(1),
      );
    }
  });

  it('a lista de descartes traz o telefone mascarado', async () => {
    await descartada();
    const r = await chamar('GET', '/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    const { descartes } = r.json<{ descartes: { telefoneMascarado: string | null }[] }>();
    expect(descartes).toHaveLength(1);
    expect(descartes[0]?.telefoneMascarado).toContain('***');
  });
});

describe('o descarte vira decisão na tela Hoje', () => {
  it('a consulta de hoje que ainda dá tempo recebe "reenviar"', async () => {
    // A consulta é daqui a 3 h, hoje: o lembrete final ainda pode sair.
    await descartada('lembrete_final');
    const r = await chamar('GET', '/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    const { descartes } = r.json<{ descartes: { acao: string; paciente: string }[] }>();
    expect(descartes[0]?.acao).toBe('reenviar');
    // A lista diz QUEM, porque um número não é acionável.
    expect(descartes[0]?.paciente).toBeTruthy();
  });

  it('a confirmação de uma consulta de hoje já venceu: a ação é ligar', async () => {
    // "sua consulta de amanhã" sobre um horário de hoje é mentira.
    await descartada('confirmacao');
    const r = await chamar('GET', '/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    const { descartes } = r.json<{ descartes: { acao: string }[] }>();
    expect(descartes[0]?.acao).toBe('ligar');
  });

  it('sem descarte nenhum, a lista vem vazia — não é erro', async () => {
    const r = await chamar('GET', '/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    expect(r.json<{ descartes: unknown[] }>().descartes).toEqual([]);
  });
});

describe('reenviar uma ação descartada', () => {
  it('devolve para a fila, vencendo agora', async () => {
    const id = await descartada();
    const r = await chamar('POST', `/api/acoes/${id}/reenviar`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query<{ status: string; attempts: number }>(
      'select status, attempts from app.scheduled_actions where id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'pendente', attempts: 0 });
  });

  it('só aceita o que está descartado: reenviar duas vezes dá 404', async () => {
    const id = await descartada();
    await chamar('POST', `/api/acoes/${id}/reenviar`, { userId: DONA_DA_A, clinica: c.clinicA });
    const r = await chamar('POST', `/api/acoes/${id}/reenviar`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ erro: 'acao_nao_descartada' });
  });

  it('a dona da B não reenvia ação da A, e a ação não se move', async () => {
    const id = await descartada();
    const r = await chamar('POST', `/api/acoes/${id}/reenviar`, {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain(TELEFONE_PLANTADO);

    const { rows } = await owner.query<{ status: string }>(
      'select status from app.scheduled_actions where id = $1',
      [id],
    );
    expect(rows[0]?.status, 'a ação da A se moveu por pedido da B').toBe('sem_proposito');
  });
});
