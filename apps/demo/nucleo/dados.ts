/**
 * Seed fictício da Clínica Aurora. Vive em memória: o demo não tem banco e não
 * fala com o WhatsApp. Os números saem daqui e passam pelas funções de verdade
 * de packages/core — é isso que faz a demonstração ser honesta.
 */

export const CLINICA = {
  nome: 'Clínica Aurora',
  endereco: 'Rua Exemplo, 100, conj. 42 — Jardins',
} as const;

export interface Procedimento {
  nome: string;
  precoCentavos: number;
  duracaoAgendaMin: number;
  duracaoRealMin: number;
  custoInsumosCentavos: number;
  comissaoBp: number;
}

export const PROCEDIMENTOS: Record<string, Procedimento> = {
  botox: {
    nome: 'Toxina botulínica',
    precoCentavos: 150000,
    duracaoAgendaMin: 40,
    duracaoRealMin: 55,
    custoInsumosCentavos: 42000,
    comissaoBp: 2000,
  },
  preenchimento: {
    nome: 'Preenchimento labial',
    precoCentavos: 180000,
    duracaoAgendaMin: 60,
    duracaoRealMin: 65,
    custoInsumosCentavos: 60000,
    comissaoBp: 2000,
  },
  limpeza: {
    nome: 'Profilaxia',
    precoCentavos: 25000,
    duracaoAgendaMin: 45,
    duracaoRealMin: 45,
    custoInsumosCentavos: 3000,
    comissaoBp: 1500,
  },
  avaliacao: {
    nome: 'Avaliação',
    precoCentavos: 20000,
    duracaoAgendaMin: 30,
    duracaoRealMin: 25,
    custoInsumosCentavos: 0,
    comissaoBp: 1000,
  },
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
  dia: 'hoje' | 'amanha';
  profissionalId: string;
  horaAgendada: string; // HH:MM
  paciente: string;
  procedimentoId: string;
  status: StatusConsulta;
  chegouEm?: string;
  iniciadaEm?: string;
  finalizadaEm?: string;
  origem?: 'recepcao' | 'assistente' | 'lista_espera';
}

/**
 * O dia da Dra. Ana atrasa porque a toxina botulínica leva 55 minutos e a agenda
 * reserva 40. É a causa raiz que a tela de Pontualidade mostra no fim.
 */
export const CONSULTAS: ConsultaDemo[] = [
  {
    id: 'h1',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '09:00',
    paciente: 'Beatriz Nunes',
    procedimentoId: 'botox',
    status: 'realizado',
    chegouEm: '08:52',
    iniciadaEm: '09:02',
    finalizadaEm: '09:58',
  },
  {
    id: 'h2',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '09:40',
    paciente: 'Rafael Prado',
    procedimentoId: 'preenchimento',
    status: 'realizado',
    chegouEm: '09:35',
    iniciadaEm: '10:00',
    finalizadaEm: '11:05',
  },
  {
    id: 'h3',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '10:40',
    paciente: 'Camila Duarte',
    procedimentoId: 'botox',
    status: 'confirmado',
    chegouEm: '10:28',
    iniciadaEm: '11:06',
  },
  {
    id: 'h4',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '11:40',
    paciente: 'Patrícia Alves',
    procedimentoId: 'avaliacao',
    status: 'confirmado',
    chegouEm: '11:05',
  },
  {
    id: 'h5',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '12:10',
    paciente: 'Lucas Martins',
    procedimentoId: 'botox',
    status: 'confirmado',
  },
  {
    id: 'h6',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '14:00',
    paciente: 'Sofia Andrade',
    procedimentoId: 'preenchimento',
    status: 'confirmado',
  },
  {
    id: 'h7',
    dia: 'hoje',
    profissionalId: 'ana',
    horaAgendada: '15:30',
    paciente: 'Marina Lopes',
    procedimentoId: 'botox',
    status: 'agendado',
  },
  {
    id: 'p1',
    dia: 'hoje',
    profissionalId: 'paulo',
    horaAgendada: '09:00',
    paciente: 'Eduardo Ramos',
    procedimentoId: 'limpeza',
    status: 'realizado',
    chegouEm: '08:55',
    iniciadaEm: '09:00',
    finalizadaEm: '09:44',
  },
  {
    id: 'p2',
    dia: 'hoje',
    profissionalId: 'paulo',
    horaAgendada: '10:00',
    paciente: 'Juliana Rocha',
    procedimentoId: 'limpeza',
    status: 'faltou',
  },
  {
    id: 'p3',
    dia: 'hoje',
    profissionalId: 'paulo',
    horaAgendada: '11:00',
    paciente: 'Tiago Moreira',
    procedimentoId: 'avaliacao',
    status: 'confirmado',
  },
  {
    id: 'p4',
    dia: 'hoje',
    profissionalId: 'paulo',
    horaAgendada: '15:00',
    paciente: 'Helena Castro',
    procedimentoId: 'limpeza',
    status: 'confirmado',
  },
  {
    id: 't1',
    dia: 'amanha',
    profissionalId: 'ana',
    horaAgendada: '09:00',
    paciente: 'Renata Vieira',
    procedimentoId: 'preenchimento',
    status: 'confirmado',
  },
  {
    id: 't2',
    dia: 'amanha',
    profissionalId: 'ana',
    horaAgendada: '10:30',
    paciente: 'Fernanda Lima',
    procedimentoId: 'botox',
    status: 'agendado',
  },
  {
    id: 't3',
    dia: 'amanha',
    profissionalId: 'ana',
    horaAgendada: '14:00',
    paciente: 'Carla Mendes',
    procedimentoId: 'botox',
    status: 'agendado',
  },
  {
    id: 't4',
    dia: 'amanha',
    profissionalId: 'ana',
    horaAgendada: '16:00',
    paciente: 'Vanessa Cardoso',
    procedimentoId: 'botox',
    status: 'confirmado',
  },
  {
    id: 't5',
    dia: 'amanha',
    profissionalId: 'paulo',
    horaAgendada: '09:00',
    paciente: 'Gustavo Peixoto',
    procedimentoId: 'limpeza',
    status: 'confirmado',
  },
  {
    id: 't6',
    dia: 'amanha',
    profissionalId: 'paulo',
    horaAgendada: '11:00',
    paciente: 'Larissa Amaral',
    procedimentoId: 'avaliacao',
    status: 'agendado',
  },
  {
    id: 't7',
    dia: 'amanha',
    profissionalId: 'paulo',
    horaAgendada: '14:30',
    paciente: 'Bruno Teles',
    procedimentoId: 'limpeza',
    status: 'confirmado',
  },
];

