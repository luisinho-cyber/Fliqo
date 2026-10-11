import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aplicarBlocos } from '../src/ambiente';

/**
 * Reescreve as tabelas de ambiente do DEPLOY.md a partir do esquema.
 *
 * `npm run ambiente:tabela`. O teste tests/ambiente-documentado.test.ts falha quando o
 * arquivo está diferente do esquema, e a mensagem dele manda rodar isto — então a
 * documentação não tem como mentir sem quebrar o CI.
 */
const caminho = fileURLToPath(new URL('../../../docs/DEPLOY.md', import.meta.url));
const antes = readFileSync(caminho, 'utf8');
const { texto, faltando } = aplicarBlocos(antes);

if (faltando.length > 0) {
  console.error(`faltam marcadores no DEPLOY.md: ${faltando.join(', ')}`);
  process.exit(1);
}

if (texto === antes) {
  console.log('DEPLOY.md já estava igual ao esquema.');
} else {
  writeFileSync(caminho, texto);
  console.log('DEPLOY.md atualizado a partir do esquema.');
}
