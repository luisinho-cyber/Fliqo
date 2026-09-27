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
