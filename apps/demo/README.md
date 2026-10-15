# apps/demo

Ambiente de demonstração comercial da Fliqo, para publicar em `demo.fliqo.com.br`.

É um site estático: **roda sem banco e sem Meta**. O seed fictício da Clínica
Aurora vive em `nucleo/dados.ts` e passa pelas funções de verdade de
`packages/core` (`projetarDia`, `sugerirDuracao`, `planejarOferta`,
`interpretarResposta`, `efeitoDaResposta`). Se a regra mudar no core, a
demonstração muda junto — é isso que faz a tela ser o sistema, e não um desenho
do sistema.

## O que a demonstração mostra

Seis coisas, e só elas:

1. **A tela do dia com os três toques reais**: chegou, iniciar, finalizar. São os
   mesmos três do produto, e cada um grava um instante de que a projeção do dia
   depende.
2. **A linha do agora**, em âmbar, mostrando este minuto — o do relógio de quem
   está olhando, andando sozinho.
3. **Horário livre em hachura diagonal**, nunca em branco. É o fundo da faixa:
   todo lugar sem bloco é horário disponível, inclusive o que um cancelamento
   acabou de abrir.
4. **O bloco deslocado por atraso**, com o contorno tracejado ficando no lugar
   onde a consulta estava marcada. A distância entre os dois é o atraso.
5. **A confirmação no WhatsApp**: a conversa, quem respondeu e quem não
   respondeu. Silêncio não é cancelamento, e a tela diz isso com essas palavras.
6. **A lista de espera**: a vaga liberada sendo oferecida em lote e reocupada por
   quem respondeu primeiro.

Ficaram de fora, de propósito: reativação de paciente em lote, financeiro
projetado, a assistente respondendo livremente fora da confirmação, e qualquer
prontuário, ficha ou anamnese.

## O relógio e o expediente

Duas exigências que brigam. A linha do agora tem de mostrar **este** minuto — um
relógio congelado desenha uma linha que não é o agora de ninguém. E o dia na tela
tem de ser um dia de clínica: nenhuma clínica atende das 2h às 9h da manhã, e um
horário desses na frente de um cliente é a demonstração dizendo que não entende o
negócio dele.

Então o que se ancora é o **dia**, e não o relógio (`nucleo/relogio.ts`). O começo
do dia é escolhido na montagem para que o minuto atual caia no mesmo ponto da
jornada **e** o dia inteiro fique entre 8h e 19h. Quando os dois cabem juntos — na
prática entre 10h e 14h —, a linha do agora é o relógio de quem está olhando, e
anda sozinha. Quando não cabem, quem cede é o relógio: o dia abre às 9h, o agora
fica num horário representativo, e a tela escreve "ilustração" dizendo
exatamente isso.

Deslocar o expediente seria a outra escolha, e é pior: o número na tela
continuaria "verdadeiro" e a clínica, impossível.

`tests/demonstracao.spec.ts` abre às 3h, às 23h e ao meio-dia, e confere nas três
que a régua da faixa não sai da janela de 8h-19h.

## Como rodar

```
npm run dev --prefix apps/demo      # http://localhost:3100
npm run build:demo                  # gera apps/demo/out
npm run e2e:demo                    # precisa do build feito antes
```

O teste de ponta a ponta sobe `scripts/servir.mjs` em cima de `out/`, ou seja,
roda contra o site publicado de verdade, e não contra o modo de desenvolvimento.
Cada teste em `tests/demonstracao.spec.ts` cobre um dos seis itens acima.

## Tipografia e tokens

A demonstração **não tem tokens próprios**. Ela importa
`apps/web/app/tokens.css` — a mesma fonte que o painel —, e a razão de cada valor
mora no DESIGN.md. Paleta duplicada é paleta que diverge, e a divergência
apareceria primeiro na frente de um cliente;
`tests/tokens-fonte-unica.test.ts` quebra o CI se uma segunda cópia voltar.

Esse arquivo declara os valores num bloco `@theme`, que é a forma de que o
Tailwind do painel precisa. A demonstração não usa utilidade nenhuma do Tailwind:
ela tem o plugin do PostCSS só para compilar esse bloco em `:root`
(`postcss.config.mjs`), sem preflight e sem reset.

A tipografia é **Sora** (título e corpo) e **DM Mono** (medida: hora e contagem,
nunca texto corrido). O rótulo é 15px, peso 500, caixa normal — não há etiqueta em
caixa alta. Nenhum componente carrega cor literal.

## Imagem de compartilhamento

`public/compartilhar.png` é gerada por `scripts/imagem-de-compartilhamento.mjs`,
que desenha a faixa do dia com os tokens da mesma fonte e tira uma foto em
1200×630.
Rode de novo quando as cores ou a tipografia mudarem:

```
node apps/demo/scripts/imagem-de-compartilhamento.mjs
```

## Publicação

`out/` é um site estático comum. A página sai com `noindex`: a demonstração não
deve competir com o site da Fliqo na busca. Para indexar, tire o `robots` de
`app/layout.tsx`.
