import type { Selectable } from 'kysely';
import { ehConflitoDeHorario } from '../erros';
import type { StatusConsulta, TabelaConsultas } from '../schema';
import { sobSavepoint, type Trx } from '../withClinic';

export type Consulta = Selectable<TabelaConsultas>;

/** Status em que a consulta ainda ocupa o horário do profissional. */
const OCUPAM_HORARIO: StatusConsulta[] = ['agendado', 'confirmado', 'em_risco', 'realizado'];

export type ResultadoMarcacao =
  | { ok: true; consulta: Consulta }
  | {
      ok: false;
      motivo: 'horario_ocupado' | 'procedimento_nao_encontrado' | 'consulta_nao_encontrada';
    };

export interface PedidoDeMarcacao {
  profissionalId: string;
  pacienteId: string;
  procedimentoId: string;
  inicio: Date;
  origem?: 'recepcao' | 'ia' | 'lista_espera' | 'online';
}

function fim(inicio: Date, duracaoMin: number): Date {
  return new Date(inicio.getTime() + duracaoMin * 60_000);
}

export async function porId(trx: Trx, id: string): Promise<Consulta | undefined> {
  return trx.selectFrom('app.appointments').selectAll().where('id', '=', id).executeTakeFirst();
}

/**
 * Marca uma consulta. O preço e a duração são fotografados do procedimento agora:
 * mudar a tabela depois não altera o que já foi combinado com o paciente.
 *
 * Não checa se o horário está livre antes de inserir — entre a checagem e o INSERT
 * outra pessoa marca. Quem decide é a constraint no_double_booking (CLAUDE.md, regra 3).
 */
export async function criar(trx: Trx, pedido: PedidoDeMarcacao): Promise<ResultadoMarcacao> {
  const proc = await trx
    .selectFrom('app.procedures')
    .select(['id', 'duration_minutes', 'price_cents', 'clinic_id'])
    .where('id', '=', pedido.procedimentoId)
    .executeTakeFirst();
  if (!proc) return { ok: false, motivo: 'procedimento_nao_encontrado' };

  const consulta = await sobSavepoint(
    trx,
    'marcar',
    () =>
      trx
        .insertInto('app.appointments')
        .values({
          clinic_id: proc.clinic_id,
          professional_id: pedido.profissionalId,
          patient_id: pedido.pacienteId,
          procedure_id: proc.id,
          starts_at: pedido.inicio,
          ends_at: fim(pedido.inicio, proc.duration_minutes),
          price_cents: proc.price_cents,
          source: pedido.origem ?? 'recepcao',
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    ehConflitoDeHorario,
  );

  return consulta ? { ok: true, consulta } : { ok: false, motivo: 'horario_ocupado' };
}

export async function cancelar(
  trx: Trx,
  consultaId: string,
  motivo: string,
): Promise<Consulta | undefined> {
  return trx
    .updateTable('app.appointments')
    .set({ status: 'cancelado', cancelled_at: new Date(), cancel_reason: motivo })
    .where('id', '=', consultaId)
    .returningAll()
    .executeTakeFirst();
}

export async function confirmar(trx: Trx, consultaId: string): Promise<Consulta | undefined> {
  return trx
    .updateTable('app.appointments')
    .set({ status: 'confirmado', confirmed_at: new Date() })
    .where('id', '=', consultaId)
    .where('status', 'in', ['agendado', 'em_risco'])
    .returningAll()
    .executeTakeFirst();
}

/**
 * Remarca: cancela a antiga e cria a nova NA MESMA transação, nessa ordem.
 *
 * A ordem importa duas vezes. Cancelar primeiro tira a consulta antiga da
 * constraint, senão ela própria bloquearia um horário que apenas se desloca.
 * E as duas operações ficam sob o mesmo savepoint: se o horário novo estiver
 * ocupado, o rollback devolve a antiga ao estado original. Nunca existe o
 * estado "cancelei a antiga e não consegui marcar a nova".
 *
 * Preço e duração vêm da consulta antiga, não da tabela de procedimentos:
 * remarcar move o que já foi combinado, não refaz a negociação.
 */
export async function remarcar(
  trx: Trx,
  consultaId: string,
  novoInicio: Date,
  novoProfissionalId?: string,
): Promise<ResultadoMarcacao> {
  const antiga = await porId(trx, consultaId);
  if (!antiga) return { ok: false, motivo: 'consulta_nao_encontrada' };

  const duracaoMs = antiga.ends_at.getTime() - antiga.starts_at.getTime();

  const nova = await sobSavepoint(
    trx,
    'remarcar',
    async () => {
      await trx
        .updateTable('app.appointments')
        .set({ status: 'cancelado', cancelled_at: new Date(), cancel_reason: 'remarcada' })
        .where('id', '=', antiga.id)
        .execute();

      return trx
        .insertInto('app.appointments')
        .values({
          clinic_id: antiga.clinic_id,
          professional_id: novoProfissionalId ?? antiga.professional_id,
          patient_id: antiga.patient_id,
          procedure_id: antiga.procedure_id,
          starts_at: novoInicio,
          ends_at: new Date(novoInicio.getTime() + duracaoMs),
          price_cents: antiga.price_cents,
          source: antiga.source,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
    ehConflitoDeHorario,
  );

  return nova ? { ok: true, consulta: nova } : { ok: false, motivo: 'horario_ocupado' };
}

export async function listarPorPeriodo(
  trx: Trx,
  de: Date,
  ate: Date,
  profissionalId?: string,
): Promise<Consulta[]> {
  let q = trx
    .selectFrom('app.appointments')
    .selectAll()
    .where('starts_at', '>=', de)
    .where('starts_at', '<', ate)
    .orderBy('starts_at');
  if (profissionalId !== undefined) q = q.where('professional_id', '=', profissionalId);
  return q.execute();
}

/** Consultas que ainda ocupam a agenda do profissional — base para calcular horários livres. */
export async function ocupadosDoProfissional(
  trx: Trx,
  profissionalId: string,
  de: Date,
  ate: Date,
): Promise<{ inicio: Date; fim: Date }[]> {
  const linhas = await trx
    .selectFrom('app.appointments')
    .select(['starts_at', 'ends_at'])
    .where('professional_id', '=', profissionalId)
    .where('status', 'in', OCUPAM_HORARIO)
    .where('starts_at', '>=', de)
    .where('starts_at', '<', ate)
    .orderBy('starts_at')
    .execute();
  return linhas.map((l) => ({ inicio: l.starts_at, fim: l.ends_at }));
}
