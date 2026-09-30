import { criarDb, type Db } from '@fliqo/db';
import { criarFila, FILA_OFERTA, SCHEMA_FILA } from '@fliqo/db/fila';
import {
  ownerPool,
  prepararFilaDeTeste,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';
import type { RespostaHoje, RespostaSemana } from '../src/rotas/hoje';

/**
 * A tela Hoje, do lado da API.
 *
 * Três coisas se provam aqui: o dia chega montado (manchete, faixa, atraso,
 * vaga), token vencido ou forjado devolve 401, e quem é da clínica A não
 * enxerga a B nem com token válido.
 */

const JWT_SECRET = 'segredo-jwt-do-supabase-para-teste';
const segredo = new TextEncoder().encode(JWT_SECRET);

const config: Config = {
  DATABASE_URL: 'nao-usado-no-teste',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app-de-teste',
  META_APP_SECRET: 'segredo-do-app-de-teste',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

const DONA_DA_A = '11111111-1111-4111-8111-111111111111';
const DONA_DA_B = '22222222-2222-4222-8222-222222222222';
const DAS_DUAS = '33333333-3333-4333-8333-333333333333';
const DE_NENHUMA = '44444444-4444-4444-8444-444444444444';
/** Dona de uma clínica e do financeiro da outra: o papel não pode viajar. */
const MISTA = '55555555-5555-4555-8555-555555555555';

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

async function token(userId: string, expiraEm = '1h'): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiraEm)
    .sign(segredo);
}

async function chamar(
  url: string,
  opcoes: { userId?: string; clinica?: string; tokenCru?: string } = {},
) {
  const jwt = opcoes.tokenCru ?? (opcoes.userId ? await token(opcoes.userId) : undefined);
  return app.inject({
    method: 'GET',
    url,
    headers: {
      ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
      ...(opcoes.clinica === undefined ? {} : { 'x-clinica': opcoes.clinica }),
    },
  });
}

async function postar(url: string, opcoes: { userId: string; clinica: string; corpo: unknown }) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${await token(opcoes.userId)}`,
      'x-clinica': opcoes.clinica,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(opcoes.corpo),
  });
}

/**
 * Um fuso em que AGORA é meio-dia.
 *
 * O teste marca consultas a duas horas daqui e a uma hora e meia adiante: num
 * fuso qualquer, rodar perto da meia-noite jogaria metade delas para outro dia
 * e o teste falharia por causa do relógio da máquina, não do código.
 */
function fusoOndeAgoraEMeioDia(agora = new Date()): string {
  const desloc = ((12 - agora.getUTCHours() + 12) % 24) - 12;
  // Etc/GMT tem o sinal invertido: Etc/GMT-3 é UTC+3.
  return desloc >= 0 ? `Etc/GMT-${String(desloc)}` : `Etc/GMT+${String(-desloc)}`;
}

/** Minutos a partir de agora, como timestamp do Postgres. */
const daquiA = (min: number): Date => new Date(Date.now() + min * 60_000);

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);

  await owner.query(`update app.clinics set timezone = $1`, [fusoOndeAgoraEMeioDia()]);
  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role)
     values ($1,$2,'dono'), ($3,$4,'dono'), ($1,$5,'recepcao'), ($3,$5,'recepcao')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B, DAS_DUAS],
  );

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });
  await app.ready();

  // O dia da clínica A: uma em atendimento com 40 min de atraso, uma logo
  // atrás (que o atraso empurra) e uma depois de um buraco de hora e meia.
  const marcar = async (
    inicioMin: number,
    duracaoMin: number,
    paciente: string,
    extras: { status?: string; iniciadaMin?: number } = {},
  ): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status, started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [
        c.clinicA,
        c.profA,
        paciente,
        c.procEletivo,
        daquiA(inicioMin),
        daquiA(inicioMin + duracaoMin),
        25000,
        extras.status ?? 'confirmado',
        extras.iniciadaMin === undefined ? null : daquiA(extras.iniciadaMin),
      ],
    );
    return rows[0]!.id;
  };

  await marcar(-120, 60, c.patients[0]!, { iniciadaMin: -80 });
  await marcar(-30, 60, c.patients[1]!, { status: 'agendado' });
  await marcar(120, 60, c.patients[2]!, { status: 'agendado' });

  // Uma consulta na clínica B, para ficar provado que a A não a enxerga.
  await owner.query(
    `insert into app.appointments
       (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at, price_cents)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      c.clinicB,
      await profissionalDaB(),
      c.patientB,
      await procedimentoDaB(),
      daquiA(-60),
      daquiA(0),
      99900,
    ],
  );
}, 90_000);

