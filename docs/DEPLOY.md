# Deploy de staging

Este passo a passo põe a Fliqo no ar em ambiente de teste: banco e login no
**Supabase**, API e worker no **Railway**. Siga na ordem. Cada passo diz onde
clicar e onde colar cada coisa.

Uma regra vale para tudo: **senha e chave só existem em dois lugares** — no
gerenciador de senhas e no campo do Railway ou do Supabase. Nunca em arquivo do
projeto, nunca numa conversa, nunca num print.

## Quem é quem

| Peça                     | Onde roda      | Conecta ao banco como | Pode mexer no schema   |
| ------------------------ | -------------- | --------------------- | ---------------------- |
| Migrações (`db:migrate`) | Seu computador | `postgres` (dono)     | sim, é o trabalho dela |
| API (`apps/api`)         | Railway        | `fliqo_app`           | não                    |
| Worker (`apps/worker`)   | Railway        | `fliqo_app`           | não                    |

A aplicação **nunca** conecta como dono do schema. É o que faz a separação entre
clínicas valer: como `fliqo_app`, toda consulta passa pela RLS.

---

## Passo 1 — Pegar as conexões no Supabase

No projeto `fliqo-staging`, clique em **Connect**, no topo da página. Vão
aparecer três opções. Você vai usar duas:

- **Direct connection** — para as migrações. É a conexão do dono.
  Ela é IPv6. Se o seu computador não tiver IPv6 (a maioria das redes de casa
  no Brasil não tem), use a **Session pooler** no lugar: é a mesma coisa por
  IPv4.
- **Transaction pooler** — para a API e o worker.

Copie as duas e guarde no gerenciador de senhas. Na string da Direct connection,
`[YOUR-PASSWORD]` é a senha do banco, aquela que você escolheu quando criou o
projeto. Se não lembrar: **Project Settings > Database > Reset database
password**.

> **Por que o pooler para a aplicação?** Porque toda consulta nossa roda dentro
> de uma transação (é assim que a clínica é fixada, com `set_config(...,
true)`), e o modo transação devolve a conexão ao fim de cada uma. É o que
> aguenta a API e o worker juntos sem estourar o limite de conexões.

## Passo 2 — Criar a senha do papel da aplicação

Este papel (`fliqo_app`) é criado pelas migrações, mas sem senha. Você dá a
senha uma vez, do seu computador.

Gere uma senha:

```
openssl rand -base64 24
```

Guarde no gerenciador de senhas. Depois, ainda no seu computador:

```
export DATABASE_ADMIN_URL="<a Direct connection do passo 1>"
export FLIQO_APP_PASSWORD="<a senha que você acabou de gerar>"
npm run db:papel-app
```

O script não imprime a senha. Rodar de novo com outra senha é como se troca a
senha do papel — nada mais precisa ser refeito além de atualizar o
`DATABASE_URL` no Railway.

## Passo 3 — Rodar as migrações

**As migrações são um passo separado, feito por você, nunca na subida da
aplicação.** Se a aplicação migrasse sozinha, dois contêineres subindo ao mesmo
tempo tentariam mudar o banco juntos — e ela conecta com um papel que nem pode
fazer isso.

Com o `DATABASE_ADMIN_URL` ainda exportado:

```
npm run db:migrate
```

Isso aplica as migrações em ordem, registra cada uma, e prepara a fila. Rodar de
novo não reaplica nada.

Repita este comando **antes de cada deploy** que traga migração nova.

## Passo 4 — Montar o `DATABASE_URL` da aplicação

Pegue a string do **Transaction pooler** (passo 1) e troque duas coisas:

- o usuário `postgres.<projeto>` vira `fliqo_app.<projeto>`;
- `[YOUR-PASSWORD]` vira a senha do passo 2.

Fica assim (o host e o `<projeto>` são os da sua string):

```
postgresql://fliqo_app.<projeto>:<senha-do-passo-2>@<host-do-pooler>:6543/postgres
```

É **este** valor que vai para o Railway, nos dois serviços.

## Passo 5 — Serviço da API no Railway

No projeto do Railway: **New > GitHub Repo** e escolha `luisinho-cyber/Fliqo`.
Depois, em **Settings** do serviço:

- **Service Name**: `api`
- **Root Directory**: deixe vazio (é um monorepo; o build roda na raiz)
- **Config-as-code file path**: `apps/api/railway.json`

