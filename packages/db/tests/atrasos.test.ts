import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appPool, asClinic, ownerPool, resetDatabase, seed, type Scenario } from './helpers';

let owner: pg.Pool;
let app: pg.Pool;
let s: Scenario;

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

/** Atendimento já realizado, `diasAtras` dias atrás, que começou `atrasoMin` depois e durou `duracaoMin`. */
async function realizado(diasAtras: number, atrasoMin: number, duracaoMin: number, paciente = 0) {
  await owner.query(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, status, price_cents,
        checked_in_at, started_at, finished_at)
     select $1, $2, $3, $4, t, t + interval '60 minutes', 'realizado', 25000,
            t - interval '10 minutes', t + make_interval(mins => $6), t + make_interval(mins => $6 + $7)
       from (select date_trunc('hour', now()) - make_interval(days => $5) as t) x`,
    [s.clinicA, s.profA, s.patients[paciente], s.procEletivo, diasAtras, atrasoMin, duracaoMin],
  );
}

describe('duração real e pontualidade', () => {
  it('mediana da duração real por profissional e procedimento', async () => {
    const duracoes = [70, 75, 72, 80, 68, 75, 78, 73]; // agenda diz 60
    for (const [i, d] of duracoes.entries()) await realizado(i + 1, 0, d);
    const r = await asClinic(app, s.clinicA, (c) =>
      c.query(
        'select sample_size, median_minutes, scheduled_minutes from app.procedure_real_durations',
      ),
    );
    expect(r.rows).toEqual([{ sample_size: 8, median_minutes: 74, scheduled_minutes: 60 }]);
  });

  it('pontualidade: atraso médio e atendimentos no horário', async () => {
    // Mesmo dia (horário fixo, longe da meia-noite): 9h no horário; 11h começou 11h30.
    const at = (inicio: string, iniciou: string, paciente: number) =>
      owner.query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, status, price_cents, started_at, finished_at)
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '1 hour', 'realizado', 25000,
                 $6::timestamptz, $6::timestamptz + interval '1 hour')`,
        [s.clinicA, s.profA, s.patients[paciente], s.procEletivo, inicio, iniciou],
      );
    await at('2026-03-10 09:00-03', '2026-03-10 09:00-03', 0);
    await at('2026-03-10 11:00-03', '2026-03-10 11:30-03', 1);
    const r = await asClinic(app, s.clinicA, (c) =>
      c.query(
        'select sum(appointments)::int as n, sum(on_time)::int as ok, max(avg_delay_minutes) as atraso from app.professional_punctuality',
      ),
    );
    expect(r.rows[0]).toEqual({ n: 2, ok: 1, atraso: 15 });
  });

  it('outra clínica não enxerga as estatísticas', async () => {
    await realizado(1, 0, 70);
    const r = await asClinic(app, s.clinicB, (c) =>
      c.query('select * from app.procedure_real_durations'),
    );
    expect(r.rows).toHaveLength(0);
  });

  it('não aceita fim antes do início', async () => {
    await expect(
      owner.query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, status, price_cents, started_at, finished_at)
         values ($1, $2, $3, $4, now() - interval '1 day', now() - interval '23 hours', 'realizado', 1, now() - interval '1 day', now() - interval '25 hours')`,
        [s.clinicA, s.profA, s.patients[0], s.procEletivo],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('aviso de atraso fica registrado por consulta', async () => {
    await realizado(1, 0, 60);
    const appt = (await owner.query('select id from app.appointments limit 1')).rows[0].id;
    await asClinic(app, s.clinicA, (c) =>
      c.query(
        `insert into app.delay_notices (clinic_id, appointment_id, channel, delay_minutes) values (app.clinic_id(), $1, 'whatsapp', 20)`,
        [appt],
      ),
    );
    const r = await asClinic(app, s.clinicA, (c) =>
      c.query('select delay_minutes from app.delay_notices'),
    );
    expect(r.rows).toEqual([{ delay_minutes: 20 }]);
  });
});
