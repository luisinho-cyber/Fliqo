import { criarDb, withClinic, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { PAYLOAD_BOTOES } from '@fliqo/core';
import { TEMPLATES } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tratarResposta } from '../src/botao';
import {
  abrirRodada,
  aceitarVaga,
  expirarEPassarAdiante,
  FRASE_VAGA_PREENCHIDA,
} from '../src/ofertas';
import { WhatsappFalso } from './fake';

let db: Db;
let owner: pg.Pool;
let c: Scenario;
let whatsapp: WhatsappFalso;

const PHONE_NUMBER_ID = '555000111222';
/** A vaga que abriu: amanhã às 14h, uma hora. */
const INICIO = new Date(Date.now() + 26 * 3_600_000);
const FIM = new Date(INICIO.getTime() + 3_600_000);

async function entrarNaFila(pacienteId: string, procedimentoId = c.procEletivo): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.waitlist_entries
       (clinic_id, patient_id, procedure_id, window_start, window_end)
     values ($1,$2,$3, current_date, current_date + 30) returning id`,
    [c.clinicA, pacienteId, procedimentoId],
  );
  return rows[0]!.id;
}

async function ofertas() {
  const { rows } = await owner.query<{ id: string; status: string; patient_id: string }>(
    `select o.id, o.status, w.patient_id
       from app.slot_offers o join app.waitlist_entries w on w.id = o.waitlist_entry_id
      order by o.created_at`,
  );
  return rows;
}

async function naFila() {
  const { rows } = await owner.query<{ patient_id: string; status: string }>(
    'select patient_id, status from app.waitlist_entries order by created_at',
  );
  return rows;
}

const vaga = { profissionalId: '', inicio: INICIO, fim: FIM };

async function rodada(agora = new Date()) {
  return withClinic(
    c.clinicA,
    (trx) => abrirRodada(trx, whatsapp, c.clinicA, { ...vaga, profissionalId: c.profA }, agora),
    db,
  );
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.whatsapp_numbers (clinic_id, phone_number_id) values ($1, $2)`,
    [c.clinicA, PHONE_NUMBER_ID],
  );
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  whatsapp = new WhatsappFalso();
  await owner.query('delete from app.scheduled_actions');
  await owner.query('delete from app.slot_offers');
  await owner.query('delete from app.waitlist_entries');
  await owner.query('delete from app.appointments');
  await owner.query('delete from app.alerts');
  await owner.query('delete from app.ai_profiles');
  await owner.query('update app.patients set whatsapp_consent_at = now()');
  await owner.query(`update app.clinics set waitlist_mode = 'lote', offer_batch_size = 3`);
});

describe('o payload casa com o template da Meta', () => {
  it('o botão do template é exatamente o payload que o webhook interpreta', () => {
    // Se divergirem, todo aceite chega como texto solto e vai parar na IA,
    // que não tem como marcar a consulta.
    expect(TEMPLATES.ofertaDeVaga.botoes).toEqual([PAYLOAD_BOTOES.QUERO_VAGA]);
    expect(PAYLOAD_BOTOES.QUERO_VAGA).toBe('QUERO_ESTE_HORARIO');
  });

  it('template recusado pela Meta não vira oferta fantasma', async () => {
    await entrarNaFila(c.patients[0]!);
    whatsapp.falharComRecusa();

    await rodada();

    // Ninguém recebeu: a oferta não pode ficar de pé esperando um aceite que
    // não vai vir, e a clínica precisa saber que o template está errado.
    expect((await ofertas()).every((o) => o.status === 'expirada')).toBe(true);
    const { rows } = await owner.query<{ title: string; severity: string }>(
      `select title, severity from app.alerts where kind = 'acao_falhou'`,
    );
    expect(rows[0]?.title).toContain('a Meta recusou o template');
    expect(rows[0]?.severity).toBe('urgente');
  });
});

