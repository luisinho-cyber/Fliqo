import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrar } from '../scripts/migrate.mjs';

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres@localhost:5432/postgres';
// Banco próprio: o dos outros testes é recriado por eles, e aqui o que importa é o histórico.
const DB = 'fliqo_migrate_test';

function comBanco(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const alvo = comBanco(ADMIN_URL, DB);

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function noAlvo<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: alvo });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function recriarBanco(): Promise<void> {
  await admin(async (c) => {
    await c.query(`drop database if exists ${DB} with (force)`);
    await c.query(`create database ${DB}`);
  });
}

async function versoesRegistradas(): Promise<string[]> {
  return noAlvo(async (c) => {
    const { rows } = await c.query<{ version: string }>(
      'select version from public.schema_migrations order by version',
    );
    return rows.map((r) => r.version);
  });
}

describe('migrador', () => {
  beforeAll(recriarBanco, 60_000);
  afterAll(async () => {
    await admin((c) => c.query(`drop database if exists ${DB} with (force)`));
  });

  it('aplica todas as migrações em ordem e registra cada uma', async () => {
    const { aplicadas, puladas } = await migrar(alvo);

    expect(puladas).toEqual([]);
    expect(aplicadas.length).toBeGreaterThanOrEqual(2);
    expect(aplicadas).toEqual([...aplicadas].sort());
    expect(await versoesRegistradas()).toEqual(aplicadas);
  });

  it('o schema realmente existe depois de migrar', async () => {
    const tabelas = await noAlvo(async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `select table_name as n from information_schema.tables where table_schema = 'app'`,
      );
      return rows.map((r) => r.n);
    });
    expect(tabelas).toContain('clinics');
    expect(tabelas).toContain('appointments');
  });

  it('rodar de novo não reaplica nada', async () => {
    const antes = await versoesRegistradas();
    const { aplicadas, puladas } = await migrar(alvo);

    expect(aplicadas).toEqual([]);
    expect(puladas).toEqual(antes);
    // Reaplicar 0001 num banco já migrado daria erro de "type already exists";
    // chegar aqui sem exceção é parte do que o teste prova.
    expect(await versoesRegistradas()).toEqual(antes);
  });

  it('recusa migração já aplicada que foi editada depois', async () => {
    const [primeira] = await versoesRegistradas();
    await noAlvo((c) =>
      c.query('update public.schema_migrations set checksum = $1 where version = $2', [
        'checksum-de-outro-conteudo',
        primeira,
      ]),
    );

    await expect(migrar(alvo)).rejects.toThrow(/nunca é editada/);
  });
});
