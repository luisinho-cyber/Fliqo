# DESIGN.md — o sistema de identidade da Fliqo

Leia junto com o CLAUDE.md antes de qualquer tela. Referência viva: `docs/referencia/fliqo-demo.html`.

**Este arquivo é a fonte.** Os valores moram em `apps/web/app/tokens.css`, e a razão de
cada um mora aqui. Se uma regra existe só dentro de um componente, ela sobe para cá —
regra que vive numa tela só é folclore, e folclore não sobrevive à segunda pessoa que
mexe na tela.

## A ideia

**A agenda é receita.** Toda tela responde a uma pergunta de dinheiro ou de tempo do
dono da clínica. A Fliqo não se parece com um painel genérico de SaaS. Ela se parece com
um instrumento: uma linha do tempo, uma manchete, uma lista de decisões.

## Três assinaturas

1. **Linha do Dia.** Cada profissional é uma faixa do dia com um cursor `AGORA`. Cada
   consulta é um bloco do tamanho da **duração real**, na posição em que vai começar **de
   verdade**. Havendo atraso, o bloco se desloca e o horário marcado fica como contorno
   tracejado âmbar, ligado por uma seta. **A distância entre o tracejado e o bloco sólido
   É o atraso** — ninguém deve precisar ler um número para enxergar.
2. **Manchete do dia.** No topo, uma frase em vez de cards de KPI: "14 consultas hoje,
   R$ 15.450 na agenda. R$ 900 ainda sem confirmação." Os números entram na frase com a
   cor do seu significado.
3. **Marcado × esperado.** No caixa, a linha tracejada é o que está marcado e a linha
   cheia é o que deve entrar de verdade. A distância entre as duas é o problema que a
   Fliqo resolve, e aparece com esse nome.

## Tokens

Valores em `apps/web/app/tokens.css`. Todo token é definido no tema claro e tem o valor
**redefinido** no escuro — o escuro não é ajuste, é a mesma tela com outros valores.

### Superfícies

| Token    | Claro     | Escuro    | Uso                             |
| -------- | --------- | --------- | ------------------------------- |
| `ground` | `#EEF1F0` | `#0B1210` | fundo do produto                |
| `paper`  | `#FFFFFF` | `#121C1A` | cartão, ficha, painel lateral   |
| `neve`   | `#F5F6F5` | `#0F1715` | seção alternada                 |

### Texto

| Token   | Claro     | Escuro    | Uso                                       |
| ------- | --------- | --------- | ----------------------------------------- |
| `ink`   | `#0C1917` | `#EAF0EE` | texto principal                           |
| `ink-2` | `#4A5F5B` | `#9BADA9` | **todo** texto secundário e de apoio      |
| `ink-3` | `#7D908B` | `#6E807C` | **não é texto**: marca, eixo, tick, ícone |

**`ink-3` não desenha texto.** Com 4,5:1 como piso, não cabe um terceiro tom de texto que
ainda se distinga do segundo: corrigido para passar, ele encostaria no `ink-2`. Então ele
é marca não textual — eixo de régua, tick de escala, traço de ícone —, onde o piso é 3:1
e ele passa (3,37 no claro, 4,18 no escuro, sobre `paper`).

**É ele o traço do bloco `finalizada`**, e esse é o caso que explica o token. `fio` ali
daria 1,22 sobre o próprio preenchimento, e contorno que não se vê não é contorno: o
estado passaria a depender só do texto. Com `ink-3` o contorno existe, continua neutro, e
a diferença com `confirmado` segue sendo forma — traço neutro contra traço `ok` — e não
matiz.

Texto de apoio vai para `ink-2`, **inclusive etiqueta em caixa alta de 11px**. Caixa alta
com `letter-spacing` já lê como secundária; ela não precisa de contraste menor também.
Hierarquia por forma, não por contraste — contraste é o canal frágil.

### Fios e ausência

