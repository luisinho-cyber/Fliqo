import type { FalhaDaMeta } from './erros-meta';
import { parametrosDoCorpo, TEMPLATES_META, type ChaveDeTemplate } from './templates';

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
  | { ok: true; wamid: string }
  | { ok: false; motivo: MotivoDeFalha; falha: FalhaDaMeta; detalhe: string };

/**
 * `recusado` é definitivo (template errado, número inválido): repetir não adianta.
 * `temporario` é o que vale a pena tentar de novo (limite, instabilidade da Meta).
 */
export type MotivoDeFalha = 'recusado' | 'temporario';

/**
 * Os templates que o worker envia, na forma que o envio precisa: nome, quantas variáveis e os
 * payloads dos botões, em ordem.
 *
 * DERIVADO de `TEMPLATES_META`, não escrito à mão. Antes havia duas listas — esta e o catálogo
 * — e duas listas da mesma coisa divergem: bastava acrescentar uma variável no corpo e esquecer
 * de mudar a contagem aqui para todo envio daquele template falhar com erro 132000. Agora a
 * contagem é CONTADA do corpo e a ordem dos botões é a mesma do registro.
 *
 * As chaves são as que o worker já usa. `confirmacao` e `ofertaDeVaga` apontam para os
 * templates que estão no ar hoje; a virada para os `fliqo_*` troca o apontamento num lugar só.
 */
export const TEMPLATES = {
  confirmacao: paraEnvio('confirmacaoAtual'),
  lembreteFinal: paraEnvio('lembreteFinal'),
  ofertaDeVaga: paraEnvio('ofertaDeVagaAtual'),
  atraso: paraEnvio('avisoDeAtraso'),
  normalizou: paraEnvio('atrasoNormalizou'),
} as const;

export interface TemplateDeEnvio {
  readonly nome: string;
  /** Quantos `{{n}}` o corpo aprovado tem. Contado do corpo, nunca declarado. */
  readonly variaveis: number;
  readonly botoes: readonly string[];
}

function paraEnvio(chave: ChaveDeTemplate): TemplateDeEnvio {
  const def = TEMPLATES_META[chave];
  return {
    nome: def.nome,
    variaveis: parametrosDoCorpo(def.corpo).length,
    botoes: def.botoes.map((b) => b.payload),
  };
}
