import type {
  ClienteWhatsApp,
  EnvioDeTemplate,
  EnvioDeTexto,
  MotivoDeFalha,
  ResultadoEnvio,
} from './cliente';
import { LimitadorPorNumero, RELOGIO_REAL, type Relogio } from './limite';

/** Quanto esperar antes de cada nova tentativa. Só para falha temporária. */
const ESPERAS_MS = [500, 2_000, 8_000];

export interface ConfigMeta {
  token: string;
  versaoApi?: string;
  baseUrl?: string;
  porSegundo?: number;
  relogio?: Relogio;
  /** Injetável para teste; por padrão, o fetch do runtime. */
  buscar?: typeof fetch;
}

interface RespostaMeta {
  messages?: { id: string }[];
  error?: { message?: string; code?: number };
}

/**
 * Cliente da Meta Cloud API.
 *
 * Repete só o que vale a pena repetir: 429 e 5xx. Um 400 é template errado ou
 * número inválido — repetir gasta limite do número da clínica e não conserta nada.
 */
export class ClienteMeta implements ClienteWhatsApp {
  readonly #token: string;
  readonly #base: string;
  readonly #versao: string;
  readonly #limitador: LimitadorPorNumero;
  readonly #relogio: Relogio;
  readonly #buscar: typeof fetch;

  constructor(cfg: ConfigMeta) {
    this.#token = cfg.token;
    this.#base = cfg.baseUrl ?? 'https://graph.facebook.com';
    this.#versao = cfg.versaoApi ?? 'v21.0';
    this.#relogio = cfg.relogio ?? RELOGIO_REAL;
    this.#limitador = new LimitadorPorNumero(cfg.porSegundo ?? 10, this.#relogio);
    this.#buscar = cfg.buscar ?? fetch;
  }

  async enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio> {
    const componentes: unknown[] = [];
    if (p.variaveis && p.variaveis.length > 0) {
      componentes.push({
        type: 'body',
        parameters: p.variaveis.map((text) => ({ type: 'text', text })),
      });
    }
    (p.botoes ?? []).forEach((payload, indice) => {
      componentes.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(indice),
        parameters: [{ type: 'payload', payload }],
      });
    });

    return this.#postar(p.phoneNumberId, {
      messaging_product: 'whatsapp',
      to: p.paraE164,
      type: 'template',
      template: {
        name: p.template,
        language: { code: p.idioma ?? 'pt_BR' },
        ...(componentes.length > 0 ? { components: componentes } : {}),
      },
    });
  }

  async enviarTexto(p: EnvioDeTexto): Promise<ResultadoEnvio> {
    return this.#postar(p.phoneNumberId, {
      messaging_product: 'whatsapp',
      to: p.paraE164,
      type: 'text',
      text: { body: p.texto },
    });
  }

  async #postar(phoneNumberId: string, corpo: unknown): Promise<ResultadoEnvio> {
    let ultimo: { motivo: MotivoDeFalha; detalhe: string } = {
      motivo: 'temporario',
      detalhe: 'sem tentativa',
    };

    for (let tentativa = 0; tentativa <= ESPERAS_MS.length; tentativa++) {
      if (tentativa > 0) await this.#relogio.esperar(ESPERAS_MS[tentativa - 1] ?? 0);
      await this.#limitador.aguardarVez(phoneNumberId);

      const r = await this.#tentar(phoneNumberId, corpo);
      if (r.ok) return r;
      // Recusa definitiva não melhora com repetição.
      if (r.motivo === 'recusado') return r;
      ultimo = { motivo: r.motivo, detalhe: r.detalhe };
    }

    return { ok: false, ...ultimo };
  }

  async #tentar(phoneNumberId: string, corpo: unknown): Promise<ResultadoEnvio> {
    try {
      const resposta = await this.#buscar(
        `${this.#base}/${this.#versao}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(corpo),
        },
      );

      const dados = (await resposta.json()) as RespostaMeta;

      if (resposta.ok) {
        const wamid = dados.messages?.[0]?.id;
        return wamid === undefined
          ? { ok: false, motivo: 'temporario', detalhe: 'resposta sem wamid' }
          : { ok: true, wamid };
      }

      const detalhe = dados.error?.message ?? `http ${resposta.status}`;
      const motivo: MotivoDeFalha =
        resposta.status === 429 || resposta.status >= 500 ? 'temporario' : 'recusado';
      return { ok: false, motivo, detalhe };
    } catch (erro) {
      // Rede caiu: vale tentar de novo.
      return {
        ok: false,
        motivo: 'temporario',
        detalhe: erro instanceof Error ? erro.message : 'falha de rede',
      };
    }
  }
}
