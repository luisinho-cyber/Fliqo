import { criarDb, withClinic, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { TEMPLATES } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devolverPresas, rodarUmaVez } from '../src/acoes';
import { tratarResposta } from '../src/botao';
import { WhatsappFalso } from './fake';

let db: Db;
let owner: pg.Pool;
let c: Scenario;
let whatsapp: WhatsappFalso;

const PHONE_NUMBER_ID = '555000111222';

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
  await owner.query('delete from app.alerts');
  await owner.query('delete from app.slot_offers');
  await owner.query('delete from app.waitlist_entries');
  await owner.query('delete from app.appointments');
});

/** Consulta daqui a `horas`, com a régua de confirmação já criada pelo trigger. */
async function marcarConsulta(pacienteId: string, horas: number, comConsentimento = true) {
  if (comConsentimento) {
    await owner.query('update app.patients set whatsapp_consent_at = now() where id = $1', [
      pacienteId,
    ]);
  } else {
    await owner.query('update app.patients set whatsapp_consent_at = null where id = $1', [
      pacienteId,
    ]);
  }
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
     values ($1,$2,$3,$4, now() + make_interval(hours => $5), now() + make_interval(hours => $5) + interval '1 hour', 25000)
     returning id`,
    [c.clinicA, c.profA, pacienteId, c.procEletivo, horas],
  );
  return rows[0]!.id;
}

async function vencerAcoes(tipo?: string): Promise<void> {
  await owner.query(
    `update app.scheduled_actions set due_at = now() - interval '1 minute'
      where status = 'pendente' ${tipo === undefined ? '' : 'and kind = $1'}`,
    tipo === undefined ? [] : [tipo],
  );
}

async function acao(tipo: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    attempts: number;
    last_error: string | null;
    due_at: Date;
  }>('select id, status, attempts, last_error, due_at from app.scheduled_actions where kind = $1', [
    tipo,
  ]);
  return rows[0];
}

async function alertasDe(tipo: string): Promise<number> {
  const { rows } = await owner.query('select id from app.alerts where kind = $1', [tipo]);
  return rows.length;
}

async function statusDaConsulta(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    'select status from app.appointments where id = $1',
    [id],
  );
  return rows[0]?.status ?? 'sumiu';
}

describe('confirmação', () => {
  it('envia o template com os três botões e marca a ação como feita', async () => {
    await marcarConsulta(c.patients[0]!, 30);
    await vencerAcoes('confirmacao');

    const r = await rodarUmaVez({ db, whatsapp });

    expect(r.feitas).toBeGreaterThanOrEqual(1);
    const enviado = whatsapp.enviados.find((e) => e.template === TEMPLATES.confirmacao.nome);
    expect(enviado).toBeDefined();
    expect(enviado?.botoes).toEqual([
      'CONFIRMAR_CONSULTA',
      'REMARCAR_CONSULTA',
      'CANCELAR_CONSULTA',
    ]);
    expect((await acao('confirmacao'))?.status).toBe('feito');
  });

  it('NÃO envia para paciente sem consentimento e alerta a recepção', async () => {
    await marcarConsulta(c.patients[1]!, 30, false);
    await vencerAcoes('confirmacao');

    await rodarUmaVez({ db, whatsapp });

    // A regra que não pode falhar: mensagem ativa sem consentimento não sai.
    expect(whatsapp.enviados).toHaveLength(0);
    expect(await alertasDe('sem_consentimento')).toBe(1);
    // E não fica tentando para sempre: é recusa definitiva.
    expect((await acao('confirmacao'))?.status).toBe('erro');
  });
});

describe('falha e backoff', () => {
  it('falha temporária volta para pendente com espera crescente', async () => {
    await marcarConsulta(c.patients[0]!, 30);
    await vencerAcoes('confirmacao');
    whatsapp.falharComTemporario(1);

    await rodarUmaVez({ db, whatsapp });

    const a = await acao('confirmacao');
    expect(a?.status).toBe('pendente');
    expect(a?.attempts).toBe(1);
    // Voltou para o futuro: não é retentada no mesmo instante.
    expect(a!.due_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('na quarta falha vira erro e gera alerta urgente', async () => {
    await marcarConsulta(c.patients[0]!, 30);
    whatsapp.falharComTemporario(4);

    for (let i = 0; i < 4; i++) {
      await vencerAcoes('confirmacao');
      await rodarUmaVez({ db, whatsapp });
    }

    const a = await acao('confirmacao');
    expect(a?.status).toBe('erro');
    expect(a?.attempts).toBe(4);
    expect(await alertasDe('acao_falhou')).toBe(1);
  });

  it('recusa definitiva não fica repetindo', async () => {
    await marcarConsulta(c.patients[0]!, 30);
    await vencerAcoes('confirmacao');
    whatsapp.falharComRecusa();

    await rodarUmaVez({ db, whatsapp });

    const a = await acao('confirmacao');
    expect(a?.status).toBe('erro');
    expect(a?.attempts).toBe(1);
  });
});

describe('silêncio', () => {
  it('SILÊNCIO não libera o horário: vira em_risco e continua ocupado', async () => {
    const consultaId = await marcarConsulta(c.patients[0]!, 30);
    await vencerAcoes('marcar_risco');

    await rodarUmaVez({ db, whatsapp });

    expect(await statusDaConsulta(consultaId)).toBe('em_risco');
    expect(await alertasDe('consulta_em_risco')).toBe(1);

    // O horário continua reservado: ninguém da fila recebeu oferta.
    const { rows } = await owner.query('select id from app.slot_offers');
    expect(rows).toHaveLength(0);

    // E o horário segue impossível de dar a outro paciente.
    const conflito = await owner
      .query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
         select clinic_id, professional_id, $1, procedure_id, starts_at, ends_at, price_cents
           from app.appointments where id = $2`,
        [c.patients[2], consultaId],
      )
      .then(() => 'aceitou')
      .catch((e: unknown) => (e as { code?: string }).code);
    expect(conflito).toBe('23P01');
  });
});

