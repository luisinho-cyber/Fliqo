import { formatBRL } from '@fliqo/core';

/** Dinheiro sempre pelo formatBRL de packages/core: um formato só no produto. */
export { formatBRL };

/** "cerca de 20 min" — nunca "17 min". Atraso exato não ajuda ninguém a decidir. */
export function atrasoAproximado(minutos: number): string {
  return `${String(Math.round(minutos / 5) * 5)} min`;
}

export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome;
}
