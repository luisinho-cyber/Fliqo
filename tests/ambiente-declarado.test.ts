import { AMBIENTE_DE_FERRAMENTA, ESQUEMAS_DE_AMBIENTE } from '@fliqo/core';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Nenhuma variável de ambiente é lida sem estar declarada no esquema.
 *
 * Dentro dos leitores de configuração quem cobra é o TIPO: eles recebem `AmbienteConhecido`,
 * que só tem os nomes do esquema. Este teste cobre o resto — scripts, caminho de start,
 * testes —, onde `process.env` é o tipo do @types/node e tem assinatura de índice.
 *
 * A LEITURA É PELA ÁRVORE SINTÁTICA, não por texto, e a primeira versão deste arquivo mostra
 * por quê: ela varria com `git grep` e tinha três defeitos de uma vez. Não via acesso
 * dinâmico (`process.env[nome]`) nem destructuring, que são justamente as formas de escapar
 * de uma varredura de texto. Acusava nomes escritos dentro de COMENTÁRIO, porque texto não
 * distingue código de prosa. E só via arquivo rastreado pelo git, então passava enquanto o
 * arquivo era novo e quebrava no commit — uma guarda cujo veredito dependia do estado do
 * índice do git.
 *
 * Aqui o compilador do TypeScript faz o parse. Comentário não é nó. E as formas que NÃO dão
 * para verificar por nome são recusadas na origem: acesso dinâmico, destructuring e guardar
 * `process.env` numa variável. Sem elas, toda leitura é um nome literal — e nome literal se
 * confere contra o esquema.
 */
const RAIZ = fileURLToPath(new URL('../', import.meta.url));

const DECLARADAS = new Set<string>([
  ...Object.values(ESQUEMAS_DE_AMBIENTE).flatMap((e) => e.map((v) => v.nome)),
  ...AMBIENTE_DE_FERRAMENTA,
  // Injetadas pelo ambiente de execução, não por nós.
  'NODE_ENV',
]);

/** As pastas varridas. `readdirSync` recursivo em vez de biblioteca de glob: é padrão. */
const PASTAS = ['apps', 'packages', 'tests'];
const IGNORAR = ['node_modules', '.next', 'dist'];

export type Achado =
  | { tipo: 'nome'; nome: string; onde: string }
  | { tipo: 'dinamico' | 'destructuring' | 'apelido'; onde: string };

/** `process.env`, `env` (parâmetro dos leitores) — o objeto de ambiente em qualquer forma. */
function ehAmbiente(no: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(no)) {
    return (
      ts.isIdentifier(no.expression) && no.expression.text === 'process' && no.name.text === 'env'
    );
  }
  return false;
}

/**
 * Percorre um arquivo e devolve o que ele faz com `process.env`.
 *
 * O `ts.forEachChild` só visita nós de código: `// process.env.FOO` num comentário não é nó
 * nenhum, e era isso que a varredura de texto não sabia.
 */
export function achadosDoArquivo(codigo: string, onde: string): Achado[] {
  const fonte = ts.createSourceFile(onde, codigo, ts.ScriptTarget.ESNext, true);
  const achados: Achado[] = [];

  const linha = (no: ts.Node): string =>
    `${onde}:${String(fonte.getLineAndCharacterOfPosition(no.getStart(fonte)).line + 1)}`;

  const visitar = (no: ts.Node): void => {
    // process.env.NOME
    if (ts.isPropertyAccessExpression(no) && ehAmbiente(no.expression)) {
      achados.push({ tipo: 'nome', nome: no.name.text, onde: linha(no) });
    }

    // process.env['NOME'] e process.env[qualquerCoisa]
    if (ts.isElementAccessExpression(no) && ehAmbiente(no.expression)) {
      const arg = no.argumentExpression;
      if (ts.isStringLiteral(arg)) achados.push({ tipo: 'nome', nome: arg.text, onde: linha(no) });
      else achados.push({ tipo: 'dinamico', onde: linha(no) });
    }

    // const { NOME } = process.env  /  const { NOME: outro } = process.env
    if (
      ts.isVariableDeclaration(no) &&
      no.initializer !== undefined &&
      ehAmbiente(no.initializer)
    ) {
      if (ts.isObjectBindingPattern(no.name))
        achados.push({ tipo: 'destructuring', onde: linha(no) });
      // const env = process.env: depois disso o índice fica livre, e por isso é recusado.
      else if (ts.isIdentifier(no.name)) achados.push({ tipo: 'apelido', onde: linha(no) });
    }

    ts.forEachChild(no, visitar);
  };

  ts.forEachChild(fonte, visitar);
  return achados;
}

