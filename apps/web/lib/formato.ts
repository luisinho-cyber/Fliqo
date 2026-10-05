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

/**
 * "1.234,56" ou "1234.56" ou "250" para centavos inteiros.
 *
 * Existe para a conversão acontecer UMA vez, na borda, e nunca com float no meio:
 * `Math.round(Number('1234,56') * 100)` passa por 123455.99999 em alguns valores, e
 * dinheiro não passa por float (CLAUDE.md, regra 1). Aqui os centavos são lidos como
 * dígitos, não calculados.
 *
 * Campo vazio é zero — "sem preço cadastrado" é um estado válido, e a tela o nomeia.
 */
export function centavosDoCampo(valor: string): number {
  const limpo = valor.trim().replace(/\s/g, '');
  if (limpo === '') return 0;

  // Separador decimal é o ÚLTIMO ponto ou vírgula, e só quando sobram 1 ou 2 dígitos
  // depois dele: "1.234" é mil duzentos e trinta e quatro reais, não um real e 234.
  const m = /^(.*?)([.,](\d{1,2}))?$/.exec(limpo);
  const inteiros = (m?.[1] ?? limpo).replace(/[.,]/g, '');
  const decimais = (m?.[3] ?? '').padEnd(2, '0');
  const centavos = Number(`${inteiros === '' ? '0' : inteiros}${decimais}`);
  return Number.isSafeInteger(centavos) && centavos >= 0 ? centavos : 0;
}
