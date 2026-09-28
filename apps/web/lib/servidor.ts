import { cookies } from 'next/headers';
import { criarClienteSupabase } from './sessao';

/** Qual clínica a pessoa está olhando. httpOnly porque tudo aqui é httpOnly. */
export const COOKIE_DA_CLINICA = 'fliqo_clinica';

/**
 * O portador da sessão, lido do cookie no servidor.
 *
 * Não verifica o token: quem verifica é a nossa API, com o segredo do Supabase,
 * como sempre fez. Aqui só se pega o que vai no cabeçalho — e se a API disser
 * 401, a tela manda para o login.
 */
export async function tokenDaSessao(): Promise<string | undefined> {
  const loja = await cookies();
  const supabase = criarClienteSupabase({
    ler: () => loja.getAll().map((c) => ({ name: c.name, value: c.value })),
  });
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

export async function clinicaEscolhida(): Promise<string | undefined> {
  const loja = await cookies();
  return loja.get(COOKIE_DA_CLINICA)?.value;
}
