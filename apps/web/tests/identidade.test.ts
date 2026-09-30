import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * As guardas do sistema de identidade.
 *
 * Os tokens são fonte única (`app/tokens.css`, com a razão de cada um no
 * DESIGN.md). Antes disto a paleta vivia metade no documento e metade dentro das
 * telas — que é como convenção vira folclore, e folclore não sobrevive à segunda
 * pessoa que mexe na tela.
 *
 * Os valores de contraste não são copiados para cá: são LIDOS do tokens.css. Uma
 * tabela repetida no teste envelheceria sozinha, e o teste passaria a provar o
 * que ele mesmo escreveu.
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const TOKENS = join(RAIZ, 'app/tokens.css');
const IGNORAR = new Set(['node_modules', '.next', 'out', 'tests', 'tsconfig.tsbuildinfo']);

/**
 * Onde cor literal pode aparecer, com nome e motivo — no formato da lista
 * `SEM_FORCE` de `packages/db/tests/rls-cobertura.test.ts`.
 *
 * Exceção nova entra aqui por decisão de alguém, não por descuido.
 */
const COM_COR_LITERAL: Record<string, string> = {
  'app/tokens.css': 'é a fonte dos tokens; é aqui que os valores moram',
  'app/layout.tsx':
    'o themeColor do navegador exige string literal e não lê variável CSS (era por aqui que o escuro tinha derivado do token)',
  'app/icon.svg': 'ícone da aba: SVG servido como arquivo, fora do alcance do CSS',
};

function arquivosDoPainel(dir = RAIZ): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      achados.push(...arquivosDoPainel(caminho));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs|css|svg)$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

describe('nenhuma cor literal fora dos tokens', () => {
  it('hex e rgb só aparecem nos arquivos nomeados', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
    const infratores = arquivosDoPainel()
      .map((f) => f.slice(RAIZ.length))
      .filter((rel) => !(rel in COM_COR_LITERAL))
      .filter((rel) => literal.test(readFileSync(join(RAIZ, rel), 'utf8')));

    expect(
      infratores.sort(),
      'cor em componente não tem tema escuro e não tem contraste conferido. Use um token.',
    ).toEqual([]);
  });

  it('a lista de exceções não guarda arquivo que já não existe', () => {
    // Exceção órfã é permissão que ninguém revisa.
    const presentes = new Set(arquivosDoPainel().map((f) => f.slice(RAIZ.length)));
    for (const rel of Object.keys(COM_COR_LITERAL)) {
      expect(presentes.has(rel), `${rel} está na lista de exceções e não existe mais`).toBe(true);
    }
  });

  it('opacity não indica estado', () => {
    // `opacity` quebra em silêncio o contraste conferido: o valor final não está
    // em token nenhum. Passado é quieto, não desbotado (DESIGN.md).
    const noCss = readFileSync(join(RAIZ, 'app/globals.css'), 'utf8');
    expect(noCss, 'estado com opacity some do cálculo de contraste').not.toMatch(/^\s*opacity:/m);
  });
});

// ---------------------------------------------------------------------------
// Contraste
// ---------------------------------------------------------------------------

type Tema = 'claro' | 'escuro';

/** Lê os tokens do CSS: os valores têm uma fonte só, e o teste bebe dela. */
function paleta(): Record<Tema, Record<string, string>> {
  const css = readFileSync(TOKENS, 'utf8');
  const escuroDe = css.indexOf('prefers-color-scheme: dark');
  expect(escuroDe, 'o tokens.css não tem bloco de tema escuro').toBeGreaterThan(0);

  const lerBloco = (texto: string): Record<string, string> => {
    const cores: Record<string, string> = {};
    for (const m of texto.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      cores[m[1] ?? ''] = (m[2] ?? '').toLowerCase();
    }
    return cores;
  };

  const claro = lerBloco(css.slice(0, escuroDe));
  // O escuro redefine só valores: o que ele não lista herda do claro.
  return { claro, escuro: { ...claro, ...lerBloco(css.slice(escuroDe)) } };
}

