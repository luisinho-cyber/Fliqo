import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appPool, asClinic, ownerPool, resetDatabase, seed, type Scenario } from './helpers';

let owner: pg.Pool;
let app: pg.Pool;
let s: Scenario;

const HOUR = 3_600_000;
/** Horário "redondo" daqui a N horas (evita flakiness de segundos). */
function inHours(h: number): Date {
  const d = new Date(Date.now() + h * HOUR);
  d.setUTCMinutes(0, 0, 0);
  return d;
}
function plusMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

async function book(
  c: pg.PoolClient,
  patient: string,
  start: Date,
  minutes = 60,
  status = 'agendado',
): Promise<string> {
  const r = await c.query(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, status, price_cents)
     values (app.clinic_id(), $1, $2, $3, $4, $5, $6, 25000) returning id`,
    [s.profA, patient, s.procEletivo, start, plusMinutes(start, minutes), status],
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  app = appPool();
});

beforeEach(async () => {
  await owner.query('truncate app.clinics cascade');
  s = await seed(owner);
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('agenda: sem conflito de horário', () => {
  it('bloqueia dois pacientes no mesmo horário do mesmo profissional', async () => {
    const t = inHours(48);
    await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, t));
    await expect(
      asClinic(app, s.clinicA, (c) => book(c, s.patients[1]!, plusMinutes(t, 30))),
    ).rejects.toMatchObject({ code: '23P01' }); // exclusion_violation
  });

  it('permite encaixe logo depois (intervalo meio-aberto)', async () => {
    const t = inHours(48);
    await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, t));
    await expect(
      asClinic(app, s.clinicA, (c) => book(c, s.patients[1]!, plusMinutes(t, 60))),
    ).resolves.toBeTypeOf('string');
  });

  it('horário cancelado volta a ficar livre', async () => {
    const t = inHours(48);
    const id = await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, t));
    await asClinic(app, s.clinicA, (c) =>
      c.query(
        `update app.appointments set status = 'cancelado', cancelled_at = now() where id = $1`,
        [id],
      ),
    );
    await expect(asClinic(app, s.clinicA, (c) => book(c, s.patients[1]!, t))).resolves.toBeTypeOf(
      'string',
    );
  });
});

describe('RLS: isolamento entre clínicas', () => {
  it('clínica B não enxerga pacientes da clínica A', async () => {
    const rows = await asClinic(
      app,
      s.clinicB,
      async (c) => (await c.query('select id from app.patients')).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([s.patientB]);
  });

  it('sem clínica definida, a aplicação não enxerga nada', async () => {
    const c = await app.connect();
    try {
      const r = await c.query('select count(*)::int as n from app.patients');
      expect(r.rows[0].n).toBe(0);
    } finally {
      c.release();
    }
  });

  it('não deixa gravar linha em nome de outra clínica', async () => {
    await expect(
      asClinic(app, s.clinicB, (c) =>
        c.query(
          `insert into app.patients (clinic_id, name, phone_e164) values ($1, 'Intruso', '+5511900000000')`,
          [s.clinicA],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('régua de confirmação automática', () => {
  const kinds = async (appt: string) =>
    (
      await owner.query(
        `select kind::text, due_at from app.scheduled_actions
          where appointment_id = $1 and status = 'pendente' order by due_at`,
        [appt],
      )
    ).rows as { kind: string; due_at: Date }[];

  it('consulta em 48h gera confirmação (24h), risco (3h) e lembrete final (1h30)', async () => {
    const t = inHours(48);
    const id = await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, t));
    const acts = await kinds(id);
    expect(acts.map((a) => a.kind)).toEqual(['confirmacao', 'marcar_risco', 'lembrete_final']);
    expect(acts[0]!.due_at.getTime()).toBe(t.getTime() - 24 * HOUR);
    expect(acts[2]!.due_at.getTime()).toBe(t.getTime() - 90 * 60_000);
  });

  it('remarcar recria a régua no novo horário', async () => {
    const id = await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, inHours(48)));
    const novo = inHours(72);
    await asClinic(app, s.clinicA, (c) =>
      c.query(`update app.appointments set starts_at = $2, ends_at = $3 where id = $1`, [
        id,
        novo,
        plusMinutes(novo, 60),
      ]),
    );
    const acts = await kinds(id);
    expect(acts).toHaveLength(3);
    expect(acts[0]!.due_at.getTime()).toBe(novo.getTime() - 24 * HOUR);
  });

  it('confirmou -> sobra só o lembrete final', async () => {
    const id = await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, inHours(48)));
    await asClinic(app, s.clinicA, (c) =>
      c.query(
        `update app.appointments set status = 'confirmado', confirmed_at = now() where id = $1`,
        [id],
      ),
    );
    expect((await kinds(id)).map((a) => a.kind)).toEqual(['lembrete_final']);
  });

  it('marcada para daqui a ~2h30: não manda confirmação de 24h no passado, só o lembrete', async () => {
    const id = await asClinic(app, s.clinicA, (c) => book(c, s.patients[0]!, inHours(3)));
    expect((await kinds(id)).map((a) => a.kind)).toEqual(['lembrete_final']);
  });

  it('dois workers simultâneos nunca pegam a mesma ação', async () => {
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       select $1, 'confirmacao', now() - interval '1 minute' from generate_series(1, 20)`,
      [s.clinicA],
    );
    const claim = () =>
      app.query('select id from app.claim_due_actions(15)').then((r) => r.rows.map((x) => x.id));
    const [a, b] = await Promise.all([claim(), claim()]);
    const all = [...a, ...b];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(20);
  });
});

