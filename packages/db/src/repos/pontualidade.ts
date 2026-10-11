import { sql } from 'kysely';
import type { Trx } from '../withClinic';

/**
 * As duas views da 0002/0011 lidas para a tela.
 *
 * Vão por `sql` cru, e não pelo construtor tipado, pela mesma razão já escrita em
 * `atrasos.duracoesMedidas`: o tipo `Banco` espelha TABELAS, e é esse espelho que
 * o teste de divergência confere contra o Postgres. Uma view declarada ali entraria
 * no tipo sem ninguém verificando se ela existe.
 *
 * As duas têm `security_invoker = true`, então a RLS da transação vale: quem lê
 * dentro de `withClinic` enxerga só a clínica da transação.
 */

export interface PontualidadeMedida {
  professional_id: string;
  nome: string;
  atendimentos: number;
  noHorario: number;
  atrasoMedioMin: number;
}

/**
 * Pontualidade por profissional numa janela de dias.
 *
 * A view agrega por DIA. Somar os dias é somar contagens, o que é exato; a média
 * de atraso do período é a média dos dias PONDERADA pelo número de atendimentos —
 * um dia com uma consulta não pode pesar igual a um dia com doze. A média do dia
 * já vem arredondada da view, então o período herda no máximo meio minuto de
 * imprecisão, que é menos do que a tela mostra.
 *
 * `day` é data no fuso da clínica, calculada pela própria view. A janela chega em
 * data, não em timestamp, para não trazer meio dia de fora.
 */
export async function porProfissional(
  trx: Trx,
  deIso: string,
  ateIso: string,
): Promise<PontualidadeMedida[]> {
  const r = await sql<{
    professional_id: string;
    nome: string;
    atendimentos: number;
    no_horario: number;
    atraso_medio: string | number | null;
  }>`
    select pr.id                              as professional_id,
           pr.name                            as nome,
           coalesce(sum(pp.appointments), 0)::int as atendimentos,
           coalesce(sum(pp.on_time), 0)::int      as no_horario,
           case when coalesce(sum(pp.appointments), 0) = 0 then null
                else sum(pp.avg_delay_minutes::numeric * pp.appointments) / sum(pp.appointments)
           end                                as atraso_medio
      from app.professionals pr
      left join app.professional_punctuality pp
        on pp.professional_id = pr.id
       and pp.day >= ${deIso}::date
       and pp.day <= ${ateIso}::date
     where pr.active
     group by pr.id, pr.name
     order by pr.name
  `.execute(trx);

  return r.rows.map((l) => ({
    professional_id: l.professional_id,
    nome: l.nome,
    atendimentos: l.atendimentos,
    noHorario: l.no_horario,
    atrasoMedioMin: l.atraso_medio === null ? 0 : Math.round(Number(l.atraso_medio)),
  }));
}

export interface DuracaoDoProcedimento {
  procedure_id: string;
  nome: string;
  cadastradaMin: number;
  medianaMin: number;
  amostra: number;
  ajustadaEm: Date | null;
}

/** A medida por procedimento, que é a unidade do cadastro. */
export async function porProcedimento(trx: Trx): Promise<DuracaoDoProcedimento[]> {
  const r = await sql<{
    procedure_id: string;
    procedure_name: string;
    scheduled_minutes: number;
    median_minutes: string | number;
    sample_size: number;
    duration_updated_at: Date | null;
  }>`
    select procedure_id, procedure_name, scheduled_minutes, median_minutes, sample_size,
           duration_updated_at
      from app.procedure_real_durations_by_procedure
     order by procedure_name
  `.execute(trx);

  return r.rows.map((l) => ({
    procedure_id: l.procedure_id,
    nome: l.procedure_name,
    cadastradaMin: l.scheduled_minutes,
    medianaMin: Number(l.median_minutes),
    amostra: l.sample_size,
    ajustadaEm: l.duration_updated_at,
  }));
}

/** Uma linha só, para a rota que aplica a sugestão recalcular antes de gravar. */
export async function doProcedimento(
  trx: Trx,
  procedureId: string,
): Promise<DuracaoDoProcedimento | undefined> {
  return (await porProcedimento(trx)).find((d) => d.procedure_id === procedureId);
}
