import type { ColumnType, Generated } from 'kysely';

/**
 * Tipos do banco, escritos à mão e verificados contra o Postgres real
 * (packages/db/tests/schema-tipos.test.ts). Gerar por ferramenta exigiria banco
 * de pé durante o build; um teste que compara tipo e schema dá a mesma garantia
 * sem tornar o build dependente de infraestrutura.
 *
 * As migrações continuam sendo a verdade. Este arquivo as descreve.
 */

/** Só o banco escreve (default/trigger); a aplicação nunca envia. */
type Automatico<T> = ColumnType<T, never, never>;
/** Valor tem default: pode ser omitido na inserção. */
type ComDefault<T> = Generated<T>;
/** Dinheiro é sempre inteiro em centavos — `bigint` chega como string no driver. */
type Centavos = ColumnType<string, number | string, number | string>;

export type StatusConsulta =
  'agendado' | 'confirmado' | 'em_risco' | 'cancelado' | 'faltou' | 'realizado';

export type TipoAcao = 'confirmacao' | 'lembrete_final' | 'marcar_risco' | 'expirar_oferta';
export type StatusAcao = 'pendente' | 'executando' | 'feito' | 'cancelado' | 'erro';
export type ModoFila = 'sequencial' | 'lote';
export type ModoConversa = 'ia' | 'humano';
export type DirecaoMensagem = 'entrada' | 'saida';
export type AutorMensagem = 'paciente' | 'ia' | 'humano' | 'sistema';
export type PapelMembro = 'dono' | 'recepcao' | 'profissional' | 'financeiro';
export type StatusOferta = 'enviada' | 'aceita' | 'recusada' | 'expirada' | 'preenchida_por_outro';
export type StatusEspera = 'aguardando' | 'atendido' | 'cancelado';

export interface TabelaClinicas {
  id: ComDefault<string>;
  name: string;
  timezone: ComDefault<string>;
  confirm_hours_before: ComDefault<number>;
  final_reminder_minutes: ComDefault<number>;
  at_risk_hours_before: ComDefault<number>;
  waitlist_mode: ComDefault<ModoFila>;
  offer_batch_size: ComDefault<number>;
  offer_timeout_minutes: ComDefault<number>;
  min_offer_lead_minutes: ComDefault<number>;
  is_demo: ComDefault<boolean>;
  created_at: Automatico<Date>;
  delay_notice_threshold_minutes: ComDefault<number>;
  delay_notice_window_hours: ComDefault<number>;
  waiting_room_alert_minutes: ComDefault<number>;
}

export interface TabelaMembros {
  clinic_id: string;
  user_id: string;
  role: PapelMembro;
}

export interface TabelaProfissionais {
  id: ComDefault<string>;
  clinic_id: string;
  name: string;
  active: ComDefault<boolean>;
}

export interface TabelaProcedimentos {
  id: ComDefault<string>;
  clinic_id: string;
  name: string;
  duration_minutes: number;
  price_cents: Centavos;
  direct_cost_cents: ComDefault<Centavos>;
  commission_bp: ComDefault<number>;
  priority_level: ComDefault<number>;
  active: ComDefault<boolean>;
}

export interface TabelaPacientes {
  id: ComDefault<string>;
  clinic_id: string;
  name: string;
  phone_e164: string;
  whatsapp_consent_at: ColumnType<Date | null, Date | null, Date | null>;
  prefers_audio: ComDefault<boolean>;
  created_at: Automatico<Date>;
}

