import type {
  ClienteWhatsApp,
  CofreDeTokens,
  EnvioDeDigitando,
  EnvioDeTemplate,
  EnvioDeTexto,
  MotivoDeFalha,
  ResultadoEnvio,
} from './cliente';
import { LimitadorPorNumero, RELOGIO_REAL, type Relogio } from './limite';

/** Quanto esperar antes de cada nova tentativa. Só para falha temporária. */
const ESPERAS_MS = [500, 2_000, 8_000];

/**
 * Teto de uma tentativa. Sem ele, pedido pendurado só terminava por erro do sistema
 * operacional, na casa dos minutos — segurando a ação, a transação e a volta do laço.
 * A Meta responde envio em menos de 2 s; quinze é folga, não estimativa.
 */
const TIMEOUT_MS = 15_000;

/**
 * Falhas em que a conexão nem chegou a abrir: o pedido NÃO saiu, e repetir é seguro.
 * Qualquer outra falha de rede pode ter acontecido depois de o pedido sair.
 */
const NAO_SAIU = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function codigoDaFalhaDeRede(erro: unknown): string | undefined {
  const causa: unknown = erro instanceof Error ? erro.cause : undefined;
  const codigo: unknown =
    typeof causa === 'object' && causa !== null && 'code' in causa ? causa.code : undefined;
  return typeof codigo === 'string' ? codigo : undefined;
}

export interface ConfigMeta {
  /**
   * De onde vem o token de cada número. NÃO é um token: o cliente pergunta a
   * cada envio, porque cada clínica manda com a credencial dela.
   */
  cofre: CofreDeTokens;
  versaoApi?: string;
  baseUrl?: string;
  porSegundo?: number;
  relogio?: Relogio;
  /** Teto de cada tentativa. Injetável para o teste não esperar quinze segundos. */
  timeoutMs?: number;
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
  readonly #cofre: CofreDeTokens;
  readonly #base: string;
  readonly #versao: string;
  readonly #limitador: LimitadorPorNumero;
  readonly #relogio: Relogio;
  readonly #buscar: typeof fetch;
  readonly #timeoutMs: number;