describe('quem entra na rodada', () => {
  it('não oferece a quem não tem consentimento, e essa pessoa continua na fila', async () => {
    await entrarNaFila(c.patients[0]!);
    await owner.query('update app.patients set whatsapp_consent_at = null where id = $1', [
      c.patients[0]!,
    ]);

    const r = await rodada();

    expect(r.ofertados).toBe(0);
    expect(r.pulados).toEqual([{ pacienteId: c.patients[0]!, motivo: 'sem_consentimento' }]);
    expect(await ofertas()).toEqual([]);
    // Continua aguardando: não foi chamada agora, não saiu da lista.
    expect(await naFila()).toEqual([{ patient_id: c.patients[0]!, status: 'aguardando' }]);
  });

  it('pula quem já recebeu o teto de ofertas do dia e chama o próximo', async () => {
    const primeiro = await entrarNaFila(c.patients[0]!);
    await entrarNaFila(c.patients[1]!);
    await owner.query(`update app.clinics set offer_batch_size = 1`);

    // Três ofertas hoje para o primeiro da fila: chegou no teto padrão.
    for (let i = 0; i < 3; i++) {
      await owner.query(
        `insert into app.slot_offers
           (clinic_id, waitlist_entry_id, professional_id, starts_at, ends_at, expires_at, status)
         values ($1,$2,$3, now() + make_interval(days => 5, hours => $4),
                 now() + make_interval(days => 5, hours => $4 + 1), now() - interval '1 hour', 'expirada')`,
        [c.clinicA, primeiro, c.profA, i],
      );
    }

    const r = await rodada();

    expect(r.pulados).toEqual([{ pacienteId: c.patients[0]!, motivo: 'teto_do_dia' }]);
    const novas = (await ofertas()).filter((o) => o.status === 'enviada');
    expect(novas).toHaveLength(1);
    expect(novas[0]?.patient_id).toBe(c.patients[1]!);
  });

  it('o teto vem do perfil da clínica quando ele existe', async () => {
    const entrada = await entrarNaFila(c.patients[0]!);
    await owner.query(
      `insert into app.ai_profiles (clinic_id, version, is_active, profile) values ($1, 1, true, $2)`,
      [
        c.clinicA,
        JSON.stringify({
          clinica: { nome: 'Clínica A', especialidade: 'odontologia', endereco: 'Rua Exemplo, 1' },
          persona: { nome: 'Assistente Fliqo', tratamento: 'voce', tom: 'acolhedor' },
          atendimento: { horarioHumano: 'seg a sex' },
          politicas: { cancelamento: '24h', formasDePagamento: ['Pix'] },
          fila: { maxOfertasPorDia: 1 },
        }),
      ],
    );
    await owner.query(
      `insert into app.slot_offers
         (clinic_id, waitlist_entry_id, professional_id, starts_at, ends_at, expires_at, status)
       values ($1,$2,$3, now() + interval '5 days', now() + interval '5 days 1 hour',
               now() - interval '1 hour', 'expirada')`,
      [c.clinicA, entrada, c.profA],
    );

    const r = await rodada();
    expect(r.pulados).toEqual([{ pacienteId: c.patients[0]!, motivo: 'teto_do_dia' }]);
  });

  it('perfil inválido não trava a fila: cai no teto padrão', async () => {
    // Errar o perfil não pode significar parar de oferecer vaga. O padrão de 3
    // vale, e a rodada acontece.
    await entrarNaFila(c.patients[0]!);
    await owner.query(
      `insert into app.ai_profiles (clinic_id, version, is_active, profile)
       values ($1, 1, true, $2)`,
      [c.clinicA, JSON.stringify({ clinica: { nome: 'x' } })],
    );

    const r = await rodada();
    expect(r.ofertados).toBe(1);
  });

  it('procedimento mais longo que a vaga não entra — quem filtra é o rank_waitlist', async () => {
    // procLongo tem 120 min; a vaga tem 60. A regra vive no banco, não no
    // planejarOferta, que só decide SE e para QUANTOS ofertar.
    await entrarNaFila(c.patients[0]!, c.procLongo);
    await entrarNaFila(c.patients[1]!, c.procEletivo);

    await rodada();

    const enviadas = (await ofertas()).filter((o) => o.status === 'enviada');
    expect(enviadas.map((o) => o.patient_id)).toEqual([c.patients[1]!]);
  });

  it('fila vazia vira alerta de horário vago', async () => {
    const r = await rodada();
    expect(r.motivo).toBe('fila_vazia');
    const { rows } = await owner.query(`select 1 from app.alerts where kind = 'horario_vago'`);
    expect(rows).toHaveLength(1);
  });
});

