/**
 * Ritmo humano de resposta. Ninguém da recepção responde em 200 ms, e ninguém manda
 * um parágrafo de 600 caracteres num balão só.
 *
 * O worker usa o resultado assim:
 *   1. espera `aguardarAntesMs` (leu a mensagem, pensou)
 *   2. envia "digitando…" e espera `digitandoMs` do balão
 *   3. envia o balão; repete 2–3 para o próximo
 * A espera é um JOB ATRASADO na fila, nunca um sleep dentro da requisição do webhook.
 */

export interface RitmoClinica {
  minRespostaMs: number;     // ex.: 4_000
  maxRespostaMs: number;     // ex.: 45_000 — recepção ocupada não responde em 3 s
  caracteresPorSegundo: number; // digitação no celular: ~4
}

export const RITMO_PADRAO: RitmoClinica = { minRespostaMs: 4_000, maxRespostaMs: 45_000, caracteresPorSegundo: 4 };

export interface PlanoDeEnvio {
  aguardarAntesMs: number;
  baloes: { texto: string; digitandoMs: number }[];
}

type Aleatorio = () => number; // injetável para teste; em produção, Math.random

export function planejarEnvio(
  recebido: string,
  resposta: string,
  ritmo: RitmoClinica = RITMO_PADRAO,
  rnd: Aleatorio = Math.random,
): PlanoDeEnvio {
  const leitura = Math.min(recebido.length * 40, 8_000);      // ~25 caracteres/s lendo
  const pensar = 1_500 + rnd() * 3_500;                       // 1,5 a 5 s
  const aguardarAntesMs = clamp(Math.round(leitura + pensar), ritmo.minRespostaMs, ritmo.maxRespostaMs);

  const baloes = quebrarEmBaloes(resposta).map((texto) => ({
    texto,
    digitandoMs: clamp(Math.round((texto.length / ritmo.caracteresPorSegundo) * 1_000 * (0.85 + rnd() * 0.3)), 1_200, 12_000),
  }));
  return { aguardarAntesMs, baloes };
}

/** Até 3 balões, quebrando em fim de frase. Nunca corta uma frase no meio. */
export function quebrarEmBaloes(texto: string, maxBaloes = 3, alvo = 160): string[] {
  const limpo = texto.trim().replace(/\s+/g, ' ');
  if (limpo.length <= alvo) return [limpo];
  const frases = limpo.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((f) => f.trim()) ?? [limpo];
  const baloes: string[] = [];
  for (const f of frases) {
    const ultimo = baloes.at(-1);
    if (ultimo !== undefined && (ultimo.length + f.length + 1 <= alvo || baloes.length === maxBaloes)) {
      baloes[baloes.length - 1] = `${ultimo} ${f}`;
    } else {
      baloes.push(f);
    }
  }
  return baloes;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
