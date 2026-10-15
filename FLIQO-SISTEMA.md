# FLIQO-SISTEMA.md — tabela de capacidades

O que o produto faz de verdade, e o que prova cada coisa.

Uma capacidade só é **CONFIRMADO** quando existe teste automatizado que falha se
ela parar de funcionar. Provado na demo não é CONFIRMADO: a demo é roteirizada e
não passa pela RLS, pela fila nem pelo WhatsApp. Sem teste, a linha fica
**SEM TESTE**, por mais que a tela funcione na mão.

A coluna "o que prova" aponta o arquivo e o `describe` do teste, para que seja
possível conferir — e para que ficar sem teste seja visível em vez de silencioso.

| Capacidade                    | Hoje                               | O que prova                                                                                |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| confirmação ativa no WhatsApp | BLOQUEADO pela verificação na Meta | —                                                                                          |
| lista de espera / reocupação  | provado na demo, falta no produto  | —                                                                                          |
| tela do dia, três toques      | CONFIRMADO                         | `apps/api/tests/painel.test.ts` › os três toques da tela Hoje                              |
| modo convidado                | a confirmar                        | —                                                                                          |
| **transferir para humano**    | **CONFIRMADO**                     | `apps/worker/tests/conversa.test.ts` › a assistente decide passar a conversa para a equipe |
| **cancelar**                  | **CONFIRMADO**                     | `apps/api/tests/painel.test.ts` › cancelar consulta pelo painel                            |
| **alertas**                   | **CONFIRMADO**                     | `apps/api/tests/painel.test.ts` › alertas do painel                                        |
| reativação em lote            | frágil — fora da venda             | —                                                                                          |

## Os três endpoints da Fase 3

### 1. `transferir_para_humano`

A válvula que tira a assistente de assunto clínico, de reclamação e de pedido do
paciente. Em `apps/worker/tests/conversa.test.ts`:

- os três motivos (dúvida clínica, reclamação, pedido do paciente) levam a
  conversa para `humano`, gravam o motivo e criam o alerta que avisa a recepção;
- urgência entra como alerta urgente, não como aviso comum;
- depois de transferir, a assistente não responde mais naquela conversa, nem
  gasta token;
- a volta em que transfere para ali: nada que o modelo pediu depois é executado;
- a despedida que o modelo escreve junto com a transferência passa pelas
  proteções de saída — senão a assistente entrega o diagnóstico no caminho para
  a equipe;
- **o caminho triste**: transferência que falha ao gravar, e transferência que
  não pega sem dar erro, derrubam a volta inteira. Nada é gravado, nada é
  enviado, e o job volta para a fila. A assistente para em vez de continuar.

### 2. `POST /api/agenda/:id/cancelar`

A rota mais destrutiva do painel. Em `apps/api/tests/painel.test.ts`:

- cancela e grava o motivo;
- abre rodada na lista de espera, para a vaga que acabou de abrir e não outra;
- o cancelamento e a chamada da fila são a mesma transação: com a fila fora do
  ar o cancelamento não acontece, em vez de o horário abrir sem ninguém ser
  chamado;
- cancelar de novo não manda a mesma vaga para as mesmas pessoas duas vezes;
- quem não é da clínica recebe 403, e consulta de outra clínica não é
  encontrada — a RLS não enxerga a linha;
- motivo vazio é recusado antes de tocar no banco.

### 3. `GET /api/alertas`

A lista de decisões da tela Hoje. Em `apps/api/tests/painel.test.ts`:

- cada linha traz o que a tela precisa para escrever decisão em vez de dado:
  tipo, gravidade, título, corpo, consulta e paciente;
- o mais recente primeiro, que é a ordem em que a recepção age;
- a lista para em 50, e os 50 são os mais recentes;
- só os alertas da clínica de quem pediu, e o 403 não carrega nada da outra;
- resolvido sai da lista, e resolver duas vezes devolve 404 na segunda.

## O que ainda não tem teste

Honestidade sobre os buracos conhecidos destes três caminhos:

- **cancelar consulta já realizada.** `agenda.cancelar` não filtra status: dá
  para cancelar um atendimento já feito, o que mexe no que o financeiro já
  contou e abre rodada de fila para um horário que já passou. Nada cobre isto.
- **a rodada da fila chegando ao paciente.** Os testes provam que o job é
  enfileirado com a vaga certa; que o worker entrega a oferta é testado em
  `apps/worker/tests/ofertas.test.ts`, mas não de ponta a ponta a partir do
  cancelamento pelo painel.
- **a tela lendo os alertas.** O contrato do endpoint está provado; que a tela
  Hoje escreva a decisão certa a partir dele, não.
