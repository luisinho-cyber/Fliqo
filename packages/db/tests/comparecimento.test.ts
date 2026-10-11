import { AMOSTRA_MINIMA_DE_COMPARECIMENTO, chanceDeComparecer } from '@fliqo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { criarDb, financeiro, withClinic, type Db } from '../src/index';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from './helpers';

/**
 * A amostra de comparecimento medida da clínica.
 *
 * O teste que importa é o do horário reencaixado. Cancelada com aviso não é comparecimento
 * perdido: o horário volta para a agenda, e a consulta que entra no lugar já está na amostra.
 * Com a cancelada no denominador o mesmo horário conta duas vezes, e a segunda sempre contra
 * a clínica — pior nas clínicas melhores, porque converter falta silenciosa em aviso
 * antecipado é o que a régua de confirmação faz.
 */

let owner: pg.Pool;
let db: Db;
let c: Scenario;

/** Uma consulta no passado, com status e horário escolhidos. Devolve o id. */
async function consulta(o: {
  status: 'realizado' | 'faltou' | 'cancelado' | 'agendado';
  diasAtras: number;
  hora: number;
  paciente: string;
  confirmada: boolean;
  clinic?: string;
  prof?: string;
}): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `with marcado as (
       select date_trunc('day', now() - make_interval(days => $5::int))
              + make_interval(hours => $6::int) as inicio
     )
     insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
        price_cents, status, confirmed_at)
     select $1, $2, $3, $4, m.inicio, m.inicio + interval '30 minutes', 25000, $7,
            case when $8::boolean then m.inicio - interval '1 day' else null end
       from marcado m
     returning id`,
    [
      o.clinic ?? c.clinicA,
      o.prof ?? c.profA,
      o.paciente,
      c.procEletivo,
      o.diasAtras,
      o.hora,
      o.status,
      o.confirmada,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('a consulta não foi inserida');
  return id;
}

function paciente(i: number): string {
  const p = c.patients[i % c.patients.length];
  if (p === undefined) throw new Error('o cenário precisa de pacientes');
  return p;
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await owner.end();
  await db.destroy();
});

function medir(clinica: string): Promise<{
  confirmada: { total: number; compareceram: number };
  sem_confirmacao: { total: number; compareceram: number };
  janelaDias: number;
}> {
  return withClinic(clinica, (trx) => financeiro.historicoDeComparecimento(trx, new Date()), db);
}

