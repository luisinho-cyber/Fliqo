# Templates de WhatsApp para submeter na Meta

> **Você não precisa copiar nada daqui à mão.** `npm run whatsapp:registrar-templates` submete
> os sete templates abaixo pela API, com o nome, o corpo, os exemplos e os botões saídos de
> `packages/whatsapp/src/templates.ts`. Esta página existe para você conferir o TEXTO antes de
> submeter e para saber o que esperar da revisão da Meta — não para ser digitada no painel.

> **O nome na Meta tem de ser idêntico ao do código, caractere por caractere.** O script
> garante isso enquanto for ele a submeter. Se você criar algum à mão no painel da Meta, nome
> diferente faz a Meta responder "template não existe" (erro 132001), e esse erro só aparece
> com a clínica real esperando a confirmação.

> **A ORDEM dos botões também é contrato.** O envio manda o payload de cada botão por ÍNDICE
> (`index: '0'`, `'1'`, em `packages/whatsapp/src/meta.ts`), não por texto. Botão fora de ordem
> faz o paciente tocar em "preciso remarcar" e o sistema entender "confirmou", **sem erro
> nenhum**. É a divergência mais perigosa desta página, porque ela não falha: ela mente.

Idioma de todos: **pt_BR**. Categoria de todos: **utility**. Nenhum template nosso é marketing.

**Nenhum template tem variável no cabeçalho**, e nenhum corpo começa ou termina com variável —
a Meta recusa a submissão nos dois casos, e há teste que impede qualquer definição nossa de
chegar lá assim.

## Os sete templates

Lidos de `packages/whatsapp/src/templates.ts`, que é o único lugar onde nome, corpo, parâmetro
e botão de template existem no código.

| Nome na Meta                 | Variáveis | Botões | Quem envia hoje                 |
| ---------------------------- | :-------: | :----: | ------------------------------- |
| `fliqo_confirmacao_consulta` |     4     |   2    | ninguém ainda — veja "a virada" |
| `fliqo_lembrete_vespera`     |     4     |   2    | ninguém ainda — falta a régua   |
| `fliqo_remarcacao`           |     2     |   0    | ninguém ainda — veja "a virada" |
| `fliqo_vaga_liberada`        |     3     |   1    | ninguém ainda — veja "a virada" |
| `confirmacao_consulta`       |     0     |   3    | `apps/worker/src/acoes.ts`      |
| `oferta_de_vaga`             |     0     |   1    | `apps/worker/src/ofertas.ts`    |
| `lembrete_final`             |     0     |   0    | `apps/worker/src/acoes.ts`      |
| `aviso_de_atraso`            |     2     |   2    | `apps/worker/src/atrasos.ts`    |
| `atraso_normalizou`          |     1     |   0    | `apps/worker/src/atrasos.ts`    |

**Por que registrar template que ninguém envia ainda.** A aprovação da Meta leva de minutos a
dias, e o código não pode usar um template antes de ele estar aprovado. Então a ordem é esta:
registra, espera a aprovação, e só então vira o código para os nomes novos. O contrário —
virar o código primeiro — para a régua de confirmação da clínica inteira até a Meta responder.

---

## 1. `fliqo_confirmacao_consulta`

Primeiro pedido de confirmação, `confirm_hours_before` antes da consulta (2 a 72 h).

```
Olá, {{1}}. Sua consulta com {{2}} está marcada para {{3}}.

Você confirma que vai poder vir? Se precisar de outro horário, a gente remarca por aqui.

Mensagem da clínica {{4}}. Pode responder nesta conversa.
```

| Variável | Conteúdo             | Exemplo na submissão     |
| -------- | -------------------- | ------------------------ |
| `{{1}}`  | nome do paciente     | `Maria`                  |
| `{{2}}`  | nome do profissional | `Dra. Helena`            |
| `{{3}}`  | data e hora          | `terça, 14/10, às 14:30` |
| `{{4}}`  | nome da clínica      | `Clínica Modelo`         |