| Token     | Claro     | Escuro    | Uso                                |
| --------- | --------- | --------- | ---------------------------------- |
| `fio`     | `#D5DDDA` | `#22302D` | hairline entre linhas de uma lista, borda de controle |
| `fio-2`   | `#E6ECEA` | `#1A2623` | divisão interna de um painel       |
| `hachura` | `#CBD7D4` | `#24322F` | traço da hachura de ausência       |

### Marca

| Token         | Claro     | Escuro    | Uso                                |
| ------------- | --------- | --------- | ---------------------------------- |
| `marca`       | `#0F4C5C` | `#2E7F94` | ação primária                      |
| `marca-viva`  | `#14657A` | `#46A0B5` | link e estado pressionado          |
| `marca-tinta` | `#E3EEF1` | `#15333C` | preenchimento de consulta marcada  |

### Tempo, desfecho e foco

| Token         | Claro     | Escuro    | Uso                               |
| ------------- | --------- | --------- | --------------------------------- |
| `agora`       | `#D98100` | `#E8A33F` | **este minuto e atraso, só**      |
| `agora-tinta` | `#FCF2E2` | `#33250F` | bloco deslocado por atraso        |
| `ok`          | `#1F9E77` | `#35B98D` | confirmado, realizado             |
| `ok-tinta`    | `#E7F4EE` | `#102E25` |                                   |
| `risco`       | `#C8453D` | `#E0635A` | o que pode não acontecer          |
| `risco-tinta` | `#FBECEA` | `#331615` |                                   |
| `foco`        | `#14657A` | `#6FC3D6` | anel de foco, 2px, sempre visível |

### Espaçamento, raio, tipografia

- **Espaçamento**, base 4: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 72 · 104 · 132.
- **Raio**: `none` 0 · `sm` 5px · `md` 10px · `lg` 14px · `pill` 980px.
- **Display**: Schibsted Grotesk 700/800, tracking negativo (−0,02 a −0,04 em).
- **Corpo**: Public Sans 400/500/600. Não há 700 no corpo: o peso do título é do título.
- **Mono**: Spline Sans Mono 400/500, **sempre** com `tabular-nums`.
- O logotipo é "fliqo" em minúsculas, peso 800, com um ponto âmbar: o "agora". É a única
  aparição de âmbar que não é tempo, e é a que dá nome à regra.

## A Linha do Dia: a tabela de estados

| Estado                   | Desenho                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| **confirmado**           | bloco `ok-tinta`, traço `ok`, raio `sm`                                                |
| **marcado sem confirmar** | bloco `marca-tinta`, traço `marca`                                                    |
| **em risco**             | bloco `risco-tinta`, traço `risco`                                                     |
| **faltou**               | bloco `risco-tinta`, traço `risco`, **mais um traço diagonal cruzando o bloco**        |
| **em atendimento**       | bloco `ok-tinta` com **barra sólida `ok` de 4px na borda esquerda**. Sem animação.      |
| **finalizada**           | bloco `ok-tinta`, traço `ink-3`, texto `ink-2`. **Nunca opacidade.**                    |
| **deslocado por atraso** | bloco `agora-tinta`, traço `agora`, **mais o contorno tracejado `agora`** no horário marcado |
| **livre**                | hachura diagonal em `hachura`, pitch 8px, raio `none`, sem borda                       |
| **cancelado**            | igual a **livre**: hachura                                                             |
| **agora**                | linha vertical `agora` de 2px, com a etiqueta `AGORA` acima                             |

Quatro razões que não são óbvias e que a tabela esconderia:

- **`em risco` e `faltou` dividem o matiz de propósito.** Risco é a previsão, faltou é o
  desfecho: é a mesma história em dois tempos. O que separa os dois é a **forma** — o
  traço diagonal. Cor igual, forma diferente.
- **`faltou` não é hachura.** Hachura é "nunca houve consulta aqui". Livre é oportunidade
  que ainda dá para preencher; faltou é dinheiro que já foi. Mesma forma esconderia a
  diferença que mais importa para a clínica.
