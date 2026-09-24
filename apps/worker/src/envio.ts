import { alertas, pacientes, type Trx } from '@fliqo/db';
import type { ClienteWhatsApp, EnvioDeTemplate, ResultadoEnvio } from '@fliqo/whatsapp';

/**
 * Porteiro de mensagem ativa (LGPD).
 *
 * TODA mensagem que o sistema manda por iniciativa própria — confirmação,
 * lembrete, oferta de vaga, aviso de atraso — passa por aqui. Sem
 * whatsapp_consent_at preenchido, a mensagem NÃO sai e a recepção recebe um
 * alerta para falar com a pessoa por outro caminho.
 *
 * Responder a quem escreveu é outra coisa e não passa por este porteiro: ali
 * quem iniciou foi o paciente, dentro da janela de 24 h da Meta.
 *
 * Existe um lugar só para isso de propósito: se cada chamada de envio decidisse
 * por conta própria, bastaria um esquecimento para a clínica mandar mensagem sem
 * consentimento — que é justamente o que não pode acontecer.
 */

export type ResultadoEnvioAtivo =
  | { ok: true; wamid: string }
  | { ok: false; motivo: 'sem_consentimento' | 'recusado' | 'temporario'; detalhe: string };

export interface PedidoDeEnvioAtivo {
  clinicId: string;
  pacienteId: string;
  phoneNumberId: string;
  template: string;
  variaveis?: string[];
  botoes?: string[];
  /** Para o alerta ficar ligado à consulta, quando houver. */
  consultaId?: string;
  /**
   * O que a mensagem ia dizer, em duas palavras ("do atraso", "da consulta de
   * amanhã"). Entra no alerta que a recepção lê: "não foi possível avisar
   * Maria do atraso" é acionável; "mensagem não enviada" manda ela adivinhar.
   */
  assunto?: string;
}

export async function enviarAtivo(
  trx: Trx,
  cliente: ClienteWhatsApp,
  p: PedidoDeEnvioAtivo,
): Promise<ResultadoEnvioAtivo> {
  const paciente = await pacientes.porId(trx, p.pacienteId);
  if (!paciente) {
    return { ok: false, motivo: 'recusado', detalhe: 'paciente não encontrado' };
  }

  if (paciente.whatsapp_consent_at === null) {
    await alertas.criar(trx, p.clinicId, {
      tipo: 'sem_consentimento',
      gravidade: 'atencao',
      titulo:
        p.assunto === undefined
          ? 'Mensagem não enviada: paciente sem consentimento de WhatsApp'
          : `Não foi possível avisar ${paciente.name} ${p.assunto} — sem consentimento de WhatsApp`,
      corpo: `Ligue para ${paciente.name} e registre o consentimento no cadastro.`,
      pacienteId: paciente.id,
      ...(p.consultaId === undefined ? {} : { consultaId: p.consultaId }),
    });
    return { ok: false, motivo: 'sem_consentimento', detalhe: 'consentimento ausente' };
  }

  const envio: EnvioDeTemplate = {
    phoneNumberId: p.phoneNumberId,
    paraE164: paciente.phone_e164,
    template: p.template,
    ...(p.variaveis === undefined ? {} : { variaveis: p.variaveis }),
    ...(p.botoes === undefined ? {} : { botoes: p.botoes }),
  };

  const r: ResultadoEnvio = await cliente.enviarTemplate(envio);
  if (!r.ok) return { ok: false, motivo: r.motivo, detalhe: r.detalhe };

  // Mensagem enviada também é mensagem: entra no histórico da conversa.
  return { ok: true, wamid: r.wamid };
}