async function profissionalDaB(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.professionals (clinic_id, name) values ($1,'Dr. Beto') returning id`,
    [c.clinicB],
  );
  return rows[0]!.id;
}

async function procedimentoDaB(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.procedures (clinic_id, name, duration_minutes, price_cents)
     values ($1,'Avaliação',60,99900) returning id`,
    [c.clinicB],
  );
  return rows[0]!.id;
}

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

describe('GET /api/hoje', () => {
  it('monta o dia: manchete, faixa do profissional, atraso e vaga', async () => {
    const r = await chamar('/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    expect(r.statusCode).toBe(200);
    const hoje = r.json<RespostaHoje>();

    expect(hoje.clinica.id).toBe(c.clinicA);
    expect(hoje.consultas).toHaveLength(3);

    // Dinheiro inteiro em centavos, somado e não calculado.
    expect(hoje.manchete).toEqual({
      quantidade: 3,
      naAgendaCents: 75000,
      semConfirmacaoCents: 50000,
    });

    expect(hoje.profissionais).toHaveLength(1);
    expect(hoje.profissionais[0]!.atrasoMin).toBeGreaterThanOrEqual(30);

    // A que está em atendimento começou 40 min depois do combinado.
    const emAtendimento = hoje.consultas.find((x) => x.situacao === 'em_atendimento');
    expect(emAtendimento?.atrasoMin).toBe(40);

    // A seguinte não começou e é empurrada: é isso que a faixa desenha como
    // bloco deslocado com o horário marcado em contorno tracejado.
    const empurrada = hoje.consultas.find((x) => x.situacao === 'aguardando' && x.atrasoMin > 0);
    expect(empurrada).toBeDefined();
    expect(Date.parse(empurrada!.inicioPrevisto)).toBeGreaterThan(
      Date.parse(empurrada!.inicioAgendado),
    );

    // O buraco de hora e meia vira horário livre hachurado.
    expect(hoje.vagas.length).toBeGreaterThan(0);
    expect(hoje.vagas[0]!.profissionalId).toBe(c.profA);
  });

  it('traz o nome do paciente e do procedimento, sem telefone', async () => {
    const r = await chamar('/api/hoje', { userId: DONA_DA_A, clinica: c.clinicA });
    const consulta = r.json<RespostaHoje>().consultas[0]!;
    expect(consulta.paciente).toBeTruthy();
    expect(consulta.procedimento).toBe('Limpeza');
    expect(JSON.stringify(r.json())).not.toContain('+5511');
  });
});

describe('autenticação da tela Hoje', () => {
  it('sem token devolve 401', async () => {
    expect((await chamar('/api/hoje', { clinica: c.clinicA })).statusCode).toBe(401);
    expect((await chamar('/api/minhas-clinicas')).statusCode).toBe(401);
  });

  it('token expirado devolve 401', async () => {
    const vencido = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(DONA_DA_A)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(segredo);

    expect((await chamar('/api/hoje', { tokenCru: vencido, clinica: c.clinicA })).statusCode).toBe(
      401,
    );
    expect((await chamar('/api/minhas-clinicas', { tokenCru: vencido })).statusCode).toBe(401);
  });

  it('token assinado com outro segredo devolve 401', async () => {
    const forjado = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(DONA_DA_A)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('segredo-errado'));

    expect((await chamar('/api/hoje', { tokenCru: forjado, clinica: c.clinicA })).statusCode).toBe(
      401,
    );
  });

  it('sem dizer a clínica devolve 400, não o dia de alguém', async () => {
    expect((await chamar('/api/hoje', { userId: DONA_DA_A })).statusCode).toBe(400);
  });
});

