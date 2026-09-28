import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetDatabase } from '../src/testing';

/**
 * Toda tabela do schema `app` é isolada por clínica.
 *
 * É a regra 2 do CLAUDE.md escrita como teste. Não existe "esqueci a RLS na
 * tabela nova": ela nasce fora da lista e o CI para. Três coisas por tabela:
 * RLS ligada, RLS FORÇADA e política de tenant.
 *
 * `force` é o que faz a política valer também para o DONO do schema. Sem ele, a
 * aplicação continua presa à clínica dela (fliqo_app não é dona da tabela), mas
 * migração, script e SQL Editor leem tudo. É camada de proteção, não a única.
 *
 * As duas listas abaixo são a revisão, como a de security-definer.test.ts: quem
 * está fora da regra está fora por decisão com nome e motivo. Sem elas, a
 * primeira tabela legitimamente global quebra o CI e alguém afrouxa o teste
 * para destravar — que é o pior desfecho possível.
 */

/**
 * Tabelas sem isolamento por clínica. Uma tabela aqui é visível de qualquer
 * clínica: só entra o que for global de verdade (catálogo do produto, por
 * exemplo), nunca dado de clínica nem de paciente.
 *
 * Vazia hoje, de propósito. A primeira que entrar é uma decisão consciente.
 */
const GLOBAIS: string[] = [];

/**
 * Tabelas com RLS ligada mas sem `force`, com o motivo.
 *
 * A aplicação continua isolada nelas — o que muda é o dono do schema.
 */
const SEM_FORCE: Record<string, string> = {
  // 0003: `force` prenderia também o dono do schema, e é como dono que
  // app.clinic_by_phone_number_id traduz o phone_number_id da Meta em clínica,
  // antes de haver clínica na transação. whatsapp-rls.test.ts prova que a
  // aplicação (fliqo_app) não lê, grava, altera nem apaga número de outra.
  whatsapp_numbers: 'a função security definer do webhook lê esta tabela como dono do schema',
};

interface Tabela {
  nome: string;
  rlsLigada: boolean;
  rlsForcada: boolean;
  temPoliticaDeTenant: boolean;
}

let owner: pg.Pool;
let tabelas: Tabela[];

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  const { rows } = await owner.query<{
    nome: string;
    rls_ligada: boolean;
    rls_forcada: boolean;
    tem_politica: boolean;
  }>(
    `select c.relname as nome,
            c.relrowsecurity as rls_ligada,
            c.relforcerowsecurity as rls_forcada,
            exists (select 1 from pg_policy p
                     where p.polrelid = c.oid and p.polname = 'tenant_isolation') as tem_politica
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r'
      order by c.relname`,
  );
  tabelas = rows.map((r) => ({
    nome: r.nome,
    rlsLigada: r.rls_ligada,
    rlsForcada: r.rls_forcada,
    temPoliticaDeTenant: r.tem_politica,
  }));
}, 90_000);

afterAll(async () => {
  await owner.end();
});

describe('cobertura de RLS no schema app', () => {
  it('existe tabela para conferir (o teste não passa por estar vazio)', () => {
    expect(tabelas.length).toBeGreaterThan(15);
  });

  it('toda tabela não global tem RLS ligada e política de tenant', () => {
    const faltando = tabelas
      .filter((t) => !GLOBAIS.includes(t.nome))
      .filter((t) => !t.rlsLigada || !t.temPoliticaDeTenant)
      .map(
        (t) =>
          `${t.nome} (rls: ${String(t.rlsLigada)}, política: ${String(t.temPoliticaDeTenant)})`,
      );
    expect(
      faltando,
      'tabela nova sem RLS: ou ela ganha a política de tenant, ou entra em GLOBAIS com motivo',
    ).toEqual([]);
  });

  it('toda tabela não global tem RLS forçada, fora as listadas em SEM_FORCE', () => {
    const faltando = tabelas
      .filter((t) => !GLOBAIS.includes(t.nome) && !(t.nome in SEM_FORCE))
      .filter((t) => !t.rlsForcada)
      .map((t) => t.nome);
    expect(
      faltando,
      'sem force, a RLS não vale para o dono do schema: ou a migração força, ou a tabela entra em SEM_FORCE com motivo',
    ).toEqual([]);
  });

  it('as duas listas de exceção só nomeiam tabela que existe', () => {
    // Exceção para tabela que já foi renomeada ou apagada é exceção esquecida:
    // ela deixa de proteger e ninguém percebe.
    const existentes = tabelas.map((t) => t.nome);
    for (const nome of [...GLOBAIS, ...Object.keys(SEM_FORCE)]) {
      expect(existentes, `${nome} está na lista de exceção mas não existe mais`).toContain(nome);
    }
  });

  it('cada exceção de force diz por quê', () => {
    for (const [nome, motivo] of Object.entries(SEM_FORCE)) {
      expect(motivo.length, `${nome} está em SEM_FORCE sem motivo escrito`).toBeGreaterThan(20);
    }
  });
});
