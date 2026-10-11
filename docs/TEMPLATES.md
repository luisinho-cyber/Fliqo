# Templates de WhatsApp para submeter na Meta

> **Você não precisa copiar nada daqui à mão.** `npm run whatsapp:registrar-templates` submete
> os cinco templates abaixo pela API, com o nome, o corpo, os exemplos e os botões saídos de
> `packages/whatsapp/src/templates.ts`. Esta página existe para você conferir o TEXTO antes de
> submeter e para saber o que esperar da revisão — não para ser digitada no painel da Meta.

> **Se você criar algum à mão no painel da Meta, o nome tem de ser idêntico ao do código,
> caractere por caractere.** Sem acento, sem espaço, sem maiúscula. O código envia por nome;
> nome diferente faz a Meta responder "template não existe" (erro 132001), e esse erro só
> aparece com a clínica real esperando a confirmação. Enquanto for o script a submeter, isso
> está garantido — a lista de nomes sai do próprio `templates.ts`.

> **São cinco, e são os cinco nomes que já existiam.** Nome novo não é de graça: cada template
> conta contra o limite da conta, e um conjunto novo ao lado do antigo deixa metade órfã —
> aprovada, consumindo cota, e sem código que a envie. O que mudou foi o **corpo** de dois
> deles, não o nome de nenhum.

> **Com o mesmo nome, código e Meta mudam JUNTOS.** Não existe janela em que o corpo novo
> esteja aprovado e o código antigo ainda funcione: `confirmacao_consulta` passou de zero para
> cinco variáveis, e enviar cinco contra um corpo de zero devolve erro 132000 em TODO envio —
> assim como enviar zero contra o corpo novo. A ordem é: submeter, **esperar a aprovação**, e só
> então mesclar o código. Está escrito de novo no fim desta página, porque é o passo que custa
> caro se for invertido.

> **A ORDEM dos botões é contrato.** O envio manda o payload de cada botão por ÍNDICE
> (`index: '0'`, `'1'`, `'2'` em `packages/whatsapp/src/meta.ts`), não por texto. Botão fora de
> ordem faz o paciente tocar em "preciso remarcar" e o sistema entender "confirmou", **sem erro
> nenhum**. É a divergência mais perigosa desta página, porque ela não falha: ela mente.

Idioma de todos: **pt_BR**. Categoria de todos: **utility**. Nenhum template nosso é marketing.

**Nenhum corpo começa ou termina com variável, e nenhum tem duas variáveis coladas** — a Meta
recusa a submissão nos três casos, e há teste que impede qualquer definição nossa de chegar lá
assim (`conferirCorpo`, em `templates.ts`).

## Os cinco templates

| Nome na Meta           | Variáveis | Botões | Quem envia                   |
| ---------------------- | :-------: | :----: | ---------------------------- |
| `confirmacao_consulta` |     5     |   3    | `apps/worker/src/acoes.ts`   |
| `lembrete_final`       |     0     |   0    | `apps/worker/src/acoes.ts`   |
| `oferta_de_vaga`       |     4     |   1    | `apps/worker/src/ofertas.ts` |
| `aviso_de_atraso`      |     2     |   2    | `apps/worker/src/atrasos.ts` |
| `atraso_normalizou`    |     1     |   0    | `apps/worker/src/atrasos.ts` |

Todos têm remetente no código. Nenhum template registrado fica sem uso.

### Data e hora são duas variáveis, nunca uma

Nos dois templates que falam de um horário futuro, `{{data}}` e `{{hora}}` são separadas, com o
`, às ` entre elas como **texto aprovado**. Três razões, nessa ordem de peso:

1. A Meta recusa duas variáveis coladas sem texto entre elas — `{{1}}{{2}}` não chega ao revisor.
2. O corpo fica legível: "para terça, 14/10, às 14:30" em vez de um carimbo colado.
3. O "às" passa a ser parte do texto aprovado em vez de concatenação nossa, então mudar a
   grafia da hora não exige nova revisão.

**A formatação mora no código**, em `dataDaMensagem` e `horaDaMensagem`
(`packages/core/src/expediente.ts`), no fuso da clínica — uma clínica em Manaus não recebe hora
calculada em São Paulo. Trocar `14:30` por `14h30` é uma linha no core e **zero** submissões.

---

## 1. `confirmacao_consulta`

Primeiro pedido de confirmação, `confirm_hours_before` antes da consulta (2 a 72 h, migração 0001).

```
Olá, {{1}}. Sua consulta com {{2}} está marcada para {{3}}, às {{4}}.

Você confirma que vai poder vir? Se precisar de outro horário, a gente remarca por aqui.

Mensagem da clínica {{5}}. Pode responder nesta conversa.
```

| Variável | Conteúdo             | Exemplo na submissão |
| -------- | -------------------- | -------------------- |
| `{{1}}`  | nome do paciente     | `Maria`              |
| `{{2}}`  | nome do profissional | `Dra. Helena`        |
| `{{3}}`  | data                 | `terça, 14/10`       |
| `{{4}}`  | hora                 | `14:30`              |
| `{{5}}`  | nome da clínica      | `Clínica Modelo`     |

**Botões, nesta ordem:**

| #   | Texto exato          | Payload que o código manda |
| --- | -------------------- | -------------------------- |
| 1   | `Confirmar presença` | `CONFIRMAR_CONSULTA`       |
| 2   | `Preciso remarcar`   | `REMARCAR_CONSULTA`        |
| 3   | `Não vou poder ir`   | `CANCELAR_CONSULTA`        |

