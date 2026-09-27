import { describe, expect, it } from 'vitest';
import {
  criarClienteSupabase,
  emProducao,
  lerConfigSupabase,
  opcoesDoCookie,
  type CookieParaGravar,
} from '../lib/sessao';

/**
 * O cookie da sessão.
 *
 * O @supabase/ssr grava com httpOnly: false por padrão. Este teste existe para
 * o dia em que alguém tirar o nosso `...forcadas` achando que é repetição: sem
 * ele, o token volta a ser legível pelo JavaScript da página.
 */

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_ANON_KEY: 'chave-anonima',
};

describe('opcoesDoCookie', () => {
  it('é httpOnly sempre', () => {
    expect(opcoesDoCookie(true).httpOnly).toBe(true);
    expect(opcoesDoCookie(false).httpOnly).toBe(true);
  });

  it('é secure em produção e não em desenvolvimento', () => {
    // No localhost o navegador descarta o cookie seguro e ninguém entra.
    expect(opcoesDoCookie(true).secure).toBe(true);
    expect(opcoesDoCookie(false).secure).toBe(false);
  });

  it('sameSite lax e path na raiz', () => {
    expect(opcoesDoCookie(true).sameSite).toBe('lax');
    expect(opcoesDoCookie(true).path).toBe('/');
  });

  it('emProducao lê do ambiente', () => {
    expect(emProducao({ NODE_ENV: 'production' })).toBe(true);
    expect(emProducao({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('lerConfigSupabase', () => {
  it('exige as duas variáveis, sem valor de desenvolvimento escondido', () => {
    expect(() => lerConfigSupabase({ NODE_ENV: 'test' })).toThrow('SUPABASE_URL');
    expect(lerConfigSupabase(ENV)).toEqual({
      url: 'https://projeto.supabase.co',
      chaveAnonima: 'chave-anonima',
    });
  });
});

/** Uma sessão como o @supabase/ssr grava: JSON em base64url no cookie do projeto. */
function cookieDeSessao(): { name: string; value: string } {
  const sessao = {
    access_token: 'cabeca.corpo.assinatura',
    refresh_token: 'renovacao',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
  const base64url = btoa(JSON.stringify(sessao))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { name: 'sb-projeto-auth-token', value: `base64-${base64url}` };
}

describe('criarClienteSupabase', () => {
  it('grava a sessão com httpOnly, mesmo com a biblioteca pedindo o contrário', async () => {
    const gravados: CookieParaGravar[] = [];
    const cliente = criarClienteSupabase(
      {
        ler: () => [cookieDeSessao()],
        gravar: (cookies) => gravados.push(...cookies),
      },
      { ...ENV, NODE_ENV: 'production' },
    );

    // Sair da conta apaga o cookie pelo mesmo caminho de gravação da sessão —
    // e a biblioteca pede httpOnly: false também aqui.
    await cliente.auth.signOut({ scope: 'local' });

    expect(gravados.length).toBeGreaterThan(0);
    for (const c of gravados) {
      expect(c.options.httpOnly, `${c.name} legível pelo JavaScript da página`).toBe(true);
      expect(c.options.sameSite).toBe('lax');
      expect(c.options.secure).toBe(true);
      expect(c.options.path).toBe('/');
    }
  });

  it('sair da conta apaga o cookie da sessão', async () => {
    const gravados: CookieParaGravar[] = [];
    const cliente = criarClienteSupabase(
      { ler: () => [cookieDeSessao()], gravar: (cookies) => gravados.push(...cookies) },
      ENV,
    );
    await cliente.auth.signOut({ scope: 'local' });

    const apagado = gravados.find((c) => c.name === 'sb-projeto-auth-token');
    expect(apagado?.value).toBe('');
    expect(apagado?.options.maxAge).toBe(0);
  });
});
