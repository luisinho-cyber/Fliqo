-- =====================================================================
-- 0009 — Quem mexeu na conexão, e o que a Meta diz do número.
--
-- Duas coisas que a Meta informa sobre o número e que hoje se perdem:
-- o nome verificado (o que o paciente vê como remetente) e a qualidade
-- (verde/amarelo/vermelho, o termômetro de bloqueio do número).
--
-- Cada um vem com o CARIMBO de quando foi apurado, e o carimbo é obrigatório
-- pelo `check`: valor sem carimbo é o bug que interessa impedir. A Meta entrega
-- esses campos no instante da conexão, e o instante da conexão envelhece — sem
-- saber quando o valor foi lido, a tela mostraria "verde" para sempre, e o dono
-- da clínica confiaria num dado de meses atrás.
--
-- Atualizar esses valores depois é trabalho dos webhooks
-- phone_number_quality_update e message_template_quality_update, que não estão
-- assinados ainda. Fase própria; anotado em docs/OPERACAO.md.
--
-- actor_user_id responde "quem desconectou o WhatsApp da clínica?", que hoje
-- não tem resposta. Sem chave estrangeira pelo mesmo motivo de
-- lead_qualifications.updated_by: o usuário mora no Supabase Auth, fora deste
-- schema. Anotado junto da mesma pendência.
-- =====================================================================

alter table app.whatsapp_connection_events
  add column actor_user_id uuid;

alter table app.whatsapp_numbers
  -- Nome que o paciente vê como remetente, aprovado pela Meta.
  add column verified_name            text check (verified_name is null or length(verified_name) <= 200),
  add column verified_name_updated_at timestamptz,
  -- Termômetro de bloqueio do número. Traduzido na borda (packages/whatsapp):
  -- lista fechada em português, não o que a Meta resolver mandar amanhã.
  add column quality_rating           text check (quality_rating in (
                                        'verde', 'amarelo', 'vermelho', 'desconhecida')),
  add column quality_updated_at       timestamptz,
  -- Valor e carimbo andam juntos, ou nenhum dos dois existe. É o que garante
  -- que a tela sempre saiba a idade do que está mostrando.
  add constraint verified_name_carimbado check (
    (verified_name is null) = (verified_name_updated_at is null)
  ),
  add constraint qualidade_carimbada check (
    (quality_rating is null) = (quality_updated_at is null)
  );
