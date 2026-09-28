import type { Intervalo } from './agenda';
import type { Cents } from './dinheiro';

/**
 * A tela Hoje em forma de regra, não de pixel.
 *
 * Duas perguntas do DESIGN.md moram aqui porque são de negócio, não de layout:
 * quanto dinheiro está na agenda de hoje e quanto dele ainda não foi confirmado
 * (a manchete), e onde a agenda do profissional tem buraco (o horário livre
 * hachurado). A geometria da faixa — quantos por cento da largura — fica na
 * tela, que é quem sabe o tamanho dela.
 */

export type StatusDaConsulta =
  'agendado' | 'confirmado' | 'em_risco' | 'realizado' | 'cancelado' | 'faltou';

/** Status que ainda ocupam horário e ainda valem dinheiro no dia. */
const CONTAM_NO_DIA: readonly StatusDaConsulta[] = [
  'agendado',
  'confirmado',
  'em_risco',
  'realizado',
];

/** Status de quem ainda não disse que vem. */
const SEM_CONFIRMACAO: readonly StatusDaConsulta[] = ['agendado', 'em_risco'];

export interface ValorDaConsulta {
  status: StatusDaConsulta;
  precoCents: Cents;
}

export interface Manchete {
  quantidade: number;
  naAgendaCents: Cents;
  semConfirmacaoCents: Cents;
}

/**
 * "14 consultas hoje, R$ 15.450 na agenda. R$ 900 ainda sem confirmação."
 *
 * Soma de inteiros em centavos, sem divisão: o valor que aparece na frase é o
 * mesmo que está gravado nas consultas.
 */
export function mancheteDoDia(consultas: readonly ValorDaConsulta[]): Manchete {
  const valem = consultas.filter((c) => CONTAM_NO_DIA.includes(c.status));
  return {
    quantidade: valem.length,
    naAgendaCents: valem.reduce((s, c) => s + c.precoCents, 0),
    semConfirmacaoCents: valem
      .filter((c) => SEM_CONFIRMACAO.includes(c.status))
      .reduce((s, c) => s + c.precoCents, 0),
  };
}

/**
 * Os buracos entre um atendimento e o seguinte, do mesmo profissional.
 *
 * Só o que está ENTRE dois atendimentos: antes do primeiro e depois do último
 * não é buraco, é começo e fim do dia — e sem tabela de expediente não há como
 * saber onde o dia acaba. Buraco curto demais não é vaga: ninguém chega em
 * cinco minutos.
 */
export function vagasEntreAtendimentos(
  ocupados: readonly Intervalo[],
  minimoMin = 20,
): Intervalo[] {
  const ordenados = [...ocupados].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  const vagas: Intervalo[] = [];
  let fimAnterior: Date | undefined;

  for (const o of ordenados) {
    if (fimAnterior !== undefined) {
      const folgaMin = (o.inicio.getTime() - fimAnterior.getTime()) / 60_000;
      if (folgaMin >= minimoMin) vagas.push({ inicio: fimAnterior, fim: o.inicio });
    }
    if (fimAnterior === undefined || o.fim.getTime() > fimAnterior.getTime()) fimAnterior = o.fim;
  }
  return vagas;
}
