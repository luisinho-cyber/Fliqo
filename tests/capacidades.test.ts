import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A tabela de capacidades não mente sobre os testes que cita.
 *
 * `FLIQO-SISTEMA.md` existe para separar o que o produto faz do que a venda diz. Isso só
 * vale enquanto a coluna "teste que prova" aponta para teste que existe — e a forma de essa
 * coluna apodrecer não é alguém apagar um arquivo: é alguém RENOMEAR um teste. O arquivo
 * continua lá, o nome citado deixa de existir, e a tabela segue afirmando prova que já não
 * roda.
 *
 * Por isso a conferência é por caminho E por nome. Existência de arquivo sozinha deixaria
 * passar exatamente o caso comum.
 *
 * Só linhas CONFIRMADO são cobradas: BETA, PLANEJADO e DESCONHECIDO são declarações de que a
 * prova não existe, e exigir citação delas seria pedir o contrário do que elas dizem.
 */
const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const TABELA = 'FLIQO-SISTEMA.md';

const ESTADOS = ['CONFIRMADO', 'BETA', 'PLANEJADO', 'DESCONHECIDO'] as const;
type Estado = (typeof ESTADOS)[number];

export interface Citacao {
  caminho: string;
  nome: string;
}

export interface LinhaDaTabela {
  recurso: string;
  estado: Estado;
  citacoes: Citacao[];
}

function ehEstado(texto: string): texto is Estado {
  return (ESTADOS as readonly string[]).includes(texto);
}

/**
 * As citações de uma célula: `` `caminho` → "nome do teste" ``.
 *
 * O nome aceita `\"` no meio porque existe teste com aspas no próprio nome, e trocar o nome
 * do teste para caber no varredor seria o varredor mandando no código.
 */
export function citacoesDaCelula(celula: string): Citacao[] {
  const citacoes: Citacao[] = [];
  const padrao = /`([^`]+)`\s*→\s*"((?:[^"\\]|\\.)*)"/g;
  for (const achado of celula.matchAll(padrao)) {
    const caminho = achado[1];
    const nome = achado[2];
    if (caminho === undefined || nome === undefined) continue;
    citacoes.push({ caminho, nome: nome.replace(/\\"/g, '"') });
  }
  return citacoes;
}

/**
 * Lê as linhas de capacidade do markdown.
 *
 * Reconhece linha de tabela com cinco células cuja segunda é um estado conhecido — assim o
 * cabeçalho, o separador e a tabela da legenda ficam de fora sem lista de exceção.
 */
export function linhasDaTabela(markdown: string): LinhaDaTabela[] {
  const linhas: LinhaDaTabela[] = [];
  for (const linha of markdown.split('\n')) {
    if (!linha.trimStart().startsWith('|')) continue;
    const celulas = linha
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (celulas.length !== 5) continue;
    const [recurso, estado, , teste] = celulas;
    if (recurso === undefined || estado === undefined || teste === undefined) continue;
    const limpo = estado.replace(/\*/g, '').trim();
    if (!ehEstado(limpo)) continue;
    linhas.push({ recurso, estado: limpo, citacoes: citacoesDaCelula(teste) });
  }
  return linhas;
}

describe('o leitor da tabela', () => {
  it('acha as duas citações de uma célula, e o caminho e o nome de cada', () => {
    const c = citacoesDaCelula('`a/b.test.ts` → "primeiro nome"; `c/d.test.ts` → "segundo nome"');
    expect(c).toEqual([
      { caminho: 'a/b.test.ts', nome: 'primeiro nome' },
      { caminho: 'c/d.test.ts', nome: 'segundo nome' },
    ]);
  });

  it('aceita aspas escapadas dentro do nome do teste', () => {
    expect(citacoesDaCelula('`a/b.test.ts` → "diz \\"tentou\\" e segue"')).toEqual([
      { caminho: 'a/b.test.ts', nome: 'diz "tentou" e segue' },
    ]);
  });

  it('não confunde a legenda nem o cabeçalho com linha de capacidade', () => {
    const md = [
      '| Estado | O que significa |',
      '| --- | --- |',
      '| **CONFIRMADO** | existe teste que falha |',
      '',
      '| Recurso | Estado | Limitação | Teste que prova | Última verificação |',
      '| --- | --- | --- | --- | --- |',
      '| Algo | CONFIRMADO | nenhuma | `a/b.test.ts` → "o nome" | 2026-01-01 |',
    ].join('\n');
    expect(linhasDaTabela(md)).toEqual([
      {
        recurso: 'Algo',
        estado: 'CONFIRMADO',
        citacoes: [{ caminho: 'a/b.test.ts', nome: 'o nome' }],
      },
    ]);
  });

  it('não lê caminho que está na coluna de limitação como se fosse prova', () => {
    const md = [
      '| Recurso | Estado | Limitação | Teste que prova | Última verificação |',
      '| --- | --- | --- | --- | --- |',
      '| Algo | DESCONHECIDO | o código está em `src/algo.ts` e não tem teste | — | 2026-01-01 |',
    ].join('\n');
    expect(linhasDaTabela(md)[0]?.citacoes).toEqual([]);
  });
});

describe('a tabela de capacidades', () => {
  const markdown = readFileSync(RAIZ + TABELA, 'utf8');
  const linhas = linhasDaTabela(markdown);
  const confirmados = linhas.filter((l) => l.estado === 'CONFIRMADO');

  it('o varredor alcança a tabela de verdade', () => {
    // Sem isto, um formato que mudasse faria os testes abaixo passarem com zero linha.
    expect(linhas.length).toBeGreaterThan(20);
    expect(confirmados.length).toBeGreaterThan(10);
  });

  it('todo CONFIRMADO cita pelo menos um teste', () => {
    const semCitacao = confirmados.filter((l) => l.citacoes.length === 0).map((l) => l.recurso);
    expect(
      semCitacao,
      'CONFIRMADO sem teste citado: ou cite o teste, ou troque o estado para DESCONHECIDO',
    ).toEqual([]);
  });

  it('todo arquivo de teste citado existe', () => {
    const faltando = confirmados.flatMap((l) =>
      l.citacoes
        .filter((c) => !existsSync(RAIZ + c.caminho))
        .map((c) => `${l.recurso}: ${c.caminho}`),
    );
    expect(faltando, 'arquivo de teste citado na tabela não existe mais').toEqual([]);
  });

  it('todo nome de teste citado existe dentro do arquivo citado', () => {
    const faltando = confirmados.flatMap((l) =>
      l.citacoes
        .filter((c) => {
          if (!existsSync(RAIZ + c.caminho)) return false; // já cobrado acima
          return !readFileSync(RAIZ + c.caminho, 'utf8').includes(c.nome);
        })
        .map((c) => `${l.recurso}: "${c.nome}" não está em ${c.caminho}`),
    );
    expect(
      faltando,
      'o teste foi renomeado e a tabela não: atualize FLIQO-SISTEMA.md ou devolva o nome',
    ).toEqual([]);
  });
});