- **`cancelado` é hachura porque é isso que ele é**: o horário está disponível. O fato de
  ter sido cancelado pertence à **lista de decisões** ("Camila cancelou as 14h, três
  pessoas da lista foram avisadas"), não à faixa. A faixa mostra o estado do dia; a lista
  mostra o que aconteceu.
- **`em atendimento` não anima.** A linha do `AGORA` já cruza esse bloco, então listras
  andando repetem um fato que a tela já diz. E estado que só existe em movimento
  desaparece sob `prefers-reduced-motion` — se some com a preferência ligada, ele nunca
  esteve codificado. Listras andando a 1,1s numa tela que a recepção deixa aberta o dia
  todo é cansaço, não sinal.

E **`finalizada` nunca usa opacidade.** `opacity` quebra em silêncio todo o contraste
calculado, porque o valor final não está em token nenhum. Passado é quieto, não desbotado.

## Regras que valem em toda tela

- **`agora` só significa este minuto ou atraso.** Não usar em botão, link ou destaque.
- **Ausência se desenha com hachura**, nunca com vazio branco.
- **Monoespaçada só para medida**: hora, dinheiro, contagem, id. Texto corrido nunca.
- **`fio` separa linhas de uma mesma lista; não desenha caixa.** Painel é `paper` sobre
  `ground`, sem borda. A borda de um **controle** (botão, campo, seleção) é outra coisa:
  ela é a afordância do controle, e usa `fio`.
- **Diferença de estado não pode depender só de matiz.** O bloco atrasado tem âmbar **e**
  tracejado; `faltou` tem vermelho **e** diagonal; a nota amarela do número é anel vazado
  contra ponto cheio, no mesmo vermelho.
- **Todo texto 4,5:1** sobre o fundo da sua nota, nos dois temas. Há teste.
- **A tela Hoje abre com a manchete do dia**, nunca com cartões de indicador.
- **Foco sempre visível**: anel `foco` de 2px. Quem opera a clínica de teclado é quem tem
  as duas mãos ocupadas.

## Componentes

- **Sem menu lateral.** A navegação são abas no topo.
- **Sem grade de cards.** Números agrupados numa faixa única com divisórias finas, só
  onde o número é o assunto.
- **Decisões pendentes** são uma lista com um glifo por severidade (quadrado = risco,
  círculo = atraso, losango = resolvido) e **uma única ação por linha**.
- **Canal do paciente:** o celular sempre à direita no desktop, mostrando o que o
  paciente recebe no momento em que acontece.
- **Telefone inteiro só depois de ato deliberado.** Nenhuma listagem o exibe de saída.
  Abrir a ficha é um ato deliberado; tocar em **Ligar** também é — no celular o toque
  dispara `tel:` e o número vai para o discador, não para a tela; no computador ele é
  revelado na própria linha, e a revelação **é** o ato. A regra existe para o número
  inteiro custar um gesto, não para a lista ser inútil: quando um caso novo precisa de
  telefone, ele ganha o gesto, nunca uma exceção. Do lado da API, **nenhum endpoint de
  listagem devolve telefone inteiro** (veja `docs/OPERACAO.md`).
- **Movimento:** só onde carrega informação, como o bloco deslizando quando o atraso muda.
  Respeitar `prefers-reduced-motion`.

## Texto

- Frases de quem opera a clínica: "Fale com Patrícia na recepção", e não "Alerta de
  atraso gerado".
- A assistente se chama **Assistente Fliqo** na interface. Nenhuma menção a fornecedor ou
  modelo de IA.
- Números sempre com a unidade e no formato brasileiro: R$ 1.500, 10:40, 45 min.
- Ambientes de demonstração exibem "Ambiente de demonstração · dados fictícios" no rodapé.

## Proibido

Gradiente roxo ou azul, emoji como ícone, sombra pesada em tudo, grade de quatro cards de
KPI no topo, etiqueta colorida para cada estado, Inter como fonte, texto de exemplo,
**cor literal dentro de componente**, **`opacity` para indicar estado**.
