# CLAUDE.md — regras do projeto Fliqo

Leia este arquivo inteiro antes de qualquer tarefa. Ele vale mais do que qualquer pedido genérico.

## O produto
CRM para clínicas brasileiras (odontologia, estética, harmonização). Três pilares:
1. **Agenda que não perde horário**: confirmação por WhatsApp, lista de espera automática, zero conflito, aviso de atraso do profissional antes de o paciente sair de casa.
2. **Atendente de IA humanizada**: responde, marca, remarca e cancela pelo WhatsApp, e passa para humano quando precisa.
3. **Financeiro ligado à agenda**: preço do procedimento → atendimento realizado → fluxo de caixa projetado.

Usuários: dono(a) da clínica, recepção, profissional, financeiro. E o fundador (painel admin).
Todo texto de interface é em português do Brasil.

## Estrutura
```
packages/core   regras de negócio PURAS (sem banco, sem rede, sem Date.now() escondido). 100% testado.
packages/db     migrações SQL (a verdade do sistema), queries tipadas, testes contra Postgres real.
packages/ai     perfil da clínica, prompt, ferramentas, proteções. Não chama o banco.
apps/api        Fastify. Webhook do WhatsApp, API do painel. Fino: valida, chama core/db, enfileira.
apps/worker     Executa ações agendadas, envia mensagens com ritmo humano, roda o agente de IA.
apps/web        Next.js. Painel da clínica + painel do fundador.
```
Regra de dependência: `core` não importa nada do projeto. `ai` importa `core`. `db` importa `core`.
`apps/*` importam os pacotes. Pacote nunca importa app.

## Comandos
- `npm test` — todos os testes (os de banco precisam de `DATABASE_ADMIN_URL`; veja docker-compose.yml)
- `npm run typecheck`
- `npm run db:migrate`
Antes de dizer que uma tarefa terminou: typecheck e testes passando. Sem exceção.

## Regras inegociáveis
1. **Dinheiro é inteiro em centavos** (`Cents`). Percentual é inteiro em basis points (`BasisPoints`). Nunca float, nunca `toFixed` para cálculo.
2. **Multi-tenant pela RLS.** Toda query da aplicação roda dentro de `withClinic(clinicId, fn)`, que abre uma transação e faz `set_config('app.clinic_id', ...)`. A aplicação conecta como `fliqo_app`, nunca como dono do schema. Cruzar clínicas só em funções `security definer` revisadas (hoje: `app.claim_due_actions`).
3. **Conflito de agenda é resolvido pelo banco** (`no_double_booking`). O código trata o erro `23P01` e responde "horário acabou de ser ocupado"; não tenta prevenir com SELECT antes de INSERT.
4. **A IA pede, o código decide.** A IA nunca recebe `clinic_id` nem `patient_id`; o executor injeta a partir da conversa. Toda chamada de ferramenta passa por `validarChamada`. Horário só pode ser marcado se veio de `buscar_horarios` na mesma conversa.
5. **Silêncio não é cancelamento.** Só libera horário quem disse que não vem ou a recepção.
6. **Webhook responde 200 em menos de 1 s.** Valida HMAC com o corpo bruto (`rawBody`, `timingSafeEqual`), grava a mensagem (idempotente por `wamid`) e enfileira. Nada de IA, espera ou envio dentro da requisição.
7. **Uma conversa, um processamento por vez.** Duas mensagens seguidas do mesmo paciente não podem gerar duas respostas paralelas (lock por `conversation_id`). Mensagens que chegam em sequência rápida (até 8 s) são respondidas juntas.
8. **Migrações são só de acréscimo.** Depois de aplicada em produção, uma migração nunca é editada; crie `000N_*.sql`.
9. **Comportamento novo = teste novo.** Regra de negócio em `core` com teste unitário; regra de banco com teste em `packages/db/tests`.
10. **Nunca reescrever histórico de branch com PR aberto sem perguntar.** `reset --hard`, `push --force` (ou `--force-with-lease`) e `rebase` numa branch que tem PR aberto apagam o trabalho que está em revisão. Pergunte antes, sempre. Em branch sem PR, siga normalmente.

## Estilo de código (o que separa isto de "vibe coding")
- TypeScript estrito (ver tsconfig). Proibido `any`, `as unknown as`, `@ts-ignore`, `!` sem motivo óbvio.
- Funções pequenas com nome que diz o que fazem, em português de domínio (`planejarOferta`, `lancamentosDoAtendimento`).
- Erros explícitos: tipos de retorno `{ ok: true } | { ok: false; motivo }` para falhas esperadas; `throw` só para bug.
- Sem `console.log` — use o logger (pino) com `clinicId` e `requestId` em todo log. Nunca logar conteúdo de mensagem de paciente nem telefone completo.
- Comentário explica **por quê**, nunca narra o que a linha faz.
- Nada de dado de exemplo, TODO ou mock fora de `tests/` e `seeds/`.
- Não adicionar dependência sem dizer por que a biblioteca padrão ou uma já instalada não serve.
- Diffs pequenos. Uma tarefa = um assunto.

## Interface (apps/web)
Toda interface segue o DESIGN.md.

- Design tokens em um arquivo (cores, espaçamento, raio, tipografia). Nenhuma cor solta em componente.
- Paleta sóbria de clínica: fundo claro, um acento só. Proibido: gradiente roxo/azul genérico, emoji como ícone, sombra pesada em tudo, texto "Lorem ipsum", botões com 5 estilos diferentes.
- Toda tela tem estado vazio, carregando e erro escritos à mão, em português natural.
- Números de dinheiro sempre `formatBRL`, alinhados à direita em tabelas.
- A tela inicial mostra decisão, não dado: "3 consultas de amanhã sem confirmação — R$ 1.200 em risco".

## Como trabalhar em uma tarefa
1. Leia os arquivos envolvidos e `docs/ARQUITETURA.md`.
2. Diga em 3–6 linhas o plano e quais arquivos vai tocar.
3. Escreva/ajuste os testes primeiro quando a tarefa for de regra de negócio.
4. Implemente o mínimo que faz os testes passarem, sem abstração "para o futuro".
5. Rode typecheck e testes. Mostre a saída.
6. Resuma o que mudou e o que ficou de fora.
