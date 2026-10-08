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
| Painel (`apps/web`)       | Railway                | não conecta ao banco  | não                    |

Você não precisa de nada instalado no seu computador: tudo é feito pelo navegador,
no Supabase, no GitHub e no Railway.

A aplicação **nunca** conecta como dono do schema. É o que faz a separação entre
clínicas valer: como `fliqo_app`, toda consulta passa pela RLS.

O painel não tem `DATABASE_URL` nenhum. Ele fala só com a API, que é quem abre a
transação dentro da clínica. Se um dia o painel precisar do banco, alguma coisa
está errada no desenho.

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

### Se o passo "Conferir acesso das funções security definer" falhar

Ele não conserta nada: só avisa. A mensagem nomeia a função, a tabela e o papel.

O que aconteceu: uma função `security definer` roda com os poderes do dono dela.
Se a tabela que ela lê tem `force row level security`, a política vale também
para o dono, e a função devolve zero linha **sem dar erro**. A fila de ações
para de rodar, a varredura de atrasos não acha clínica e o painel não acha a
clínica de ninguém — tudo em silêncio.

Não ligue `BYPASSRLS` no papel para destravar: é interruptor global e sai da
vista. O conserto é uma migração nova com política explícita na tabela,
liberando o papel dono pelo nome — visível no schema, auditável e com escopo por
tabela. Me chame antes de aplicar.

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
| `WHATSAPP_VERIFY_TOKEN` | uma frase inventada por você; a mesma vai na Meta (passo 8) |
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
ele é o webhook do passo 8.

## Passo 6 — Serviço do worker no Railway

**New > GitHub Repo**, o mesmo repositório. Em **Settings**:

- **Service Name**: `worker`
- **Root Directory**: vazio
- **Config-as-code file path**: `apps/worker/railway.json`

O worker atende HTTP em duas rotas, e o `railway.json` dele aponta o health check
para `/health`. **Não gere domínio**: o health check do Railway bate na porta
interna do serviço, e o worker não tem nada para servir ao público.

- `/health` responde 200 enquanto o processo está de pé. O health check do Railway
  roda só no início do deploy, aceita qualquer 2xx e serve para o deploy novo entrar
  no ar; ele não roda depois disso e não reinicia nada.
- `/estado` diz se o trabalho está saindo: `verde`, `degradado` (laço batendo, envio
  represado) ou `travado` (laço sem sinal), com a causa e os números. Fica fora do
  health check.

O que reinicia o worker é a política `ON_FAILURE`, e ela só age quando o processo
sai com erro. Um laço travado não faz o processo sair: o worker fica de pé, nada é
enviado, e o `/estado` diz `travado`. O aviso que chega a alguém é o e-mail do vigia
de operador.

Em **Variables**:

| Variável             | De onde vem                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`       | passo 4, o mesmo da API                                                       |
| `WHATSAPP_TOKEN_KEY` | **o mesmo valor que está na api** — é a chave que decifra os tokens           |
| `ANTHROPIC_API_KEY`  | do painel do provedor; **cole direto aqui, e em nenhum outro lugar**          |
| `EMAIL_API_KEY`      | do painel do serviço de e-mail; **cole direto aqui, e em nenhum outro lugar** |
| `EMAIL_REMETENTE`    | um remetente verificado no serviço, ex. `avisos@suaclinica.com.br`            |
| `OPERADOR_EMAIL`     | o seu e-mail: é quem recebe o aviso                                           |
| `LOG_LEVEL`          | `info`                                                                        |

**As três de e-mail são do vigia de operador** (migração 0015). Ele roda de 15 em 15
minutos em horário comercial e avisa quando uma clínica fica com o WhatsApp fora por
mais de 20 min, quando passa 3 h com ação vencida e nenhuma mensagem saindo, ou quando
a qualidade do número cai do verde.

**A `EMAIL_API_KEY` fica SÓ no worker.** Não na api, não no painel, não no CI. Quem
manda e-mail é o worker; um runner de CI que pode mandar e-mail em nome da Fliqo é
superfície nova sem nada em troca, e a api não tem o que fazer com ela.

`EMAIL_API_URL` e `OPERADOR_FUSO` são opcionais: valem `https://api.resend.com/emails`
e `America/Sao_Paulo`. O fuso é o **seu**, não o da clínica — é a sua caixa de entrada
que toca, e é ele que decide o que é "horário comercial" para o vigia.

