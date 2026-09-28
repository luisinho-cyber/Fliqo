/**
 * O contrato da tela Hoje, como a nossa API responde.
 *
 * Escrito aqui e não importado de apps/api porque app nunca importa app
 * (CLAUDE.md, regra de dependência). O que amarra os dois é o teste da API.
 */

export interface ClinicaDaPessoa {
  id: string;
  nome: string;
}

export type SituacaoDaConsulta = 'finalizada' | 'em_atendimento' | 'aguardando';

export interface ConsultaDaTela {
  id: string;
  profissionalId: string;
  pacienteId: string;
  paciente: string;
  procedimento: string;
  inicioAgendado: string;
  fimAgendado: string;
  inicioPrevisto: string;
  duracaoEsperadaMin: number;
  atrasoMin: number;
  situacao: SituacaoDaConsulta;
  status: string;
  precoCents: number;
  chegou: boolean;
}

export interface ProfissionalDaTela {
  id: string;
  nome: string;
  atrasoMin: number;
}

export interface VagaDaTela {
  profissionalId: string;
  inicio: string;
  fim: string;
}

export interface DecisaoDaTela {
  id: string;
  tipo: string;
  gravidade: 'info' | 'atencao' | 'urgente';
  titulo: string;
  detalhe: string | null;
  consultaId: string | null;
}

export interface Hoje {
  clinica: ClinicaDaPessoa;
  fuso: string;
  dataIso: string;
  agora: string;
  manchete: { quantidade: number; naAgendaCents: number; semConfirmacaoCents: number };
  profissionais: ProfissionalDaTela[];
  consultas: ConsultaDaTela[];
  vagas: VagaDaTela[];
  decisoes: DecisaoDaTela[];
}

/** Mesma lista do `check` da 0008. App não importa app, então ela se repete aqui. */
export type FaixaDeOrcamento =
  | 'nao_informado'
  | 'ate_500'
  | 'de_500_a_1k'
  | 'de_1k_a_3k'
  | 'de_3k_a_10k'
  | 'de_10k_a_30k'
  | 'acima_30k';

export interface ItemDaCaixa {
  id: string;
  modo: 'ia' | 'humano';
  motivoHandover: string | null;
  ultimaEntradaEm: string | null;
  paciente: string;
  telefoneMascarado: string;
  temConsentimento: boolean;
  ultimaMensagem: { corpo: string | null; autor: string; em: string } | null;
}

export interface Qualificacao {
  origem: { quem: 'paciente' | 'clinica' | 'desconhecida'; em: string | null };
  conveniosDaClinica: string[];
  urgencia: { nivel: 'alta' | 'normal'; motivo: string | null };
  interesse: string | null;
  faixaDeOrcamento: FaixaDeOrcamento | null;
  observacao: string | null;
  atualizadoEm: string | null;
}

export interface FichaDaConversa {
  id: string;
  modo: 'ia' | 'humano';
  motivoHandover: string | null;
  paciente: { id: string; nome: string; telefone: string; temConsentimento: boolean };
  proximasConsultas: { id: string; inicio: string; status: string }[];
  qualificacao: Qualificacao;
}

export interface Mensagem {
  id: string;
  direction: 'entrada' | 'saida';
  author: 'paciente' | 'ia' | 'humano' | 'sistema';
  body: string | null;
  media_kind: string | null;
  created_at: string;
}

export interface DiaDaSemana {
  dataIso: string;
  ehHoje: boolean;
  consultas: ConsultaDaTela[];
  vagas: VagaDaTela[];
}

export interface Semana {
  clinica: ClinicaDaPessoa;
  fuso: string;
  agora: string;
  profissionais: ProfissionalDaTela[];
  dias: DiaDaSemana[];
}
