/**
 * Embedded Signup com coexistência: a clínica liga o número dela sem passar
 * senha para ninguém, e continua usando o app do WhatsApp Business no celular.
 *
 * O navegador devolve um código; o servidor troca esse código por um token da
 * clínica, assina os webhooks e registra o número. O código sozinho não serve
 * para nada — a troca exige o segredo do app, que só existe no servidor.
 */

/**
 * Campos de webhook que assinamos.
 *
 * `history` está DE FORA de propósito: assinar traria as conversas antigas da
 * clínica para o nosso banco, e essa importação não foi consentida por nenhum
 * dos pacientes. Dado de saúde é dado sensível (LGPD); trazer histórico sem
 * necessidade é risco puro, sem ganho.
 */
export const CAMPOS_DE_WEBHOOK = [
  'messages',
  // Mensagem que a clínica mandou pelo app do celular. É o que avisa a IA para
  // parar de responder aquela conversa.
  'smb_message_echoes',
  // Estado do app do celular (ex.: número saiu da coexistência).
  'smb_app_state_sync',
  'account_update',
] as const;

export interface ConfigOnboarding {
  appId: string;
  appSecret: string;
  versaoApi?: string;
  baseUrl?: string;
  buscar?: typeof fetch;
}

export type ResultadoConexao =
  | {
      ok: true;
      token: string;
      wabaId: string;
      phoneNumberId: string;
      telefoneExibicao?: string;
    }
  | { ok: false; motivo: MotivoDeConexao; detalhe: string };

export type MotivoDeConexao =
  'codigo_invalido' | 'sem_numero' | 'assinatura_falhou' | 'registro_falhou' | 'indisponivel';

interface RespostaToken {
  access_token?: string;
  error?: { message?: string };
}

interface RespostaWabas {
  data?: { id: string }[];
  error?: { message?: string };
}

interface RespostaNumeros {
  data?: { id: string; display_phone_number?: string }[];
  error?: { message?: string };
}

/**
 * Tira segredos de um texto que veio de fora antes de ele virar log ou linha de
 * banco.
 *
 * A mensagem de erro do provedor é texto que NÓS não escrevemos. Se ela ecoar a
 * requisição — e provedores ecoam — vem junto a URL com `client_secret`. Guardar
 * essa mensagem crua em `last_error` colocaria o segredo do app no banco e no
 * painel. Por isso nada que chega de fora é gravado sem passar por aqui.
 */
