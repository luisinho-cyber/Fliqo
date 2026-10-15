import { MINUTO_DE_ABERTURA } from './dados';

/**
 * O relógio da demonstração.
 *
 * Duas exigências que brigam entre si. A linha do agora tem de mostrar ESTE
 * minuto — um relógio congelado desenha uma linha que não é o agora de ninguém.
 * E o dia que aparece na tela tem de ser um dia de clínica: nenhuma clínica
 * atende das 2h às 9h da manhã, e um horário desses na frente de um cliente é a
 * demonstração dizendo que não entende o negócio dele.
 *
 * A saída é ancorar o DIA, não o relógio: o começo do dia é escolhido para que o
 * minuto atual caia no mesmo ponto da jornada, e o dia inteiro fique dentro do
 * expediente. Quando os dois não cabem juntos — de madrugada, ou tarde da noite
 * —, quem cede é o relógio: o dia abre num horário representativo, e a tela diz
 * que ali o agora é ilustração. Deslocar o expediente seria a outra escolha, e
 * ela é pior: o número na tela continuaria "verdadeiro" e a clínica, impossível.
 */

const MIN = 60_000;

/** O expediente da clínica fictícia. Fora daqui não existe dia para desenhar. */
export const ABERTURA_H = 8;
export const FECHAMENTO_H = 19;

/**
 * O dia representativo, para quando o relógio de quem abre está fora do
 * expediente. Às 9h o dia cabe inteiro na janela com folga dos dois lados.
 */
export const HORA_REPRESENTATIVA = 9;

export interface RelogioDoDia {
  /** Meia-noite mais o offset: a hora de parede em que a jornada começa. */
  inicioDoDia: Date;
  /** O instante que a linha do agora marca. */
  agora: Date;
  /** `false` quando o agora é o horário representativo, e não o relógio. */
  doRelogio: boolean;
}

function naHoraCheia(d: Date): Date {
  const cheia = new Date(d);
  cheia.setMinutes(0, 0, 0);
  return cheia;
}

function emHoras(d: Date, hora: number): Date {
  const alvo = new Date(d);
  alvo.setHours(hora, 0, 0, 0);
  return alvo;
}

/**
 * A última hora cheia em que a jornada ainda termina dentro do expediente.
 *
 * Sai da duração real do dia, e não de um número escrito à mão: consulta nova no
 * seed empurra o fim da jornada, e a janela acompanha sozinha.
 */
export function ultimaHoraDeInicio(duracaoDoDiaMin: number): number {
  return Math.floor(FECHAMENTO_H - duracaoDoDiaMin / 60);
}

export function relogioDoDia(momento: Date, duracaoDoDiaMin: number): RelogioDoDia {
  const candidato = naHoraCheia(new Date(momento.getTime() - MINUTO_DE_ABERTURA * MIN));
  const ultima = ultimaHoraDeInicio(duracaoDoDiaMin);

  if (candidato.getHours() >= ABERTURA_H && candidato.getHours() <= ultima) {
    return { inicioDoDia: candidato, agora: momento, doRelogio: true };
  }

  const inicioDoDia = emHoras(momento, HORA_REPRESENTATIVA);
  return {
    inicioDoDia,
    agora: new Date(inicioDoDia.getTime() + MINUTO_DE_ABERTURA * MIN),
    doRelogio: false,
  };
}

/** Converte um offset do seed em instante de parede. */
export function instanteDe(inicioDoDia: Date, minutoDoDia: number): Date {
  return new Date(inicioDoDia.getTime() + minutoDoDia * MIN);
}

export function hhmm(d: Date): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
