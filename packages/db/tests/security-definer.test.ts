import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetDatabase } from '../src/testing';

/**
 * As funções que cruzam clínicas.
 *
 * `security definer` roda com os poderes de quem criou a função, não de quem
 * chama: é o único jeito de a aplicação ver mais de uma clínica, e por isso é a
 * única porta por onde o isolamento entre clínicas pode vazar. A lista abaixo é
 * a revisão — acrescentar mais uma sem passar por aqui quebra o CI, que é
 * exatamente o que se quer.
 */
const ESPERADAS = [
  // Worker: pega o lote de ações vencidas de todas as clínicas (0001).
  'claim_due_actions',
  // Webhook: traduz o phone_number_id da Meta para a clínica, antes de haver
  // clínica na transação (0003).
  'clinic_by_phone_number_id',
  // Varredor: devolve à fila o que ficou preso em 'executando' (0004).
  'requeue_stuck_actions',
  // Varredura de atrasos: devolve só os ids das clínicas com atendimento hoje (0006).
  'clinics_with_appointments_today',
  // Painel: as clínicas da pessoa que acabou de entrar, antes de haver clínica
  // na transação. Devolve só os ids (0007).
  'clinic_ids_of_member',
].sort();

let owner: pg.Pool;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
}, 90_000);

afterAll(async () => {
  await owner.end();
});

describe('funções que cruzam clínicas', () => {
  it('são exatamente as revisadas', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.prosecdef
        order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(ESPERADAS);
  });

  it('nenhuma delas é executável por public', async () => {
    // Sem o revoke, qualquer papel do banco atravessa a RLS por essa porta.
    const { rows } = await owner.query<{ proname: string; acl: string | null }>(
      `select p.proname, array_to_string(p.proacl::text[], ',') as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.prosecdef`,
    );
    for (const f of rows) {
      expect(f.acl, `${f.proname} não tem ACL: herdou execute de public`).not.toBeNull();
      expect(f.acl, `public executa ${f.proname}`).not.toMatch(/(^|,)=X/);
    }
  });

  it('todas fixam o search_path', async () => {
    // Sem search_path fixo, quem chama pode plantar um schema no meio do
    // caminho e a função passa a executar outra coisa com poderes de dono.
    const { rows } = await owner.query<{ proname: string; config: string[] | null }>(
      `select p.proname, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and p.prosecdef`,
    );
    for (const f of rows) {
      expect(f.config?.join(','), `${f.proname} sem search_path fixo`).toContain('search_path=');
    }
  });
});

describe('clínica ativa', () => {
  it('active é not null com default true: clínica existente não sai da varredura', async () => {
    // Se tivesse entrado nullable ou com default false, todas as clínicas de
    // antes da 0006 ficariam de fora e ninguém perceberia.
    const { rows } = await owner.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default
         from information_schema.columns
        where table_schema = 'app' and table_name = 'clinics' and column_name = 'active'`,
    );
    expect(rows[0]).toEqual({ is_nullable: 'NO', column_default: 'true' });
  });

  it('uma clínica criada sem dizer nada nasce ativa', async () => {
    const { rows } = await owner.query<{ active: boolean }>(
      `insert into app.clinics (name) values ('Clínica sem flag') returning active`,
    );
    expect(rows[0]?.active).toBe(true);
  });
});

describe('clinic_ids_of_member', () => {
  it('devolve só os ids das clínicas daquela pessoa, e nada além do id', async () => {
    const criar = async (nome: string): Promise<string> => {
      const { rows } = await owner.query<{ id: string }>(
        `insert into app.clinics (name) values ($1) returning id`,
        [nome],
      );
      if (!rows[0]) throw new Error('clínica não criada');
      return rows[0].id;
    };
    const daPessoa = await criar('Clínica da pessoa');
    const deOutra = await criar('Clínica de outra pessoa');
    const pessoa = '44444444-4444-4444-8444-444444444444';
    const outra = '55555555-5555-4555-8555-555555555555';
    await owner.query(
      `insert into app.clinic_members (clinic_id, user_id, role)
       values ($1,$2,'dono'), ($3,$4,'dono')`,
      [daPessoa, pessoa, deOutra, outra],
    );

    const { rows, fields } = await owner.query<{ clinic_ids_of_member: string }>(
      `select app.clinic_ids_of_member($1)`,
      [pessoa],
    );
    expect(rows.map((r) => r.clinic_ids_of_member)).toEqual([daPessoa]);
    // Uma coluna só: se alguém acrescentar nome ou telefone ao retorno, a
    // função passa a vazar dado de clínica para fora da RLS.
    expect(fields).toHaveLength(1);
  });

  it('clínica suspensa não aparece: quem foi desligado não entra no painel', async () => {
    const { rows: c } = await owner.query<{ id: string }>(
      `insert into app.clinics (name, active) values ('Clínica suspensa', false) returning id`,
    );
    const clinica = c[0]?.id;
    const pessoa = '66666666-6666-4666-8666-666666666666';
    await owner.query(
      `insert into app.clinic_members (clinic_id, user_id, role) values ($1,$2,'dono')`,
      [clinica, pessoa],
    );
    const { rows } = await owner.query(`select app.clinic_ids_of_member($1)`, [pessoa]);
    expect(rows).toEqual([]);
  });

  it('quem não é membro de nada não recebe clínica nenhuma', async () => {
    const { rows } = await owner.query(`select app.clinic_ids_of_member($1)`, [
      '77777777-7777-4777-8777-777777777777',
    ]);
    expect(rows).toEqual([]);
  });
});
