# Templates de WhatsApp para submeter na Meta

> **O nome do template na Meta tem de ser idêntico ao do código, caractere por
> caractere.** Sem acento, sem espaço, sem maiúscula, exatamente como está na coluna
> "Nome na Meta" abaixo. O código envia por nome; nome diferente faz a Meta responder
> "template não existe", e esse erro só aparece com a clínica real esperando a
> confirmação — nenhum teste nosso pega.

> **A ORDEM dos botões também tem de ser idêntica.** O código manda o payload de cada
> botão por ÍNDICE (`index: '0'`, `'1'`, `'2'` em `packages/whatsapp/src/meta.ts:60-67`),
> não por texto. Se você submeter "Não vou poder ir" como primeiro botão, o paciente toca
> em "não vou" e o sistema recebe "confirmou", **sem erro nenhum**. É a divergência mais
> perigosa desta página, porque ela não falha: ela mente.

Idioma de todos: **pt_BR** (`Portuguese (BRAZIL)`). É o padrão do código em
`packages/whatsapp/src/meta.ts:75`; nenhum envio passa idioma diferente.

**Nenhum template pode ter variável no cabeçalho.** O código manda parâmetro só para o
corpo e para os botões. Cabeçalho com variável faz a Meta recusar o envio por número de
parâmetros. Cabeçalho de texto fixo e rodapé fixo podem existir.

## Os cinco nomes que o código referencia

Lidos de `packages/whatsapp/src/cliente.ts:53-71` (`TEMPLATES`), que é o único lugar onde
nome de template existe no código. Todo envio passa por
`apps/worker/src/envio.ts:74`.

| Nome na Meta           | Categoria | Variáveis | Botões | Onde o código usa                |
| ---------------------- | --------- | :-------: | :----: | -------------------------------- |
| `confirmacao_consulta` | utility   |     0     |   3    | `apps/worker/src/acoes.ts:86`    |
| `lembrete_final`       | utility   |     0     |   0    | `apps/worker/src/acoes.ts:115`   |
| `oferta_de_vaga`       | utility   |     0     |   1    | `apps/worker/src/ofertas.ts:172` |
| `aviso_de_atraso`      | utility   |     2     |   2    | `apps/worker/src/atrasos.ts:159` |
| `atraso_normalizou`    | utility   |     1     |   0    | `apps/worker/src/atrasos.ts:159` |

**A coluna "Variáveis" é a mais importante depois do nome.** Ela é o que o código manda
hoje, contado no call site. Se o template aprovado tiver um `{{1}}` que o código não
manda, **todo envio falha** com erro de parâmetro — o mesmo sintoma do nome errado, com a
mesma hora ruim para descobrir. Submeta exatamente esta quantidade.

---

## 1. `confirmacao_consulta`

- **Categoria:** utility
- **Idioma:** pt_BR
- **Variáveis:** nenhuma
- **Botões:** 3, de resposta rápida

**Corpo:**

```
Olá! Aqui é da clínica.

Você tem uma consulta marcada com a gente nos próximos dias. Pode nos dizer se vai
poder vir?

Se precisar de outro horário, também resolvemos por aqui.
```

**Botões, nesta ordem:**

| #   | Texto exato          | Payload que o código manda |
| --- | -------------------- | -------------------------- |
| 1   | `Confirmar presença` | `CONFIRMAR_CONSULTA`       |
| 2   | `Preciso remarcar`   | `REMARCAR_CONSULTA`        |
| 3   | `Não vou poder ir`   | `CANCELAR_CONSULTA`        |

O payload **não** vai no template: o código o manda em cada envio
(`packages/whatsapp/src/meta.ts:60-67`), e é ele que volta no webhook. Você submete só o
texto. O que precisa bater é a **posição**.

**"nos próximos dias" é texto carregado, não enfeite.** A régua de confirmação da clínica
é configurável de 2 a 72 horas (`confirm_hours_before`, migração 0001), então esta
mensagem pode sair com a consulta a um dia ou a três. Por isso o texto não diz "amanhã":
com 72 horas de antecedência, "amanhã" seria mentira. E a lógica que decide se uma
mensagem represada ainda pode sair declara, no código, que este template afirma
"consulta amanhã ou depois" — texto que valha para hoje quebraria essa declaração.
**Se você trocar essa frase, avise: há código que depende do que ela afirma.**

---

## 2. `lembrete_final`

- **Categoria:** utility
- **Idioma:** pt_BR
- **Variáveis:** nenhuma
- **Botões:** nenhum

**Corpo:**

```
Passando para lembrar da sua consulta de hoje aqui na clínica.

Se precisar avisar qualquer coisa, pode responder nesta conversa.
```

Sem botão de propósito: a resposta do paciente cai na conversa e é a atendente de IA que
trata. O texto afirma "consulta hoje e ainda por vir" — a mesma observação do template
anterior vale aqui: há código que depende disso.

---

## 3. `oferta_de_vaga`

- **Categoria:** utility — **mas leia a ressalva abaixo**
- **Idioma:** pt_BR
- **Variáveis:** nenhuma
- **Botões:** 1

**Corpo:**

```
Abriu um horário na nossa agenda e você está na lista de espera.

Quem responder primeiro fica com ele. Se não der para você agora, não precisa fazer
nada.
```

**Botão:**

