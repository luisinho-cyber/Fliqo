import { createServer } from 'node:http';
import { TextEncoder } from 'node:util';
import { jwtVerify } from 'jose';

/**
 * O Supabase Auth falso, para o e2e do painel.
 *
 * Existe porque o `proxy.ts` chama `getUser()`, e isso é CERTO: `getSession()` sozinho
 * acreditaria em qualquer cookie, e o comentário de lá diz exatamente isso. Ou seja, o painel
 * recusa sessão forjada por desenho — e um e2e que quisesse passar sem servidor de
 * autenticação teria de enfraquecer a produção, que é o contrário do que um teste serve.
 *
 * Então o terceiro é mockado na borda HTTP, igual ao Graph API no teste de integração. E ele
 * CONFERE A ASSINATURA do token: um stub que aceitasse qualquer coisa faria o teste "sem
 * sessão" passar por acidente e deixaria de provar que o guarda do painel funciona.
 *
 * Nada aqui fala com o Supabase de verdade, e nenhuma credencial real existe neste arquivo.
 */
const PORTA = Number(process.argv[2] ?? 3403);
const SEGREDO = new TextEncoder().encode(
  process.env['SUPABASE_JWT_SECRET'] ?? 'SEGREDO_FALSO_DE_TESTE_NAO_USE_1234567890',
);

function usuarioDe(sub) {
  const agora = new Date().toISOString();
  return {
    id: sub,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'recepcao@exemplo.invalido',
    app_metadata: {},
    user_metadata: {},
    created_at: agora,
    updated_at: agora,
  };
}

const servidor = createServer((req, res) => {
  const responder = (status, corpo) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corpo));
  };

  const caminho = (req.url ?? '').split('?')[0];
  if (caminho === '/health') return responder(200, { ok: true });

  // O que o getUser() chama.
  if (caminho === '/auth/v1/user') {
    const cabecalho = req.headers.authorization ?? '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice('Bearer '.length) : '';
    jwtVerify(token, SEGREDO)
      .then(({ payload }) => {
        const sub = payload.sub;
        if (typeof sub !== 'string' || sub.length === 0) {
          return responder(401, { code: 401, msg: 'sem sub' });
        }
        return responder(200, usuarioDe(sub));
      })
      .catch(() => responder(401, { code: 401, msg: 'token invalido' }));
    return;
  }

  /*
   * Renovação: o e2e sempre assina token novo, então isto não deveria ser chamado. Responde
   * 400 em vez de 200 com token inventado — se um dia for chamado, o teste falha e alguém
   * descobre por quê, em vez de passar com uma sessão que o painel renovou do nada.
   */
  if (caminho === '/auth/v1/token') {
    return responder(400, { error: 'refresh nao suportado no falso' });
  }

  return responder(404, { error: `rota nao mockada: ${caminho}` });
});

servidor.listen(PORTA, '127.0.0.1', () => {
  process.stdout.write(`supabase auth falso em http://127.0.0.1:${String(PORTA)}\n`);
});
