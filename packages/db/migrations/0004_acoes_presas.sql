-- =====================================================================
-- 0004 — Devolver à fila as ações que ficaram presas em 'executando'.
--
-- app.claim_due_actions marca a ação como 'executando' antes de o worker
-- executá-la. Se o worker morrer no meio, ninguém desmarca: aquela confirmação
-- nunca mais sai e o paciente simplesmente não é avisado.
--
-- Precisa ser security definer pelo mesmo motivo do claim: o varredor roda sem
-- clínica na transação (ele não sabe de antemão quais clínicas têm ação presa),
-- e a RLS de scheduled_actions barraria o update. Sem isso a função existiria,
-- rodaria sem erro e não devolveria nada — que foi o que um teste pegou.
--
-- Devolve só a CONTAGEM, não as linhas: o worker não precisa de mais do que
-- isso, e assim nenhuma linha de nenhuma clínica atravessa a fronteira.
-- =====================================================================

create or replace function app.requeue_stuck_actions(p_older_than_minutes int)
returns int
language sql security definer set search_path = app, pg_temp as $$
  with devolvidas as (
    update app.scheduled_actions
       set status = 'pendente'
     where status = 'executando'
       and due_at < now() - make_interval(mins => p_older_than_minutes)
    returning 1
  )
  select count(*)::int from devolvidas
$$;

revoke all on function app.requeue_stuck_actions(int) from public;
grant execute on function app.requeue_stuck_actions(int) to fliqo_app;