export interface EsperaDemo {
  id: string;
  paciente: string;
  procedimentoId: string;
  prioridade: number;
  desde: string;
  estado: 'aguardando' | 'ofertado' | 'atendido' | 'preenchido_por_outro';
}

export const LISTA_DE_ESPERA: EsperaDemo[] = [
  {
    id: 'w1',
    paciente: 'Mariana Teixeira',
    procedimentoId: 'botox',
    prioridade: 1,
    desde: 'há 6 dias',
    estado: 'aguardando',
  },
  {
    id: 'w2',
    paciente: 'João Bulhões',
    procedimentoId: 'botox',
    prioridade: 0,
    desde: 'há 4 dias',
    estado: 'aguardando',
  },
  {
    id: 'w3',
    paciente: 'Isabela Freitas',
    procedimentoId: 'botox',
    prioridade: 0,
    desde: 'há 2 dias',
    estado: 'aguardando',
  },
  {
    id: 'w4',
    paciente: 'Otávio Pinheiro',
    procedimentoId: 'limpeza',
    prioridade: 0,
    desde: 'há 1 dia',
    estado: 'aguardando',
  },
];

/** Faltas do mês, para o número que o dono sente no bolso. */
export const FALTAS_DO_MES = [
  { paciente: 'Juliana Rocha', procedimentoId: 'limpeza' },
  { paciente: 'Sérgio Bastos', procedimentoId: 'botox' },
  { paciente: 'Aline Ferraz', procedimentoId: 'preenchimento' },
  { paciente: 'Diego Matos', procedimentoId: 'limpeza' },
  { paciente: 'Priscila Nunes', procedimentoId: 'botox' },
  { paciente: 'Rogério Antunes', procedimentoId: 'avaliacao' },
  { paciente: 'Letícia Barros', procedimentoId: 'limpeza' },
];

export const FORMA_DE_PAGAMENTO = {
  nome: 'Crédito 3x',
  taxaBp: 349,
  diasParaReceber: 30,
  parcelas: 3,
} as const;

export const CONFIG_FILA = {
  modo: 'lote' as const,
  tamanhoLote: 3,
  timeoutMin: 20,
  antecedenciaMinimaMin: 60,
};

/**
 * Durações medidas nos últimos 90 dias, em minutos, um número por atendimento.
 * Ficam cruas de propósito: quem decide se a agenda deve mudar é sugerirDuracao,
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

export interface VagaDaSemana {
  procedimentoId: string;
  status: 'agendado' | 'confirmado' | 'em_risco';
}

/**
 * O ritmo da semana, por dia (1 = segunda … 6 = sábado). É o que a clínica tem
 * marcado daqui em diante; sem isso a projeção de caixa seria uma linha reta, que
 * nenhuma clínica de verdade tem. Domingo não atende.
 */
export const RITMO_DA_SEMANA: Record<number, VagaDaSemana[]> = {
  1: [
    { procedimentoId: 'botox', status: 'confirmado' },
    { procedimentoId: 'limpeza', status: 'confirmado' },
    { procedimentoId: 'limpeza', status: 'agendado' },
    { procedimentoId: 'avaliacao', status: 'agendado' },
  ],
  2: [
    { procedimentoId: 'preenchimento', status: 'confirmado' },
    { procedimentoId: 'botox', status: 'agendado' },
    { procedimentoId: 'limpeza', status: 'confirmado' },
  ],
  3: [
    { procedimentoId: 'botox', status: 'confirmado' },
    { procedimentoId: 'botox', status: 'em_risco' },
    { procedimentoId: 'limpeza', status: 'agendado' },
    { procedimentoId: 'avaliacao', status: 'confirmado' },
  ],
  4: [
    { procedimentoId: 'preenchimento', status: 'agendado' },
    { procedimentoId: 'limpeza', status: 'confirmado' },
    { procedimentoId: 'limpeza', status: 'em_risco' },
  ],
  5: [
    { procedimentoId: 'botox', status: 'confirmado' },
    { procedimentoId: 'preenchimento', status: 'confirmado' },
    { procedimentoId: 'limpeza', status: 'agendado' },
    { procedimentoId: 'avaliacao', status: 'agendado' },
  ],
  6: [
    { procedimentoId: 'limpeza', status: 'confirmado' },
    { procedimentoId: 'avaliacao', status: 'agendado' },
  ],
};
