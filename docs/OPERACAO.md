# Operação

## Segredos

Nenhum segredo fica no banco nem no repositório. Todos vêm do ambiente:

| Variável                         | Para quê                                          | Quem usa    |
| -------------------------------- | ------------------------------------------------- | ----------- |
| `DATABASE_URL`                   | conexão da aplicação (papel `fliqo_app`)          | api, worker |
| `DATABASE_ADMIN_URL`             | dono do schema; migrações e manutenção            | scripts     |
| `WHATSAPP_APP_SECRET`            | validar a assinatura do webhook da Meta           | api         |
| `WHATSAPP_VERIFY_TOKEN`          | verificação do webhook na Meta                    | api         |
| `META_APP_ID`, `META_APP_SECRET` | trocar o código do Embedded Signup por token      | api         |
| `WHATSAPP_TOKEN_KEY`             | cifrar o token de cada clínica (32 bytes, base64) | api         |
| `SUPABASE_JWT_SECRET`            | verificar o token do painel                       | api         |
| `ANTHROPIC_API_KEY`              | chamar o modelo da Assistente Fliqo               | worker      |
| `FLIQO_APP_PASSWORD`             | senha do papel `fliqo_app`, no script do papel    | scripts     |

O worker só precisa de `WHATSAPP_TOKEN_KEY` para rodar a rotação de chave
(abaixo); em operação normal, quem cifra e decifra token é a API.

Como colocar cada uma dessas no ar está em [DEPLOY.md](DEPLOY.md).

Além dos segredos, o worker lê `ANTHROPIC_MODEL` (padrão `claude-haiku-4-5`).
Trocar de modelo é mudar essa variável e reiniciar o worker — não mexe em código
nem exige publicar de novo.

