/**
 * O que o worker precisa do modelo. É uma interface, e não a classe do provedor,
 * pelo mesmo motivo de ClienteWhatsApp: o teste precisa roteirizar chamadas de
 * ferramenta, e chamar o modelo de verdade em teste seria lento, caro e diferente
 * a cada execução.
 */

export interface BlocoTexto {
  tipo: 'texto';
  texto: string;
}

export interface BlocoChamada {
  tipo: 'chamada';
  id: string;
  nome: string;
  entrada: unknown;
}

export type BlocoResposta = BlocoTexto | BlocoChamada;

export interface BlocoResultado {
  tipo: 'resultado';
  id: string;
  /** JSON do que a ferramenta devolveu, ou a mensagem de erro. */
  conteudo: string;
  erro?: boolean;
}

export type BlocoEntrada = BlocoTexto | BlocoChamada | BlocoResultado;

export interface TurnoLlm {
  papel: 'paciente' | 'assistente';
  blocos: BlocoEntrada[];
}

export interface UsoDeTokens {
  entrada: number;
  saida: number;
  cacheLido: number;
  cacheCriado: number;
}

export interface RespostaLlm {
  blocos: BlocoResposta[];
  /** 'ferramenta' = o modelo quer executar algo e espera o resultado. */
  parada: 'ferramenta' | 'fim' | 'limite';
  modelo: string;
  uso: UsoDeTokens;
}

export interface DefinicaoDeFerramenta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface PedidoLlm {
  sistema: string;
  turnos: TurnoLlm[];
  ferramentas: DefinicaoDeFerramenta[];
  maxTokens?: number;
}

export interface ClienteLlm {
  responder(p: PedidoLlm): Promise<RespostaLlm>;
}

/** O texto solto da resposta, junto, sem os blocos de chamada de ferramenta. */
export function textoDaResposta(r: RespostaLlm): string {
  return r.blocos
    .filter((b): b is BlocoTexto => b.tipo === 'texto')
    .map((b) => b.texto)
    .join('\n')
    .trim();
}

export function chamadasDaResposta(r: RespostaLlm): BlocoChamada[] {
  return r.blocos.filter((b): b is BlocoChamada => b.tipo === 'chamada');
}

export const USO_ZERO: UsoDeTokens = { entrada: 0, saida: 0, cacheLido: 0, cacheCriado: 0 };

export function somarUso(a: UsoDeTokens, b: UsoDeTokens): UsoDeTokens {
  return {
    entrada: a.entrada + b.entrada,
    saida: a.saida + b.saida,
    cacheLido: a.cacheLido + b.cacheLido,
    cacheCriado: a.cacheCriado + b.cacheCriado,
  };
}