O `apps/api/railway.json` já traz o comando de start, o health check em
`/health` e a política de reinício. Você não precisa preencher isso à mão.

Em **Variables**, cole:

| Variável                | De onde vem                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`          | passo 4                                                     |
| `SUPABASE_JWT_SECRET`   | Supabase > Project Settings > API > JWT Secret              |
| `WHATSAPP_APP_SECRET`   | Meta > seu app > Configurações básicas > Chave secreta      |
| `WHATSAPP_VERIFY_TOKEN` | uma frase inventada por você; a mesma vai na Meta (passo 7) |
| `META_APP_ID`           | Meta > seu app > Configurações básicas                      |
| `META_APP_SECRET`       | Meta > seu app > Configurações básicas                      |
| `WHATSAPP_TOKEN_KEY`    | gere com `openssl rand -base64 32`                          |
| `LOG_LEVEL`             | `info`                                                      |

Não crie `PORT`: o Railway injeta sozinho, e a API usa o que ele der.

Em **Settings > Networking**, clique em **Generate Domain**. Guarde o endereço:
ele é o webhook do passo 7.

## Passo 6 — Serviço do worker no Railway

**New > GitHub Repo**, o mesmo repositório. Em **Settings**:

- **Service Name**: `worker`
- **Root Directory**: vazio
- **Config-as-code file path**: `apps/worker/railway.json`

O worker não atende HTTP: não gere domínio nem configure health check para ele.

Em **Variables**:

| Variável            | De onde vem                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`      | passo 4, o mesmo da API                                              |
| `WHATSAPP_TOKEN`    | Meta > WhatsApp > API Setup, token do número                         |
| `ANTHROPIC_API_KEY` | do painel do provedor; **cole direto aqui, e em nenhum outro lugar** |
| `LOG_LEVEL`         | `info`                                                               |

`ANTHROPIC_MODEL` é opcional. Sem ela, vale `claude-haiku-4-5`. Trocar de modelo
é mudar essa variável e reiniciar o worker.

## Passo 7 — Apontar o webhook na Meta

Em **Meta > seu app > WhatsApp > Configuration > Webhook**:

- **Callback URL**: `https://<o domínio do passo 5>/webhooks/whatsapp`
- **Verify token**: a mesma frase que você pôs em `WHATSAPP_VERIFY_TOKEN`

Clique em **Verify and save**. Se der erro, é quase sempre o token diferente
entre os dois lados.

## Conferir se está de pé

```
curl https://<o domínio do passo 5>/health
```

Tem de responder `{"ok":true}`. Se responder, a API subiu e o Railway vai
mantê-la no ar. Se o deploy ficar reiniciando, veja os logs do serviço: a API
morre no start de propósito quando falta uma variável, e o log diz qual é.

O worker não tem endereço para consultar. Ele avisa no log:
`worker no ar`.

---

## Quando publicar de novo

1. Se o PR tiver migração nova: `npm run db:migrate` do seu computador, **antes**
   de o deploy subir.
2. `git push` na `main`. O Railway reconstrói os dois serviços sozinho.

Os dois `railway.json` têm `watchPatterns`: mexer só na `apps/demo` não
reconstrói a API nem o worker.

## O que nunca vai para o Railway

- **`DATABASE_ADMIN_URL`.** O dono do schema não passa pela RLS. Ele fica no seu
  computador, para migração e manutenção. Se um dia a aplicação precisar dele,
  alguma coisa está errada no desenho.
- **`FLIQO_APP_PASSWORD`.** Ela só é usada pelo script do passo 2. O que o
  Railway precisa é do `DATABASE_URL` já montado.

## Se precisar trocar uma chave

- **Senha do `fliqo_app`**: repita o passo 2 com uma senha nova e atualize o
  `DATABASE_URL` nos dois serviços do Railway. Há uma janela de segundos em que
  os contêineres antigos erram ao reconectar; em staging, tudo bem.
- **`WHATSAPP_TOKEN_KEY`**: não troque na mão. Há um procedimento em
  [OPERACAO.md](OPERACAO.md) — trocar a chave sem recifrar deixa todas as
  clínicas conectadas sem token.
- **`ANTHROPIC_API_KEY`**: revogue no painel do provedor, gere outra e troque só
  a variável do worker.
