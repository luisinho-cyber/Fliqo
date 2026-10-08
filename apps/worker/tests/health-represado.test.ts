import { criarDb, operador, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { cifrar } from '@fliqo/whatsapp';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rodarUmaVez } from '../src/acoes';
import { CODIGO_POR_ESTADO, criarBatimento, criarEntrega, vereditoDeSaude } from '../src/saude';
import { WhatsappFalso } from './fake';

/**
 * O caso que o enunciado nomeou: número em erro, trinta ações pendentes, estado não verde.
 *
 * O veredito mora em `/estado`. O `/health` é liveness e não sabe de entrega (saude.test.ts).
 *
 * Ele existe porque o sinal andava na direção CONTRÁRIA do problema. O batimento é marcado a
 * cada ação concluída e a cada volta do laço; com o número em erro, o `claim_due_actions`
 * deixa de reclamar as ações de envio daquela clínica, a rodada termina limpa e rápida, e o
 * batimento bate. Suprimir o envio melhorava o sinal.
 *
 * Então este arquivo não testa a função de medida isolada — testa a cadeia inteira: claim
 * suprimindo de verdade, medida tirada pelo laço que suprimiu, veredito traduzido em código
 * HTTP. É nas emendas que esse tipo de defeito vive.
 */

const PN = '555000999888';
const QUANTAS = 30;

let db: Db;
let owner: pg.Pool;
let c: Scenario;

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
  await owner.query('delete from app.scheduled_actions');
  await owner.query('delete from app.alerts');
  await owner.query('delete from app.whatsapp_numbers');
});

/** O número da clínica, no estado pedido. Token cifrado de verdade por causa do check da 0005. */
async function numero(status: 'conectado' | 'erro'): Promise<void> {
  const g = cifrar('TOKEN-FALSO-DE-TESTE', randomBytes(32));
  await owner.query(
    `insert into app.whatsapp_numbers
       (clinic_id, phone_number_id, status, active, token_ciphertext, token_iv, token_tag, token_updated_at)
     values ($1,$2,$3,true,$4,$5,$6, now())`,
    [c.clinicA, PN, status, g.ciphertext, g.iv, g.tag],
  );
}

/** N ações de envio vencidas, sem consulta: o claim não lê `appointments`. */
async function acoesVencidas(quantas: number): Promise<void> {
  await owner.query(
    `insert into app.scheduled_actions (clinic_id, kind, due_at)
     select $1, 'confirmacao', now() - interval '5 minutes'
       from generate_series(1, $2::int)`,
    [c.clinicA, quantas],
  );
}

/** O veredito como o /estado o produziria, com a medida tirada agora pelo laço. */
async function vereditoAgora(): Promise<{ estado: string; codigo: number; represadas: number }> {
  const agoraMs = Date.now();
  const entrega = criarEntrega();
  const represadas = await operador.vencidasRepresadas(db);
  entrega.marcar(represadas, agoraMs);

  const v = vereditoDeSaude(
    { batimentos: { acoes: criarBatimento(() => agoraMs) }, entrega },
    agoraMs,
  );
  return { estado: v.estado, codigo: CODIGO_POR_ESTADO[v.estado], represadas };
}

describe('número em erro com trinta ações pendentes', () => {
  it('o claim não reclama nenhuma: é a supressão de propósito da 0010', async () => {
    await numero('erro');
    await acoesVencidas(QUANTAS);

    const r = await rodarUmaVez({ db, whatsapp: new WhatsappFalso() });

    // A rodada termina LIMPA, e é esse o problema que o sinal tinha de parar de premiar.
    expect(r.pegas).toBe(0);
    expect(r.falhas).toBe(0);
  });

  it('a medida enxerga as trinta represadas', async () => {
    await numero('erro');
    await acoesVencidas(QUANTAS);
    await rodarUmaVez({ db, whatsapp: new WhatsappFalso() });

    expect(await operador.vencidasRepresadas(db)).toBe(QUANTAS);
  });

  it('e o /estado NÃO responde verde', async () => {
    await numero('erro');
    await acoesVencidas(QUANTAS);
    await rodarUmaVez({ db, whatsapp: new WhatsappFalso() });

    const v = await vereditoAgora();
    expect(v.represadas).toBe(QUANTAS);
    expect(v.estado).toBe('degradado');
    expect(v.codigo).not.toBe(200);
  });

  it('mas também não responde 503: o worker está de pé, o que falta é credencial', async () => {
    // Token expirado represa envio por HORAS, com o laço batendo. 503 diria que o processo
    // parou, e ele não parou.
    await numero('erro');
    await acoesVencidas(QUANTAS);
    await rodarUmaVez({ db, whatsapp: new WhatsappFalso() });

    const v = await vereditoAgora();
    expect(v.codigo).toBe(207);
    expect(v.codigo).toBeLessThan(300);
  });
});

describe('o número volta e o /estado volta ao verde', () => {
  it('com o número conectado, a rodada consome a fila e o estado é verde', async () => {
    await numero('conectado');
    // Três, e não trinta: aqui o que se prova é que a fila ESVAZIA e o estado acompanha.
    await acoesVencidas(3);

    // As ações não têm consulta, então cada uma falha como 'sem consulta' e é definitiva —
    // o que importa é que saem de `pendente`, que é o que a medida conta.
    await rodarUmaVez({ db, whatsapp: new WhatsappFalso() });

    const v = await vereditoAgora();
    expect(v.represadas).toBe(0);
    expect(v.estado).toBe('verde');
    expect(v.codigo).toBe(200);
  });
});

describe('o que a medida NÃO conta', () => {
  it('ação que ainda não venceu não é represamento', async () => {
    await numero('erro');
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       values ($1, 'confirmacao', now() + interval '2 hours')`,
      [c.clinicA],
    );
    expect(await operador.vencidasRepresadas(db)).toBe(0);
  });

  it('`marcar_risco` vencida não é represamento: ela não manda mensagem', async () => {
    // Quem decide é `app.action_kind_envia` (0010), não uma lista de nomes repetida na medida.
    await numero('erro');
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       values ($1, 'marcar_risco', now() - interval '5 minutes')`,
      [c.clinicA],
    );
    expect(await operador.vencidasRepresadas(db)).toBe(0);
  });

  it('ação em `executando` não é represamento: é ação na mão de um worker agora', async () => {
    // Contá-la faria toda rodada normal parecer represamento. Quem cuida de `executando`
    // preso é `requeue_stuck_actions` (0004).
    await numero('erro');
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at, status)
       values ($1, 'confirmacao', now() - interval '5 minutes', 'executando')`,
      [c.clinicA],
    );
    expect(await operador.vencidasRepresadas(db)).toBe(0);
  });

  it('a medida soma as clínicas, e não vaza qual é qual', async () => {
    // O /estado não diz clínica: a contagem é agregada de propósito. Quem precisa saber de QUAL
    // clínica recebe o e-mail do vigia de operador.
    await numero('erro');
    await acoesVencidas(2);
    await owner.query(
      `insert into app.scheduled_actions (clinic_id, kind, due_at)
       values ($1, 'confirmacao', now() - interval '5 minutes')`,
      [c.clinicB],
    );

    expect(await operador.vencidasRepresadas(db)).toBe(3);
  });
});