**Botões, nesta ordem:** `Confirmar` (payload `CONFIRMAR_CONSULTA`), `Preciso remarcar`
(payload `REMARCAR_CONSULTA`).

**Dois botões, e não três — uma perda que vale registrar.** O template que está no ar hoje tem
um terceiro, `Não vou poder ir` (`CANCELAR_CONSULTA`), e ele é o único toque que LIBERA o
horário e dispara a lista de espera. Sem ele, quem não pode vir tem de escrever, e a IA
interpreta — o que funciona, mas perde o caminho de um toque. Se quiser os três, é uma linha em
`templates.ts` (`BOTAO.CANCELAR` já existe) e o número de botões nesta página muda para 3.

O texto não diz "amanhã" de propósito: com 72 h de antecedência seria mentira. Quem diz o dia é
`{{3}}`.

---

## 2. `fliqo_lembrete_vespera`

Lembrete do dia anterior, para quem ainda não respondeu o primeiro pedido.

```
Olá, {{1}}. Passando para lembrar da sua consulta com {{2}}, {{3}}.

Ainda não recebemos sua confirmação. Responder ajuda a organizar a agenda do dia, e se você não puder vir o horário fica livre para outro paciente.

Mensagem da clínica {{4}}. Pode responder nesta conversa.
```

| Variável | Conteúdo             | Exemplo na submissão      |
| -------- | -------------------- | ------------------------- |
| `{{1}}`  | nome do paciente     | `Maria`                   |
| `{{2}}`  | nome do profissional | `Dra. Helena`             |
| `{{3}}`  | data e hora          | `amanhã, 14/10, às 14:30` |
| `{{4}}`  | nome da clínica      | `Clínica Modelo`          |

**Botões, nesta ordem:** `Confirmar` (payload `CONFIRMAR_CONSULTA`), `Preciso remarcar` (payload
`REMARCAR_CONSULTA`) — os mesmos do template anterior.

**Nada na régua agenda este template ainda.** `app.action_kind` (migração 0001) tem
`confirmacao`, `lembrete_final`, `marcar_risco` e `expirar_oferta` — não tem véspera. Ligar
isto exige valor novo na enum, linha nova no gatilho `app.sync_appointment_actions` e um ajuste
por clínica de quando enviar: ou seja, **migração, e fase própria**. Registrar agora é só para
a aprovação não ser o gargalo depois.

---

## 3. `fliqo_remarcacao`

Resposta ao pedido de remarcação.

```
Olá, {{1}}. Recebemos seu pedido para remarcar a consulta.

Me diga nesta conversa quais dias e horários são melhores para você, e eu procuro uma vaga. Seu horário atual continua reservado até a gente combinar o novo.

Mensagem da clínica {{2}}. Pode responder nesta conversa.
```

| Variável | Conteúdo         |
| -------- | ---------------- |
| `{{1}}`  | nome do paciente |
| `{{2}}`  | nome da clínica  |

Sem botão: remarcar é escolher dia e hora, e isso não cabe em resposta rápida.

"Seu horário atual continua reservado" é a regra 5 do CLAUDE.md escrita para o paciente —
**pedir para remarcar não libera o horário.**

**Quando este template é necessário, e quando não é.** Se o paciente acabou de tocar em
"Preciso remarcar", a janela de 24 h está aberta e a atendente responde em texto livre, sem
template. Este template serve para o caso em que a janela FECHOU (o paciente pediu, ficou em
silêncio mais de 24 h, e a clínica volta ao assunto) — é exatamente o que o erro 131047 avisa.

---

## 4. `fliqo_vaga_liberada`

Lista de espera: abriu horário.

```
Olá, {{1}}. Abriu um horário na nossa agenda: {{2}}.

Você está na lista de espera para este atendimento. Quem responder primeiro fica com o horário; se não der para você, não precisa fazer nada.

Mensagem da clínica {{3}}. Pode responder nesta conversa.
```

