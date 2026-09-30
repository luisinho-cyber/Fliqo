import { sql } from 'kysely';
import { ACOES_QUE_ENVIAM } from '../schema';
import type { Trx } from '../withClinic';

/**
 * As ações agendadas, do lado de quem NÃO as executa.
 *
 * O worker tem o próprio caminho (claim, executa, conclui). Aqui ficam as duas
 * operações que vêm de fora dele: cancelar em bloco quando o dono desliga o
 * WhatsApp, e encerrar sem propósito quando a afirmação do template venceu.
 */

/**
 * O dono desligou o WhatsApp: as ações de envio pendentes são canceladas na hora.
 *
 * Tratamento OPOSTO ao do número em erro, porque a intenção é oposta. Quem teve o
 * token revogado quer as confirmações de amanhã esperando o número voltar; quem
 * desligou de propósito não pretende voltar amanhã, e segurar as ações dele só
 * acumula fila para um envio que ninguém mais quer.
 *
 * Só as de envio: `marcar_risco` não manda mensagem e continua valendo — a
 * consulta segue existindo e o painel continua precisando saber que ela está sem
 * confirmação.
 */
export async function cancelarEnviosPendentes(trx: Trx, clinicId: string): Promise<number> {
  const r = await trx
    .updateTable('app.scheduled_actions')
    .set({ status: 'cancelado', last_error: 'WhatsApp desligado pelo painel' })
    .where('clinic_id', '=', clinicId)
    .where('status', '=', 'pendente')
    .where('kind', 'in', [...ACOES_QUE_ENVIAM])
    .returning('id')
    .execute();
  return r.length;
}

/**
 * A ação venceu durante a queda: encerra sem propósito, sem alerta.
 *
 * Não é falha — é consequência esperada de o WhatsApp ter ficado fora. O que a
 * recepção precisa saber vira decisão na tela Hoje, com a lista dos pacientes e
 * uma ação por linha; um alerta por ação aqui seria a enxurrada que esta fase
 * existe para remover.
 */
export async function encerrarSemProposito(
  trx: Trx,
  acaoId: string,
  motivo: string,
): Promise<void> {
  await trx
    .updateTable('app.scheduled_actions')
    .set({ status: 'sem_proposito', last_error: motivo })
    .where('id', '=', acaoId)
    .execute();
}

/**
 * Devolve uma ação descartada para a fila, vencendo agora.
 *
 * Só aceita o que está em `sem_proposito`: reenfileirar algo que já foi feito
 * mandaria mensagem repetida, e algo em `erro` precisa de olhar humano, não de
 * mais uma tentativa. Devolve se achou — sem isso a rota responderia 200 para um
 * id qualquer e quem tocou o botão acharia que reenviou.
 *
 * O worker refaz o caminho inteiro, checagem de pertinência incluída: se a
 * afirmação do template venceu nesse meio-tempo, volta para `sem_proposito`.
 */
export async function reenfileirar(trx: Trx, acaoId: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    update app.scheduled_actions
       set status = 'pendente', due_at = now(), attempts = 0, last_error = null
     where id = ${acaoId} and status = 'sem_proposito'
     returning id
  `.execute(trx);
  return r.rows.length > 0;
}

export interface DescarteDoDia {
  acaoId: string;
  kind: string;
  consultaId: string | null;
  pacienteId: string | null;
  paciente: string | null;
  telefoneMascarado: string | null;
  inicioDaConsulta: Date | null;
  motivo: string | null;
}

/**
 * O que foi descartado por causa da queda, para a tela Hoje.
 *
 * Um número não é acionável: "30 descartadas" conta à recepção que algo ruim
 * aconteceu e não diz o que fazer. A lista diz: são estes, e para cada um há uma
 * ação. Por isso devolve paciente e horário, e não uma contagem.
 *
 * O telefone sai MASCARADO: nenhum endpoint de listagem devolve telefone inteiro
 * (DESIGN.md e docs/OPERACAO.md). O inteiro sai só pela revelação por paciente.
 */
export async function descartadasNoDia(trx: Trx, de: Date, ate: Date): Promise<DescarteDoDia[]> {
  const r = await sql<{
    acao_id: string;
    kind: string;
    consulta_id: string | null;
    paciente_id: string | null;
    paciente: string | null;
    telefone: string | null;
    inicio: Date | null;
    motivo: string | null;
  }>`
    select s.id as acao_id, s.kind, s.appointment_id as consulta_id,
           a.patient_id as paciente_id, p.name as paciente, p.phone_e164 as telefone,
           a.starts_at as inicio, s.last_error as motivo
      from app.scheduled_actions s
      left join app.appointments a on a.id = s.appointment_id
      left join app.patients p on p.id = a.patient_id
     where s.status = 'sem_proposito'
       and a.starts_at >= ${de} and a.starts_at < ${ate}
     order by a.starts_at
  `.execute(trx);

  return r.rows.map((l) => ({
    acaoId: l.acao_id,
    kind: l.kind,
    consultaId: l.consulta_id,
    pacienteId: l.paciente_id,
    paciente: l.paciente,
    telefoneMascarado: l.telefone === null ? null : mascarar(l.telefone),
    inicioDaConsulta: l.inicio,
    motivo: l.motivo,
  }));
}

/** Mesma máscara da caixa de conversas: primeiros cinco e dois últimos. */
function mascarar(telefone: string): string {
  return telefone.length <= 6 ? '***' : `${telefone.slice(0, 5)}***${telefone.slice(-2)}`;
}
