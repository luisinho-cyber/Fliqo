import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valida a assinatura HMAC SHA-256 da Meta.
 *
 * Duas coisas não podem mudar aqui:
 *  - o hash é do CORPO BRUTO. Re-serializar o JSON muda ordem e espaços, e o
 *    hash deixa de bater — o corpo que a Meta assinou não é o que JSON.stringify
 *    produz;
 *  - a comparação é em tempo constante. Comparar com === vaza, pelo tempo de
 *    resposta, quantos bytes iniciais o atacante acertou.
 */
export function assinaturaConfere(
  corpoBruto: Buffer,
  cabecalho: unknown,
  segredo: string,
): boolean {
  if (typeof cabecalho !== 'string') return false;

  const esperado = `sha256=${createHmac('sha256', segredo).update(corpoBruto).digest('hex')}`;
  const recebido = Buffer.from(cabecalho);
  const calculado = Buffer.from(esperado);

  // timingSafeEqual exige mesmo tamanho; comparar antes não vaza nada além do
  // comprimento, que já é público no cabeçalho.
  if (recebido.length !== calculado.length) return false;
  return timingSafeEqual(recebido, calculado);
}
