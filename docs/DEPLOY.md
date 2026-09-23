# Deploy de staging

Este passo a passo põe a Fliqo no ar em ambiente de teste: banco e login no
**Supabase**, API e worker no **Railway**. Siga na ordem. Cada passo diz onde
clicar e onde colar cada coisa.

Uma regra vale para tudo: **senha e chave só existem em dois lugares** — no
gerenciador de senhas e no campo do Railway ou do Supabase. Nunca em arquivo do
projeto, nunca numa conversa, nunca num print.

## Quem é quem

| Peça                      | Onde roda              | Conecta ao banco como | Pode mexer no schema   |
| ------------------------- | ---------------------- | --------------------- | ---------------------- |
| Migração (`Migrar banco`) | GitHub Actions, na mão | `postgres` (dono)     | sim, é o trabalho dela |
| API (`apps/api`)          | Railway                | `fliqo_app`           | não                    |
| Worker (`apps/worker`)    | Railway                | `fliqo_app`           | não                    |

Você não precisa de nada instalado no seu computador: tudo é feito pelo navegador,
no Supabase, no GitHub e no Railway.

A aplicação **nunca** conecta como dono do schema. É o que faz a separação entre
clínicas valer: como `fliqo_app`, toda consulta passa pela RLS.

---

## Passo 1 — Pegar as conexões no Supabase

No projeto `fliqo-staging`, clique em **Connect**, no topo da página. Vão
aparecer três opções. Você vai copiar duas:

- **qualquer uma das três** (Direct connection, Session pooler ou Transaction
  pooler) — é a conexão do dono, a que roda as migrações. Tanto faz qual: o
  workflow descobre sozinho por onde conectar.
- **Transaction pooler** — é a conexão da aplicação, a da API e do worker.

Cole as duas num rascunho do gerenciador de senhas por enquanto. Nas duas,
`[YOUR-PASSWORD]` é a senha do banco, aquela que você escolheu quando criou o
projeto. Se não lembrar dela: **Project Settings > Database > Reset database
password**.

> **Por que tanto faz, para a migração?** Porque o que o workflow precisa da
> string é só o identificador do projeto (aquele pedaço de letras e números que
> aparece no host ou no usuário) e a senha. Com esses dois, ele monta a conexão
> certa sozinho e testa antes de migrar. Se você colar a forma "errada", ele
> conserta em silêncio.

> **Por que a aplicação usa a Transaction pooler?** Porque ela faz tudo dentro de
> transações curtas, e o modo transação devolve a conexão ao fim de cada uma: é o
> que aguenta a API e o worker juntos sem estourar o limite de conexões. A
> migração é o contrário — tranca o banco durante todo o trabalho, para dois não
> rodarem juntos —, e por isso vai pelo modo sessão, que o workflow escolhe.

## Passo 2 — Gerar a senha do papel da aplicação

O papel `fliqo_app` é criado pelas migrações, mas sem senha. A senha é sua e
precisa ser forte: é ela que separa a aplicação do dono do banco.

Gere no site do seu gerenciador de senhas (1Password, Bitwarden, o do navegador
— todos têm um gerador). Peça **30 caracteres, com letras, números e símbolos**,
e **sem os símbolos `@`, `:`, `/` e `#`** — esses quatro têm significado dentro
de uma URL de conexão e dariam trabalho à toa no passo 4.

Salve no gerenciador com um nome que você reconheça depois, tipo
`Fliqo staging — senha do fliqo_app`. Você vai colar esse valor em dois lugares:
no GitHub (passo 3) e no Railway (passo 4).

## Passo 3 — Cadastrar os secrets e rodar a migração pelo GitHub

As migrações não rodam na subida da aplicação. Se ela migrasse sozinha, dois
contêineres subindo ao mesmo tempo tentariam mudar o banco juntos — e ela conecta
com um papel que nem tem esse direito. Quem roda é você, apertando um botão.

