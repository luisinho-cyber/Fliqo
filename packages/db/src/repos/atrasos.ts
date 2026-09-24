import { sql, type Selectable, type Updateable } from 'kysely';
import type { Db } from '../conexao';
import type { TabelaAvisosAtraso, TabelaConsultas } from '../schema';
import type { Trx } from '../withClinic';

export type AvisoDeAtraso = Selectable<TabelaAvisosAtraso>;

/**
 * As clínicas que a varredura precisa olhar agora.
 *
 * Roda FORA de withClinic — é a única coisa que acontece antes de saber de qual
 * clínica se trata, igual a `numeros.clinicaDoNumero`. Por isso recebe a conexão
 * e usa a função `security definer`: a RLS ainda não tem tenant para filtrar.
 * A função devolve só ids; nome, fuso e o resto ficam do outro lado da RLS.
 */
export async function clinicasParaVarrer(db: Db): Promise<string[]> {
  const r = await sql<{ clinic_id: string }>`
    select app.clinics_with_appointments_today() as clinic_id
  `.execute(db);
  return r.rows.map((l) => l.clinic_id);
}

/** Os três toques da tela Hoje. Um por vez, e só para frente. */
export async function registrarChegada(trx: Trx, consultaId: string, em: Date) {
  return marcar(trx, consultaId, { checked_in_at: em });
}

export async function registrarInicio(trx: Trx, consultaId: string, em: Date) {
  return marcar(trx, consultaId, { started_at: em });
}

/**
 * Finalizar também fecha a consulta como realizada: é o atendimento que
 * acabou, e é daí que sai a duração real do procedimento.
 */
export async function registrarFim(trx: Trx, consultaId: string, em: Date) {
  return marcar(trx, consultaId, { finished_at: em, status: 'realizado' });
}

async function marcar(trx: Trx, consultaId: string, valores: Updateable<TabelaConsultas>) {
  return trx
    .updateTable('app.appointments')
    .set(valores)
    .where('id', '=', consultaId)
    .returningAll()
    .executeTakeFirst();
}

export interface ConsultaComProcedimento {
  id: string;
  professional_id: string;
  patient_id: string;
  procedure_id: string;
  starts_at: Date;
  ends_at: Date;
  status: 'agendado' | 'confirmado' | 'em_risco' | 'cancelado' | 'faltou' | 'realizado';
  checked_in_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  duracao_agenda_min: number;
}

/** O fuso da clínica manda no que é "hoje" — uma em Manaus vira o dia depois. */
export async function fusoDaClinica(trx: Trx, clinicId: string): Promise<string> {
  const c = await trx
    .selectFrom('app.clinics')
    .select(['timezone'])
    .where('id', '=', clinicId)
    .executeTakeFirstOrThrow();
  return c.timezone;
}

export async function consultasDoDia(
  trx: Trx,
  de: Date,
  ate: Date,
): Promise<ConsultaComProcedimento[]> {
  const linhas = await trx
    .selectFrom('app.appointments as a')
    .innerJoin('app.procedures as p', 'p.id', 'a.procedure_id')
    .select([
      'a.id',
      'a.professional_id',
      'a.patient_id',
      'a.procedure_id',
      'a.starts_at',
      'a.ends_at',
      'a.status',
      'a.checked_in_at',
      'a.started_at',
      'a.finished_at',
      'p.duration_minutes as duracao_agenda_min',
    ])
    .where('a.starts_at', '>=', de)
    .where('a.starts_at', '<', ate)
    .orderBy('a.starts_at')
    .execute();
  return linhas;
}

export interface DuracaoMedida {
  professional_id: string;
  procedure_id: string;
  amostra: number;
  medianaMin: number;
}

/**
 * A view já entrega mediana e tamanho da amostra por profissional e procedimento.
 * Vai por `sql` cru porque o tipo `Banco` espelha tabelas, e é esse espelho que o
 * teste de divergência confere contra o Postgres — uma view ali entraria sem
 * ninguém verificando.
 */
export async function duracoesMedidas(trx: Trx): Promise<DuracaoMedida[]> {
  const r = await sql<{
    professional_id: string;
    procedure_id: string;
    sample_size: number;
    median_minutes: string | number;
  }>`select professional_id, procedure_id, sample_size, median_minutes
       from app.procedure_real_durations`.execute(trx);
  return r.rows.map((l) => ({
    professional_id: l.professional_id,
    procedure_id: l.procedure_id,
    amostra: l.sample_size,
    medianaMin: Number(l.median_minutes),
  }));
}

/** Último atraso comunicado a cada consulta, para não repetir por variação pequena. */
export async function ultimoAvisoPorConsulta(
  trx: Trx,
  consultaIds: string[],
): Promise<Map<string, number>> {
  if (consultaIds.length === 0) return new Map();
  const linhas = await trx
    .selectFrom('app.delay_notices')
    .select(['appointment_id', 'delay_minutes', 'sent_at'])
    .where('appointment_id', 'in', consultaIds)
    .where('channel', '=', 'whatsapp')
    .orderBy('sent_at', 'desc')
    .execute();

  const ultimo = new Map<string, number>();
  for (const l of linhas)
    if (!ultimo.has(l.appointment_id)) ultimo.set(l.appointment_id, l.delay_minutes);
  return ultimo;
}

/** Quantos avisos já foram para o paciente, por consulta. Alimenta o teto de 3. */
export async function contarAvisosPorConsulta(
  trx: Trx,
  consultaIds: string[],
): Promise<Map<string, number>> {
  if (consultaIds.length === 0) return new Map();
  const linhas = await trx
    .selectFrom('app.delay_notices')
    .select(['appointment_id', (eb) => eb.fn.countAll<string>().as('quantos')])
    .where('appointment_id', 'in', consultaIds)
    .where('channel', '=', 'whatsapp')
    .groupBy('appointment_id')
    .execute();
  return new Map(linhas.map((l) => [l.appointment_id, Number(l.quantos)]));
}

export async function registrarAviso(
  trx: Trx,
  clinicId: string,
  a: { consultaId: string; canal: 'whatsapp' | 'recepcao'; atrasoMin: number },
): Promise<AvisoDeAtraso> {
  return trx
    .insertInto('app.delay_notices')
    .values({
      clinic_id: clinicId,
      appointment_id: a.consultaId,
      channel: a.canal,
      delay_minutes: a.atrasoMin,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface ConfigDeAtrasos {
  limiarAvisoMin: number;
  janelaAvisoHoras: number;
  esperaNaSalaMin: number;
}

export async function configDeAtrasos(trx: Trx, clinicId: string): Promise<ConfigDeAtrasos> {
  const c = await trx
    .selectFrom('app.clinics')
    .select([
      'delay_notice_threshold_minutes',
      'delay_notice_window_hours',
      'waiting_room_alert_minutes',
    ])
    .where('id', '=', clinicId)
    .executeTakeFirstOrThrow();
  return {
    limiarAvisoMin: c.delay_notice_threshold_minutes,
    janelaAvisoHoras: c.delay_notice_window_hours,
    esperaNaSalaMin: c.waiting_room_alert_minutes,
  };
}