describe('o horário cancelado e reencaixado conta uma vez, não duas', () => {
  beforeAll(async () => {
    /*
     * O cenário do enunciado: 40 consultas no período, 30 realizadas, 2 faltas e 8
     * canceladas que foram reencaixadas — e as 8 reencaixadas realizadas estão entre as 30.
     *
     * As oito canceladas ocupam o MESMO starts_at da realizada que as substituiu, porque é
     * isso que reencaixar significa: a secretária pôs outro paciente nas 9h de terça. O
     * `no_double_booking` permite, e de propósito: a EXCLUDE não conta `cancelado` nem
     * `faltou`, senão o encaixe — a operação mais comum da clínica — seria impossível.
     */
    for (let i = 0; i < 8; i++) {
      await consulta({
        status: 'cancelado',
        diasAtras: i + 1,
        hora: 9,
        paciente: paciente(i),
        confirmada: true,
      });
      await consulta({
        status: 'realizado',
        diasAtras: i + 1,
        hora: 9,
        paciente: paciente(i + 1),
        confirmada: true,
      });
    }
    // As outras 22 realizadas, em horário próprio.
    for (let i = 0; i < 22; i++) {
      await consulta({
        status: 'realizado',
        diasAtras: i + 1,
        hora: 14,
        paciente: paciente(i),
        confirmada: true,
      });
    }
    for (let i = 0; i < 2; i++) {
      await consulta({
        status: 'faltou',
        diasAtras: i + 1,
        hora: 16,
        paciente: paciente(i),
        confirmada: true,
      });
    }
  }, 60_000);

  it('o período tem as 40 consultas que o cenário descreve', async () => {
    // Confere o CENÁRIO antes de conferir a conta: um teste que mede 32 porque só inseriu
    // 32 linhas provaria nada.
    const { rows } = await owner.query<{ status: string; quantas: string }>(
      `select status, count(*) as quantas from app.appointments
        where clinic_id = $1 group by status order by status`,
      [c.clinicA],
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, Number(r.quantas)]))).toEqual({
      cancelado: 8,
      faltou: 2,
      realizado: 30,
    });
  });

  it('a amostra é 32, não 40: realizado + faltou', async () => {
    const h = await medir(c.clinicA);
    expect(h.confirmada).toEqual({ total: 32, compareceram: 30 });
  });

  it('a taxa dá 30/32, e não 30/40', async () => {
    const h = await medir(c.clinicA);
    const chance = chanceDeComparecer(h.confirmada);
    expect(chance).toEqual({ ha: true, bp: 9375, amostra: 32 });
    // O que a versão antiga devolveria, para a diferença ficar escrita: 7500 bp.
    expect(chance.ha && chance.bp).not.toBe(7500);
  });

  it('a diferença são 18,75 pontos percentuais — não é arredondamento', async () => {
    // 93,75% contra 75,00%. Uma clínica boa apareceria como medíocre, e o esperado do Caixa
    // sairia um quarto menor do que o que ela de fato recebe.
    const h = await medir(c.clinicA);
    const comCancelada = Math.round((30 * 10_000) / 40);
    const chance = chanceDeComparecer(h.confirmada);
    expect((chance.ha ? chance.bp : 0) - comCancelada).toBe(1875);
  });

  it('cancelar mais não derruba a taxa', async () => {
    // O ponto do enunciado: quanto melhor a clínica for em arrancar aviso antecipado, mais
    // cancelada ela registra. Isso não pode custar nada na medida.
    const antes = await medir(c.clinicA);
    for (let i = 0; i < 10; i++) {
      await consulta({
        status: 'cancelado',
        diasAtras: i + 1,
        hora: 11,
        paciente: paciente(i),
        confirmada: true,
      });
    }
    const depois = await medir(c.clinicA);
    expect(depois.confirmada).toEqual(antes.confirmada);
  });

  it('a amostra passa do piso, então a taxa existe', async () => {
    // 32 contra o piso de 30. Com a cancelada no denominador seriam 40 — ou seja, a versão
    // antiga também passava, e o defeito nunca apareceria como "sem histórico".
    const h = await medir(c.clinicA);
    expect(h.confirmada.total).toBeGreaterThanOrEqual(AMOSTRA_MINIMA_DE_COMPARECIMENTO);
  });
});

describe('o que mais fica fora do denominador', () => {
  it('consulta que a recepção não marcou não conta como falta', async () => {
    // `agendado` no passado é desleixo de registro, não comportamento de paciente. Hora 20
    // porque `agendado` PARTICIPA do no_double_booking: precisa de horário livre de verdade.
    const antes = await medir(c.clinicA);
    const quem = c.patients[0];
    if (quem === undefined) throw new Error('o cenário precisa de um paciente');
    await consulta({
      status: 'agendado',
      diasAtras: 4,
      hora: 20,
      paciente: quem,
      confirmada: false,
    });
    const depois = await medir(c.clinicA);
    expect(depois).toEqual(antes);
  });

  it('o grupo vem de confirmed_at, e os dois grupos não se misturam', async () => {
    const semConfirmar = c.patients[0];
    if (semConfirmar === undefined) throw new Error('o cenário precisa de um paciente');
    const antes = await medir(c.clinicA);

    await consulta({
      status: 'faltou',
      diasAtras: 5,
      hora: 19,
      paciente: semConfirmar,
      confirmada: false,
    });

    const depois = await medir(c.clinicA);
    expect(depois.confirmada).toEqual(antes.confirmada);
    expect(depois.sem_confirmacao.total).toBe(antes.sem_confirmacao.total + 1);
    expect(depois.sem_confirmacao.compareceram).toBe(antes.sem_confirmacao.compareceram);
  });

  it('a amostra de uma clínica não vaza para a outra', async () => {
    const a = await medir(c.clinicA);
    const b = await medir(c.clinicB);
    expect(a.confirmada.total).toBeGreaterThan(0);
    expect(b.confirmada.total).toBe(0);
  });
});
