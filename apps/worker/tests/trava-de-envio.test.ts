import { criarDb, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { TEMPLATES } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rodarUmaVez } from '../src/acoes';
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