describe('lista de espera', () => {
  async function wait(
    patient: string,
    procedure: string,
    prio: number,
    createdMinutesAgo: number,
    days = 7,
  ) {
    const r = await owner.query(
      `insert into app.waitlist_entries
         (clinic_id, patient_id, procedure_id, window_start, window_end, priority_level, created_at)
       values ($1, $2, $3, current_date, current_date + $4::int, $5, now() - make_interval(mins => $6))
       returning id`,
      [s.clinicA, patient, procedure, days, prio, createdMinutesAgo],
    );
    return r.rows[0].id as string;
  }

  it('urgência passa na frente; entre iguais, quem chegou primeiro', async () => {
    const antigo = await wait(s.patients[0]!, s.procEletivo, 0, 600);
    const novo = await wait(s.patients[1]!, s.procEletivo, 0, 10);
    const urgente = await wait(s.patients[2]!, s.procUrgente, 0, 5); // prioridade vem do procedimento
    const t = inHours(30);
    const ranked = await asClinic(app, s.clinicA, async (c) =>
      (
        await c.query(`select id from app.rank_waitlist(app.clinic_id(), $1, $2, $3, 10)`, [
          s.profA,
          t,
          plusMinutes(t, 60),
        ])
      ).rows.map((r) => r.id),
    );
    expect(ranked).toEqual([urgente, antigo, novo]);
  });

  it('não oferece procedimento que não cabe na vaga', async () => {
    await wait(s.patients[0]!, s.procLongo, 3, 100); // 120 min numa vaga de 60
    const t = inHours(30);
    const ranked = await asClinic(
      app,
      s.clinicA,
      async (c) =>
        (
          await c.query(`select id from app.rank_waitlist(app.clinic_id(), $1, $2, $3, 10)`, [
            s.profA,
            t,
            plusMinutes(t, 60),
          ])
        ).rows,
    );
    expect(ranked).toHaveLength(0);
  });

  it('oferta em lote: dois aceitam ao mesmo tempo, só um leva a vaga', async () => {
    const e1 = await wait(s.patients[0]!, s.procEletivo, 0, 100);
    const e2 = await wait(s.patients[1]!, s.procEletivo, 0, 50);
    const t = inHours(30);
    const offer = async (entry: string) =>
      (
        await owner.query(
          `insert into app.slot_offers (clinic_id, waitlist_entry_id, professional_id, starts_at, ends_at, expires_at)
           values ($1, $2, $3, $4, $5, now() + interval '20 minutes') returning id`,
          [s.clinicA, entry, s.profA, t, plusMinutes(t, 60)],
        )
      ).rows[0].id as string;
    const [o1, o2] = [await offer(e1), await offer(e2)];

    const claim = (o: string) =>
      asClinic(
        app,
        s.clinicA,
        async (c) => (await c.query('select app.claim_slot_offer($1) as id', [o])).rows[0].id,
      );
    const results = await Promise.all([claim(o1), claim(o2)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const booked = await owner.query(
      `select count(*)::int as n from app.appointments where starts_at = $1 and status = 'confirmado'`,
      [t],
    );
    expect(booked.rows[0].n).toBe(1);
    const statuses = (
      await owner.query(`select status from app.slot_offers order by status`)
    ).rows.map((r) => r.status);
    expect(statuses).toEqual(['aceita', 'preenchida_por_outro']);
  });

  it('oferta expirada não pode ser aceita', async () => {
    const e1 = await wait(s.patients[0]!, s.procEletivo, 0, 100);
    const t = inHours(30);
    const o = (
      await owner.query(
        `insert into app.slot_offers (clinic_id, waitlist_entry_id, professional_id, starts_at, ends_at, expires_at)
         values ($1, $2, $3, $4, $5, now() - interval '1 minute') returning id`,
        [s.clinicA, e1, s.profA, t, plusMinutes(t, 60)],
      )
    ).rows[0].id;
    const r = await asClinic(
      app,
      s.clinicA,
      async (c) => (await c.query('select app.claim_slot_offer($1) as id', [o])).rows[0].id,
    );
    expect(r).toBeNull();
  });
});
