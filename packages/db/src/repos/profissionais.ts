import type { Selectable } from 'kysely';
import type { TabelaProfissionais } from '../schema';
import type { Trx } from '../withClinic';

export type Profissional = Selectable<TabelaProfissionais>;

export async function listarAtivos(trx: Trx): Promise<Profissional[]> {
  return trx
    .selectFrom('app.professionals')
    .selectAll()
    .where('active', '=', true)
    .orderBy('name')
    .execute();
}

/**
 * Um profissional pelo id, dentro da clínica da transação.
 *
 * `listarAtivos` não serve para isto: o nome é pedido para montar a mensagem de uma consulta
 * que já existe, e consulta antiga pode apontar para profissional inativo — filtrar por
 * `active` faria a confirmação sair sem o nome de quem vai atender.
 */
export async function porId(trx: Trx, id: string): Promise<Profissional | undefined> {
  return trx.selectFrom('app.professionals').selectAll().where('id', '=', id).executeTakeFirst();
}