describe('o primeiro sim leva', () => {
  it('lote: quem aceita primeiro marca, os outros viram preenchida_por_outro', async () => {
    await entrarNaFila(c.patients[0]!);
    await entrarNaFila(c.patients[1]!);
    await entrarNaFila(c.patients[2]!);

    const r = await rodada();
    expect(r.ofertados).toBe(3);

    const aceite = await withClinic(
      c.clinicA,
      (trx) => aceitarVaga(trx, whatsapp, c.clinicA, c.patients[1]!),
      db,
    );
    expect(aceite.ok).toBe(true);

    const depois = await ofertas();
    const porPaciente = new Map(depois.map((o) => [o.patient_id, o.status]));
    expect(porPaciente.get(c.patients[1]!)).toBe('aceita');
    expect(porPaciente.get(c.patients[0]!)).toBe('preenchida_por_outro');
    expect(porPaciente.get(c.patients[2]!)).toBe('preenchida_por_outro');

    const { rows } = await owner.query<{ patient_id: string; source: string; status: string }>(
      'select patient_id, source, status from app.appointments',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patient_id: c.patients[1]!,
      source: 'lista_espera',
      status: 'confirmado',
    });

    // Quem ganhou sai da lista; os outros continuam aguardando.
    const fila = await naFila();
    expect(fila.find((f) => f.patient_id === c.patients[1]!)?.status).toBe('atendido');
    expect(fila.find((f) => f.patient_id === c.patients[0]!)?.status).toBe('aguardando');
  });

  it('o mesmo paciente aceitando duas vezes gera uma consulta só', async () => {
    await entrarNaFila(c.patients[0]!);
    await rodada();

    const primeira = await withClinic(
      c.clinicA,
      (trx) => aceitarVaga(trx, whatsapp, c.clinicA, c.patients[0]!),
      db,
    );
    const segunda = await withClinic(
      c.clinicA,
      (trx) => aceitarVaga(trx, whatsapp, c.clinicA, c.patients[0]!),
      db,
    );

    expect(primeira.ok).toBe(true);
    // A oferta já não está 'enviada': o segundo toque não acha oferta aberta.
    expect(segunda).toEqual({ ok: false, motivo: 'sem_oferta' });

    const { rows } = await owner.query('select 1 from app.appointments');
    expect(rows).toHaveLength(1);
  });

  it('quem chega depois recebe a frase e continua na lista', async () => {
    await entrarNaFila(c.patients[0]!);
    await entrarNaFila(c.patients[1]!);
    await rodada();

    await withClinic(c.clinicA, (trx) => aceitarVaga(trx, whatsapp, c.clinicA, c.patients[0]!), db);

    // O segundo aperta o botão depois: a oferta dele virou preenchida_por_outro,
    // então não há oferta 'enviada' — ele recebe a frase pelo caminho do botão.
    await owner.query(
      `update app.slot_offers set status = 'enviada'
        where waitlist_entry_id in (select id from app.waitlist_entries where patient_id = $1)`,
      [c.patients[1]!],
    );
    const tardio = await withClinic(
      c.clinicA,
      (trx) => aceitarVaga(trx, whatsapp, c.clinicA, c.patients[1]!),
      db,
    );

    expect(tardio).toEqual({ ok: false, motivo: 'preenchida_por_outro' });
    expect(whatsapp.textos.at(-1)?.texto).toBe(FRASE_VAGA_PREENCHIDA);
    expect((await naFila()).find((f) => f.patient_id === c.patients[1]!)?.status).toBe(
      'aguardando',
    );
  });

  it('o botão do webhook chega até a marcação', async () => {
    await entrarNaFila(c.patients[0]!);
    await rodada();

    const r = await withClinic(
      c.clinicA,
      (trx) =>
        tratarResposta(trx, whatsapp, {
          clinicId: c.clinicA,
          pacienteId: c.patients[0]!,
          payloadBotao: PAYLOAD_BOTOES.QUERO_VAGA,
        }),
      db,
    );

    expect(r).toEqual({ tratado: true, efeito: 'aceitar_oferta:aceita' });
    const { rows } = await owner.query('select 1 from app.appointments');
    expect(rows).toHaveLength(1);
  });
});

