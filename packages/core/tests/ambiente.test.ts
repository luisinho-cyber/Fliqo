import { describe, expect, it } from 'vitest';
import {
  AMBIENTE_DA_API,
  AMBIENTE_DO_PAINEL,
  AMBIENTE_DO_WORKER,
  apenas,
  CHAVE_BASE64_32,
  exigirAmbiente,
  lerAmbiente,
  minimoDeCaracteres,
  URL_DA_APLICACAO,
  type AmbienteConhecido,
} from '../src/ambiente';

/**
 * A leitura do ambiente pelo esquema único.
 *
 * O que está em jogo: cada variável que faltava custava UM deploy, porque a mensagem só
 * contava a primeira. Três deploys quebrados em sequência vieram daí.
 */

/** Ambiente completo da api, com valores falsos. Ponto de partida de cada caso. */
const DA_API: AmbienteConhecido = {
  DATABASE_URL: 'postgresql://fliqo_app.ref-falso:senha-falsa@pooler.exemplo:6543/postgres',
  WHATSAPP_APP_SECRET: 'segredo-falso',
  WHATSAPP_VERIFY_TOKEN: 'frase-falsa',
  SUPABASE_JWT_SECRET: 'jwt-falso',
  META_APP_ID: '000000000000000',
  META_APP_SECRET: 'segredo-falso-do-app',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('todas as que faltam, de uma vez', () => {
  it('três faltando vêm nas três linhas, não uma por deploy', () => {
    const r = lerAmbiente(AMBIENTE_DA_API, {
      ...DA_API,
      WHATSAPP_APP_SECRET: undefined,
      SUPABASE_JWT_SECRET: undefined,
      META_APP_SECRET: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problemas.map((p) => p.variavel)).toEqual([
      'WHATSAPP_APP_SECRET',
      'SUPABASE_JWT_SECRET',
      'META_APP_SECRET',
    ]);
  });

  it('cada linha diz de onde a variável vem', () => {
    const r = lerAmbiente(AMBIENTE_DA_API, { ...DA_API, SUPABASE_JWT_SECRET: undefined });
    if (r.ok) throw new Error('devia ter recusado');
    expect(r.problemas[0]?.motivo).toContain('JWT Secret');
  });

  it('string vazia conta como faltando: variável criada no Railway e não preenchida', () => {
    const r = lerAmbiente(AMBIENTE_DA_API, { ...DA_API, META_APP_ID: '' });
    expect(r.ok).toBe(false);
  });

  it('a mensagem de start junta tudo e não repete nenhum valor', () => {
    const chamada = (): unknown =>
      exigirAmbiente('a api', AMBIENTE_DA_API, {
        ...DA_API,
        WHATSAPP_APP_SECRET: undefined,
        META_APP_SECRET: undefined,
      });
    expect(chamada).toThrow(/2 variáveis/);
    expect(chamada).toThrow(/WHATSAPP_APP_SECRET/);
    expect(chamada).toThrow(/META_APP_SECRET/);
    // Segredo não entra em mensagem de erro: ela sobe no log do Railway.
    try {
      chamada();
    } catch (erro) {
      const texto = erro instanceof Error ? erro.message : '';
      for (const valor of Object.values(DA_API)) {
        if (typeof valor === 'string' && valor.length > 3) expect(texto).not.toContain(valor);
      }
    }
  });

  it('com tudo no lugar, devolve a configuração e aplica os padrões', () => {
    const config = exigirAmbiente('a api', AMBIENTE_DA_API, DA_API);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.META_APP_ID).toBe('000000000000000');
  });

  it('PORT vem como número, não como texto', () => {
    const config = exigirAmbiente('a api', AMBIENTE_DA_API, { ...DA_API, PORT: '8080' });
    expect(config.PORT).toBe(8080);
  });

  it('PORT que não é inteiro positivo é recusada', () => {
    for (const porta of ['0', '-1', 'abc', '3.5']) {
      expect(lerAmbiente(AMBIENTE_DA_API, { ...DA_API, PORT: porta }).ok, porta).toBe(false);
    }
  });
});

describe('o formato da conexão da aplicação', () => {
  it('a conexão do DONO do schema é recusada, e a mensagem diz por quê', () => {
    // O dono não passa pela RLS (CLAUDE.md, regra 2): a separação entre clínicas sumiria sem
    // erro nenhum, porque as consultas continuariam funcionando — enxergando tudo.
    const motivo = URL_DA_APLICACAO.conferir(
      'postgresql://postgres.ref-falso:senha-falsa@pooler.exemplo:6543/postgres',
    );
    expect(motivo).toContain('fliqo_app');
    expect(motivo).toContain('RLS');
  });

  it('a do fliqo_app passa, com e sem o ref do pooler', () => {
    expect(URL_DA_APLICACAO.conferir(DA_API.DATABASE_URL ?? '')).toBeUndefined();
    expect(
      URL_DA_APLICACAO.conferir('postgresql://fliqo_app:senha-falsa@localhost:5432/postgres'),
    ).toBeUndefined();
  });

  it('o que não é conexão postgres é recusado', () => {
    expect(URL_DA_APLICACAO.conferir('fliqo_app@banco')).toContain('postgresql://');
  });
});

describe('os outros formatos', () => {
  it('a chave do cofre precisa de 32 bytes, e a mensagem diz quantos tem', () => {
    expect(CHAVE_BASE64_32.conferir(Buffer.alloc(32, 1).toString('base64'))).toBeUndefined();
    expect(CHAVE_BASE64_32.conferir(Buffer.alloc(16, 1).toString('base64'))).toContain('tem 16');
    expect(CHAVE_BASE64_32.conferir('senha-comum-nao-serve')).toContain('32 bytes');
  });

  it('o mínimo de caracteres recusa o curto e aceita o do tamanho exato', () => {
    const formato = minimoDeCaracteres(32);
    expect(formato.conferir('x'.repeat(31))).toContain('tem 31');
    expect(formato.conferir('x'.repeat(32))).toBeUndefined();
  });

  it('formato errado entra na MESMA lista de quem falta', () => {
    const r = lerAmbiente(AMBIENTE_DA_API, {
      ...DA_API,
      WHATSAPP_TOKEN_KEY: 'curta',
      META_APP_ID: undefined,
    });
    if (r.ok) throw new Error('devia ter recusado');
    expect(r.problemas.map((p) => p.variavel)).toEqual(['META_APP_ID', 'WHATSAPP_TOKEN_KEY']);
  });
});

describe('os esquemas descrevem o código de hoje', () => {
  it('o worker da main envia com WHATSAPP_TOKEN, não com a chave por clínica', () => {
    // Declarar a chave aqui faria o worker RECUSAR subir por falta de variável que o código
    // dele não lê. Quando a fase de resiliência entrar, o typecheck cobra a troca.
    const nomes = AMBIENTE_DO_WORKER.map((v) => v.nome);
    expect(nomes).toContain('WHATSAPP_TOKEN');
    expect(nomes).not.toContain('WHATSAPP_TOKEN_KEY');
  });

  it('o painel não lê banco: regra 10 em forma de configuração', () => {
    const nomes: readonly string[] = AMBIENTE_DO_PAINEL.map((v) => v.nome);
    expect(nomes).not.toContain('DATABASE_URL');
    expect(nomes).not.toContain('SUPABASE_JWT_SECRET');
  });

  it('nenhum esquema declara a conexão do dono do schema', () => {
    for (const esquema of [AMBIENTE_DA_API, AMBIENTE_DO_WORKER, AMBIENTE_DO_PAINEL]) {
      expect(esquema.map((v) => v.nome)).not.toContain('DATABASE_ADMIN_URL');
    }
  });

  it('nenhuma variável do painel tem prefixo NEXT_PUBLIC_', () => {
    for (const v of AMBIENTE_DO_PAINEL) expect(v.nome).not.toMatch(/^NEXT_PUBLIC_/);
  });

  it('toda obrigatória diz de onde vem: a tabela do DEPLOY.md sai disto', () => {
    for (const esquema of [AMBIENTE_DA_API, AMBIENTE_DO_WORKER, AMBIENTE_DO_PAINEL]) {
      for (const v of esquema) {
        expect(v.origem.length, `${v.nome} sem origem`).toBeGreaterThan(3);
        expect(v.porque.length, `${v.nome} sem porquê`).toBeGreaterThan(3);
      }
    }
  });
});

describe('o pedaço do esquema, para quem não tem start', () => {
  it('confere só os nomes pedidos', () => {
    const so = apenas(AMBIENTE_DO_PAINEL, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
    const config = exigirAmbiente('o painel', so, {
      SUPABASE_URL: 'https://projeto-falso.supabase.co',
      SUPABASE_ANON_KEY: 'chave-falsa',
    });
    expect(config.SUPABASE_ANON_KEY).toBe('chave-falsa');
  });

  it('e cobra o que falta dentro do pedaço', () => {
    const so = apenas(AMBIENTE_DO_PAINEL, ['API_URL']);
    expect(() => exigirAmbiente('o painel', so, {})).toThrow(/API_URL/);
  });
});