describe('isolamento entre clínicas na tela Hoje', () => {
  it('a dona da A não vê o dia da B, nem com token válido', async () => {
    const r = await chamar('/api/hoje', { userId: DONA_DA_A, clinica: c.clinicB });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'nao_e_membro_da_clinica' });
    // Nem de raspão: o corpo do 403 não carrega nada da clínica B.
    expect(r.body).not.toContain('99900');
  });

  it('a dona da B vê o dia dela, e só o dela', async () => {
    const r = await chamar('/api/hoje', { userId: DONA_DA_B, clinica: c.clinicB });
    expect(r.statusCode).toBe(200);
    expect(r.json().consultas).toHaveLength(1);
    expect(r.json().manchete.naAgendaCents).toBe(99900);
  });

  it('minhas-clinicas devolve só as clínicas da pessoa', async () => {
    const daA = await chamar('/api/minhas-clinicas', { userId: DONA_DA_A });
    expect(daA.json()).toEqual([{ id: c.clinicA, nome: 'Clínica A', papel: 'dono' }]);

    const daB = await chamar('/api/minhas-clinicas', { userId: DONA_DA_B });
    expect(daB.json()).toEqual([{ id: c.clinicB, nome: 'Clínica B', papel: 'dono' }]);

    const nenhuma = await chamar('/api/minhas-clinicas', { userId: DE_NENHUMA });
    expect(nenhuma.json()).toEqual([]);
  });

  /**
   * O papel vem POR CLÍNICA, e não por pessoa: quem é dono numa e recepção na
   * outra não pode levar o "dono" de uma para a outra. É o que o painel usa para
   * decidir se mostra a aba do WhatsApp, e é a API que nega de verdade.
   */
  it('o papel é lido dentro de cada clínica, não herdado entre elas', async () => {
    await owner.query(
      `insert into app.clinic_members (clinic_id, user_id, role) values ($1,$2,'dono')`,
      [c.clinicA, MISTA],
    );
    await owner.query(
      `insert into app.clinic_members (clinic_id, user_id, role) values ($1,$2,'financeiro')`,
      [c.clinicB, MISTA],
    );

    const lista = (await chamar('/api/minhas-clinicas', { userId: MISTA })).json<
      { id: string; papel: string }[]
    >();
    expect(new Map(lista.map((x) => [x.id, x.papel]))).toEqual(
      new Map([
        [c.clinicA, 'dono'],
        [c.clinicB, 'financeiro'],
      ]),
    );
  });

  it('quem é das duas escolhe uma de cada vez, e cada uma mostra só o que é dela', async () => {
    const lista = await chamar('/api/minhas-clinicas', { userId: DAS_DUAS });
    expect(lista.json()).toHaveLength(2);

    const naA = await chamar('/api/hoje', { userId: DAS_DUAS, clinica: c.clinicA });
    const naB = await chamar('/api/hoje', { userId: DAS_DUAS, clinica: c.clinicB });
    expect(naA.json().manchete.naAgendaCents).toBe(75000);
    expect(naB.json().manchete.naAgendaCents).toBe(99900);
  });
});

