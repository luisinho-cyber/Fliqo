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

/**
 * Templates da régua de confirmação.
 *
 * Os payloads vêm do core: se divergirem, o botão que o paciente aperta não é entendido
 * na volta. A ORDEM dos botões é parte do contrato — o envio manda o payload por índice
 * (veja `enviarTemplate` em meta.ts), então botão fora de ordem na Meta entrega o payload
 * errado ao botão certo, sem erro nenhum.
 *
 * `variaveis` é quantos `{{n}}` o corpo aprovado na Meta tem de ter. Template aprovado com
 * uma variável que o código não manda faz TODO envio falhar por número de parâmetros — o
 * mesmo sintoma do nome errado, e na mesma hora ruim. O cliente falso dos testes confere
 * esta contagem em cada envio, e docs/TEMPLATES.md é conferido contra ela.
 */
export const TEMPLATES = {
  confirmacao: {
    nome: 'confirmacao_consulta',
    variaveis: 0,
    botoes: [PAYLOAD_BOTOES.CONFIRMAR, PAYLOAD_BOTOES.REMARCAR, PAYLOAD_BOTOES.CANCELAR],
  },
  lembreteFinal: { nome: 'lembrete_final', variaveis: 0, botoes: [] as string[] },
  ofertaDeVaga: { nome: 'oferta_de_vaga', variaveis: 0, botoes: [PAYLOAD_BOTOES.QUERO_VAGA] },
  /**
   * Aviso de atraso. "Prefiro remarcar" reusa o payload de remarcação: o atraso
   * é da clínica, e o fluxo de remarcação não cobra taxa de cancelamento —
   * quem remarca não cancelou.
   */
  atraso: {
    nome: 'aviso_de_atraso',
    /** {{1}} minutos de atraso, {{2}} novo horário previsto. Nesta ordem. */
    variaveis: 2,
    botoes: [PAYLOAD_BOTOES.CIENTE_DO_ATRASO, PAYLOAD_BOTOES.REMARCAR],
  },
  /** O atraso passou: o horário marcado volta a valer. {{1}} é o horário original. */
  normalizou: { nome: 'atraso_normalizou', variaveis: 1, botoes: [] as string[] },
} as const;
