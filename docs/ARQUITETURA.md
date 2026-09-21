# Arquitetura do Fliqo

## Em uma frase
Postgres é o cérebro das regras (agenda, fila, isolamento entre clínicas), o código TypeScript é o cérebro das decisões, e a IA só conversa: ela pede ações por ferramentas e o sistema decide se executa.

## Desenho

```
 WhatsApp (Meta Cloud API)                     Painel web (Next.js)
        │  webhook                                   │  HTTPS + JWT (Supabase Auth)
        ▼                                            ▼
 ┌─────────────────────────── apps/api (Fastify) ───────────────────────────┐
 │ valida HMAC · grava mensagem (idempotente) · enfileira · API do painel    │
 └───────────────┬──────────────────────────────────────────┬──────────────┘
                 │ fila (pg-boss, dentro do próprio Postgres)│ queries com withClinic()
                 ▼                                           ▼
 ┌──────────── apps/worker ────────────┐        ┌──────── Postgres (Supabase) ────────┐
 │ 1. conversa: proteções → agente IA  │◀──────▶│ RLS por clínica                      │
 │    → ferramentas → ritmo humano     │        │ no_double_booking (EXCLUDE)          │
 │ 2. ações agendadas (claim_due_...)  │        │ régua de confirmação (trigger)       │
 │ 3. lista de espera (ofertas)        │        │ rank_waitlist / claim_slot_offer     │
 │ 4. financeiro (lançamentos)         │        │ fila pg-boss                         │
 └───────────────┬─────────────────────┘        └──────────────────────────────────────┘
                 │
                 ▼
        API da Anthropic (Claude, com tool use) · Whisper/TTS para áudio
```

## Por que esta arquitetura (e não N8N + Langflow)
A versão anterior separava N8N (automação) e Langflow (IA). Para um fundador programando sozinho com Claude Code, isso vira três lugares para depurar e fluxos que não passam por teste nem por revisão de código. Aqui:
- **Tudo é código versionado e testado.** Uma régua de confirmação muda num PR, não num fluxo visual.
- **Uma infraestrutura a menos.** A fila (pg-boss) roda dentro do Postgres. Redis só entra se um dia a fila passar de milhares de jobs por segundo.
- **A IA vira uma função.** Chamada direta à API com ferramentas tipadas, sem servidor intermediário.

## Os 5 fluxos principais

**1. Paciente manda mensagem**
webhook → HMAC → `messages` (unique `wamid`) → job `conversa:{id}` → worker:
proteções de entrada (`checarEntrada`) → se transferir: `conversations.mode = 'humano'` e notifica o painel → senão agente IA com o prompt do perfil ativo → cada ferramenta validada e executada com `clinic_id`/`patient_id` da conversa → `checarSaida` → `planejarEnvio` (ritmo humano) → jobs atrasados de "digitando" e envio.

**2. Confirmação da consulta**
A consulta nasce → trigger cria 3 ações: confirmação (24 h antes), risco (3 h antes) e lembrete final (1h30 antes). O worker pega com `claim_due_actions` (vários workers em paralelo, sem duplicar).
- A confirmação é um **template da Meta com botões** (Confirmo / Preciso remarcar / Não vou). O botão chega como payload fixo: sem IA, sem erro de interpretação.
- "Não vou" → libera o horário → fluxo 3.
- Sem resposta até 3 h antes → status `em_risco`, alerta na tela da recepção e reenvio. **O horário não é liberado sozinho.**
- Lembrete final 1h30 antes, com endereço e "como chegar".

> Por que não confirmar só 1h30 antes: com 90 minutos, quem está na lista de espera quase nunca consegue chegar. A confirmação de véspera é o que dá tempo de reaproveitar o horário. O lembrete de 1h30 continua, mas para lembrar, não para decidir.

**3. Horário liberado → lista de espera**
`planejarOferta` decide se ainda dá tempo (antecedência mínima de 60 min, configurável) → `rank_waitlist` ordena: prioridade (definida pela clínica no procedimento: 0 eletivo a 3 urgência) e depois ordem de chegada → oferta para 1 (modo sequencial) ou para 3 ao mesmo tempo (modo lote) → o primeiro "quero" leva, via `claim_slot_offer`. Os demais recebem "esse horário acabou de ser preenchido, você continua na lista". Testado com dois aceites simultâneos.

> A IA não decide gravidade. Quem define a prioridade é a clínica, no cadastro do procedimento, ou a recepção, na entrada da fila. Classificar gravidade clínica por IA é risco ético e legal.

**4. Atendimento realizado → caixa**
Recepção marca "realizado" e escolhe a forma de pagamento → `lancamentosDoAtendimento` gera a receita nas datas em que o dinheiro cai (parcelas), a taxa da maquininha e a comissão como despesas, e os insumos → `cash_entries`. A projeção (`projetarFluxo`) soma os lançamentos e a agenda futura **ponderada pela chance de comparecer**. Esse é o diferencial: o dono vê quanto vai entrar de verdade, não quanto está marcado.

