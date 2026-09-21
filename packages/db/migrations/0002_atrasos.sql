-- =====================================================================
-- 0002 — Atrasos: horários reais do atendimento, avisos enviados e
-- duração real por profissional/procedimento (a causa raiz do atraso).
-- =====================================================================

alter table app.appointments
  add column checked_in_at timestamptz,   -- paciente chegou na recepção
  add column started_at    timestamptz,   -- profissional iniciou o atendimento
  add column finished_at   timestamptz,   -- terminou
  add constraint started_after_checkin check (started_at is null or checked_in_at is null or started_at >= checked_in_at - interval '1 hour'),
  add constraint finished_after_start  check (finished_at is null or (started_at is not null and finished_at > started_at));

-- Configuração de avisos por clínica
alter table app.clinics
  add column delay_notice_threshold_minutes int not null default 15 check (delay_notice_threshold_minutes between 5 and 120),
  add column delay_notice_window_hours      int not null default 3  check (delay_notice_window_hours between 1 and 8),
  add column waiting_room_alert_minutes     int not null default 15 check (waiting_room_alert_minutes between 5 and 60);

-- Último atraso comunicado a cada consulta (evita mandar 6 mensagens de atraso).
create table app.delay_notices (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  appointment_id   uuid not null references app.appointments(id) on delete cascade,
  channel          text not null check (channel in ('whatsapp', 'recepcao')),
  delay_minutes    int  not null check (delay_minutes >= 0),
  sent_at          timestamptz not null default now()
);
create index on app.delay_notices (appointment_id, sent_at desc);

alter table app.delay_notices enable row level security;
alter table app.delay_notices force row level security;
create policy tenant_isolation on app.delay_notices
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert, update, delete on app.delay_notices to fliqo_app;

-- Duração REAL por profissional e procedimento nos últimos 90 dias (mediana).
-- É isso que mostra ao dono que "botox com a Dra. Ana leva 55 min, não 40".
create view app.procedure_real_durations
with (security_invoker = true) as
select a.clinic_id,
       a.professional_id,
       a.procedure_id,
       count(*)::int                                                     as sample_size,
       percentile_cont(0.5) within group (
         order by extract(epoch from (a.finished_at - a.started_at)) / 60) as median_minutes,
       max(p.duration_minutes)                                            as scheduled_minutes
  from app.appointments a
  join app.procedures p on p.id = a.procedure_id
 where a.status = 'realizado'
   and a.started_at is not null
   and a.finished_at is not null
   and a.started_at > now() - interval '90 days'
 group by a.clinic_id, a.professional_id, a.procedure_id;

-- Pontualidade por profissional por dia: quanto o atendimento começou depois do horário marcado.
create view app.professional_punctuality
with (security_invoker = true) as
select a.clinic_id,
       a.professional_id,
       (a.starts_at at time zone c.timezone)::date as day,
       count(*)::int                                                              as appointments,
       round(avg(greatest(0, extract(epoch from (a.started_at - a.starts_at)) / 60)))::int as avg_delay_minutes,
       count(*) filter (where a.started_at <= a.starts_at + interval '10 minutes')::int  as on_time
  from app.appointments a
  join app.clinics c on c.id = a.clinic_id
 where a.started_at is not null
 group by a.clinic_id, a.professional_id, (a.starts_at at time zone c.timezone)::date;

grant select on app.procedure_real_durations, app.professional_punctuality to fliqo_app;