/**
 * Passar `process.env` como ARGUMENTO continua valendo: é o padrão `= process.env` dos
 * leitores, e do outro lado o parâmetro é `AmbienteConhecido`, onde o tipo fecha os nomes.
 */
function todosOsAchados(): Achado[] {
  const arquivos = PASTAS.flatMap((pasta) =>
    readdirSync(RAIZ + pasta, { recursive: true, encoding: 'utf8' })
      .map((nome) => `${pasta}/${nome}`)
      .filter((rel) => /\.(ts|tsx|mjs)$/.test(rel))
      .filter((rel) => !IGNORAR.some((i) => rel.includes(`/${i}/`))),
  );
  return arquivos.flatMap((rel) => achadosDoArquivo(readFileSync(RAIZ + rel, 'utf8'), rel));
}

describe('o varredor lê código, não texto', () => {
  it('acha o nome literal, nas duas formas', () => {
    const achados = achadosDoArquivo(
      `const a = process.env.DATABASE_URL; const b = process.env['LOG_LEVEL'];`,
      'exemplo.ts',
    );
    expect(achados.map((a) => (a.tipo === 'nome' ? a.nome : a.tipo))).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
    ]);
  });

  it('acha acesso dinâmico, que é como se escapa de uma varredura de texto', () => {
    for (const codigo of [
      'const x = process.env[nome];',
      "const k = 'ALGO'; const x = process.env[k];",
      'const x = process.env[`PREFIXO_${sufixo}`];',
    ]) {
      expect(
        achadosDoArquivo(codigo, 'exemplo.ts').map((a) => a.tipo),
        codigo,
      ).toContain('dinamico');
    }
  });

  it('acha destructuring, com e sem renome', () => {
    expect(achadosDoArquivo('const { DATABASE_URL } = process.env;', 'e.ts')[0]?.tipo).toBe(
      'destructuring',
    );
    expect(achadosDoArquivo('const { ALGO: url } = process.env;', 'e.ts')[0]?.tipo).toBe(
      'destructuring',
    );
  });

  it('acha o apelido: guardar process.env numa variável libera o índice depois', () => {
    expect(achadosDoArquivo('const e = process.env; const x = e[k];', 'e.ts')[0]?.tipo).toBe(
      'apelido',
    );
  });

  it('NÃO acha nome dentro de comentário nem de string: era o falso positivo da versão de texto', () => {
    const codigo = [
      '// process.env.NAO_DECLARADA deixa de compilar',
      '/* process.env.OUTRA_INVENTADA */',
      "const msg = 'leia process.env.TERCEIRA_INVENTADA';",
    ].join('\n');
    expect(achadosDoArquivo(codigo, 'exemplo.ts')).toEqual([]);
  });

  it('passar o ambiente como argumento não é leitura de nome', () => {
    // É o padrão `= process.env` dos leitores: do outro lado o tipo é AmbienteConhecido.
    expect(
      achadosDoArquivo('export function ler(env = process.env) { return env; }', 'e.ts'),
    ).toEqual([]);
  });
});

describe('o repositório inteiro', () => {
  const achados = todosOsAchados();

  it('o varredor alcança o código de verdade', () => {
    // Sem isto, um glob errado acharia zero arquivo e os testes abaixo passariam vazios.
    const nomes = achados.filter((a) => a.tipo === 'nome').map((a) => a.nome);
    expect(nomes.length).toBeGreaterThan(5);
    expect(nomes).toContain('DATABASE_URL');
  });

  it('nenhuma leitura de nome fora do esquema', () => {
    const fora = achados
      .filter((a): a is Extract<Achado, { tipo: 'nome' }> => a.tipo === 'nome')
      .filter((a) => !DECLARADAS.has(a.nome));
    expect(
      fora.map((f) => `${f.nome} em ${f.onde}`),
      'declare a variável em packages/core/src/ambiente.ts (esquema do serviço, ou AMBIENTE_DE_FERRAMENTA)',
    ).toEqual([]);
  });

  it('nenhum acesso dinâmico, destructuring ou apelido de process.env', () => {
    // Estas três formas não dão para conferir por nome, então não existem: quem precisa do
    // ambiente inteiro passa `process.env` como argumento para um leitor com esquema.
    const formas = achados.filter((a) => a.tipo !== 'nome').map((a) => `${a.tipo} em ${a.onde}`);
    expect(formas, 'leia por nome literal, ou passe o ambiente a um leitor do esquema').toEqual([]);
  });
});
