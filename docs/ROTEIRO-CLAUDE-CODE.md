# Roteiro para construir o Fliqo com Claude Code

**Como usar:** abra o Claude Code na pasta `fliqo/`. Faça **uma fase por sessão**. Cole o prompt da fase, deixe ele planejar, revise o plano e só então autorize. No fim de cada fase: testes e typecheck verdes, e você faz commit.

O que já está pronto e testado (não reescrever):
- `packages/db/migrations/0001_init.sql` — tabelas, RLS, anti-conflito, régua de confirmação, fila (15 testes)
- `packages/db/migrations/0002_atrasos.sql` — horários reais, avisos de atraso, duração real e pontualidade (5 testes)
- `packages/core` — dinheiro, precificação, financeiro, agenda, fila, ritmo humano (20 testes) e atrasos (11 testes)
- `packages/ai` — perfil da clínica, prompt, ferramentas, proteções (12 testes)

Estimativa honesta, trabalhando algumas horas por dia: **6 a 10 semanas até um MVP vendável**. O corte do MVP está no fim.

---

## Fase 0 — Fundação (meio dia)
```
Leia CLAUDE.md e docs/ARQUITETURA.md. Configure a fundação do monorepo:
1. ESLint (typescript-eslint strict) + Prettier, com scripts lint e format.
2. GitHub Actions: em todo push, roda typecheck, lint e testes, com um serviço Postgres 16
   e DATABASE_ADMIN_URL apontando para ele.
3. packages/db/scripts/migrate.mjs: aplica migrations/*.sql em ordem, registrando em uma
   tabela public.schema_migrations; nunca reaplica.
Não mude nenhuma regra de negócio. Mostre a saída de npm test e npm run typecheck no fim.
```
**Pronto quando:** CI verde no GitHub.

## Fase 1 — Acesso ao banco (1–2 dias)
```
Em packages/db, crie a camada de acesso com Kysely (tipos gerados a partir do schema):
- withClinic(clinicId, fn): abre transação, set_config('app.clinic_id', clinicId, true), executa fn.
- Repositórios: agenda (criar, remarcar, cancelar, listar por período), pacientes, procedimentos,
  lista de espera, ofertas, conversas/mensagens, financeiro.
- Criar consulta traduz o erro 23P01 para { ok: false, motivo: 'horario_ocupado' }.
- remarcar: marca o novo horário e cancela o antigo NA MESMA transação.
Testes em packages/db/tests contra Postgres real, como os existentes, conectando como fliqo_tester.
```
**Pronto quando:** um teste prova que remarcar para um horário ocupado deixa a consulta original intacta.

## Fase 2 — API e webhook (2–3 dias)
```
Crie apps/api com Fastify + Zod + pino:
- POST /webhooks/whatsapp: validação HMAC com rawBody e crypto.timingSafeEqual (porte o
  middleware do projeto anterior, docs/referencia/webhookAuth.ts e docs/referencia/app-rawbody.ts); GET de
  verificação da Meta; grava a mensagem idempotente por wamid; enfileira no pg-boss o job
  'conversa' com singletonKey = conversation_id; responde 200 em < 1 s.
- Descobrir a clínica pelo phone_number_id do webhook (tabela nova whatsapp_numbers via migração 0002).
- API do painel autenticada por JWT do Supabase: agenda, pacientes, procedimentos, fila, conversas
  (inclui "assumir conversa" = mode 'humano' e "devolver para IA").
- Rate limit por IP no webhook e por usuário no painel.
Testes: assinatura inválida = 401; mesmo wamid duas vezes = 1 mensagem; usuário da clínica A não lê a B.
```

## Fase 3 — Worker de ações agendadas (2 dias)
```
Crie apps/worker. Loop a cada 30 s: app.claim_due_actions(50); para cada ação, withClinic(action.clinic_id):
- confirmacao: envia template com botões CONFIRMAR_CONSULTA / REMARCAR_CONSULTA / CANCELAR_CONSULTA.
- marcar_risco: se ainda 'agendado', muda para 'em_risco' e cria alerta para o painel.
- lembrete_final: envia template de lembrete com endereço.
- expirar_oferta: expira a oferta e chama a próxima rodada da fila.
Sucesso -> status 'feito'. Erro -> volta para 'pendente' com backoff (1, 5, 15 min); na 4ª falha, 'erro' + alerta.
A resposta dos botões chega pelo webhook: use interpretarResposta/efeitoDaResposta de packages/core.
Cliente do WhatsApp em packages/whatsapp (novo), com retry e respeito ao limite de envio.
```
**Pronto quando:** teste de integração com um cliente WhatsApp falso cobre confirmou / cancelou / silêncio.

## Fase 4 — Agente de IA (3–4 dias)
```
Implemente o job 'conversa' no worker usando o SDK da Anthropic com tool use:
1. Junta as mensagens do paciente que chegaram nos últimos 8 s em uma só entrada.
2. conversations.mode = 'humano' -> não responde.
3. checarEntrada (packages/ai). Emergência -> RESPOSTA_EMERGENCIA imediata + alerta urgente.
4. Carrega o perfil ativo (ai_profiles) + procedimentos + últimas 20 mensagens -> montarPromptSistema.
5. Loop de ferramentas (máx. 5 voltas): validarChamada -> executor que injeta clinic_id/patient_id
   da conversa. Guardar horários devolvidos por buscar_horarios na conversa; marcar_consulta e
   remarcar_consulta recusam horário que não esteja nessa lista.
6. checarSaida. Se reprovar: uma nova tentativa informando o motivo; se reprovar de novo -> transferir.
7. planejarEnvio (ritmo do perfil) -> jobs atrasados: 'digitando' e envio de cada balão.
8. Áudio: transcrição (Whisper) antes; se perfil.respondeAudioComAudio e o paciente mandou áudio, responde com TTS.
Modelo configurável por env (padrão: um modelo rápido). Registrar tokens usados por clínica.
Testes com um cliente de LLM falso que devolve chamadas de ferramenta roteirizadas.
```
**Pronto quando:** um teste prova que a IA pedindo um horário fora de `buscar_horarios` é recusada.

