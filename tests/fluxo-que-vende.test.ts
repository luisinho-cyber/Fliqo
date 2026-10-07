import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PAYLOAD_BOTOES } from '@fliqo/core';
import { agenda, criarDb, withClinic, type Db, type Trx } from '@fliqo/db';
import { criarFila, FILA_BOTAO, SCHEMA_FILA } from '@fliqo/db/fila';
import { ownerPool, prepararFilaDeTeste, resetDatabase, urlDoTester } from '@fliqo/db/testing';
import { ClienteMeta, TEMPLATES, type Relogio } from '@fliqo/whatsapp';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../apps/api/src/app';
import type { Config } from '../apps/api/src/config';
import { rodarUmaVez } from '../apps/worker/src/acoes';
import { tratarResposta } from '../apps/worker/src/botao';

/**
 * O caminho que vende o produto, de ponta a ponta, numa ordem só.
 *
 * Os testes existentes cobrem cada peça: o webhook tem o seu, o claim tem o seu, a lista de
 * espera tem o seu. O que não existia era a prova de que as peças se encaixam — e é nas
 * emendas que este produto falha, porque cada emenda tem um dono diferente (o banco decide o
 * conflito, a Meta decide o envio, o worker decide a ordem).
 *
 * Nada aqui toca número de WhatsApp real: o `fetch` do `ClienteMeta` é substituído por um
 * Graph API falso. É o cliente VERDADEIRO com a borda HTTP trocada, de propósito — um
 * cliente falso provaria que o nosso fake funciona, não que o payload que sai está certo.
 *
 * Os `it` são ordenados e dependentes: é um caminho, não uma matriz de casos. `vitest.config`
 * roda um arquivo por vez (`fileParallelism: false`), e dentro do arquivo a ordem é a de
 * escrita.
 */

const SEGREDO_META = 'segredo-do-app-da-meta-para-teste';
const PHONE_NUMBER_ID = '109876543210987';
const TELEFONE_PACIENTE = '5511944445555';
const TELEFONE_DA_FILA = '5511955556666';

const config: Config = {
  DATABASE_URL: 'nao-usado-no-teste',
  WHATSAPP_APP_SECRET: SEGREDO_META,
  WHATSAPP_VERIFY_TOKEN: 'token-de-verificacao-de-teste',
  SUPABASE_JWT_SECRET: 'SEGREDO_FALSO_DE_TESTE_NAO_USE_1234567890',
  META_APP_ID: 'app-de-teste',
  META_APP_SECRET: 'segredo-do-app-de-teste',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

/** Uma chamada que o Graph API falso recebeu. Nunca sai desta máquina. */
interface ChamadaNaMeta {
  url: string;
  template?: string;
  variaveis: string[];
  botoes: string[];
  para?: string;
}

/** A janela do passo atual. Zerada entre passos, para cada um afirmar só o que ele causou. */
const naMeta: ChamadaNaMeta[] = [];
/** Nunca zerado: é contra ele que a guarda do fim confere que nada escapou da borda falsa. */
let totalDeChamadas = 0;
let wamidDaMeta = 0;

/**
 * O Graph API falso.
 *
 * Responde como a Meta responde a um envio aceito, e guarda o que recebeu para o teste
 * conferir NOME DE TEMPLATE, variáveis e ordem de botão — que é o que a clínica real perde
 * quando está errado.
 */
const graphFalso = ((url: string, init?: RequestInit) => {
  const corpo =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  const template = corpo['template'] as
    | {
        name?: string;
        components?: { type: string; parameters?: { text?: string; payload?: string }[] }[];
      }
    | undefined;
  const componentes = template?.components ?? [];
  naMeta.push({
    url,
    ...(template?.name === undefined ? {} : { template: template.name }),
    variaveis: (componentes.find((c) => c.type === 'body')?.parameters ?? []).map(
      (p) => p.text ?? '',
    ),
    botoes: componentes
      .filter((c) => c.type === 'button')
      .map((c) => c.parameters?.[0]?.payload ?? ''),
    ...(typeof corpo['to'] === 'string' ? { para: corpo['to'] } : {}),
  });
  totalDeChamadas++;
  wamidDaMeta++;
  return Promise.resolve(
    Response.json({ messages: [{ id: `wamid.DAMETA.${String(wamidDaMeta)}` }] }),
  );
}) as unknown as typeof fetch;

/** Relógio que não dorme: o limitador por número e o backoff tornariam o teste lento. */
const RELOGIO_PARADO: Relogio = { agora: () => 0, esperar: () => Promise.resolve() };

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let whatsapp: ClienteMeta;

/** O que o cenário cria no passo 1 e o resto do caminho usa. */
const cenario = {
  clinica: '',
  profissional: '',
  procedimento: '',
  paciente: '',
  daFila: '',
  consulta: '',
  inicio: new Date(),
};

function assinar(corpo: string): string {
  return `sha256=${createHmac('sha256', SEGREDO_META).update(corpo).digest('hex')}`;
}

/**
 * Posta no webhook como a Meta posta: corpo cru, assinado sobre o MESMO texto.
 *
 * Assinar o objeto reserializado passaria com HMAC validado sobre bytes que a Meta nunca
 * mandou — o `rawBody` existe exatamente para isso não acontecer.
 */
function postarWebhook(corpo: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': assinar(corpo),
    },
    payload: corpo,
  });
}

