import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Os guardas do painel, escritos como teste porque disciplina não escala.
 *
 * O painel fala SÓ com a nossa API: é ela que abre `withClinic` e passa pela
 * RLS (CLAUDE.md, regra 10). No dia em que alguém achar mais rápido ler uma
 * tabela pelo navegador com o supabase-js, este teste quebra antes do merge.
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const IGNORAR = new Set(['node_modules', '.next', 'out', 'tests', 'tsconfig.tsbuildinfo']);

function arquivosDoPainel(dir = RAIZ): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      achados.push(...arquivosDoPainel(caminho));
      continue;
    }
    // .html entra junto: public/ também é código que roda no navegador.
    if (/\.(ts|tsx|js|jsx|mjs|html)$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

function ondeAparece(agulha: string): string[] {
  return arquivosDoPainel()
    .filter((f) => readFileSync(f, 'utf8').includes(agulha))
    .map((f) => f.slice(RAIZ.length));
}

describe('nada lê tabela pelo navegador', () => {
  it('não existe .from( em apps/web', () => {
    // Montado em pedaços para o próprio guarda não se acusar.
    const agulha = ['.', 'from', '('].join('');
    expect(
      ondeAparece(agulha),
      'o painel só fala com a nossa API (CLAUDE.md, regra 10). Use [...x] no lugar de Array.from(.',
    ).toEqual([]);
  });

  it('não existe cliente de navegador do Supabase', () => {
    for (const agulha of ['createBrowserClient', 'NEXT_PUBLIC_SUPABASE']) {
      expect(
        ondeAparece(agulha),
        `${agulha} põe o Supabase dentro do navegador — o token tem que ficar no servidor`,
      ).toEqual([]);
    }
  });
});

describe('nada de dado de paciente no navegador', () => {
  it('não existe localStorage nem sessionStorage', () => {
    // Nem cache, nem rascunho: o que fica guardado no aparelho sai da clínica
    // junto com o aparelho.
    for (const agulha of ['localStorage', 'sessionStorage']) {
      expect(ondeAparece(agulha), `${agulha} guarda dado de paciente no aparelho`).toEqual([]);
    }
  });
});

describe('nada de token em log', () => {
  it('não existe console no painel', () => {
    // O log do painel é o do servidor. console.log num componente imprime no
    // terminal do servidor E no navegador, e é assim que um token acaba num
    // print de tela.
    expect(ondeAparece('console.')).toEqual([]);
  });
});

/**
 * NEXT_PUBLIC_ por LISTA DE PERMISSÃO, não por proibição.
 *
 * Proibir nome a nome é correr atrás: `NEXT_PUBLIC_SUPABASE_URL` seria pega,
 * `NEXT_PUBLIC_SUPABASE_ANON` também, e `NEXT_PUBLIC_TOKEN_DA_API` passaria
 * batido porque ninguém pensou nela. A lista abaixo é o contrário: só o que
 * está escrita aqui pode existir, e qualquer outra quebra o CI.
 *
 * Ela está vazia, e é assim que deve continuar enquanto o navegador não precisar
 * de configuração nenhuma. Acrescentar uma linha aqui é uma decisão consciente
 * de publicar um valor para todo mundo que abrir o painel.
 */
const NEXT_PUBLIC_PERMITIDAS: string[] = [];

describe('nada de configuração vazando para o pacote do navegador', () => {
  it('nenhuma variável NEXT_PUBLIC_ fora da lista de permissão', () => {
    const achadas = new Set<string>();
    for (const arquivo of arquivosDoPainel()) {
      for (const achado of readFileSync(arquivo, 'utf8').matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        achadas.add(achado[0]);
      }
    }
    expect(
      [...achadas].filter((n) => !NEXT_PUBLIC_PERMITIDAS.includes(n)).sort(),
      'NEXT_PUBLIC_ entra no pacote de TODAS as páginas. Passe como prop do componente de servidor.',
    ).toEqual([]);
  });

  /**
   * O painel nunca troca o código por token: quem faz isso é a nossa API, que é
   * o único processo com o segredo do app. Se alguma destas palavras aparecer em
   * apps/web, alguém está tentando falar com a Meta daqui — e o segredo teria
   * que vir junto.
   */
  it('não existe segredo do app nem chamada à Graph API no painel', () => {
    for (const agulha of [
      'META_APP_SECRET',
      'client_secret',
      'oauth/access_token',
      'graph.facebook.com',
    ]) {
      expect(
        ondeAparece(agulha),
        `${agulha} é assunto da API. O painel só entrega o código do navegador para ela.`,
      ).toEqual([]);
    }
  });
});
