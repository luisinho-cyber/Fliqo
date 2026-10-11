import { criarDb, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import {
  prepararFilaDeTeste,
  ownerPool,
  resetDatabase,
  seed,
  urlDoTester,
  type Scenario,
} from '@fliqo/db/testing';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';
import { comRecurso } from '../src/rotas/contexto';
import type { RelatorioDaImportacao, SaidaDaImportacao } from '../src/rotas/importacao';

/**
 * Modo convidado: importar a agenda do sistema que a clínica já usa.
 *
 * Quatro coisas aqui importam mais que o resto, e são as que o pedido nomeou:
 * reimportar não duplica, telefone com e sem nono dígito é o mesmo paciente, linha
 * malformada é recusada COM MOTIVO, e a clínica em modo convidado não enxerga
 * prontuário. As três primeiras são sobre não estragar a agenda; a última é sobre
 * não fingir ser a fonte da verdade do que não é nossa.
 */

const JWT_SECRET = 'segredo-jwt-do-convidado';
const segredo = new TextEncoder().encode(JWT_SECRET);
const DONA_DA_A = '11111111-1111-4111-8111-111111111111';
const DONA_DA_B = '22222222-2222-4222-8222-222222222222';
const RECEPCAO_DA_A = '44444444-4444-4444-8444-444444444444';

const config: Config = {
  DATABASE_URL: 'nao-usado',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app',
  META_APP_SECRET: 'segredo',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 5).toString('base64'),
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

const CABECALHO = 'Paciente;Celular;Profissional;Início;Procedimento';
const MAPA = { paciente: 0, telefone: 1, profissional: 2, inicio: 3, procedimento: 4 };

async function token(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(segredo);
}

async function chamar(
  metodo: 'GET' | 'POST',
  url: string,
  o: { userId: string; clinica: string; corpo?: object },
): Promise<LightMyRequestResponse> {
  const opcoes: InjectOptions = {
    method: metodo,
    url,
    headers: { authorization: `Bearer ${await token(o.userId)}`, 'x-clinica': o.clinica },
  };
  if (o.corpo !== undefined) opcoes.payload = o.corpo;
  return app.inject(opcoes);
}

async function importar(
  linhas: string[],
  o: { userId?: string; clinica?: string; arquivo?: string } = {},
): Promise<LightMyRequestResponse> {
  return chamar('POST', '/api/importacoes', {
    userId: o.userId ?? DONA_DA_A,
    clinica: o.clinica ?? c.clinicA,
    corpo: {
      arquivo: o.arquivo ?? 'agenda.csv',
      texto: [CABECALHO, ...linhas].join('\n'),
      mapa: MAPA,
      temCabecalho: true,
    },
  });
}

function relatorioDe(r: LightMyRequestResponse): RelatorioDaImportacao {
  const saida = r.json<SaidaDaImportacao>();
  if (!saida.ok) throw new Error(`a importação foi recusada: ${saida.motivo}`);
  return saida.relatorio;
}

async function quantasConsultas(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `select count(*) as n from app.appointments where clinic_id = $1`,
    [c.clinicA],
  );
  return Number(rows[0]?.n ?? '0');
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role)
     values ($1,$2,'dono'), ($3,$4,'dono'), ($1,$5,'recepcao')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B, RECEPCAO_DA_A],
  );
  // A clínica A é a convidada: a agenda dela vive em outro sistema. A B marca aqui.
  await owner.query('update app.clinics set guest_mode = true where id = $1', [c.clinicA]);

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });

  /**
   * Uma rota de teste guardada por `comRecurso`.
   *
   * Prontuário não existe no sistema — não há tabela, tela nem rota. A guarda existe
   * ANTES dele, e esta rota é o jeito de provar que ela funciona de verdade em vez de
   * só afirmar que a lista está certa. Quando a tela nascer, nasce coberta.
   */
  app.get('/teste/prontuario', async (req, reply) => {
    const r = await comRecurso(
      'prontuario',
      { db, segredoJwt: new TextEncoder().encode(JWT_SECRET), boss },
      req,
      reply,
      () => Promise.resolve({ ficha: 'conteúdo de prontuário' }),
    );
    return r.respondido ? reply : reply.send(r.valor);
  });

  await app.ready();
}, 90_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.schedule_import_rows');
  await owner.query('delete from app.schedule_imports');
  await owner.query('delete from app.appointments');
});