| Variável | Conteúdo                   | Exemplo                   |
| -------- | -------------------------- | ------------------------- |
| `{{1}}`  | nome do paciente           | `Maria`                   |
| `{{2}}`  | data e hora da vaga aberta | `quinta, 16/10, às 09:00` |
| `{{3}}`  | nome da clínica            | `Clínica Modelo`          |

**Botão:** `Quero essa vaga` (payload `QUERO_ESTE_HORARIO`).

`{{2}}` é o que faltava na versão anterior: ela dizia "abriu um horário" e dava um botão que
MARCA a consulta, sem o paciente saber se era terça às 8h ou sexta às 19h.

**Ressalva de categoria.** É o único dos sete em que a Meta pode discordar de `utility` e
reclassificar como `marketing`. A defesa é real — o paciente pediu para entrar na lista de
espera —, mas o revisor é literal. Se vier reclassificado, `marketing` exige opt-in registrado
e respeita a janela de marketing do país, o que muda quando a mensagem pode sair. Não mude o
texto para tentar escapar; ele já está no tom mais seco possível.

---

## 5. `lembrete_final`

Lembrete do mesmo dia, `final_reminder_minutes` antes (30 a 240 min). Sem variável e sem botão.

```
Passando para lembrar da sua consulta de hoje aqui na clínica.

Se precisar avisar qualquer coisa, pode responder nesta conversa.
```

A resposta do paciente cai na conversa e a atendente trata. O texto afirma "consulta hoje e
ainda por vir", e há código que depende disso (`packages/core/src/pertinencia.ts`, que decide se
uma mensagem represada por queda de WhatsApp ainda pode sair).

---

## 6. `aviso_de_atraso`

```
Precisamos avisar de um atraso aqui na clínica, de cerca de {{1}} minutos.

A previsão agora é atender você às {{2}}. Se preferir outro dia, me diga por aqui.
```

| Variável | Conteúdo                                                        |
| -------- | --------------------------------------------------------------- |
| `{{1}}`  | minutos de atraso, inteiro, **sem arredondar** (pode sair `17`) |
| `{{2}}`  | novo horário previsto, `HH:MM`, no fuso da clínica              |

**Botões, nesta ordem:** `Tudo bem, eu vou` (`CHEGO_MAIS_TARDE`), `Preciso remarcar`
(`REMARCAR_CONSULTA`).

O segundo reusa o payload de remarcação de propósito: o atraso é da clínica, e quem remarca por
causa dele não cancelou. O primeiro **não mexe na agenda** — o horário marcado continua valendo,
e é ele que volta se o atraso passar (o template seguinte).

---

## 7. `atraso_normalizou`

```
O atraso aqui na clínica já foi resolvido.

Seu horário das {{1}} continua valendo como estava combinado. Se precisar falar com a gente, responda nesta conversa.
```

`{{1}}` é o horário **original** da consulta, `HH:MM`, no fuso da clínica. É o marcado, não o
previsto: a mensagem existe justamente para dizer que o combinado voltou a valer.

---

---

## 8. `confirmacao_consulta`

O pedido de confirmação que a régua envia **hoje**, sem variável nenhuma. Continua registrado e
funcionando até a virada: derrubá-lo antes de `fliqo_confirmacao_consulta` estar aprovado deixa a
clínica sem confirmação.

```
Olá! Aqui é da clínica.

Você tem uma consulta marcada com a gente nos próximos dias. Pode nos dizer se vai poder vir?

Se precisar de outro horário, também resolvemos por aqui.
```

**Botões, nesta ordem:** `Confirmar presença` (`CONFIRMAR_CONSULTA`), `Preciso remarcar`
(`REMARCAR_CONSULTA`), `Não vou poder ir` (`CANCELAR_CONSULTA`).

