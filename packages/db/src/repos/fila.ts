import { sql, type Selectable } from 'kysely';
import type { TabelaEspera, TabelaOfertas } from '../schema';
import type { Trx } from '../withClinic';

export type EntradaNaEspera = Selectable<TabelaEspera>;
export type Oferta = Selectable<TabelaOfertas>;

export interface PedidoDeEspera {
  pacienteId: string;
  procedimentoId: string;
  profissionalId?: string;
  janelaInicio: Date;
  janelaFim: Date;
  prioridade?: number;
}

export async function entrar(
  trx: Trx,
  clinicId: string,
  p: PedidoDeEspera,
): Promise<EntradaNaEspera> {
  return trx
    .insertInto('app.waitlist_entries')
    .values({
      clinic_id: clinicId,
      patient_id: p.pacienteId,
      procedure_id: p.procedimentoId,
      professional_id: p.profissionalId ?? null,
      window_start: p.janelaInicio,
      window_end: p.janelaFim,
      ...(p.prioridade === undefined ? {} : { priority_level: p.prioridade }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function sair(trx: Trx, entradaId: string): Promise<void> {
  await trx
    .updateTable('app.waitlist_entries')
    .set({ status: 'cancelado' })
    .where('id', '=', entradaId)
    .execute();
}

/**
 * Ordena a fila para uma vaga: prioridade definida pela clínica primeiro, depois
 * ordem de chegada. Quem decide a ordem é o banco (`app.rank_waitlist`) — a IA
 * não julga gravidade.
 */
export async function ranquear(
  trx: Trx,
  clinicId: string,
  profissionalId: string,
  inicio: Date,
  fim: Date,
  limite: number,
): Promise<EntradaNaEspera[]> {
  const r = await sql<EntradaNaEspera>`
    select * from app.rank_waitlist(${clinicId}, ${profissionalId}, ${inicio}, ${fim}, ${limite})
  `.execute(trx);
  return [...r.rows];
}

export async function criarOferta(
  trx: Trx,
  clinicId: string,
  entradaId: string,
  profissionalId: string,
  inicio: Date,
  fim: Date,
  expiraEm: Date,
): Promise<Oferta> {
  return trx
    .insertInto('app.slot_offers')
    .values({
      clinic_id: clinicId,
      waitlist_entry_id: entradaId,
      professional_id: profissionalId,
      starts_at: inicio,
      ends_at: fim,
      expires_at: expiraEm,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export type ResultadoDaOferta =
  { ok: true; consultaId: string } | { ok: false; motivo: 'preenchida_por_outro' };

/**
 * Aceita a oferta. `app.claim_slot_offer` serializa os "sim" simultâneos da mesma
 * vaga: o primeiro leva, os outros recebem null. Testado com dois aceites ao mesmo tempo.
 */
export async function aceitarOferta(trx: Trx, ofertaId: string): Promise<ResultadoDaOferta> {
  const r = await sql<{ claim_slot_offer: string | null }>`
    select app.claim_slot_offer(${ofertaId})
  `.execute(trx);
  const consultaId = r.rows[0]?.claim_slot_offer ?? null;
  return consultaId === null
    ? { ok: false, motivo: 'preenchida_por_outro' }
    : { ok: true, consultaId };
}

export async function expirarOferta(trx: Trx, ofertaId: string): Promise<Oferta | undefined> {
  return trx
    .updateTable('app.slot_offers')
    .set({ status: 'expirada' })
    .where('id', '=', ofertaId)
    .where('status', '=', 'enviada')
    .returningAll()
    .executeTakeFirst();
}

export async function ofertasAbertas(trx: Trx, entradaId: string): Promise<Oferta[]> {
  return trx
    .selectFrom('app.slot_offers')
    .selectAll()
    .where('waitlist_entry_id', '=', entradaId)
    .where('status', '=', 'enviada')
    .execute();
}