describe('resposta do botão', () => {
  it('confirmou: a consulta vira confirmado', async () => {
    const consultaId = await marcarConsulta(c.patients[0]!, 30);

    await withClinic(
      c.clinicA,
      (trx) =>
        tratarResposta(trx, whatsapp, {
          clinicId: c.clinicA,
          pacienteId: c.patients[0]!,
          payloadBotao: 'CONFIRMAR_CONSULTA',
        }),
      db,
    );

    expect(await statusDaConsulta(consultaId)).toBe('confirmado');
  });

  it('cancelou: libera o horário e oferece para quem está na fila', async () => {
    const consultaId = await marcarConsulta(c.patients[0]!, 30);
    // Alguém esperando por este procedimento, com consentimento para receber oferta.
    await owner.query('update app.patients set whatsapp_consent_at = now() where id = $1', [
      c.patients[1],
    ]);
    const hoje = new Date();
    const daquiTresDias = new Date(hoje.getTime() + 3 * 24 * 3600_000);
    await owner.query(
      `insert into app.waitlist_entries (clinic_id, patient_id, procedure_id, window_start, window_end)
       values ($1,$2,$3,$4,$5)`,
      [c.clinicA, c.patients[1], c.procEletivo, hoje, daquiTresDias],
    );

    await withClinic(
      c.clinicA,
      (trx) =>
        tratarResposta(trx, whatsapp, {
          clinicId: c.clinicA,
          pacienteId: c.patients[0]!,
          payloadBotao: 'CANCELAR_CONSULTA',
        }),
      db,
    );

    expect(await statusDaConsulta(consultaId)).toBe('cancelado');

    const { rows: ofertas } = await owner.query('select id from app.slot_offers');
    expect(ofertas.length).toBeGreaterThanOrEqual(1);
    expect(whatsapp.enviados.some((e) => e.template === TEMPLATES.ofertaDeVaga.nome)).toBe(true);

    // A oferta tem que vencer sozinha se ninguém responder.
    const { rows: expirar } = await owner.query(
      `select id from app.scheduled_actions where kind = 'expirar_oferta'`,
    );
    expect(expirar.length).toBeGreaterThanOrEqual(1);
  });

  it('quer remarcar: o horário atual NÃO é liberado', async () => {
    const consultaId = await marcarConsulta(c.patients[0]!, 30);

    await withClinic(
      c.clinicA,
      (trx) =>
        tratarResposta(trx, whatsapp, {
          clinicId: c.clinicA,
          pacienteId: c.patients[0]!,
          payloadBotao: 'REMARCAR_CONSULTA',
        }),
      db,
    );

    expect(await statusDaConsulta(consultaId)).toBe('agendado');
  });

  it('texto livre não é tratado aqui: vai para a IA', async () => {
    await marcarConsulta(c.patients[0]!, 30);

    const r = await withClinic(
      c.clinicA,
      (trx) =>
        tratarResposta(trx, whatsapp, {
          clinicId: c.clinicA,
          pacienteId: c.patients[0]!,
          texto: 'posso levar minha mãe junto?',
        }),
      db,
    );

    expect(r).toEqual({ tratado: false, motivo: 'nao_e_botao' });
  });
});

describe('ações presas', () => {
  it('devolve para pendente o que ficou em executando por um worker morto', async () => {
    await marcarConsulta(c.patients[0]!, 30);
    // Simula o worker que pegou a ação e morreu antes de concluir.
    await owner.query(
      `update app.scheduled_actions
          set status = 'executando', due_at = now() - interval '10 minutes'
        where kind = 'confirmacao'`,
    );

    const devolvidas = await devolverPresas(db);

    expect(devolvidas).toBe(1);
    expect((await acao('confirmacao'))?.status).toBe('pendente');
  });

  it('não devolve o que está executando há pouco tempo', async () => {
    await marcarConsulta(c.patients[0]!, 30);
    await owner.query(
      `update app.scheduled_actions set status = 'executando', due_at = now() where kind = 'confirmacao'`,
    );

    expect(await devolverPresas(db)).toBe(0);
    expect((await acao('confirmacao'))?.status).toBe('executando');
  });
});
