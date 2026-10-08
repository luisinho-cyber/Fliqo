-- =====================================================================
-- 0016 — A sexta função ganha uma coluna: a fila de envio represada agora.
--
-- Por que mexer na sexta em vez de criar uma sétima: o /health do worker precisa
-- saber se existe ação de envio VENCIDA que não saiu, e isso é leitura cruzada —
-- `scheduled_actions` tem RLS, e o worker lê fora de `withClinic`. Uma função nova
-- seria a sétima a cruzar clínicas, e a lista de seis é o portão (CLAUDE.md, regra 2).
--
-- A coluna cabe no mesmo contrato da 0015: é uma CONTAGEM, agregada, sem nada
-- identificável. O que ela acrescenta é um instante diferente — `vencidas_na_janela`
-- olha para trás (o que deveria ter saído nas últimas N horas) e `vencidas_pendentes`
-- olha para AGORA (o que está represado neste instante).
--
-- `drop` e depois `create`, e não `create or replace`: o Postgres recusa
-- `create or replace` quando o TIPO DE RETORNO muda — "cannot change return type of
-- existing function" —, e acrescentar coluna ao `returns table` é mudar o retorno. Quem
-- descobriu isso foi o teste, aplicando as migrações num banco do zero; sem ele o erro
-- apareceria no `db:migrate` de produção.
--
-- O `drop` apaga os grants junto, por isso o `revoke`/`grant` no fim não é decoração. A
-- 0015 fica intacta no histórico, como manda a regra 8.
--
-- SOBRE O NÚMERO: mesma observação da 0015 — esta branch sai da resiliência do
-- WhatsApp e a fila tem 0011 a 0014 em outras branches. Se a ordem mudar, renumerar
-- ANTES de mesclar.
-- =====================================================================

drop function if exists app.operator_health(int);

create function app.operator_health(
  p_janela_de_silencio_horas int default 3
)
returns table (
  clinic_id            uuid,
  clinic_name          text,
  whatsapp_fora_desde  timestamptz,
  enviadas_ultima_hora bigint,
  enviadas_na_janela   bigint,
  vencidas_na_janela   bigint,
  -- NOVA: ações de envio ainda `pendente` com `due_at` no passado, neste instante.
  -- É a fila represada. Diferente de `vencidas_na_janela`, que conta o que venceu na
  -- janela independentemente de ter saído ou não.
  vencidas_pendentes   bigint,
  qualidade            text
)
language sql
security definer
set search_path = app, pg_temp
stable
as $$
  select
    c.id,
    c.name,
    (select min(a.created_at)
       from app.alerts a
      where a.clinic_id = c.id and a.kind = 'whatsapp_fora' and a.resolved_at is null),
    (select count(*)
       from app.messages m
      where m.clinic_id = c.id
        and m.direction = 'saida'
        and m.created_at >= now() - interval '1 hour'),
    (select count(*)
       from app.messages m
      where m.clinic_id = c.id
        and m.direction = 'saida'
        and m.created_at >= now() - make_interval(hours => p_janela_de_silencio_horas)),
    (select count(*)
       from app.scheduled_actions s
      where s.clinic_id = c.id
        and app.action_kind_envia(s.kind)
        and s.due_at >= now() - make_interval(hours => p_janela_de_silencio_horas)
        and s.due_at <= now()),
    -- Só `pendente`: 'executando' é ação na mão de um worker agora, e contá-la faria
    -- toda rodada normal parecer represamento. Quem cuida de 'executando' preso é
    -- `requeue_stuck_actions` (0004).
    (select count(*)
       from app.scheduled_actions s
      where s.clinic_id = c.id
        and s.status = 'pendente'
        and app.action_kind_envia(s.kind)
        and s.due_at <= now()),
    (select w.quality_rating
       from app.whatsapp_numbers w
      where w.clinic_id = c.id and w.active
      order by w.created_at desc
      limit 1)
  from app.clinics c
  where c.active
    and not c.is_demo
$$;

comment on function app.operator_health(int) is
  'Saúde por clínica para o operador e para o /health do worker. Retorno AGREGADO: contagens e carimbos, nunca linha de paciente, telefone ou conteúdo de mensagem.';

revoke all on function app.operator_health(int) from public;
grant execute on function app.operator_health(int) to fliqo_app;
