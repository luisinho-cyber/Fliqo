export interface Intervalo {
  inicio: Date;
  fim: Date;
}

const MIN = 60_000;

function sobrepoe(a: Intervalo, b: Intervalo): boolean {
  return a.inicio < b.fim && b.inicio < a.fim; // meio-aberto: [inicio, fim)
}

/**
 * Horários livres para um procedimento de `duracaoMin` dentro do expediente.
 * A IA só pode oferecer horários que vieram DAQUI — ela nunca "inventa" um horário.
 * O banco (constraint no_double_booking) é a garantia final; esta função é a vitrine.
 */
export function horariosLivres(params: {
  expediente: Intervalo[];
  ocupados: Intervalo[];
  duracaoMin: number;
  passoMin?: number;
  agora: Date;
  antecedenciaMinimaMin?: number;
  limite?: number;
}): Date[] {
  const { expediente, ocupados, duracaoMin, agora } = params;
  const passo = (params.passoMin ?? 15) * MIN;
  const duracao = duracaoMin * MIN;
  const aPartirDe = agora.getTime() + (params.antecedenciaMinimaMin ?? 60) * MIN;
  const limite = params.limite ?? Number.POSITIVE_INFINITY;
  const out: Date[] = [];

  for (const bloco of [...expediente].sort((a, b) => a.inicio.getTime() - b.inicio.getTime())) {
    // alinha o primeiro candidato ao passo, a partir do início do bloco
    let t = bloco.inicio.getTime();
    if (t < aPartirDe) t += Math.ceil((aPartirDe - t) / passo) * passo;
    for (; t + duracao <= bloco.fim.getTime(); t += passo) {
      const cand = { inicio: new Date(t), fim: new Date(t + duracao) };
      if (!ocupados.some((o) => sobrepoe(o, cand))) {
        out.push(cand.inicio);
        if (out.length >= limite) return out;
      }
    }
  }
  return out;
}

/**
 * Espalha as sugestões: em vez de "14h, 14h15, 14h30", oferece opções em períodos diferentes.
 * Humano de recepção faz assim ("tenho terça de manhã ou quinta à tarde").
 */
export function sugestoesVariadas(
  livres: Date[],
  quantidade = 3,
  distanciaMinimaMin = 180,
): Date[] {
  const out: Date[] = [];
  for (const d of livres) {
    if (out.every((o) => Math.abs(o.getTime() - d.getTime()) >= distanciaMinimaMin * MIN))
      out.push(d);
    if (out.length === quantidade) break;
  }
  return out;
}
