import { criarDb, operador, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { cifrar } from '@fliqo/whatsapp';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rodarUmaVez } from '../src/acoes';
import { iniciarLacoDeAcoes, type LacoDeAcoes } from '../src/laco-de-acoes';
import { criarParada } from '../src/parada';
import { JANELA_DE_SAUDE_MS, servidorDeSaude } from '../src/saude';
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
 * Então este arquivo não monta a medida à mão — roda o LAÇO de produção (`iniciarLacoDeAcoes`,
 * o mesmo que o `index.ts` chama) por uma volta e pergunta ao servidor de saúde. Claim
 * suprimindo de verdade, medida tirada pelo laço que suprimiu, veredito traduzido em código
 * HTTP: é nas emendas que esse tipo de defeito vive, e antes a emenda do laço só era guardada
 * por um teste que lia o texto do `index.ts`.
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

/**
 * Uma volta, exatamente uma, do laço de produção.
 *
 * A parada é pedida logo depois de iniciar: a primeira volta já começou (o laço chama a tarefa
 * antes do primeiro `await`), termina inteira, e o laço sai em vez de dormir 30 s.
 */
async function umaVolta(agora: () => number = Date.now): Promise<LacoDeAcoes> {
  const parada = criarParada();
  const laco = iniciarLacoDeAcoes({
    parada,
    db,
    whatsapp: new WhatsappFalso(),
    log: pino({ level: 'silent' }),
    agora,
  });
  parada.pedir();
  await laco.terminou;
  // Volta que falhou cai em `aoFalhar` e não mede: sem esta linha, o erro viraria "verde".
  expect(laco.entrega.ultima(), 'a volta não chegou a medir').toBeDefined();
  return laco;
}

/** Pergunta ao servidor de saúde, ligado ao batimento e à medida que o laço marcou. */
async function perguntar(
  laco: LacoDeAcoes,
  rota: '/estado' | '/health',
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const servidor = servidorDeSaude({
    porta: 0,
    batimentos: { acoes: laco.batimento },
    entrega: laco.entrega,
  });
  try {
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${String(port)}${rota}`);
    return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
  } finally {
    servidor.close();
  }
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

  it('uma volta do laço mede as trinta represadas', async () => {
    await numero('erro');
    await acoesVencidas(QUANTAS);

    const laco = await umaVolta();
    expect(laco.entrega.ultima()?.vencidasRepresadas).toBe(QUANTAS);
  });

  it('e o /estado NÃO responde verde', async () => {
    await numero('erro');
    await acoesVencidas(QUANTAS);

    const r = await perguntar(await umaVolta(), '/estado');
    expect(r.status).not.toBe(200);
    expect(r.corpo).toMatchObject({
      estado: 'degradado',
      entrega: { vencidasRepresadas: QUANTAS },
      causa: '30 ação(ões) de envio vencida(s) que não saíram',
    });
  });

  it('mas também não responde 503: o worker está de pé, o que falta é credencial', async () => {
    // Token expirado represa envio por HORAS, com o laço batendo. 503 diria que o processo
    // parou, e ele não parou.
    await numero('erro');
    await acoesVencidas(QUANTAS);

    expect((await perguntar(await umaVolta(), '/estado')).status).toBe(207);
  });

  it('e o /health, no mesmo instante, continua 200: ele só diz que o processo está de pé', async () => {
    await numero('erro');
    await acoesVencidas(QUANTAS);

    const r = await perguntar(await umaVolta(), '/health');
    expect(r.status).toBe(200);
    expect(r.corpo).toEqual({ ok: true });
  });
});

describe('a medida sai da volta do laço', () => {
  it('é tirada DEPOIS da rodada: o que a rodada resolveu não conta', async () => {
    await numero('conectado');
    // Três, e não trinta: aqui o que se prova é que a fila ESVAZIA e a medida acompanha.
    await acoesVencidas(3);
    // A precondição: antes da volta, as três estão represadas. Medir antes da rodada daria 3.
    expect(await operador.vencidasRepresadas(db)).toBe(3);

    // As ações não têm consulta, então cada uma falha como 'sem consulta' e é definitiva —
    // o que importa é que saem de `pendente`, que é o que a medida conta.
    const laco = await umaVolta();
    expect(laco.entrega.ultima()?.vencidasRepresadas).toBe(0);
  });

  it('e com o número conectado o /estado volta ao verde', async () => {
    await numero('conectado');
    await acoesVencidas(3);

    const r = await perguntar(await umaVolta(), '/estado');
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ estado: 'verde', causa: null });
  });

  it('a volta marca o batimento e a medida no relógio do laço', async () => {
    // Número em erro: nenhuma ação é pega, então `aoProgredir` não bate. Quem marca o
    // batimento aqui é a própria volta — e é isso que se prova.
    await numero('erro');
    await acoesVencidas(QUANTAS);

    let relogio = 0;
    const parada = criarParada();
    const laco = iniciarLacoDeAcoes({
      parada,
      db,
      whatsapp: new WhatsappFalso(),
      log: pino({ level: 'silent' }),
      agora: () => relogio,
    });
    // O batimento nasceu em 0. Tudo o que a volta marcar daqui em diante sai em 2 janelas.
    relogio = 2 * JANELA_DE_SAUDE_MS;
    parada.pedir();
    await laco.terminou;

    expect(laco.batimento.ultimo()).toBe(2 * JANELA_DE_SAUDE_MS);
    expect(laco.entrega.ultima()?.emMs).toBe(2 * JANELA_DE_SAUDE_MS);
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