## Fase 5 — Lista de espera completa (1–2 dias)
```
Quando uma consulta é cancelada/liberada: planejarOferta -> rank_waitlist -> cria slot_offers
e envia a oferta (template com botão QUERO_ESTE_HORARIO) -> agenda 'expirar_oferta'.
Botão aceito -> claim_slot_offer. null -> "esse horário acabou de ser preenchido, você continua na lista".
Modo sequencial: expirou sem resposta -> próximo da fila. Nenhum interessado -> alerta "horário vago" no painel.
```

## Fase 5B — Atrasos do profissional (2–3 dias)
```
Use packages/core/src/atrasos.ts e a migração 0002. Implemente:
1. Painel: botões "Paciente chegou" (checked_in_at), "Iniciar atendimento" (started_at) e
   "Finalizar" (finished_at) na tela Hoje. Um toque cada; o profissional pode usar no celular.
2. Worker: a cada 2 min, e sempre que started_at/finished_at mudar, para cada profissional com
   atendimento hoje: projetarDia -> decidirAvisos (com o último aviso de delay_notices).
   - para 'paciente': template "A Dra. Ana está com cerca de 20 min de atraso. Se preferir,
     pode chegar às 14h20. Pedimos desculpas." com botões "Ok, chego às 14h20" / "Prefiro remarcar".
   - 'normalizou': "Tudo em dia por aqui, pode vir no horário normal (14h)."
   - para 'recepcao': alerta no painel "Fale com a Maria na recepção: atraso de ~20 min".
   Registrar cada aviso em delay_notices.
3. esperandoDemais: alerta na recepção quando alguém espera 15 min+ depois do horário.
4. Duração esperada: usar a mediana de app.procedure_real_durations quando houver 8+ amostras;
   senão, a duração do procedimento.
5. Tela "Pontualidade" (dono): % no horário, atraso médio por profissional (professional_punctuality)
   e o card "Botox com a Dra. Ana dura 55 min, a agenda reserva 40 — ajustar?" (sugerirDuracao),
   com botão que atualiza procedures.duration_minutes só para os próximos agendamentos.
6. "Prefiro remarcar" no aviso de atraso -> fluxo de remarcação da IA, sem cobrar taxa de cancelamento.
Nunca enviar aviso de atraso fora da janela configurada nem mais de 3 avisos por consulta.
```
**Pronto quando:** teste com relógio simulado cobre: atraso aparece -> aviso; atraso cresce 10 min -> reaviso; atraso some -> "normalizou"; paciente na sala -> só recepção.

## Fase 6 — Painel da clínica (1–2 semanas)
```
Crie apps/web com Next.js (App Router) + Tailwind + tokens de design em um arquivo.
Siga a seção Interface do CLAUDE.md. Telas, nesta ordem:
1. Hoje: consultas do dia por status, "sem confirmação amanhã: N — R$ X em risco", horários vagos.
2. Agenda semanal por profissional (arrastar para remarcar chama a API; conflito mostra aviso).
3. Conversas: caixa de entrada, conversas em modo humano no topo, botão Assumir / Devolver para IA.
4. Lista de espera.
5. Financeiro: fluxo projetado 30/60/90 dias (projetarFluxo), custo das faltas no mês, margem por procedimento.
6. Configurações: procedimentos (preço calculado pelo markup divisor), formas de pagamento, régua.
Cada tela com estados vazio, carregando e erro.
```

## Fase 7 — Painel do fundador (3–5 dias)
```
Área /admin só para o papel 'fundador':
1. Lista de clínicas com: mensagens/mês, custo de IA, taxa de confirmação, faltas evitadas.
2. Onboarding de clínica em passos: dados -> procedimentos -> perfil da IA (formulário a partir de
   PerfilClinicaSchema) -> número de WhatsApp -> publicar.
3. Simulador: conversa com a IA usando o perfil em rascunho, sem WhatsApp, com as ferramentas
   rodando contra uma cópia de teste da agenda.
4. Clínica demo: seed de 60 dias + botão "resetar demo".
5. Entrar como clínica (suporte) sempre registrado em log de auditoria.
```

## Fase 8 — Endurecimento antes da primeira clínica pagante (2–3 dias)
```
- Teste de carga com k6: 50 webhooks/s por 5 min; nenhuma mensagem duplicada ou perdida.
- Checklist de segurança: headers, CORS, rate limit, segredos só em env, rotação de tokens da Meta,
  RLS verificada em todas as tabelas (teste que falha se surgir tabela sem policy).
- Sentry na API, worker e web. Alertas: fila parada > 5 min, taxa de erro de envio > 5%.
- Backup: confirmar retenção do Supabase e fazer um restore de teste.
```

---

## Corte do MVP (o que vende primeiro)
**Entra:** agenda, confirmação com botões, lista de espera, IA que responde dúvidas e marca/remarca/cancela, passar para humano, tela Hoje, custo das faltas.
**Entra simples:** aviso de atraso ao paciente (é o que o paciente sente na pele) e financeiro com lançamento por atendimento e projeção de 30 dias.
**Fica para depois:** Instagram, resposta em áudio, conciliação bancária, comissões por profissional, app mobile.

O primeiro cliente não compra funcionalidade: compra o número de faltas caindo. Entregue a confirmação impecável antes de qualquer outra coisa.
