/**
 * Telefone brasileiro em E.164.
 *
 * Existe por um problema concreto: a Meta entrega o mesmo número de formas
 * diferentes — com ou sem +55, e celular antigo às vezes sem o nono dígito.
 * Gravar como veio faz o mesmo paciente virar duas fichas, com duas conversas
 * e dois históricos.
 *
 * Toda gravação e toda busca por telefone passa por aqui.
 */

/** DDDs que existem no Brasil. Fora desta lista, o número está errado. */
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export type TelefoneNormalizado =
  { ok: true; e164: string } | { ok: false; motivo: 'vazio' | 'curto_demais' | 'ddd_invalido' };

/**
 * Celular no Brasil tem 9 dígitos e começa com 9. Fixo tem 8 e começa com 2–5.
 * Um assinante de 8 dígitos começando com 6–9 é celular antigo: falta o 9.
 */
function completarNono(assinante: string): string {
  if (assinante.length !== 8) return assinante;
  const primeiro = assinante[0] ?? '';
  return primeiro >= '6' && primeiro <= '9' ? `9${assinante}` : assinante;
}

export function normalizarTelefoneBR(bruto: string): TelefoneNormalizado {
  const digitos = bruto.replace(/\D/g, '');
  if (digitos.length === 0) return { ok: false, motivo: 'vazio' };

  // Número estrangeiro sai como veio: só sabemos completar número brasileiro.
  if (bruto.trimStart().startsWith('+') && !digitos.startsWith('55')) {
    return { ok: true, e164: `+${digitos}` };
  }

  const semPais = digitos.startsWith('55') && digitos.length > 11 ? digitos.slice(2) : digitos;
  if (semPais.length < 10) return { ok: false, motivo: 'curto_demais' };

  const ddd = semPais.slice(0, 2);
  const assinante = completarNono(semPais.slice(2));

  if (!DDDS.has(Number(ddd))) return { ok: false, motivo: 'ddd_invalido' };
  if (assinante.length < 8 || assinante.length > 9) return { ok: false, motivo: 'curto_demais' };

  return { ok: true, e164: `+55${ddd}${assinante}` };
}

/** Dois jeitos de escrever o mesmo número são o mesmo paciente. */
export function mesmoTelefone(a: string, b: string): boolean {
  const na = normalizarTelefoneBR(a);
  const nb = normalizarTelefoneBR(b);
  return na.ok && nb.ok && na.e164 === nb.e164;
}
