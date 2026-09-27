import { NextResponse, type NextRequest } from 'next/server';
import { criarClienteSupabase, emProducao, opcoesDoCookie } from './lib/sessao';
import { COOKIE_DA_CLINICA } from './lib/servidor';

/**
 * Renova a sessão e guarda a porta. (No Next 16 este arquivo se chama proxy;
 * é o antigo middleware.)
 *
 * Renovar precisa acontecer aqui porque componente de servidor não pode gravar
 * cookie: sem isto, a sessão morreria na primeira expiração do token e a
 * recepção seria deslogada no meio do expediente.
 *
 * Guardar a porta aqui é o que faz "sair da conta" e "token vencido" caírem no
 * mesmo lugar: sem sessão, /login.
 */
export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const resposta = NextResponse.next({ request: req });

  const supabase = criarClienteSupabase({
    ler: () => req.cookies.getAll().map((c) => ({ name: c.name, value: c.value })),
    gravar: (cookies, cabecalhos) => {
      for (const c of cookies) resposta.cookies.set(c.name, c.value, c.options);
      for (const [nome, valor] of Object.entries(cabecalhos)) resposta.headers.set(nome, valor);
    },
  });

  // getUser() valida contra o Supabase e renova o token quando dá — getSession()
  // sozinho acreditaria num cookie qualquer.
  const { data } = await supabase.auth.getUser();
  const temSessao = data.user !== null;
  const caminho = req.nextUrl.pathname;

  if (!temSessao && caminho !== '/login') {
    return redirecionar(req, '/login', resposta, { limparClinica: true });
  }
  if (temSessao && caminho === '/login') {
    return redirecionar(req, '/hoje', resposta, { limparClinica: false });
  }
  return resposta;
}

/**
 * Redirecionar cria uma resposta nova: os cookies renovados nesta passagem
 * precisam ser copiados, senão a renovação se perde e a pessoa entra num laço
 * de login.
 */
function redirecionar(
  req: NextRequest,
  destino: string,
  origem: NextResponse,
  opcoes: { limparClinica: boolean },
): NextResponse {
  const r = NextResponse.redirect(new URL(destino, req.url));
  for (const c of origem.cookies.getAll()) r.cookies.set(c.name, c.value, c);
  // Sem sessão, a clínica escolhida também não vale mais.
  if (opcoes.limparClinica) {
    r.cookies.set(COOKIE_DA_CLINICA, '', { ...opcoesDoCookie(emProducao()), maxAge: 0 });
  }
  return r;
}

export const config = {
  // Tudo menos os arquivos do próprio Next: o painel inteiro exige sessão.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
