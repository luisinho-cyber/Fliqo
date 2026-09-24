/**
 * Atrasos do profissional.
 *
 * O atraso raramente é culpa de um paciente: é a duração do procedimento subestimada na agenda,
 * que vai se acumulando ao longo do dia. Este módulo faz três coisas:
 *   1. PREVÊ em tempo real o horário em que cada paciente vai ser atendido (efeito cascata).
 *   2. AVISA o paciente antes de ele sair de casa — espera explicada incomoda muito menos
 *      do que espera sem explicação.
 *   3. MOSTRA a causa: quanto cada procedimento dura de verdade com cada profissional.
 */

const MIN = 60_000;

export interface ConsultaDoDia {
  id: string;
  inicioAgendado: Date;
  fimAgendado: Date;
  duracaoEsperadaMin: number; // duração real histórica (ou a da agenda, se não houver histórico)
  iniciadaEm?: Date; // profissional/recepção apertou "iniciar atendimento"
  finalizadaEm?: Date;
  pacienteChegouEm?: Date; // check-in na recepção
  status: 'agendado' | 'confirmado' | 'em_risco' | 'realizado' | 'cancelado' | 'faltou';
}

export interface PrevisaoConsulta {
  id: string;
  inicioPrevisto: Date;
  atrasoMin: number; // 0 quando no horário
  situacao: 'finalizada' | 'em_atendimento' | 'aguardando';
}

/**
 * Efeito cascata do dia de UM profissional. As consultas precisam vir desse profissional.
 * Buracos na agenda absorvem atraso: se sobra meia hora livre, o atraso diminui.
 */
export function projetarDia(consultas: ConsultaDoDia[], agora: Date): PrevisaoConsulta[] {
  const ativas = consultas
    .filter((c) => c.status !== 'cancelado' && c.status !== 'faltou')
    .sort((a, b) => a.inicioAgendado.getTime() - b.inicioAgendado.getTime());

  let livreEm = agora.getTime(); // quando o profissional fica livre, pela previsão
  const out: PrevisaoConsulta[] = [];

  for (const c of ativas) {
    if (c.finalizadaEm) {
      const inicio = c.iniciadaEm ?? c.inicioAgendado;
      out.push({
        id: c.id,
        inicioPrevisto: inicio,
        atrasoMin: atraso(inicio, c.inicioAgendado),
        situacao: 'finalizada',
      });
      continue;
    }
    if (c.iniciadaEm) {
      // Em atendimento: termina no mínimo "agora"; se ainda está dentro da duração esperada, termina no esperado.
      const fimEsperado = c.iniciadaEm.getTime() + c.duracaoEsperadaMin * MIN;
      livreEm = Math.max(agora.getTime(), fimEsperado);
      out.push({
        id: c.id,
        inicioPrevisto: c.iniciadaEm,
        atrasoMin: atraso(c.iniciadaEm, c.inicioAgendado),
        situacao: 'em_atendimento',
      });
      continue;
    }
    const inicio = Math.max(c.inicioAgendado.getTime(), livreEm);
    out.push({
      id: c.id,
      inicioPrevisto: new Date(inicio),
      atrasoMin: atraso(new Date(inicio), c.inicioAgendado),
      situacao: 'aguardando',
    });
    livreEm = inicio + c.duracaoEsperadaMin * MIN;
  }
  return out;
}

function atraso(real: Date, agendado: Date): number {
  return Math.max(0, Math.round((real.getTime() - agendado.getTime()) / MIN));
}

export interface ConfigAtrasos {
  limiarAvisoMin: number; // só avisa a partir de X min de atraso (padrão 15)
  janelaAvisoHoras: number; // avisa quem tem consulta nas próximas X horas (padrão 3)
  variacaoParaReavisarMin: number; // reavisa só se o atraso mudou X min ou mais (padrão 10)
  arredondarParaMin: number; // "cerca de 20 min", nunca "17 min" (padrão 5)
}

export const CONFIG_ATRASOS_PADRAO: ConfigAtrasos = {
  limiarAvisoMin: 15,
  janelaAvisoHoras: 3,
  variacaoParaReavisarMin: 10,
  arredondarParaMin: 5,
};

export type Aviso =
  | {
      para: 'paciente';
      consultaId: string;
      atrasoMin: number;
      novoHorario: Date;
      tipo: 'atraso' | 'normalizou';
    }
  | { para: 'recepcao'; consultaId: string; atrasoMin: number; motivo: 'paciente_ja_na_sala' };

/**
 * Decide quem avisar agora. `jaAvisado` = último atraso comunicado a cada consulta (em min).
 * - Paciente que já está na recepção não recebe WhatsApp: a recepção é avisada para falar pessoalmente.
 * - Não reavisa por variação pequena (ninguém quer 6 mensagens de atraso).
 * - Se o atraso sumiu depois de um aviso, manda "pode vir no horário normal".
 */
