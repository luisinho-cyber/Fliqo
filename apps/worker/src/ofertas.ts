import { planejarOferta, type ConfigFila } from '@fliqo/core';
import { agenda, alertas, fila, ia, numeros, pacientes, type Trx } from '@fliqo/db';
import { PerfilClinicaSchema } from '@fliqo/ai';
import { sql } from 'kysely';
import { TEMPLATES, type ClienteWhatsApp } from '@fliqo/whatsapp';
import { enviarAtivo } from './envio';

/**
 * A lista de espera: um horário que abriu não fica vazio.
 *
 * Três coisas acontecem aqui, e a ordem importa:
 *   1. `planejarOferta` decide SE dá tempo de oferecer (e para quantos).
 *   2. `app.rank_waitlist` decide QUEM — prioridade da clínica e ordem de
 *      chegada, e é ele que já descarta quem tem procedimento longo demais
 *      para o buraco que abriu.
 *   3. `app.claim_slot_offer` decide de QUEM é a vaga quando dois dizem sim ao
 *      mesmo tempo. O primeiro leva; os outros recebem a frase de vaga
 *      preenchida e continuam na fila.
 *
 * Nada aqui cancela consulta nem tira ninguém da lista por conta própria.
 */

export const FRASE_VAGA_PREENCHIDA =
  'Esse horário acabou de ser preenchido, mas você continua na lista. Aviso assim que abrir outro.';

/** Teto de ofertas por pessoa por dia quando a clínica não tem perfil ativo. */
const MAX_OFERTAS_PADRAO = 3;

export interface ResultadoDaRodada {
  ofertados: number;
  /** Quem estava na vez mas não recebeu, e por quê. Vira log, não alerta. */
  pulados: { pacienteId: string; motivo: 'sem_consentimento' | 'teto_do_dia' }[];
  motivo?: 'em_cima_da_hora' | 'sem_tempo_para_resposta' | 'fila_vazia' | 'sem_numero';
}

export interface VagaAberta {
  consultaId?: string;
  profissionalId: string;
  inicio: Date;
  fim: Date;
}

