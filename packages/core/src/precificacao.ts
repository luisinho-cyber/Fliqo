import { BP_100, assertBp, assertCents, type BasisPoints, type Cents } from './dinheiro';

export interface PercentuaisSobrePreco {
  impostoBp: BasisPoints;
  taxaCartaoBp: BasisPoints;
  comissaoBp: BasisPoints;
  lucroBp: BasisPoints;
}

/**
 * Markup divisor: preço = custo ÷ (1 − Σ percentuais que incidem SOBRE O PREÇO).
 * Nunca somar os percentuais por cima do custo — isso entrega menos margem do que parece.
 *
 * Caso canônico: custo R$ 50, imposto 8,08%, taxa 10%, lucro 20%
 *   errado (soma por cima): R$ 69,04   |   certo (divisor): R$ 80,75
 */
export function precoPorMarkupDivisor(custo: Cents, p: PercentuaisSobrePreco): Cents {
  assertCents(custo, 'custo');
  const soma = p.impostoBp + p.taxaCartaoBp + p.comissaoBp + p.lucroBp;
  for (const [k, v] of Object.entries(p)) assertBp(v, k);
  if (soma >= BP_100) {
    throw new RangeError(`Percentuais somam ${soma / 100}% — o preço tenderia ao infinito. Revise a margem.`);
  }
  return Math.round((custo * BP_100) / (BP_100 - soma));
}

/** Margem de contribuição real de um procedimento já precificado. */
export function margemDeContribuicao(
  preco: Cents,
  custoDireto: Cents,
  p: Omit<PercentuaisSobrePreco, 'lucroBp'>,
): { valor: Cents; bp: BasisPoints } {
  assertCents(preco, 'preço');
  assertCents(custoDireto, 'custo direto');
  const deducoes = Math.round((preco * (p.impostoBp + p.taxaCartaoBp + p.comissaoBp)) / BP_100);
  const valor = preco - deducoes - custoDireto;
  return { valor, bp: preco === 0 ? 0 : Math.round((valor * BP_100) / preco) };
}
