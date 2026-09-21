-- =====================================================================
-- Fliqo — schema inicial
-- Regras que este arquivo garante NO BANCO (não no código, não na IA):
--   1. Toda linha pertence a uma clínica (clinic_id) e a RLS isola as clínicas.
--   2. Um profissional nunca tem dois atendimentos ativos no mesmo horário
--      (EXCLUDE constraint — vale mesmo com dois pedidos simultâneos).
--   3. Mudou o horário da consulta -> lembretes são recriados automaticamente.
--   4. Oferta de vaga da lista de espera é aceita por UMA pessoa só (claim atômico).
--   5. Dinheiro é sempre inteiro em centavos. Nunca float.
-- =====================================================================

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

create schema if not exists app;

-- Tenant atual da transação. A API executa `select set_config('app.clinic_id', $1, true)`
-- no início de cada transação. No Supabase, troque por um claim do JWT.
create or replace function app.clinic_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.clinic_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- Clínicas e configuração operacional
-- ---------------------------------------------------------------------
create type app.waitlist_mode as enum ('sequencial', 'lote');

create table app.clinics (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  timezone                  text not null default 'America/Sao_Paulo',
  -- Régua de confirmação (configurável por clínica)
  confirm_hours_before      int  not null default 24  check (confirm_hours_before between 2 and 72),
  final_reminder_minutes    int  not null default 90  check (final_reminder_minutes between 30 and 240),
  -- Sem resposta até X horas antes -> consulta entra em "risco" e a fila é avisada
  at_risk_hours_before      int  not null default 3   check (at_risk_hours_before between 1 and 24),
  -- Lista de espera
  waitlist_mode             app.waitlist_mode not null default 'lote',
  offer_batch_size          int  not null default 3   check (offer_batch_size between 1 and 10),
  offer_timeout_minutes     int  not null default 20  check (offer_timeout_minutes between 5 and 240),
  -- Prazo mínimo para oferecer vaga (ninguém chega em 10 min)
  min_offer_lead_minutes    int  not null default 60  check (min_offer_lead_minutes >= 15),
  is_demo                   boolean not null default false,
  created_at                timestamptz not null default now()
);

create table app.clinic_members (
  clinic_id  uuid not null references app.clinics(id) on delete cascade,
  user_id    uuid not null,
  role       text not null check (role in ('dono', 'recepcao', 'profissional', 'financeiro')),
  primary key (clinic_id, user_id)
);

create table app.professionals (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references app.clinics(id) on delete cascade,
  name       text not null,
  active     boolean not null default true,
  unique (clinic_id, id)
);

-- Procedimento = preço + duração + custo + prioridade. A IA lê daqui; nunca inventa preço.
create table app.procedures (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          uuid not null references app.clinics(id) on delete cascade,
  name               text not null,
  duration_minutes   int  not null check (duration_minutes between 5 and 600),
  price_cents        bigint not null check (price_cents >= 0),
  direct_cost_cents  bigint not null default 0 check (direct_cost_cents >= 0),
  commission_bp      int  not null default 0 check (commission_bp between 0 and 10000), -- basis points: 1000 = 10%
  -- Prioridade definida pela CLÍNICA (0 = eletivo, 3 = urgência/dor). A IA não julga gravidade.
  priority_level     smallint not null default 0 check (priority_level between 0 and 3),
  active             boolean not null default true,
  unique (clinic_id, id)
);

create table app.patients (
  id                     uuid primary key default gen_random_uuid(),
  clinic_id              uuid not null references app.clinics(id) on delete cascade,
  name                   text not null,
  phone_e164             text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_consent_at    timestamptz,             -- LGPD: sem consentimento, sem mensagem ativa
  prefers_audio          boolean not null default false,
  created_at             timestamptz not null default now(),
  unique (clinic_id, phone_e164),
  unique (clinic_id, id)
);

-- ---------------------------------------------------------------------
-- Agenda
-- ---------------------------------------------------------------------
create type app.appointment_status as enum
  ('agendado', 'confirmado', 'em_risco', 'cancelado', 'faltou', 'realizado');