`.env` está no `.gitignore`. Nenhum destes valores aparece em log — há teste
para o token da clínica (`apps/api/tests/conexao.test.ts`, "o token nunca vai
para o log").

## Trocar a chave do token (`WHATSAPP_TOKEN_KEY`)

A chave cifra o token de acesso de cada clínica. **Trocar a variável sem
recifrar deixa todos os tokens ilegíveis** e obriga todas as clínicas a
reconectar o WhatsApp. O procedimento abaixo evita isso.

Gere a chave nova:

```bash
openssl rand -base64 32
```

Rode a rotação com as duas chaves no ambiente — a antiga para decifrar, a nova
para regravar:

```bash
export DATABASE_ADMIN_URL="postgresql://.../fliqo"
export WHATSAPP_TOKEN_KEY_ANTIGA="<a chave que está em uso>"
export WHATSAPP_TOKEN_KEY="<a chave nova>"

npm run whatsapp:rotacionar-chave
```

A saída diz quantos tokens foram recifrados, e lista os números que **não**
puderam ser recifrados (essas clínicas precisam reconectar pelo painel). Nenhum
token é impresso.

Só depois que a rotação terminar sem falhas, troque `WHATSAPP_TOKEN_KEY` no
ambiente da api e do worker e reinicie os dois. A ordem importa: se você trocar
a variável antes de rodar a rotação, perde a chave antiga e não há como recifrar.

Rodar a rotação duas vezes com a mesma chave nos dois lados é inofensivo: ela
decifra e regrava com a mesma chave.

## Migrações e fila

```bash
export DATABASE_ADMIN_URL="postgresql://.../fliqo"
npm run db:migrate
```

Aplica as migrações pendentes em ordem, registra em `public.schema_migrations`
e prepara as filas do pg-boss. Rodar de novo não reaplica nada. Migração já
aplicada que foi editada faz o script parar (CLAUDE.md, regra 8).

## Suspender uma clínica

`app.clinics.active` marca a clínica como ativa. É `not null default true`, então
toda clínica existente continua ativa sem ninguém fazer nada.

**Hoje ela desliga uma coisa só: a varredura de atrasos.** Uma clínica com
`active = false` deixa de receber aviso de atraso e alerta de sala de espera —
e nada mais. Continuam funcionando:

- a régua de confirmação (`scheduled_actions`: confirmação, lembrete, risco);
- a oferta de vaga da lista de espera;
- o webhook do WhatsApp e a Assistente Fliqo;
- o painel.

Ou seja, **suspender por inadimplência ainda não para a operação**. Enquanto os
outros caminhos não olharem para essa coluna, trate `active = false` como "sai da
varredura de atrasos", não como "clínica desligada". Desligar de verdade é
desativar o número em `app.whatsapp_numbers`, o que corta entrada e saída de
mensagem.

```sql
update app.clinics set active = false where id = '<id da clínica>';
```

## Dado de paciente, para quando houver política de retenção

Ainda não existe retenção, exportação nem exclusão automatizadas. Quando
existirem, estas são as tabelas que guardam dado sobre paciente e precisam
entrar nelas juntas:

| Tabela                    | O que guarda                                              |
| ------------------------- | --------------------------------------------------------- |
| `app.patients`            | nome, telefone, consentimento                             |
| `app.conversations`       | a conversa e por que ela saiu da assistente               |
| `app.messages`            | o conteúdo do que a pessoa escreveu                       |
| `app.lead_qualifications` | interesse, faixa de orçamento e a leitura de quem atendeu |
| `app.alerts`              | título e corpo que citam a pessoa                         |
| `app.delay_notices`       | quando e por que ela foi avisada                          |

`app.lead_qualifications` é a mais fácil de esquecer: ela nasceu depois das
outras e não é óbvia numa varredura por nome de tabela. Apagar um paciente sem
apagar a qualificação dele deixa a leitura de quem atendeu órfã no banco.

## Qualidade e nome verificado do número: falta quem atualize

`app.whatsapp_numbers` guarda o que a Meta contou sobre o número no momento da
conexão, cada coisa com o carimbo de quando foi apurada:

| Coluna                     | O que é                                   |
| -------------------------- | ----------------------------------------- |
| `verified_name`            | nome que o paciente vê como remetente     |
| `verified_name_updated_at` | quando esse nome foi lido                 |
| `quality_rating`           | verde / amarelo / vermelho / desconhecida |
| `quality_updated_at`       | quando essa nota foi lida                 |

O `check` da 0009 impede valor sem carimbo: os dois andam juntos ou nenhum dos
dois existe. É isso que permite à tela dizer a idade do dado.

**Hoje esses valores só são atualizados quando alguém reconecta o número.** Os
webhooks que a Meta manda quando a nota muda — `phone_number_quality_update` e
`message_template_quality_update` — **não estão assinados** (veja
`CAMPOS_DE_WEBHOOK` em `packages/whatsapp/src/onboarding.ts`). Assiná-los e fazer
com que eles escrevam nessas colunas, sempre com o carimbo, é uma fase própria.

Enquanto isso não existir, a tela `/configuracoes/whatsapp` faz a única coisa
honesta: passados 7 dias da apuração, ela **para de mostrar o valor** e diz que
não há leitura recente, com a data e a idade. Um "verde" de três meses atrás não
é informação sobre hoje, e o dono da clínica agiria em cima dele.

O nome verificado é tratado de outro jeito de propósito: data seca, sem alarme.
Nome desatualizado não causa dano; nota de qualidade desatualizada esconde um
número a caminho do bloqueio. O tratamento segue a consequência de estar errado,
não a simetria.

## Quando o WhatsApp da clínica cai (fase própria)

Duas coisas tiram o WhatsApp da clínica do ar, e **elas não são a mesma coisa**:
o dono desligar o número pelo painel, e a Meta revogar o token. O segundo
acontece sem ninguém apertar nada.

O diagnóstico está feito; não refaça. O estado atual de cada caminho:

| Caminho                     | Sem número ativo               | Token revogado (401)         |
| --------------------------- | ------------------------------ | ---------------------------- |
| confirmação, lembrete final | `definitivo: true`, sem envio  | `recusado`, uma tentativa só |
| aviso de atraso             | `continue`, sem envio          | idem                         |
| oferta de vaga              | `sem_numero`, ninguém ofertado | idem                         |
| aceitar oferta              | guardado por `!== undefined`   | idem                         |

Ou seja: **não há tempestade de retentativa.** `meta.ts` classifica qualquer
status que não seja 429 nem 5xx como `recusado`, e `#postar` desiste na hora. E o
`last_error` que a execução escreve é o da `scheduled_actions`, sobrescrito a cada
tentativa, não o de `whatsapp_numbers` — esse só é escrito ao conectar e ao
desconectar, porque `conexao.marcarErro` **não tem um único chamador**.

Os dois problemas de verdade:

1. **Alerta por ação, não por causa.** Trinta consultas amanhã viram trinta
   alertas `acao_falhou`, e nenhum deles diz "o WhatsApp da clínica está fora".
2. **Ação queimada.** O token é revogado às 2h; as trinta confirmações de amanhã
   são reclamadas uma a uma e falham como definitivo. Às 9h alguém reconecta — e os
   trinta pacientes nunca foram confirmados, porque as ações já queimaram. Uma
   queda de três horas come um dia inteiro de confirmação, em silêncio.

### O que a fase faz

**Um alerta, não N.** Na falha com cara de autenticação, chamar
`conexao.marcarErro` uma vez e abrir **um** alerta de tipo novo (`whatsapp_fora`),
em vez de um `acao_falhou` por ação.

**`erro` segura, `desconectado` cancela.** São intenções opostas e recebem
tratamentos opostos:

| Situação                                    | O que acontece com as ações de envio pendentes |
| ------------------------------------------- | ---------------------------------------------- |
| `status = 'erro'` (token revogado)          | ficam `pendente` e **esperam** o número voltar |
| `status = 'desconectado'` (o dono desligou) | são **canceladas em bloco**, na hora           |

Quem teve o token revogado quer as confirmações de amanhã esperando. Quem desligou
de propósito não pretende voltar amanhã, e segurar as ações dele só acumula fila
para um envio que ninguém mais quer.

**A exclusão no claim é por propriedade, não por nome.** `claim_due_actions` deixa
de reclamar as ações **que enviam mensagem** de clínica com número em `erro` — e
decide isso por uma classificação declarada num lugar só, não por lista de
exceção caso a caso. Migração nova com `create or replace`; a 0001 não se edita
(CLAUDE.md, regra 8).

Classificação de hoje, para `app.action_kind`:

| Tipo             | Envia? | Por quê                                                 |
| ---------------- | ------ | ------------------------------------------------------- |
| `confirmacao`    | sim    | manda o template de confirmação                         |
| `lembrete_final` | sim    | manda o template de lembrete                            |
| `expirar_oferta` | sim    | `expirarEPassarAdiante` oferece a vaga à próxima rodada |
| `marcar_risco`   | não    | só muda o status da consulta                            |

`expirar_oferta` está aqui porque **o nome enganou o critério na primeira vez**:
expirar não depende do WhatsApp, mas passar a vaga adiante manda mensagem. Segurá-la
durante a queda estica o prazo da oferta, e é o comportamento certo: hoje a rodada
queima calada, porque `ofertas.ts` não acha número ativo, devolve `sem_numero` e
oferece a ninguém.

### As duas invariantes que impedem a próxima "porta ao lado"

O ponto de classificar por propriedade é que tipo de ação novo não entra sem
alguém decidir. Duas guardas, no padrão da lista `SEM_FORCE` e da lista das cinco
funções `security definer` — invariante enumerada em vez de acordo tácito:

1. **Nada fica sem classificação.** Duas listas em `packages/db/src/schema.ts`,
   `ACOES_QUE_ENVIAM` e `ACOES_QUE_NAO_ENVIAM`, e um teste que exige que a união
   delas seja **exatamente** os valores de `app.action_kind` no `pg_enum`. Tipo novo
   na enum quebra o CI até aparecer numa das duas.
2. **O banco e o código não discordam de quem envia.** A propriedade mora no banco
   (uma função `immutable` que o claim usa), e o teste pergunta o veredito dela para
   cada valor da enum e compara com `ACOES_QUE_ENVIAM`. Divergir não quebraria no
   start: quebraria numa queda, com uma ação sendo consumida quando devia esperar.

E o **padrão inseguro é o seguro**: a função do banco trata valor que não conhece
como "envia", ou seja, segura a ação. Segurar é recuperável, queimar não é. Assim o
CI falha alto antes de o tipo novo chegar à produção, e se chegar, ele erra para o
lado que não perde confirmação.

Teste do comportamento: número em `erro`, três ações vencidas → nenhuma reclamada,
nenhuma tentativa de envio, um alerta; o número volta a ativo → as três são
reclamadas e enviadas. Por mutação, se a exclusão no claim virar no-op, o teste vê
as três consumidas e quebra. Segundo teste, para o outro lado: `marcar_risco`
vencida com o número em `erro` continua sendo reclamada e executada.

### Retomar não é reexecutar

Quando o número volta a `ativo`, a pilha represada é reclamada de uma vez — e uma
ação que fazia sentido às 2h pode não fazer mais às 9h. Cada uma precisa de uma
checagem de **pertinência** antes de enviar. Ação que não passa é encerrada como
`sem_proposito`, e isso **não vira alerta**: não é problema, é consequência
esperada da queda. (`sem_proposito` é valor novo no `check` de
`scheduled_actions.status`, que hoje aceita `pendente`, `executando`, `feito`,
`cancelado` e `erro` — migração nova que troca a constraint, nunca edição da 0001.)

O que já existe, conferido no código, para não reescrever:

| Ação             | Guarda de hoje                                                        | Falta                                                                       |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `confirmacao`    | `consulta.status !== 'agendado'` devolve ok, sem envio                | **a antecedência**: consulta que já passou e ninguém tocou segue `agendado` |
| `lembrete_final` | status em `agendado`, `confirmado` ou `em_risco`                      | a mesma — nenhuma checagem de tempo                                         |
| `expirar_oferta` | `planejarOferta` recusa `em_cima_da_hora` e `sem_tempo_para_resposta` | **nada**: a regra já está em `packages/core/src/fila.ts`, no lugar certo    |
| `marcar_risco`   | `status !== 'agendado'`                                               | não é represada (não envia), então não forma pilha                          |

Então o trabalho novo é um só, e **não é um número de minutos**: é a afirmação do
template continuar verdadeira na hora do envio.

#### O limite sai do que o template afirma

Escolher "X minutos de antecedência" empurra o problema para a frente: alguém vai
reinterpretar o número. A regra é outra — cada template **afirma** algo sobre
quando, e só pode sair enquanto essa afirmação for verdade **no momento do envio**.
Abaixo disso a mensagem é falsa, por mais folga que sobre no relógio.

| Template               | O que afirma          | Verdadeiro enquanto                                                               |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `confirmacao_consulta` | a consulta é "amanhã" | a consulta cai num dia de calendário **posterior ao de hoje**, no fuso da clínica |
| `lembrete_final`       | a consulta é hoje, já | a consulta ainda **não começou** e é hoje no fuso da clínica                      |
| `oferta_de_vaga`       | dá para aceitar e vir | `planejarOferta` já decide isso (`em_cima_da_hora`, `sem_tempo_para_resposta`)    |

Por que dia de calendário e não minutos: às 23h, uma consulta às 8h de amanhã está
a nove horas de distância e "amanhã" **é verdade**. Às 9h, uma consulta às 23h de
**hoje** está a catorze horas e "amanhã" **é falso**. Qualquer limite em minutos
acerta um desses dois casos e erra o outro. É a afirmação que decide, não a
distância.

E o piso, sem discussão: **consulta no passado é sempre `sem_proposito`**, para
qualquer tipo.

A regra mora em `packages/core` com teste unitário, recebendo o instante do envio
(sem `Date.now()` escondido) e o fuso da clínica. Os casos de virada de dia são o
teste que importa: 23h para 8h de amanhã passa; 9h para 23h de hoje não passa.

**O texto dos templates não mora aqui, e há como detectar quando ele muda.** A
afirmação está inteira num texto que vive na Meta — `confirmacao` e `lembrete_final`
são enviados **sem variáveis**. Nenhum teste prova que a afirmação declarada é
verdadeira, mas dá para detectar **o instante em que ela pode ter deixado de ser**:

- ao lado de cada declaração em `TEMPLATES` (`packages/whatsapp/src/cliente.ts`),
  guardar o **hash do texto aprovado**;
- um passo periódico, ou a conferência de deploy, busca os textos com
  `GET /{waba-id}/message_templates` e compara;
- divergiu, **falha alto nomeando o template**: o texto mudou, a declaração precisa
  ser revisitada.

Não prova semântica, e não precisa. Precisa gritar quando alguém editou o texto na
Meta, que é exatamente quando a regra escrita para de valer em silêncio.

**Mas a conferência é por clínica, não global.** Cada clínica conecta a **própria**
WABA, e os templates são aprovados por WABA — não há nada no repositório que crie ou
aprove template, então hoje eles são pré-aprovados à mão na conta de cada clínica.
Ou seja: trinta clínicas podem ter trinta textos diferentes sob o mesmo nome
`confirmacao_consulta`, e um hash só não cobre isso. A conferência roda **uma vez
por clínica conectada**, com o token daquela clínica — o que significa decifrar
token, e portanto `WHATSAPP_TOKEN_KEY` no ambiente de quem roda a conferência. Não
é o mesmo perfil de um passo de deploy que só lê schema: decidir onde isso roda faz
parte da fase, e o "Conferir RLS" não serve de molde aqui porque ele não precisa de
segredo de clínica nenhuma.

**O aviso de atraso não entra aqui.** Ele não é `scheduled_actions`: vem de
`FILA_ATRASOS`, uma varredura periódica sobre a agenda do dia. Não há pilha para
retomar — quando o número volta, a varredura seguinte olha o dia corrente e se
corrige sozinha. Represar não se aplica, e por isso a checagem de "a consulta já
terminou?" também não.

Teste do retorno: número em `erro`, duas confirmações represadas — uma de consulta
amanhã, outra de consulta que venceu durante a queda. Número volta a `ativo` → a
primeira é enviada, a segunda termina em `sem_proposito`, e **nenhum alerta é
aberto**. Por mutação, se a checagem de antecedência virar no-op, o teste vê dois
envios e quebra; se `sem_proposito` virar `erro`, ele vê um alerta e quebra.

### `sem_proposito` precisa de guarda, ou vira ação invisível

Status novo que entra sem ninguém revisar as leituras é pior do que ação falhada:
ação falhada aparece em algum lugar; ação com status que nenhuma consulta enumera
não aparece em nenhum. Uma queda de três horas comeria um dia de confirmação e o
status novo só esconderia isso de forma mais educada.

Hoje o `check` de `scheduled_actions.status` tem cinco valores, e estes são todos os
lugares que os leem ou escrevem — conferido, para a fase não descobrir um deles
depois:

| Onde                                   | O que faz com o status                         |
| -------------------------------------- | ---------------------------------------------- |
| `claim_due_actions` (0001)             | reclama só `pendente`; escreve `executando`    |
| `requeue_stuck_actions` (0004)         | devolve `executando` para `pendente`           |
| índice `scheduled_actions_due` (0001)  | parcial, só `pendente`                         |
| índice `one_pending_per_kind` (0001)   | parcial, só `pendente`                         |
| trigger de mudança de consulta (0001)  | cancela as `pendente` da consulta              |
| `acoes.ts` — sucesso                   | escreve `feito`                                |
| `acoes.ts` — `falhar` com `desiste`    | escreve `erro` **e abre alerta `acao_falhou`** |
| `acoes.ts` — `falhar` com backoff      | volta para `pendente`                          |
| `ofertas.ts` — insere `expirar_oferta` | nasce `pendente` pelo default                  |

O teste, no formato das outras listas: ler os valores do `check` direto do
`pg_constraint` e exigir que cada um esteja declarado numa tabela que diz, para cada
status, se é **reclamável**, se é **terminal** e se **conta como falha**. Valor novo
no `check` quebra o CI até aparecer lá. `sem_proposito` entra como: não reclamável,
terminal, **não é falha** — e por isso não abre alerta.

**O descarte tem destino, e não é linha de relatório.** Resolvida a queda, o que
foi descartado vira **decisão na tela Hoje**, no formato que ela já usa: "13
consultas de hoje não foram confirmadas por causa da queda", com **a lista dos
pacientes e uma ação por linha**. Um número não é acionável — "30 descartadas" conta
à recepção que algo ruim aconteceu e não diz o que fazer. A lista diz: são estes,
ligue para eles. É o que a Fliqo promete no resto do produto, transformar o que se
perdeu em ação em vez de aviso. O alerta `whatsapp_fora` continua carregando a
contagem ao ser resolvido, mas ele é o **resumo**; a decisão na Hoje é o que faz
alguém agir.

Duas coisas que isso obriga, achadas lendo a tela:

- **As decisões da Hoje vêm só de `app.alerts` hoje**, uma linha por alerta, e a
  única ação de cada linha é "Resolvido". Treze pacientes não podem ser treze
  alertas — é exatamente a enxurrada que esta fase remove. Então a Hoje passa a ter
  uma **segunda fonte** de decisão: uma consulta sobre as ações `sem_proposito` do
  dia, ligada aos pacientes. Isso muda o contrato de `/api/hoje`, não só a tela.
- **A ação por linha sai da mesma regra do template.** Para quem ainda dá para
  confirmar (a afirmação continua verdadeira), a ação é **"Enviar confirmação
  agora"** — o número voltou, e isso resolve sozinho. Para quem a afirmação já
  venceu, não há mensagem possível: a ação é **ligar**, e aí a linha precisa do
  telefone. O corte entre as duas ações é o mesmo `lerAfirmacao` do core, aplicado
  agora em vez de na hora do envio.

E uma tensão para decidir na fase, não para resolver aqui: a regra da tela Conversas
é **telefone mascarado em lista, inteiro só na ficha**. Uma lista para ligar sem o
número inteiro não serve para ligar. Ou a linha abre a ficha, ou esta lista é a
exceção escrita — mas exceção à regra de telefone não se cria em silêncio.

### Conferir, não supor

`claim_due_actions` passará a ler `whatsapp_numbers`. Ela é `security definer` e
cruza clínicas, então essa referência nova entra no escopo da conferência.
`whatsapp_numbers` está na lista `SEM_FORCE`
(`packages/db/tests/rls-cobertura.test.ts`), o que **deve** bastar: sem `force`, o
dono do schema lê a tabela sem precisar de política.

Isso é uma expectativa, não um resultado. O workflow **Conferir RLS** existe para
essa frase não ser uma aposta: ele é só de leitura e roda de qualquer branch
(`workflow_dispatch`). Rode-o a partir da branch da fase, antes de mesclar, e
trate o veredito dele como a resposta. Nesta sessão o disparo por API foi negado
(`Resource not accessible by integration`, falta `actions: write`), então quem
dispara é o fundador, pelo painel do GitHub.

## Pendências para quando houver log de auditoria

Hoje não existe log de auditoria. Duas coisas precisam ser resolvidas junto com
ele, e não antes, porque hoje não há para onde apontar:

- **`lead_qualifications.updated_by` não tem chave estrangeira.** O usuário mora
  no Supabase Auth, fora do schema `app`. Enquanto a tabela tiver um escritor só
  e o painel controlar o campo — ele vem do `sub` do JWT, nunca do navegador —,
  isso é aceitável. Quando o log existir, o campo precisa passar a apontar para
  algo que continue existindo depois que a pessoa sair da clínica, senão a
  auditoria aponta para um id que não explica nada.
- **`whatsapp_connection_events.actor_user_id` também não tem chave
  estrangeira,** pelo mesmo motivo. Ele responde "quem desligou o WhatsApp da
  clínica?", que antes da 0009 não tinha resposta nenhuma. Vale a mesma ressalva:
  quando o log existir, precisa apontar para algo que continue existindo depois
  que a pessoa sair da clínica.
- **Não há `created_at` na qualificação.** `updated_at` é sobrescrito a cada
  edição, então hoje não dá para saber quando a qualificação nasceu — só quando
  foi mexida pela última vez. Para auditoria isso importa: "quem qualificou e
  quando" é a pergunta, e metade dela está faltando.

Nenhuma das duas trava nada agora. As duas ficam caras se forem lembradas só
depois de a tabela ter volume.