describe('a oferta que vence', () => {
  it('sequencial: expira e chama o próximo, sem tirar ninguém da fila', async () => {
    await owner.query(`update app.clinics set waitlist_mode = 'sequencial', offer_batch_size = 1`);
    await entrarNaFila(c.patients[0]!);
    await entrarNaFila(c.patients[1]!);

    const r = await rodada();
    expect(r.ofertados).toBe(1);
    const primeira = (await ofertas())[0]!;

    const saida = await withClinic(
      c.clinicA,
      (trx) => expirarEPassarAdiante(trx, whatsapp, c.clinicA, primeira.id, new Date()),
      db,
    );

    expect(saida.expirou).toBe(true);
    expect(saida.rodada?.ofertados).toBe(1);

    const todas = await ofertas();
    expect(todas.find((o) => o.id === primeira.id)?.status).toBe('expirada');
    const nova = todas.find((o) => o.status === 'enviada');
    expect(nova?.patient_id).toBe(c.patients[1]!);

    // Nada de cancelar nem de tirar da fila: silêncio não é recusa.
    expect((await naFila()).every((f) => f.status === 'aguardando')).toBe(true);
    const { rows } = await owner.query('select 1 from app.appointments');
    expect(rows).toHaveLength(0);
  });

  it('lote: só alerta quando a última oferta do horário morre', async () => {
    await entrarNaFila(c.patients[0]!);
    await entrarNaFila(c.patients[1]!);
    await rodada();
    const abertas = await ofertas();

    await withClinic(
      c.clinicA,
      (trx) => expirarEPassarAdiante(trx, whatsapp, c.clinicA, abertas[0]!.id, new Date()),
      db,
    );
    let { rows } = await owner.query(`select 1 from app.alerts where kind = 'horario_vago'`);
    expect(rows).toHaveLength(0);

    await withClinic(
      c.clinicA,
      (trx) => expirarEPassarAdiante(trx, whatsapp, c.clinicA, abertas[1]!.id, new Date()),
      db,
    );
    ({ rows } = await owner.query(`select 1 from app.alerts where kind = 'horario_vago'`));
    expect(rows).toHaveLength(1);

    expect((await naFila()).every((f) => f.status === 'aguardando')).toBe(true);
  });

  it('expirar uma oferta já aceita não desfaz nada', async () => {
    await entrarNaFila(c.patients[0]!);
    await rodada();
    const oferta = (await ofertas())[0]!;
    await withClinic(c.clinicA, (trx) => aceitarVaga(trx, whatsapp, c.clinicA, c.patients[0]!), db);

    const saida = await withClinic(
      c.clinicA,
      (trx) => expirarEPassarAdiante(trx, whatsapp, c.clinicA, oferta.id, new Date()),
      db,
    );

    expect(saida.expirou).toBe(false);
    expect((await ofertas())[0]?.status).toBe('aceita');
    const { rows } = await owner.query('select 1 from app.appointments');
    expect(rows).toHaveLength(1);
  });
});
