-- =====================================================================
-- 0007 — as clínicas de quem acabou de entrar no painel
--
-- O painel precisa responder "de qual clínica é esta pessoa?" ANTES de ter
-- uma clínica: sem tenant na transação, a RLS não devolve nenhuma linha de
-- app.clinic_members, e a pergunta não tem resposta. É o mesmo caso de
-- app.clinic_by_phone_number_id: a única coisa que acontece antes de saber de
-- qual clínica se trata.
--
-- A função devolve SÓ ids. Nome, fuso e configuração continuam do outro lado
-- da RLS, lidos dentro de withClinic depois que a clínica foi escolhida.
--
-- O id do usuário NUNCA vem do cliente: a API passa o `sub` do JWT que ela
-- mesma verificou. Quem chama com outro id vê as clínicas daquele outro id —
-- por isso execute é só do fliqo_app, e a API é o único caminho até aqui.
-- =====================================================================

create or replace function app.clinic_ids_of_member(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select m.clinic_id
    from app.clinic_members m
    join app.clinics c on c.id = m.clinic_id
   where m.user_id = p_user_id
     and c.active
   order by m.clinic_id
$$;

revoke execute on function app.clinic_ids_of_member(uuid) from public;
grant  execute on function app.clinic_ids_of_member(uuid) to fliqo_app;
