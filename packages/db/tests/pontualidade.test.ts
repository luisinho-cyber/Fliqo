import { TOLERANCIA_PONTUALIDADE_MIN } from '@fliqo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { appPool, asClinic, ownerPool, resetDatabase, seed, type Scenario } from './helpers';

/**
 * As duas views da pontualidade, testadas pelo comportamento e não pelo texto.
 *
 * A mais importante é a tolerância: o "no horário" da view é `starts_at + 10 min`,
 * escrito em SQL, e `TOLERANCIA_PONTUALIDADE_MIN` é o mesmo dez escrito em
 * TypeScript. Nada obriga os dois a concordarem — a não ser este teste, que planta
 * um atendimento exatamente no limite e outro um minuto além. Sem ele, mexer na
 * view deixaria a tela afirmando um percentual que o banco não calculou.
 */

let owner: pg.Pool;
let app: pg.Pool;
let c: Scenario;
let profB: string;
let procB: string;

/** Um atendimento realizado, com atraso e duração escolhidos. */
async function realizado(o: {
  clinic: string;
  prof: string;
  proc: string;
  paciente: string;
  /** Hora do dia em que foi MARCADO, para não colidir com no_double_booking. */
  hora: number;
  /** Dias atrás. */
  diasAtras?: number;
  atrasoMin: number;
  duracaoMin: number;
}): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `with marcado as (
       select (date_trunc('day', now() - make_interval(days => $6::int)) + make_interval(hours => $5::int)) as inicio
     )
     insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
        price_cents, status, started_at, finished_at)
     select $1, $2, $3, $4,
            m.inicio,
            m.inicio + interval '1 hour',
            25000, 'realizado',
            m.inicio + make_interval(mins => $7::int),
            m.inicio + make_interval(mins => $7::int) + make_interval(mins => $8::int)
       from marcado m
     returning id`,
    [o.clinic, o.prof, o.paciente, o.proc, o.hora, o.diasAtras ?? 1, o.atrasoMin, o.duracaoMin],
  );
  const linha = rows[0];
  if (linha === undefined) throw new Error('o cenário não inseriu a consulta');
  return linha.id;
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  app = appPool();
  c = await seed(owner);

  // A clínica B ganha equipe e cadastro próprios: sem isso não há o que a RLS
  // possa deixar escapar, e o teste de isolamento passaria por falta de dado.
  const { rows: pb } = await owner.query<{ id: string }>(
    `insert into app.professionals (clinic_id, name) values ($1, 'Dr. Bruno') returning id`,
    [c.clinicB],
  );
  profB = pb[0]?.id ?? '';
  const { rows: pr } = await owner.query<{ id: string }>(
    `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
     values ($1, 'Limpeza da B', 60, 20000) returning id`,
    [c.clinicB],
  );
  procB = pr[0]?.id ?? '';
}, 90_000);

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('pontualidade por profissional', () => {
  /**
   * O limite é fechado, e é a mesma decisão que `percentualNoHorario` mostra na
   * tela: começar exatamente dez minutos depois ainda é "no horário"; onze não é.
   */
  it('o "no horário" da view é a tolerância declarada no core', async () => {
    await owner.query('delete from app.appointments');
    const paciente = c.patients[0];
    if (paciente === undefined) throw new Error('o cenário não tem paciente');

    await realizado({
      clinic: c.clinicA,
      prof: c.profA,
      proc: c.procEletivo,
      paciente,
      hora: 8,
      atrasoMin: TOLERANCIA_PONTUALIDADE_MIN,
      duracaoMin: 60,
    });
    await realizado({
      clinic: c.clinicA,
      prof: c.profA,
      proc: c.procEletivo,
      paciente,
      hora: 10,
      atrasoMin: TOLERANCIA_PONTUALIDADE_MIN + 1,
      duracaoMin: 60,
    });

    const { rows } = await owner.query<{ atendimentos: number; no_horario: number }>(
      `select sum(appointments)::int as atendimentos, sum(on_time)::int as no_horario
         from app.professional_punctuality where professional_id = $1`,
      [c.profA],
    );
    expect(rows[0]?.atendimentos).toBe(2);
    expect(
      rows[0]?.no_horario,
      'a view e TOLERANCIA_PONTUALIDADE_MIN discordam de quem chegou no horário',
    ).toBe(1);
  });

  it('atendimento que nunca começou não entra na conta', async () => {
    await owner.query('delete from app.appointments');
    const paciente = c.patients[0];
    if (paciente === undefined) throw new Error('o cenário não tem paciente');
    // Marcada e nunca iniciada: não é atraso, é consulta que não aconteceu (ainda).
    await owner.query(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
       values ($1,$2,$3,$4, now() + interval '2 hours', now() + interval '3 hours', 25000)`,
      [c.clinicA, c.profA, paciente, c.procEletivo],
    );
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from app.professional_punctuality where professional_id = $1`,
      [c.profA],
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('duração real por procedimento', () => {
  beforeAll(async () => {
    await owner.query('delete from app.appointments');
    const [p1, p2, p3] = c.patients;
    if (p1 === undefined || p2 === undefined || p3 === undefined) {
      throw new Error('o cenário precisa de três pacientes');
    }

    // A Limpeza está cadastrada em 60 min. Nove atendimentos de 90, dois deles com
    // um segundo profissional: a amostra é do PROCEDIMENTO, não de uma pessoa.
    const outra = await owner.query<{ id: string }>(
      `insert into app.professionals (clinic_id, name) values ($1, 'Dra. Bia') returning id`,
      [c.clinicA],
    );
    const bia = outra.rows[0]?.id ?? '';

    for (let i = 0; i < 7; i++) {
      await realizado({
        clinic: c.clinicA,
        prof: c.profA,
        proc: c.procEletivo,
        paciente: p1,
        hora: 8,
        diasAtras: i + 1,
        atrasoMin: 0,
        duracaoMin: 90,
      });
    }
    for (let i = 0; i < 2; i++) {
      await realizado({
        clinic: c.clinicA,
        prof: bia,
        proc: c.procEletivo,
        paciente: p2,
        hora: 8,
        diasAtras: i + 1,
        atrasoMin: 0,
        duracaoMin: 90,
      });
    }

    // Dor aguda: uma medida só. Amostra pequena de propósito.
    await realizado({
      clinic: c.clinicA,
      prof: c.profA,
      proc: c.procUrgente,
      paciente: p3,
      hora: 14,
      atrasoMin: 0,
      duracaoMin: 75,
    });

    // Fora da janela de 90 dias: medida velha não descreve o mês que vem.
    await realizado({
      clinic: c.clinicA,
      prof: c.profA,
      proc: c.procLongo,
      paciente: p1,
      hora: 16,
      diasAtras: 200,
      atrasoMin: 0,
      duracaoMin: 200,
    });

    // E a clínica B, para a RLS ter o que esconder.
    await realizado({
      clinic: c.clinicB,
      prof: profB,
      proc: procB,
      paciente: c.patientB,
      hora: 9,
      atrasoMin: 0,
      duracaoMin: 90,
    });
  }, 60_000);

  it('a amostra atravessa a equipe: nove atendimentos, dois profissionais', async () => {
    const { rows } = await owner.query<{ sample_size: number; median_minutes: string }>(
      `select sample_size, median_minutes from app.procedure_real_durations_by_procedure
        where procedure_id = $1`,
      [c.procEletivo],
    );
    expect(rows[0]?.sample_size).toBe(9);
    expect(Number(rows[0]?.median_minutes)).toBe(90);

    // A view por PROFISSIONAL da 0002 continua vendo sete e dois, separados: as
    // duas respondem perguntas diferentes e nenhuma substitui a outra.
    const { rows: porProf } = await owner.query<{ sample_size: number }>(
      `select sample_size from app.procedure_real_durations
        where procedure_id = $1 order by sample_size desc`,
      [c.procEletivo],
    );
    expect(porProf.map((l) => l.sample_size)).toEqual([7, 2]);
  });

  it('medida de mais de 90 dias não entra', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from app.procedure_real_durations_by_procedure where procedure_id = $1`,
      [c.procLongo],
    );
    expect(rows[0]?.n, 'atendimento de 200 dias atrás entrou na amostra').toBe('0');
  });

  it('a duração cadastrada vem junto, para a comparação não precisar de segunda consulta', async () => {
    const { rows } = await owner.query<{ scheduled_minutes: number }>(
      `select scheduled_minutes from app.procedure_real_durations_by_procedure where procedure_id = $1`,
      [c.procEletivo],
    );
    expect(rows[0]?.scheduled_minutes).toBe(60);
  });

  /** A view é `security_invoker`: quem lê de dentro da clínica A não vê a B. */
  it('a RLS vale na view: a clínica A não vê o procedimento da B', async () => {
    const daA = await asClinic(app, c.clinicA, async (cli) => {
      const { rows } = await cli.query<{ procedure_id: string }>(
        `select procedure_id from app.procedure_real_durations_by_procedure`,
      );
      return rows.map((l) => l.procedure_id);
    });
    expect(daA).toContain(c.procEletivo);
    expect(daA, 'procedimento da clínica B apareceu para a A').not.toContain(procB);

    const daB = await asClinic(app, c.clinicB, async (cli) => {
      const { rows } = await cli.query<{ procedure_id: string }>(
        `select procedure_id from app.procedure_real_durations_by_procedure`,
      );
      return rows.map((l) => l.procedure_id);
    });
    expect(daB).toEqual([procB]);
  });

  it('a pontualidade também não atravessa clínica', async () => {
    const daB = await asClinic(app, c.clinicB, async (cli) => {
      const { rows } = await cli.query<{ professional_id: string }>(
        `select professional_id from app.professional_punctuality`,
      );
      return rows.map((l) => l.professional_id);
    });
    expect(daB).toEqual([profB]);
  });
});

describe('o carimbo do ajuste de duração', () => {
  it('data sem autor é recusada pelo banco', async () => {
    await expect(
      owner.query(`update app.procedures set duration_updated_at = now() where id = $1`, [
        c.procEletivo,
      ]),
    ).rejects.toThrow(/duracao_carimbada/);
  });

  it('autor sem data também', async () => {
    await expect(
      owner.query(
        `update app.procedures set duration_updated_by = gen_random_uuid() where id = $1`,
        [c.procEletivo],
      ),
    ).rejects.toThrow(/duracao_carimbada/);
  });

  it('os dois juntos passam, e é o par que responde "quem encurtou a limpeza?"', async () => {
    const autor = '33333333-3333-4333-8333-333333333333';
    await owner.query(
      `update app.procedures
          set duration_minutes = 90, duration_updated_by = $2, duration_updated_at = now()
        where id = $1`,
      [c.procEletivo, autor],
    );
    const { rows } = await owner.query<{
      duration_minutes: number;
      duration_updated_by: string;
      duration_updated_at: Date;
    }>(
      `select duration_minutes, duration_updated_by, duration_updated_at
         from app.procedures where id = $1`,
      [c.procEletivo],
    );
    expect(rows[0]?.duration_minutes).toBe(90);
    expect(rows[0]?.duration_updated_by).toBe(autor);
    expect(rows[0]?.duration_updated_at).toBeInstanceOf(Date);
  });

  it('cadastro nunca ajustado tem os dois nulos, e isso não é falta de informação', async () => {
    const { rows } = await owner.query<{ at: Date | null; by: string | null }>(
      `select duration_updated_at as at, duration_updated_by as by
         from app.procedures where id = $1`,
      [c.procUrgente],
    );
    expect(rows[0]?.at).toBeNull();
    expect(rows[0]?.by).toBeNull();
  });
});
