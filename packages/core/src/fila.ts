/**
 * Regras da lista de espera e da confirmação. Funções puras: recebem a configuração da clínica
 * e o relógio, devolvem a decisão. Quem executa (enviar mensagem, gravar oferta) é o worker.
 */

export interface ConfigFila {
  modo: 'lote' | 'sequencial';
  tamanhoLote: number;          // quantos da fila recebem a oferta ao mesmo tempo (modo lote)
  timeoutMin: number;           // quanto tempo a oferta fica de pé
  antecedenciaMinimaMin: number;// não oferece vaga que começa antes disso (ninguém chega em 10 min)
}

export type PlanoDeOferta =
  | { ofertar: false; motivo: 'em_cima_da_hora' | 'sem_tempo_para_resposta' }
  | { ofertar: true; quantos: number; expiraEm: Date };

const MIN = 60_000;

export function planejarOferta(cfg: ConfigFila, inicioDaVaga: Date, agora: Date): PlanoDeOferta {
  const limiteParaAceitar = inicioDaVaga.getTime() - cfg.antecedenciaMinimaMin * MIN;
  if (limiteParaAceitar <= agora.getTime()) return { ofertar: false, motivo: 'em_cima_da_hora' };

  const expira = Math.min(agora.getTime() + cfg.timeoutMin * MIN, limiteParaAceitar);
  // Menos de 5 minutos para responder não é oferta, é pegadinha.
  if (expira - agora.getTime() < 5 * MIN) return { ofertar: false, motivo: 'sem_tempo_para_resposta' };

  return { ofertar: true, quantos: cfg.modo === 'lote' ? cfg.tamanhoLote : 1, expiraEm: new Date(expira) };
}

/**
 * Resposta à confirmação. A mensagem de confirmação sai como TEMPLATE da Meta com botões,
 * então 95% das respostas chegam como payload fixo — sem IA, sem chance de interpretar errado.
 * Texto livre ("vou atrasar 10 min", "posso levar minha mãe?") vai para a IA.
 */
export type RespostaConfirmacao =
  | { tipo: 'confirmou' }
  | { tipo: 'cancelou' }
  | { tipo: 'quer_remarcar' }
  | { tipo: 'texto_livre'; texto: string };

export const PAYLOAD_BOTOES = {
  CONFIRMAR: 'CONFIRMAR_CONSULTA',
  CANCELAR: 'CANCELAR_CONSULTA',
  REMARCAR: 'REMARCAR_CONSULTA',
} as const;

export function interpretarResposta(msg: { payloadBotao?: string; texto?: string }): RespostaConfirmacao {
  switch (msg.payloadBotao) {
    case PAYLOAD_BOTOES.CONFIRMAR:
      return { tipo: 'confirmou' };
    case PAYLOAD_BOTOES.CANCELAR:
      return { tipo: 'cancelou' };
    case PAYLOAD_BOTOES.REMARCAR:
      return { tipo: 'quer_remarcar' };
  }
  return { tipo: 'texto_livre', texto: msg.texto ?? '' };
}

/**
 * O que fazer com a consulta depois da resposta. Regra de ouro:
 * SILÊNCIO NÃO É CANCELAMENTO. Só libera o horário quem disse que não vem (ou a recepção).
 * Tirar da agenda quem não respondeu gera paciente chegando para um horário que foi dado a outro.
 */
export type Efeito =
  | { acao: 'marcar_confirmado' }
  | { acao: 'liberar_horario_e_ofertar'; motivo: string }
  | { acao: 'iniciar_remarcacao' }
  | { acao: 'encaminhar_para_ia' };

export function efeitoDaResposta(r: RespostaConfirmacao): Efeito {
  switch (r.tipo) {
    case 'confirmou':
      return { acao: 'marcar_confirmado' };
    case 'cancelou':
      return { acao: 'liberar_horario_e_ofertar', motivo: 'paciente cancelou pela confirmação' };
    case 'quer_remarcar':
      // Libera o horário antigo só DEPOIS que o novo estiver marcado (worker faz nessa ordem).
      return { acao: 'iniciar_remarcacao' };
    case 'texto_livre':
      return { acao: 'encaminhar_para_ia' };
  }
}