Sem variável, a mensagem não diz dia nem hora — é o buraco que o template novo fecha. O paciente
com duas consultas marcadas não sabe qual está confirmando.

---

## 9. `oferta_de_vaga`

A oferta que a lista de espera envia **hoje**, também sem variável. Sai na virada.

```
Abriu um horário na nossa agenda e você está na lista de espera.

Quem responder primeiro fica com ele. Se não der para você agora, não precisa fazer nada.
```

**Botão:** `Quero este horário` (`QUERO_ESTE_HORARIO`).

Esta é a versão que não diz QUAL vaga abriu, e cujo botão marca a consulta. É o motivo de
`fliqo_vaga_liberada` existir.

## A virada do código para os nomes novos

Depois que a Meta aprovar, três call sites mudam de nome e passam a mandar parâmetro:

| Onde                             | De                     | Para                         |
| -------------------------------- | ---------------------- | ---------------------------- |
| `apps/worker/src/acoes.ts`       | `confirmacao_consulta` | `fliqo_confirmacao_consulta` |
| `apps/worker/src/ofertas.ts`     | `oferta_de_vaga`       | `fliqo_vaga_liberada`        |
| resposta ao pedido de remarcação | (não existe)           | `fliqo_remarcacao`           |

Cada um precisa buscar o nome do profissional, o nome da clínica e formatar a data no fuso da
clínica — dado que já está no banco no momento do envio, mas que hoje nenhum desses caminhos
carrega. **É mudança de comportamento da régua, com teste novo, e não entra junto com esta
página.** `confirmacao_consulta` e `oferta_de_vaga` continuam registrados e funcionando na Meta
até a virada acontecer; derrubá-los antes é deixar a clínica sem confirmação.

## Os erros da Meta que têm conduta própria

Tratados em `packages/whatsapp/src/erros-meta.ts`. Todos chegam como HTTP 400, e é o código —
não o status — que diz o que fazer.

| Código   | Significa                                   | Conduta                                            |
| -------- | ------------------------------------------- | -------------------------------------------------- |
| `131026` | o número não recebe WhatsApp                | corrigir o telefone no cadastro; repetir não ajuda |
| `131047` | janela de 24 h fechada                      | mandar template em vez de texto livre              |
| `132000` | contagem de variáveis diferente da aprovada | o corpo na Meta não é o do repositório             |
| `132001` | template não existe ou não está aprovado    | rodar `whatsapp:registrar-templates`               |
| `131048` | limite de envio do número                   | sai na próxima tentativa                           |
| `131056` | muitas mensagens para o mesmo paciente      | sai na próxima tentativa                           |

Código que não está nesta tabela cai em "desconhecida" e é tratado como **definitivo**: repetir
um erro definitivo gasta o limite de envio do número da clínica sem consertar nada.

## Como registrar

```
WHATSAPP_WABA_ID=... WHATSAPP_TOKEN=... npm run whatsapp:registrar-templates
```

- `WHATSAPP_WABA_ID`: Meta > WhatsApp > API Setup, o ID da conta do WhatsApp Business.
- `WHATSAPP_TOKEN`: o mesmo token do worker, **mas ele precisa da permissão
  `whatsapp_business_management`** — a de enviar mensagem não cria template, e a Meta responde
  isso com erro de permissão que o script repassa inteiro.

**Nenhuma dessas duas variáveis vai para serviço do Railway nem para o CI.** O script não é um
serviço: ele roda do seu terminal, uma vez por conta de WhatsApp Business. Um runner que pode
criar template na sua conta da Meta é superfície nova sem nada em troca.

Rodar de novo é seguro e é o uso normal: ele lê o que já existe, pula esses, e mostra o status
de cada um (`APPROVED`, `PENDING`, `REJECTED`).

## Mensagem fora de template

`enviarTexto` manda texto livre e **não** precisa de aprovação: é o que a atendente usa dentro
da janela de 24 h depois de o paciente escrever. Nada a submeter.