**5. Profissional atrasando**
Recepção marca "chegou", profissional marca "iniciou" e "terminou" (um toque cada). A cada mudança, o worker roda `projetarDia` para o profissional: o atraso é calculado em cascata, e buracos na agenda o absorvem. `decidirAvisos` escolhe quem avisar:
- paciente que ainda não saiu de casa recebe WhatsApp com o novo horário provável, e a opção de remarcar sem multa;
- paciente que já está na sala não recebe mensagem, a recepção é avisada para falar pessoalmente;
- só reavisa se o atraso mudar 10 min ou mais, e avisa quando normalizar.

A causa raiz aparece no painel: `app.procedure_real_durations` compara a duração real (mediana de 90 dias) com a duração na agenda, e `sugerirDuracao` propõe o ajuste. Na maioria dos casos o atraso é uma agenda que reserva 40 min para um procedimento que leva 55.

> O que o sistema não resolve: profissional que encaixa paciente por conta própria, ou que chega tarde. Isso aparece no indicador de pontualidade. A decisão é do dono da clínica.

## Escala: o que aguenta e onde aperta
| Componente | Como escala | Primeiro gargalo provável |
| --- | --- | --- |
| API | Sem estado; várias instâncias atrás do balanceador | Nenhum antes de centenas de clínicas |
| Worker | N instâncias; `SKIP LOCKED` e locks por conversa impedem duplicidade | Latência da IA (resolvido com mais workers) |
| Postgres | Supabase + pooler (PgBouncer); índices já criados | Conexões: use o pooler em modo transação |
| WhatsApp | Um número por clínica (cada uma tem o próprio limite na Meta) | Aprovação de templates e limite de envio de números novos |
| IA | Modelo rápido (Haiku) para conversa, com escalonamento opcional | Custo por mensagem: monitorar por clínica |

Ordem de grandeza: 300 clínicas × 1.500 mensagens/mês ≈ 450 mil mensagens/mês ≈ 1 mensagem a cada 6 s em média. Uma API e dois workers pequenos dão conta com folga. O que exige atenção não é volume, é **correção** (duplicidade, conflito, vazamento entre clínicas), e isso está coberto pelo banco e pelos testes.

## Um número de WhatsApp por clínica
Para ligar o número de cada clínica sem pedir senha a ninguém, use o **Embedded Signup** da Meta. Isso exige tornar-se Tech Provider, ou começar por um parceiro oficial (BSP) enquanto isso. Cada clínica tem o próprio número, os próprios templates e o próprio limite. Nunca use API não oficial: o número é banido e a clínica perde o contato dos pacientes.

## Configurar a IA de cada clínica (sem programar)
- `app.ai_profiles` guarda o perfil em JSON, validado por `PerfilClinicaSchema`, e **versionado**. Publicar uma nova versão desativa a anterior; voltar atrás é um clique.
- Preços e durações vêm de `app.procedures`, nunca do perfil (fonte única).
- O painel do fundador tem: assistente de onboarding (20 min por clínica), **simulador de conversa** (testar a IA com o perfil antes de ligar o WhatsApp) e modo demonstração.

## Modo demonstração (para vender)
Uma clínica com `is_demo = true`, populada por um seed com 60 dias de agenda, faltas, fila e caixa. Nela o simulador de WhatsApp roda ao vivo na reunião: você marca, o prospect vê a agenda mudar e o caixa se mexer. Um botão "resetar demo" recria tudo.

## LGPD e dados de saúde
- Dado de saúde é **dado sensível**. A clínica é a controladora e o Fliqo é o operador: tenha contrato (DPA) com cada clínica.
- Consentimento para WhatsApp em `patients.whatsapp_consent_at`. Sem ele, nenhuma mensagem ativa.
- Não enviar ao modelo de IA mais do que a conversa precisa (nada de prontuário). Revise os termos de retenção de dados do provedor de IA e registre isso no contrato.
- Logs sem conteúdo de mensagem e com telefone mascarado. Backups criptografados (padrão do Supabase). Log de auditoria para ações do fundador dentro de uma clínica.
- Se o paciente perguntar se fala com um robô, a IA diz a verdade. Tom humano, sim; fingir ser pessoa, não. Isso protege a clínica (transparência exigida pelo CDC e pela LGPD) e a sua reputação.

## Hospedagem sugerida
- Supabase (Postgres, autenticação, arquivos) — região São Paulo.
- API + worker: Railway, Render ou Fly.io (containers).
- Web: Vercel.
- Erros: Sentry. Logs: pino → o agregador do provedor.
