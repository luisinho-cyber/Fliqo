import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarFila, FILA_CONVERSA, SCHEMA_FILA } from '../scripts/fila.mjs';
import { definirPapelDaAplicacao, PAPEL } from '../scripts/papel-app.mjs';
import { ownerPool, prepararFilaDeTeste, resetDatabase } from '../src/testing';

/**
 * O caminho de produção: a API não conecta como dono do schema, conecta como
 * `fliqo_app`, com senha. Este teste prova que esse papel existe, entra com
 * senha e continua preso pela RLS — se a senha desse acesso irrestrito, o
 * isolamento entre clínicas seria decoração.
 */

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres@localhost:5432/postgres';
const SENHA = 'senha-de-teste-do-fliqo-app-1234';
const TEST_DB = 'fliqo_test';

let owner: pg.Pool;
let clinicaA: string;
let clinicaB: string;

function urlDoPapel(senha: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB}`;
  u.username = PAPEL;
  u.password = senha;
  return u.toString();
}

async function comoAplicacao<T>(fn: (c: pg.Client) => Promise<T>, senha = SENHA): Promise<T> {
  const c = new pg.Client({ connectionString: urlDoPapel(senha) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.clinics (name) values ('Clínica A'), ('Clínica B') returning id`,
  );
  clinicaA = rows[0]!.id;
  clinicaB = rows[1]!.id;
  await definirPapelDaAplicacao(ADMIN_URL, SENHA);
}, 90_000);

afterAll(async () => {
  await owner.end();
  // Deixa o papel sem login: nenhum teste seguinte, nem um script rodado sem
  // querer, entra com a senha deste arquivo.
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  await c.query(`alter role ${PAPEL} with nologin`);
  await c.end();
});

describe('papel da aplicação', () => {
  it('recusa senha curta antes de tocar no banco', async () => {
    await expect(definirPapelDaAplicacao(ADMIN_URL, 'curta')).rejects.toThrow('ao menos 20');
  });

  it('entra no banco com a senha definida', async () => {
    const quem = await comoAplicacao((c) => c.query<{ u: string }>('select current_user as u'));
    expect(quem.rows[0]?.u).toBe(PAPEL);
  });

  it('rodar de novo troca a senha, e a antiga para de valer', async () => {
    const nova = `${SENHA}-trocada`;
    await definirPapelDaAplicacao(ADMIN_URL, nova);
    await expect(comoAplicacao((c) => c.query('select 1'), SENHA)).rejects.toThrow();
    const ok = await comoAplicacao((c) => c.query('select 1'), nova);
    expect(ok.rowCount).toBe(1);
    await definirPapelDaAplicacao(ADMIN_URL, SENHA);
  });

  it('continua preso pela RLS: só enxerga a clínica da transação', async () => {
    const visiveis = await comoAplicacao(async (c) => {
      await c.query('begin');
      await c.query(`select set_config('app.clinic_id', $1, true)`, [clinicaA]);
      const r = await c.query<{ id: string }>('select id from app.clinics');
      await c.query('commit');
      return r.rows.map((x) => x.id);
    });
    expect(visiveis).toEqual([clinicaA]);
    expect(visiveis).not.toContain(clinicaB);
  });

  it('não é dono do schema: não consegue desligar a RLS', async () => {
    await expect(
      comoAplicacao((c) => c.query('alter table app.clinics disable row level security')),
    ).rejects.toThrow();
  });
});

/**
 * A fila em produção é criada no passo de migração, com a conexão de dono.
 * A API e o worker só a usam. Se eles tentassem criar ou migrar o schema,
 * morreriam no start — `fliqo_app` não tem direito de mexer em schema.
 */
describe('fila vista pelo papel da aplicação', () => {
  it('enfileira sem precisar de direito sobre o schema', async () => {
    await prepararFilaDeTeste();
    const boss = criarFila(urlDoPapel(SENHA));
    await boss.start();
    try {
      const id = await boss.send(FILA_CONVERSA, { teste: true });
      expect(id).toBeTruthy();
    } finally {
      await boss.stop();
    }
  });

  it('reclama de schema desatualizado em vez de tentar migrar', async () => {
    await prepararFilaDeTeste();
    // Uma versão do pg-boss mais nova do que a do banco: o start da aplicação
    // tem de parar com um erro claro, não tentar um DDL que ela não pode fazer.
    await owner.query(`update ${SCHEMA_FILA}.version set version = version - 1`);
    const boss = criarFila(urlDoPapel(SENHA));
    await expect(boss.start()).rejects.toThrow(/migration/i);
    await owner.query(`update ${SCHEMA_FILA}.version set version = version + 1`);
  });
});
