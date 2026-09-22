import { conexao, criarDb, withClinic, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { decifrar, lerChave, OnboardingMeta } from '@fliqo/whatsapp';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { construirApp } from '../src/app';
import type { Config } from '../src/config';

const JWT_SECRET = 'segredo-jwt-da-conexao';
const CHAVE_BASE64 = Buffer.alloc(32, 9).toString('base64');
const DONA = '44444444-4444-4444-8444-444444444444';
const RECEPCAO = '55555555-5555-4555-8555-555555555555';
const DONA_DA_B = '66666666-6666-4666-8666-666666666666';

const config: Config = {
  DATABASE_URL: 'nao-usado',
  WHATSAPP_APP_SECRET: 'x',
  WHATSAPP_VERIFY_TOKEN: 'y',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  META_APP_ID: 'app-fliqo',
  META_APP_SECRET: 'segredo-do-app',
  WHATSAPP_TOKEN_KEY: CHAVE_BASE64,
  PORT: 0,
  LOG_LEVEL: 'silent',
};

let app: FastifyInstance | undefined;
let db: Db;
let boss: PgBoss;
let owner: pg.Pool;
let c: Scenario;

/**
 * Meta falsa. Cada chamada que o onboarding faz é atendida por uma resposta
 * roteirizada — conectar de verdade exigiria a Meta do outro lado.
 */
function metaFalsa(opcoes: { falharNa?: 'token' | 'assinatura' | 'registro' } = {}) {
  const chamadas: { url: string; corpo?: unknown }[] = [];
  const buscar: typeof fetch = (entrada, init) => {
    const url = entrada instanceof Request ? entrada.url : entrada.toString();
    chamadas.push({
      url,
      ...(typeof init?.body === 'string' ? { corpo: JSON.parse(init.body) as unknown } : {}),
    });

    const responder = (status: number, corpo: unknown) =>
      Promise.resolve(new Response(JSON.stringify(corpo), { status }));

    if (url.includes('oauth/access_token')) {
      return opcoes.falharNa === 'token'
        ? // Provedor ecoando a requisição: é assim que o client_secret escaparia.
          responder(400, { error: { message: `Invalid code. Request was: ${url}` } })
        : responder(200, { access_token: 'TOKEN-SECRETO-DA-CLINICA' });
    }
    if (url.includes('me/businesses')) return responder(200, { data: [{ id: 'WABA-123' }] });
    if (url.includes('/phone_numbers')) {
      return responder(200, { data: [{ id: 'PN-999', display_phone_number: '+5511333322221' }] });
    }
    if (url.includes('subscribed_apps')) {
      return opcoes.falharNa === 'assinatura'
        ? responder(400, { error: { message: 'sem permissão' } })
        : responder(200, { success: true });
    }
    if (url.includes('/register')) {
      return opcoes.falharNa === 'registro'
        ? responder(400, {
            error: { message: `PIN incorreto (client_secret=segredo-do-app usado em ${url})` },
          })
        : responder(200, {});
    }
    return responder(404, {});
  };

  return {
    chamadas,
    onboarding: new OnboardingMeta({ appId: 'app-fliqo', appSecret: 'segredo-do-app', buscar }),
  };
}

async function token(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function montarApp(falsa: ReturnType<typeof metaFalsa>): Promise<FastifyInstance> {
  await app?.close();
  app = construirApp({ config, db, boss, onboarding: falsa.onboarding });
  await app.ready();
  return app;
}

/** O app do teste corrente. Falha alto se algum teste esquecer de montar. */
function oApp(): FastifyInstance {
  if (!app) throw new Error('chame montarApp() antes');
  return app;
}

async function chamar(
  metodo: 'GET' | 'POST',
  url: string,
  o: { userId: string; clinica: string; corpo?: unknown },
) {
  return oApp().inject({
    method: metodo,
    url,
    headers: {
      authorization: `Bearer ${await token(o.userId)}`,
      'x-clinica': o.clinica,
      ...(o.corpo === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(o.corpo === undefined ? {} : { payload: JSON.stringify(o.corpo) }),
  });
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  await owner.query(
    `insert into app.clinic_members (clinic_id, user_id, role)
     values ($1,$2,'dono'), ($1,$3,'recepcao'), ($4,$5,'dono')`,
    [c.clinicA, DONA, RECEPCAO, c.clinicB, DONA_DA_B],
  );
  db = criarDb(urlDoTester());
  boss = criarFila(urlDoTester());
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.whatsapp_connection_events');
  await owner.query('delete from app.whatsapp_numbers');
});

const pedido = { codigo: 'CODIGO-DO-NAVEGADOR', pin: '123456', coexistencia: true };

describe('conectar', () => {
  it('troca o código, assina os webhooks e grava o token CIFRADO', async () => {
    const falsa = metaFalsa();
    await montarApp(falsa);

    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.statusCode).toBe(200);

    const guardado = await owner.query<{
      token_ciphertext: Buffer;
      token_iv: Buffer;
      token_tag: Buffer;
      status: string;
      coexistencia: boolean;
    }>(
      `select token_ciphertext, token_iv, token_tag, status, coexistencia
         from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );
    const linha = guardado.rows[0]!;
    expect(linha.status).toBe('conectado');
    expect(linha.coexistencia).toBe(true);

    // O token NÃO está em claro em lugar nenhum da linha.
    expect(linha.token_ciphertext.toString('utf8')).not.toContain('TOKEN-SECRETO-DA-CLINICA');
    // E decifra de volta com a chave certa.
    expect(
      decifrar(
        { ciphertext: linha.token_ciphertext, iv: linha.token_iv, tag: linha.token_tag },
        lerChave(CHAVE_BASE64),
      ),
    ).toEqual({ ok: true, token: 'TOKEN-SECRETO-DA-CLINICA' });
  });

  it('NÃO assina o campo history — conversa antiga não entra (LGPD)', async () => {
    const falsa = metaFalsa();
    await montarApp(falsa);
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const assinatura = falsa.chamadas.find((x) => x.url.includes('subscribed_apps'));
    const corpo = assinatura?.corpo as { subscribed_fields?: string[] } | undefined;
    const campos = corpo?.subscribed_fields ?? [];

    expect(campos).toContain('smb_message_echoes');
    expect(campos).toContain('messages');
    // A regra que motiva este teste: nada de importar histórico.
    expect(campos).not.toContain('history');
  });

  it('a resposta e o status nunca devolvem o token', async () => {
    await montarApp(metaFalsa());
    const conectar = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    const status = await chamar('GET', '/api/whatsapp/status', {
      userId: DONA,
      clinica: c.clinicA,
    });

    for (const corpo of [conectar.body, status.body]) {
      expect(corpo).not.toContain('TOKEN-SECRETO-DA-CLINICA');
      expect(corpo).not.toContain('token_ciphertext');
      expect(corpo).not.toContain('ciphertext');
    }
    expect(status.json()).toMatchObject({ conexao: { status: 'conectado' } });
  });

  it('falha na Meta não grava conexão e registra o evento', async () => {
    await montarApp(metaFalsa({ falharNa: 'registro' }));
    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ erro: 'registro_falhou' });

    const { rows } = await owner.query('select id from app.whatsapp_numbers');
    expect(rows).toHaveLength(0);

    const { rows: evts } = await owner.query<{ kind: string }>(
      'select kind from app.whatsapp_connection_events',
    );
    expect(evts[0]?.kind).toBe('falhou');
  });

  it('código inválido não vira conexão', async () => {
    await montarApp(metaFalsa({ falharNa: 'token' }));
    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.json()).toEqual({ erro: 'codigo_invalido' });
    expect((await owner.query('select id from app.whatsapp_numbers')).rows).toHaveLength(0);
  });

  it('PIN fora do formato é recusado antes de falar com a Meta', async () => {
    const falsa = metaFalsa();
    await montarApp(falsa);
    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: { ...pedido, pin: '12' },
    });
    expect(r.statusCode).toBe(400);
    expect(falsa.chamadas).toHaveLength(0);
  });
});

describe('quem pode conectar', () => {
  it('recepção não conecta o WhatsApp da clínica', async () => {
    await montarApp(metaFalsa());
    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: RECEPCAO,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.statusCode).toBe(403);
    expect((await owner.query('select id from app.whatsapp_numbers')).rows).toHaveLength(0);
  });

  it('dona da clínica B não conecta na clínica A', async () => {
    await montarApp(metaFalsa());
    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA_DA_B,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.statusCode).toBe(403);
  });

  it('sem token, 401', async () => {
    await montarApp(metaFalsa());
    const r = await oApp().inject({
      method: 'GET',
      url: '/api/whatsapp/status',
      headers: { 'x-clinica': c.clinicA },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('reconectar', () => {
  it('troca o token do mesmo número e registra o evento', async () => {
    await montarApp(metaFalsa());
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    const antes = await owner.query<{ token_ciphertext: Buffer }>(
      `select token_ciphertext from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );

    const r = await chamar('POST', '/api/whatsapp/reconectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.statusCode).toBe(200);

    const depois = await owner.query<{ token_ciphertext: Buffer }>(
      `select token_ciphertext from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );
    // Mesmo número, uma linha só, token regravado (IV novo muda o ciphertext).
    expect(depois.rows).toHaveLength(1);
    expect(depois.rows[0]!.token_ciphertext.equals(antes.rows[0]!.token_ciphertext)).toBe(false);

    const { rows: evts } = await owner.query<{ kind: string }>(
      'select kind from app.whatsapp_connection_events order by created_at',
    );
    expect(evts.map((e) => e.kind)).toEqual(['conectou', 'reconectou']);
  });
});

describe('o token só sai pelo caminho certo', () => {
  it('tokenCifradoDoNumero devolve; status não', async () => {
    await montarApp(metaFalsa());
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const lido = await withClinic(
      c.clinicA,
      async (trx) => ({
        pelaPorta: await conexao.tokenCifradoDoNumero(trx, 'PN-999'),
        pelaVitrine: await conexao.status(trx),
      }),
      db,
    );

    expect(lido.pelaPorta).toBeDefined();
    expect(Object.keys(lido.pelaVitrine ?? {}).join(',')).not.toContain('token');
    expect(JSON.stringify(lido.pelaVitrine)).not.toContain('ciphertext');
  });
});

describe('o token nunca vai para o log', () => {
  it('nada do que o pino escreve contém o token, em nenhum caminho', async () => {
    const linhas: string[] = [];
    const fluxo = new Writable({
      write(pedaco: Buffer, _cod, pronto) {
        linhas.push(pedaco.toString('utf8'));
        pronto();
      },
    });

    // App próprio, com o log capturado.
    await app?.close();
    const falsa = metaFalsa();
    app = construirApp({
      config,
      db,
      boss,
      onboarding: falsa.onboarding,
      fluxoDeLog: fluxo,
    });
    await app.ready();

    // Percorre os caminhos em que o token existe em memória.
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    await chamar('POST', '/api/whatsapp/reconectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    await chamar('GET', '/api/whatsapp/status', { userId: DONA, clinica: c.clinicA });

    // E o caminho de falha, que é onde detalhe de erro costuma vazar segredo.
    await app.close();
    const falha = metaFalsa({ falharNa: 'registro' });
    app = construirApp({
      config,
      db,
      boss,
      onboarding: falha.onboarding,
      fluxoDeLog: fluxo,
    });
    await app.ready();
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const tudo = linhas.join('\n');
    expect(tudo.length).toBeGreaterThan(0); // o log realmente escreveu algo
    expect(tudo).not.toContain('TOKEN-SECRETO-DA-CLINICA');
    expect(tudo).not.toContain('segredo-do-app');
    expect(tudo).not.toContain(CHAVE_BASE64);
  });

  it('o token não vai na URL de nenhuma chamada à Meta', async () => {
    const falsa = metaFalsa();
    await montarApp(falsa);
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    // URL vaza em log de proxy e em mensagem de erro: segredo vai no cabeçalho.
    for (const chamada of falsa.chamadas) {
      expect(chamada.url).not.toContain('TOKEN-SECRETO-DA-CLINICA');
      expect(chamada.url).not.toContain('access_token=');
    }
  });
});

describe('o client_secret nunca escapa', () => {
  it('nem para o log nem para o banco, mesmo com a Meta ecoando a URL', async () => {
    const linhas: string[] = [];
    const fluxo = new Writable({
      write(pedaco: Buffer, _cod, pronto) {
        linhas.push(pedaco.toString('utf8'));
        pronto();
      },
    });

    // Caminho de erro na troca do código: é a chamada que leva o client_secret
    // na URL, e a falsa devolve essa URL dentro da mensagem de erro.
    await app?.close();
    app = construirApp({
      config,
      db,
      boss,
      onboarding: metaFalsa({ falharNa: 'token' }).onboarding,
      fluxoDeLog: fluxo,
    });
    await app.ready();
    const r = await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.statusCode).toBe(502);

    // E o caminho de erro no registro, que também ecoa.
    await app.close();
    app = construirApp({
      config,
      db,
      boss,
      onboarding: metaFalsa({ falharNa: 'registro' }).onboarding,
      fluxoDeLog: fluxo,
    });
    await app.ready();
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const log = linhas.join('\n');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain('segredo-do-app');
    expect(log).not.toContain('client_secret=');

    // O que ficou gravado no banco também não pode ter o segredo.
    const { rows } = await owner.query<{ detail: string | null }>(
      'select detail from app.whatsapp_connection_events',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const linha of rows) {
      expect(linha.detail ?? '').not.toContain('segredo-do-app');
      expect(linha.detail ?? '').not.toContain('client_secret=');
      expect(linha.detail ?? '').not.toContain('code=');
    }

    // E a resposta ao painel também não.
    expect(r.body).not.toContain('segredo-do-app');
  });
});