/** O evento de toque em botão, na forma que a Cloud API manda. */
function eventoDeBotao(wamid: string, payloadBotao: string, de = TELEFONE_PACIENTE): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  id: wamid,
                  from: de,
                  type: 'button',
                  button: { payload: payloadBotao, text: 'rótulo que o código ignora' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/**
 * Consome a fila de botão como o worker consome (`apps/worker/src/index.ts:53`).
 *
 * A lógica do consumidor é inline no `index.ts` e não dá para importar; estas três linhas
 * são as mesmas. Há um teste de guarda no fim deste arquivo que falha se o `index.ts`
 * deixar de chamar `tratarResposta` — sem ele, este caminho poderia testar algo que a
 * produção não faz.
 */
async function drenarFilaDeBotao(): Promise<number> {
  const { rows } = await owner.query<{
    id: string;
    data: { clinicId: string; pacienteId: string; payloadBotao: string };
  }>(`select id, data from ${SCHEMA_FILA}.job where name = $1 and state = 'created'`, [FILA_BOTAO]);

  for (const job of rows) {
    const { clinicId, pacienteId, payloadBotao } = job.data;
    await withClinic(
      clinicId,
      (trx) => tratarResposta(trx, whatsapp, { clinicId, pacienteId, payloadBotao }),
      db,
    );
  }
  // Marcar como consumido por SQL: o teste precisa saber quantos jobs NOVOS cada passo
  // criou, e um job que fica 'created' seria contado de novo no passo seguinte.
  if (rows.length > 0) {
    await owner.query(`delete from ${SCHEMA_FILA}.job where id = any($1::uuid[])`, [
      rows.map((r) => r.id),
    ]);
  }
  return rows.length;
}

function consulta(trx: Trx, id: string) {
  return trx.selectFrom('app.appointments').selectAll().where('id', '=', id).executeTakeFirst();
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  whatsapp = new ClienteMeta({
    token: 'token-falso-de-teste-nao-e-credencial',
    buscar: graphFalso,
    relogio: RELOGIO_PARADO,
  });
  app = construirApp({ config, db, boss });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

describe('1. a clínica existe, com profissional e procedimento', () => {
  /*
   * Criado por SQL do dono, e não pela API, porque na main não existe caminho de API para
   * criar clínica nem profissional: é o onboarding da Fase 7, e o cadastro de procedimentos
   * é o #30. Quando os dois mesclarem, este bloco troca de SQL para chamada de rota — e é o
   * único bloco deste arquivo que precisa mudar.
   */
  it('cria a clínica, o profissional, o procedimento e o número de WhatsApp', async () => {
    const { rows: clinicas } = await owner.query<{ id: string }>(
      `insert into app.clinics (name, timezone, confirm_hours_before)
       values ('Clínica do Caminho Feliz', 'America/Sao_Paulo', 24) returning id`,
    );
    cenario.clinica = clinicas[0]?.id ?? '';
    expect(cenario.clinica).not.toBe('');

    const { rows: profs } = await owner.query<{ id: string }>(
      `insert into app.professionals (clinic_id, name) values ($1, 'Dra. Helena') returning id`,
      [cenario.clinica],
    );
    cenario.profissional = profs[0]?.id ?? '';

    const { rows: procs } = await owner.query<{ id: string }>(
      `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
       values ($1, 'Limpeza e profilaxia', 45, 18000) returning id`,
      [cenario.clinica],
    );
    cenario.procedimento = procs[0]?.id ?? '';

    /*
     * O número da clínica. `active = true` é o que `numeros.ativoDaClinica` exige, e
     * `status` fica no padrão 'pendente' de propósito: 'conectado' exigiria token pelo
     * check `conectado_tem_token` (0005), e na main o envio usa o token do ambiente.
     * Nenhum número real, nenhum token real.
     */
    await owner.query(
      `insert into app.whatsapp_numbers (clinic_id, phone_number_id, active)
       values ($1, $2, true)`,
      [cenario.clinica, PHONE_NUMBER_ID],
    );

    expect(cenario.profissional).not.toBe('');
    expect(cenario.procedimento).not.toBe('');
  });

  it('cria o paciente COM consentimento, que é o que destrava mensagem ativa', async () => {
    // Sem `whatsapp_consent_at` o porteiro da LGPD (apps/worker/src/envio.ts) barra o envio
    // e abre alerta. O caminho que vende depende do consentimento existir.
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.patients (clinic_id, name, phone_e164, whatsapp_consent_at)
       values ($1, 'Maria', $2, now()) returning id`,
      [cenario.clinica, `+${TELEFONE_PACIENTE}`],
    );
    cenario.paciente = rows[0]?.id ?? '';

    const { rows: fila } = await owner.query<{ id: string }>(
      `insert into app.patients (clinic_id, name, phone_e164, whatsapp_consent_at)
       values ($1, 'Joana', $2, now()) returning id`,
      [cenario.clinica, `+${TELEFONE_DA_FILA}`],
    );
    cenario.daFila = fila[0]?.id ?? '';
    expect(cenario.paciente).not.toBe('');
    expect(cenario.daFila).not.toBe('');
  });
});

describe('2. o paciente é agendado', () => {
  it('a consulta nasce com a duração do procedimento e o preço do dia', async () => {
    // Dois dias à frente para a régua de confirmação ter onde caber: o gatilho da 0001 só
    // cria a ação se `starts_at - confirm_hours_before` ainda estiver no futuro.
    cenario.inicio = new Date(Date.now() + 2 * 86_400_000);

    const marcada = await withClinic(
      cenario.clinica,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: cenario.profissional,
          pacienteId: cenario.paciente,
          procedimentoId: cenario.procedimento,
          inicio: cenario.inicio,
          origem: 'recepcao',
        }),
      db,
    );

    expect(marcada.ok).toBe(true);
    if (!marcada.ok) return;
    cenario.consulta = marcada.consulta.id;

    const minutos =
      (marcada.consulta.ends_at.getTime() - marcada.consulta.starts_at.getTime()) / 60_000;
    expect(minutos).toBe(45);
    expect(Number(marcada.consulta.price_cents)).toBe(18_000);
    expect(marcada.consulta.status).toBe('agendado');
  });

  it('a régua de confirmação foi criada pelo gatilho, sem ninguém pedir', async () => {
    // É o gatilho `appointments_sync_actions` (0001). Se ele não disparar, nada do passo 4
    // acontece — e o sintoma seria "a mensagem não saiu", três passos adiante.
    const { rows } = await owner.query<{ kind: string }>(
      `select kind from app.scheduled_actions
        where appointment_id = $1 and status = 'pendente' order by kind`,
      [cenario.consulta],
    );
    expect(rows.map((r) => r.kind)).toEqual(['confirmacao', 'lembrete_final', 'marcar_risco']);
  });
});

describe('3. o mesmo horário com o mesmo profissional não aceita dois pacientes', () => {
  it('o BANCO recusa, com 23P01, e é ele que decide — não um SELECT antes do INSERT', async () => {
    /*
     * O código do erro é o contrato: `exclusion_violation` é 23P01, e é por ele que
     * `ehConflitoDeHorario` reconhece a colisão. Testar só a mensagem em português deixaria
     * passar uma troca de constraint que mudasse o código.
     */
    const erro = await owner
      .query(
        `insert into app.appointments
           (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
         values ($1, $2, $3, $4, $5, $5::timestamptz + interval '45 minutes', 18000)`,
        [
          cenario.clinica,
          cenario.profissional,
          cenario.daFila,
          cenario.procedimento,
          cenario.inicio,
        ],
      )
      .then(() => undefined)
      .catch((e: unknown) => e as { code?: string; constraint?: string });

    expect(erro?.code).toBe('23P01');
    expect(erro?.constraint).toBe('no_double_booking');
  });

  it('e o caminho da aplicação devolve recusa tratada, não erro de banco cru', async () => {
    const colidiu = await withClinic(
      cenario.clinica,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: cenario.profissional,
          pacienteId: cenario.daFila,
          procedimentoId: cenario.procedimento,
          inicio: cenario.inicio,
          origem: 'recepcao',
        }),
      db,
    );
    expect(colidiu.ok).toBe(false);
    if (!colidiu.ok) expect(colidiu.motivo).toBe('horario_ocupado');
  });

  it('a consulta original sobreviveu à colisão', async () => {
    // O savepoint é o que garante isto: violação de constraint aborta a transação inteira
    // no Postgres, e sem ele a recusa levaria embora a consulta que já estava lá.
    const viva = await withClinic(cenario.clinica, (trx) => consulta(trx, cenario.consulta), db);
    expect(viva?.status).toBe('agendado');
  });
});

describe('4. o template de confirmação sai pelo Graph API falso', () => {
  it('a ação vence e o worker manda o template, com os botões na ordem do código', async () => {
    /*
     * O `due_at` é puxado para trás por SQL em vez de esperar um dia. É o RELÓGIO que anda,
     * não a regra: a ação, o estado da consulta e o caminho de envio são os de produção.
     */
    await owner.query(
      `update app.scheduled_actions set due_at = now() - interval '1 minute'
        where appointment_id = $1 and kind = 'confirmacao'`,
      [cenario.consulta],
    );

    naMeta.length = 0;
    const r = await rodarUmaVez({ db, whatsapp });
    expect(r.pegas).toBeGreaterThanOrEqual(1);

    const envio = naMeta.find((c) => c.template === TEMPLATES.confirmacao.nome);
    expect(envio, 'o template de confirmação não foi enviado').toBeDefined();
    expect(envio?.para).toBe(`+${TELEFONE_PACIENTE}`);
    expect(envio?.url).toContain(`/${PHONE_NUMBER_ID}/messages`);
    // A ordem dos botões é contrato: o payload vai por índice, e botão fora de ordem faz o
    // paciente tocar em "remarcar" e o sistema entender "confirmou".
    expect(envio?.botoes).toEqual([...TEMPLATES.confirmacao.botoes]);
  });

  it('a mensagem enviada não leva nenhum dado que não seja do paciente certo', () => {
    const envio = naMeta.find((c) => c.template === TEMPLATES.confirmacao.nome);
    expect(envio?.para).not.toBe(`+${TELEFONE_DA_FILA}`);
  });

  it('a ação ficou como feita, e não volta a ser reclamada', async () => {
    const { rows } = await owner.query<{ status: string }>(
      `select status from app.scheduled_actions
        where appointment_id = $1 and kind = 'confirmacao'`,
      [cenario.consulta],
    );
    expect(rows[0]?.status).toBe('feito');
  });
});

describe('5. o paciente toca em "Confirmar"', () => {
  it('o webhook aceita com HMAC válido e a consulta vira confirmada', async () => {
    const corpo = eventoDeBotao('wamid.CONFIRMOU.1', PAYLOAD_BOTOES.CONFIRMAR);
    const r = await postarWebhook(corpo);
    expect(r.statusCode).toBe(200);

    expect(await drenarFilaDeBotao()).toBe(1);

    const depois = await withClinic(cenario.clinica, (trx) => consulta(trx, cenario.consulta), db);
    expect(depois?.status).toBe('confirmado');
    expect(depois?.confirmed_at).not.toBeNull();
  });

  it('sem assinatura válida o mesmo evento é 401 e não muda nada', async () => {
    const corpo = eventoDeBotao('wamid.FORJADO.1', PAYLOAD_BOTOES.CANCELAR);
    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'outro-segredo').update(corpo).digest('hex')}`,
      },
      payload: corpo,
    });
    expect(r.statusCode).toBe(401);

    // O cancelamento forjado NÃO aconteceu: a consulta segue confirmada.
    const depois = await withClinic(cenario.clinica, (trx) => consulta(trx, cenario.consulta), db);
    expect(depois?.status).toBe('confirmado');
  });
});