export function redigirSegredos(texto: string, segredos: string[]): string {
  let limpo = texto;
  for (const segredo of segredos) {
    if (segredo.length > 0) limpo = limpo.split(segredo).join('[removido]');
  }
  // Também qualquer par chave=valor que pareça segredo, mesmo que o valor não
  // esteja na lista (token de outra clínica, por exemplo). O `=` sai junto: com
  // ele, um texto redigido ainda casaria com uma busca por "client_secret=", e a
  // garantia viraria discutível.
  return limpo.replace(/\b(client_secret|access_token|code)=[^&\s"']+/gi, '$1 [removido]');
}

export class OnboardingMeta {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #base: string;
  readonly #versao: string;
  readonly #buscar: typeof fetch;

  constructor(cfg: ConfigOnboarding) {
    this.#appId = cfg.appId;
    this.#appSecret = cfg.appSecret;
    this.#base = cfg.baseUrl ?? 'https://graph.facebook.com';
    this.#versao = cfg.versaoApi ?? 'v21.0';
    this.#buscar = cfg.buscar ?? fetch;
  }

  #url(caminho: string): string {
    return `${this.#base}/${this.#versao}/${caminho}`;
  }

  /** Nada que veio da Meta vira log ou linha de banco sem passar por aqui. */
  #limpar(texto: string): string {
    return redigirSegredos(texto, [this.#appSecret]);
  }

  /**
   * Faz a chamada e devolve o corpo cru. Quem chama sabe o formato que espera da
   * Meta e o declara na leitura — aqui não dá para saber.
   */
  async #json(url: string, init?: RequestInit): Promise<{ status: number; corpo: unknown }> {
    const r = await this.#buscar(url, init);
    return { status: r.status, corpo: await r.json() };
  }

  /** Troca o código do navegador pelo token da clínica. Exige o segredo do app. */
  async trocarCodigo(
    codigo: string,
  ): Promise<{ ok: true; token: string } | { ok: false; detalhe: string }> {
    const url =
      this.#url('oauth/access_token') +
      `?client_id=${encodeURIComponent(this.#appId)}` +
      `&client_secret=${encodeURIComponent(this.#appSecret)}` +
      `&code=${encodeURIComponent(codigo)}`;

    const { corpo: cru } = await this.#json(url);
    const corpo = cru as RespostaToken;
    return corpo.access_token === undefined
      ? { ok: false, detalhe: this.#limpar(corpo.error?.message ?? 'resposta sem access_token') }
      : { ok: true, token: corpo.access_token };
  }

  /** Assina nosso app aos webhooks da conta da clínica — sem `history`. */
  async assinarWebhooks(wabaId: string, token: string): Promise<{ ok: boolean; detalhe: string }> {
    const { status, corpo: cru } = await this.#json(this.#url(`${wabaId}/subscribed_apps`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subscribed_fields: [...CAMPOS_DE_WEBHOOK] }),
    });
    const corpo = cru as { error?: { message?: string } };
    return status >= 200 && status < 300
      ? { ok: true, detalhe: 'assinado' }
      : { ok: false, detalhe: this.#limpar(corpo.error?.message ?? `http ${status}`) };
  }

  /** Registra o número para a Cloud API, mantendo a coexistência com o app. */
  async registrarNumero(
    phoneNumberId: string,
    token: string,
    pin: string,
  ): Promise<{ ok: boolean; detalhe: string }> {
    const { status, corpo: cru } = await this.#json(this.#url(`${phoneNumberId}/register`), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const corpo = cru as { error?: { message?: string } };
    return status >= 200 && status < 300
      ? { ok: true, detalhe: 'registrado' }
      : { ok: false, detalhe: this.#limpar(corpo.error?.message ?? `http ${status}`) };
  }

  async descobrirWaba(token: string): Promise<string | undefined> {
    // Token no cabeçalho, nunca na URL: URL aparece em log de proxy, em
    // mensagem de erro e em qualquer depuração de cliente HTTP.
    const { corpo: cru } = await this.#json(this.#url('me/businesses'), {
      headers: { authorization: `Bearer ${token}` },
    });
    return (cru as RespostaWabas).data?.[0]?.id;
  }

  async descobrirNumero(
    wabaId: string,
    token: string,
  ): Promise<{ id: string; telefone?: string } | undefined> {
    const { corpo: cru } = await this.#json(this.#url(`${wabaId}/phone_numbers`), {
      headers: { authorization: `Bearer ${token}` },
    });
    const primeiro = (cru as RespostaNumeros).data?.[0];
    if (!primeiro) return undefined;
    return {
      id: primeiro.id,
      ...(primeiro.display_phone_number === undefined
        ? {}
        : { telefone: primeiro.display_phone_number }),
    };
  }

  /**
   * O fluxo inteiro. Devolve o token e o número, ou o motivo da falha — o
   * chamador é que decide o que gravar e o que mostrar para a clínica.
   */
  async conectar(entrada: {
    codigo: string;
    wabaId?: string;
    phoneNumberId?: string;
    pin: string;
  }): Promise<ResultadoConexao> {
    const troca = await this.trocarCodigo(entrada.codigo);
    if (!troca.ok) return { ok: false, motivo: 'codigo_invalido', detalhe: troca.detalhe };
    const token = troca.token;

    const wabaId = entrada.wabaId ?? (await this.descobrirWaba(token));
    if (wabaId === undefined) {
      return { ok: false, motivo: 'sem_numero', detalhe: 'não achei a conta da clínica' };
    }

    const numero =
      entrada.phoneNumberId === undefined
        ? await this.descobrirNumero(wabaId, token)
        : { id: entrada.phoneNumberId };
    if (numero === undefined) {
      return { ok: false, motivo: 'sem_numero', detalhe: 'nenhum número na conta' };
    }

    const assinatura = await this.assinarWebhooks(wabaId, token);
    if (!assinatura.ok) {
      return { ok: false, motivo: 'assinatura_falhou', detalhe: assinatura.detalhe };
    }

    const registro = await this.registrarNumero(numero.id, token, entrada.pin);
    if (!registro.ok) {
      return { ok: false, motivo: 'registro_falhou', detalhe: registro.detalhe };
    }

    return {
      ok: true,
      token,
      wabaId,
      phoneNumberId: numero.id,
      ...('telefone' in numero ? { telefoneExibicao: numero.telefone } : {}),
    };
  }
}
