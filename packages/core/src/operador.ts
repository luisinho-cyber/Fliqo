/**
 * Quando o operador — o fundador — precisa ser avisado, e quando não.
 *
 * A pergunta que isto responde não é "a clínica está bem?", é "eu preciso abrir o computador
 * agora?". São coisas diferentes: uma clínica fechada que não mandou mensagem nenhuma na
 * última hora está bem, e acordar alguém por isso treina a pessoa a ignorar o aviso — que é
 * o jeito mais rápido de um sistema de alerta virar enfeite.
 *
 * Mora em core e é puro: nenhum relógio escondido, nenhuma consulta. O instante entra como
 * parâmetro, e é isso que permite testar "silêncio de três horas" sem esperar três horas.
 */

/** Minutos de WhatsApp fora antes de valer um e-mail. */
export const MINUTOS_DE_WHATSAPP_FORA = 20;

/** Horas sem nenhuma mensagem, tendo ação vencida, antes de valer um e-mail. */
export const HORAS_DE_SILENCIO = 3;

/**
 * Quantas vezes o mesmo aviso pode ser reenviado antes de parar.
 *
 * O teto existe porque alerta que se repete para sempre é alerta que vira filtro de caixa de
 * entrada. Seis, com uma hora entre eles, cobre um expediente: se depois de seis horas de
 * aviso ninguém olhou, o problema não é falta de e-mail.
 */
export const TETO_DE_REENVIOS = 6;

/** Intervalo mínimo entre dois e-mails da MESMA causa na MESMA clínica. */
export const INTERVALO_DE_REENVIO_MIN = 60;

/**
 * Horário em que o operador aceita ser avisado, no fuso DELE.
 *
 * Do operador e não da clínica: é a caixa de entrada dele que toca. Uma clínica em Manaus com
 * o WhatsApp fora às 7h da manhã vira e-mail às 8h de São Paulo — o problema não desaparece
 * por esperar, e o aviso fora de hora só ensina a ignorar.
 */
export const HORA_DE_INICIO = 8;
export const HORA_DE_FIM = 20;

/**
 * As causas, enumeradas.
 *
 * A lista é o contrato com o `check` da migração e com a tabela de reenvio: causa nova sem
 * passar por aqui não tem teto, não tem intervalo e não tem nome na coluna.
 */
export const CAUSAS_DE_OPERADOR = ['whatsapp_fora', 'silencio', 'qualidade'] as const;
export type CausaDeOperador = (typeof CAUSAS_DE_OPERADOR)[number];

/**
 * O que a função de operador devolve por clínica. Números e carimbos, nada mais.
 *
 * Nenhum campo identifica paciente: não há id de paciente, telefone nem conteúdo. O nome da
 * clínica entra porque o e-mail sem ele obriga o operador a abrir o banco para saber de quem
 * se trata, e aí o aviso deixa de ser acionável.
 */
export interface SaudeDaClinica {
  clinicId: string;
  clinicaNome: string;
  /** Desde quando há alerta `whatsapp_fora` aberto, ou `null` se não há. */
  whatsappForaDesde: Date | null;
  enviadasNaUltimaHora: number;
  /** Mensagens enviadas na janela de silêncio. */
  enviadasNaJanela: number;
  /** Ações de envio que venceram na janela de silêncio: o que DEVERIA ter saído. */
  vencidasNaJanela: number;
  /** `verde`, `amarelo`, `vermelho`, `desconhecida`, ou `null` se nunca foi medida. */
  qualidade: string | null;
}

export interface LimitesDoOperador {
  minutosDeWhatsappFora: number;
  horasDeSilencio: number;
  tetoDeReenvios: number;
  intervaloDeReenvioMin: number;
}

export const LIMITES_PADRAO: LimitesDoOperador = {
  minutosDeWhatsappFora: MINUTOS_DE_WHATSAPP_FORA,
  horasDeSilencio: HORAS_DE_SILENCIO,
  tetoDeReenvios: TETO_DE_REENVIOS,
  intervaloDeReenvioMin: INTERVALO_DE_REENVIO_MIN,
};

/**
 * As causas ativas numa clínica, neste instante.
 *
 * `silencio` exige ação VENCIDA na janela, e não só ausência de envio. Sem isso, toda clínica
 * sem consulta marcada — fim de semana, feriado, clínica nova — viraria alerta. A régua só
 * agenda ação quando existe consulta, então "tinha o que mandar e não mandou" é a única forma
 * de silêncio que significa algo.
 */
