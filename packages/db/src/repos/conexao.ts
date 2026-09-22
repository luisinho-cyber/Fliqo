import type { Selectable } from 'kysely';
import type { StatusWhatsapp, TabelaEventosConexao, TipoEventoConexao } from '../schema';
import type { Trx } from '../withClinic';

/**
 * Conexão do WhatsApp da clínica.
 *
 * O token cifrado mora em whatsapp_numbers, mas SÓ sai por
 * `tokenCifradoDoNumero`. O painel usa `status`, que seleciona coluna por coluna
 * e não inclui as do token — se algum dia alguém trocar por selectAll(), o teste
 * quebra.
 */

export type EventoConexao = Selectable<TabelaEventosConexao>;

/** O que o painel pode ver. Nenhum campo de token aqui, de propósito. */
export interface StatusConexao {
  id: string;
  phoneNumberId: string;
  telefoneExibicao: string | null;
  wabaId: string | null;
  status: StatusWhatsapp;
  coexistencia: boolean;
  conectadoEm: Date | null;
  ultimoErro: string | null;
}

export async function status(trx: Trx): Promise<StatusConexao | undefined> {
  const linha = await trx
    .selectFrom('app.whatsapp_numbers')
    .select([
      'id',
      'phone_number_id',
      'display_phone_e164',
      'waba_id',
      'status',
      'coexistencia',
      'connected_at',
      'last_error',
    ])
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!linha) return undefined;

  return {
    id: linha.id,
    phoneNumberId: linha.phone_number_id,
    telefoneExibicao: linha.display_phone_e164,
    wabaId: linha.waba_id,
    status: linha.status,
    coexistencia: linha.coexistencia,
    conectadoEm: linha.connected_at,
    ultimoErro: linha.last_error,
  };
}

export interface TokenGuardado {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** Único caminho por onde o token cifrado sai do banco. Para o worker enviar. */
export async function tokenCifradoDoNumero(
  trx: Trx,
  phoneNumberId: string,
): Promise<TokenGuardado | undefined> {
  const linha = await trx
    .selectFrom('app.whatsapp_numbers')
    .select(['token_ciphertext', 'token_iv', 'token_tag'])
    .where('phone_number_id', '=', phoneNumberId)
    .where('status', '=', 'conectado')
    .executeTakeFirst();

  if (!linha?.token_ciphertext || !linha.token_iv || !linha.token_tag) return undefined;
  return { ciphertext: linha.token_ciphertext, iv: linha.token_iv, tag: linha.token_tag };
}

export interface ConexaoGravada {
  phoneNumberId: string;
  wabaId: string;
  telefoneExibicao?: string;
  coexistencia: boolean;
  token: TokenGuardado;
}

/**
 * Grava (ou regrava) a conexão. Reconectar cai aqui também: o número é o mesmo,
 * o token é novo. Por isso é upsert por phone_number_id e não insert.
 */
export async function gravarConexao(
  trx: Trx,
  clinicId: string,
  c: ConexaoGravada,
): Promise<{ id: string }> {
  const agora = new Date();
  const linha = await trx
    .insertInto('app.whatsapp_numbers')
    .values({
      clinic_id: clinicId,
      phone_number_id: c.phoneNumberId,
      waba_id: c.wabaId,
      display_phone_e164: c.telefoneExibicao ?? null,
      coexistencia: c.coexistencia,
      status: 'conectado',
      active: true,
      token_ciphertext: c.token.ciphertext,
      token_iv: c.token.iv,
      token_tag: c.token.tag,
      token_updated_at: agora,
      connected_at: agora,
      last_error: null,
    })
    .onConflict((oc) =>
      oc.column('phone_number_id').doUpdateSet({
        waba_id: c.wabaId,
        display_phone_e164: c.telefoneExibicao ?? null,
        coexistencia: c.coexistencia,
        status: 'conectado',
        active: true,
        token_ciphertext: c.token.ciphertext,
        token_iv: c.token.iv,
        token_tag: c.token.tag,
        token_updated_at: agora,
        connected_at: agora,
        last_error: null,
      }),
    )
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return linha;
}

/** Marca falha sem apagar o token antigo: a clínica pode seguir enviando até reconectar. */
export async function marcarErro(trx: Trx, numeroId: string, detalhe: string): Promise<void> {
  await trx
    .updateTable('app.whatsapp_numbers')
    .set({ status: 'erro', last_error: detalhe })
    .where('id', '=', numeroId)
    .execute();
}

/**
 * O número saiu da coexistência (a clínica registrou no WhatsApp normal).
 * Apaga o token: ele não vale mais nada e não tem por que continuar guardado.
 */
export async function desconectar(trx: Trx, phoneNumberId: string, detalhe: string): Promise<void> {
  await trx
    .updateTable('app.whatsapp_numbers')
    .set({
      status: 'desconectado',
      active: false,
      last_error: detalhe,
      token_ciphertext: null,
      token_iv: null,
      token_tag: null,
      token_updated_at: null,
    })
    .where('phone_number_id', '=', phoneNumberId)
    .execute();
}

export async function registrarEvento(
  trx: Trx,
  clinicId: string,
  kind: TipoEventoConexao,
  numeroId?: string,
  detalhe?: string,
): Promise<EventoConexao> {
  return trx
    .insertInto('app.whatsapp_connection_events')
    .values({
      clinic_id: clinicId,
      whatsapp_number_id: numeroId ?? null,
      kind,
      detail: detalhe ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function eventos(trx: Trx, limite = 20): Promise<EventoConexao[]> {
  return trx
    .selectFrom('app.whatsapp_connection_events')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(limite)
    .execute();
}
