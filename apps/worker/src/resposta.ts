import type { PlanoDeEnvio } from '@fliqo/core';
import { comoConexaoDoBoss, conversas, pacientes, type Trx } from '@fliqo/db';
import { FILA_RESPOSTA } from '@fliqo/db/fila';
import type { ClienteWhatsApp } from '@fliqo/whatsapp';
import type { PgBoss } from 'pg-boss';

/**
 * A resposta da assistente sai no ritmo de gente: uma pausa para "ler e pensar",
 * o "digitando…", e um balão de cada vez.
 *
 * Cada balão é um job atrasado, nunca um sleep. Um sleep seguraria a transação
 * aberta por até 45 segundos e perderia o resto da resposta se o worker caísse
 * no meio.
 */

export interface BalaoDaResposta {
  clinicId: string;
  conversaId: string;
  phoneNumberId: string;
  /** wamid da mensagem do paciente que estamos respondendo, para o "digitando…". */
  wamidRecebido?: string;
  texto: string;
  digitandoMs: number;
}

export async function agendarResposta(
  boss: PgBoss,
  trx: Trx,
  base: Omit<BalaoDaResposta, 'texto' | 'digitandoMs'>,
  plano: PlanoDeEnvio,
): Promise<void> {
  // Um segundo de distância mínima entre balões: `startAfter` tem resolução de
  // segundo, e dois balões marcados para o mesmo segundo podem sair fora de
  // ordem — o paciente leria a resposta de trás para frente.
  const ESPACO_MINIMO_MS = 1_000;
  let atrasoMs = plano.aguardarAntesMs;
  for (const balao of plano.baloes) {
    await boss.send({
      name: FILA_RESPOSTA,
      data: { ...base, texto: balao.texto, digitandoMs: balao.digitandoMs },
      options: {
        startAfter: Math.round(atrasoMs / 1_000),
        // Enfileira dentro da transação que gravou a conversa: ou as duas coisas
        // acontecem, ou nenhuma.
        db: comoConexaoDoBoss(trx),
      },
    });
    atrasoMs += Math.max(balao.digitandoMs, ESPACO_MINIMO_MS);
  }
}

export type ResultadoDoBalao =
  | { ok: true; wamid: string }
  | { ok: false; motivo: 'humano' | 'sem_paciente' | 'envio'; detalhe?: string };

/**
 * Envia um balão. Checa o modo de novo aqui de propósito: entre planejar e
 * enviar, a recepção pode ter assumido a conversa pelo celular — e aí a
 * assistente tem de calar, mesmo com a resposta já pronta na fila.
 */
export async function enviarBalao(
  trx: Trx,
  cliente: ClienteWhatsApp,
  b: BalaoDaResposta,
): Promise<ResultadoDoBalao> {
  const conversa = await conversas.porId(trx, b.conversaId);
  if (!conversa || conversa.mode === 'humano') return { ok: false, motivo: 'humano' };

  const paciente = await pacientes.porId(trx, conversa.patient_id);
  if (!paciente) return { ok: false, motivo: 'sem_paciente' };

  if (b.wamidRecebido !== undefined) {
    await cliente.marcarDigitando({
      phoneNumberId: b.phoneNumberId,
      wamidRecebido: b.wamidRecebido,
    });
  }

  const r = await cliente.enviarTexto({
    phoneNumberId: b.phoneNumberId,
    paraE164: paciente.phone_e164,
    texto: b.texto,
  });
  if (!r.ok) return { ok: false, motivo: 'envio', detalhe: r.detalhe };

  await conversas.registrar(trx, {
    conversaId: b.conversaId,
    clinicId: b.clinicId,
    direcao: 'saida',
    autor: 'ia',
    wamid: r.wamid,
    corpo: b.texto,
  });
  return { ok: true, wamid: r.wamid };
}