**Não existe mais um token de WhatsApp de ambiente.** Cada clínica manda com a
credencial dela: a api cifra o token no momento da conexão, e o worker decifra para
enviar. Por isso o worker precisa da `WHATSAPP_TOKEN_KEY` — sem ela ele não tem como
mandar mensagem em nome de ninguém, e o start falha dizendo isso.

Um token único de reserva seria pior do que falhar: uma clínica mal configurada
passaria a mandar mensagem pelo número errado, os pacientes dela receberiam de um
remetente estranho, e nada apareceria em log nenhum.

`ANTHROPIC_MODEL` é opcional. Sem ela, vale `claude-haiku-4-5`. Trocar de modelo
é mudar essa variável e reiniciar o worker.

Não crie `PORT`: o Railway injeta, e o worker usa o que ele der para o `/health`.

**`ANTHROPIC_API_KEY` vai SÓ aqui.** Não na api, não no painel, não no `.env` da
sua máquina. Quem chama o modelo é o worker; nenhum outro serviço tem o que fazer
com essa chave, e uma chave configurada onde não é usada é uma chave a mais para
vazar quando alguém der acesso de leitura às variáveis de um serviço.

## Passo 7 — Serviço do painel no Railway

**New > GitHub Repo**, o mesmo repositório. Em **Settings**:

- **Service Name**: `web`
- **Root Directory**: vazio
- **Config-as-code file path**: `apps/web/railway.json`

Gere um domínio em **Settings > Networking > Generate Domain**. É esse endereço
que a clínica abre.

Em **Variables**:

| Variável            | De onde vem                                                 |
| ------------------- | ----------------------------------------------------------- |
| `API_URL`           | o domínio do passo 5, sem barra no fim                      |
| `SUPABASE_URL`      | Supabase > Project Settings > API > Project URL             |
| `SUPABASE_ANON_KEY` | Supabase > Project Settings > API > anon public             |
| `META_APP_ID`       | Meta > seu app > Configurações básicas                      |
| `META_CONFIG_ID`    | Meta > seu app > WhatsApp > Embedded Signup, a configuração |
| `NODE_ENV`          | `production`                                                |

`META_APP_ID` e `META_CONFIG_ID` são identificadores públicos: o painel os passa
como prop para abrir a janela da Meta, que roda no navegador. **O
`META_APP_SECRET` não entra aqui** — ele fica só no serviço da api, que é quem
troca o código por token. Há guarda de teste que quebra o CI se o nome do
segredo aparecer em `apps/web`.

`NODE_ENV=production` não é detalhe: é o que faz o cookie de sessão sair como
`Secure`. Sem ele o cookie viaja também em http.

Não crie `PORT`: o `start` do painel usa a que o Railway injetar. O health check
aponta para `/health`, que é a única rota fora do `proxy.ts` — a raiz manda para
`/login` com 307, e health check que segue redirecionamento não diz nada sobre o
serviço estar de pé. Essa rota devolve `{"ok":true}` e mais nada.

## Onde cada variável entra, e onde NÃO entra

A tabela existe para responder a pergunta que dá errado: "esta variável, em qual
serviço?". Configurar um segredo num serviço que não o usa não é inofensivo — é um
lugar a mais de onde ele vaza no dia em que alguém ganhar acesso de leitura às
variáveis daquele serviço.