  constructor(cfg: ConfigMeta) {
    this.#cofre = cfg.cofre;
    this.#base = cfg.baseUrl ?? 'https://graph.facebook.com';
    this.#versao = cfg.versaoApi ?? 'v21.0';
    this.#relogio = cfg.relogio ?? RELOGIO_REAL;
    this.#limitador = new LimitadorPorNumero(cfg.porSegundo ?? 10, this.#relogio);
    this.#buscar = cfg.buscar ?? fetch;
    this.#timeoutMs = cfg.timeoutMs ?? TIMEOUT_MS;
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

  /**
   * Indicador de digitação. Uma tentativa só, e o erro morre aqui: a mensagem de
   * verdade vale mais do que o enfeite, e repetir gastaria limite do número.
   */
  async marcarDigitando(p: EnvioDeDigitando): Promise<void> {
    // Sem token não há enfeite, e também não há por que renovar credencial por
    // causa dele: quem precisa de token fresco é a mensagem, que vem em seguida.
    const token = await this.#cofre.doNumero(p.phoneNumberId);
    if (token === undefined) return;
    await this.#tentar(
      p.phoneNumberId,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: p.wamidRecebido,
        typing_indicator: { type: 'text' },
      },
      token,
    );
  }

  /**
   * Uma tentativa, renovando a credencial no máximo uma vez.
   *
   * A Meta recusar o token não quer dizer que a clínica está fora: quer dizer que
   * o token que temos em mão envelheceu — ela reconectou, a Meta revogou, a chave
   * foi rotacionada. Então o cofre esquece e tentamos com o token fresco. UMA vez:
   * se o fresco também for recusado, o problema é a credencial e não o cache, e
   * insistir viraria laço.
   *
   * A repetição não gasta o backoff de falha temporária nem conta como tentativa
   * dele — são coisas diferentes, e misturar as duas faria um token trocado
   * consumir o orçamento de retentativa de uma instabilidade de rede.
   */
  async #tentarComCredencialViva(phoneNumberId: string, corpo: unknown): Promise<ResultadoEnvio> {
    for (const renovando of [false, true]) {
      if (renovando) this.#cofre.esquecer(phoneNumberId);

      const token = await this.#cofre.doNumero(phoneNumberId);
      if (token === undefined) {
        // Sem token não há envio possível, e repetir não cria credencial. É
        // `recusado` de propósito: `temporario` faria a régua tentar quatro vezes
        // e depois mais três rodadas, sem nada mudar entre elas.
        // Sem token é problema de credencial também: quem trata é o mesmo
        // caminho, e repetir não cria token.
        return {
          ok: false,
          motivo: 'credencial',
          detalhe: 'sem token de envio para este número',
        };
      }

      const r = await this.#tentar(phoneNumberId, corpo, token);
      if (r.ok) return r;
      if (r.credencial !== true) return r;
      if (renovando) {
        // Já era o token fresco: o problema é a credencial, não o cache. Motivo
        // próprio, para quem chama poder marcar o número em erro uma vez em vez
        // de tratar como recusa comum e alertar por ação.
        return { ok: false, motivo: 'credencial', detalhe: r.detalhe };
      }
    }
    // Inalcançável: o laço acima sempre retorna. Fica explícito para o tipo.
    return { ok: false, motivo: 'credencial', detalhe: 'credencial recusada' };
  }

  async #postar(phoneNumberId: string, corpo: unknown): Promise<ResultadoEnvio> {
    let ultimo: { motivo: MotivoDeFalha; detalhe: string } = {
      motivo: 'temporario',
      detalhe: 'sem tentativa',
    };

    for (let tentativa = 0; tentativa <= ESPERAS_MS.length; tentativa++) {
      if (tentativa > 0) await this.#relogio.esperar(ESPERAS_MS[tentativa - 1] ?? 0);
      await this.#limitador.aguardarVez(phoneNumberId);

      const r = await this.#tentarComCredencialViva(phoneNumberId, corpo);
      if (r.ok) return r;
      // Só `temporario` repete. Recusa e credencial não melhoram com repetição, e
      // `incerto` pode já ter saído: repetir é a mensagem duplicada no celular do paciente.
      if (r.motivo !== 'temporario') return r;
      ultimo = { motivo: r.motivo, detalhe: r.detalhe };
    }

    return { ok: false, ...ultimo };
  }

  /**
   * `credencial: true` marca a recusa que pode ser só token velho. É interno: quem
   * chama traduz para `recusado` depois de já ter tentado com token fresco.
   */
  async #tentar(
    phoneNumberId: string,
    corpo: unknown,
    token: string,
  ): Promise<ResultadoEnvio & { credencial?: boolean }> {
    let resposta: Response;
    try {
      resposta = await this.#buscar(`${this.#base}/${this.#versao}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (erro) {
      const detalhe = erro instanceof Error ? erro.message : 'falha de rede';
      // Conexão que nem abriu: o pedido não saiu, repetir é seguro. O resto — conexão que
      // caiu, tempo esgotado — pode ter acontecido com a mensagem já aceita.
      const codigo = codigoDaFalhaDeRede(erro);
      return codigo !== undefined && NAO_SAIU.has(codigo)
        ? { ok: false, motivo: 'temporario', detalhe }
        : { ok: false, motivo: 'incerto', detalhe };
    }

    let dados: RespostaMeta;
    try {
      dados = (await resposta.json()) as RespostaMeta;
    } catch {
      // A Meta respondeu; o corpo é que não deu para ler. Num 2xx, a mensagem saiu.
      if (resposta.ok) return { ok: false, motivo: 'incerto', detalhe: 'resposta 2xx ilegível' };
      dados = {};
    }

    if (resposta.ok) {
      const wamid = dados.messages?.[0]?.id;
      // 2xx é aceite. Sem wamid não dá para gravar o envio, mas repetir duplicaria.
      return wamid === undefined
        ? { ok: false, motivo: 'incerto', detalhe: 'resposta 2xx sem wamid' }
        : { ok: true, wamid };
    }

    const detalhe = dados.error?.message ?? `http ${String(resposta.status)}`;
    // 401, ou o código 190 (OAuthException) que a Meta usa para token inválido
    // ou expirado. Nos dois casos o token em mão pode simplesmente ter mudado.
    if (resposta.status === 401 || dados.error?.code === 190) {
      return { ok: false, motivo: 'recusado', detalhe, credencial: true };
    }
    const motivo: MotivoDeFalha =
      resposta.status === 429 || resposta.status >= 500 ? 'temporario' : 'recusado';
    return { ok: false, motivo, detalhe };
  }
}
