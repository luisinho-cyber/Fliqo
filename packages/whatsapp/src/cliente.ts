import { PAYLOAD_BOTOES } from '@fliqo/core';

/**
 * O que o worker precisa do WhatsApp. É uma interface e não uma classe porque o
 * teste implementa a própria versão: mandar mensagem de verdade em teste é
 * inaceitável, e um cliente falso é a única forma honesta de cobrir os fluxos.
 */
export interface ClienteWhatsApp {
  enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio>;
  enviarTexto(p: EnvioDeTexto): Promise<ResultadoEnvio>;
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
  ofertaDeVaga: { nome: 'oferta_de_vaga', botoes: ['QUERO_ESTE_HORARIO'] },
} as const;
