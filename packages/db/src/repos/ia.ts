import type { Selectable } from 'kysely';
import type { TabelaConsumoIa, TabelaPerfisIa } from '../schema';
import type { Trx } from '../withClinic';

export type PerfilIa = Selectable<TabelaPerfisIa>;

/**
 * O perfil que está valendo. É versionado: `one_active_profile` garante no banco
 * que só existe um ativo por clínica, então voltar atrás é trocar a flag.
 */
export async function perfilAtivo(trx: Trx): Promise<PerfilIa | undefined> {
  return trx
    .selectFrom('app.ai_profiles')
    .selectAll()
    .where('is_active', '=', true)
    .executeTakeFirst();
}

export interface ConsumoNovo {
  conversaId?: string;
  modelo: string;
  entrada: number;
  saida: number;
  cacheLido: number;
  cacheCriado: number;
}

/** Custo por clínica é o gargalo do negócio: cada chamada ao modelo é registrada. */
export async function registrarConsumo(
  trx: Trx,
  clinicId: string,
  c: ConsumoNovo,
): Promise<Selectable<TabelaConsumoIa>> {
  return trx
    .insertInto('app.ai_usage')
    .values({
      clinic_id: clinicId,
      conversation_id: c.conversaId ?? null,
      model: c.modelo,
      input_tokens: c.entrada,
      output_tokens: c.saida,
      cache_read_tokens: c.cacheLido,
      cache_creation_tokens: c.cacheCriado,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
