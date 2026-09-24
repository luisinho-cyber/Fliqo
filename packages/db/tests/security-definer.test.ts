import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetDatabase } from '../src/testing';

/**
 * As funções que cruzam clínicas.
 *
 * `security definer` roda com os poderes de quem criou a função, não de quem
 * chama: é o único jeito de a aplicação ver mais de uma clínica, e por isso é a
 * única porta por onde o isolamento entre clínicas pode vazar. A lista abaixo é
 * a revisão — acrescentar uma quinta função sem passar por aqui quebra o CI, que
 * é exatamente o que se quer.
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
  it('são exatamente as quatro revisadas', async () => {
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
