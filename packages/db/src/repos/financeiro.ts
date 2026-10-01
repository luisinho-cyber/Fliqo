import type { Insertable, Selectable } from 'kysely';
import type { StatusConsulta, TabelaCaixa } from '../schema';
import type { Trx } from '../withClinic';

export type Lancamento = Selectable<TabelaCaixa>;

export interface LancamentoNovo {
  tipo: 'receita' | 'despesa';
  status: 'previsto' | 'realizado' | 'cancelado';
  categoria: string;
  descricao: string;
  valorCentavos: number;
  vencimento: Date;
  consultaId?: string;
  parcela?: number;
}

function paraLinha(clinicId: string, l: LancamentoNovo): Insertable<TabelaCaixa> {
  return {
    clinic_id: clinicId,
    kind: l.tipo,
    status: l.status,
    category: l.categoria,
    description: l.descricao,
    amount_cents: l.valorCentavos,
    due_date: l.vencimento,
    appointment_id: l.consultaId ?? null,
    installment_no: l.parcela ?? null,
  };
}

/**
 * Grava os lançamentos de um atendimento de uma vez só. `lancamentosDoAtendimento`
 * de packages/core é quem calcula receita, taxa, comissão e insumo; aqui só persiste.
 */
export async function lancar(
  trx: Trx,
  clinicId: string,
  lancamentos: LancamentoNovo[],
): Promise<Lancamento[]> {
  if (lancamentos.length === 0) return [];
  return trx
    .insertInto('app.cash_entries')
    .values(lancamentos.map((l) => paraLinha(clinicId, l)))
    .returningAll()
    .execute();
}

export async function listarPorPeriodo(trx: Trx, de: Date, ate: Date): Promise<Lancamento[]> {
  return trx
    .selectFrom('app.cash_entries')
    .selectAll()
    .where('due_date', '>=', de)
    .where('due_date', '<=', ate)
    .where('status', '<>', 'cancelado')
    .orderBy('due_date')
    .execute();
}

export interface ConsultaDoCaixa {
  professional_id: string;
  profissional: string;
  procedure_id: string;
  procedimento: string;
  status: StatusConsulta;
  precoCents: number;
  precoCadastrado: boolean;
}

/**
 * As consultas do período, com o que o caixa precisa saber de cada uma.
 *
 * `precoCadastrado` olha a origem do procedimento E o snapshot da consulta:
 * `importado` com snapshot zero é preço que ninguém cadastrou, porque o cadastro vive
 * no outro sistema (0012). Cortesia de verdade tem origem `cadastro` e vale zero.
 *
 * O critério é no SNAPSHOT e não só no procedimento de propósito: se a clínica
 * cadastrar o preço depois, as consultas novas passam a contar, e as antigas continuam
 * valendo desconhecido — porque é isso que elas são. Inventar o preço de hoje para uma
 * consulta de março seria somar um número que ninguém cobrou.
 *
 * O preço somado é sempre o snapshot da consulta, nunca o preço atual do procedimento:
 * mudar a tabela não altera o passado (0001).
 */
export async function consultasDoPeriodo(
  trx: Trx,
  de: Date,
  ate: Date,
): Promise<ConsultaDoCaixa[]> {
  const linhas = await trx
    .selectFrom('app.appointments as a')
    .innerJoin('app.professionals as pr', 'pr.id', 'a.professional_id')
    .innerJoin('app.procedures as p', 'p.id', 'a.procedure_id')
    .select([
      'a.professional_id',
      'pr.name as profissional',
      'a.procedure_id',
      'p.name as procedimento',
      'a.status',
      'a.price_cents',
      'p.source as origem_do_procedimento',
    ])
    .where('a.starts_at', '>=', de)
    .where('a.starts_at', '<', ate)
    .execute();

  return linhas.map((l) => ({
    professional_id: l.professional_id,
    profissional: l.profissional,
    procedure_id: l.procedure_id,
    procedimento: l.procedimento,
    status: l.status,
    // bigint chega como string do driver; o Number é seguro porque centavos de uma
    // consulta cabem muito dentro do inteiro seguro.
    precoCents: Number(l.price_cents),
    precoCadastrado: !(l.origem_do_procedimento === 'importado' && Number(l.price_cents) === 0),
  }));
}
