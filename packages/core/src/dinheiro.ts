/**
 * Dinheiro no Fliqo = inteiro em centavos. Percentual = inteiro em basis points (1 bp = 0,01%).
 * Nenhuma função deste pacote recebe ou devolve float para valor monetário.
 */
export type Cents = number;
export type BasisPoints = number;

export const BP_100 = 10_000;

export function assertCents(v: number, label = 'valor'): asserts v is Cents {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`${label} precisa ser inteiro >= 0 em centavos, recebido: ${v}`);
  }
}

export function assertBp(v: number, label = 'percentual'): asserts v is BasisPoints {
  if (!Number.isInteger(v) || v < 0 || v > BP_100) {
    throw new RangeError(`${label} precisa estar entre 0 e 10000 bp, recebido: ${v}`);
  }
}

/** Aplica percentual com arredondamento bancário simples (meio para cima). */
export function applyBp(amount: Cents, bp: BasisPoints): Cents {
  assertCents(amount);
  assertBp(bp);
  return Math.round((amount * bp) / BP_100);
}

/**
 * Divide um valor em N partes que somam EXATAMENTE o total.
 * O resto dos centavos vai para as primeiras parcelas (100,00 em 3x = 33,34 + 33,33 + 33,33).
 */
export function splitEven(total: Cents, parts: number): Cents[] {
  assertCents(total, 'total');
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError(`parcelas inválidas: ${parts}`);
  const base = Math.floor(total / parts);
  const rest = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0));
}

export function formatBRL(v: Cents): string {
  return (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
