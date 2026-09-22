import { createHmac } from 'node:crypto';
import { criarDb, withClinic, type Db } from '@fliqo/db';
import { criarFila, FILA_BOTAO, FILA_CONVERSA, SCHEMA_FILA } from '@fliqo/db/fila';
import {
  ownerPool,
  prepararFilaDeTeste,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';

const SEGREDO = 'segredo-do-app-da-meta';
const TOKEN_VERIFICACAO = 'token-de-verificacao';
const PHONE_NUMBER_ID = '109876543210987';

const config: Config = {
  DATABASE_URL: 'nao-usado-no-teste',
  WHATSAPP_APP_SECRET: SEGREDO,
  WHATSAPP_VERIFY_TOKEN: TOKEN_VERIFICACAO,
  SUPABASE_JWT_SECRET: 'segredo-jwt-de-teste',
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

function assinar(corpo: string): string {
  return `sha256=${createHmac('sha256', SEGREDO).update(corpo).digest('hex')}`;
}

function eventoDeTexto(wamid: string, de: string, texto: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [{ id: wamid, from: de, type: 'text', text: { body: texto } }],
            },
          },
        ],
      },
    ],
  });
}

async function postar(corpo: string, assinatura?: string) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      ...(assinatura === undefined ? {} : { 'x-hub-signature-256': assinatura }),
    },
    payload: corpo,
  });
}