create table app.appointments (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  professional_id  uuid not null,
  patient_id       uuid not null,
  procedure_id     uuid not null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           app.appointment_status not null default 'agendado',
  -- Snapshot: o preço do dia da marcação. Mudar a tabela depois não altera o passado.
  price_cents      bigint not null check (price_cents >= 0),
  source           text not null default 'recepcao' check (source in ('recepcao', 'ia', 'lista_espera', 'online')),
  confirmed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (clinic_id, professional_id) references app.professionals (clinic_id, id),
  foreign key (clinic_id, patient_id)      references app.patients      (clinic_id, id),
  foreign key (clinic_id, procedure_id)    references app.procedures    (clinic_id, id),
  -- REGRA 2: impossível marcar dois pacientes no mesmo horário do mesmo profissional.
  constraint no_double_booking exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('agendado', 'confirmado', 'em_risco', 'realizado'))
);
create index on app.appointments (clinic_id, starts_at);
create index on app.appointments (patient_id);

-- ---------------------------------------------------------------------
-- Ações agendadas (confirmação, lembrete, risco, expiração de oferta)
-- Worker: select ... where status='pendente' and due_at <= now() for update skip locked
-- Escala horizontalmente: N workers nunca pegam a mesma ação.
-- ---------------------------------------------------------------------
create type app.action_kind as enum ('confirmacao', 'lembrete_final', 'marcar_risco', 'expirar_oferta');

create table app.scheduled_actions (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references app.clinics(id) on delete cascade,
  kind            app.action_kind not null,
  appointment_id  uuid references app.appointments(id) on delete cascade,
  offer_id        uuid,
  due_at          timestamptz not null,
  status          text not null default 'pendente' check (status in ('pendente', 'executando', 'feito', 'cancelado', 'erro')),
  attempts        int not null default 0,
  last_error      text,
  created_at      timestamptz not null default now()
);
create index scheduled_actions_due on app.scheduled_actions (due_at) where status = 'pendente';
create unique index one_pending_per_kind
  on app.scheduled_actions (appointment_id, kind) where status = 'pendente' and appointment_id is not null;

-- REGRA 3: (re)cria a régua sempre que a consulta nasce ou muda de horário/status.
create or replace function app.sync_appointment_actions() returns trigger
language plpgsql as $$
declare c app.clinics;
begin
  if tg_op = 'UPDATE'
     and new.starts_at = old.starts_at
     and new.status = old.status then
    return new;
  end if;

  update app.scheduled_actions set status = 'cancelado'
   where appointment_id = new.id and status = 'pendente';

  if new.status not in ('agendado', 'confirmado', 'em_risco') then
    return new;
  end if;

  select * into c from app.clinics where id = new.clinic_id;

  -- Confirmação só se ainda não confirmou e se ainda dá tempo
  if new.status in ('agendado', 'em_risco') then
    insert into app.scheduled_actions (clinic_id, kind, appointment_id, due_at)
    select new.clinic_id, 'confirmacao', new.id, new.starts_at - make_interval(hours => c.confirm_hours_before)
     where new.status = 'agendado'
       and new.starts_at - make_interval(hours => c.confirm_hours_before) > now();

    insert into app.scheduled_actions (clinic_id, kind, appointment_id, due_at)
    select new.clinic_id, 'marcar_risco', new.id, new.starts_at - make_interval(hours => c.at_risk_hours_before)
     where new.status = 'agendado'
       and new.starts_at - make_interval(hours => c.at_risk_hours_before) > now();
  end if;

  insert into app.scheduled_actions (clinic_id, kind, appointment_id, due_at)
  select new.clinic_id, 'lembrete_final', new.id, new.starts_at - make_interval(mins => c.final_reminder_minutes)
   where new.starts_at - make_interval(mins => c.final_reminder_minutes) > now();

  return new;
end $$;

create trigger appointments_sync_actions
after insert or update of starts_at, status on app.appointments
for each row execute function app.sync_appointment_actions();

-- ---------------------------------------------------------------------
-- Lista de espera e ofertas de vaga
-- ---------------------------------------------------------------------
create table app.waitlist_entries (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  patient_id       uuid not null,
  procedure_id     uuid not null,
  professional_id  uuid,                              -- null = qualquer profissional
  window_start     date not null,
  window_end       date not null,
  priority_level   smallint not null default 0 check (priority_level between 0 and 3),
  status           text not null default 'aguardando' check (status in ('aguardando', 'atendido', 'cancelado')),
  created_at       timestamptz not null default now(),
  check (window_end >= window_start),
  foreign key (clinic_id, patient_id)   references app.patients   (clinic_id, id),
  foreign key (clinic_id, procedure_id) references app.procedures (clinic_id, id)
);
create index on app.waitlist_entries (clinic_id, status, priority_level desc, created_at);

