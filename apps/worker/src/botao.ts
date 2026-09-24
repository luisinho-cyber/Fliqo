import {
  efeitoDaResposta,
  interpretarResposta,
  planejarOferta,
  type ConfigFila,
} from '@fliqo/core';
import { agenda, alertas, fila, type Trx } from '@fliqo/db';
import { TEMPLATES, type ClienteWhatsApp } from '@fliqo/whatsapp';
import { enviarAtivo } from './envio';

/**
 * A resposta ao template de confirmação.
 *
 * Chega como payload fixo de botão, então não passa pela IA: não há o que
 * interpretar errado. Quem decide o efeito é packages/core; aqui só se executa.
 */

export type SaidaDoBotao =
  { tratado: true; efeito: string } | { tratado: false; motivo: 'sem_consulta' | 'nao_e_botao' };

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

async function configDaClinica(trx: Trx, clinicId: string): Promise<ConfigFila> {
  const c = await trx
    .selectFrom('app.clinics')
    .select([
      'waitlist_mode',
      'offer_batch_size',
      'offer_timeout_minutes',
      'min_offer_lead_minutes',
    ])
    .where('id', '=', clinicId)
    .executeTakeFirstOrThrow();
  return {
    modo: c.waitlist_mode,
    tamanhoLote: c.offer_batch_size,
    timeoutMin: c.offer_timeout_minutes,
    antecedenciaMinimaMin: c.min_offer_lead_minutes,
  };
}

/**
 * Libera o horário e oferece para a fila.
 *
 * Só chega aqui quem DISSE que não vem. Silêncio nunca cai neste caminho
 * (CLAUDE.md, regra 5) — quem não responde vira 'em_risco' e mantém o horário.
 */
async function liberarEOfertar(
  trx: Trx,
  cliente: ClienteWhatsApp,
  clinicId: string,
  consultaId: string,
  motivo: string,
  agora: Date,
): Promise<void> {
  const cancelada = await agenda.cancelar(trx, consultaId, motivo);
  if (!cancelada) return;

  const cfg = await configDaClinica(trx, clinicId);
  const plano = planejarOferta(cfg, cancelada.starts_at, agora);
  if (!plano.ofertar) {
    await alertas.criar(trx, clinicId, {
      tipo: 'horario_vago',
      gravidade: 'atencao',
      titulo: 'Horário liberado sem tempo de oferecer',
      corpo: `O paciente cancelou, mas não dá para oferecer a vaga (${plano.motivo}).`,
      consultaId: cancelada.id,
    });
    return;
  }

  const candidatos = await fila.ranquear(
    trx,
    clinicId,
    cancelada.professional_id,
    cancelada.starts_at,
    cancelada.ends_at,
    plano.quantos,
  );

  if (candidatos.length === 0) {
    await alertas.criar(trx, clinicId, {
      tipo: 'horario_vago',
      gravidade: 'atencao',
      titulo: 'Horário vago sem ninguém na fila',
      corpo: 'O paciente cancelou e a lista de espera está vazia para este horário.',
      consultaId: cancelada.id,
    });
    return;
  }

  const numero = await trx
    .selectFrom('app.whatsapp_numbers')
    .select(['phone_number_id'])
    .where('active', '=', true)
    .executeTakeFirst();

  for (const candidato of candidatos) {
    const oferta = await fila.criarOferta(
      trx,
      clinicId,
      candidato.id,
      cancelada.professional_id,
      cancelada.starts_at,
      cancelada.ends_at,
      plano.expiraEm,
    );

    if (numero !== undefined) {
      // Oferta é mensagem ativa: passa pelo porteiro de consentimento como as outras.
      await enviarAtivo(trx, cliente, {
        clinicId,
        pacienteId: candidato.patient_id,
        phoneNumberId: numero.phone_number_id,
        template: TEMPLATES.ofertaDeVaga.nome,
        botoes: [...TEMPLATES.ofertaDeVaga.botoes],
      });
    }

    // A oferta precisa vencer sozinha se ninguém responder.
    await trx
      .insertInto('app.scheduled_actions')
      .values({
        clinic_id: clinicId,
        kind: 'expirar_oferta',
        offer_id: oferta.id,
        due_at: plano.expiraEm,
      })
      .execute();
  }
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
