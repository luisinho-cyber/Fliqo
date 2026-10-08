-- =====================================================================
-- 0018 — O requeue mede desde que a ação foi RECLAMADA, não desde o vencimento.
--
-- `app.requeue_stuck_actions` (0004) devolvia à fila toda ação em 'executando'
-- com `due_at < now() - N min`. Mas `due_at` é quando a ação VENCEU, e uma ação
-- reclamada está vencida por definição: a que venceu há dez minutos passava a
-- contar como "presa" no instante em que era reclamada.
--
-- Com um worker só isso não aparecia — o requeue roda no começo de cada volta,
-- quando a anterior já terminou. Com dois workers ao mesmo tempo, que é o que
-- acontece num deploy, a primeira volta do novo devolvia à fila o que o antigo
-- estava enviando, o novo reclamava de novo, e os dois mandavam.
--
-- As duas funções são `security definer` que já existiam (0001/0010 e 0004):
-- muda o corpo, não a lista. A assinatura, o `search_path` e as permissões ficam
-- como estavam.
-- =====================================================================

alter table app.scheduled_actions add column claimed_at timestamptz;

comment on column app.scheduled_actions.claimed_at is
  'Quando o worker reclamou a ação pela última vez. É daqui que o requeue mede "presa".';

-- O corpo da 0010, com uma linha a mais: o carimbo da reclamação.
create or replace function app.claim_due_actions(p_limit int)
returns setof app.scheduled_actions
language sql security definer set search_path = app, pg_temp as $$
  update app.scheduled_actions s
     set status = 'executando', attempts = s.attempts + 1, claimed_at = now()
   where s.id in (
     select a.id from app.scheduled_actions a
      where a.status = 'pendente' and a.due_at <= now()
        and not (
          app.action_kind_envia(a.kind)
          and exists (
            select 1 from app.whatsapp_numbers w
             where w.clinic_id = a.clinic_id and w.active and w.status = 'erro'
          )
        )
      order by a.due_at
      limit p_limit
      for update skip locked)
  returning s.*
$$;

revoke all on function app.claim_due_actions(int) from public;
grant execute on function app.claim_due_actions(int) to fliqo_app;

/*
 * `coalesce` para a ação que já estava em 'executando' quando esta migração
 * entrou: ela foi reclamada pela função antiga e não tem carimbo. Para ela vale
 * a régua antiga, a única informação que existe — e ela some na primeira volta.
 */
create or replace function app.requeue_stuck_actions(p_older_than_minutes int)
returns int
language sql security definer set search_path = app, pg_temp as $$
  with devolvidas as (
    update app.scheduled_actions
       set status = 'pendente'
     where status = 'executando'
       and coalesce(claimed_at, due_at) < now() - make_interval(mins => p_older_than_minutes)
    returning 1
  )
  select count(*)::int from devolvidas
$$;

revoke all on function app.requeue_stuck_actions(int) from public;
grant execute on function app.requeue_stuck_actions(int) to fliqo_app;