**O terceiro botão é o que paga a conta.** `Não vou poder ir` é o único toque que LIBERA o
horário e dispara a lista de espera (`liberar_horario_e_ofertar`). Sem ele, quem não pode vir
tem de escrever, e a vaga só abre depois de a IA interpretar o texto — a mesma vaga, horas mais
tarde, com menos chance de ser preenchida.

O corpo não diz "amanhã" de propósito: com 72 h de antecedência seria mentira. Quem diz o dia é
`{{3}}`.

---

## 2. `lembrete_final`

Lembrete do mesmo dia, `final_reminder_minutes` antes (30 a 240 min). Sem variável e sem botão.

```
Passando para lembrar da sua consulta de hoje aqui na clínica.

Se precisar avisar qualquer coisa, pode responder nesta conversa.
```

Sem botão de propósito: a resposta cai na conversa e a atendente trata. O texto afirma "consulta
hoje e ainda por vir", e há código que depende disso
(`packages/core/src/pertinencia.ts`, que decide se uma mensagem represada por queda de WhatsApp
ainda pode sair).

**O que falta aqui, e por que eu não acrescentei:** ele não diz a HORA da consulta de hoje. O
dado existe no momento do envio. Acrescentar uma variável é uma submissão nova e uma espera de
revisão, e a clínica sobrevive sem — então fica anotado como melhoria, não como correção, para
você decidir quando quiser pagar a rodada.

---

## 3. `oferta_de_vaga`

Lista de espera: abriu horário.

```
Olá, {{1}}. Abriu um horário na nossa agenda: {{2}}, às {{3}}.

Você está na lista de espera para este atendimento. Quem responder primeiro fica com o horário; se não der para você, não precisa fazer nada.

Mensagem da clínica {{4}}. Pode responder nesta conversa.
```

| Variável | Conteúdo         | Exemplo na submissão |
| -------- | ---------------- | -------------------- |
| `{{1}}`  | nome do paciente | `Maria`              |
| `{{2}}`  | data da vaga     | `quinta, 16/10`      |
| `{{3}}`  | hora da vaga     | `09:00`              |
| `{{4}}`  | nome da clínica  | `Clínica Modelo`     |

**Botão:** `Quero este horário` (payload `QUERO_ESTE_HORARIO`).

`{{2}}` e `{{3}}` são a correção que mais importa nesta rodada. A versão anterior dizia "abriu um
horário" e dava um botão que **marca a consulta** — o paciente aceitava sem saber se era terça às
8h ou sexta às 19h. O dado estava em `vaga.inicio`, no código, desde sempre.

**Ressalva de categoria.** É o único dos cinco em que a Meta pode discordar de `utility` e
reclassificar como `marketing`. A defesa é real — o paciente pediu para entrar na lista de espera
—, mas o revisor é literal. Se vier reclassificado, `marketing` exige opt-in registrado e
respeita a janela de marketing do país, o que muda quando a mensagem pode sair. Não mude o texto
para tentar escapar; ele já está no tom mais seco possível.

---

## 4. `aviso_de_atraso`

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

Sem data, e isso é decisão: o aviso é sempre do dia corrente, e dizer a data de hoje numa
mensagem que chega hoje é ruído. `{{2}}` é hora, não data e hora colados.

O segundo botão reusa o payload de remarcação de propósito: o atraso é da clínica, e quem remarca
por causa dele não cancelou. O primeiro **não mexe na agenda** — o horário marcado continua
valendo, e é ele que volta se o atraso passar (o template seguinte).

---

## 5. `atraso_normalizou`

```
O atraso aqui na clínica já foi resolvido.

Seu horário das {{1}} continua valendo como estava combinado. Se precisar falar com a gente, responda nesta conversa.
```

`{{1}}` é o horário **original** da consulta, `HH:MM`, no fuso da clínica. É o marcado, não o
previsto: a mensagem existe justamente para dizer que o combinado voltou a valer.

---

## A ordem de submissão, que não dá para inverter

1. **Submeta** (`npm run whatsapp:registrar-templates`). O script lê o que a conta já tem e manda
   só o que falta — rodar de novo é seguro e é o uso normal.
2. **Espere a aprovação** de `confirmacao_consulta` e `oferta_de_vaga`. O script mostra o status
   de cada um a cada execução (`APPROVED`, `PENDING`, `REJECTED`).
3. **Só então mescle o código.** Até lá, o código com as variáveis novas não pode ir para
   produção: ele mandaria cinco variáveis contra um corpo aprovado com zero, e todo envio
   voltaria 132000.

Os outros três (`lembrete_final`, `aviso_de_atraso`, `atraso_normalizou`) não mudaram de corpo:
se já estiverem aprovados, o script os pula e nada neles exige espera.

**Se os dois corpos novos forem reprovados**, o código não vai para produção e nada quebra — é a
vantagem de a ordem ser esta. Corrija o texto em `templates.ts`, rode o script de novo e espere.

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

Código fora desta tabela cai em "desconhecida" e é tratado como **definitivo**: repetir um erro
definitivo gasta o limite de envio do número da clínica sem consertar nada.

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

## Mensagem fora de template

`enviarTexto` manda texto livre e **não** precisa de aprovação: é o que a atendente usa dentro
da janela de 24 h depois de o paciente escrever. Nada a submeter.