| #   | Texto exato          | Payload que o código manda |
| --- | -------------------- | -------------------------- |
| 1   | `Quero este horário` | `QUERO_ESTE_HORARIO`       |

**Ressalva de categoria.** Este é o único dos cinco em que a Meta pode discordar de
`utility` e reclassificar como `marketing`. A defesa é real — o paciente pediu para
entrar na lista de espera, e a mensagem responde a esse pedido —, mas o revisor é
literal. Se vier reclassificado: `marketing` exige opt-in registrado e respeita a janela
de marketing do país, o que muda quando a mensagem pode sair. Não mude o texto para
tentar escapar; o texto já está no tom mais seco possível.

---

## 4. `aviso_de_atraso`

- **Categoria:** utility
- **Idioma:** pt_BR
- **Variáveis:** 2
- **Botões:** 2

**Corpo:**

```
Precisamos avisar de um atraso aqui na clínica, de cerca de {{1}} minutos.

A previsão agora é atender você às {{2}}. Se preferir outro dia, me diga por aqui.
```

| Variável | O que o código manda                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| `{{1}}`  | Minutos de atraso, inteiro, **sem arredondar** — pode sair `17`, não só `15` ou `20`. |
| `{{2}}`  | Novo horário previsto, no formato `HH:MM` e no fuso da clínica. Ex.: `14:50`.         |

Nesta ordem exata (`apps/worker/src/atrasos.ts:166-169`). Trocar a ordem na Meta faz a
mensagem dizer "atraso de cerca de 14:50 minutos".

**Botões, nesta ordem:**

| #   | Texto exato        | Payload que o código manda |
| --- | ------------------ | -------------------------- |
| 1   | `Tudo bem, eu vou` | `CHEGO_MAIS_TARDE`         |
| 2   | `Prefiro remarcar` | `REMARCAR_CONSULTA`        |

O segundo botão reusa o payload de remarcação de propósito: o atraso é da clínica, e
quem remarca por causa dele não cancelou — o fluxo de remarcação não cobra taxa de
cancelamento.

O primeiro botão **não mexe na agenda**: o horário marcado continua sendo o horário
marcado, e é ele que volta a valer se o atraso passar (é o template seguinte).

---

## 5. `atraso_normalizou`

- **Categoria:** utility
- **Idioma:** pt_BR
- **Variáveis:** 1
- **Botões:** nenhum

**Corpo:**

```
O atraso aqui na clínica já foi resolvido.

Seu horário das {{1}} continua valendo como estava combinado. Se precisar falar com a
gente, responda nesta conversa.
```

| Variável | O que o código manda                                                           |
| -------- | ------------------------------------------------------------------------------ |
| `{{1}}`  | O horário **original** da consulta, `HH:MM`, no fuso da clínica. Ex.: `14:30`. |

É o horário marcado, não o previsto: a mensagem existe justamente para dizer que o
horário combinado voltou a valer.

---

## O que falta no CÓDIGO, e por que eu não escrevi o texto para isso

Três templates vão com **zero variáveis**, o que significa que a mensagem não pode dizer
dia, hora, profissional nem procedimento. Eu não acrescentei `{{1}}` nos textos acima, e
a razão é dura: template aprovado com variável que o código não manda faz **todo envio
falhar** por número de parâmetros. Seria trocar um bug por outro do mesmo tamanho.

| Template               | O que falta                                                                 | Gravidade |
| ---------------------- | --------------------------------------------------------------------------- | --------- |
| `oferta_de_vaga`       | O horário ofertado. A mensagem não diz **qual** vaga abriu.                 | bloqueio  |
| `confirmacao_consulta` | Dia e hora. O paciente com duas consultas marcadas não sabe qual confirmar. | alto      |
| `lembrete_final`       | A hora da consulta de hoje.                                                 | médio     |

**`oferta_de_vaga` é bloqueio para o piloto.** O paciente recebe "abriu um horário" e um
botão, sem saber se é terça às 8h ou sexta às 19h — e tocar no botão marca a consulta. O
dado existe no código no momento do envio (`vaga.inicio` e `vaga.fim`, em
`apps/worker/src/ofertas.ts:163-164`): é só passá-lo em `variaveis`.

**A ordem de submissão importa, por causa do custo de reaprovação.** Cada mudança de
corpo é uma nova submissão e uma nova espera da Meta. Então:

1. **Antes de submeter:** corrigir o código do `oferta_de_vaga` para mandar as duas
   variáveis, e submeter o template já com elas. Não vale submeter a versão muda, porque
   ela não serve para nada e você paga a reaprovação do mesmo jeito.
2. **Pode submeter como está:** `aviso_de_atraso` e `atraso_normalizou`, que já mandam o
   que precisam.
3. **Submeta como está e corrija depois, se tiver pressa:** `confirmacao_consulta` e
   `lembrete_final`. A versão muda funciona — é só vaga.

Me diga se quer que eu faça a mudança do item 1 antes de você submeter. São duas
variáveis num call site, e é o que separa a lista de espera de funcionar de a lista de
espera parecer que funciona.

## Mensagem fora de template

`enviarTexto` (`packages/whatsapp/src/cliente.ts:10`) manda texto livre e **não** precisa
de aprovação: é o que a atendente de IA usa dentro da janela de 24 horas depois de o
paciente escrever. Nada a submeter.
