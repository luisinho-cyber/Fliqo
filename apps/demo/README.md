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

## O relógio

A linha do agora mostra o minuto de verdade, então o que se ancora é o **dia da
clínica**, não o relógio: o começo do dia é escolhido na montagem para que o
minuto atual caia sempre no mesmo ponto da jornada (`nucleo/relogio.ts`). A
demonstração abre com o mesmo dia às nove da manhã e às dez da noite, e as horas
que aparecem nos blocos são horas de parede de verdade — não um relógio
congelado.

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

Os tokens vivem em `app/tokens.css` e a razão de cada um mora no DESIGN.md. A
tipografia é **Sora** (título e corpo) e **DM Mono** (medida: hora e contagem,
nunca texto corrido). Nenhum componente carrega cor literal.

## Imagem de compartilhamento

`public/compartilhar.png` é gerada por `scripts/imagem-de-compartilhamento.mjs`,
que desenha a faixa do dia com os tokens desta pasta e tira uma foto em 1200×630.
Rode de novo quando as cores ou a tipografia mudarem:

```
node apps/demo/scripts/imagem-de-compartilhamento.mjs
```

## Publicação

`out/` é um site estático comum. A página sai com `noindex`: a demonstração não
deve competir com o site da Fliqo na busca. Para indexar, tire o `robots` de
`app/layout.tsx`.
