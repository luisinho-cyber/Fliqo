import {
  efeitoDaResposta,
  interpretarResposta,
  PAYLOAD_BOTOES,
  planejarOferta,
  projetarDia,
  sugerirDuracao,
  type ConsultaDoDia,
  type Efeito,
  type PlanoDeOferta,
  type PrevisaoConsulta,
} from '@fliqo/core';
import { CONFIG_FILA, DURACOES_REAIS, PROCEDIMENTOS, type ConsultaDemo } from './dados';
import { instanteDe } from './relogio';

/**
 * A ponte entre o seed fictício e as funções de verdade de packages/core.
 *
 * Nada aqui recalcula regra de negócio. Este arquivo só traduz o formato do seed
 * para o formato que o core espera e devolve o resultado — se a regra mudar no
 * core, a demonstração muda junto, que é o ponto de usar a lógica real em vez de
 * desenhar o resultado à mão.
 */

const MIN = 60_000;

/**
 * Duração que o dia leva de verdade: a mediana medida, quando o core diz que a
 * amostra basta para confiar nela; a da agenda, quando não.
 */
export function duracaoEsperada(procedimentoId: string): number {
  const agenda = PROCEDIMENTOS[procedimentoId]?.duracaoAgendaMin ?? 30;
  const s = sugerirDuracao(DURACOES_REAIS[procedimentoId] ?? [], agenda);
  return s.sugerir ? s.medianaMin : agenda;
}

export function paraCore(c: ConsultaDemo, inicioDoDia: Date): ConsultaDoDia {
  const inicio = instanteDe(inicioDoDia, c.marcadaEm);
  const duracaoAgenda = PROCEDIMENTOS[c.procedimentoId]?.duracaoAgendaMin ?? 30;
  return {
    id: c.id,
    inicioAgendado: inicio,
    fimAgendado: new Date(inicio.getTime() + duracaoAgenda * MIN),
    duracaoEsperadaMin: duracaoEsperada(c.procedimentoId),
    status: c.status,
    ...(c.chegouEm === undefined ? {} : { pacienteChegouEm: instanteDe(inicioDoDia, c.chegouEm) }),
    ...(c.iniciadaEm === undefined ? {} : { iniciadaEm: instanteDe(inicioDoDia, c.iniciadaEm) }),
    ...(c.finalizadaEm === undefined
      ? {}
      : { finalizadaEm: instanteDe(inicioDoDia, c.finalizadaEm) }),
  };
}

export function consultasDoProfissional(
  consultas: ConsultaDemo[],
  profissionalId: string,
): ConsultaDemo[] {
  return consultas
    .filter((c) => c.profissionalId === profissionalId)
    .sort((a, b) => a.marcadaEm - b.marcadaEm);
}

/**
 * O efeito cascata do dia, direto de `projetarDia`: onde cada consulta vai
 * começar DE VERDADE. É essa diferença entre o previsto e o marcado que a tela
 * desenha como deslocamento, sem ninguém precisar ler um número.
 */
export function previsaoDoDia(
  consultas: ConsultaDemo[],
  profissionalId: string,
  inicioDoDia: Date,
  momento: Date,
): Map<string, PrevisaoConsulta> {
  const doDia = consultasDoProfissional(consultas, profissionalId).map((c) =>
    paraCore(c, inicioDoDia),
  );
  return new Map(projetarDia(doDia, momento).map((p) => [p.id, p]));
}

/** Dá tempo de oferecer a vaga, e para quantas pessoas? Quem responde é o core. */
export function planoDaVaga(inicioDaVaga: Date, momento: Date): PlanoDeOferta {
  return planejarOferta(CONFIG_FILA, inicioDaVaga, momento);
}

/**
 * O que a clínica faz com a resposta do paciente. A resposta chega como payload
 * de botão de template, então quem a traduz é `interpretarResposta`, e quem
 * decide o efeito é `efeitoDaResposta` — a demonstração não opina.
 */
export function efeitoDoBotao(payload: string): Efeito {
  return efeitoDaResposta(interpretarResposta({ payloadBotao: payload }));
}

export { PAYLOAD_BOTOES };
