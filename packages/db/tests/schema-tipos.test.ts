import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { COLUNAS, FAIXAS_DE_ORCAMENTO } from '../src/schema';
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

  /**
   * As faixas de orçamento existem em dois lugares: no `check` da 0008 e em
   * FAIXAS_DE_ORCAMENTO, de onde a API monta o enum do Zod. Divergir não quebra
   * nada no start — quebra na cara da recepção, com 500 ao salvar uma faixa que
   * a API aceitou e o banco recusou, ou com uma faixa válida recusada antes de
   * chegar ao banco.
   */
  it('as faixas de orçamento do banco são exatamente as do código', async () => {
    const { rows } = await owner.query<{ definicao: string }>(
      `select pg_get_constraintdef(c.oid) as definicao
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'app' and t.relname = 'lead_qualifications'
          and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%budget_band%'`,
    );
    expect(rows, 'nenhum check de budget_band no banco').toHaveLength(1);

    const noBanco = [...(rows[0]?.definicao.matchAll(/'([a-z0-9_]+)'/g) ?? [])]
      .map((m) => m[1])
      .sort();
    expect(noBanco).toEqual([...FAIXAS_DE_ORCAMENTO].sort());
  });

  it('há folga de faixas: lista apertada empurra orçamento para dentro do texto livre', () => {
    // Migração é só de acréscimo, então cada faixa nova é uma migração. Quando
    // a lista aperta, a recepção escreve o valor em `note` — mil caracteres de
    // texto livre sobre paciente, pior para retenção e para exportação.
    expect(FAIXAS_DE_ORCAMENTO.length).toBeGreaterThanOrEqual(6);
  });
});