create table app.slot_offers (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          uuid not null references app.clinics(id) on delete cascade,
  waitlist_entry_id  uuid not null references app.waitlist_entries(id) on delete cascade,
  professional_id    uuid not null,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  expires_at         timestamptz not null,
  status             text not null default 'enviada'
                     check (status in ('enviada', 'aceita', 'recusada', 'expirada', 'preenchida_por_outro')),
  created_at         timestamptz not null default now()
);
create index on app.slot_offers (professional_id, starts_at) where status = 'enviada';

-- Ranking: prioridade do procedimento/entrada (maior primeiro) e depois ordem de chegada.
create or replace function app.rank_waitlist(
  p_clinic uuid, p_professional uuid, p_starts timestamptz, p_ends timestamptz, p_limit int
) returns setof app.waitlist_entries
language sql stable as $$
  select w.*
    from app.waitlist_entries w
    join app.procedures pr on pr.id = w.procedure_id
    join app.clinics c on c.id = w.clinic_id
   where w.clinic_id = p_clinic
     and w.status = 'aguardando'
     and (w.professional_id is null or w.professional_id = p_professional)
     and (p_starts at time zone c.timezone)::date between w.window_start and w.window_end
     and pr.duration_minutes <= extract(epoch from (p_ends - p_starts)) / 60
     -- não oferece de novo a quem já recebeu oferta para este mesmo horário
     and not exists (
       select 1 from app.slot_offers o
        where o.waitlist_entry_id = w.id
          and o.professional_id = p_professional
          and o.starts_at = p_starts)
     -- não oferece a quem já tem consulta ativa no mesmo horário
     and not exists (
       select 1 from app.appointments a
        where a.patient_id = w.patient_id
          and a.status in ('agendado', 'confirmado', 'em_risco')
          and tstzrange(a.starts_at, a.ends_at) && tstzrange(p_starts, p_ends))
   order by greatest(w.priority_level, pr.priority_level) desc, w.created_at asc
   limit p_limit
$$;

-- REGRA 4: primeiro "sim" leva. Os demais recebem 'preenchida_por_outro'.
-- Retorna o id da consulta criada, ou null se a vaga já foi ocupada / oferta expirou.
create or replace function app.claim_slot_offer(p_offer uuid) returns uuid
language plpgsql as $$
declare
  o   app.slot_offers;
  w   app.waitlist_entries;
  pr  app.procedures;
  new_id uuid;
begin
  -- Serializa todos os "sim" da MESMA vaga (profissional + horário) antes de travar
  -- qualquer linha. Sem isso, dois aceites simultâneos travam um ao outro (deadlock):
  -- cada um segura a própria oferta e espera a do outro.
  select * into o from app.slot_offers where id = p_offer;
  if not found then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(o.professional_id::text || '|' || o.starts_at::text, 0));

  select * into o from app.slot_offers where id = p_offer for update;
  if o.status <> 'enviada' or o.expires_at < now() then
    return null;
  end if;

  select * into w  from app.waitlist_entries where id = o.waitlist_entry_id for update;
  select * into pr from app.procedures      where id = w.procedure_id;

  begin
    insert into app.appointments
      (clinic_id, professional_id, patient_id, procedure_id, starts_at, ends_at,
       status, price_cents, source, confirmed_at)
    values
      (o.clinic_id, o.professional_id, w.patient_id, w.procedure_id,
       o.starts_at, o.starts_at + make_interval(mins => pr.duration_minutes),
       'confirmado', pr.price_cents, 'lista_espera', now())
    returning id into new_id;
  exception when exclusion_violation then
    -- Outra pessoa ocupou o horário no mesmo instante: a constraint decidiu.
    update app.slot_offers set status = 'preenchida_por_outro' where id = p_offer;
    return null;
  end;

  update app.slot_offers set status = 'aceita' where id = p_offer;
  update app.waitlist_entries set status = 'atendido' where id = w.id;
  update app.slot_offers
     set status = 'preenchida_por_outro'
   where professional_id = o.professional_id
     and starts_at = o.starts_at
     and status = 'enviada'
     and id <> p_offer;

  return new_id;
end $$;

