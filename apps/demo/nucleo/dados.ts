/**
 * Seed fictício da Clínica Aurora. Vive em memória: a demonstração não tem banco
 * e não fala com a Meta. Nenhum nome, telefone ou procedimento aqui pertence a
 * paciente de verdade.
 *
 * Os horários são OFFSETS em minutos desde o começo do dia da clínica, não horas
 * de parede. O dia é ancorado em `nucleo/relogio.ts` de modo que o minuto atual
 * caia sempre no mesmo ponto da jornada — é isso que deixa a linha do agora
 * mostrar este minuto de verdade, a qualquer hora que a demonstração abra, sem
 * um relógio congelado.
 */

export const CLINICA = {
  nome: 'Clínica Aurora',
} as const;

export interface Procedimento {
  nome: string;
  duracaoAgendaMin: number;
}

export const PROCEDIMENTOS: Record<string, Procedimento> = {
  botox: { nome: 'Toxina botulínica', duracaoAgendaMin: 40 },
  preenchimento: { nome: 'Preenchimento labial', duracaoAgendaMin: 60 },
  limpeza: { nome: 'Profilaxia', duracaoAgendaMin: 45 },
  avaliacao: { nome: 'Avaliação', duracaoAgendaMin: 30 },
};

export interface Profissional {
  id: string;
  nome: string;
  especialidade: string;
}

export const PROFISSIONAIS: Profissional[] = [
  { id: 'ana', nome: 'Dra. Ana Ribeiro', especialidade: 'Harmonização facial' },
  { id: 'paulo', nome: 'Dr. Paulo Serra', especialidade: 'Odontologia' },
];

export type StatusConsulta =
  'agendado' | 'confirmado' | 'em_risco' | 'realizado' | 'cancelado' | 'faltou';

export interface ConsultaDemo {
  id: string;
  profissionalId: string;
  /** Minutos desde o começo do dia da clínica. */
  marcadaEm: number;
  paciente: string;
  procedimentoId: string;
  status: StatusConsulta;
  chegouEm?: number;
  iniciadaEm?: number;
  finalizadaEm?: number;
}

/**
 * O minuto do dia em que a demonstração abre. Às 2h12 de jornada a Dra. Ana já
 * acumulou o atraso que desloca os dois blocos seguintes, e os três toques
 * (chegou, iniciar, finalizar) têm cada um um alvo esperando na tela.
 */
export const MINUTO_DE_ABERTURA = 132;

/**
 * O dia da Dra. Ana atrasa porque a toxina botulínica leva 55 minutos medidos e a
 * agenda reserva 40. O buraco das 5h de jornada absorve o atraso: do Sofia para
 * frente o dia volta ao horário, e é por isso que o deslocamento não vale para
 * todos os blocos.
 */
export const CONSULTAS: ConsultaDemo[] = [
  {
    id: 'a1',
    profissionalId: 'ana',
    marcadaEm: 0,
    paciente: 'Beatriz Nunes',
    procedimentoId: 'botox',
    status: 'realizado',
    chegouEm: -8,
    iniciadaEm: 2,
    finalizadaEm: 58,
  },
  {
    id: 'a2',
    profissionalId: 'ana',
    marcadaEm: 40,
    paciente: 'Rafael Prado',
    procedimentoId: 'preenchimento',
    status: 'realizado',
    chegouEm: 35,
    iniciadaEm: 60,
    finalizadaEm: 125,
  },
  {
    id: 'a3',
    profissionalId: 'ana',
    marcadaEm: 100,
    paciente: 'Camila Duarte',
    procedimentoId: 'botox',
    status: 'confirmado',
    chegouEm: 88,
    iniciadaEm: 126,
  },
  {
    id: 'a4',
    profissionalId: 'ana',
    marcadaEm: 160,
    paciente: 'Patrícia Alves',
    procedimentoId: 'avaliacao',
    status: 'confirmado',
    chegouEm: 125,
  },
  {
    id: 'a5',
    profissionalId: 'ana',
    marcadaEm: 190,
    paciente: 'Lucas Martins',
    procedimentoId: 'botox',
    status: 'confirmado',
  },
  {
    id: 'a6',
    profissionalId: 'ana',
    marcadaEm: 300,
    paciente: 'Sofia Andrade',
    procedimentoId: 'preenchimento',
    status: 'confirmado',
  },
  {
    id: 'a7',
    profissionalId: 'ana',
    marcadaEm: 390,
    paciente: 'Marina Lopes',
    procedimentoId: 'botox',
    status: 'agendado',
  },
  {
    id: 'p1',
    profissionalId: 'paulo',
    marcadaEm: 0,
    paciente: 'Eduardo Ramos',
    procedimentoId: 'limpeza',
    status: 'realizado',
    chegouEm: -5,
    iniciadaEm: 0,
    finalizadaEm: 44,
  },
  {
    id: 'p2',
    profissionalId: 'paulo',
    marcadaEm: 60,
    paciente: 'Juliana Rocha',
    procedimentoId: 'limpeza',
    status: 'faltou',
  },
  {
    id: 'p3',
    profissionalId: 'paulo',
    marcadaEm: 120,
    paciente: 'Tiago Moreira',
    procedimentoId: 'avaliacao',
    status: 'confirmado',
    chegouEm: 115,
  },
  {
    id: 'p4',
    profissionalId: 'paulo',
    marcadaEm: 240,
    paciente: 'Helena Castro',
    procedimentoId: 'limpeza',
    status: 'cancelado',
  },
  {
    id: 'p5',
    profissionalId: 'paulo',
    marcadaEm: 360,
    paciente: 'Bruno Teles',
    procedimentoId: 'limpeza',
    status: 'confirmado',
  },
];

