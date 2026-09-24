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