describe('o token não aparece no log', () => {
  it('o redator apaga authorization e cookie', async () => {
    const linhas: string[] = [];
    const fluxo = new PassThrough();
    fluxo.on('data', (pedaco: Buffer) => linhas.push(pedaco.toString('utf8')));

    const comLog = construirApp({ config, db, boss, fluxoDeLog: fluxo });
    await comLog.ready();

    const jwt = await token(DONA_DA_A);
    await comLog.inject({
      method: 'GET',
      url: '/api/hoje',
      headers: { authorization: `Bearer ${jwt}`, 'x-clinica': c.clinicA },
    });

    // E se alguém um dia logar o token de propósito, o redator pega.
    comLog.log.info({ authorization: `Bearer ${jwt}`, access_token: jwt }, 'teste');
    await comLog.close();

    const tudo = linhas.join('');
    expect(tudo).not.toContain(jwt);
    expect(tudo).toContain('[redigido]');
  });
});

describe('GET /api/agenda/semana', () => {
  it('devolve sete dias, de segunda a domingo, e marca qual é hoje', async () => {
    const r = await chamar('/api/agenda/semana', { userId: DONA_DA_A, clinica: c.clinicA });
    expect(r.statusCode).toBe(200);
    const semana = r.json<RespostaSemana>();
    expect(semana.dias).toHaveLength(7);
    expect(semana.dias.filter((d) => d.ehHoje)).toHaveLength(1);
  });

  it('o atraso é calculado só na coluna de hoje', async () => {
    // Projetar atraso para quinta seria inventar um número que nada sustenta, e
    // a recepção remarcaria em cima dele.
    const r = await chamar('/api/agenda/semana', { userId: DONA_DA_A, clinica: c.clinicA });
    const semana = r.json<RespostaSemana>();
    for (const dia of semana.dias) {
      if (dia.ehHoje) continue;
      expect(dia.consultas.every((x) => x.atrasoMin === 0)).toBe(true);
    }
    const hoje = semana.dias.find((d) => d.ehHoje);
    expect(hoje?.consultas.some((x) => x.atrasoMin > 0)).toBe(true);
  });

  it('em dia que não é hoje o bloco fica onde foi marcado, mesmo com horários batidos', async () => {
    // Sem esta invariante, projetar a semana inteira passaria despercebido: num
    // dia futuro sem atendimento começado a projeção dá zero de atraso por
    // acaso. O que a distingue é a SITUAÇÃO: fora de hoje, nada é "em
    // atendimento" nem "finalizada", porque não se projeta outro dia.
    const antes = await chamar('/api/agenda/semana', { userId: DONA_DA_A, clinica: c.clinicA });
    const outroDia = antes.json<RespostaSemana>().dias.find((d) => !d.ehHoje);
    expect(outroDia).toBeDefined();

    const { rows } = await owner.query<{ id: string }>(
      `insert into app.appointments
         (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
          price_cents, status, started_at, finished_at, checked_in_at)
       select $1, $2, $3, $4,
              timezone(cl.timezone, ($5::date + time '09:00')),
              timezone(cl.timezone, ($5::date + time '10:00')),
              25000, 'realizado',
              timezone(cl.timezone, ($5::date + time '09:40')),
              timezone(cl.timezone, ($5::date + time '10:30')),
              timezone(cl.timezone, ($5::date + time '08:55'))
         from app.clinics cl where cl.id = $1
       returning id`,
      [c.clinicA, c.profA, c.patients[3]!, c.procEletivo, outroDia!.dataIso],
    );

    try {
      const r = await chamar('/api/agenda/semana', { userId: DONA_DA_A, clinica: c.clinicA });
      const dia = r.json<RespostaSemana>().dias.find((d) => d.dataIso === outroDia!.dataIso);
      const plantada = dia?.consultas.find((x) => x.id === rows[0]!.id);
      expect(plantada).toBeDefined();
      expect(plantada!.situacao).toBe('aguardando');
      expect(plantada!.atrasoMin).toBe(0);
      expect(plantada!.inicioPrevisto).toBe(plantada!.inicioAgendado);
    } finally {
      await owner.query(`delete from app.appointments where id = $1`, [rows[0]!.id]);
    }
  });

  it('filtra por profissional', async () => {
    const r = await chamar(`/api/agenda/semana?profissionalId=${c.profA}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.json<RespostaSemana>().profissionais.map((p) => p.id)).toEqual([c.profA]);
  });

  it('data mal formada é recusada antes de tocar no banco', async () => {
    const r = await chamar('/api/agenda/semana?de=ontem', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(400);
  });

  it('a dona da A não vê a semana da B, e o 403 não carrega nada da B', async () => {
    const r = await chamar('/api/agenda/semana', { userId: DONA_DA_A, clinica: c.clinicB });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('99900');
    expect(r.body).not.toContain('Dr. Beto');
  });
});

describe('POST /api/fila/oferecer', () => {
  async function jobsDeOferta(): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from ${SCHEMA_FILA}.job where name = $1`,
      [FILA_OFERTA],
    );
    return Number(rows[0]?.n ?? 0);
  }

  const vaga = () => ({
    profissionalId: c.profA,
    inicio: daquiA(300).toISOString(),
    fim: daquiA(360).toISOString(),
  });

  it('enfileira uma rodada para a vaga', async () => {
    await owner.query(`delete from ${SCHEMA_FILA}.job where name = $1`, [FILA_OFERTA]);
    const r = await postar('/api/fila/oferecer', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: vaga(),
    });
    expect(r.statusCode).toBe(202);
    expect(await jobsDeOferta()).toBe(1);
  });

  it('duplo clique na mesma vaga não abre duas rodadas', async () => {
    // Duas rodadas mandariam oferta em dobro para as mesmas pessoas da fila.
    await owner.query(`delete from ${SCHEMA_FILA}.job where name = $1`, [FILA_OFERTA]);
    const pedido = vaga();
    for (let i = 0; i < 2; i++) {
      const r = await postar('/api/fila/oferecer', {
        userId: DONA_DA_A,
        clinica: c.clinicA,
        corpo: pedido,
      });
      expect(r.statusCode).toBe(202);
    }
    expect(await jobsDeOferta()).toBe(1);
  });

  it('vagas diferentes abrem rodadas diferentes', async () => {
    await owner.query(`delete from ${SCHEMA_FILA}.job where name = $1`, [FILA_OFERTA]);
    for (const minutos of [400, 500]) {
      await postar('/api/fila/oferecer', {
        userId: DONA_DA_A,
        clinica: c.clinicA,
        corpo: {
          profissionalId: c.profA,
          inicio: daquiA(minutos).toISOString(),
          fim: daquiA(minutos + 60).toISOString(),
        },
      });
    }
    expect(await jobsDeOferta()).toBe(2);
  });

  it('intervalo invertido é recusado', async () => {
    const r = await postar('/api/fila/oferecer', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: {
        profissionalId: c.profA,
        inicio: daquiA(400).toISOString(),
        fim: daquiA(300).toISOString(),
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it('profissional de outra clínica não é encontrado', async () => {
    // A RLS não enxerga a linha: para a clínica A aquele profissional não existe.
    const { rows } = await owner.query<{ id: string }>(
      `select id from app.professionals where clinic_id = $1 limit 1`,
      [c.clinicB],
    );
    const r = await postar('/api/fila/oferecer', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { ...vaga(), profissionalId: rows[0]!.id },
    });
    expect(r.statusCode).toBe(404);
  });

  it('a dona da B não oferece vaga na agenda da A, e nada é enfileirado', async () => {
    await owner.query(`delete from ${SCHEMA_FILA}.job where name = $1`, [FILA_OFERTA]);
    const r = await postar('/api/fila/oferecer', {
      userId: DONA_DA_B,
      clinica: c.clinicA,
      corpo: vaga(),
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain(c.profA);
    expect(await jobsDeOferta()).toBe(0);
  });
});
