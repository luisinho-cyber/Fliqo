import type { BlocoResposta, ClienteLlm, PedidoLlm, RespostaLlm } from '@fliqo/ai';
import {
  TEMPLATES,
  type ClienteWhatsApp,
  type EnvioDeDigitando,
  type EnvioDeTemplate,
  type EnvioDeTexto,
  type ResultadoEnvio,
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

  /**
   * Além de guardar o envio, CONFERE o contrato do template.
   *
   * Fica aqui, e não num teste próprio, porque assim todo teste do worker que manda
   * mensagem cobra a contagem de graça, em cada envio, inclusive os que ainda não
   * existem. Variável a mais ou a menos do que o template aprovado tem faz a Meta recusar
   * o envio inteiro — e esse erro só apareceria com a clínica esperando.
   */
  enviarTemplate(p: EnvioDeTemplate): Promise<ResultadoEnvio> {
    conferirContrato(p);
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

/** Todo template declarado, por nome, para o cliente falso achar o contrato de cada envio. */
interface ContratoDoTemplate {
  nome: string;
  variaveis: number;
  botoes: readonly string[];
}

// A chave é `string` e não a união dos nomes: o que chega em `enviarTemplate` é string, e
// é justamente o nome DESCONHECIDO que esta tabela precisa poder não achar.
const PORTIPO = new Map<string, ContratoDoTemplate>(
  Object.values(TEMPLATES).map((t) => [t.nome, t]),
);

function conferirContrato(p: EnvioDeTemplate): void {
  const declarado = PORTIPO.get(p.template);
  if (declarado === undefined) {
    throw new Error(
      `envio para o template "${p.template}", que não está em TEMPLATES. ` +
        'Nome de template só existe lá, e é por nome que a Meta encontra.',
    );
  }

  const quantas = p.variaveis?.length ?? 0;
  if (quantas !== declarado.variaveis) {
    throw new Error(
      `o template "${p.template}" manda ${String(quantas)} variável(is) e o contrato ` +
        `declara ${String(declarado.variaveis)}. O corpo aprovado na Meta tem ` +
        `${String(declarado.variaveis)} {{n}}: número diferente faz a Meta recusar o envio. ` +
        'Se a mudança é intencional, mude TEMPLATES e docs/TEMPLATES.md juntos.',
    );
  }

  const botoes = p.botoes ?? [];
  if (botoes.join('|') !== declarado.botoes.join('|')) {
    throw new Error(
      `os botões do template "${p.template}" saíram em ordem diferente da declarada. ` +
        'O payload vai por ÍNDICE: fora de ordem, o paciente toca num botão e o sistema ' +
        'entende outro, sem erro nenhum.',
    );
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