| Variável                | api | worker | web | Por quê                                                      |
| ----------------------- | :-: | :----: | :-: | ------------------------------------------------------------ |
| `DATABASE_URL`          |  ✓  |   ✓    |  —  | o painel não fala com o banco (CLAUDE.md, regra 10)          |
| `DATABASE_ADMIN_URL`    |  —  |   —    |  —  | **em nenhum**, ver abaixo                                    |
| `SUPABASE_JWT_SECRET`   |  ✓  |   —    |  —  | quem verifica o token do painel é a api                      |
| `SUPABASE_URL`          |  —  |   —    |  ✓  | só para autenticar, no servidor do painel                    |
| `SUPABASE_ANON_KEY`     |  —  |   —    |  ✓  | idem                                                         |
| `API_URL`               |  —  |   —    |  ✓  | quem chama a api é o servidor do painel                      |
| `EMAIL_API_KEY`         |  —  |   ✓    |  —  | **só o worker**: é ele que manda o aviso de operador         |
| `EMAIL_REMETENTE`       |  —  |   ✓    |  —  | idem                                                         |
| `OPERADOR_EMAIL`        |  —  |   ✓    |  —  | idem                                                         |
| `WHATSAPP_APP_SECRET`   |  ✓  |   —    |  —  | valida a assinatura do webhook, que chega na api             |
| `WHATSAPP_VERIFY_TOKEN` |  ✓  |   —    |  —  | idem                                                         |
| `WHATSAPP_TOKEN_KEY`    |  ✓  |   ✓    |  —  | a api cifra o token da clínica; o worker decifra para enviar |
| `META_APP_ID`           |  ✓  |   —    |  ✓  | a api troca o código; o painel abre a janela                 |
| `META_APP_SECRET`       |  ✓  |   —    |  —  | **só a api**: é o que torna o código do navegador útil       |
| `META_CONFIG_ID`        |  —  |   —    |  ✓  | identificador público do Embedded Signup                     |
| `ANTHROPIC_API_KEY`     |  —  |   ✓    |  —  | **só o worker** chama o modelo                               |
| `ANTHROPIC_MODEL`       |  —  |   ✓    |  —  | opcional; padrão `claude-haiku-4-5`                          |
| `NODE_ENV`              |  —  |   —    |  ✓  | `production`, para o cookie sair `Secure`                    |
| `LOG_LEVEL`             |  ✓  |   ✓    |  ✓  | `info`                                                       |
| `PORT`                  |  —  |   —    |  —  | o Railway injeta nos três; não crie à mão                    |
| `FLIQO_APP_PASSWORD`    |  —  |   —    |  —  | só na sua máquina, ao rodar o script do papel                |

### `DATABASE_ADMIN_URL` não vai para o Railway em hipótese nenhuma

Essa é a conexão do **dono do schema**, e o dono do schema **não passa pela RLS**
(CLAUDE.md, regra 2). Um serviço que a conhece está a uma linha de virar vazamento
entre clínicas — basta alguém trocar `criarDb(config.DATABASE_URL)` por ela num
apuro de madrugada.

Quem usa essa URL são as migrações e os scripts, que rodam no workflow do GitHub
com ela como secret, ou na sua máquina. **Nenhum serviço do Railway.**

Isto não é só documentação: **a api e o worker se recusam a subir** se a variável
estiver no ambiente deles (`recusarAdminUrl`). A recusa vive no caminho de start e
não na leitura da configuração, de propósito — o job de testes e o workflow de
migração têm a variável no ambiente legitimamente, e uma recusa no carregamento do
schema derrubaria o próprio CI que aplica a regra. Há guarda de teste para as duas
coisas em `tests/deploy.test.ts`.

## Teto de conexões: por que os números são estes

Cada serviço abre **dois** pools, não um: o da Kysely (consultas) e o do pg-boss
(fila), que é separado. Sem teto explícito, cada um assume 10 — ou seja, cada
serviço consome 20 conexões, e ninguém percebe até o primeiro pico. O pooler do
Supabase é compartilhado entre api, worker e as migrações, e quando ele esgota o
sintoma é erro de conexão que parece problema do banco.

| Serviço | `POOL_CONSULTAS` | `POOL_DA_FILA` | Total | Por quê                                                                                                                                                    |
| ------- | :--------------: | :------------: | :---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api     |        8         |       2        |  10   | muitas consultas curtas de HTTP; o pg-boss dela quase não usa o pool próprio, porque ela enfileira dentro da transação da requisição (`comoConexaoDoBoss`) |
| worker  |        6         |       5        |  11   | dois laços mais cinco filas com `work`; a fila precisa de mais que a da api porque aqui ela consome, não só enfileira                                      |