export function decidirAvisos(
  consultas: ConsultaDoDia[],
  previsao: PrevisaoConsulta[],
  jaAvisado: ReadonlyMap<string, number>,
  agora: Date,
  cfg: ConfigAtrasos = CONFIG_ATRASOS_PADRAO,
): Aviso[] {
  const porId = new Map(consultas.map((c) => [c.id, c]));
  const limiteJanela = agora.getTime() + cfg.janelaAvisoHoras * 60 * MIN;
  const avisos: Aviso[] = [];

  for (const p of previsao) {
    if (p.situacao !== 'aguardando') continue;
    const c = porId.get(p.id);
    if (!c || c.inicioAgendado.getTime() > limiteJanela) continue;

    const atrasoArredondado =
      Math.round(p.atrasoMin / cfg.arredondarParaMin) * cfg.arredondarParaMin;
    const anterior = jaAvisado.get(p.id);

    if (p.atrasoMin >= cfg.limiarAvisoMin) {
      if (
        anterior !== undefined &&
        Math.abs(atrasoArredondado - anterior) < cfg.variacaoParaReavisarMin
      )
        continue;
      if (c.pacienteChegouEm) {
        avisos.push({
          para: 'recepcao',
          consultaId: p.id,
          atrasoMin: atrasoArredondado,
          motivo: 'paciente_ja_na_sala',
        });
      } else {
        avisos.push({
          para: 'paciente',
          consultaId: p.id,
          atrasoMin: atrasoArredondado,
          novoHorario: p.inicioPrevisto,
          tipo: 'atraso',
        });
      }
    } else if (anterior !== undefined && anterior > 0 && !c.pacienteChegouEm) {
      avisos.push({
        para: 'paciente',
        consultaId: p.id,
        atrasoMin: 0,
        novoHorario: c.inicioAgendado,
        tipo: 'normalizou',
      });
    }
  }
  return avisos;
}

/**
 * Atendimento longo na sala de espera: alerta a recepção para ir falar com o paciente
 * (oferecer água/café, explicar). Quem espera sem ninguém falar nada vai embora irritado.
 */
export function esperandoDemais(
  consultas: ConsultaDoDia[],
  agora: Date,
  toleranciaMin = 15,
): { consultaId: string; esperandoMin: number }[] {
  return consultas
    .filter((c) => c.pacienteChegouEm && !c.iniciadaEm && c.status !== 'cancelado')
    .map((c) => {
      // O filter acima já garante pacienteChegouEm; o TS não estreita através dele.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const referencia = Math.max(c.pacienteChegouEm!.getTime(), c.inicioAgendado.getTime());
      return { consultaId: c.id, esperandoMin: Math.floor((agora.getTime() - referencia) / MIN) };
    })
    .filter((x) => x.esperandoMin >= toleranciaMin);
}

/**
 * A causa raiz: duração real vs. duração na agenda, por profissional e procedimento.
 * Usa a mediana (um atendimento que travou não distorce) e exige amostra mínima.
 */
export function sugerirDuracao(
  duracoesReaisMin: number[],
  duracaoNaAgendaMin: number,
  opcoes = { amostraMinima: 8, diferencaMinimaMin: 10, arredondarPara: 5 },
):
  | { sugerir: false }
  | { sugerir: true; novaDuracaoMin: number; medianaMin: number; amostra: number } {
  if (duracoesReaisMin.length < opcoes.amostraMinima) return { sugerir: false };
  const ord = [...duracoesReaisMin].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  // amostraMinima >= 1 garante que meio e meio-1 estão dentro do array.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const mediana = ord.length % 2 ? ord[meio]! : (ord[meio - 1]! + ord[meio]!) / 2;
  if (Math.abs(mediana - duracaoNaAgendaMin) < opcoes.diferencaMinimaMin) return { sugerir: false };
  const nova = Math.ceil(mediana / opcoes.arredondarPara) * opcoes.arredondarPara;
  return { sugerir: true, novaDuracaoMin: nova, medianaMin: mediana, amostra: ord.length };
}

/** Indicadores de pontualidade do dia/mês para o painel do dono. */
export function pontualidade(previsoesFinalizadas: PrevisaoConsulta[], toleranciaMin = 10) {
  const n = previsoesFinalizadas.length;
  if (n === 0) return { atendimentos: 0, noHorarioPct: 0, atrasoMedioMin: 0 };
  const noHorario = previsoesFinalizadas.filter((p) => p.atrasoMin <= toleranciaMin).length;
  const soma = previsoesFinalizadas.reduce((s, p) => s + p.atrasoMin, 0);
  return {
    atendimentos: n,
    noHorarioPct: Math.round((noHorario / n) * 100),
    atrasoMedioMin: Math.round(soma / n),
  };
}

/**
 * Duração que a projeção deve usar.
 *
 * A mediana medida só entra com amostra suficiente: com três atendimentos, um
 * caso fora da curva vira "verdade" e desloca o dia inteiro na tela. Sem
 * amostra, vale a duração que está na agenda — que é o que a clínica combinou.
 */
export function duracaoParaProjecao(
  medida: { medianaMin: number; amostra: number } | undefined,
  duracaoNaAgendaMin: number,
  amostraMinima = 8,
): number {
  if (!medida || medida.amostra < amostraMinima) return duracaoNaAgendaMin;
  return Math.round(medida.medianaMin);
}

/**
 * Teto de avisos por consulta.
 *
 * Três mensagens de atraso já são muitas; a quarta vira incômodo e a clínica
 * parece desorganizada. O teto conta só o que foi para o PACIENTE: alerta de
 * recepção é interno e não gasta a cota.
 *
 * O aviso de que o atraso passou ("normalizou") conta como os outros, de
 * propósito: quem passou do teto já recebeu informação demais, e o horário
 * marcado continua valendo para quem não foi avisado de mudança nenhuma.
 */
export function respeitarLimiteDeAvisos(
  avisos: Aviso[],
  enviadosPorConsulta: ReadonlyMap<string, number>,
  maximo = 3,
): Aviso[] {
  return avisos.filter((a) => {
    if (a.para !== 'paciente') return true;
    return (enviadosPorConsulta.get(a.consultaId) ?? 0) < maximo;
  });
}
