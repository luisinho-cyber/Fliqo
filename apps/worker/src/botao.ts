import { efeitoDaResposta, interpretarResposta } from '@fliqo/core';
import { agenda, alertas, type Trx } from '@fliqo/db';
import type { ClienteWhatsApp } from '@fliqo/whatsapp';
import { abrirRodada, aceitarVaga } from './ofertas';

/**
 * A resposta ao template de confirmação.
 *
 * Chega como payload fixo de botão, então não passa pela IA: não há o que
 * interpretar errado. Quem decide o efeito é packages/core; aqui só se executa.
 */

export type SaidaDoBotao =
  | { tratado: true; efeito: string }
  | { tratado: false; motivo: 'sem_consulta' | 'nao_e_botao' | 'sem_oferta' };

/**
 * Libera o horário e chama a fila.
 *
 * Só chega aqui quem DISSE que não vem. Silêncio nunca cai neste caminho
 * (CLAUDE.md, regra 5) — quem não responde vira 'em_risco' e mantém o horário.
 */
export async function liberarEOfertar(
  trx: Trx,
  cliente: ClienteWhatsApp,
  clinicId: string,
  consultaId: string,
  motivo: string,
  agora: Date,
): Promise<void> {
  const cancelada = await agenda.cancelar(trx, consultaId, motivo);
  if (!cancelada) return;

  await abrirRodada(
    trx,
    cliente,
    clinicId,
    {
      consultaId: cancelada.id,
      profissionalId: cancelada.professional_id,
      inicio: cancelada.starts_at,
      fim: cancelada.ends_at,
    },
    agora,
  );
}

/** A consulta que a confirmação estava tratando: a próxima ainda de pé. */
async function consultaEmQuestao(trx: Trx, pacienteId: string, agora: Date) {
  return trx
    .selectFrom('app.appointments')
    .selectAll()
    .where('patient_id', '=', pacienteId)
    .where('status', 'in', ['agendado', 'em_risco', 'confirmado'])
    .where('starts_at', '>', agora)
    .orderBy('starts_at')
    .executeTakeFirst();
}

export async function tratarResposta(
  trx: Trx,
  cliente: ClienteWhatsApp,
  entrada: { clinicId: string; pacienteId: string; payloadBotao?: string; texto?: string },
  agora = new Date(),
): Promise<SaidaDoBotao> {
  const resposta = interpretarResposta({
    ...(entrada.payloadBotao === undefined ? {} : { payloadBotao: entrada.payloadBotao }),
    ...(entrada.texto === undefined ? {} : { texto: entrada.texto }),
  });
  const efeito = efeitoDaResposta(resposta);

  // Texto livre é da IA (Fase 4), não deste caminho.
  if (efeito.acao === 'encaminhar_para_ia') return { tratado: false, motivo: 'nao_e_botao' };

  // O aceite de vaga não fala da "próxima consulta": ele fala de uma oferta
  // aberta, que pode ser para um horário que a pessoa ainda nem tem.
  if (efeito.acao === 'aceitar_oferta') {
    const r = await aceitarVaga(trx, cliente, entrada.clinicId, entrada.pacienteId);
    return r.ok || r.motivo === 'preenchida_por_outro'
      ? { tratado: true, efeito: `${efeito.acao}:${r.ok ? 'aceita' : r.motivo}` }
      : { tratado: false, motivo: 'sem_oferta' };
  }

  const consulta = await consultaEmQuestao(trx, entrada.pacienteId, agora);
  if (!consulta) return { tratado: false, motivo: 'sem_consulta' };

  switch (efeito.acao) {
    case 'marcar_confirmado':
      await agenda.confirmar(trx, consulta.id);
      return { tratado: true, efeito: efeito.acao };

    case 'liberar_horario_e_ofertar':
      await liberarEOfertar(trx, cliente, entrada.clinicId, consulta.id, efeito.motivo, agora);
      return { tratado: true, efeito: efeito.acao };

    case 'registrar_ciencia':
      // A agenda não muda: o horário marcado continua valendo. Se o atraso
      // passar, esta mesma pessoa recebe o "normalizou" — é o aviso em
      // delay_notices que amarra as duas pontas.
      await alertas.criar(trx, entrada.clinicId, {
        tipo: 'atraso_profissional',
        gravidade: 'info',
        titulo: 'Paciente viu o aviso de atraso',
        corpo: 'Vai chegar no horário novo. O horário marcado segue reservado.',
        consultaId: consulta.id,
        pacienteId: entrada.pacienteId,
      });
      return { tratado: true, efeito: efeito.acao };

    case 'iniciar_remarcacao':
      // O horário antigo continua de pé: só sai depois que o novo estiver marcado.
      await alertas.criar(trx, entrada.clinicId, {
        tipo: 'conversa_assumida',
        gravidade: 'info',
        titulo: 'Paciente quer remarcar',
        corpo: 'Pedido de remarcação pela confirmação. O horário atual segue reservado.',
        consultaId: consulta.id,
        pacienteId: entrada.pacienteId,
      });
      return { tratado: true, efeito: efeito.acao };
  }
}