describe('reimportação é idempotente', () => {
  const AGENDA = [
    'Maria Silva;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza',
    'João Souza;11988776655;Dra. Ana;05/10/2026 15:00;Limpeza',
    'Ana Lima;11977665544;Dr. Bruno;05/10/2026 14:00;Clareamento',
  ];

  it('o mesmo arquivo duas vezes não duplica consulta', async () => {
    const primeira = relatorioDe(await importar(AGENDA));
    expect(primeira).toMatchObject({ total: 3, entraram: 3, repetidas: 0, recusadas: 0 });
    expect(await quantasConsultas()).toBe(3);

    const segunda = relatorioDe(await importar(AGENDA));
    expect(segunda).toMatchObject({ total: 3, entraram: 0, repetidas: 3, recusadas: 0 });
    expect(await quantasConsultas(), 'reimportar duplicou a agenda').toBe(3);
  });

  it('arquivo com uma linha nova e duas repetidas entra só a nova', async () => {
    await importar(AGENDA);
    const r = relatorioDe(
      await importar([...AGENDA, 'Novo Paciente;11966554433;Dra. Ana;05/10/2026 16:00;Limpeza']),
    );
    expect(r).toMatchObject({ total: 4, entraram: 1, repetidas: 3 });
    expect(await quantasConsultas()).toBe(4);
  });

  /**
   * Consulta cancelada na Fliqo continua ocupando a chave natural. Reimportar o
   * arquivo de ontem não ressuscita o que a recepção cancelou hoje — a planilha é a
   * agenda do outro sistema, não uma ordem de desfazer o que foi decidido aqui.
   */
  it('reimportar não ressuscita consulta cancelada na Fliqo', async () => {
    await importar(AGENDA);
    await owner.query(
      `update app.appointments set status = 'cancelado', cancelled_at = now()
        where clinic_id = $1`,
      [c.clinicA],
    );

    const r = relatorioDe(await importar(AGENDA));
    expect(r).toMatchObject({ entraram: 0, repetidas: 3 });

    const { rows } = await owner.query<{ status: string }>(
      `select distinct status from app.appointments where clinic_id = $1`,
      [c.clinicA],
    );
    expect(rows.map((l) => l.status)).toEqual(['cancelado']);
  });

  /**
   * A distinção que o `on conflict` com alvo explícito existe para preservar: linha
   * repetida é reimportação (nada mudou, e isso não é problema); horário de outro
   * paciente é recusa com motivo. `on conflict do nothing` sem alvo engoliria as
   * duas no mesmo silêncio.
   */
  it('horário ocupado por OUTRO paciente é recusa com motivo, não repetição', async () => {
    await importar(['Maria Silva;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza']);
    const r = relatorioDe(
      await importar(['Outra Pessoa;11955443322;Dra. Ana;05/10/2026 14:00;Limpeza']),
    );
    expect(r).toMatchObject({ total: 1, entraram: 0, repetidas: 0, recusadas: 1 });
    expect(r.recusas[0]).toMatchObject({ linha: 2, motivo: 'horario_ocupado' });
  });

  /**
   * O que o savepoint por linha protege.
   *
   * Violação de constraint aborta a transação inteira no Postgres. Sem savepoint, uma
   * linha conflitante no meio do arquivo levaria embora todas as que já tinham
   * entrado — e o relatório diria que entraram, porque as contas são feitas em
   * memória. Mentira pior do que erro.
   */
  it('linha recusada no meio não leva embora as que já entraram', async () => {
    // Telefones só deste teste: `beforeEach` limpa consultas, não pacientes, e
    // reaproveitar número traria o nome que outro teste já gravou para ele.
    await importar(['Primeira;11933220001;Dra. Ana;05/10/2026 14:00;Limpeza']);

    const r = relatorioDe(
      await importar([
        'Segunda;11933220002;Dra. Ana;05/10/2026 15:00;Limpeza',
        'Conflita;11933220003;Dra. Ana;05/10/2026 14:00;Limpeza',
        'Terceira;11933220004;Dra. Ana;05/10/2026 16:00;Limpeza',
      ]),
    );
    expect(r).toMatchObject({ total: 3, entraram: 2, recusadas: 1 });
    expect(r.recusas[0]).toMatchObject({ linha: 3, motivo: 'horario_ocupado' });

    // E o relatório não mentiu: as três estão lá — a primeira, a segunda e a terceira.
    const { rows } = await owner.query<{ nome: string }>(
      `select p.name as nome from app.appointments a
         join app.patients p on p.id = a.patient_id
        where a.clinic_id = $1 order by a.starts_at`,
      [c.clinicA],
    );
    expect(rows.map((l) => l.nome)).toEqual(['Primeira', 'Segunda', 'Terceira']);
  });

  it('as contas sempre fecham com o total', async () => {
    const r = relatorioDe(
      await importar([
        'Maria Silva;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza',
        'Maria Silva;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza',
        'Sem Data;11988776655;Dra. Ana;amanhã;Limpeza',
      ]),
    );
    expect(r.entraram + r.repetidas + r.recusadas).toBe(r.total);
  });
});

