import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ownerPool, resetDatabase, seed, type Scenario } from './helpers';

/**
 * A chave natural da importação contra a constraint de agenda.
 *
 * Este arquivo existe por um bloqueio que quase entrou: a primeira versão do índice
 * da 0012 era única sobre TODA consulta, e a `no_double_booking` da 0001 exclui
 * `cancelado` e `faltou` — como tem de excluir, senão ninguém nunca remarcaria um
 * horário cancelado. As duas discordavam, e quem pagava era a operação mais comum
 * de uma clínica.
 *
 * As três linhas abaixo são as que não podem brigar nunca mais:
 *   1. remarcar horário cancelado, mesmo trio, PASSA;
 *   2. reimportar a mesma linha, mesmo cancelada, NÃO ressuscita;
 *   3. dois pacientes no mesmo horário ativo continua impossível.
 */

let owner: pg.Pool;
let c: Scenario;
let paciente: string;

/** Uma consulta como a recepção cria, ou como a importação cria — a origem é o argumento. */
async function marcar(o: {
  hora: number;
  origem: 'recepcao' | 'importado' | 'lista_espera';
  paciente?: string;
}): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `with marcado as (
       select date_trunc('day', now() + interval '10 days') + make_interval(hours => $5::int) as inicio
     )
     insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents, source)
     select $1, $2, $3, $4, m.inicio, m.inicio + interval '30 minutes', 25000, $6
       from marcado m
     returning id`,
    [c.clinicA, c.profA, o.paciente ?? paciente, c.procEletivo, o.hora, o.origem],
  );
  const linha = rows[0];
  if (linha === undefined) throw new Error('o cenário não inseriu a consulta');
  return linha.id;
}

async function cancelar(id: string): Promise<void> {
  await owner.query(
    `update app.appointments set status = 'cancelado', cancelled_at = now() where id = $1`,
    [id],
  );
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  const p = c.patients[0];
  if (p === undefined) throw new Error('o cenário não tem paciente');
  paciente = p;
}, 60_000);

afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.appointments');
});

describe('a constraint de agenda da 0001', () => {
  /**
   * O fato do qual tudo depende. Se um dia alguém tirar `cancelado` desta lista, a
   * clínica para de poder remarcar e este teste é quem conta.
   */
  it('exclui cancelado e faltou dos status que bloqueiam o horário', async () => {
    const { rows } = await owner.query<{ definicao: string }>(
      `select pg_get_constraintdef(oid) as definicao from pg_constraint
        where conname = 'no_double_booking'`,
    );
    const definicao = rows[0]?.definicao ?? '';
    expect(definicao, 'a no_double_booking não existe mais').toContain('EXCLUDE');
    for (const ativo of ['agendado', 'confirmado', 'em_risco', 'realizado']) {
      expect(definicao, `${ativo} deveria bloquear o horário`).toContain(ativo);
    }
    for (const livre of ['cancelado', 'faltou']) {
      expect(definicao, `${livre} não pode bloquear o horário`).not.toContain(livre);
    }
  });

  it('dois pacientes no mesmo horário ativo continua impossível', async () => {
    const outro = c.patients[1];
    if (outro === undefined) throw new Error('o cenário precisa de dois pacientes');
    await marcar({ hora: 9, origem: 'recepcao' });
    await expect(marcar({ hora: 9, origem: 'recepcao', paciente: outro })).rejects.toThrow(
      /no_double_booking/,
    );
  });
});

