import { MINUTO_DE_ABERTURA } from './dados';

/**
 * O relógio da demonstração.
 *
 * A linha do agora tem de mostrar ESTE minuto — o do relógio de quem está
 * olhando, andando sozinho. Um relógio congelado em 11:12 desenharia uma linha
 * que não é o agora de ninguém.
 *
 * Então o que se ancora é o dia da clínica, não o relógio: o começo do dia é
 * escolhido para que o minuto atual caia em `MINUTO_DE_ABERTURA` da jornada.
 * A demonstração abre com o mesmo dia às nove da manhã e às dez da noite, e a
 * hora que aparece em cada bloco é hora de parede de verdade.
 *
 * O começo do dia cai na hora cheia anterior: agenda de clínica é desenhada em
 * marcas de cinco minutos, e um dia que começasse 08:37 pareceria defeito.
 */
const MIN = 60_000;

export function comecoDoDia(momento: Date): Date {
  const inicio = new Date(momento.getTime() - MINUTO_DE_ABERTURA * MIN);
  inicio.setMinutes(0, 0, 0);
  return inicio;
}

/** Converte um offset do seed em instante de parede. */
export function instanteDe(inicioDoDia: Date, minutoDoDia: number): Date {
  return new Date(inicioDoDia.getTime() + minutoDoDia * MIN);
}

export function hhmm(d: Date): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
