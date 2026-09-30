import { criarDb, withClinic, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { cifrar, type ResultadoEnvio } from '@fliqo/whatsapp';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rodarUmaVez } from '../src/acoes';
import { WhatsappFalso } from './fake';

/**
 * Queda de WhatsApp: a ação espera em vez de queimar.
 *
 * O caso que dá nome a tudo: o token é revogado às 2h; as confirmações de amanhã
 * vencem, são reclamadas uma a uma e falham como definitivo; às 9h alguém
 * reconecta e descobre que os trinta pacientes nunca foram confirmados. Uma queda
 * de três horas comia um dia inteiro de confirmação, em silêncio.
 */

const PN = '555000111222';

let db: Db;
let owner: pg.Pool;
let c: Scenario;
let whatsapp: WhatsappFalso;

/** Cliente falso que recusa a credencial, como a Meta faz com token revogado. */
class SemCredencial extends WhatsappFalso {
  override enviarTemplate(): Promise<ResultadoEnvio> {
    return Promise.resolve({
      ok: false,
      motivo: 'credencial',
      detalhe: 'Error validating access token',
    });
  }
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
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
  await owner.query('delete from app.appointments');
  await owner.query('delete from app.whatsapp_numbers');
  // `conectado_tem_token` (0005) exige token: conectado sem token não existe, e
  // seria a clínica achando que pode enviar.
  const g = cifrar('TOKEN-DA-CLINICA', randomBytes(32));
  await owner.query(
    `insert into app.whatsapp_numbers
       (clinic_id, phone_number_id, status, token_ciphertext, token_iv, token_tag, token_updated_at)
     values ($1,$2,'conectado',$3,$4,$5, now())`,
    [c.clinicA, PN, g.ciphertext, g.iv, g.tag],
  );
  await owner.query(`update app.patients set whatsapp_consent_at = now()`);
});

/**
 * Consulta daqui a N minutos, com a régua criada pelo trigger.
 *
 * Em minutos porque `make_interval(hours => ...)` só aceita inteiro, e os casos que
 * interessam aqui são de meia hora. O trigger só cria a régua para consulta no
 * FUTURO — por isso ela nasce no futuro, e quem precisa dela no passado usa
 * `moverPara`.
 */
