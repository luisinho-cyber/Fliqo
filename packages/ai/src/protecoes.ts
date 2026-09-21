/**
 * Proteções determinísticas. Rodam ANTES e DEPOIS do modelo, em código, sem IA.
 * Se uma delas dispara, a IA nem é chamada (ou a resposta dela não sai).
 */

export type Transferencia = { transferir: true; motivo: string; urgente: boolean } | { transferir: false };

const EMERGENCIA =
  /\b(sangr(ando|amento) (muito|forte|n[aã]o para)|n[aã]o consigo respirar|falta de ar|desmai|incha[cç]o (na garganta|no rosto todo)|rea[cç][aã]o al[eé]rgica|dor no peito|infarto|avc)\b/i;
const PEDE_HUMANO = /\b(falar com (algu[eé]m|uma pessoa|atendente|humano|a recep[cç][aã]o)|atendente|pessoa de verdade|humano)\b/i;
const FRUSTRACAO = /\b(absurdo|rid[ií]culo|p[eé]ssimo|vou processar|procon|reclame aqui|advogado|n[aã]o resolve|palha[cç]ada|desrespeito)\b/i;

export function checarEntrada(
  msg: { texto: string; audioSegundos?: number },
  gatilhosExtras: string[] = [],
): Transferencia {
  const t = msg.texto;
  if (EMERGENCIA.test(t)) return { transferir: true, motivo: 'possível emergência', urgente: true };
  if (PEDE_HUMANO.test(t)) return { transferir: true, motivo: 'paciente pediu atendimento humano', urgente: false };
  if (FRUSTRACAO.test(t)) return { transferir: true, motivo: 'paciente frustrado', urgente: false };
  if (t.length > 600) return { transferir: true, motivo: 'mensagem longa (provável reclamação ou caso complexo)', urgente: false };
  if ((msg.audioSegundos ?? 0) > 90) return { transferir: true, motivo: 'áudio longo', urgente: false };
  const extra = gatilhosExtras.find((g) => t.toLowerCase().includes(g.toLowerCase()));
  if (extra) return { transferir: true, motivo: `gatilho da clínica: ${extra}`, urgente: false };
  return { transferir: false };
}

/** Resposta enviada imediatamente em caso de emergência, sem passar pela IA. */
export const RESPOSTA_EMERGENCIA =
  'Pelo que você descreveu, procure atendimento de emergência agora: ligue 192 (SAMU) ou vá ao pronto-socorro mais próximo. ' +
  'Já avisei a equipe da clínica para entrar em contato com você.';

export type ChecagemSaida = { ok: true; texto: string } | { ok: false; motivo: string };

/**
 * Checa a resposta da IA antes de enviar:
 * - tira formatação de robô (negrito, listas, títulos);
 * - bloqueia valor em R$ que não existe na tabela da clínica (IA não inventa preço);
 * - bloqueia promessa de resultado e linguagem de diagnóstico.
 */
export function checarSaida(texto: string, precosPermitidosCentavos: number[]): ChecagemSaida {
  let limpo = texto
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .trim();

  const valores = [...limpo.matchAll(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/g)].map((m) =>
    Math.round(Number(m[1]!.replace(/\./g, '').replace(',', '.')) * 100),
  );
  const inventado = valores.find((v) => !precosPermitidosCentavos.includes(v));
  if (inventado !== undefined) return { ok: false, motivo: `valor fora da tabela: ${inventado} centavos` };

  if (/\b(garanto|garantimos|resultado garantido|100% (seguro|eficaz)|sem nenhum risco)\b/i.test(limpo)) {
    return { ok: false, motivo: 'promessa de resultado' };
  }
  if (/\b(voc[eê] tem|[eé] (provavelmente|com certeza) (uma|um) (infec[cç][aã]o|inflama[cç][aã]o|c[aá]rie|doen[cç]a)|tome \d|pode tomar)\b/i.test(limpo)) {
    return { ok: false, motivo: 'diagnóstico ou orientação de medicamento' };
  }
  limpo = limpo.replace(/\n{3,}/g, '\n\n');
  return { ok: true, texto: limpo };
}
