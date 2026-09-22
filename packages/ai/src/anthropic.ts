import Anthropic from '@anthropic-ai/sdk';
import type {
  BlocoEntrada,
  BlocoResposta,
  ClienteLlm,
  PedidoLlm,
  RespostaLlm,
  TurnoLlm,
} from './llm';

/**
 * Adaptador do provedor. Tudo que é específico da API mora aqui: o resto do
 * sistema fala só com ClienteLlm.
 *
 * O prompt de sistema vai marcado para cache. Ele é o pedaço grande e repetido
 * (perfil + tabela de procedimentos + FAQ) e, numa conversa de 6 mensagens, é
 * relido 6 vezes — sem cache, é ele que domina o custo por clínica.
 */

export interface ConfigLlm {
  apiKey: string;
  modelo: string;
  maxTokens?: number;
  baseURL?: string;
  /** Teto por chamada. O padrão do SDK é minutos — tempo demais para quem está
   *  esperando no WhatsApp, e tempo demais com uma transação aberta do outro lado. */
  timeoutMs?: number;
}

function paraApi(turnos: TurnoLlm[]): Anthropic.MessageParam[] {
  return turnos.map((t) => ({
    role: t.papel === 'paciente' ? ('user' as const) : ('assistant' as const),
    content: t.blocos.map(bloco),
  }));
}

function bloco(b: BlocoEntrada): Anthropic.ContentBlockParam {
  switch (b.tipo) {
    case 'texto':
      return { type: 'text', text: b.texto };
    case 'chamada':
      return { type: 'tool_use', id: b.id, name: b.nome, input: b.entrada as object };
    case 'resultado':
      return {
        type: 'tool_result',
        tool_use_id: b.id,
        content: b.conteudo,
        ...(b.erro === true ? { is_error: true } : {}),
      };
  }
}

export class ClienteAnthropic implements ClienteLlm {
  readonly #cliente: Anthropic;
  readonly #modelo: string;
  readonly #maxTokens: number;

  constructor(cfg: ConfigLlm) {
    this.#cliente = new Anthropic({
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs ?? 30_000,
      maxRetries: 2,
      ...(cfg.baseURL === undefined ? {} : { baseURL: cfg.baseURL }),
    });
    this.#modelo = cfg.modelo;
    this.#maxTokens = cfg.maxTokens ?? 1_024;
  }

  async responder(p: PedidoLlm): Promise<RespostaLlm> {
    const r = await this.#cliente.messages.create({
      model: this.#modelo,
      max_tokens: p.maxTokens ?? this.#maxTokens,
      system: [{ type: 'text', text: p.sistema, cache_control: { type: 'ephemeral' } }],
      tools: p.ferramentas.map((f) => ({
        name: f.name,
        description: f.description,
        input_schema: f.input_schema as Anthropic.Tool.InputSchema,
      })),
      messages: paraApi(p.turnos),
    });

    const blocos: BlocoResposta[] = [];
    for (const b of r.content) {
      if (b.type === 'text') blocos.push({ tipo: 'texto', texto: b.text });
      if (b.type === 'tool_use')
        blocos.push({ tipo: 'chamada', id: b.id, nome: b.name, entrada: b.input });
    }

    return {
      blocos,
      parada:
        r.stop_reason === 'tool_use'
          ? 'ferramenta'
          : r.stop_reason === 'max_tokens'
            ? 'limite'
            : 'fim',
      modelo: r.model,
      uso: {
        entrada: r.usage.input_tokens,
        saida: r.usage.output_tokens,
        cacheLido: r.usage.cache_read_input_tokens ?? 0,
        cacheCriado: r.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
