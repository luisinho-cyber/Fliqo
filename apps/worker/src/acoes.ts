import { sql } from 'kysely';
import { agenda, alertas, numeros, withClinic, type Db, type Trx } from '@fliqo/db';
import { TEMPLATES, type ClienteWhatsApp } from '@fliqo/whatsapp';
import { enviarAtivo } from './envio';
import { expirarEPassarAdiante } from './ofertas';

/**
 * Executa as ações agendadas da régua de confirmação.
 *
 * `app.claim_due_actions` já entrega o lote marcado como 'executando' e com
 * attempts incrementado, e vários workers podem rodar em paralelo sem pegar a
 * mesma ação. O que falta é: executar dentro da clínica certa e decidir o que
 * fazer quando dá errado.
 */

export interface AcaoPendente {
  id: string;
  clinic_id: string;
  kind: 'confirmacao' | 'lembrete_final' | 'marcar_risco' | 'expirar_oferta';
  appointment_id: string | null;
  offer_id: string | null;
  attempts: number;
}

/** Espera antes de tentar de novo, por número de tentativas já feitas. */
const BACKOFF_MIN = [1, 5, 15];
export const MAX_TENTATIVAS = BACKOFF_MIN.length + 1;

/** Ação parada em 'executando' por mais que isto foi abandonada por um worker morto. */
export const LIMITE_PRESA_MIN = 5;

export interface Dependencias {
  db: Db;
  whatsapp: ClienteWhatsApp;
  agora?: () => Date;
}

async function reservar(db: Db, limite: number): Promise<AcaoPendente[]> {
  const r = await sql<AcaoPendente>`select * from app.claim_due_actions(${limite})`.execute(db);
  return [...r.rows];
}

/**
 * Devolve à fila o que ficou preso em 'executando'.
 *
 * `claim_due_actions` marca a ação antes de executar. Se o worker morrer no meio,
 * ninguém desmarca, e aquela confirmação nunca mais sai — o paciente simplesmente
 * não é avisado. Como a ação é idempotente do ponto de vista do paciente (ele
 * recebe a confirmação de novo, no pior caso), devolver é mais seguro que deixar.
 */
export async function devolverPresas(db: Db, limiteMin = LIMITE_PRESA_MIN): Promise<number> {
  // Pela função security definer: o varredor roda sem clínica na transação, e a
  // RLS de scheduled_actions barraria um update direto — ele não devolveria nada
  // e ninguém perceberia.
  const r = await sql<{ requeue_stuck_actions: number }>`
    select app.requeue_stuck_actions(${limiteMin})
  `.execute(db);
  return r.rows[0]?.requeue_stuck_actions ?? 0;
}

export type SaidaDaAcao = { ok: true } | { ok: false; motivo: string; definitivo: boolean };

async function confirmacao(trx: Trx, dep: Dependencias, acao: AcaoPendente): Promise<SaidaDaAcao> {
  if (acao.appointment_id === null) return { ok: false, motivo: 'sem consulta', definitivo: true };
  const consulta = await agenda.porId(trx, acao.appointment_id);
  if (!consulta) return { ok: true }; // consulta sumiu: nada a fazer
  if (consulta.status !== 'agendado') return { ok: true }; // já confirmada ou cancelada

  const phoneNumberId = await numeros.ativoDaClinica(trx);
  if (phoneNumberId === undefined) {
    return { ok: false, motivo: 'clínica sem número de WhatsApp', definitivo: true };
  }

  const r = await enviarAtivo(trx, dep.whatsapp, {
    clinicId: acao.clinic_id,
    pacienteId: consulta.patient_id,
    phoneNumberId,
    template: TEMPLATES.confirmacao.nome,
    botoes: [...TEMPLATES.confirmacao.botoes],
    consultaId: consulta.id,
  });

  if (r.ok) return { ok: true };
  // Sem consentimento o alerta já foi criado; insistir não resolve.
  return { ok: false, motivo: r.detalhe, definitivo: r.motivo !== 'temporario' };
}

async function lembreteFinal(
  trx: Trx,
  dep: Dependencias,
  acao: AcaoPendente,
): Promise<SaidaDaAcao> {
  if (acao.appointment_id === null) return { ok: false, motivo: 'sem consulta', definitivo: true };
  const consulta = await agenda.porId(trx, acao.appointment_id);
  if (!consulta) return { ok: true };
  if (!['agendado', 'confirmado', 'em_risco'].includes(consulta.status)) return { ok: true };

  const phoneNumberId = await numeros.ativoDaClinica(trx);
  if (phoneNumberId === undefined) {
    return { ok: false, motivo: 'clínica sem número de WhatsApp', definitivo: true };
  }

  const r = await enviarAtivo(trx, dep.whatsapp, {
    clinicId: acao.clinic_id,
    pacienteId: consulta.patient_id,
    phoneNumberId,
    template: TEMPLATES.lembreteFinal.nome,
    consultaId: consulta.id,
  });

  if (r.ok) return { ok: true };
  return { ok: false, motivo: r.detalhe, definitivo: r.motivo !== 'temporario' };
}

