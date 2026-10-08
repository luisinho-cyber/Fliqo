import { acoes, criarDb, withClinic, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { TEMPLATES } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rodarUmaVez } from '../src/acoes';
import { quandoDaConsulta } from '../src/titulos-de-alerta';
import { WhatsappFalso } from './fake';

/**
 * A ação que volta para a fila depois de já ter mandado a mensagem não manda de novo.
 *
 * Antes da 0017, o único registro de que a confirmação saiu era o `status = 'feito'`. Ação
 * que voltava a `pendente` — requeue, dois workers, recepção reenviando — era executada do
 * zero, e o paciente recebia a mesma confirmação duas vezes.
 */

let db: Db;
let owner: pg.Pool;
let c: Scenario;
let whatsapp: WhatsappFalso;

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.whatsapp_numbers (clinic_id, phone_number_id) values ($1, '555000333444')`,
    [c.clinicA],
  );
  await owner.query('update app.patients set whatsapp_consent_at = now() where id = $1', [
    c.patients[0],
  ]);
  db = criarDb(urlDoTester());
}, 90_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  whatsapp = new WhatsappFalso();
  await owner.query('delete from app.envios');
  await owner.query('delete from app.scheduled_actions');
  await owner.query('delete from app.appointments');
});

/** Consulta daqui a 30 h; o gatilho cria a régua, e a confirmação já vence. */
async function consultaComConfirmacaoVencida(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
     values ($1, $2, $3, $4, now() + interval '30 hours', now() + interval '31 hours', 25000)
     returning id`,
    [c.clinicA, c.profA, c.patients[0], c.procEletivo],
  );
  await owner.query(
    `update app.scheduled_actions set due_at = now() - interval '1 minute'
      where kind = 'confirmacao'`,
  );
  return rows[0]?.id ?? '';
}

/** A ação volta para a fila, como faria um requeue ou a recepção reenviando. */
async function devolverAFila(): Promise<void> {
  await owner.query(
    `update app.scheduled_actions set status = 'pendente', due_at = now() - interval '1 minute'
      where kind = 'confirmacao'`,
  );
}

async function inicioDa(consulta: string): Promise<Date> {
  const { rows } = await owner.query<{ starts_at: Date }>(
    'select starts_at from app.appointments where id = $1',
    [consulta],
  );
  return rows[0]?.starts_at ?? new Date(0);
}

async function statusDaConfirmacao(): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    `select status from app.scheduled_actions where kind = 'confirmacao'`,
  );
  return rows[0]?.status;
}

describe('a confirmação que já saiu e voltou para a fila', () => {
  it('não é enviada de novo, e a ação termina feita', async () => {
    await consultaComConfirmacaoVencida();

    await rodarUmaVez({ db, whatsapp });
    expect(whatsapp.enviados).toHaveLength(1);

    await devolverAFila();
    const r = await rodarUmaVez({ db, whatsapp });

    expect(whatsapp.enviados).toHaveLength(1);
    expect(r.repeticoesEvitadas).toBe(1);
    expect(await statusDaConfirmacao()).toBe('feito');
  });

  it('o envio fica gravado com o wamid que a Meta devolveu', async () => {
    const consulta = await consultaComConfirmacaoVencida();
    await rodarUmaVez({ db, whatsapp });

    const { rows } = await owner.query<{ template_name: string; wamid: string }>(
      'select template_name, wamid from app.envios where appointment_id = $1',
      [consulta],
    );
    expect(rows).toEqual([{ template_name: TEMPLATES.confirmacao.nome, wamid: 'wamid.FALSO.1' }]);
  });
});

describe('o envio que NÃO saiu não trava o próximo', () => {
  it('falha temporária desfaz a reserva, e a próxima tentativa envia', async () => {
    await consultaComConfirmacaoVencida();
    // As quatro tentativas do cliente falham: a ação volta para a fila com espera.
    whatsapp.falharComTemporario(1);
    await rodarUmaVez({ db, whatsapp });
    expect(whatsapp.enviados).toHaveLength(0);
    expect(await statusDaConfirmacao()).toBe('pendente');

    await devolverAFila();
    await rodarUmaVez({ db, whatsapp });
    expect(whatsapp.enviados).toHaveLength(1);
    expect(await statusDaConfirmacao()).toBe('feito');
  });
});

describe('envio incerto: a mensagem pode ter saído', () => {
  it('não repete, para em erro, e a recepção é avisada para conferir', async () => {
    const consulta = await consultaComConfirmacaoVencida();
    const inicio = await inicioDa(consulta);
    whatsapp.roteiro.push({ ok: false, motivo: 'incerto', detalhe: 'conexão caiu' });

    const r = await rodarUmaVez({ db, whatsapp });
    expect(r.incertas).toBe(1);
    expect(await statusDaConfirmacao()).toBe('erro');

    const { rows } = await owner.query<{ title: string }>(
      `select title from app.alerts where kind = 'acao_falhou'`,
    );
    // Quem e quando, no fuso da clínica: a recepção sabe qual consulta conferir.
    expect(rows.map((l) => l.title)).toEqual([
      `Não sei se a confirmação chegou para Paciente 1 — consulta ${quandoDaConsulta(inicio, 'America/Sao_Paulo')}`,
    ]);

    // O botão "Reenviar" mora no bloco de descartes, e a API só reenvia ação descartada.
    // A incerta fica FORA desse bloco: botão que aparece e responde 404 é pior que nenhum.
    const descartes = await withClinic(
      c.clinicA,
      (trx) => acoes.descartadasNoDia(trx, new Date(0), new Date(Date.now() + 7 * 86_400_000)),
      db,
    );
    expect(descartes).toEqual([]);

    // A volta seguinte não pega a ação de novo: é o "não repetir".
    await rodarUmaVez({ db, whatsapp });
    expect(whatsapp.enviados).toHaveLength(0);
  });
});

describe('falha definitiva: o alerta também diz quem e quando', () => {
  it('template recusado vira alerta com o paciente e o horário, e aponta para eles', async () => {
    const consulta = await consultaComConfirmacaoVencida();
    const inicio = await inicioDa(consulta);
    whatsapp.falharComRecusa();
    await rodarUmaVez({ db, whatsapp });

    const { rows } = await owner.query<{
      title: string;
      appointment_id: string | null;
      patient_id: string | null;
    }>(`select title, appointment_id, patient_id from app.alerts where kind = 'acao_falhou'`);
    expect(rows).toEqual([
      {
        title: `Não consegui enviar a confirmação para Paciente 1 — consulta ${quandoDaConsulta(inicio, 'America/Sao_Paulo')}`,
        appointment_id: consulta,
        patient_id: c.patients[0],
      },
    ]);
  });
});
