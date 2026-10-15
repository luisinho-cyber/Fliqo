import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A paleta tem uma fonte só, e os dois apps bebem dela.
 *
 * Antes disto a demonstração tinha uma cópia dos tokens. Cópia não quebra nada
 * no dia em que é feita: ela quebra no dia em que alguém ajusta um valor no
 * painel, ninguém lembra do outro arquivo, e a divergência aparece na frente de
 * um cliente — que é o único lugar em que a demonstração é vista.
 *
 * O que este arquivo prova é a amarra, e não os valores: que existe UM arquivo
 * de tokens, que a demonstração importa esse arquivo pelo caminho, e que ela não
 * declara token nenhum por conta própria. Os valores em si têm guarda no
 * `apps/web/tests/identidade.test.ts`, que confere contraste lendo a mesma fonte.
 */

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTE = join(RAIZ, 'apps/web/app/tokens.css');
const GLOBAIS_DA_DEMO = join(RAIZ, 'apps/demo/app/globals.css');

/** Os prefixos de token do `@theme`, que é o que a fonte declara. */
const PREFIXOS = ['--color-', '--font-', '--radius-', '--text-', '--tracking-', '--spacing'];

function arquivosCss(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (['node_modules', '.next', 'out', 'test-results'].includes(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      achados.push(...arquivosCss(caminho));
      continue;
    }
    if (nome.endsWith('.css')) achados.push(caminho);
  }
  return achados;
}

/**
 * Os tokens DECLARADOS num CSS, no formato `--nome: valor`.
 *
 * Sem âncora de início de linha de propósito: a cópia que este arquivo existe
 * para pegar pode chegar minificada, ou numa linha só, e uma guarda que depende
 * da formatação do infrator não é guarda. `var(--nome)` não casa porque não tem
 * dois-pontos.
 */
function declarados(css: string): string[] {
  return [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)]
    .map((m) => m[1] ?? '')
    .filter((nome) => PREFIXOS.some((p) => nome.startsWith(p)));
}

/** Os tokens USADOS num CSS, no formato `var(--nome)`. */
function usados(css: string): string[] {
  return [...css.matchAll(/var\((--[a-z0-9-]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((nome) => PREFIXOS.some((p) => nome.startsWith(p)));
}

describe('a fonte dos tokens', () => {
  it('é um arquivo só no repositório inteiro', () => {
    const comTokens = [join(RAIZ, 'apps/web'), join(RAIZ, 'apps/demo')]
      .flatMap((app) => arquivosCss(app))
      .filter((caminho) => declarados(readFileSync(caminho, 'utf8')).length > 0)
      .map((caminho) => caminho.slice(RAIZ.length + 1));

    expect(
      comTokens,
      'paleta em dois arquivos é paleta que diverge; declare os valores só na fonte',
    ).toEqual(['apps/web/app/tokens.css']);
  });

  it('a demonstração importa essa fonte pelo caminho, e não uma cópia', () => {
    const css = readFileSync(GLOBAIS_DA_DEMO, 'utf8');
    const importado = /@import\s+'([^']+tokens\.css)'/.exec(css)?.[1];
    expect(importado, 'apps/demo/app/globals.css não importa nenhum tokens.css').toBeDefined();

    // Resolver o caminho é o que prova a amarra: um `tokens.css` ao lado passaria
    // numa conferência por texto e seria justamente a cópia que não pode existir.
    const alvo = resolve(dirname(GLOBAIS_DA_DEMO), importado ?? '');
    expect(alvo).toBe(FONTE);
  });

  it('todo token que a demonstração usa existe na fonte', () => {
    const naFonte = new Set(declarados(readFileSync(FONTE, 'utf8')));
    const semDono = [...new Set(usados(readFileSync(GLOBAIS_DA_DEMO, 'utf8')))].filter(
      (nome) => !naFonte.has(nome),
    );

    expect(semDono.sort(), 'estes tokens não existem em apps/web/app/tokens.css').toEqual([]);
  });

  it('o painel e a demonstração usam os mesmos nomes', () => {
    // Nome diferente para o mesmo valor é cópia disfarçada: ela não aparece como
    // segundo arquivo, mas diverge igual.
    const naFonte = new Set(declarados(readFileSync(FONTE, 'utf8')));
    const noPainel = new Set(usados(readFileSync(join(RAIZ, 'apps/web/app/globals.css'), 'utf8')));
    const semDono = [...noPainel].filter((nome) => !naFonte.has(nome));

    expect(semDono.sort(), 'estes tokens não existem em apps/web/app/tokens.css').toEqual([]);
  });
});

describe('a tipografia do sistema de design', () => {
  const fonte = readFileSync(FONTE, 'utf8');

  it.each([
    ['--font-titulo', 'Sora'],
    ['--font-texto', 'Sora'],
    ['--font-mono', 'DM Mono'],
  ])('%s é %s', (token, familia) => {
    const valor = new RegExp(`${token}:\\s*([^;]+);`).exec(fonte)?.[1] ?? '';
    expect(valor).toContain(`'${familia}'`);
  });

  it('cada família declara uma pilha de fallback de verdade', () => {
    // `sans-serif` sozinho entrega a serifada padrão do navegador enquanto a
    // fonte da rede não chega — ou para sempre, se ela não chegar.
    for (const token of ['--font-titulo', '--font-texto', '--font-mono']) {
      const valor = new RegExp(`${token}:\\s*([^;]+);`).exec(fonte)?.[1] ?? '';
      const familias = valor.split(',').length;
      expect(familias, `${token} tem ${familias} família(s); precisa de uma pilha`).toBeGreaterThan(
        3,
      );
    }
  });

  it('as duas páginas carregam as famílias que os tokens pedem', () => {
    for (const layout of ['apps/web/app/layout.tsx', 'apps/demo/app/layout.tsx']) {
      const texto = readFileSync(join(RAIZ, layout), 'utf8');
      expect(texto, `${layout} não carrega Sora`).toContain('family=Sora');
      expect(texto, `${layout} não carrega DM Mono`).toContain('family=DM+Mono');
    }
  });

  it('não existe etiqueta em caixa alta em tela nenhuma', () => {
    /*
     * O rótulo do v2 é 15px, peso 500, caixa normal. Caixa alta apaga o acento e
     * a silhueta da palavra em português, que é o que se lê de relance — e a
     * regra morreria sozinha se só estivesse escrita no DESIGN.md.
     */
    const telas = [join(RAIZ, 'apps/web'), join(RAIZ, 'apps/demo')].flatMap((app) =>
      arquivosCss(app),
    );
    const infratores = telas
      .filter((caminho) => /text-transform:\s*uppercase/.test(readFileSync(caminho, 'utf8')))
      .map((caminho) => caminho.slice(RAIZ.length + 1));

    expect(infratores.sort(), 'o rótulo do sistema de design é caixa normal').toEqual([]);
  });

  it('o rótulo é token, e não um tamanho solto dentro de uma tela', () => {
    expect(fonte).toMatch(/--text-rotulo:\s*15px;/);
    expect(fonte).toMatch(/--font-weight-rotulo:\s*500;/);
    expect(fonte).toMatch(/--tracking-rotulo:\s*-0\.01em;/);
  });
});
