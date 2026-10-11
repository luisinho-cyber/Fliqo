import {
  AMBIENTE_DO_PAINEL,
  apenas,
  exigirAmbiente,
  type AmbienteConhecido,
  type ConfigDoEsquema,
} from '@fliqo/core';

/**
 * A configuração do painel vem do esquema único (packages/core/src/ambiente.ts).
 *
 * Nenhuma delas tem prefixo `NEXT_PUBLIC_`, e isso é a regra 10 em forma de configuração: o
 * navegador não fala com o Supabase nem com a api. Quem lê é o servidor do painel.
 *
 * Aqui a validação é POR LEITOR, e não uma só na subida: o painel não tem start — cada página
 * é uma renderização de servidor. Um leitor que exigisse o esquema inteiro faria a tela de
 * conexão do WhatsApp estourar por falta de uma variável que ela não usa. Os nomes de cada
 * pedaço vêm do esquema pelo tipo, então pedir uma que não existe lá não compila.
 */
export type ConfigDoPainel = ConfigDoEsquema<typeof AMBIENTE_DO_PAINEL>;

const DA_API = apenas(AMBIENTE_DO_PAINEL, ['API_URL']);
const DO_SUPABASE = apenas(AMBIENTE_DO_PAINEL, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);

export function lerEnderecoDaApi(env: AmbienteConhecido): string {
  return exigirAmbiente('o painel', DA_API, env).API_URL;
}

export function lerSupabase(env: AmbienteConhecido): {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
} {
  return exigirAmbiente('o painel', DO_SUPABASE, env);
}
