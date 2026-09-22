import { normalizarTelefoneBR } from '@fliqo/core';
import type { Selectable } from 'kysely';
import type { TabelaPacientes } from '../schema';
import type { Trx } from '../withClinic';

export type Paciente = Selectable<TabelaPacientes>;

/** Nome de quem chegou pelo WhatsApp e ainda não se identificou. A recepção corrige depois. */
export const NOME_A_CONFIRMAR = 'a confirmar';

export async function porId(trx: Trx, id: string): Promise<Paciente | undefined> {
  return trx.selectFrom('app.patients').selectAll().where('id', '=', id).executeTakeFirst();
}

/**
 * Busca sempre pelo número normalizado: o mesmo celular escrito com ou sem o
 * nono dígito, ou sem o +55, tem que achar a mesma ficha.
 */
export async function porTelefone(trx: Trx, telefone: string): Promise<Paciente | undefined> {
  const n = normalizarTelefoneBR(telefone);
  if (!n.ok) return undefined;
  return trx
    .selectFrom('app.patients')
    .selectAll()
    .where('phone_e164', '=', n.e164)
    .executeTakeFirst();
}

/**
 * Acha o paciente pelo telefone ou cria um novo.
 *
 * Sem consentimento: quem escreveu foi ele, e responder é reativo. Mensagem ativa
 * (confirmação, lembrete, oferta) exige `whatsapp_consent_at` preenchido — quem
 * checa isso é quem envia, não este repositório.
 */
export type ResultadoPaciente =
  { ok: true; paciente: Paciente; novo: boolean } | { ok: false; motivo: 'telefone_invalido' };

export async function acharOuCriarPorTelefone(
  trx: Trx,
  clinicId: string,
  telefone: string,
  nome = NOME_A_CONFIRMAR,
): Promise<ResultadoPaciente> {
  const n = normalizarTelefoneBR(telefone);
  if (!n.ok) return { ok: false, motivo: 'telefone_invalido' };

  const existente = await porTelefone(trx, n.e164);
  if (existente) return { ok: true, paciente: existente, novo: false };

  const paciente = await trx
    .insertInto('app.patients')
    .values({ clinic_id: clinicId, name: nome, phone_e164: n.e164 })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { ok: true, paciente, novo: true };
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
