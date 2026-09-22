import { sql } from 'kysely';
import type { Db } from '../conexao';
import type { Trx } from '../withClinic';

/**
 * Traduz o phone_number_id do webhook para a clínica.
 *
 * Roda FORA de withClinic, de propósito: é a única coisa que acontece antes de
 * saber qual é a clínica. Por isso recebe a conexão, não a transação, e usa a
 * função security definer — a RLS ainda não tem tenant para filtrar.
 *
 * Devolve undefined para número desconhecido ou desativado. Quem chamou responde
 * 200 mesmo assim: reclamar com a Meta faz ela reenviar o mesmo evento para sempre.
 */
export async function clinicaDoNumero(db: Db, phoneNumberId: string): Promise<string | undefined> {
  const r = await sql<{ clinic_id: string | null }>`
    select app.clinic_by_phone_number_id(${phoneNumberId}) as clinic_id
  `.execute(db);
  return r.rows[0]?.clinic_id ?? undefined;
}

/**
 * O número de onde a clínica manda mensagem. Ao contrário de clinicaDoNumero,
 * este roda dentro de withClinic: a RLS já sabe de quem é a linha.
 */
export async function ativoDaClinica(trx: Trx): Promise<string | undefined> {
  const linha = await trx
    .selectFrom('app.whatsapp_numbers')
    .select(['phone_number_id'])
    .where('active', '=', true)
    .executeTakeFirst();
  return linha?.phone_number_id;
}