async function configDaFila(trx: Trx, clinicId: string): Promise<ConfigFila> {
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

/** O teto de ofertas por dia mora no perfil da clínica, versionado como o resto. */
async function tetoDeOfertas(trx: Trx): Promise<number> {
  const perfil = await ia.perfilAtivo(trx);
  const lido = PerfilClinicaSchema.safeParse(perfil?.profile);
  return lido.success ? lido.data.fila.maxOfertasPorDia : MAX_OFERTAS_PADRAO;
}

/** Quantas ofertas cada um destes pacientes já recebeu hoje. */
async function ofertasDeHoje(trx: Trx, pacienteIds: string[]): Promise<Map<string, number>> {
  if (pacienteIds.length === 0) return new Map();
  const r = await sql<{ patient_id: string; quantas: string }>`
    select w.patient_id, count(*) as quantas
      from app.slot_offers o
      join app.waitlist_entries w on w.id = o.waitlist_entry_id
      join app.clinics c on c.id = o.clinic_id
     where w.patient_id = any(${pacienteIds})
       and o.created_at >= timezone(c.timezone, date_trunc('day', timezone(c.timezone, now())))
     group by w.patient_id
  `.execute(trx);
  return new Map(r.rows.map((l) => [l.patient_id, Number(l.quantas)]));
}

/**
 * Abre uma rodada de ofertas para uma vaga.
 *
 * Só recebe oferta quem tem `whatsapp_consent_at`: mensagem de oferta é
 * mensagem ativa. Quem não tem CONTINUA na fila, intocado — só não é chamado
 * agora, e isso volta em `pulados` para virar log.
 */
export async function abrirRodada(
  trx: Trx,
  cliente: ClienteWhatsApp,
  clinicId: string,
  vaga: VagaAberta,
  agora: Date,
): Promise<ResultadoDaRodada> {
  const cfg = await configDaFila(trx, clinicId);
  const plano = planejarOferta(cfg, vaga.inicio, agora);
  if (!plano.ofertar) {
    await alertas.criar(trx, clinicId, {
      tipo: 'horario_vago',
      gravidade: 'atencao',
      titulo: 'Horário liberado sem tempo de oferecer',
      corpo: `A vaga abriu, mas não dá para oferecer (${plano.motivo}). Ligue para quem está na fila.`,
      ...(vaga.consultaId === undefined ? {} : { consultaId: vaga.consultaId }),
    });
    return { ofertados: 0, pulados: [], motivo: plano.motivo };
  }

  const phoneNumberId = await numeros.ativoDaClinica(trx);
  if (phoneNumberId === undefined) return { ofertados: 0, pulados: [], motivo: 'sem_numero' };

  // Ranqueia mais gente do que o lote: quem está sem consentimento ou no teto do
  // dia não pode ocupar uma das vagas da rodada e deixar a oferta sair menor.
  const candidatos = await fila.ranquear(
    trx,
    clinicId,
    vaga.profissionalId,
    vaga.inicio,
    vaga.fim,
    plano.quantos * 4,
  );
  if (candidatos.length === 0) {
    await alertas.criar(trx, clinicId, {
      tipo: 'horario_vago',
      gravidade: 'atencao',
      titulo: 'Horário vago sem ninguém na fila',
      corpo: 'A vaga abriu e a lista de espera está vazia para este horário.',
      ...(vaga.consultaId === undefined ? {} : { consultaId: vaga.consultaId }),
    });
    return { ofertados: 0, pulados: [], motivo: 'fila_vazia' };
  }

  const teto = await tetoDeOfertas(trx);
  const jaReceberam = await ofertasDeHoje(
    trx,
    candidatos.map((c) => c.patient_id),
  );

  const saida: ResultadoDaRodada = { ofertados: 0, pulados: [] };

  for (const candidato of candidatos) {
    if (saida.ofertados >= plano.quantos) break;

    if ((jaReceberam.get(candidato.patient_id) ?? 0) >= teto) {
      saida.pulados.push({ pacienteId: candidato.patient_id, motivo: 'teto_do_dia' });
      continue;
    }

    const paciente = await pacientes.porId(trx, candidato.patient_id);
    if (!paciente || paciente.whatsapp_consent_at === null) {
      // Segue na fila: não sai, não é marcado, só não é chamado agora.
      saida.pulados.push({ pacienteId: candidato.patient_id, motivo: 'sem_consentimento' });
      continue;
    }

    const oferta = await fila.criarOferta(
      trx,
      clinicId,
      candidato.id,
      vaga.profissionalId,
      vaga.inicio,
      vaga.fim,
      plano.expiraEm,
    );

    const envio = await enviarAtivo(trx, cliente, {
      clinicId,
      pacienteId: candidato.patient_id,
      phoneNumberId,
      template: TEMPLATES.ofertaDeVaga.nome,
      botoes: [...TEMPLATES.ofertaDeVaga.botoes],
    });

    if (!envio.ok) {
      // Template recusado pela Meta (não aprovado, nome errado) não pode virar
      // uma oferta fantasma: ninguém recebeu, ninguém vai aceitar, e o horário
      // ficaria "ofertado" até expirar sem que a clínica soubesse.
      await fila.expirarOferta(trx, oferta.id);
      if (envio.motivo === 'recusado') {
        await alertas.criar(trx, clinicId, {
          tipo: 'acao_falhou',
          gravidade: 'urgente',
          titulo: 'A oferta de vaga não saiu: a Meta recusou o template',
          corpo: `Confira se o template "${TEMPLATES.ofertaDeVaga.nome}" está aprovado e com o botão ${TEMPLATES.ofertaDeVaga.botoes[0]}. Detalhe: ${envio.detalhe}`,
          ...(vaga.consultaId === undefined ? {} : { consultaId: vaga.consultaId }),
        });
        return { ...saida, motivo: 'sem_numero' };
      }
      continue;
    }

    await trx
      .insertInto('app.scheduled_actions')
      .values({
        clinic_id: clinicId,
        kind: 'expirar_oferta',
        offer_id: oferta.id,
        due_at: plano.expiraEm,
      })
      .execute();

    saida.ofertados += 1;
  }

  if (saida.ofertados === 0) {
    await alertas.criar(trx, clinicId, {
      tipo: 'horario_vago',
      gravidade: 'atencao',
      titulo: 'Horário vago: ninguém da fila pôde ser chamado',
      corpo:
        'Quem estava na vez não tem consentimento de WhatsApp ou já recebeu ofertas demais hoje.',
      ...(vaga.consultaId === undefined ? {} : { consultaId: vaga.consultaId }),
    });
  }
  return saida;
}

export type ResultadoDoAceite =
  { ok: true; consultaId: string } | { ok: false; motivo: 'sem_oferta' | 'preenchida_por_outro' };

/**
 * O paciente apertou "quero este horário".
 *
 * Quem decide é `claim_slot_offer`, que serializa os "sim" simultâneos: o
 * primeiro leva a vaga, os outros recebem a frase e CONTINUAM na fila. Apertar
 * duas vezes cai no mesmo caminho do segundo: uma consulta só.
 */
export async function aceitarVaga(
  trx: Trx,
  cliente: ClienteWhatsApp,
  clinicId: string,
  pacienteId: string,
): Promise<ResultadoDoAceite> {
  const aberta = await trx
    .selectFrom('app.slot_offers as o')
    .innerJoin('app.waitlist_entries as w', 'w.id', 'o.waitlist_entry_id')
    .select(['o.id'])
    .where('w.patient_id', '=', pacienteId)
    .where('o.status', '=', 'enviada')
    .orderBy('o.created_at', 'desc')
    .executeTakeFirst();

  if (!aberta) return { ok: false, motivo: 'sem_oferta' };

  const r = await fila.aceitarOferta(trx, aberta.id);
  const paciente = await pacientes.porId(trx, pacienteId);
  const phoneNumberId = await numeros.ativoDaClinica(trx);

  if (!r.ok) {
    // Resposta dentro da janela de 24 h: quem escreveu foi o paciente.
    if (paciente && phoneNumberId !== undefined) {
      await cliente.enviarTexto({
        phoneNumberId,
        paraE164: paciente.phone_e164,
        texto: FRASE_VAGA_PREENCHIDA,
      });
    }
    return { ok: false, motivo: 'preenchida_por_outro' };
  }

  const consulta = await agenda.porId(trx, r.consultaId);
  if (paciente && phoneNumberId !== undefined && consulta) {
    await cliente.enviarTexto({
      phoneNumberId,
      paraE164: paciente.phone_e164,
      texto: `Pronto, o horário é seu: ${consulta.starts_at.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })}. Até lá!`,
    });
  }
  return { ok: true, consultaId: r.consultaId };
}

/**
 * A oferta venceu sem resposta.
 *
 * NÃO cancela consulta e NÃO tira ninguém da fila: silêncio não é recusa
 * (CLAUDE.md, regra 5). A oferta vira 'expirada' e, no modo sequencial, a vaga
 * segue para o próximo. No modo lote, quando a última oferta daquele horário
 * morre sem aceite, a recepção é avisada de que o horário ficou vago.
 */
export async function expirarEPassarAdiante(
  trx: Trx,
  cliente: ClienteWhatsApp,
  clinicId: string,
  ofertaId: string,
  agora: Date,
): Promise<{ expirou: boolean; rodada?: ResultadoDaRodada }> {
  const oferta = await fila.expirarOferta(trx, ofertaId);
  if (!oferta) return { expirou: false }; // já foi aceita, recusada ou expirada

  const cfg = await configDaFila(trx, clinicId);

  if (cfg.modo === 'sequencial') {
    const rodada = await abrirRodada(
      trx,
      cliente,
      clinicId,
      {
        profissionalId: oferta.professional_id,
        inicio: oferta.starts_at,
        fim: oferta.ends_at,
      },
      agora,
    );
    return { expirou: true, rodada };
  }

  // Modo lote: só avisa quando a última oferta daquele horário morreu.
  const aindaDePe = await trx
    .selectFrom('app.slot_offers')
    .select(['id'])
    .where('professional_id', '=', oferta.professional_id)
    .where('starts_at', '=', oferta.starts_at)
    .where('status', '=', 'enviada')
    .executeTakeFirst();

  if (!aindaDePe) {
    await alertas.criar(trx, clinicId, {
      tipo: 'horario_vago',
      gravidade: 'atencao',
      titulo: 'Horário vago: ninguém da fila quis',
      corpo: 'As ofertas expiraram sem resposta. Todo mundo continua na lista.',
    });
  }
  return { expirou: true };
}