describe('6. o mesmo wamid de novo não faz nada de novo', () => {
  it('reenvio responde 200, grava uma mensagem só e não enfileira outro job', async () => {
    const corpo = eventoDeBotao('wamid.CONFIRMOU.1', PAYLOAD_BOTOES.CONFIRMAR);
    const r = await postarWebhook(corpo);
    // 200 de propósito: recusar faz a Meta reenviar o mesmo evento para sempre.
    expect(r.statusCode).toBe(200);

    const quantas = await withClinic(
      cenario.clinica,
      async (trx) => {
        const linhas = await trx
          .selectFrom('app.messages')
          .select('id')
          .where('wamid', '=', 'wamid.CONFIRMOU.1')
          .execute();
        return linhas.length;
      },
      db,
    );
    expect(quantas).toBe(1);
    expect(await drenarFilaDeBotao()).toBe(0);
  });

  it('e a consulta continua confirmada uma vez, não duas', async () => {
    const depois = await withClinic(cenario.clinica, (trx) => consulta(trx, cenario.consulta), db);
    expect(depois?.status).toBe('confirmado');
  });
});

describe('7. o paciente toca em "Preciso remarcar"', () => {
  /**
   * AQUI O SISTEMA NÃO FAZ O QUE O ENUNCIADO PEDIA, E É DE PROPÓSITO.
   *
   * O enunciado dizia "horário volta a ficar livre". Não volta, e não deve: a regra 5 do
   * CLAUDE.md é que só libera horário quem disse que NÃO VEM, ou a recepção. Pedir para
   * remarcar não é dizer que não vem — é dizer "quero outro dia". Liberar antes de o novo
   * horário existir produz o paciente que pediu para remarcar, não combinou nada, aparece
   * no horário antigo e encontra outro paciente na cadeira.
   *
   * `efeitoDaResposta` devolve `iniciar_remarcacao`, e `botao.ts:110` tem a frase escrita:
   * "O horário antigo continua de pé: só sai depois que o novo estiver marcado."
   *
   * Então este bloco testa o que o sistema faz, e o bloco 7b cobre o caminho que de fato
   * libera o horário — senão o passo 8 estaria testando uma premissa falsa.
   */
  it('o horário NÃO é liberado: continua confirmado, no mesmo lugar', async () => {
    const corpo = eventoDeBotao('wamid.REMARCAR.1', PAYLOAD_BOTOES.REMARCAR);
    expect((await postarWebhook(corpo)).statusCode).toBe(200);
    expect(await drenarFilaDeBotao()).toBe(1);

    const depois = await withClinic(cenario.clinica, (trx) => consulta(trx, cenario.consulta), db);
    expect(depois?.status).toBe('confirmado');
    expect(depois?.starts_at.getTime()).toBe(cenario.inicio.getTime());
    expect(depois?.cancelled_at).toBeNull();
  });

  it('a recepção é avisada, porque remarcar é conversa e não automação', async () => {
    const { rows } = await owner.query<{ kind: string; title: string }>(
      `select kind, title from app.alerts
        where appointment_id = $1 and resolved_at is null order by created_at desc`,
      [cenario.consulta],
    );
    expect(rows[0]?.kind).toBe('conversa_assumida');
    expect(rows[0]?.title).toContain('remarcar');
  });

  it('nenhuma oferta de vaga saiu: não havia vaga', () => {
    // É a consequência que torna o passo 8 impossível por este caminho.
    expect(naMeta.filter((c) => c.template === TEMPLATES.ofertaDeVaga.nome)).toEqual([]);
  });
});

