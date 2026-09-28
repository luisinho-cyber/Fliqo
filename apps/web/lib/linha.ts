/**
 * A geometria da Linha do Dia.
 *
 * Só conta em milissegundos e porcentagem: nada de regra de negócio, nada de
 * rede. A projeção do atraso já veio pronta do servidor (é regra, e mora em
 * packages/core); aqui só se decide onde cada bloco cai na faixa.
 */

export interface Janela {
  inicioMs: number;
  fimMs: number;
}

export interface Bloco {
  inicioMs: number;
  fimMs: number;
}

const MIN = 60_000;
const HORA = 60 * MIN;

/**
 * A faixa cobre o dia que existe, não um horário comercial imaginado.
 *
 * Uma janela fixa de 8h às 19h espremeria os blocos a ponto de o nome do
 * paciente não caber — e o ponto da Linha do Dia é ler o dia sem clicar em nada.
 * O instante `agora` entra sempre: o cursor fora da faixa esconderia onde o dia
 * está.
 */
export function janelaDoDia(
  blocos: readonly Bloco[],
  agoraMs: number,
  opcoes: { margemMin?: number; minimoHoras?: number } = {},
): Janela {
  const margem = (opcoes.margemMin ?? 30) * MIN;
  const minimo = (opcoes.minimoHoras ?? 6) * HORA;

  const inicios = [...blocos.map((b) => b.inicioMs), agoraMs];
  const fins = [...blocos.map((b) => b.fimMs), agoraMs];
  const inicio = Math.min(...inicios) - margem;
  const fim = Math.max(...fins) + margem;

  return { inicioMs: inicio, fimMs: Math.max(fim, inicio + minimo) };
}

/** Onde um instante cai na faixa, de 0 a 100. Fora da faixa, gruda na borda. */
export function pct(instanteMs: number, janela: Janela): number {
  const largura = janela.fimMs - janela.inicioMs;
  if (largura <= 0) return 0;
  const bruto = ((instanteMs - janela.inicioMs) / largura) * 100;
  return Math.max(0, Math.min(100, bruto));
}

/**
 * A largura de um bloco, em porcentagem da faixa.
 * Nunca zero: um bloco de largura zero some da tela, e uma consulta que sumiu
 * da agenda é pior do que uma consulta fina demais.
 */
export function largura(duracaoMs: number, janela: Janela): number {
  const total = janela.fimMs - janela.inicioMs;
  if (total <= 0) return 0;
  return Math.max(1.2, Math.min(100, (duracaoMs / total) * 100));
}

export interface MarcaDeHora {
  pct: number;
  rotulo: string;
}

/** As horas cheias dentro da faixa, no relógio da clínica. */
export function marcasDeHora(janela: Janela, fuso: string): MarcaDeHora[] {
  const marcas: MarcaDeHora[] = [];
  const primeira = Math.ceil(janela.inicioMs / HORA) * HORA;
  for (let t = primeira; t <= janela.fimMs; t += HORA) {
    marcas.push({ pct: pct(t, janela), rotulo: hhmm(t, fuso) });
  }
  return marcas;
}

/** Hora no relógio da clínica, nunca no do servidor nem no do navegador. */
export function hhmm(instanteMs: number, fuso: string): string {
  return new Date(instanteMs).toLocaleTimeString('pt-BR', {
    timeZone: fuso,
    hour: '2-digit',
    minute: '2-digit',
  });
}
