import type { Selectable } from 'kysely';
import type { GravidadeAlerta, TabelaAlertas, TipoAlerta } from '../schema';
import type { Trx } from '../withClinic';

export type Alerta = Selectable<TabelaAlertas>;

export interface AlertaNovo {
  tipo: TipoAlerta;
  gravidade: GravidadeAlerta;
  titulo: string;
  corpo?: string;
  consultaId?: string;
  conversaId?: string;
  pacienteId?: string;
}

/** O que a recepção precisa ver. Nunca leva conteúdo de mensagem de paciente. */
export async function criar(trx: Trx, clinicId: string, a: AlertaNovo): Promise<Alerta> {
  return trx
    .insertInto('app.alerts')
    .values({
      clinic_id: clinicId,
      kind: a.tipo,
      severity: a.gravidade,
      title: a.titulo,
      body: a.corpo ?? null,
      appointment_id: a.consultaId ?? null,
      conversation_id: a.conversaId ?? null,
      patient_id: a.pacienteId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function abertos(trx: Trx, limite = 50): Promise<Alerta[]> {
  return trx
    .selectFrom('app.alerts')
    .selectAll()
    .where('resolved_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(limite)
    .execute();
}

export async function resolver(trx: Trx, id: string): Promise<Alerta | undefined> {
  return trx
    .updateTable('app.alerts')
    .set({ resolved_at: new Date() })
    .where('id', '=', id)
    .where('resolved_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Cria o alerta só se não houver um aberto do mesmo tipo.
 *
 * Existe para o "um alerta por causa, não um por ação": quando o WhatsApp da
 * clínica cai, as trinta ações de envio daquele dia descobrem a falha uma a uma,
 * e cada uma chamaria aqui. Trinta alertas dizendo a mesma coisa é a enxurrada
 * que faz a recepção parar de ler alerta.
 */
export async function criarSeNaoHouverAberto(
  trx: Trx,
  clinicId: string,
  a: AlertaNovo,
): Promise<Alerta | undefined> {
  const aberto = await trx
    .selectFrom('app.alerts')
    .select('id')
    .where('kind', '=', a.tipo)
    .where('resolved_at', 'is', null)
    .executeTakeFirst();
  if (aberto) return undefined;
  return criar(trx, clinicId, a);
}
