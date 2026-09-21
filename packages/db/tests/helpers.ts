import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Banco descartável para testes. Nunca aponte para produção.
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres@localhost:5432/postgres';
const TEST_DB = 'fliqo_test';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
// Todas as migrações, em ordem — o teste roda contra o schema completo, como produção.
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(migrationsDir + f, 'utf8'));

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** Recria o banco de teste do zero e aplica a migração. */
export async function resetDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'fliqo_tester') then
        create role fliqo_tester login;
      end if; end $$`);
  await admin.end();

  const owner = new pg.Client({ connectionString: withDb(ADMIN_URL, TEST_DB) });
  await owner.connect();
  for (const sql of migrations) await owner.query(sql);
  await owner.query('grant fliqo_app to fliqo_tester');
  await owner.end();
}

/** Conexão como dono do schema (ignora RLS). Só para montar cenário. */
export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: withDb(ADMIN_URL, TEST_DB), max: 4 });
}

/** Conexão como a aplicação (sujeita à RLS), igual à API em produção. */
export function appPool(): pg.Pool {
  const u = new URL(withDb(ADMIN_URL, TEST_DB));
  u.username = 'fliqo_tester';
  return new pg.Pool({ connectionString: u.toString(), max: 8 });
}

/** Executa `fn` numa transação já "dentro" da clínica — o padrão que a API deve seguir. */
export async function asClinic<T>(
  pool: pg.Pool,
  clinicId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

export interface Scenario {
  clinicA: string;
  clinicB: string;
  profA: string;
  procEletivo: string;   // 60 min, prioridade 0
  procUrgente: string;   // 30 min, prioridade 3
  procLongo: string;     // 120 min
  patients: string[];    // 4 pacientes na clínica A
  patientB: string;      // 1 paciente na clínica B
}

export async function seed(owner: pg.Pool): Promise<Scenario> {
  const one = async (sql: string, p: unknown[] = []) => (await owner.query(sql, p)).rows[0].id as string;
  const clinicA = await one(`insert into app.clinics (name) values ('Clínica A') returning id`);
  const clinicB = await one(`insert into app.clinics (name) values ('Clínica B') returning id`);
  const profA = await one(`insert into app.professionals (clinic_id, name) values ($1, 'Dra. Ana') returning id`, [clinicA]);
  const proc = (name: string, dur: number, price: number, prio: number) =>
    one(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents, priority_level)
       values ($1, $2, $3, $4, $5) returning id`,
      [clinicA, name, dur, price, prio],
    );
  const procEletivo = await proc('Limpeza', 60, 25000, 0);
  const procUrgente = await proc('Dor aguda', 30, 30000, 3);
  const procLongo = await proc('Implante', 120, 350000, 0);
  const patients: string[] = [];
  for (let i = 1; i <= 4; i++) {
    patients.push(
      await one(
        `insert into app.patients (clinic_id, name, phone_e164) values ($1, $2, $3) returning id`,
        [clinicA, `Paciente ${i}`, `+551199999000${i}`],
      ),
    );
  }
  const patientB = await one(
    `insert into app.patients (clinic_id, name, phone_e164) values ($1, 'Paciente B', '+5511988887777') returning id`,
    [clinicB],
  );
  return { clinicA, clinicB, profA, procEletivo, procUrgente, procLongo, patients, patientB };
}
