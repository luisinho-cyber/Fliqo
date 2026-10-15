import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appPool, ownerPool, resetDatabase, seed, type Scenario } from './helpers';

/**
 * `app.requeue_stuck_actions` mede desde que a ação foi RECLAMADA (0018).
 *
 * Antes media desde o vencimento, e ação reclamada está vencida por definição: a que venceu
 * há dez minutos virava "presa" no instante da reclamação. Num deploy há dois workers ao
 * mesmo tempo — e a primeira volta do novo devolvia à fila o que o antigo estava enviando.
 *
 * Cada worker aqui é uma CONEXÃO `fliqo_app` própria, como em produção. A ação não tem
 * consulta: o claim e o requeue não leem `appointments`, e sem consulta o gatilho da régua
 * não cria ações extras.
 */

/** O mesmo limite que o worker usa (LIMITE_PRESA_MIN, em apps/worker). */
const LIMITE_MIN = 5;

let owner: pg.Pool;
let workers: pg.Pool;
let c: Scenario;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  workers = appPool();
  c = await seed(owner);
}, 90_000);

afterAll(async () => {
  await workers.end();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.scheduled_actions');
});

/** Ação pendente que venceu há `minutos`: bem mais velha que o limite do requeue. */
async function acaoVencidaHa(minutos: number): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.scheduled_actions (clinic_id, kind, due_at)
     values ($1, 'confirmacao', now() - make_interval(mins => $2)) returning id`,
    [c.clinicA, minutos],
  );
  return rows[0]?.id ?? '';
}

async function estado(id: string): Promise<{ status: string; claimed_at: Date | null }> {
  const { rows } = await owner.query<{ status: string; claimed_at: Date | null }>(
    'select status, claimed_at from app.scheduled_actions where id = $1',
    [id],
  );
  const linha = rows[0];
  if (linha === undefined) throw new Error('a ação sumiu');
  return linha;
}

/** Um worker: uma conexão própria, que reclama ou varre e devolve a conexão. */
async function comoWorker<T>(fn: (cx: pg.PoolClient) => Promise<T>): Promise<T> {
  const cx = await workers.connect();
  try {
    return await fn(cx);
  } finally {
    cx.release();
  }
}

describe('dois workers: um reclama, o outro varre', () => {
  it('a ação que acabou de ser reclamada NÃO volta para a fila', async () => {
    const id = await acaoVencidaHa(10);

    const reclamadas = await comoWorker(async (a) => {
      const r = await a.query<{ id: string }>('select id from app.claim_due_actions(50)');
      return r.rows.map((l) => l.id);
    });
    expect(reclamadas).toEqual([id]);

    // O worker B sobe agora — o novo, num deploy — e a primeira coisa que ele faz é varrer.
    const devolvidas = await comoWorker(async (b) => {
      const r = await b.query<{ n: number }>('select app.requeue_stuck_actions($1) as n', [
        LIMITE_MIN,
      ]);
      return r.rows[0]?.n;
    });

    expect(devolvidas).toBe(0);
    expect((await estado(id)).status).toBe('executando');
  });

  it('e por isso o worker B não consegue reclamá-la de novo', async () => {
    const id = await acaoVencidaHa(10);
    await comoWorker((a) => a.query('select id from app.claim_due_actions(50)'));
    await comoWorker((b) => b.query('select app.requeue_stuck_actions($1)', [LIMITE_MIN]));

    const doB = await comoWorker(async (b) => {
      const r = await b.query<{ id: string }>('select id from app.claim_due_actions(50)');
      return r.rows.map((l) => l.id);
    });
    expect(doB).not.toContain(id);
  });
});

describe('o requeue ainda faz o trabalho dele', () => {
  it('reclamada há mais que o limite é presa de verdade, e volta', async () => {
    const id = await acaoVencidaHa(10);
    await comoWorker((a) => a.query('select id from app.claim_due_actions(50)'));
    // O worker A morreu há seis minutos com a ação na mão.
    await owner.query(
      `update app.scheduled_actions set claimed_at = now() - interval '6 minutes' where id = $1`,
      [id],
    );

    const devolvidas = await comoWorker(async (b) => {
      const r = await b.query<{ n: number }>('select app.requeue_stuck_actions($1) as n', [
        LIMITE_MIN,
      ]);
      return r.rows[0]?.n;
    });
    expect(devolvidas).toBe(1);
    expect((await estado(id)).status).toBe('pendente');
  });

  it('o claim carimba o momento da reclamação', async () => {
    const id = await acaoVencidaHa(10);
    await comoWorker((a) => a.query('select id from app.claim_due_actions(50)'));
    const { claimed_at } = await estado(id);
    expect(claimed_at).toBeInstanceOf(Date);
    expect(Math.abs((claimed_at?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  it('ação presa de antes da 0018, sem carimbo, cai na régua antiga', async () => {
    // Reclamada pela função antiga: está em 'executando' sem claimed_at.
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.scheduled_actions (clinic_id, kind, due_at, status)
       values ($1, 'confirmacao', now() - interval '10 minutes', 'executando') returning id`,
      [c.clinicA],
    );
    const id = rows[0]?.id ?? '';
    await comoWorker((b) => b.query('select app.requeue_stuck_actions($1)', [LIMITE_MIN]));
    expect((await estado(id)).status).toBe('pendente');
  });
});
