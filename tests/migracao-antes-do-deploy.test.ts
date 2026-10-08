import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A migração roda ANTES do código novo ir ao ar (CLAUDE.md, regra 12).
 *
 * O "Migrar banco" roda no push da `main` e o Railway espera os checks antes de publicar.
 * Entre um e outro, o código VELHO roda sobre o esquema NOVO — o que só é seguro enquanto
 * o esquema novo convive com o código velho. Este arquivo guarda as duas metades: o
 * workflow continua disparando no push, e nenhuma migração destrói o que o código velho
 * ainda usa.
 *
 * Os dois lados são lidos como texto porque são o próprio artefato: o YAML é o que o GitHub
 * executa, e o SQL é o que o migrador aplica. Não há comportamento a exercitar aqui.
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const PASTA = `${RAIZ}packages/db/migrations/`;

/** Tira os comentários: prosa explicando "nunca drop column" não é um drop column. */
function semComentarios(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** As formas que quebram o código velho rodando sobre o esquema novo. */
const DESTRUTIVAS: { nome: string; padrao: RegExp }[] = [
  { nome: 'remover coluna', padrao: /\bdrop\s+column\b/i },
  { nome: 'remover tabela', padrao: /\bdrop\s+table\b/i },
  { nome: 'renomear', padrao: /\brename\b/i },
  { nome: 'trocar o tipo de coluna', padrao: /\balter\s+column\s+\w+\s+(set\s+data\s+)?type\b/i },
  { nome: 'not null em coluna existente', padrao: /\bset\s+not\s+null\b/i },
];

/**
 * `add column ... not null` sem `default`: o código velho insere sem a coluna, e o insert
 * falha. Lê cada cláusula de `add column` até a próxima vírgula ou ponto e vírgula.
 */
function colunasObrigatoriasSemPadrao(sql: string): string[] {
  return sql
    .split(/\badd\s+column\b/i)
    .slice(1)
    .map((resto) => resto.split(/[,;]/)[0] ?? '')
    .filter((clausula) => /\bnot\s+null\b/i.test(clausula) && !/\bdefault\b/i.test(clausula))
    .map((clausula) => clausula.trim().split(/\s+/)[0] ?? '?');
}

function violacoes(sql: string): string[] {
  const limpo = semComentarios(sql);
  return [
    ...DESTRUTIVAS.filter((d) => d.padrao.test(limpo)).map((d) => d.nome),
    ...colunasObrigatoriasSemPadrao(limpo).map((c) => `coluna nova "${c}" obrigatória sem padrão`),
  ];
}

describe('o esquema só acrescenta', () => {
  const migracoes = readdirSync(PASTA).filter((n) => n.endsWith('.sql'));

  it('há migrações para conferir', () => {
    expect(migracoes.length).toBeGreaterThan(0);
  });

  for (const nome of migracoes) {
    it(`${nome} não destrói o que o código velho usa`, () => {
      expect(violacoes(readFileSync(PASTA + nome, 'utf8'))).toEqual([]);
    });
  }
});

describe('o detector reconhece cada forma destrutiva', () => {
  // Sem isto, um regex errado deixaria passar tudo e o teste de cima ficaria verde à toa.
  it.each([
    ['alter table app.patients drop column name;', 'remover coluna'],
    ['drop table app.alerts;', 'remover tabela'],
    ['alter table app.patients rename column name to nome;', 'renomear'],
    ['alter table app.patients rename to pacientes;', 'renomear'],
    ['alter table app.patients alter column name type varchar(80);', 'trocar o tipo de coluna'],
    [
      'alter table app.patients alter column name set data type varchar(80);',
      'trocar o tipo de coluna',
    ],
    [
      'alter table app.patients alter column prefers_audio set not null;',
      'not null em coluna existente',
    ],
  ])('%s', (sql, esperado) => {
    expect(violacoes(sql)).toContain(esperado);
  });

  it('coluna nova obrigatória sem padrão é recusada; com padrão, ou nula, passa', () => {
    expect(violacoes('alter table app.clinics add column x int not null;')).toEqual([
      'coluna nova "x" obrigatória sem padrão',
    ]);
    expect(violacoes('alter table app.clinics add column x int not null default 0;')).toEqual([]);
    expect(violacoes('alter table app.clinics add column x int;')).toEqual([]);
  });

  it('o que só acrescenta passa', () => {
    expect(
      violacoes(`
        -- Nunca drop column aqui: isto é prosa.
        create table app.coisa (id uuid primary key, nome text not null);
        create index on app.coisa (nome);
        alter table app.coisa drop constraint coisa_check;
        alter table app.coisa add constraint coisa_check check (nome <> '');
      `),
    ).toEqual([]);
  });
});

describe('o Migrar banco roda no push da main', () => {
  const fluxo = readFileSync(`${RAIZ}.github/workflows/migrar-banco.yml`, 'utf8');

  it('dispara no push da main, e continua disparável à mão', () => {
    // Sem o push, o Railway publicaria sem migrar — e o "Wait for CI" nem aparece no painel.
    expect(fluxo).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/m);
  });

  it('mantém a guarda "só a main"', () => {
    expect(fluxo).toContain("if: github.ref != 'refs/heads/main'");
    expect(fluxo).toContain('exit 1');
  });

  it('mantém a fila: duas execuções não disputam o banco', () => {
    expect(fluxo).toMatch(/^concurrency: migrar-banco$/m);
  });
});
