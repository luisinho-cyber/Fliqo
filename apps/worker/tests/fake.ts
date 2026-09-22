import type { BlocoResposta, ClienteLlm, PedidoLlm, RespostaLlm } from '@fliqo/ai';
import type {
  ClienteWhatsApp,
  EnvioDeDigitando,
  EnvioDeTemplate,
  EnvioDeTexto,
  ResultadoEnvio,
} from '@fliqo/whatsapp';

/**
 * Cliente falso. Guarda o que "enviou" para o teste conferir, e permite roteirizar
 * falhas — mandar mensagem de verdade em teste é inaceitável.
 */
export class WhatsappFalso implements ClienteWhatsApp {
  readonly enviados: EnvioDeTemplate[] = [];
  readonly textos: EnvioDeTexto[] = [];
  readonly digitando: EnvioDeDigitando[] = [];
  /** Respostas roteirizadas, consumidas em ordem. Vazio = sucesso. */
  readonly roteiro: ResultadoEnvio[] = [];
  #n = 0;

  falharComTemporario(vezes: number): void {
    for (let i = 0; i < vezes; i++) {
      this.roteiro.push({ ok: false, motivo: 'temporario', detalhe: 'instabilidade simulada' });
    }
  }

  falharComRecusa(): void {
    this.roteiro.push({ ok: false, motivo: 'recusado', detalhe: 'template inexistente' });
  }

  enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio> {
    const roteirizado = this.roteiro.shift();
    if (roteirizado && !roteirizado.ok) return Promise.resolve(roteirizado);
    this.enviados.push(p);
    return Promise.resolve({ ok: true, wamid: `wamid.FALSO.${++this.#n}` });
  }

  enviarTexto(p: EnvioDeTexto): Promise<ResultadoEnvio> {
    const roteirizado = this.roteiro.shift();
    if (roteirizado && !roteirizado.ok) return Promise.resolve(roteirizado);
    this.textos.push(p);
    return Promise.resolve({ ok: true, wamid: `wamid.FALSO.${++this.#n}` });
  }

  marcarDigitando(p: EnvioDeDigitando): Promise<void> {
    this.digitando.push(p);
    return Promise.resolve();
  }
}

/**
 * Modelo falso, com as respostas escritas à mão. Não existe outro jeito honesto
 * de testar o laço de ferramentas: o modelo de verdade é lento, custa dinheiro e
 * responde diferente a cada execução — um teste assim não prova nada.
 */
export class LlmFalso implements ClienteLlm {
  /** Respostas na ordem em que serão devolvidas. */
  readonly roteiro: RespostaLlm[] = [];
  readonly pedidos: PedidoLlm[] = [];

  responde(...blocos: BlocoResposta[]): this {
    const temChamada = blocos.some((b) => b.tipo === 'chamada');
    this.roteiro.push({
      blocos,
      parada: temChamada ? 'ferramenta' : 'fim',
      modelo: 'modelo-de-teste',
      uso: { entrada: 100, saida: 20, cacheLido: 0, cacheCriado: 0 },
    });
    return this;
  }

  diz(texto: string): this {
    return this.responde({ tipo: 'texto', texto });
  }

  chama(nome: string, entrada: unknown, id = `tool_${String(this.roteiro.length + 1)}`): this {
    return this.responde({ tipo: 'chamada', id, nome, entrada });
  }

  /** O que a ferramenta devolveu na volta N do laço, já desserializado. */
  resultadoDaVolta(volta: number): unknown {
    const pedido = this.pedidos[volta];
    const ultimo = pedido?.turnos.at(-1);
    const bloco = ultimo?.blocos.find((b) => b.tipo === 'resultado');
    return bloco?.tipo === 'resultado' ? JSON.parse(bloco.conteudo) : undefined;
  }

  responder(p: PedidoLlm): Promise<RespostaLlm> {
    this.pedidos.push(structuredClone(p));
    const r = this.roteiro.shift();
    if (!r) throw new Error('o roteiro do modelo falso acabou antes do teste');
    return Promise.resolve(r);
  }
}
