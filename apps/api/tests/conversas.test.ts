import { criarDb, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
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
import { PassThrough } from 'node:stream';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';

/**
 * A caixa de entrada e a ficha do lead.
 *
 * O que se prova aqui, além do isolamento entre clínicas: o corpo da mensagem
 * do paciente chega inteiro na tela e não chega em log nenhum, e o telefone sai
 * mascarado na lista e inteiro só na ficha.
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

/** Conteúdo plantado: se aparecer em log, o teste acusa. */
const SEGREDO_DO_PACIENTE = 'tenho medo de dentista desde crianca e nao conto pra ninguem';
const TELEFONE_A = '+5511999990001';
const TELEFONE_B = '+5511988887777';

let app: FastifyInstance;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;
let conversaA: string;
let conversaB: string;

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
  opcoes: { userId?: string; clinica?: string; corpo?: unknown } = {},
) {
  const jwt = opcoes.userId === undefined ? undefined : await token(opcoes.userId);
  return app.inject({
    method: metodo,
    url,
    headers: {
      ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
      ...(opcoes.clinica === undefined ? {} : { 'x-clinica': opcoes.clinica }),
      ...(opcoes.corpo === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(opcoes.corpo === undefined ? {} : { payload: JSON.stringify(opcoes.corpo) }),
  });
}

/** Uma conversa com mensagem, em qualquer clínica. */
async function conversaCom(
  clinicId: string,
  pacienteId: string,
  corpo: string,
  modo: 'ia' | 'humano',
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `insert into app.conversations (clinic_id, patient_id, mode, handover_reason, last_inbound_at)
     values ($1,$2,$3,$4, now()) returning id`,
    [clinicId, pacienteId, modo, modo === 'humano' ? 'paciente pediu atendimento humano' : null],
  );
  const id = rows[0]!.id;
  await owner.query(
    `insert into app.messages (clinic_id, conversation_id, direction, author, body)
     values ($1,$2,'entrada','paciente',$3)`,
    [clinicId, id, corpo],
  );
  return id;
}

beforeAll(async () => {
  await resetDatabase();
  await prepararFilaDeTeste();
  owner = ownerPool();
  c = await seed(owner);

  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role) values ($1,$2,'dono'), ($3,$4,'dono')`,
    [c.clinicA, DONA_DA_A, c.clinicB, DONA_DA_B],
  );

  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
  await boss.start();
  app = construirApp({ config, db, boss });
  await app.ready();

  conversaA = await conversaCom(c.clinicA, c.patients[0]!, SEGREDO_DO_PACIENTE, 'humano');
  conversaB = await conversaCom(c.clinicB, c.patientB, 'mensagem da clinica B', 'ia');
  // Uma segunda da A, em modo assistente, para provar a ordenação.
  await conversaCom(c.clinicA, c.patients[1]!, 'oi, queria marcar', 'ia');
}, 90_000);

afterAll(async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  await owner.end();
});

describe('caixa de entrada', () => {
  it('conversa em modo humano vem no topo, marcada', async () => {
    const r = await chamar('GET', '/api/conversas', { userId: DONA_DA_A, clinica: c.clinicA });
    expect(r.statusCode).toBe(200);
    const lista = r.json();
    expect(lista).toHaveLength(2);
    // Quem já tem alguém esperando vem primeiro: a assistente calou ali.
    expect(lista[0].modo).toBe('humano');
    expect(lista[0].motivoHandover).toBe('paciente pediu atendimento humano');
  });

  it('o telefone sai mascarado na lista', async () => {
    const r = await chamar('GET', '/api/conversas', { userId: DONA_DA_A, clinica: c.clinicA });
    expect(r.body).not.toContain(TELEFONE_A);
    expect(r.json()[0].telefoneMascarado).toBe('+5511***01');
  });

  it('filtra por estado', async () => {
    const humanas = await chamar('GET', '/api/conversas?estado=humano', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(humanas.json()).toHaveLength(1);

    const daAssistente = await chamar('GET', '/api/conversas?estado=assistente', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(daAssistente.json()).toHaveLength(1);
    expect(daAssistente.json()[0].modo).toBe('ia');
  });

  it('estado inventado é recusado antes de tocar no banco', async () => {
    const r = await chamar('GET', '/api/conversas?estado=qualquer', {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('ficha do lead', () => {
  it('traz o telefone inteiro, ao contrário da lista', async () => {
    const r = await chamar('GET', `/api/conversas/${conversaA}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().paciente.telefone).toBe(TELEFONE_A);
  });

  it('a origem sai de quem escreveu primeiro, sem guardar cópia', async () => {
    const r = await chamar('GET', `/api/conversas/${conversaA}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.json().qualificacao.origem.quem).toBe('paciente');
  });

  it('a urgência sai do motivo do handover quando não há alerta', async () => {
    const r = await chamar('GET', `/api/conversas/${conversaA}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.json().qualificacao.urgencia.nivel).toBe('normal');
    expect(r.json().qualificacao.urgencia.motivo).toBe('paciente pediu atendimento humano');
  });

  it('alerta urgente aberto na conversa levanta a urgência', async () => {
    await owner.query(
      `insert into app.alerts (clinic_id, conversation_id, kind, severity, title)
       values ($1,$2,'emergencia','urgente','Possível emergência')`,
      [c.clinicA, conversaA],
    );
    const r = await chamar('GET', `/api/conversas/${conversaA}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.json().qualificacao.urgencia.nivel).toBe('alta');
    await owner.query(`delete from app.alerts where conversation_id = $1`, [conversaA]);
  });

  it('conversa que não existe devolve 404', async () => {
    const r = await chamar('GET', `/api/conversas/${c.clinicB}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('qualificação escrita pela recepção', () => {
  it('grava e carimba quem editou com o sub do JWT', async () => {
    const r = await chamar('POST', `/api/conversas/${conversaA}/qualificacao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { interesse: 'harmonização facial', faixaDeOrcamento: 'de_3k_a_10k' },
    });
    expect(r.statusCode).toBe(200);
    // O autor vem do token verificado, nunca do corpo do pedido.
    expect(r.json().updated_by).toBe(DONA_DA_A);
    expect(r.json().interest).toBe('harmonização facial');
  });

  it('campo ausente não apaga o que outra pessoa escreveu', async () => {
    await chamar('POST', `/api/conversas/${conversaA}/qualificacao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { observacao: 'ligar depois das 18h' },
    });
    const ficha = await chamar('GET', `/api/conversas/${conversaA}`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(ficha.json().qualificacao.interesse).toBe('harmonização facial');
    expect(ficha.json().qualificacao.observacao).toBe('ligar depois das 18h');
  });

  it('autor mandado no corpo é ignorado: quem vale é o sub do JWT', async () => {
    // Nenhum id vindo do cliente é fonte de autorização nem de autoria.
    const outro = '99999999-9999-4999-8999-999999999999';
    const r = await chamar('POST', `/api/conversas/${conversaA}/qualificacao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { observacao: 'com autor forjado', autor: outro, updated_by: outro },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().updated_by).toBe(DONA_DA_A);

    const { rows } = await owner.query<{ updated_by: string }>(
      `select updated_by from app.lead_qualifications where conversation_id = $1`,
      [conversaA],
    );
    expect(rows[0]?.updated_by).toBe(DONA_DA_A);
  });

  it('faixa de orçamento inventada é recusada', async () => {
    const r = await chamar('POST', `/api/conversas/${conversaA}/qualificacao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { faixaDeOrcamento: 'muito_dinheiro' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('assumir e devolver', () => {
  it('assumir silencia a assistente e devolver a traz de volta', async () => {
    const assumir = await chamar('POST', `/api/conversas/${conversaA}/assumir`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(assumir.json().mode).toBe('humano');

    const devolver = await chamar('POST', `/api/conversas/${conversaA}/devolver`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
    expect(devolver.json().mode).toBe('ia');
    expect(devolver.json().handover_reason).toBeNull();

    // Volta ao estado do cenário para não afetar os outros casos.
    await chamar('POST', `/api/conversas/${conversaA}/assumir`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
    });
  });
});

describe('isolamento entre clínicas', () => {
  it('a dona da B não abre a caixa de entrada da A', async () => {
    const r = await chamar('GET', '/api/conversas', { userId: DONA_DA_B, clinica: c.clinicA });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ erro: 'nao_e_membro_da_clinica' });
    // O corpo do 403 não carrega nada da clínica pedida.
    expect(r.body).not.toContain(SEGREDO_DO_PACIENTE);
    expect(r.body).not.toContain(TELEFONE_A);
    expect(r.body).not.toContain('Paciente 1');
  });

  it('a dona da B não abre a ficha de um lead da A', async () => {
    for (const url of [`/api/conversas/${conversaA}`, `/api/conversas/${conversaA}/mensagens`]) {
      const r = await chamar('GET', url, { userId: DONA_DA_B, clinica: c.clinicA });
      expect(r.statusCode, url).toBe(403);
      expect(r.body, url).not.toContain(SEGREDO_DO_PACIENTE);
      expect(r.body, url).not.toContain(TELEFONE_A);
    }
  });

  it('a dona da B não assume, não devolve e não qualifica conversa da A', async () => {
    const acoes: [string, unknown][] = [
      [`/api/conversas/${conversaA}/assumir`, undefined],
      [`/api/conversas/${conversaA}/devolver`, undefined],
      [`/api/conversas/${conversaA}/qualificacao`, { observacao: 'invadido' }],
    ];
    for (const [url, corpo] of acoes) {
      const r = await chamar('POST', url, {
        userId: DONA_DA_B,
        clinica: c.clinicA,
        ...(corpo === undefined ? {} : { corpo }),
      });
      expect(r.statusCode, url).toBe(403);
      expect(r.body, url).not.toContain(SEGREDO_DO_PACIENTE);
    }

    const { rows } = await owner.query(
      `select note from app.lead_qualifications where conversation_id = $1`,
      [conversaA],
    );
    expect(rows[0]?.note).not.toBe('invadido');
  });

  it('pedir a própria clínica com id da outra no corpo não muda nada', async () => {
    // O clinicId nunca vem do cliente: vem da transação já autenticada.
    const r = await chamar('POST', `/api/conversas/${conversaB}/qualificacao`, {
      userId: DONA_DA_A,
      clinica: c.clinicA,
      corpo: { observacao: 'tentando alcançar a B' },
    });
    // A conversa da B não existe dentro da clínica A: a RLS não a enxerga.
    expect(r.statusCode).toBe(404);
    const { rows } = await owner.query(
      `select count(*)::int as n from app.lead_qualifications where conversation_id = $1`,
      [conversaB],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('x-clinica de clínica da qual não é membro devolve 403 em toda rota', async () => {
    // A conferência não é da rota: é do comUsuario, e vale para todas.
    const rotas = [
      '/api/conversas',
      '/api/conversas?estado=humano',
      `/api/conversas/${conversaB}`,
      '/api/hoje',
      '/api/agenda/semana',
    ];
    for (const url of rotas) {
      const r = await chamar('GET', url, { userId: DONA_DA_A, clinica: c.clinicB });
      expect(r.statusCode, url).toBe(403);
    }
  });

  it('as clínicas aceitas no x-clinica são exatamente as de clinic_ids_of_member', async () => {
    // A autorização por requisição é o membroDaClinica DENTRO da transação, que
    // passa pela RLS. Esta invariante amarra os dois: o que a função security
    // definer lista e o que o cabeçalho aceita não podem divergir.
    for (const [usuario, esperadas] of [
      [DONA_DA_A, [c.clinicA]],
      [DONA_DA_B, [c.clinicB]],
    ] as const) {
      const { rows } = await owner.query<{ clinic_id: string }>(
        `select app.clinic_ids_of_member($1) as clinic_id`,
        [usuario],
      );
      expect(rows.map((r) => r.clinic_id).sort()).toEqual([...esperadas].sort());

      for (const clinica of [c.clinicA, c.clinicB]) {
        const r = await chamar('GET', '/api/conversas', { userId: usuario, clinica });
        const aceito = r.statusCode === 200;
        expect(aceito, `${usuario} em ${clinica}`).toBe(esperadas.includes(clinica));
      }
    }
  });
});

describe('conteúdo de mensagem nunca vai para o log', () => {
  it('nem o corpo da mensagem, nem o telefone completo', async () => {
    const linhas: string[] = [];
    const fluxo = new PassThrough();
    fluxo.on('data', (pedaco: Buffer) => linhas.push(pedaco.toString('utf8')));

    const comLog = construirApp({ config, db, boss, fluxoDeLog: fluxo });
    await comLog.ready();
    const jwt = await token(DONA_DA_A);
    const cabecalhos = { authorization: `Bearer ${jwt}`, 'x-clinica': c.clinicA };

    for (const url of [
      '/api/conversas',
      `/api/conversas/${conversaA}`,
      `/api/conversas/${conversaA}/mensagens`,
    ]) {
      const r = await comLog.inject({ method: 'GET', url, headers: cabecalhos });
      expect(r.statusCode, url).toBe(200);
    }
    await comLog.close();

    const tudo = linhas.join('');
    expect(tudo).not.toContain(SEGREDO_DO_PACIENTE);
    expect(tudo).not.toContain(TELEFONE_A);
    expect(tudo).not.toContain(TELEFONE_B);
  });
});
