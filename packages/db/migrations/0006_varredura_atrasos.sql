-- =====================================================================
-- 0006 — Varredura de atrasos: quais clínicas o worker precisa olhar.
-- =====================================================================

-- Clínica suspensa (inadimplência, pedido do dono) sai da varredura sem perder
-- nenhum dado. Fica em `clinics` e não numa tabela de assinatura porque o que a
-- varredura precisa saber é uma coisa só: olho para esta clínica agora ou não.
alter table app.clinics
  add column active boolean not null default true;

-- ---------------------------------------------------------------------
-- A única forma de a aplicação descobrir em quais clínicas trabalhar.
--
-- É `security definer` pelo mesmo motivo de `app.claim_due_actions`: o worker
-- roda sem clínica fixada na transação, e a RLS de `appointments` e `clinics`
-- devolveria zero linhas. Depois de pegar os ids, ele faz
-- set_config('app.clinic_id', ...) e trabalha dentro da RLS de cada uma.
--
-- Devolve `setof uuid`, e não `setof app.clinics`: assim é impossível vazar
-- nome, fuso ou qualquer outra coluna de uma clínica para outra — o tipo de
-- retorno é a garantia, não a boa intenção de quem escreve o select.
--
-- "Hoje" é o hoje de cada clínica: `c.timezone` existe desde a 0001 e é o que
-- manda. Uma clínica em Manaus vira o dia uma hora depois de uma em São Paulo,
-- e a varredura respeita isso sem nenhum ajuste.
-- ---------------------------------------------------------------------
create or replace function app.clinics_with_appointments_today()
returns setof uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select distinct a.clinic_id
    from app.appointments a
    join app.clinics c on c.id = a.clinic_id
   where c.active
     and a.status not in ('cancelado', 'faltou')
     and a.starts_at >= timezone(c.timezone, date_trunc('day', timezone(c.timezone, now())))
     and a.starts_at <  timezone(c.timezone, date_trunc('day', timezone(c.timezone, now())) + interval '1 day')
$$;

revoke execute on function app.clinics_with_appointments_today() from public;
grant  execute on function app.clinics_with_appointments_today() to fliqo_app;