export function causasAtivas(
  saude: SaudeDaClinica,
  agora: Date,
  limites: LimitesDoOperador = LIMITES_PADRAO,
): CausaDeOperador[] {
  const causas: CausaDeOperador[] = [];

  if (saude.whatsappForaDesde !== null) {
    const minutos = (agora.getTime() - saude.whatsappForaDesde.getTime()) / 60_000;
    // Vinte minutos de carência: uma queda que se resolve sozinha em dez não precisa de
    // e-mail, e o alerta na tela da clínica já apareceu.
    if (minutos >= limites.minutosDeWhatsappFora) causas.push('whatsapp_fora');
  }

  if (saude.vencidasNaJanela > 0 && saude.enviadasNaJanela === 0) causas.push('silencio');

  // `null` é "nunca medida", que não é o mesmo que ruim — não acorda ninguém.
  if (saude.qualidade !== null && saude.qualidade !== 'verde') causas.push('qualidade');

  return causas;
}

/** O aviso que já foi mandado para uma causa, como a tabela guarda. */
export interface AvisoJaMandado {
  envios: number;
  ultimoEnvioEm: Date;
}

export type DecisaoDeEnvio =
  | { enviar: true; motivo: 'primeira_vez' | 'reenvio' }
  | { enviar: false; motivo: 'teto_atingido' | 'muito_recente' };

/**
 * Manda, reenvia, ou cala.
 *
 * O reenvio existe porque alerta de uma vez só é o buraco que a régua da clínica ainda tem: o
 * `criarSeNaoHouverAberto` abre UM alerta e, se ninguém resolver, o silêncio continua para
 * sempre sem nada aparecer de novo. Aqui a causa que persiste volta a avisar — até o teto.
 */
export function decidirEnvio(
  jaMandado: AvisoJaMandado | undefined,
  agora: Date,
  limites: LimitesDoOperador = LIMITES_PADRAO,
): DecisaoDeEnvio {
  if (jaMandado === undefined) return { enviar: true, motivo: 'primeira_vez' };
  if (jaMandado.envios >= limites.tetoDeReenvios) return { enviar: false, motivo: 'teto_atingido' };

  const minutos = (agora.getTime() - jaMandado.ultimoEnvioEm.getTime()) / 60_000;
  return minutos >= limites.intervaloDeReenvioMin
    ? { enviar: true, motivo: 'reenvio' }
    : { enviar: false, motivo: 'muito_recente' };
}

/**
 * O instante está dentro do horário em que o operador aceita e-mail?
 *
 * Sábado e domingo ficam fora: a clínica também está, e o que acontece no fim de semana
 * aparece na segunda com o mesmo tamanho. Quem quiser ser acordado no domingo muda as duas
 * constantes aqui, num lugar só.
 */
export function dentroDoHorarioDeOperacao(agora: Date, fuso: string): boolean {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(agora);

  const dia = partes.find((p) => p.type === 'weekday')?.value ?? '';
  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '-1');

  if (dia === 'Sat' || dia === 'Sun') return false;
  return hora >= HORA_DE_INICIO && hora < HORA_DE_FIM;
}

/**
 * A frase do e-mail, por causa.
 *
 * Mora em core junto da regra porque é a mesma decisão: o texto tem de dizer o que fazer, não
 * o que aconteceu. "O WhatsApp da clínica X está fora há 40 min" é acionável; "alerta aberto"
 * manda o operador adivinhar.
 */
export function frasesDoAviso(
  saude: SaudeDaClinica,
  causas: readonly CausaDeOperador[],
  agora: Date,
): string[] {
  const frases: string[] = [];
  for (const causa of causas) {
    if (causa === 'whatsapp_fora' && saude.whatsappForaDesde !== null) {
      const min = Math.floor((agora.getTime() - saude.whatsappForaDesde.getTime()) / 60_000);
      frases.push(
        `WhatsApp fora há ${String(min)} min. Nenhuma mensagem sai enquanto isso: ` +
          'a clínica precisa reconectar em Configurações › WhatsApp.',
      );
    }
    if (causa === 'silencio') {
      frases.push(
        `${String(saude.vencidasNaJanela)} ação(ões) de envio venceram nas últimas ` +
          `${String(HORAS_DE_SILENCIO)} h e nenhuma mensagem saiu.`,
      );
    }
    if (causa === 'qualidade') {
      frases.push(
        `Qualidade do número em "${saude.qualidade ?? 'desconhecida'}" segundo a Meta. ` +
          'Número em vermelho perde o direito de enviar.',
      );
    }
  }
  return frases;
}
