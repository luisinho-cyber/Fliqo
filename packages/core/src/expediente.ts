import type { Intervalo } from './agenda';

/**
 * Expediente da clínica: de "seg a sex, 8h às 19h" para intervalos de verdade.
 *
 * Existe porque `horariosLivres` precisa de datas, e a clínica pensa em dias da
 * semana. A conversão passa pelo fuso da clínica: o servidor roda em UTC, e uma
 * conta feita com o fuso do servidor ofereceria 6h da manhã para o paciente.
 */

export interface FaixaDeExpediente {
  /** 0 = domingo … 6 = sábado, como Date#getDay. */
  diaDaSemana: number;
  /** HH:MM na hora local da clínica. */
  de: string;
  ate: string;
}

const MIN = 60_000;

/** Minutos que o fuso está à frente do UTC no instante dado. */
function deslocamentoMin(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instante);

  const pegar = (tipo: string): number => Number(partes.find((p) => p.type === tipo)?.value ?? '0');
  // A hora 24 aparece em alguns runtimes onde deveria ser 0.
  const hora = pegar('hour') % 24;
  const comoSeFosseUtc = Date.UTC(
    pegar('year'),
    pegar('month') - 1,
    pegar('day'),
    hora,
    pegar('minute'),
    pegar('second'),
  );
  return (comoSeFosseUtc - instante.getTime()) / MIN;
}

/**
 * O instante em que o relógio da clínica marca `hhmm` naquele dia.
 * Duas passadas porque o deslocamento depende do próprio instante — é o jeito de
 * acertar também o dia em que o fuso muda.
 */
export function noFuso(dataIso: string, hhmm: string, fuso: string): Date {
  const [ano, mes, dia] = dataIso.split('-').map(Number) as [number, number, number];
  const [hora, minuto] = hhmm.split(':').map(Number) as [number, number];
  const palpite = Date.UTC(ano, mes - 1, dia, hora, minuto);
  const primeiro = palpite - deslocamentoMin(new Date(palpite), fuso) * MIN;
  const segundo = palpite - deslocamentoMin(new Date(primeiro), fuso) * MIN;
  return new Date(segundo);
}

/** O dia da semana no fuso da clínica, não no do servidor. */
function diaDaSemanaNoFuso(dataIso: string, fuso: string): number {
  const meioDia = noFuso(dataIso, '12:00', fuso);
  const nome = new Intl.DateTimeFormat('en-US', { timeZone: fuso, weekday: 'short' }).format(
    meioDia,
  );
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nome);
}

export function somarDias(dataIso: string, dias: number): string {
  const d = new Date(`${dataIso}T12:00:00Z`); // meio-dia UTC: imune a mudança de fuso
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Os blocos de expediente de `dias` dias a partir de `dataIso` (AAAA-MM-DD na
 * hora da clínica). Faixa com `ate` menor ou igual a `de` é ignorada: horário que
 * vira o dia não existe em clínica e viraria um bloco negativo.
 */
export function expedienteEmIntervalos(
  faixas: FaixaDeExpediente[],
  dataIso: string,
  dias: number,
  fuso: string,
): Intervalo[] {
  const out: Intervalo[] = [];
  for (let i = 0; i < dias; i++) {
    const dia = somarDias(dataIso, i);
    const semana = diaDaSemanaNoFuso(dia, fuso);
    for (const f of faixas.filter((x) => x.diaDaSemana === semana)) {
      if (f.ate <= f.de) continue;
      out.push({ inicio: noFuso(dia, f.de, fuso), fim: noFuso(dia, f.ate, fuso) });
    }
  }
  return out.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}
