# apps/demo

Ambiente de demonstração comercial da Fliqo, para publicar em `demo.fliqo.com.br`.

É um site estático: **não tem banco e não fala com o WhatsApp**. O seed fictício
da Clínica Aurora vive em `nucleo/dados.ts` e passa pelas funções de verdade de
`packages/core` (`projetarDia`, `decidirAvisos`, `planejarOferta`,
`lancamentosDoAtendimento`, `projetarFluxo`, `custoDasFaltas`, `sugerirDuracao`,
`pontualidade`). Se a regra mudar no core, a demonstração muda junto — é isso que
faz os números serem honestos.

## Como rodar

```
npm run dev --prefix apps/demo      # http://localhost:3100
npm run build:demo                  # gera apps/demo/out
npm run e2e:demo                    # precisa do build feito antes
```

O teste de ponta a ponta sobe `scripts/servir.mjs` em cima de `out/`, ou seja,
roda contra o site publicado de verdade, não contra o modo de desenvolvimento.

## A apresentação

São seis cenas (`nucleo/roteiro.ts`), conduzidas pela barra de baixo:

| tecla | faz                                |
| ----- | ---------------------------------- |
| `→`   | avança uma cena                    |
| `R`   | recomeça do zero                   |
| `H`   | esconde a barra (para gravar tela) |

Em cada cena quem apresenta toca nos botões do celular do paciente, à direita, e
a agenda muda atrás.

## A calculadora

A tela de Caixa lê os números da clínica pela URL, para o vendedor abrir a
demonstração já com eles:

```
https://demo.fliqo.com.br/?consultas=500&falta=20&ticket=800
```

`consultas` por mês, `falta` em %, `ticket` médio em reais.

## Imagem de compartilhamento

`public/compartilhar.png` é gerada por `scripts/imagem-de-compartilhamento.mjs`,
que desenha a Linha do Dia com os tokens do DESIGN.md e tira uma foto em
1200×630. Rode de novo quando as cores ou a tipografia mudarem:

```
node apps/demo/scripts/imagem-de-compartilhamento.mjs
```

## Publicação

`out/` é um site estático comum. A página sai com `noindex`: a demonstração não
deve competir com o site da Fliqo na busca. Para indexar, tire o `robots` de
`app/layout.tsx`.
