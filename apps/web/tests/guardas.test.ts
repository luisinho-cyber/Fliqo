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
