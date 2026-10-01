import { validarAmbienteDoPainel } from '../lib/ambiente';

/**
 * Confere o ambiente ANTES de o Next existir.
 *
 * O `instrumentation.ts` também confere, e continua valendo — mas ele roda depois de o
 * Next ligar a porta e imprimir "Ready", e o pedido é não abrir porta. Então o `start`
 * chama este script primeiro: ele sai com código 1, o `&&` corta a linha, e o Next nunca
 * sobe. Nada de serviço degradado.
 *
 * Fica em TypeScript, rodado por `tsx`, para ler a MESMA lista que o painel usa. Uma
 * segunda lista em .mjs divergiria da primeira, que é o problema que este contrato existe
 * para matar.
 *
 * Escreve em `process.stderr` em vez de `console`: é fronteira de linha de comando, e a
 * saída é o produto — mas não vale afrouxar a regra do logger para o resto do painel.
 */
try {
  validarAmbienteDoPainel();
} catch (erro) {
  process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
  process.exit(1);
}