/**
 * Sem resposta até o prazo: a consulta entra em risco e a recepção é avisada.
 *
 * O horário NÃO é liberado (CLAUDE.md, regra 5). Quem não respondeu pode
 * perfeitamente aparecer; tirar da agenda por silêncio é criar dois pacientes
 * para o mesmo horário.
 */
async function marcarRisco(trx: Trx, acao: AcaoPendente): Promise<SaidaDaAcao> {
  if (acao.appointment_id === null) return { ok: false, motivo: 'sem consulta', definitivo: true };
  const consulta = await agenda.porId(trx, acao.appointment_id);
  if (!consulta) return { ok: true };
  if (consulta.status !== 'agendado') return { ok: true };

  await trx
    .updateTable('app.appointments')
    .set({ status: 'em_risco' })
    .where('id', '=', consulta.id)
    .execute();

  await alertas.criar(trx, acao.clinic_id, {
    tipo: 'consulta_em_risco',
    gravidade: 'atencao',
    titulo: 'Consulta sem confirmação',
    corpo: 'O paciente não respondeu à confirmação. O horário continua reservado.',
    consultaId: consulta.id,
    pacienteId: consulta.patient_id,
  });

  return { ok: true };
}

/** Oferta vencida: expira e chama a próxima rodada da fila para aquela vaga. */
async function expirarOferta(
  trx: Trx,
  dep: Dependencias,
  acao: AcaoPendente,
): Promise<SaidaDaAcao> {
  if (acao.offer_id === null) return { ok: false, motivo: 'sem oferta', definitivo: true };
  const agora = (dep.agora ?? (() => new Date()))();
  await expirarEPassarAdiante(trx, dep.whatsapp, acao.clinic_id, acao.offer_id, agora);
  return { ok: true };
}

async function executar(trx: Trx, dep: Dependencias, acao: AcaoPendente): Promise<SaidaDaAcao> {
  switch (acao.kind) {
    case 'confirmacao':
      return confirmacao(trx, dep, acao);
    case 'lembrete_final':
      return lembreteFinal(trx, dep, acao);
    case 'marcar_risco':
      return marcarRisco(trx, acao);
    case 'expirar_oferta':
      return expirarOferta(trx, dep, acao);
  }
}

async function concluir(trx: Trx, acaoId: string): Promise<void> {
  await trx
    .updateTable('app.scheduled_actions')
    .set({ status: 'feito' })
    .where('id', '=', acaoId)
    .execute();
}

/**
 * Falhou: volta para 'pendente' com espera crescente. Na última tentativa vira
 * 'erro' e alguém precisa olhar — silêncio aqui significa paciente não avisado.
 */
async function falhar(
  trx: Trx,
  acao: AcaoPendente,
  motivo: string,
  definitivo: boolean,
): Promise<void> {
  const desiste = definitivo || acao.attempts >= MAX_TENTATIVAS;

  if (desiste) {
    await trx
      .updateTable('app.scheduled_actions')
      .set({ status: 'erro', last_error: motivo })
      .where('id', '=', acao.id)
      .execute();

    await alertas.criar(trx, acao.clinic_id, {
      tipo: 'acao_falhou',
      gravidade: 'urgente',
      titulo: `Não consegui executar "${acao.kind}"`,
      corpo: `${motivo}. O paciente pode não ter sido avisado.`,
      ...(acao.appointment_id === null ? {} : { consultaId: acao.appointment_id }),
    });
    return;
  }

  const minutos = BACKOFF_MIN[acao.attempts - 1] ?? BACKOFF_MIN[BACKOFF_MIN.length - 1] ?? 15;
  await sql`
    update app.scheduled_actions
       set status = 'pendente', last_error = ${motivo},
           due_at = now() + make_interval(mins => ${minutos})
     where id = ${acao.id}
  `.execute(trx);
}

export interface ResumoDaRodada {
  pegas: number;
  feitas: number;
  falhas: number;
  devolvidas: number;
}

/** Uma passada: devolve o que ficou preso, pega o lote e executa cada ação. */
export async function rodarUmaVez(dep: Dependencias, limite = 50): Promise<ResumoDaRodada> {
  const devolvidas = await devolverPresas(dep.db);
  const acoes = await reservar(dep.db, limite);
  let feitas = 0;
  let falhas = 0;

  for (const acao of acoes) {
    // Cada ação na própria transação: uma falha não derruba o lote inteiro.
    await withClinic(
      acao.clinic_id,
      async (trx) => {
        const r = await executar(trx, dep, acao);
        if (r.ok) {
          await concluir(trx, acao.id);
          feitas++;
        } else {
          await falhar(trx, acao, r.motivo, r.definitivo);
          falhas++;
        }
      },
      dep.db,
    );
  }

  return { pegas: acoes.length, feitas, falhas, devolvidas };
}
