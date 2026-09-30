import { conexao, criarDb, withClinic, QUALIDADES_DO_NUMERO, type Db } from '@fliqo/db';
import { criarFila } from '@fliqo/db/fila';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { decifrar, lerChave, OnboardingMeta, QUALIDADES } from '@fliqo/whatsapp';
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
function metaFalsa(
  opcoes: {
    falharNa?: 'token' | 'assinatura' | 'registro';
    /** A Meta calada sobre nome e qualidade: acontece, e a tela tem que aguentar. */
    semLeitura?: boolean;
    qualidade?: string;
  } = {},
) {
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
      return responder(200, {
        data: [
          {
            id: 'PN-999',
            display_phone_number: '+5511333322221',
            ...(opcoes.semLeitura === true
              ? {}
              : {
                  verified_name: 'Clínica A',
                  quality_rating: opcoes.qualidade ?? 'GREEN',
                }),
          },
        ],
      });
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

describe('o que a Meta contou sobre o número, com carimbo', () => {
  it('nome verificado e qualidade chegam ao status, cada um com a data de apuração', async () => {
    await montarApp(metaFalsa({ qualidade: 'YELLOW' }));
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const r = await chamar('GET', '/api/whatsapp/status', { userId: DONA, clinica: c.clinicA });
    expect(r.json()).toMatchObject({
      conexao: { nomeVerificado: 'Clínica A', qualidade: 'amarelo' },
    });
    const { conexao: viva } = r.json<{
      conexao: { nomeVerificadoEm: string; qualidadeEm: string };
    }>();
    // O carimbo é o ponto: sem ele a tela não tem como dizer a idade do dado.
    expect(Date.parse(viva.nomeVerificadoEm)).toBeGreaterThan(0);
    expect(Date.parse(viva.qualidadeEm)).toBeGreaterThan(0);
  });

  /**
   * A 0009 proíbe valor sem carimbo. Este teste é a prova de que a proibição
   * está no banco, e não só no código que grava: um `update` direto, como o de
   * um webhook futuro escrito às pressas, bate na mesma parede.
   */
  it('o banco recusa qualidade sem carimbo', async () => {
    await montarApp(metaFalsa());
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    await expect(
      owner.query(
        `update app.whatsapp_numbers
            set quality_rating = 'verde', quality_updated_at = null
          where phone_number_id = 'PN-999'`,
      ),
    ).rejects.toThrow(/qualidade_carimbada/);

    await expect(
      owner.query(
        `update app.whatsapp_numbers
            set verified_name = 'Outro Nome', verified_name_updated_at = null
          where phone_number_id = 'PN-999'`,
      ),
    ).rejects.toThrow(/verified_name_carimbado/);
  });

  it('Meta calada não carimba nada, e o status diz isso com nulo', async () => {
    await montarApp(metaFalsa({ semLeitura: true }));
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const { conexao: viva } = (
      await chamar('GET', '/api/whatsapp/status', { userId: DONA, clinica: c.clinicA })
    ).json<{ conexao: Record<string, unknown> }>();

    expect(viva.qualidade).toBeNull();
    expect(viva.qualidadeEm).toBeNull();
    expect(viva.nomeVerificado).toBeNull();
    expect(viva.nomeVerificadoEm).toBeNull();
  });

  /**
   * Religar sem leitura nova não pode apagar a leitura antiga: a data da última
   * apuração é justamente o que a tela mostra quando o dado envelheceu
   * ("última em 12/06, há 92 dias"). Apagar trocaria "velho e datado" por
   * "nunca houve", que é pior e falso.
   */
  it('religar sem leitura nova preserva a leitura antiga, com o carimbo antigo', async () => {
    await montarApp(metaFalsa({ qualidade: 'RED' }));
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    const antes = (
      await chamar('GET', '/api/whatsapp/status', { userId: DONA, clinica: c.clinicA })
    ).json<{ conexao: { qualidade: string; qualidadeEm: string } }>();

    await montarApp(metaFalsa({ semLeitura: true }));
    await chamar('POST', '/api/whatsapp/reconectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });

    const depois = (
      await chamar('GET', '/api/whatsapp/status', { userId: DONA, clinica: c.clinicA })
    ).json<{ conexao: { qualidade: string; qualidadeEm: string } }>();

    expect(depois.conexao.qualidade).toBe('vermelho');
    expect(depois.conexao.qualidadeEm).toBe(antes.conexao.qualidadeEm);
  });
});

describe('quem mexeu na conexão fica registrado', () => {
  it('conectar guarda o autor, e é o do token, não o que o corpo pediu', async () => {
    await montarApp(metaFalsa());
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      // Tentativa de escolher o autor pelo corpo. Ignorada: quem vale é o `sub`.
      corpo: { ...pedido, actorUserId: RECEPCAO, autorUserId: RECEPCAO },
    });

    const { rows } = await owner.query<{ kind: string; actor_user_id: string | null }>(
      'select kind, actor_user_id from app.whatsapp_connection_events',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(DONA);
  });

  it('a falha também tem autor: "tentou e não deu" precisa de nome', async () => {
    await montarApp(metaFalsa({ falharNa: 'registro' }));
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    const { rows } = await owner.query<{ kind: string; actor_user_id: string | null }>(
      'select kind, actor_user_id from app.whatsapp_connection_events',
    );
    expect(rows[0]).toMatchObject({ kind: 'falhou', actor_user_id: DONA });
  });
});

describe('desconectar', () => {
  async function conectada(): Promise<void> {
    await montarApp(metaFalsa());
    await chamar('POST', '/api/whatsapp/conectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
  }

  it('apaga o token, desativa o número e registra quem desligou', async () => {
    await conectada();
    const r = await chamar('POST', '/api/whatsapp/desconectar', {
      userId: DONA,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query<{
      status: string;
      active: boolean;
      token_ciphertext: Buffer | null;
      token_iv: Buffer | null;
      token_tag: Buffer | null;
      token_updated_at: Date | null;
    }>(
      `select status, active, token_ciphertext, token_iv, token_tag, token_updated_at
         from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );
    expect(rows[0]).toMatchObject({ status: 'desconectado', active: false });
    // As três partes do token vão juntas: meio token guardado é o bug que a
    // constraint `token_completo` existe para impedir.
    expect(rows[0]?.token_ciphertext).toBeNull();
    expect(rows[0]?.token_iv).toBeNull();
    expect(rows[0]?.token_tag).toBeNull();
    expect(rows[0]?.token_updated_at).toBeNull();

    const { rows: evts } = await owner.query<{ kind: string; actor_user_id: string | null }>(
      'select kind, actor_user_id from app.whatsapp_connection_events order by created_at',
    );
    expect(evts.map((e) => e.kind)).toEqual(['conectou', 'desconectou']);
    expect(evts[1]?.actor_user_id).toBe(DONA);
  });

  it('desligado, o worker não acha mais a clínica pelo número', async () => {
    // `clinic_by_phone_number_id` filtra `active`: é o que faz o webhook parar.
    await conectada();
    await chamar('POST', '/api/whatsapp/desconectar', { userId: DONA, clinica: c.clinicA });

    const { rows } = await owner.query<{ clinica: string | null }>(
      `select app.clinic_by_phone_number_id('PN-999') as clinica`,
    );
    expect(rows[0]?.clinica).toBeNull();
  });

  it('a recepção não desliga o WhatsApp da clínica', async () => {
    await conectada();
    const r = await chamar('POST', '/api/whatsapp/desconectar', {
      userId: RECEPCAO,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);

    const { rows } = await owner.query<{ status: string }>(
      `select status from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );
    expect(rows[0]?.status).toBe('conectado');
  });

  it('a dona da clínica B não desliga o número da A, e o 403 não conta nada da A', async () => {
    await conectada();
    const r = await chamar('POST', '/api/whatsapp/desconectar', {
      userId: DONA_DA_B,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(403);

    // O corpo do 403 não confirma sequer que existe número ligado na A.
    for (const vazamento of ['PN-999', '+5511333322221', 'Clínica A', 'WABA-123', 'conectado']) {
      expect(r.body).not.toContain(vazamento);
    }

    const { rows } = await owner.query<{ status: string }>(
      `select status from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );
    expect(rows[0]?.status).toBe('conectado');
  });

  it('sem número ligado, 404 — e não um 200 que faz a pessoa achar que desligou algo', async () => {
    await montarApp(metaFalsa());
    const r = await chamar('POST', '/api/whatsapp/desconectar', {
      userId: DONA,
      clinica: c.clinicA,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ erro: 'nenhum_numero_conectado' });
    expect((await owner.query('select id from app.whatsapp_connection_events')).rows).toHaveLength(
      0,
    );
  });

  it('religar depois de desligar traz o número de volta, com token novo', async () => {
    await conectada();
    await chamar('POST', '/api/whatsapp/desconectar', { userId: DONA, clinica: c.clinicA });

    await montarApp(metaFalsa());
    const r = await chamar('POST', '/api/whatsapp/reconectar', {
      userId: DONA,
      clinica: c.clinicA,
      corpo: pedido,
    });
    expect(r.statusCode).toBe(200);

    const { rows } = await owner.query<{ status: string; active: boolean }>(
      `select status, active from app.whatsapp_numbers where phone_number_id = 'PN-999'`,
    );
    expect(rows[0]).toMatchObject({ status: 'conectado', active: true });
  });
});

describe('as duas listas de qualidade são a mesma lista', () => {
  /**
   * A lista vive em dois lugares por força da regra de dependência: o `check` da
   * 0009 (espelhado em QUALIDADES_DO_NUMERO, em @fliqo/db) e QUALIDADES, em
   * @fliqo/whatsapp, que não pode importar db. Este teste mora aqui porque
   * apps/api é quem importa os dois.
   *
   * Divergir não quebra no start: quebra na hora de gravar, com a Meta mandando
   * um valor que a borda traduziu e o banco recusou.
   */
  it('QUALIDADES (whatsapp) e QUALIDADES_DO_NUMERO (db) coincidem', () => {
    expect([...QUALIDADES].sort()).toEqual([...QUALIDADES_DO_NUMERO].sort());
  });
});