function canal(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminancia(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
}

export function razaoDeContraste(a: string, b: string): number {
  const [claro, escuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return ((claro ?? 0) + 0.05) / ((escuro ?? 0) + 0.05);
}

/**
 * Os pares de TEXTO da tabela de estados, com o piso de 4,5:1.
 *
 * `ink` sobre cada `*-tinta` é o texto dentro dos blocos da Linha do Dia; `ink-2`
 * sobre as três superfícies é todo o texto de apoio, que é onde o `ink-3` deixou
 * de ser usado.
 */
const TEXTO: [string, string][] = [
  ['ink', 'ground'],
  ['ink', 'paper'],
  ['ink', 'neve'],
  ['ink', 'ok-tinta'],
  ['ink', 'marca-tinta'],
  ['ink', 'risco-tinta'],
  ['ink', 'agora-tinta'],
  ['ink-2', 'ground'],
  ['ink-2', 'paper'],
  ['ink-2', 'neve'],
  // Texto dentro do bloco finalizado, e da hachura de livre e cancelado.
  ['ink-2', 'ok-tinta'],
];

/**
 * Traço que IDENTIFICA um estado: piso 3:1, o da WCAG para componente não
 * textual. É aqui que o `ink-3` vive agora — tick da escala da Linha do Dia.
 *
 * `agora` fica de fora: é exceção consciente, conferida no fim deste arquivo.
 */
const TRACO_DE_ESTADO: [string, string][] = [
  ['ink-3', 'paper'],
  ['ok', 'paper'],
  ['risco', 'paper'],
  ['marca', 'paper'],
  ['foco', 'paper'],
  ['foco', 'ground'],
];

/**
 * Separadores: `fio`, `fio-2` e `hachura` NÃO têm piso de 3:1, e não é
 * afrouxamento — é o papel que é outro.
 *
 * Eles separam e texturizam; nenhum deles é a única coisa que distingue um
 * estado. `livre` se separa de bloco sólido pela textura, não pela cor do traço,
 * e `fio` é hairline de lista. O traço de `finalizada` NÃO está aqui: ele é
 * `ink-3` e responde pelo piso de 3:1, porque contorno que não se vê não é
 * contorno.
 *
 * Subir esses três para 3:1 transformaria hairline em régua e hachura em
 * listrado, e mataria a leitura que eles existem para permitir. O que o teste
 * garante é que eles sejam PERCEPTÍVEIS, e que não somem num tema.
 */
const SEPARADOR: [string, string][] = [
  ['fio', 'paper'],
  ['fio-2', 'paper'],
  ['hachura', 'paper'],
];

describe.each(['claro', 'escuro'] as const)('contraste no tema %s', (tema) => {
  const cores = paleta()[tema];

  it.each(TEXTO)('texto: %s sobre %s tem 4,5:1', (frente, fundo) => {
    const a = cores[frente];
    const b = cores[fundo];
    expect(a, `token ${frente} não existe`).toBeDefined();
    expect(b, `token ${fundo} não existe`).toBeDefined();
    expect(razaoDeContraste(a ?? '#000000', b ?? '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TRACO_DE_ESTADO)('traço de estado: %s sobre %s tem 3:1', (frente, fundo) => {
    const a = cores[frente];
    const b = cores[fundo];
    expect(a, `token ${frente} não existe`).toBeDefined();
    expect(razaoDeContraste(a ?? '#000000', b ?? '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it.each(SEPARADOR)('separador: %s sobre %s é perceptível', (frente, fundo) => {
    const a = cores[frente];
    const b = cores[fundo];
    expect(a, `token ${frente} não existe`).toBeDefined();
    // Perceptível, não 3:1 — veja o comentário de SEPARADOR.
    expect(razaoDeContraste(a ?? '#000000', b ?? '#ffffff')).toBeGreaterThan(1.05);
  });
});

describe('o que a paleta declara', () => {
  it('todo token do claro tem valor no escuro', () => {
    const { claro, escuro } = paleta();
    for (const nome of Object.keys(claro)) {
      expect(escuro[nome], `${nome} não tem valor no tema escuro`).toBeDefined();
    }
  });

  it('o escuro redefine de verdade, e não herda tudo', () => {
    // Guarda contra um bloco escuro vazio: a tela ficaria clara com a preferência
    // de escuro ligada, e ninguém notaria em teste nenhum.
    const { claro, escuro } = paleta();
    const iguais = Object.keys(claro).filter((n) => claro[n] === escuro[n]);
    expect(iguais, 'estes tokens não foram redefinidos no escuro').toEqual([]);
  });

  /**
   * `agora` sobre `paper` fica em 2,96 no claro — abaixo de 3:1, e fica assim de
   * propósito: âmbar escurecido para passar deixa de ser âmbar. Quem carrega a
   * leitura é a FORMA — a etiqueta AGORA acima da linha e o contorno tracejado —,
   * que é a regra "nunca só matiz" fazendo o trabalho dela.
   */
  it('o âmbar é exceção consciente, e a forma é que carrega', () => {
    const { claro } = paleta();
    expect(razaoDeContraste(claro.agora ?? '', claro.paper ?? '')).toBeLessThan(3);
    const css = readFileSync(join(RAIZ, 'app/globals.css'), 'utf8');
    expect(css, 'a etiqueta AGORA é o que sustenta a leitura do âmbar').toContain(
      "content: 'AGORA'",
    );
    expect(css, 'o contorno tracejado é a outra metade da forma').toContain(
      'dashed var(--color-agora)',
    );
  });
});

// ---------------------------------------------------------------------------
// A tabela de estados da Linha do Dia
// ---------------------------------------------------------------------------

/**
 * A tabela do DESIGN.md, enumerada — no formato das outras listas do projeto.
 *
 * Existe porque a diferença entre dois estados costuma ser UMA declaração, e
 * uma declaração perdida num refactor não quebra nada visível em teste nenhum:
 * `em risco` e `faltou` ficariam idênticos, e a recepção leria previsão como
 * desfecho. Estado novo entra aqui por decisão de alguém.
 */
const ESTADOS: Record<string, { exige: (string | RegExp)[]; proibe?: string[] }> = {
  '.bloco.marcado': { exige: ['--color-marca-tinta', '--color-marca'] },
  '.bloco.confirmado': { exige: ['--color-ok-tinta', '--color-ok'] },
  '.bloco.em-risco': { exige: ['--color-risco-tinta', '--color-risco'] },
  // A diagonal é o que separa desfecho de previsão. Sem ela os dois são iguais.
  '.bloco.faltou': {
    exige: ['--color-risco-tinta', '--color-risco', /background-image:\s*linear-gradient\(/],
  },
  '.bloco.atrasado': { exige: ['--color-agora-tinta', '--color-agora'] },
  // Barra sólida à esquerda, e nada de animação: estado que só existe em
  // movimento desaparece sob prefers-reduced-motion.
  '.bloco.atendendo': {
    exige: ['--color-ok-tinta', 'border-left: 4px'],
    proibe: ['animation', 'repeating-linear-gradient'],
  },
  // Passado é quieto, não desbotado.
  '.bloco.finalizada': {
    exige: ['--color-ok-tinta', '--color-ink-3', '--color-ink-2'],
    proibe: ['opacity'],
  },
};

function bloco(css: string, seletor: string): string {
  // Pega o corpo da regra, aceitando o seletor sozinho ou em lista.
  const escapado = seletor.replace(/[.-]/g, (c) => `\\${c}`);
  const re = new RegExp(`(^|,|\\s)${escapado}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  expect(m, `a regra ${seletor} não existe em globals.css`).not.toBeNull();
  return m?.[3] ?? '';
}

describe('a tabela de estados está desenhada', () => {
  const css = readFileSync(join(RAIZ, 'app/globals.css'), 'utf8');

  it.each(Object.entries(ESTADOS))('%s declara o que a tabela manda', (seletor, regra) => {
    const corpo = bloco(css, seletor);
    for (const pedaco of regra.exige) {
      if (typeof pedaco === 'string') {
        expect(corpo, `${seletor} perdeu "${pedaco}"`).toContain(pedaco);
      } else {
        expect(corpo, `${seletor} não casa com ${pedaco.source}`).toMatch(pedaco);
      }
    }
    for (const pedaco of regra.proibe ?? []) {
      expect(corpo, `${seletor} não pode ter "${pedaco}"`).not.toContain(pedaco);
    }
  });

  it('em risco e faltou dividem o matiz e se separam pela forma', () => {
    const risco = bloco(css, '.bloco.em-risco');
    const faltou = bloco(css, '.bloco.faltou');
    // Mesmo preenchimento: é a mesma história em dois tempos.
    expect(risco).toContain('--color-risco-tinta');
    expect(faltou).toContain('--color-risco-tinta');
    // E só um dos dois DESENHA a diagonal. O teste olha o valor de
    // background-image, não o texto solto: `background-image: none` com o
    // gradiente sobrando ao lado numa propriedade morta passaria batido.
    expect(risco).not.toMatch(/background-image:\s*linear-gradient\(/);
    expect(faltou).toMatch(/background-image:\s*linear-gradient\(/);
    expect(faltou, 'faltou com background-image: none não tem diagonal').not.toMatch(
      /background-image:\s*none/,
    );
  });

  it('livre e cancelado são a mesma hachura, sem raio e sem borda', () => {
    const corpo = bloco(css, '.bloco.cancelado');
    expect(corpo).toMatch(/background-image:\s*repeating-linear-gradient\(/);
    expect(corpo).toContain('--color-hachura');
    expect(corpo).toContain('var(--radius-none)');
    expect(corpo).toContain('border: none');
  });

  it('nenhum estado do bloco fica fora da tabela', () => {
    // Classe nova em .bloco sem linha na tabela acima quebra o CI: é assim que a
    // tabela continua sendo a tabela, e não um retrato de ontem.
    const achadas = new Set(
      [...css.matchAll(/^\s*\.bloco\.([a-z-]+)/gm)].map((m) => `.bloco.${m[1] ?? ''}`),
    );
    const conhecidas = new Set([...Object.keys(ESTADOS), '.bloco.cancelado']);
    expect([...achadas].filter((c) => !conhecidas.has(c)).sort()).toEqual([]);
  });
});
