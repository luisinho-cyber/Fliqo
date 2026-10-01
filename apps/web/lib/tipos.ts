/**
 * O contrato da tela Hoje, como a nossa API responde.
 *
 * Escrito aqui e não importado de apps/api porque app nunca importa app
 * (CLAUDE.md, regra de dependência). O que amarra os dois é o teste da API.
 */

export interface ClinicaNaTela {
  id: string;
  nome: string;
}

/** Mesma lista do `check` de clinic_members. App não importa app, então ela se repete aqui. */
export type PapelNaClinica = 'dono' | 'recepcao' | 'profissional' | 'financeiro';

export interface ClinicaDaPessoa extends ClinicaNaTela {
  /** Papel na clínica. Serve para não oferecer o que a API vai negar com 403. */
  papel: PapelNaClinica;
  /** Modo convidado: a agenda vive em outro sistema e a Fliqo opera sobre ela. */
  modoConvidado: boolean;
}

/** O mapeamento de colunas que a clínica escolhe na tela de importação. */
export interface MapaDeColunas {
  paciente: number;
  telefone: number;
  profissional: number;
  inicio: number;
  procedimento: number;
}

export interface RecusaNaTela {
  linha: number;
  motivo: string;
  rotulo: string;
}

export interface RelatorioDaImportacao {
  id: string;
  arquivo: string;
  em: string;
  total: number;
  entraram: number;
  repetidas: number;
  recusadas: number;
  recusas: RecusaNaTela[];
}

export type SaidaDaImportacao =
  | { ok: true; relatorio: RelatorioDaImportacao }
  | { ok: false; motivo: 'planilha_sem_linhas' | 'planilha_grande_demais'; maximo: number };

export interface Importacoes {
  fuso: string;
  importacoes: Omit<RelatorioDaImportacao, 'recusas'>[];
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
  clinica: ClinicaNaTela;
  fuso: string;
  dataIso: string;
  agora: string;
  manchete: { quantidade: number; naAgendaCents: number; semConfirmacaoCents: number };
  profissionais: ProfissionalDaTela[];
  consultas: ConsultaDaTela[];
  vagas: VagaDaTela[];
  decisoes: DecisaoDaTela[];
  /** Vazio para quem não é dono: só ele pode aplicar o ajuste. */
  sugestoesDeDuracao: SugestaoDeDuracaoNaTela[];
}

export interface SugestaoDeDuracaoNaTela {
  procedimentoId: string;
  nome: string;
  cadastradaMin: number;
  novaDuracaoMin: number;
  medianaMin: number;
  amostra: number;
}

/**
 * A sugestão como a API a entrega. O `motivo` da recusa chega junto porque a tela
 * escreve coisas diferentes para "ainda não medimos o bastante" e "o cadastro está
 * certo" — são notícias diferentes para o dono.
 */
export type SugestaoDaApi =
  | { sugerir: false; motivo: 'amostra_pequena' | 'divergencia_pequena' }
  | {
      sugerir: true;
      cadastradaMin: number;
      novaDuracaoMin: number;
      medianaMin: number;
      amostra: number;
    };

export interface ProfissionalNaPontualidade {
  id: string;
  nome: string;
  atendimentos: number;
  noHorario: number;
  noHorarioPct: number | null;
  atrasoMedioMin: number;
}

export interface ProcedimentoNaPontualidade {
  id: string;
  nome: string;
  cadastradaMin: number;
  medianaMin: number;
  amostra: number;
  ajustadaEm: string | null;
  sugestao: SugestaoDaApi;
}

export interface Pontualidade {
  clinica: ClinicaNaTela;
  de: string;
  ate: string;
  profissionais: ProfissionalNaPontualidade[];
  procedimentos: ProcedimentoNaPontualidade[];
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
  clinica: ClinicaNaTela;
  fuso: string;
  agora: string;
  profissionais: ProfissionalDaTela[];
  dias: DiaDaSemana[];
}

/** O que /api/whatsapp/status devolve. Nenhum campo de token, por construção. */
export interface ConexaoDoWhatsapp {
  id: string;
  phoneNumberId: string;
  telefoneExibicao: string | null;
  wabaId: string | null;
  status: 'pendente' | 'conectado' | 'erro' | 'desconectado';
  coexistencia: boolean;
  conectadoEm: string | null;
  ultimoErro: string | null;
  nomeVerificado: string | null;
  nomeVerificadoEm: string | null;
  qualidade: 'verde' | 'amarelo' | 'vermelho' | 'desconhecida' | null;
  qualidadeEm: string | null;
}

export interface EventoDeConexao {
  id: string;
  kind: 'conectou' | 'reconectou' | 'falhou' | 'desconectou';
  detail: string | null;
  created_at: string;
}

export interface StatusDoWhatsapp {
  conexao: ConexaoDoWhatsapp | null;
  eventos: EventoDeConexao[];
  fuso: string;
}

// ---------------------------------------------------------------------------
// Caixa
// ---------------------------------------------------------------------------

export interface LinhaNaTela {
  id: string;
  nome: string;
  consultas: number;
  marcadoCents: number;
  esperadoCents: number;
  realizadoCents: number;
}

export interface ProcedimentoSemPreco {
  id: string;
  nome: string;
}

export interface Caixa {
  clinica: ClinicaNaTela;
  de: string;
  ate: string;
  consultas: number;
  marcadoCents: number;
  esperadoCents: number;
  realizadoCents: number;
  /** A frase vem montada do servidor: é a mesma conta das tabelas, e não pode divergir. */
  manchete: string;
  faltas: { quantidade: number; valorCents: number };
  semPreco: { consultas: number; procedimentos: ProcedimentoSemPreco[] };
  porProfissional: LinhaNaTela[];
  porProcedimento: LinhaNaTela[];
}
