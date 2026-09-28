import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A sessão do painel mora em cookie httpOnly, e só no servidor.
 *
 * O @supabase/ssr grava com `httpOnly: false` por padrão — é o que permite o
 * cliente do navegador ler o token. O painel mostra dado de saúde: token que o
 * JavaScript da página consegue ler vira sessão roubada no primeiro XSS. Por
 * isso as opções abaixo são forçadas na hora de gravar, e não deixadas por
 * conta do padrão da biblioteca.
 *
 * O navegador nunca vê o token: quem fala com a nossa API é o servidor do
 * painel, que lê o cookie e põe o Bearer no cabeçalho. O navegador só carrega
 * o portador.
 */

export interface CookieLido {
  name: string;
  value: string;
}

export interface CookieParaGravar {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

export interface OpcoesDoCookie {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
}

/**
 * `secure` só fora de desenvolvimento: no localhost o navegador descarta o
 * cookie seguro e ninguém consegue entrar. Em produção é https e ele vale.
 */
export function opcoesDoCookie(producao: boolean): OpcoesDoCookie {
  return { httpOnly: true, sameSite: 'lax', secure: producao, path: '/' };
}

export function emProducao(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Endereço e chave pública do Supabase.
 *
 * Sem `NEXT_PUBLIC_`: nada de Supabase precisa chegar ao navegador, porque o
 * navegador não fala com o Supabase. Prefixo público embutiria isto no pacote
 * do cliente e convidaria a próxima pessoa a criar um cliente lá.
 */
export interface ConfigSupabase {
  url: string;
  chaveAnonima: string;
}

export function lerConfigSupabase(env: NodeJS.ProcessEnv = process.env): ConfigSupabase {
  const url = env.SUPABASE_URL;
  const chaveAnonima = env.SUPABASE_ANON_KEY;
  if (!url || !chaveAnonima) {
    throw new Error('configuração inválida: SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórios');
  }
  return { url, chaveAnonima };
}

export interface CofreDeCookies {
  ler: () => CookieLido[];
  /**
   * Ausente onde o framework não deixa gravar (componente de servidor). Nesse
   * caso quem renova a sessão é o proxy (proxy.ts), que roda antes.
   *
   * `cabecalhos` são os que a biblioteca manda junto quando grava sessão —
   * no-store e companhia. Sem eles, um CDN na frente do painel pode guardar a
   * resposta com o Set-Cookie e entregar a sessão de uma pessoa para outra.
   */
  gravar?: (cookies: CookieParaGravar[], cabecalhos: Record<string, string>) => void;
}

/**
 * O que o painel usa do Supabase: autenticação, e só (CLAUDE.md, regra 10).
 *
 * O tipo é estreito de propósito: o método de ler tabela não existe nele, então
 * quem tentar ler tabela por aqui não passa nem do typecheck.
 */
export type ClienteDeAutenticacao = Pick<SupabaseClient, 'auth'>;

export function criarClienteSupabase(
  cofre: CofreDeCookies,
  env: NodeJS.ProcessEnv = process.env,
): ClienteDeAutenticacao {
  const { url, chaveAnonima } = lerConfigSupabase(env);
  const forcadas = opcoesDoCookie(emProducao(env));

  return createServerClient(url, chaveAnonima, {
    cookies: {
      getAll: () => cofre.ler(),
      setAll: (cookies, cabecalhos) => {
        // As nossas opções vêm DEPOIS das da biblioteca: httpOnly, sameSite e
        // path são decisão nossa, não dela.
        cofre.gravar?.(
          cookies.map((c) => ({
            name: c.name,
            value: c.value,
            options: { ...c.options, ...forcadas },
          })),
          cabecalhos,
        );
      },
    },
  });
}
