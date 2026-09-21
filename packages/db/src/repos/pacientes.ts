import type { Selectable } from 'kysely';
import type { TabelaPacientes } from '../schema';
import type { Trx } from '../withClinic';

export type Paciente = Selectable<TabelaPacientes>;

/** Nome de quem chegou pelo WhatsApp e ainda não se identificou. A recepção corrige depois. */
export const NOME_A_CONFIRMAR = 'a confirmar';

export async function porId(trx: Trx, id: string): Promise<Paciente | undefined> {
  return trx.selectFrom('app.patients').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function porTelefone(trx: Trx, telefoneE164: string): Promise<Paciente | undefined> {
  return trx
    .selectFrom('app.patients')
    .selectAll()
    .where('phone_e164', '=', telefoneE164)
    .executeTakeFirst();
}

/**
 * Acha o paciente pelo telefone ou cria um novo.
 *
 * Sem consentimento: quem escreveu foi ele, e responder é reativo. Mensagem ativa
 * (confirmação, lembrete, oferta) exige `whatsapp_consent_at` preenchido — quem
 * checa isso é quem envia, não este repositório.
 */
export async function acharOuCriarPorTelefone(
  trx: Trx,
  clinicId: string,
  telefoneE164: string,
  nome = NOME_A_CONFIRMAR,
): Promise<{ paciente: Paciente; novo: boolean }> {
  const existente = await porTelefone(trx, telefoneE164);
  if (existente) return { paciente: existente, novo: false };

  const paciente = await trx
    .insertInto('app.patients')
    .values({ clinic_id: clinicId, name: nome, phone_e164: telefoneE164 })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { paciente, novo: true };
}

export async function renomear(trx: Trx, id: string, nome: string): Promise<Paciente | undefined> {
  return trx
    .updateTable('app.patients')
    .set({ name: nome })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

/**
 * Registra o consentimento para mensagem ativa (LGPD). `em` é o instante da resposta
 * do paciente, ou da marcação pela recepção — não a hora em que este código rodou.
 * Não sobrescreve consentimento já dado: a data que vale é a primeira.
 */
export async function registrarConsentimento(
  trx: Trx,
  id: string,
  em: Date,
): Promise<Paciente | undefined> {
  return trx
    .updateTable('app.patients')
    .set({ whatsapp_consent_at: em })
    .where('id', '=', id)
    .where('whatsapp_consent_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
}
