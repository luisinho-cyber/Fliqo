import { PAYLOAD_BOTOES } from '@fliqo/core';

/**
 * O que o worker precisa do WhatsApp. É uma interface e não uma classe porque o
 * teste implementa a própria versão: mandar mensagem de verdade em teste é
 * inaceitável, e um cliente falso é a única forma honesta de cobrir os fluxos.
 */
export interface ClienteWhatsApp {
  enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio>;
  enviarTexto(p: EnvioDeTexto): Promise<ResultadoEnvio>;
  /**
   * Liga o "digitando…" no celular do paciente. A Meta exige o id da mensagem
   * que está sendo respondida. É enfeite: falhar aqui não pode impedir a
   * resposta de sair, então devolve void em vez de ResultadoEnvio.
   */
  marcarDigitando(p: EnvioDeDigitando): Promise<void>;
}

/**
 * De onde sai o token de envio de cada número.
 *
 * O token é POR CLÍNICA: cada clínica conecta a própria conta, e mandar mensagem
 * em nome dela exige a credencial dela. O cliente não guarda token nenhum — ele
 * pergunta, a cada envio, qual é o token daquele `phoneNumberId`.
 *
 * `esquecer` existe porque o token muda sem ninguém avisar: a clínica reconecta,
 * a Meta revoga, a chave de cifragem é rotacionada. Quando a Meta recusa a
 * credencial, o cliente manda esquecer e tenta UMA vez com token fresco — se o
 * fresco também for recusado, a falha é definitiva.
 */
export interface CofreDeTokens {
  /** Token daquele número, ou undefined quando não há token utilizável. */
  doNumero(phoneNumberId: string): Promise<string | undefined>;
  esquecer(phoneNumberId: string): void;
}

export interface EnvioDeDigitando {
  phoneNumberId: string;
  /** wamid da última mensagem do paciente. */
  wamidRecebido: string;
}

export interface EnvioDeTemplate {
  /** Número da clínica na Meta (de onde sai a mensagem). */
  phoneNumberId: string;
  paraE164: string;
  template: string;
  idioma?: string;
  /** Variáveis do corpo, na ordem em que o template as espera. */
  variaveis?: string[];
  /** Payloads dos botões de resposta rápida. Vêm de PAYLOAD_BOTOES. */
  botoes?: string[];
}

export interface EnvioDeTexto {
  phoneNumberId: string;
  paraE164: string;
  texto: string;
}

export type ResultadoEnvio =
  { ok: true; wamid: string } | { ok: false; motivo: MotivoDeFalha; detalhe: string };

/**
 * `recusado` é definitivo (template errado, número inválido): repetir não adianta.
 * `temporario` é o que vale a pena tentar de novo (limite, instabilidade da Meta).
 */
export type MotivoDeFalha = 'recusado' | 'temporario';

/** Templates da régua de confirmação. Os payloads vêm do core: se divergirem, o botão que o paciente aperta não é entendido na volta. */
export const TEMPLATES = {
  confirmacao: {
    nome: 'confirmacao_consulta',
    botoes: [PAYLOAD_BOTOES.CONFIRMAR, PAYLOAD_BOTOES.REMARCAR, PAYLOAD_BOTOES.CANCELAR],
  },
  lembreteFinal: { nome: 'lembrete_final', botoes: [] as string[] },
  ofertaDeVaga: { nome: 'oferta_de_vaga', botoes: [PAYLOAD_BOTOES.QUERO_VAGA] },
  /**
   * Aviso de atraso. "Prefiro remarcar" reusa o payload de remarcação: o atraso
   * é da clínica, e o fluxo de remarcação não cobra taxa de cancelamento —
   * quem remarca não cancelou.
   */
  atraso: {
    nome: 'aviso_de_atraso',
    botoes: [PAYLOAD_BOTOES.CIENTE_DO_ATRASO, PAYLOAD_BOTOES.REMARCAR],
  },
  /** O atraso passou: o horário marcado volta a valer. */
  normalizou: { nome: 'atraso_normalizou', botoes: [] as string[] },
} as const;