Sobra folga para as migrações e para um `psql` de emergência. Se você aumentar a
réplica de algum serviço, **multiplique**: duas réplicas da api são 20 conexões,
não 10. Os números vivem como constantes no topo de `apps/api/src/index.ts` e
`apps/worker/src/index.ts`, e há teste que quebra se alguém voltar a chamar
`criarDb`/`criarFila` sem passá-los.

Repare que nenhuma variável do painel começa com `NEXT_PUBLIC_`. Isso é de
propósito: o navegador não fala com o Supabase nem com o banco, então nada disso
precisa chegar até ele. Quem lê o cookie da sessão e chama a API é o servidor do
painel. A lista de `NEXT_PUBLIC_` permitidas está em
`apps/web/tests/guardas.test.ts`, e hoje está vazia — qualquer variável nova com
esse prefixo quebra o CI até alguém escrevê-la ali de propósito.

### Criar a primeira pessoa

O painel não tem cadastro aberto — quem entra é quem a clínica cadastrou.

1. **Supabase > Authentication > Users > Add user**, com e-mail e senha.
2. Copie o **User UID** que aparece na lista.
3. Ligue essa pessoa à clínica, no **SQL Editor** do Supabase:

```sql
insert into app.clinic_members (clinic_id, user_id, role)
values ('<id da clínica>', '<User UID>', 'dono');
```

Sem essa linha a pessoa entra no painel e vê "sua conta ainda não está ligada a
uma clínica" — que é o certo: é a tabela que decide, não o token.

## Passo 8 — Apontar o webhook na Meta

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

Tem de aparecer `{"ok":true}`. Se aparecer, a API subiu. O Railway consulta esse
mesmo endereço só no início de cada deploy, para decidir se o deploy novo entra no
ar; depois disso ele não o consulta mais, e quem reinicia a API quando ela cai é a
política `ON_FAILURE`.

Se o deploy ficar reiniciando sem parar, abra os logs do serviço no Railway: a
API morre no start de propósito quando falta uma variável, e o log diz o nome da
que falta.

O worker não tem endereço para consultar. Abra os logs dele e procure a linha
`worker no ar`.

O painel: abra o domínio do passo 7. Tem de cair na tela de entrar. Depois de
entrar com a pessoa que você criou, aparece a linha do dia de hoje. Se aparecer
"não consegui carregar o dia de hoje", o `API_URL` está errado ou a API está
fora do ar.

---

## Quando publicar de novo

1. Juntar o PR na `main`. O Railway reconstrói os três serviços sozinho.
2. Se o PR tiver migração nova, rode o workflow **Migrar banco** (passo 3.2)
   em seguida.

A ordem é essa porque o workflow só roda na `main`: o arquivo da migração precisa
estar lá para ser aplicado. Entre o deploy e o workflow existe uma janela de
alguns minutos em que o código novo está no ar esperando uma coluna que ainda não
existe — por isso rode o workflow **logo depois** de juntar, e teste só depois
dele. Em staging essa janela não machuca ninguém; quando existir produção, o
jeito é separar o deploy da migração.

Os três `railway.json` têm `watchPatterns`: mexer só na `apps/demo` não
reconstrói a API, o worker nem o painel.

## O que nunca vai para o Railway

- **`DATABASE_ADMIN_URL`.** O dono do schema não passa pela RLS. Ele mora só nos
  secrets do GitHub, para a migração. Se um dia a aplicação precisar dele, alguma
  coisa está errada no desenho.
- **`FLIQO_APP_PASSWORD`.** Ela é usada só pelo workflow de migração. O que o
  Railway precisa é do `DATABASE_URL` já montado, com a senha dentro.
- **`SUPABASE_JWT_SECRET` no serviço do painel.** Quem verifica a assinatura do
  token é a API. O painel só carrega o token; se ele pudesse verificar sozinho,
  haveria dois lugares decidindo quem entra.
- **A `service_role key` do Supabase.** Ela ignora RLS. Não existe lugar nenhum
  neste projeto que precise dela.

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