describe('o paciente é reconhecido pelo telefone', () => {
  /**
   * O caso central do item 2: o outro sistema exporta o mesmo celular com e sem o
   * nono dígito, e isso é comum em base antiga. Duas fichas para a mesma pessoa
   * significam duas conversas, dois históricos e duas confirmações.
   */
  it('com e sem nono dígito é o mesmo paciente, e não dois cadastros', async () => {
    const r = relatorioDe(
      await importar([
        'Maria Silva;11988887777;Dra. Ana;05/10/2026 14:00;Limpeza',
        'Maria Silva;1188887777;Dra. Ana;05/10/2026 15:00;Limpeza',
      ]),
    );
    expect(r.entraram).toBe(2);

    const { rows } = await owner.query<{ n: string; phone: string }>(
      `select count(*) as n, min(phone_e164) as phone from app.patients
        where clinic_id = $1 and phone_e164 like '%88887777'`,
      [c.clinicA],
    );
    expect(rows[0]?.n, 'o mesmo celular virou dois cadastros').toBe('1');
    expect(rows[0]?.phone).toBe('+5511988887777');

    // E as duas consultas são da mesma ficha.
    const { rows: consultas } = await owner.query<{ pacientes: string }>(
      `select count(distinct patient_id) as pacientes from app.appointments where clinic_id = $1`,
      [c.clinicA],
    );
    expect(consultas[0]?.pacientes).toBe('1');
  });

  it('+55 e formatação não criam ficha nova', async () => {
    await importar(['Maria Silva;11988887777;Dra. Ana;05/10/2026 14:00;Limpeza']);
    const r = relatorioDe(
      await importar(['Maria Silva;+55 (11) 98888-7777;Dra. Ana;05/10/2026 16:00;Limpeza']),
    );
    expect(r.entraram).toBe(1);
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) as n from app.patients where clinic_id = $1 and phone_e164 = '+5511988887777'`,
      [c.clinicA],
    );
    expect(rows[0]?.n).toBe('1');
  });

  /**
   * Paciente que chegou pelo WhatsApp antes da importação está gravado como
   * "a confirmar". A planilha do outro sistema tem o nome de verdade.
   */
  it('o nome da planilha preenche quem estava como "a confirmar"', async () => {
    await owner.query(
      `insert into app.patients (clinic_id, name, phone_e164) values ($1, 'a confirmar', $2)`,
      [c.clinicA, '+5511955554444'],
    );
    await importar(['Carla Dias;11955554444;Dra. Ana;05/10/2026 14:00;Limpeza']);
    const { rows } = await owner.query<{ name: string }>(
      `select name from app.patients where clinic_id = $1 and phone_e164 = $2`,
      [c.clinicA, '+5511955554444'],
    );
    expect(rows[0]?.name).toBe('Carla Dias');
  });

  it('nome já corrigido na Fliqo não é sobrescrito pela planilha', async () => {
    await owner.query(
      `insert into app.patients (clinic_id, name, phone_e164) values ($1, 'Carla Dias Souza', $2)`,
      [c.clinicA, '+5511944443333'],
    );
    await importar(['CARLA D;11944443333;Dra. Ana;05/10/2026 14:00;Limpeza']);
    const { rows } = await owner.query<{ name: string }>(
      `select name from app.patients where clinic_id = $1 and phone_e164 = $2`,
      [c.clinicA, '+5511944443333'],
    );
    expect(rows[0]?.name, 'a planilha desfez a correção da recepção').toBe('Carla Dias Souza');
  });
});

describe('linha recusada nunca some em silêncio', () => {
  it('a linha malformada vem no relatório com o número e o motivo', async () => {
    const r = relatorioDe(
      await importar([
        'Maria Silva;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza',
        'Sem Telefone;;Dra. Ana;05/10/2026 15:00;Limpeza',
        'Data Ruim;11988776655;Dra. Ana;30/02/2026 15:00;Limpeza',
        ';11977665544;Dra. Ana;05/10/2026 16:00;Limpeza',
      ]),
    );
    expect(r).toMatchObject({ total: 4, entraram: 1, recusadas: 3 });
    // O número é o da LINHA NO ARQUIVO, contando o cabeçalho: é nele que a pessoa
    // vai abrir a planilha para consertar.
    expect(r.recusas).toEqual([
      { linha: 3, motivo: 'telefone_invalido', rotulo: 'Sem Telefone' },
      { linha: 4, motivo: 'data_invalida', rotulo: 'Data Ruim' },
      { linha: 5, motivo: 'sem_paciente', rotulo: '' },
    ]);
  });

  it('a recusa fica gravada, e o relatório pode ser reaberto depois', async () => {
    const r = relatorioDe(
      await importar(['Sem Telefone;;Dra. Ana;05/10/2026 15:00;Limpeza'], {
        arquivo: 'outubro.csv',
      }),
    );

    const depois = await chamar('GET', `/api/importacoes/${r.id}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(depois.statusCode).toBe(200);
    expect(depois.json<RelatorioDaImportacao>()).toMatchObject({
      arquivo: 'outubro.csv',
      recusadas: 1,
      recusas: [{ linha: 2, motivo: 'telefone_invalido', rotulo: 'Sem Telefone' }],
    });
  });

  it('a recusa gravada não guarda o telefone', async () => {
    await importar(['Zé;11911112222;Dra. Ana;amanhã;Limpeza']);
    const { rows } = await owner.query<{ label: string; reason: string }>(
      'select label, reason from app.schedule_import_rows',
    );
    expect(rows).toHaveLength(1);
    // Nem o número, nem os dígitos sem o +: linha recusada não precisa de uma cópia
    // a mais do telefone do paciente numa tabela nova.
    const tudo = JSON.stringify(rows);
    expect(tudo).not.toContain('11911112222');
    expect(tudo).not.toContain('911112222');
  });

  it('planilha só com cabeçalho é falha esperada, com motivo, e não erro', async () => {
    const r = await importar([]);
    expect(r.statusCode).toBe(200);
    expect(r.json<SaidaDaImportacao>()).toMatchObject({
      ok: false,
      motivo: 'planilha_sem_linhas',
    });
  });

  it('planilha grande demais diz o máximo, em vez de estourar', async () => {
    const muitas = Array.from(
      { length: 2001 },
      (_, i) =>
        `P ${String(i)};1199988${String(i).padStart(4, '0')};Dra. Ana;05/10/2026 14:00;Limpeza`,
    );
    const r = await importar(muitas);
    expect(r.json<SaidaDaImportacao>()).toMatchObject({
      ok: false,
      motivo: 'planilha_grande_demais',
      maximo: 2000,
    });
    expect(await quantasConsultas(), 'recusou e gravou de todo jeito').toBe(0);
  });
});