async function consulta(pacienteId: string, minutos: number): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
     values ($1,$2,$3,$4, now() + make_interval(mins => $5),
             now() + make_interval(mins => $5) + interval '1 hour', 25000)
     returning id`,
    [c.clinicA, c.profA, pacienteId, c.procEletivo, minutos],
  );
  return rows[0]!.id;
}

/** Move a consulta sem passar pelo trigger de régua (ele só olha starts_at e status). */
async function moverPara(consultaId: string, minutos: number): Promise<void> {
  await owner.query(
    `update app.appointments
        set starts_at = now() + make_interval(mins => $2),
            ends_at = now() + make_interval(mins => $2) + interval '1 hour'
      where id = $1`,
    [consultaId, minutos],
  );
}

/**
 * Cria a ação à mão, já vencida.
 *
 * Necessário quando a consulta tem de estar no passado: mover `starts_at` dispara
 * o trigger de régua, que CANCELA as ações pendentes daquela consulta e só recria
 * as que ainda caem no futuro. Então o caminho honesto é posicionar a consulta
 * primeiro e declarar a ação depois.
 */
async function criarAcao(consultaId: string, kind: string): Promise<void> {
  await owner.query(
    `insert into app.scheduled_actions (clinic_id, kind, appointment_id, due_at)
     values ($1, $2::app.action_kind, $3, now() - interval '1 minute')`,
    [c.clinicA, kind, consultaId],
  );
}

/**
 * Deixa só um tipo de ação e vence tudo.
 *
 * Isolar o tipo não é conveniência: com a régua inteira vencida, `marcar_risco`
 * roda primeiro (ordem de due_at), muda a consulta para `em_risco`, e aí a
 * confirmação sai como "ok, nada a fazer" — o teste passaria a medir outra coisa.
 */
async function sobraApenas(kind: string): Promise<void> {
  await owner.query(`delete from app.scheduled_actions where kind <> $1`, [kind]);
  await owner.query(`update app.scheduled_actions set due_at = now() - interval '1 minute'`);
}

async function statusDasAcoes(kind?: string): Promise<string[]> {
  const { rows } = await owner.query<{ status: string }>(
    `select status from app.scheduled_actions ${kind === undefined ? '' : 'where kind = $1'} order by kind`,
    kind === undefined ? [] : [kind],
  );
  return rows.map((l) => l.status);
}

async function alertas(): Promise<string[]> {
  const { rows } = await owner.query<{ kind: string }>(
    'select kind from app.alerts order by created_at',
  );
  return rows.map((l) => l.kind);
}

describe('a credencial cai', () => {
  it('marca o número em erro e abre UM alerta, não um por ação', async () => {
    // Três consultas de amanhã: três confirmações que vão descobrir a falha.
    await consulta(c.patients[0]!, 26 * 60);
    await consulta(c.patients[1]!, 27 * 60);
    await consulta(c.patients[2]!, 28 * 60);
    await sobraApenas('confirmacao');

    const r = await rodarUmaVez({ db, whatsapp: new SemCredencial() });

    expect(r.esperandoOWhatsapp).toBeGreaterThanOrEqual(3);
    expect(await alertas(), 'um alerta por causa, não um por ação').toEqual(['whatsapp_fora']);

    const { rows } = await owner.query<{ status: string }>(
      `select status from app.whatsapp_numbers where phone_number_id = $1`,
      [PN],
    );
    expect(rows[0]?.status).toBe('erro');
  });

  it('as ações voltam a esperar, e não queimam como erro', async () => {
    await consulta(c.patients[0]!, 26 * 60);
    await sobraApenas('confirmacao');
    await rodarUmaVez({ db, whatsapp: new SemCredencial() });

    expect(await statusDasAcoes('confirmacao')).toEqual(['pendente']);
  });

  it('a queda não come o orçamento de retentativa da ação', async () => {
    await consulta(c.patients[0]!, 26 * 60);
    await sobraApenas('confirmacao');
    await rodarUmaVez({ db, whatsapp: new SemCredencial() });

    const { rows } = await owner.query<{ attempts: number }>(
      `select attempts from app.scheduled_actions where kind = 'confirmacao'`,
    );
    expect(rows[0]?.attempts, 'o claim somou 1 e a devolução tirou 1').toBe(0);
  });
});

describe('com o número em erro, o claim não consome a pilha', () => {
  beforeEach(async () => {
    await owner.query(
      `update app.whatsapp_numbers set status = 'erro' where phone_number_id = $1`,
      [PN],
    );
  });

  it('três ações de envio vencidas: nenhuma reclamada, nenhuma tentativa, nenhum alerta novo', async () => {
    await consulta(c.patients[0]!, 26 * 60);
    await consulta(c.patients[1]!, 27 * 60);
    await consulta(c.patients[2]!, 28 * 60);
    await sobraApenas('confirmacao');

    const r = await rodarUmaVez({ db, whatsapp });

    expect(r.pegas, 'ação de envio foi reclamada com o número em erro').toBe(0);
    expect(whatsapp.enviados, 'tentou enviar sem número').toHaveLength(0);
    expect(await alertas()).toEqual([]);
    expect(new Set(await statusDasAcoes('confirmacao'))).toEqual(new Set(['pendente']));
  });

  /**
   * O outro lado da moeda: `marcar_risco` não envia nada, e por isso continua
   * rodando. Segurar tudo deixaria o painel sem saber que a consulta está sem
   * confirmação — o que é justamente a informação de que a recepção precisa
   * enquanto o WhatsApp está fora.
   */
  it('marcar_risco continua sendo reclamada e executada', async () => {
    await consulta(c.patients[0]!, 26 * 60);
    await sobraApenas('marcar_risco');

    const r = await rodarUmaVez({ db, whatsapp });

    expect(r.pegas).toBe(1);
    expect(await statusDasAcoes('marcar_risco')).toEqual(['feito']);
    expect(await alertas()).toEqual(['consulta_em_risco']);
  });

  it('o número volta a conectado e a pilha retoma', async () => {
    await consulta(c.patients[0]!, 26 * 60);
    await sobraApenas('confirmacao');
    expect((await rodarUmaVez({ db, whatsapp })).pegas).toBe(0);

    await owner.query(
      `update app.whatsapp_numbers set status = 'conectado' where phone_number_id = $1`,
      [PN],
    );

    const r = await rodarUmaVez({ db, whatsapp });
    expect(r.pegas).toBeGreaterThanOrEqual(1);
    expect(whatsapp.enviados.length, 'a confirmação saiu quando o número voltou').toBeGreaterThan(
      0,
    );
  });
});

describe('retomar não é reexecutar', () => {
  /**
   * A pilha represada é reclamada de uma vez quando o número volta, e uma ação que
   * fazia sentido às 2h pode não fazer mais às 9h. Duas confirmações: uma de
   * consulta que ainda é amanhã, outra de consulta que venceu durante a queda.
   */
  it('a que ainda vale é enviada; a que venceu termina em sem_proposito, sem alerta', async () => {
    const amanha = await consulta(c.patients[0]!, 30 * 60);
    const jaHoje = await consulta(c.patients[1]!, 32 * 60);
    // Dentro de meia hora: a confirmação diria "amanhã", e isso já é falso.
    await moverPara(jaHoje, 30);

    // As duas ações são declaradas aqui, e não pelo trigger: assim o teste mede a
    // pertinência e nada mais.
    await owner.query('delete from app.scheduled_actions');
    await criarAcao(amanha, 'confirmacao');
    await criarAcao(jaHoje, 'confirmacao');

    const r = await rodarUmaVez({ db, whatsapp });

    expect(r.semProposito).toBe(1);
    expect(r.feitas).toBe(1);
    expect(whatsapp.enviados, 'saiu mensagem para a consulta vencida').toHaveLength(1);
    expect(await alertas(), 'descarte não é falha, e não alerta').toEqual([]);

    const { rows } = await owner.query<{ id: string; status: string }>(
      `select appointment_id as id, status from app.scheduled_actions where kind = 'confirmacao'`,
    );
    const porConsulta = new Map(rows.map((l) => [l.id, l.status]));
    expect(porConsulta.get(amanha)).toBe('feito');
    expect(porConsulta.get(jaHoje)).toBe('sem_proposito');
  });

  it('consulta que já começou nunca recebe mensagem', async () => {
    const passada = await consulta(c.patients[0]!, 30 * 60);
    await moverPara(passada, -120);
    await owner.query('delete from app.scheduled_actions');
    await criarAcao(passada, 'confirmacao');

    await rodarUmaVez({ db, whatsapp });

    expect(whatsapp.enviados).toHaveLength(0);
    expect(await statusDasAcoes('confirmacao')).toEqual(['sem_proposito']);
  });
});

describe('desconectar cancela em bloco', () => {
  it('as ações de envio pendentes viram cancelado, e marcar_risco fica', async () => {
    const { acoes } = await import('@fliqo/db');
    await consulta(c.patients[0]!, 26 * 60);

    const canceladas = await withClinic(
      c.clinicA,
      (trx) => acoes.cancelarEnviosPendentes(trx, c.clinicA),
      db,
    );

    expect(canceladas).toBeGreaterThanOrEqual(1);
    const { rows } = await owner.query<{ kind: string; status: string }>(
      'select kind, status from app.scheduled_actions order by kind',
    );
    for (const l of rows) {
      if (l.kind === 'marcar_risco') {
        expect(l.status, 'marcar_risco não envia e continua valendo').toBe('pendente');
      } else {
        expect(l.status, `${l.kind} devia ter sido cancelada`).toBe('cancelado');
      }
    }
  });
});