export interface TabelaConsultas {
  id: ComDefault<string>;
  clinic_id: string;
  professional_id: string;
  patient_id: string;
  procedure_id: string;
  starts_at: Date;
  ends_at: Date;
  status: ComDefault<StatusConsulta>;
  price_cents: Centavos;
  source: ComDefault<'recepcao' | 'ia' | 'lista_espera' | 'online'>;
  confirmed_at: ColumnType<Date | null, Date | null, Date | null>;
  cancelled_at: ColumnType<Date | null, Date | null, Date | null>;
  cancel_reason: ColumnType<string | null, string | null, string | null>;
  created_at: Automatico<Date>;
  checked_in_at: ColumnType<Date | null, Date | null, Date | null>;
  started_at: ColumnType<Date | null, Date | null, Date | null>;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface TabelaAcoes {
  id: ComDefault<string>;
  clinic_id: string;
  kind: TipoAcao;
  appointment_id: string | null;
  offer_id: string | null;
  due_at: Date;
  status: ComDefault<StatusAcao>;
  attempts: ComDefault<number>;
  last_error: ColumnType<string | null, string | null, string | null>;
  created_at: Automatico<Date>;
}

export interface TabelaEspera {
  id: ComDefault<string>;
  clinic_id: string;
  patient_id: string;
  procedure_id: string;
  professional_id: string | null;
  window_start: Date;
  window_end: Date;
  priority_level: ComDefault<number>;
  status: ComDefault<StatusEspera>;
  created_at: Automatico<Date>;
}

export interface TabelaOfertas {
  id: ComDefault<string>;
  clinic_id: string;
  waitlist_entry_id: string;
  professional_id: string;
  starts_at: Date;
  ends_at: Date;
  expires_at: Date;
  status: ComDefault<StatusOferta>;
  created_at: Automatico<Date>;
}

export interface TabelaConversas {
  id: ComDefault<string>;
  clinic_id: string;
  patient_id: string;
  mode: ComDefault<ModoConversa>;
  handover_reason: ColumnType<string | null, string | null, string | null>;
  last_inbound_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface TabelaMensagens {
  id: ComDefault<string>;
  clinic_id: string;
  conversation_id: string;
  direction: DirecaoMensagem;
  author: AutorMensagem;
  wamid: string | null;
  body: string | null;
  media_kind: 'audio' | 'imagem' | 'documento' | null;
  created_at: Automatico<Date>;
}

export interface TabelaPerfisIa {
  id: ComDefault<string>;
  clinic_id: string;
  version: number;
  is_active: ComDefault<boolean>;
  profile: unknown;
  created_by: string | null;
  created_at: Automatico<Date>;
}

export interface TabelaFormasPagamento {
  id: ComDefault<string>;
  clinic_id: string;
  name: string;
  fee_bp: ComDefault<number>;
  settlement_days: ComDefault<number>;
  installments: ComDefault<number>;
}

export interface TabelaCaixa {
  id: ComDefault<string>;
  clinic_id: string;
  kind: 'receita' | 'despesa';
  status: 'previsto' | 'realizado' | 'cancelado';
  category: string;
  description: string;
  amount_cents: Centavos;
  due_date: Date;
  appointment_id: string | null;
  installment_no: number | null;
  created_at: Automatico<Date>;
}

export interface TabelaAvisosAtraso {
  id: ComDefault<string>;
  clinic_id: string;
  appointment_id: string;
  channel: 'whatsapp' | 'recepcao';
  delay_minutes: number;
  sent_at: ComDefault<Date>;
}

export type StatusWhatsapp = 'pendente' | 'conectado' | 'erro' | 'desconectado';

export interface TabelaNumerosWhatsapp {
  id: ComDefault<string>;
  clinic_id: string;
  phone_number_id: string;
  display_phone_e164: string | null;
  waba_id: string | null;
  active: ComDefault<boolean>;
  created_at: Automatico<Date>;
  status: ComDefault<StatusWhatsapp>;
  coexistencia: ComDefault<boolean>;
  // Token cifrado (AES-256-GCM). Nunca sai daqui para o painel.
  token_ciphertext: ColumnType<Buffer | null, Buffer | null, Buffer | null>;
  token_iv: ColumnType<Buffer | null, Buffer | null, Buffer | null>;
  token_tag: ColumnType<Buffer | null, Buffer | null, Buffer | null>;
  token_updated_at: ColumnType<Date | null, Date | null, Date | null>;
  connected_at: ColumnType<Date | null, Date | null, Date | null>;
  last_error: ColumnType<string | null, string | null, string | null>;
}

export type TipoEventoConexao = 'conectou' | 'reconectou' | 'falhou' | 'desconectou';

export interface TabelaEventosConexao {
  id: ComDefault<string>;
  clinic_id: string;
  whatsapp_number_id: string | null;
  kind: TipoEventoConexao;
  detail: string | null;
  created_at: Automatico<Date>;
}

export type TipoAlerta =
  | 'consulta_em_risco'
  | 'sem_consentimento'
  | 'acao_falhou'
  | 'horario_vago'
  | 'emergencia'
  | 'conversa_assumida'
  | 'atraso_profissional'
  | 'espera_longa';

export type GravidadeAlerta = 'info' | 'atencao' | 'urgente';

export interface TabelaAlertas {
  id: ComDefault<string>;
  clinic_id: string;
  kind: TipoAlerta;
  severity: GravidadeAlerta;
  title: string;
  body: string | null;
  appointment_id: string | null;
  conversation_id: string | null;
  patient_id: string | null;
  resolved_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: Automatico<Date>;
}

export interface TabelaConsumoIa {
  id: ComDefault<string>;
  clinic_id: string;
  conversation_id: string | null;
  model: string;
  input_tokens: ComDefault<number>;
  output_tokens: ComDefault<number>;
  cache_read_tokens: ComDefault<number>;
  cache_creation_tokens: ComDefault<number>;
  created_at: Automatico<Date>;
}

export interface Banco {
  'app.clinics': TabelaClinicas;
  'app.clinic_members': TabelaMembros;
  'app.professionals': TabelaProfissionais;
  'app.procedures': TabelaProcedimentos;
  'app.patients': TabelaPacientes;
  'app.appointments': TabelaConsultas;
  'app.scheduled_actions': TabelaAcoes;
  'app.waitlist_entries': TabelaEspera;
  'app.slot_offers': TabelaOfertas;
  'app.conversations': TabelaConversas;
  'app.messages': TabelaMensagens;
  'app.ai_profiles': TabelaPerfisIa;
  'app.payment_methods': TabelaFormasPagamento;
  'app.cash_entries': TabelaCaixa;
  'app.delay_notices': TabelaAvisosAtraso;
  'app.whatsapp_numbers': TabelaNumerosWhatsapp;
  'app.alerts': TabelaAlertas;
  'app.ai_usage': TabelaConsumoIa;
  'app.whatsapp_connection_events': TabelaEventosConexao;
}

/**
 * Espelho em runtime do tipo `Banco`. O tipo do mapa obriga a listar exatamente as
 * colunas de cada tabela — esquecer uma, ou inventar uma, não compila. É isso que
 * permite ao teste comparar estes tipos com o Postgres real e acusar divergência
 * quando uma migração nova mexe no schema e ninguém atualiza este arquivo.
 */
export const COLUNAS: { [T in keyof Banco]: { [C in keyof Banco[T]]: true } } = {
  'app.clinics': {
    id: true,
    name: true,
    timezone: true,
    confirm_hours_before: true,
    final_reminder_minutes: true,
    at_risk_hours_before: true,
    waitlist_mode: true,
    offer_batch_size: true,
    offer_timeout_minutes: true,
    min_offer_lead_minutes: true,
    is_demo: true,
    created_at: true,
    delay_notice_threshold_minutes: true,
    delay_notice_window_hours: true,
    waiting_room_alert_minutes: true,
  },
  'app.clinic_members': { clinic_id: true, user_id: true, role: true },
  'app.professionals': { id: true, clinic_id: true, name: true, active: true },
  'app.procedures': {
    id: true,
    clinic_id: true,
    name: true,
    duration_minutes: true,
    price_cents: true,
    direct_cost_cents: true,
    commission_bp: true,
    priority_level: true,
    active: true,
  },
  'app.patients': {
    id: true,
    clinic_id: true,
    name: true,
    phone_e164: true,
    whatsapp_consent_at: true,
    prefers_audio: true,
    created_at: true,
  },
  'app.appointments': {
    id: true,
    clinic_id: true,
    professional_id: true,
    patient_id: true,
    procedure_id: true,
    starts_at: true,
    ends_at: true,
    status: true,
    price_cents: true,
    source: true,
    confirmed_at: true,
    cancelled_at: true,
    cancel_reason: true,
    created_at: true,
    checked_in_at: true,
    started_at: true,
    finished_at: true,
  },
  'app.scheduled_actions': {
    id: true,
    clinic_id: true,
    kind: true,
    appointment_id: true,
    offer_id: true,
    due_at: true,
    status: true,
    attempts: true,
    last_error: true,
    created_at: true,
  },
  'app.waitlist_entries': {
    id: true,
    clinic_id: true,
    patient_id: true,
    procedure_id: true,
    professional_id: true,
    window_start: true,
    window_end: true,
    priority_level: true,
    status: true,
    created_at: true,
  },
  'app.slot_offers': {
    id: true,
    clinic_id: true,
    waitlist_entry_id: true,
    professional_id: true,
    starts_at: true,
    ends_at: true,
    expires_at: true,
    status: true,
    created_at: true,
  },
  'app.conversations': {
    id: true,
    clinic_id: true,
    patient_id: true,
    mode: true,
    handover_reason: true,
    last_inbound_at: true,
  },
  'app.messages': {
    id: true,
    clinic_id: true,
    conversation_id: true,
    direction: true,
    author: true,
    wamid: true,
    body: true,
    media_kind: true,
    created_at: true,
  },
  'app.ai_profiles': {
    id: true,
    clinic_id: true,
    version: true,
    is_active: true,
    profile: true,
    created_by: true,
    created_at: true,
  },
  'app.payment_methods': {
    id: true,
    clinic_id: true,
    name: true,
    fee_bp: true,
    settlement_days: true,
    installments: true,
  },
  'app.cash_entries': {
    id: true,
    clinic_id: true,
    kind: true,
    status: true,
    category: true,
    description: true,
    amount_cents: true,
    due_date: true,
    appointment_id: true,
    installment_no: true,
    created_at: true,
  },
  'app.delay_notices': {
    id: true,
    clinic_id: true,
    appointment_id: true,
    channel: true,
    delay_minutes: true,
    sent_at: true,
  },
  'app.whatsapp_numbers': {
    id: true,
    clinic_id: true,
    phone_number_id: true,
    display_phone_e164: true,
    waba_id: true,
    active: true,
    created_at: true,
    status: true,
    coexistencia: true,
    token_ciphertext: true,
    token_iv: true,
    token_tag: true,
    token_updated_at: true,
    connected_at: true,
    last_error: true,
  },
  'app.alerts': {
    id: true,
    clinic_id: true,
    kind: true,
    severity: true,
    title: true,
    body: true,
    appointment_id: true,
    conversation_id: true,
    patient_id: true,
    resolved_at: true,
    created_at: true,
  },
  'app.ai_usage': {
    id: true,
    clinic_id: true,
    conversation_id: true,
    model: true,
    input_tokens: true,
    output_tokens: true,
    cache_read_tokens: true,
    cache_creation_tokens: true,
    created_at: true,
  },
  'app.whatsapp_connection_events': {
    id: true,
    clinic_id: true,
    whatsapp_number_id: true,
    kind: true,
    detail: true,
    created_at: true,
  },
};