async function jobsDaConversa(conversaId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `select count(*) as n from ${SCHEMA_FILA}.job where name = $1 and singleton_key = $2`,
    [FILA_CONVERSA, conversaId],
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.whatsapp_numbers (clinic_id, phone_number_id, display_phone_e164)
     values ($1, $2, '+5511333322221')`,
    [c.clinicA, PHONE_NUMBER_ID],
  );

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

describe('verificação da Meta', () => {
  it('devolve o challenge quando o token confere', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN_VERIFICACAO}&hub.challenge=12345`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('12345');
  });

  it('recusa token errado', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=12345',
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('assinatura', () => {
  it('assinatura inválida devolve 401', async () => {
    const corpo = eventoDeTexto('wamid.X1', '5511999990001', 'oi');
    const r = await postar(
      corpo,
      'sha256=00000000000000000000000000000000000000000000000000000000000000',
    );
    expect(r.statusCode).toBe(401);
  });

  it('assinatura de outro segredo devolve 401', async () => {
    const corpo = eventoDeTexto('wamid.X2', '5511999990001', 'oi');
    const outra = `sha256=${createHmac('sha256', 'segredo-errado').update(corpo).digest('hex')}`;
    const r = await postar(corpo, outra);
    expect(r.statusCode).toBe(401);
  });

  it('sem cabeçalho de assinatura devolve 401', async () => {
    const corpo = eventoDeTexto('wamid.X3', '5511999990001', 'oi');
    const r = await postar(corpo);
    expect(r.statusCode).toBe(401);
  });

  it('corpo alterado depois de assinado devolve 401', async () => {
    // Assina um corpo e envia outro: é o ataque que a assinatura existe para barrar.
    const assinado = eventoDeTexto('wamid.ORIGINAL', '5511999990001', 'confirmo');
    const adulterado = eventoDeTexto('wamid.ORIGINAL', '5511999990001', 'cancela minha consulta');

    const r = await postar(adulterado, assinar(assinado));
    expect(r.statusCode).toBe(401);

    // E nada do corpo adulterado foi gravado.
    const { rows } = await owner.query('select id from app.messages where wamid = $1', [
      'wamid.ORIGINAL',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('assinatura calculada sobre o corpo bruto é aceita', async () => {
    const corpo = eventoDeTexto('wamid.OK1', '5511999990001', 'quero marcar');
    const r = await postar(corpo, assinar(corpo));
    expect(r.statusCode).toBe(200);
  });

  it('o hash é do corpo bruto, não do JSON reserializado', async () => {
    // Mesmo objeto, espaçamento diferente: a Meta assinaria ESTE texto.
    const corpo = `{"object":"whatsapp_business_account",  "entry":[{"changes":[{"value":{"metadata":{"phone_number_id":"${PHONE_NUMBER_ID}"},"messages":[{"id":"wamid.BRUTO","from":"5511999990001","type":"text","text":{"body":"oi"}}]}}]}]}`;
    const r = await postar(corpo, assinar(corpo));
    expect(r.statusCode).toBe(200);
  });
});

describe('gravação e fila', () => {
  it('grava a mensagem, cria paciente "a confirmar" e enfileira', async () => {
    const corpo = eventoDeTexto('wamid.NOVA1', '5511911112222', 'bom dia');
    const r = await postar(corpo, assinar(corpo));
    expect(r.statusCode).toBe(200);

    const estado = await withClinic(
      c.clinicA,
      async (trx) => {
        const paciente = await trx
          .selectFrom('app.patients')
          .selectAll()
          .where('phone_e164', '=', '+5511911112222')
          .executeTakeFirstOrThrow();
        const conversa = await trx
          .selectFrom('app.conversations')
          .selectAll()
          .where('patient_id', '=', paciente.id)
          .executeTakeFirstOrThrow();
        const mensagens = await trx
          .selectFrom('app.messages')
          .selectAll()
          .where('conversation_id', '=', conversa.id)
          .execute();
        return { paciente, conversa, mensagens };
      },
      db,
    );

    expect(estado.paciente.name).toBe('a confirmar');
    expect(estado.paciente.whatsapp_consent_at).toBeNull();
    expect(estado.mensagens).toHaveLength(1);
    expect(estado.mensagens[0]?.body).toBe('bom dia');
    expect(estado.conversa.last_inbound_at).not.toBeNull();
    expect(await jobsDaConversa(estado.conversa.id)).toBe(1);
  });

  it('o mesmo wamid duas vezes grava uma mensagem só e não enfileira de novo', async () => {
    const corpo = eventoDeTexto('wamid.REPETIDA', '5511922223333', 'oi de novo');

    const primeira = await postar(corpo, assinar(corpo));
    const segunda = await postar(corpo, assinar(corpo));

    // As duas respondem 200: recusar faria a Meta reenviar para sempre.
    expect(primeira.statusCode).toBe(200);
    expect(segunda.statusCode).toBe(200);

    const { conversaId, quantas } = await withClinic(
      c.clinicA,
      async (trx) => {
        const paciente = await trx
          .selectFrom('app.patients')
          .selectAll()
          .where('phone_e164', '=', '+5511922223333')
          .executeTakeFirstOrThrow();
        const conversa = await trx
          .selectFrom('app.conversations')
          .selectAll()
          .where('patient_id', '=', paciente.id)
          .executeTakeFirstOrThrow();
        const msgs = await trx
          .selectFrom('app.messages')
          .selectAll()
          .where('wamid', '=', 'wamid.REPETIDA')
          .execute();
        return { conversaId: conversa.id, quantas: msgs.length };
      },
      db,
    );

    expect(quantas).toBe(1);
    expect(await jobsDaConversa(conversaId)).toBe(1);
  });

  it('duas mensagens seguidas da mesma conversa não viram dois processamentos', async () => {
    const um = eventoDeTexto('wamid.SEQ1', '5511933334444', 'oi');
    const dois = eventoDeTexto('wamid.SEQ2', '5511933334444', 'tem horário amanhã?');
    await postar(um, assinar(um));
    await postar(dois, assinar(dois));

    const conversaId = await withClinic(
      c.clinicA,
      async (trx) => {
        const paciente = await trx
          .selectFrom('app.patients')
          .selectAll()
          .where('phone_e164', '=', '+5511933334444')
          .executeTakeFirstOrThrow();
        const conversa = await trx
          .selectFrom('app.conversations')
          .selectAll()
          .where('patient_id', '=', paciente.id)
          .executeTakeFirstOrThrow();
        const msgs = await trx
          .selectFrom('app.messages')
          .selectAll()
          .where('conversation_id', '=', conversa.id)
          .execute();
        expect(msgs).toHaveLength(2);
        return conversa.id;
      },
      db,
    );

    // As duas mensagens estão gravadas, mas a fila tem UM job para a conversa:
    // é a regra 7 do CLAUDE.md, garantida pela política stately da fila.
    expect(await jobsDaConversa(conversaId)).toBe(1);
  });

  it('número que não é de nenhuma clínica responde 200 sem gravar nada', async () => {
    const corpo = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'numero-desconhecido' },
                messages: [
                  { id: 'wamid.ORFA', from: '5511999998888', type: 'text', text: { body: 'oi' } },
                ],
              },
            },
          ],
        },
      ],
    });
    const r = await postar(corpo, assinar(corpo));
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query('select id from app.messages where wamid = $1', [
      'wamid.ORFA',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('mesmo celular com e sem o nono dígito cai na mesma ficha', async () => {
    // A Meta entrega número brasileiro antigo sem o 9. Sem normalizar, o mesmo
    // paciente viraria duas fichas, com duas conversas e dois históricos.
    const comNove = eventoDeTexto('wamid.NOVE1', '5511987651234', 'oi');
    const semNove = eventoDeTexto('wamid.NOVE2', '551187651234', 'esqueci de dizer o nome');
    await postar(comNove, assinar(comNove));
    await postar(semNove, assinar(semNove));

    const { rows } = await owner.query<{ id: string; phone_e164: string }>(
      `select id, phone_e164 from app.patients where phone_e164 = $1`,
      ['+5511987651234'],
    );
    expect(rows).toHaveLength(1);

    const conversas = await owner.query('select id from app.conversations where patient_id = $1', [
      rows[0]?.id,
    ]);
    expect(conversas.rows).toHaveLength(1);

    const msgs = await owner.query(
      `select id from app.messages where wamid in ('wamid.NOVE1', 'wamid.NOVE2')`,
    );
    expect(msgs.rows).toHaveLength(2);
  });

  it('telefone impossível não grava nada e ainda responde 200', async () => {
    const corpo = eventoDeTexto('wamid.RUIM', '123', 'oi');
    const r = await postar(corpo, assinar(corpo));
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query('select id from app.messages where wamid = $1', [
      'wamid.RUIM',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('resposta de botão vai para a fila do botão, não para a da IA', async () => {
    const corpo = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [
                  {
                    id: 'wamid.BOTAO1',
                    from: '5511966665555',
                    type: 'interactive',
                    interactive: { button_reply: { id: 'CONFIRMAR_CONSULTA' } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const r = await postar(corpo, assinar(corpo));
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query<{ name: string; data: { payloadBotao?: string } }>(
      `select name, data from ${SCHEMA_FILA}.job where data->>'payloadBotao' = 'CONFIRMAR_CONSULTA'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(FILA_BOTAO);

    // O payload do botão é o que fica gravado como corpo — é o que
    // interpretarResposta() entende na volta.
    const { rows: msgs } = await owner.query<{ body: string }>(
      `select body from app.messages where wamid = 'wamid.BOTAO1'`,
    );
    expect(msgs[0]?.body).toBe('CONFIRMAR_CONSULTA');
  });

  it('mensagem de texto continua indo para a fila da conversa', async () => {
    const corpo = eventoDeTexto('wamid.TEXTO1', '5511955556666', 'bom dia');
    await postar(corpo, assinar(corpo));

    const { rows } = await owner.query<{ name: string }>(
      `select j.name from ${SCHEMA_FILA}.job j
         join app.conversations cv on cv.id::text = j.singleton_key
         join app.patients p on p.id = cv.patient_id
        where p.phone_e164 = '+5511955556666'`,
    );
    expect(rows[0]?.name).toBe(FILA_CONVERSA);
  });

  it('responde em menos de 1 s', async () => {
    const corpo = eventoDeTexto('wamid.RAPIDA', '5511944445555', 'oi');
    const antes = Date.now();
    const r = await postar(corpo, assinar(corpo));
    const levou = Date.now() - antes;

    expect(r.statusCode).toBe(200);
    expect(levou).toBeLessThan(1000);
  });
});
