import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { COLUNAS } from '../src/schema';
import { ownerPool, resetDatabase } from './helpers';

/**
 * Os tipos de packages/db/src/schema.ts são escritos à mão. Este teste é o que
 * impede que eles mintam: compara coluna a coluna com o Postgres depois de aplicar
 * todas as migrações. Migração nova que mexe no schema quebra aqui até alguém
 * atualizar o tipo — que é o ponto.
 */
describe('tipos do banco', () => {
  let owner: pg.Pool;
  let real: Map<string, Set<string>>;

  beforeAll(async () => {
    await resetDatabase();
    owner = ownerPool();
    const { rows } = await owner.query<{ tabela: string; coluna: string }>(
      `select c.table_name as tabela, c.column_name as coluna
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'app' and t.table_type = 'BASE TABLE'`,
    );
    real = new Map();
    for (const { tabela, coluna } of rows) {
      const set = real.get(tabela) ?? new Set<string>();
      set.add(coluna);
      real.set(tabela, set);
    }
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  it('descreve exatamente as tabelas que existem no schema app', () => {
    const tipadas = Object.keys(COLUNAS)
      .map((t) => t.replace(/^app\./, ''))
      .sort();
    expect(tipadas).toEqual([...real.keys()].sort());
  });

  it('descreve exatamente as colunas de cada tabela', () => {
    for (const [nomeCompleto, colunas] of Object.entries(COLUNAS)) {
      const tabela = nomeCompleto.replace(/^app\./, '');
      const noBanco = real.get(tabela);
      expect(noBanco, `tabela ${tabela} não existe no banco`).toBeDefined();
      expect(Object.keys(colunas).sort(), `colunas de ${tabela}`).toEqual(
        [...(noBanco ?? [])].sort(),
      );
    }
  });
});
