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