describe('quem pode importar', () => {
  it('a recepção não importa agenda', async () => {
    const r = await importar(['Maria;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza'], {
      userId: RECEPCAO_DA_A,
    });
    expect(r.statusCode).toBe(403);
    expect(await quantasConsultas()).toBe(0);
  });

  it('a dona da B não importa para a agenda da A', async () => {
    const r = await importar(['Maria;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza'], {
      userId: DONA_DA_B,
    });
    expect(r.statusCode).toBe(403);
    expect(await quantasConsultas()).toBe(0);
  });

  it('a importação de uma clínica não aparece na outra', async () => {
    const r = relatorioDe(await importar(['Maria;11999887766;Dra. Ana;05/10/2026 14:00;Limpeza']));
    const daB = await chamar('GET', `/api/importacoes/${r.id}`, {
      userId: DONA_DA_B,
      clinica: c.clinicB,
    });
    // A RLS não acha a linha: para a clínica B aquela importação não existe.
    expect(daB.statusCode).toBe(404);
  });
});

describe('o modo convidado desliga o que não é nosso', () => {
  /** O teste que o pedido nomeou. A guarda é real; a rota é de teste porque a tela ainda não existe. */
  it('a clínica em modo convidado não enxerga prontuário', async () => {
    const r = await chamar('GET', '/teste/prontuario', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);
    // O motivo é dito: não é falta de permissão, é a clínica tendo dito onde está a
    // verdade. A tela precisa escrever isso em português.
    expect(r.json()).toEqual({ erro: 'recurso_do_modo_proprio', recurso: 'prontuario' });
    expect(r.body).not.toContain('conteúdo de prontuário');
  });

  it('a clínica que marca na Fliqo enxerga', async () => {
    const r = await chamar('GET', '/teste/prontuario', {
      userId: DONA_DA_B,
      clinica: c.clinicB,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ficha: 'conteúdo de prontuário' });
  });

  it('o painel sabe o modo de cada clínica, para não oferecer aba que leva a 403', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/minhas-clinicas',
      headers: { authorization: `Bearer ${await token(DONA_DA_A)}` },
    });
    expect(r.json<{ id: string; modoConvidado: boolean }[]>()).toEqual([
      { id: c.clinicA, nome: 'Clínica A', papel: 'dono', modoConvidado: true },
    ]);
  });

  /**
   * A outra metade da promessa: o resto do sistema NÃO muda. A consulta importada
   * entra na agenda como qualquer outra, com a régua de confirmação da clínica —
   * quem agenda as ações é o mesmo gatilho que já existia.
   */
  it('consulta importada entra na agenda como as outras, com ação agendada', async () => {
    await importar(['Maria;11999887766;Dra. Ana;05/10/2027 14:00;Limpeza']);
    const { rows } = await owner.query<{ source: string; status: string; acoes: string }>(
      `select a.source, a.status,
              (select count(*) from app.scheduled_actions s where s.appointment_id = a.id) as acoes
         from app.appointments a where a.clinic_id = $1`,
      [c.clinicA],
    );
    expect(rows[0]?.source, 'a consulta importada deveria se reconhecer').toBe('importado');
    expect(rows[0]?.status).toBe('agendado');
    expect(
      Number(rows[0]?.acoes),
      'consulta importada ficou sem confirmação: o modo convidado não serve para nada assim',
    ).toBeGreaterThan(0);
  });
});
