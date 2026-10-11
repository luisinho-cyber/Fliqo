import type { Selectable } from 'kysely';
import type { TabelaProcedimentos } from '../schema';
import type { Trx } from '../withClinic';

export type Procedimento = Selectable<TabelaProcedimentos>;

export async function porId(trx: Trx, id: string): Promise<Procedimento | undefined> {
  return trx.selectFrom('app.procedures').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function listarAtivos(trx: Trx): Promise<Procedimento[]> {
  return trx
    .selectFrom('app.procedures')
    .selectAll()
    .where('active', '=', true)
    .orderBy('name')
    .execute();
}

/**
 * Ajusta a duração na agenda. Só vale para os próximos agendamentos: consultas já
 * marcadas guardam a própria duração em starts_at/ends_at e não são tocadas.
 *
 * O autor é obrigatório no tipo, e não opcional com default nulo: o carimbo
 * (0011) existe para responder "quem encurtou a limpeza?", e parâmetro que pode
 * ser omitido é parâmetro que vai ser omitido. Quem ajusta é sempre uma pessoa
 * autenticada — não há ajuste automático de cadastro.
 */
export async function ajustarDuracao(
  trx: Trx,
  id: string,
  duracaoMinutos: number,
  autorUserId: string,
  em: Date,
): Promise<Procedimento | undefined> {
  return trx
    .updateTable('app.procedures')
    .set({
      duration_minutes: duracaoMinutos,
      duration_updated_by: autorUserId,
      duration_updated_at: em,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}
