import { blocoDoArquivo, blocosDoDeploy, celulasDaTabela } from '@fliqo/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A tabela do DEPLOY.md é gerada do esquema, e este teste é o que a impede de mentir.
 *
 * O DEPLOY.md já afirmou coisa que o código não fazia: que o worker precisava da
 * `WHATSAPP_TOKEN_KEY` (ele lê `WHATSAPP_TOKEN`), e que o workflow de migração devia rodar
 * antes do deploy num lugar e depois do merge noutro. Documentação de configuração que
 * divergiu do código custou três deploys quebrados em sequência.
 *
 * A comparação é por CÉLULA: o gerador escreve as colunas justas e a Prettier as realinha,
 * e o alinhamento não é o assunto.
 */
const DEPLOY = fileURLToPath(new URL('../docs/DEPLOY.md', import.meta.url));

describe('as tabelas de ambiente do DEPLOY.md', () => {
  const texto = readFileSync(DEPLOY, 'utf8');
  const gerados = blocosDoDeploy();

  for (const [bloco, conteudo] of Object.entries(gerados)) {
    it(`o bloco "${bloco}" está igual ao esquema`, () => {
      const noArquivo = blocoDoArquivo(texto, bloco);
      expect(noArquivo, `falta o marcador ambiente:${bloco} no DEPLOY.md`).toBeDefined();
      expect(
        celulasDaTabela(noArquivo ?? ''),
        `o DEPLOY.md divergiu do esquema. Rode: npm run ambiente:tabela`,
      ).toEqual(celulasDaTabela(conteudo));
    });
  }
});
