/**
 * Regras da lista de espera e da confirmação. Funções puras: recebem a configuração da clínica
 * e o relógio, devolvem a decisão. Quem executa (enviar mensagem, gravar oferta) é o worker.
 */

export interface ConfigFila {
  modo: 'lote' | 'sequencial';
  tamanhoLote: number; // quantos da fila recebem a oferta ao mesmo tempo (modo lote)
  timeoutMin: number; // quanto tempo a oferta fica de pé
  antecedenciaMinimaMin: number; // não oferece vaga que começa antes disso (ninguém chega em 10 min)
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
  if (expira - agora.getTime() < 5 * MIN)
    return { ofertar: false, motivo: 'sem_tempo_para_resposta' };

  return {
    ofertar: true,
    quantos: cfg.modo === 'lote' ? cfg.tamanhoLote : 1,
    expiraEm: new Date(expira),
  };
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
  | { tipo: 'ciente_do_atraso' }
  | { tipo: 'quer_a_vaga' }
  | { tipo: 'texto_livre'; texto: string };

export const PAYLOAD_BOTOES = {
  CONFIRMAR: 'CONFIRMAR_CONSULTA',
  CANCELAR: 'CANCELAR_CONSULTA',
  REMARCAR: 'REMARCAR_CONSULTA',
  // Resposta ao aviso de atraso. Não mexe na agenda: o horário marcado continua
  // sendo o horário marcado, e é ele que vale se o atraso passar.
  CIENTE_DO_ATRASO: 'CHEGO_MAIS_TARDE',
  /**
   * Aceite da oferta de vaga. Esta string é a MESMA do botão no template
   * `oferta_de_vaga` aprovado na Meta — é ela que volta no webhook. Mudar aqui
   * sem mudar lá (e sem reaprovar o template) faz todo aceite virar texto solto
   * e cair na IA, que não tem como marcar a consulta.
   */
  QUERO_VAGA: 'QUERO_ESTE_HORARIO',
} as const;

export function interpretarResposta(msg: {
  payloadBotao?: string;
  texto?: string;
}): RespostaConfirmacao {
  switch (msg.payloadBotao) {
    case PAYLOAD_BOTOES.CONFIRMAR:
      return { tipo: 'confirmou' };
    case PAYLOAD_BOTOES.CANCELAR:
      return { tipo: 'cancelou' };
    case PAYLOAD_BOTOES.REMARCAR:
      return { tipo: 'quer_remarcar' };
    case PAYLOAD_BOTOES.CIENTE_DO_ATRASO:
      return { tipo: 'ciente_do_atraso' };
    case PAYLOAD_BOTOES.QUERO_VAGA:
      return { tipo: 'quer_a_vaga' };
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
  | { acao: 'iniciar_remarcacao'; semTaxa?: boolean }
  | { acao: 'registrar_ciencia' }
  | { acao: 'aceitar_oferta' }
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
    case 'quer_a_vaga':
      // Quem decide se a vaga é dele é o banco (claim_slot_offer), não a ordem
      // em que a mensagem chegou aqui.
      return { acao: 'aceitar_oferta' };
    case 'ciente_do_atraso':
      // Só registra que a pessoa viu. A agenda não muda: se o atraso passar, o
      // horário original volta a valer e ela precisa ser avisada disso.
      return { acao: 'registrar_ciencia' };
    case 'texto_livre':
      return { acao: 'encaminhar_para_ia' };
  }
}
