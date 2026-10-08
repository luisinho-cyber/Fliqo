import { sql } from 'kysely';
import { ehViolacaoDeUnicidade } from '../erros';
import { sobSavepoint, type Trx } from '../withClinic';

/**
 * A trava de envio (0017): a mesma mensagem não sai duas vezes para a mesma consulta.
 *
 * A ordem é a de `no_double_booking` — reserva primeiro, o banco decide:
 * `reservar` ANTES de chamar a Meta, `concluir` com o wamid depois do 200, `desfazer`
 * quando o envio falhou. Tudo na transação da ação; o gatilho da 0017 recusa o commit
 * de reserva que não foi concluída nem desfeita.
 */

export interface PedidoDeReserva {
  clinicId: string;
  appointmentId: string;
  /** O horário da consulta agora. Faz parte da chave: horário novo, mensagem nova. */
  inicioDaConsulta: Date;
  template: string;
  acaoId: string;
}

export type Reserva = { ok: true; id: string } | { ok: false; motivo: 'ja_saiu' };

/**
 * Reserva o envio. `ja_saiu` quando a mesma mensagem para a mesma consulta já foi
 * enviada — ou está sendo, por outro worker: aí o insert ESPERA o outro terminar e só
 * então responde, que é o que impede os dois de chamar a Meta ao mesmo tempo.
 *
 * Sob savepoint porque o 23505 abortaria a transação da ação inteira, e a ação ainda
 * precisa ser marcada como feita.
 */
export async function reservar(trx: Trx, p: PedidoDeReserva): Promise<Reserva> {
  const linha = await sobSavepoint(
    trx,
    'reserva_de_envio',
    () =>
      trx
        .insertInto('app.envios')
        .values({
          clinic_id: p.clinicId,
          appointment_id: p.appointmentId,
          appointment_starts_at: p.inicioDaConsulta,
          template_name: p.template,
          action_id: p.acaoId,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    ehViolacaoDeUnicidade,
  );
  return linha === undefined ? { ok: false, motivo: 'ja_saiu' } : { ok: true, id: linha.id };
}

/** O envio saiu: wamid e momento na linha reservada. */
export async function concluir(trx: Trx, id: string, wamid: string): Promise<void> {
  await trx
    .updateTable('app.envios')
    .set({ wamid, enviado_em: sql<Date>`now()` })
    .where('id', '=', id)
    .execute();
}

/** O envio não saiu: a reserva some, e a próxima tentativa pode enviar. */
export async function desfazer(trx: Trx, id: string): Promise<void> {
  await trx.deleteFrom('app.envios').where('id', '=', id).execute();
}
