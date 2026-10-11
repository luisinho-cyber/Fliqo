import { AMBIENTE_DE_FERRAMENTA, ESQUEMAS_DE_AMBIENTE } from '@fliqo/core';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Nenhuma variável de ambiente é lida sem estar declarada no esquema.
 *
 * Dentro dos leitores de configuração quem cobra é o TIPO: eles recebem `AmbienteConhecido`,
 * que só tem os nomes do esquema. Este teste cobre o resto do código — scripts, caminho de
 * start, testes —, onde `process.env` é o tipo do @types/node e tem assinatura de índice.
 *
 * A alternativa era `noPropertyAccessFromIndexSignature` no repositório inteiro. Ela
 * funciona, e foi medida: custa catorze trocas de ponto por colchete em acesso a `Record`
 * que não tem nada a ver com ambiente. O teste cobre o mesmo buraco sem esse preço.
 */
const RAIZ = fileURLToPath(new URL('../', import.meta.url));

const DECLARADAS = new Set<string>([
  ...Object.values(ESQUEMAS_DE_AMBIENTE).flatMap((e) => e.map((v) => v.nome)),
  ...AMBIENTE_DE_FERRAMENTA,
  // Injetadas pelo ambiente de execução, não por nós.
  'NODE_ENV',
  'npm_lifecycle_event',
]);

/** Toda leitura de `process.env.NOME` ou `env.NOME` no código versionado. */
function nomesLidos(): { nome: string; onde: string }[] {
  const saida = execFileSync(
    'git',
    [
      'grep',
      '-n',
      '-E',
      "(process\\.)?env(\\.|\\[')[A-Z][A-Z0-9_]+",
      '--',
      'apps',
      'packages',
      'tests',
    ],
    { cwd: RAIZ, encoding: 'utf8' },
  );
  const achados: { nome: string; onde: string }[] = [];
  for (const linha of saida.split('\n')) {
    if (linha === '' || linha.includes('ambiente-declarado.test.ts')) continue;
    for (const m of linha.matchAll(/env(?:\.|\[')([A-Z][A-Z0-9_]+)/g)) {
      const nome = m[1];
      if (nome !== undefined) achados.push({ nome, onde: linha.split(':').slice(0, 2).join(':') });
    }
  }
  return achados;
}

describe('toda variável lida está no esquema', () => {
  const lidas = nomesLidos();

  it('o varredor acha leituras de verdade', () => {
    // Sem isto, um regex errado acharia zero e o teste abaixo passaria sem conferir nada.
    expect(lidas.length).toBeGreaterThan(5);
    expect(lidas.map((l) => l.nome)).toContain('DATABASE_URL');
  });

  it('nenhuma leitura de nome fora do esquema', () => {
    const fora = lidas.filter((l) => !DECLARADAS.has(l.nome));
    expect(
      fora.map((f) => `${f.nome} em ${f.onde}`),
      'declare a variável em packages/core/src/ambiente.ts (esquema do serviço, ou AMBIENTE_DE_FERRAMENTA)',
    ).toEqual([]);
  });
});