describe('7b. o horário volta a ficar livre pelo caminho que de fato libera', () => {
  it('"Não vou poder ir" cancela a consulta e abre o horário', async () => {
    // Antes de cancelar, alguém tem de estar esperando por este horário — senão a oferta
    // não tem para quem ir e o passo 8 passaria por falta de gente, não por acerto.
    // A janela cobre o dia da consulta: `rank_waitlist` só oferece a quem disse que pode
    // naquele período. Janela errada faria o passo 8 falhar por motivo que não é o testado.
    await owner.query(
      `insert into app.waitlist_entries
         (clinic_id, patient_id, professional_id, procedure_id, window_start, window_end)
       values ($1, $2, $3, $4, current_date, current_date + 7)`,
      [cenario.clinica, cenario.daFila, cenario.profissional, cenario.procedimento],
    );

    naMeta.length = 0;
    const corpo = eventoDeBotao('wamid.CANCELOU.1', PAYLOAD_BOTOES.CANCELAR);
    expect((await postarWebhook(corpo)).statusCode).toBe(200);
    expect(await drenarFilaDeBotao()).toBe(1);

    const depois = await withClinic(cenario.clinica, (trx) => consulta(trx, cenario.consulta), db);
    expect(depois?.status).toBe('cancelado');
    expect(depois?.cancelled_at).not.toBeNull();
  });

  it('o horário livre aceita outro paciente — é a operação de todo dia', async () => {
    const encaixe = await withClinic(
      cenario.clinica,
      (trx) =>
        agenda.criar(trx, {
          profissionalId: cenario.profissional,
          pacienteId: cenario.daFila,
          procedimentoId: cenario.procedimento,
          inicio: cenario.inicio,
          origem: 'recepcao',
        }),
      db,
    );
    expect(encaixe.ok).toBe(true);
  });
});