/**
 * A rodada de confirmação que saiu na véspera, como ela fica no dia seguinte:
 * quem respondeu que vem, quem respondeu que não vem e quem não respondeu nada.
 *
 * `semResposta` não é cancelamento (CLAUDE.md, regra 5): o horário continua
 * marcado e a tela diz isso com essas palavras.
 */
export type EstadoConfirmacao = 'confirmou' | 'recusou' | 'semResposta' | 'aguardando';

export interface ConfirmacaoDemo {
  consultaId: string;
  estado: EstadoConfirmacao;
  /** Quando a resposta chegou, em minutos do dia (negativo: ontem). */
  respondeuEm?: number;
}

export const CONFIRMACOES: ConfirmacaoDemo[] = [
  { consultaId: 'a3', estado: 'confirmou', respondeuEm: -840 },
  { consultaId: 'a5', estado: 'confirmou', respondeuEm: -795 },
  { consultaId: 'a6', estado: 'confirmou', respondeuEm: -760 },
  { consultaId: 'a7', estado: 'aguardando' },
  { consultaId: 'p3', estado: 'confirmou', respondeuEm: -820 },
  { consultaId: 'p4', estado: 'recusou', respondeuEm: -805 },
  { consultaId: 'p5', estado: 'semResposta' },
];

export interface EsperaDemo {
  id: string;
  paciente: string;
  procedimentoId: string;
  desde: string;
  estado: 'aguardando' | 'ofertado' | 'ficou_com_a_vaga' | 'segue_na_fila';
}

export const LISTA_DE_ESPERA: EsperaDemo[] = [
  {
    id: 'w1',
    paciente: 'Mariana Teixeira',
    procedimentoId: 'botox',
    desde: 'há 6 dias',
    estado: 'aguardando',
  },
  {
    id: 'w2',
    paciente: 'João Bulhões',
    procedimentoId: 'botox',
    desde: 'há 4 dias',
    estado: 'aguardando',
  },
  {
    id: 'w3',
    paciente: 'Isabela Freitas',
    procedimentoId: 'botox',
    desde: 'há 2 dias',
    estado: 'aguardando',
  },
  {
    id: 'w4',
    paciente: 'Otávio Pinheiro',
    procedimentoId: 'limpeza',
    desde: 'há 1 dia',
    estado: 'aguardando',
  },
];

export const CONFIG_FILA = {
  modo: 'lote' as const,
  tamanhoLote: 3,
  timeoutMin: 20,
  antecedenciaMinimaMin: 60,
};

/**
 * Durações medidas nos últimos 90 dias, em minutos, um número por atendimento.
 * Ficam cruas de propósito: quem decide se a agenda deve mudar é `sugerirDuracao`,
 * que usa a mediana e exige amostra mínima — não uma média escrita à mão aqui.
 */
export const DURACOES_REAIS: Record<string, number[]> = {
  botox: [
    53, 58, 53, 52, 48, 53, 62, 57, 62, 56, 57, 56, 43, 60, 58, 58, 43, 42, 48, 51, 57, 54, 58, 50,
    57, 57, 50, 67, 58, 63, 50, 49, 52, 54,
  ],
  preenchimento: [
    77, 69, 63, 67, 70, 65, 74, 59, 61, 73, 65, 57, 72, 76, 61, 53, 63, 63, 62, 76, 56,
  ],
  limpeza: [
    36, 43, 43, 48, 50, 31, 50, 37, 48, 37, 45, 50, 44, 45, 48, 45, 44, 52, 50, 43, 58, 39, 49, 43,
    45, 48, 46, 48, 37, 37, 48, 40, 39, 37, 51, 48, 52, 40, 45, 39, 48, 52, 40, 52, 49, 44, 35, 52,
  ],
  avaliacao: [
    24, 22, 26, 26, 30, 20, 29, 30, 30, 24, 22, 29, 25, 25, 30, 23, 15, 23, 17, 28, 26, 22, 24, 28,
    25, 30, 24, 29, 30,
  ],
};
