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