### 3.1 — Cadastrar os dois secrets

No GitHub, no repositório `luisinho-cyber/Fliqo`:

**Settings > Secrets and variables > Actions > New repository secret.**

Crie dois, um de cada vez (o nome tem de ser exatamente assim):

| Name                 | Secret                                           |
| -------------------- | ------------------------------------------------ |
| `DATABASE_ADMIN_URL` | a conexão do dono do passo 1, com a senha dentro |
| `FLIQO_APP_PASSWORD` | a senha que você gerou no passo 2                |

Depois de salvar, o GitHub nunca mais mostra o valor — só permite trocar. Isso é
esperado: quem precisa lembrar é o seu gerenciador de senhas.

> Troque o `[YOUR-PASSWORD]` da string pela senha do banco antes de colar.

Se um dia o projeto do Supabase mudar de região, cadastre também uma **variável**
(não um secret): na mesma tela, aba **Variables > New repository variable**, com
o nome `SUPABASE_REGION` e o valor da região nova. Sem ela, o workflow assume
`sa-east-1`, que é a região do `fliqo-staging`.

### 3.2 — Rodar o workflow

No GitHub: aba **Actions** > na lista da esquerda, **Migrar banco** > botão
**Run workflow**, à direita.

Vai aparecer uma caixinha com **Use workflow from**. Deixe em **main** e clique
em **Run workflow**. Se escolher outra branch, o workflow para no primeiro passo
com uma mensagem dizendo isso — é de propósito: banco de verdade só recebe o que
já está na main.

### 3.3 — Conferir se deu certo

A execução aparece na lista em alguns segundos. Clique nela e abra o job
`migrar`. Antes de cada tentativa de conexão, o log traz uma linha de
diagnóstico assim:

```
conexão: host=aws-0-sa-east-1.pooler.supabase.com porta=5432 usuario=postgres.abcdefgh — normalização aplicada: a conexão direta é IPv6 e não chega do GitHub Actions (tentativa 1 de 2)
```

Ela diz tudo o que você precisa para entender uma falha: para onde foi, com que
usuário, e se a string que você colou foi convertida ou usada como veio. Host,
porta e usuário não são segredo. A senha e a string inteira nunca aparecem, nem
quando dá erro.

Deu certo quando os quatro passos estão com visto verde e:

- **Aplicar migrações e preparar a fila** termina com `pronto — N aplicada(s)`
  (ou `nada a fazer` se já estavam todas);
- **Dar senha ao papel da aplicação** termina com
  `senha do papel fliqo_app definida`.

### Quando dá errado, leia por esta tabela

| O que aparece no log                  | O que é                                         | O que fazer                                                          |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `respondeu e recusou a senha`         | o host está certo, a senha dentro do secret não | troque o secret `DATABASE_ADMIN_URL` com a senha certa do banco      |
| `permission denied to alter role`     | o script pediu algo que exige superusuário      | é bug nosso: me avise, com a linha do log                            |
| `nenhum host do pooler respondeu`     | a região não bate com a do projeto              | confira a região no Supabase e cadastre a variável `SUPABASE_REGION` |
| `não deu para achar o ref do projeto` | a string colada não é do Supabase               | copie de novo em **Connect**, no painel do projeto                   |
| `normalização pulada`                 | a string não aponta para o Supabase             | idem acima: o secret está com a string errada                        |

> **Cuidado com uma pegadinha:** quando a senha está errada, a mensagem do
> Postgres diz `password authentication failed for user "postgres"` — com
> `postgres` sozinho, sem o ref. Isso **não** quer dizer que a conexão usou o
> usuário errado. O pooler conecta como `postgres.<ref>` e, do outro lado, o
> papel do banco chama-se `postgres`; a mensagem vem de lá. A linha de
> diagnóstico acima mostra o usuário que foi realmente usado.

