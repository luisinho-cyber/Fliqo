# DESIGN.md — linguagem visual da Fliqo

Leia junto com o CLAUDE.md antes de qualquer tela. Referência viva: `docs/referencia/fliqo-demo.html`.

## A ideia
**A agenda é receita.** Toda tela responde a uma pergunta de dinheiro ou de tempo do dono da clínica.
A Fliqo não se parece com um painel genérico de SaaS. Ela se parece com um instrumento: uma linha do tempo, uma manchete, uma lista de decisões.

## Três assinaturas (o que torna a Fliqo reconhecível)
1. **Linha do Dia.** Na tela principal, cada profissional é uma faixa horizontal de 8h às 19h, com um cursor "agora". Cada consulta é um bloco do tamanho da **duração real**. Quando há atraso, o bloco se desloca e o horário marcado fica como contorno tracejado âmbar, ligado por uma seta. O horário livre aparece hachurado em petróleo. O atraso e a vaga se veem sem precisar ler número.
2. **Manchete do dia.** No topo, uma frase em vez de cards de KPI: "14 consultas hoje, R$ 15.450 na agenda. R$ 900 ainda sem confirmação." Os números entram na frase com a cor do seu significado.
3. **Marcado × esperado.** No caixa, a linha tracejada é o que está marcado e a linha cheia é o que deve entrar de verdade. A distância entre as duas é o problema que a Fliqo resolve e aparece com esse nome.

## Tokens
| Papel | Claro | Escuro | Uso |
| --- | --- | --- | --- |
| ground | `#EEF1F0` | `#0B1211` | fundo da página |
| paper | `#FFFFFF` | `#121C1A` | superfícies |
| ink | `#0C1917` | `#E7EEEC` | texto principal, botões primários |
| petrol | `#0F4C5C` | `#5BB3C6` | marca, em atendimento, horário livre |
| ok | `#1F9E77` | `#3FC79C` | confirmado, recuperado |
| late | `#D98100` | `#F0A531` | atraso (nunca outra coisa) |
| risk | `#C8453D` | `#EE756C` | sem resposta, falta, reclamação |

Regra de cor: **âmbar é exclusivo de atraso, vermelho é exclusivo de risco ou perda.** Nenhuma cor decorativa.

## Tipografia
- **Schibsted Grotesk** (700/800): manchete, títulos, números grandes. Tracking negativo (−0,02 a −0,04 em).
- **Public Sans** (400–700): todo o texto de interface.
- **Spline Sans Mono**: horas, valores em tabela, contadores, rótulos técnicos. Sempre `tabular-nums`.
- O logotipo é "fliqo" em minúsculas, peso 800, com um ponto âmbar: o "agora".

## Componentes e regras
- **Sem menu lateral.** A navegação são abas no topo: Linha do dia · Conversas · Lista de espera · Caixa · Pontualidade.
- **Sem grade de cards.** Números agrupados numa faixa única com divisórias finas (`.figs`), só onde o número é o assunto.
- **Status por forma e cor:** bloco cheio = confirmado; bloco vazado = aguardando; hachurado vermelho = falta; bloco com borda âmbar = atrasado.
- **Decisões pendentes** são uma lista com um glifo por severidade (quadrado = risco, círculo = atraso, losango = resolvido) e uma única ação por linha. Sem barras coloridas nas bordas dos cards.
- **Canal do paciente:** o celular sempre à direita no desktop, mostrando o que o paciente recebe no momento em que acontece.
- **Movimento:** só onde carrega informação, como o bloco deslizando quando o atraso muda ou a faixa listrada do atendimento em andamento. Respeitar `prefers-reduced-motion`.

## Texto
- Frases de quem opera a clínica: "Fale com Patrícia na recepção", e não "Alerta de atraso gerado".
- A assistente se chama **Assistente Fliqo** na interface. Nenhuma menção a fornecedor ou modelo de IA.
- Números sempre com a unidade e no formato brasileiro: R$ 1.500, 10:40, 45 min.
- Ambientes de demonstração exibem "Ambiente de demonstração · dados fictícios" no rodapé.

## Proibido
Gradiente roxo ou azul, emoji como ícone, sombra pesada em tudo, grade de quatro cards de KPI no topo, etiqueta colorida para cada estado, Inter como fonte, texto de exemplo.