describe('remarcar horário cancelado', () => {
  /**
   * O caso que o índice único sobre toda consulta bloquearia: MESMO paciente, MESMO
   * profissional, MESMO horário. É o que acontece quando o paciente cancela e liga de
   * volta meia hora depois, e é o caminho que a lista de espera usa.
   */
  it('o mesmo trio depois de cancelar passa', async () => {
    const primeira = await marcar({ hora: 9, origem: 'recepcao' });
    await cancelar(primeira);

    const segunda = await marcar({ hora: 9, origem: 'recepcao' });
    expect(segunda).not.toBe(primeira);

    const { rows } = await owner.query<{ status: string; source: string }>(
      `select status, source from app.appointments order by created_at`,
    );
    expect(rows.map((l) => l.status)).toEqual(['cancelado', 'agendado']);
  });

  it('vale também pela lista de espera, que é o outro caminho', async () => {
    const primeira = await marcar({ hora: 9, origem: 'recepcao' });
    await cancelar(primeira);
    await expect(marcar({ hora: 9, origem: 'lista_espera' })).resolves.toBeTruthy();
  });

  /** E depois de faltar, que é o outro status que a EXCLUDE libera. */
  it('o mesmo trio depois de faltar também passa', async () => {
    const primeira = await marcar({ hora: 9, origem: 'recepcao' });
    await owner.query(`update app.appointments set status = 'faltou' where id = $1`, [primeira]);
    await expect(marcar({ hora: 9, origem: 'recepcao' })).resolves.toBeTruthy();
  });

  /**
   * E o trio remarcado DEPOIS de uma importação: a consulta importada foi cancelada,
   * e a recepção remarca. A origem diferente é o que faz passar.
   */
  it('remarcação depois de cancelar consulta importada passa', async () => {
    const importada = await marcar({ hora: 9, origem: 'importado' });
    await cancelar(importada);
    await expect(marcar({ hora: 9, origem: 'recepcao' })).resolves.toBeTruthy();
  });
});

describe('o encaixe no horário liberado', () => {
  /**
   * A operação mais comum de uma clínica, e a que a lista de espera existe para fazer:
   * o paciente cancela as 14h de terça, a recepção encaixa OUTRO paciente no mesmo
   * horário. Duas coisas a liberam, e as duas precisam valer ao mesmo tempo:
   *
   *   - a `no_double_booking` exclui `cancelado`, então o intervalo está livre;
   *   - a chave natural é parcial em `source = 'importado'`, e o encaixe entra como
   *     `recepcao` ou `lista_espera` — fica fora do índice.
   *
   * O caso de remarcação do MESMO paciente já tinha teste acima. Este é o de paciente
   * diferente, que é o que a clínica faz todo dia, e ele não tinha.
   */
  it('outro paciente entra no horário que foi cancelado', async () => {
    const outro = c.patients[1];
    if (outro === undefined) throw new Error('o cenário precisa de dois pacientes');

    const cancelada = await marcar({ hora: 14, origem: 'recepcao' });
    await cancelar(cancelada);

    await expect(
      marcar({ hora: 14, origem: 'recepcao', paciente: outro }),
      'o encaixe da recepção no horário liberado foi bloqueado',
    ).resolves.toBeTruthy();

    const { rows } = await owner.query<{ status: string; patient_id: string }>(
      `select status, patient_id from app.appointments order by created_at`,
    );
    expect(rows.map((l) => l.status)).toEqual(['cancelado', 'agendado']);
  });

  it('e entra pela lista de espera também, que é o caminho automático', async () => {
    const outro = c.patients[1];
    if (outro === undefined) throw new Error('o cenário precisa de dois pacientes');
    const cancelada = await marcar({ hora: 14, origem: 'recepcao' });
    await cancelar(cancelada);
    await expect(
      marcar({ hora: 14, origem: 'lista_espera', paciente: outro }),
    ).resolves.toBeTruthy();
  });

  it('o mesmo vale depois de uma falta', async () => {
    const outro = c.patients[1];
    if (outro === undefined) throw new Error('o cenário precisa de dois pacientes');
    const faltou = await marcar({ hora: 14, origem: 'recepcao' });
    await owner.query(`update app.appointments set status = 'faltou' where id = $1`, [faltou]);
    await expect(marcar({ hora: 14, origem: 'recepcao', paciente: outro })).resolves.toBeTruthy();
  });

  it('e vale até no horário que uma consulta IMPORTADA deixou livre', async () => {
    // A clínica em modo convidado cancela na Fliqo e encaixa pela lista de espera: a
    // origem diferente é o que faz passar.
    const outro = c.patients[1];
    if (outro === undefined) throw new Error('o cenário precisa de dois pacientes');
    const importada = await marcar({ hora: 14, origem: 'importado' });
    await cancelar(importada);
    await expect(
      marcar({ hora: 14, origem: 'lista_espera', paciente: outro }),
    ).resolves.toBeTruthy();
  });

  /**
   * Por que o `where` é por ORIGEM e não por status, dito pela função que paga a conta.
   *
   * `app.claim_slot_offer` (0001) captura só `exclusion_violation` ao inserir o aceite da
   * vaga. Um `unique_violation` ali NÃO é tratado: em vez de marcar a oferta como
   * "preenchida por outro" e seguir, a função estoura e a transação toda vai embora.
   *
   * É por isso que a chave natural não pode alcançar o caminho da lista de espera. Copiar
   * para o índice a cláusula de status da EXCLUDE pareceria equivalente e não é: ela
   * deixaria a reimportação ressuscitar consulta cancelada, e para cobrir isso o índice
   * teria de valer para `lista_espera` também — justo o caminho que não sabe tratar o erro.
   */
  it('a função da lista de espera só trata conflito de INTERVALO', async () => {
    const { rows } = await owner.query<{ corpo: string }>(
      `select pg_get_functiondef(oid) as corpo from pg_proc
        where proname = 'claim_slot_offer' and pronamespace = 'app'::regnamespace`,
    );
    const corpo = rows[0]?.corpo ?? '';
    expect(corpo, 'claim_slot_offer não existe mais').not.toBe('');
    expect(corpo).toContain('exclusion_violation');
    expect(
      corpo,
      'se a função passar a tratar unique_violation, a chave natural pode alcançá-la — ' +
        'até lá, ela não pode',
    ).not.toContain('unique_violation');
  });
});

