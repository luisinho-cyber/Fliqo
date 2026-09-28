# apps/web — o painel da clínica

Next.js (App Router) + Tailwind. Fases 6 e 7 do roteiro; nesta fase existe uma
tela: **Hoje**.

## O que roda onde

Tudo que importa roda no servidor. O navegador recebe HTML pronto e dois
componentes pequenos: o cursor "agora", que anda sozinho, e o recarregar
periódico.

- A sessão fica num cookie **httpOnly** (`@supabase/ssr`). O JavaScript da
  página não lê o token — nem o nosso, nem o de quem conseguir injetar script.
- O `supabase-js` serve só para autenticar. **Nenhuma leitura de tabela pelo
  navegador**: o painel fala com a nossa API, que abre `withClinic` e passa
  pela RLS (CLAUDE.md, regra 10). `apps/web/tests/guardas.test.ts` e uma regra
  de lint quebram o CI se alguém tentar.
- Nada de paciente em `localStorage` ou `sessionStorage`. Nem cache, nem
  rascunho.
- `proxy.ts` (o antigo middleware) renova a sessão e manda para `/login` quem
  não tiver uma.

## Variáveis

| Variável            | Para quê                              |
| ------------------- | ------------------------------------- |
| `API_URL`           | onde a nossa API responde             |
| `SUPABASE_URL`      | projeto do Supabase (só autenticação) |
| `SUPABASE_ANON_KEY` | chave pública do projeto              |

Sem prefixo `NEXT_PUBLIC_` de propósito: nada de Supabase vai para o navegador.

## Comandos

```
npm run dev --workspace @fliqo/web    # localhost:3200
npm run typecheck:web
npm run build:web
```

## O que ainda não está ligado

`public/conectar-whatsapp.html` é a página do Embedded Signup, da fase da
conexão com a Meta. Ela ainda não faz parte do painel: espera um
`window.FLIQO_CONFIG` com o token dentro do navegador, que é justamente o que a
sessão em cookie httpOnly existe para evitar. Antes de ligá-la ao painel, ela
precisa passar a chamar a nossa API pelo servidor, como o resto daqui. Enquanto
isso, o `proxy.ts` mantém a página atrás do login.
