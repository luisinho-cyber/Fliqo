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

## Conexão do WhatsApp

`/configuracoes/whatsapp` é componente de servidor, como o resto do painel. O
único pedaço que roda no navegador é `componentes/ConectarWhatsapp.tsx`, porque
o SDK da Meta não roda de outro lugar. Ele recebe dois identificadores públicos
por prop (`META_APP_ID` e `META_CONFIG_ID`, lidos no servidor) e devolve um
CÓDIGO — nunca um token. O código vai para a nossa API por server action, e é lá
que ele vira token, com o segredo do app.

A página antiga `public/conectar-whatsapp.html` foi apagada: ela esperava um
`window.FLIQO_CONFIG` com o token dentro do navegador, que é justamente o que a
sessão em cookie httpOnly existe para evitar.