**Rode este workflow antes de cada deploy que traga migração nova.** Rodar sem
precisar não faz mal: migração aplicada não é reaplicada, e o passo do papel
apenas redefine a mesma senha.

> **Sobre o papel `fliqo_app`:** ele nasce sem `superuser` e sem `bypassrls` —
> são os padrões do Postgres. O script confere os dois toda vez e para se algum
> estiver ligado, porque removê-los exige superusuário, que o `postgres` do
> Supabase não é. Se isso acontecer, fale com o suporte do Supabase: um papel com
> `bypassrls` enxerga todas as clínicas de uma vez.

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
| `WHATSAPP_TOKEN_KEY`    | gere como está logo abaixo da tabela                        |
| `LOG_LEVEL`             | `info`                                                      |

**Como gerar a `WHATSAPP_TOKEN_KEY`:** ela não é uma senha comum — precisa ser
exatamente 32 bytes em base64, e o gerador do gerenciador de senhas não garante
isso. No Chrome, abra uma aba qualquer, aperte **F12**, vá em **Console**, cole a
linha abaixo e aperte Enter:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
```

Sai um texto de 44 caracteres terminando em `=`. Copie **sem as aspas** que o
console mostra em volta, cole no Railway e guarde uma cópia no gerenciador de
senhas — perder essa chave é perder o acesso aos tokens das clínicas já
conectadas.

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

Abra no navegador:

```
https://<o domínio do passo 5>/health
```

Tem de aparecer `{"ok":true}`. Se aparecer, a API subiu e o Railway vai mantê-la
no ar — é esse mesmo endereço que ele consulta para saber se precisa reiniciar.

Se o deploy ficar reiniciando sem parar, abra os logs do serviço no Railway: a
API morre no start de propósito quando falta uma variável, e o log diz o nome da
que falta.

O worker não tem endereço para consultar. Abra os logs dele e procure a linha
`worker no ar`.

---

## Quando publicar de novo

1. Juntar o PR na `main`. O Railway reconstrói os dois serviços sozinho.
2. Se o PR tiver migração nova, rode o workflow **Migrar banco** (passo 3.2)
   em seguida.

A ordem é essa porque o workflow só roda na `main`: o arquivo da migração precisa
estar lá para ser aplicado. Entre o deploy e o workflow existe uma janela de
alguns minutos em que o código novo está no ar esperando uma coluna que ainda não
existe — por isso rode o workflow **logo depois** de juntar, e teste só depois
dele. Em staging essa janela não machuca ninguém; quando existir produção, o
jeito é separar o deploy da migração.

Os dois `railway.json` têm `watchPatterns`: mexer só na `apps/demo` não
reconstrói a API nem o worker.

## O que nunca vai para o Railway

- **`DATABASE_ADMIN_URL`.** O dono do schema não passa pela RLS. Ele mora só nos
  secrets do GitHub, para a migração. Se um dia a aplicação precisar dele, alguma
  coisa está errada no desenho.
- **`FLIQO_APP_PASSWORD`.** Ela é usada só pelo workflow de migração. O que o
  Railway precisa é do `DATABASE_URL` já montado, com a senha dentro.

## Se precisar trocar uma chave

- **Senha do `fliqo_app`**: gere outra (passo 2), troque o secret
  `FLIQO_APP_PASSWORD` no GitHub, rode o workflow **Migrar banco** e atualize o
  `DATABASE_URL` nos dois serviços do Railway. Nessa ordem. Entre o workflow e o
  Railway há alguns segundos em que os contêineres antigos erram ao reconectar;
  em staging, tudo bem.
- **`WHATSAPP_TOKEN_KEY`**: não troque na mão. Há um procedimento em
  [OPERACAO.md](OPERACAO.md) — trocar a chave sem recifrar deixa todas as
  clínicas conectadas sem token.
- **`ANTHROPIC_API_KEY`**: revogue no painel do provedor, gere outra e troque só
  a variável do worker.
