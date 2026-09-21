import type { Insertable, Selectable } from 'kysely';
import type { TabelaCaixa } from '../schema';
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