describe('8. a lista de espera dispara a oferta de vaga', () => {
  it('a oferta foi criada para quem estava esperando', async () => {
    // A oferta aponta para a ENTRADA da fila, não para o paciente: é a entrada que carrega
    // a janela e a prioridade, e é ela que `claim_slot_offer` marca como atendida.
    const { rows } = await owner.query<{ patient_id: string; status: string; starts_at: Date }>(
      `select w.patient_id, o.status, o.starts_at
         from app.slot_offers o
         join app.waitlist_entries w on w.id = o.waitlist_entry_id
        where o.clinic_id = $1`,
      [cenario.clinica],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.patient_id).toBe(cenario.daFila);
    expect(rows[0]?.status).toBe('enviada');
    expect(rows[0]?.starts_at.getTime()).toBe(cenario.inicio.getTime());
  });

  it('e o template de vaga liberada saiu pelo Graph API falso, para ela', () => {
    const oferta = naMeta.find((c) => c.template === TEMPLATES.ofertaDeVaga.nome);
    expect(oferta, 'o template de oferta de vaga não foi enviado').toBeDefined();
    expect(oferta?.para).toBe(`+${TELEFONE_DA_FILA}`);
    expect(oferta?.botoes).toEqual([...TEMPLATES.ofertaDeVaga.botoes]);
  });

  it('a oferta não foi para quem cancelou', () => {
    const paraQuemCancelou = naMeta.filter(
      (c) => c.template === TEMPLATES.ofertaDeVaga.nome && c.para === `+${TELEFONE_PACIENTE}`,
    );
    expect(paraQuemCancelou).toEqual([]);
  });
});