describe('a chave natural é só das importadas', () => {
  it('o índice é parcial em source = importado', async () => {
    const { rows } = await owner.query<{ definicao: string }>(
      `select pg_get_indexdef(indexrelid) as definicao from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where c.relname = 'appointment_natural_key'`,
    );
    const definicao = rows[0]?.definicao ?? '';
    expect(definicao, 'o índice da chave natural não existe').toContain('UNIQUE');
    expect(
      definicao,
      'índice sobre toda consulta bloqueia remarcação de horário cancelado',
    ).toMatch(/WHERE \(source = 'importado'/);
  });

  /** Reimportar a mesma linha, mesmo cancelada, não ressuscita: a chave continua ocupada. */
  it('a segunda importada do mesmo trio bate na chave, mesmo cancelada', async () => {
    const importada = await marcar({ hora: 9, origem: 'importado' });
    await cancelar(importada);
    await expect(marcar({ hora: 9, origem: 'importado' })).rejects.toThrow(
      /appointment_natural_key/,
    );
  });

  /**
   * Duas consultas de recepção com o mesmo trio, a primeira cancelada, NÃO batem na
   * chave — elas estão fora do índice. Quem as separa é a EXCLUDE, e ela libera.
   */
  it('duas de recepção com o mesmo trio não entram no índice', async () => {
    const primeira = await marcar({ hora: 9, origem: 'recepcao' });
    await cancelar(primeira);
    await marcar({ hora: 9, origem: 'recepcao' });

    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from app.appointments where source = 'recepcao'`,
    );
    expect(rows[0]?.n).toBe('2');
  });
});

describe('procedimento criado pela importação se reconhece', () => {
  it('o cadastro normal nasce como cadastro', async () => {
    const { rows } = await owner.query<{ source: string }>(
      `select source from app.procedures where id = $1`,
      [c.procEletivo],
    );
    expect(rows[0]?.source).toBe('cadastro');
  });

  /**
   * O que o Caixa vai precisar perguntar no dia em que uma clínica desligar o modo
   * convidado: quais procedimentos têm preço que ninguém cadastrou. Sem a origem, a
   * resposta seria "preço zero", que confunde o gratuito de verdade com o não
   * cadastrado — e somar zero faz a tela mentir com cara de verde.
   */
  it('a origem distingue preço zero cadastrado de preço nunca cadastrado', async () => {
    await owner.query(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents, source)
       values ($1, 'Da planilha', 30, 0, 'importado'), ($1, 'Cortesia', 30, 0, 'cadastro')`,
      [c.clinicA],
    );
    const { rows } = await owner.query<{ nome: string }>(
      `select name as nome from app.procedures
        where source = 'importado' and price_cents = 0 order by name`,
    );
    expect(rows.map((l) => l.nome)).toEqual(['Da planilha']);
  });

  it('origem que ninguém declarou é recusada pelo banco', async () => {
    await expect(
      owner.query(
        `insert into app.procedures (clinic_id, name, duration_minutes, price_cents, source)
         values ($1, 'Inventada', 30, 0, 'sei_la')`,
        [c.clinicA],
      ),
    ).rejects.toThrow(/procedures_source_check/);
  });
});