-- ---------------------------------------------------------------------
-- Conversas (WhatsApp) — idempotência por wamid
-- ---------------------------------------------------------------------
create table app.conversations (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  patient_id       uuid not null,
  mode             text not null default 'ia' check (mode in ('ia', 'humano')), -- 'humano' silencia a IA
  handover_reason  text,
  last_inbound_at  timestamptz,       -- janela de 24h da Meta
  unique (clinic_id, patient_id),
  foreign key (clinic_id, patient_id) references app.patients (clinic_id, id)
);

create table app.messages (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  conversation_id  uuid not null references app.conversations(id) on delete cascade,
  direction        text not null check (direction in ('entrada', 'saida')),
  author           text not null check (author in ('paciente', 'ia', 'humano', 'sistema')),
  wamid            text unique,        -- webhook repetido da Meta não duplica mensagem
  body             text,
  media_kind       text check (media_kind in ('audio', 'imagem', 'documento')),
  created_at       timestamptz not null default now()
);
create index on app.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------
-- Configuração da IA por clínica (versionada — dá para voltar atrás)
-- ---------------------------------------------------------------------
create table app.ai_profiles (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          uuid not null references app.clinics(id) on delete cascade,
  version            int not null,
  is_active          boolean not null default false,
  profile            jsonb not null,   -- validado por Zod em packages/ai (ClinicProfileSchema)
  created_by         uuid,
  created_at         timestamptz not null default now(),
  unique (clinic_id, version)
);
create unique index one_active_profile on app.ai_profiles (clinic_id) where is_active;

-- ---------------------------------------------------------------------
-- Financeiro
-- ---------------------------------------------------------------------
create table app.payment_methods (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         uuid not null references app.clinics(id) on delete cascade,
  name              text not null,                         -- 'Pix', 'Crédito 3x', 'Convênio X'
  fee_bp            int  not null default 0 check (fee_bp between 0 and 10000),
  settlement_days   int  not null default 0 check (settlement_days between 0 and 180),
  installments      int  not null default 1 check (installments between 1 and 24),
  unique (clinic_id, id)
);

create table app.cash_entries (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  kind             text not null check (kind in ('receita', 'despesa')),
  status           text not null check (status in ('previsto', 'realizado', 'cancelado')),
  category         text not null,        -- 'procedimento', 'taxa_cartao', 'comissao', 'insumo', 'aluguel'...
  description      text not null,
  amount_cents     bigint not null check (amount_cents >= 0),
  due_date         date not null,
  appointment_id   uuid references app.appointments(id) on delete set null,
  installment_no   int,
  created_at       timestamptz not null default now()
);
create index on app.cash_entries (clinic_id, due_date);

-- ---------------------------------------------------------------------
-- RLS — REGRA 1. Uma clínica nunca enxerga dado de outra.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'professionals','procedures','patients','appointments','scheduled_actions',
    'waitlist_entries','slot_offers','conversations','messages','ai_profiles',
    'payment_methods','cash_entries','clinic_members'
  ] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on app.%I using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id())', t);
  end loop;
end $$;

alter table app.clinics enable row level security;
alter table app.clinics force row level security;
create policy tenant_isolation on app.clinics using (id = app.clinic_id());

-- Papel usado pela API em runtime. O dono do schema (migrações) não passa pela RLS;
-- a aplicação NUNCA conecta como dono.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fliqo_app') then
    create role fliqo_app nologin;
  end if;
end $$;
grant usage on schema app to fliqo_app;
grant select, insert, update, delete on all tables in schema app to fliqo_app;
grant execute on all functions in schema app to fliqo_app;

-- ---------------------------------------------------------------------
-- Worker: pega um lote de ações vencidas de TODAS as clínicas, sem que dois
-- workers peguem a mesma. Security definer = único ponto que cruza tenants.
-- Depois de pegar, o worker faz set_config('app.clinic_id', action.clinic_id)
-- e executa a ação já dentro da RLS daquela clínica.
-- ---------------------------------------------------------------------
create or replace function app.claim_due_actions(p_limit int)
returns setof app.scheduled_actions
language sql security definer set search_path = app, pg_temp as $$
  update app.scheduled_actions s
     set status = 'executando', attempts = s.attempts + 1
   where s.id in (
     select id from app.scheduled_actions
      where status = 'pendente' and due_at <= now()
      order by due_at
      limit p_limit
      for update skip locked)
  returning s.*
$$;
revoke all on function app.claim_due_actions(int) from public;
grant execute on function app.claim_due_actions(int) to fliqo_app;