describe('o caminho testado é o caminho que a produção usa', () => {
  /**
   * A guarda que impede este arquivo de virar um falso verde.
   *
   * `drenarFilaDeBotao` repete as três linhas do consumidor de `apps/worker/src/index.ts`,
   * porque a lógica é inline lá e não dá para importar. Se o `index.ts` passar a chamar
   * outra coisa, o e2e continuaria verde testando um caminho que ninguém executa.
   */
  it('o consumidor da fila de botão chama tratarResposta', () => {
    const fonte = readFileSync(new URL('../apps/worker/src/index.ts', import.meta.url), 'utf8');
    const trecho = fonte.slice(fonte.indexOf('FILA_BOTAO'));
    expect(trecho).toContain('tratarResposta(');
    expect(trecho).toContain('withClinic(');
  });

  it('todo envio passou pela borda falsa, e nenhum token foi gravado', () => {
    /*
     * O cliente é o VERDADEIRO — só o `fetch` é nosso. A prova de que nenhuma chamada saiu
     * é a contagem: a borda falsa emitiu um wamid por chamada registrada, então não existe
     * envio que tenha ido por outro caminho. Se o `buscar` injetado deixasse de ser usado,
     * `naMeta` ficaria vazio e os passos 4 e 8 cairiam antes desta guarda.
     */
    // Dois envios no caminho inteiro: a confirmação (passo 4) e a oferta de vaga (passo 8).
    expect(totalDeChamadas).toBeGreaterThanOrEqual(2);
    // Um wamid emitido por chamada registrada: não existe envio que tenha ido por fora.
    expect(wamidDaMeta).toBe(totalDeChamadas);
    // E o token de teste não aparece em nada que o teste guardou.
    expect(JSON.stringify(naMeta)).not.toContain('token-falso-de-teste');
  });
});
