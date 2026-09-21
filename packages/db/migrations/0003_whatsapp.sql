-- =====================================================================
-- 0003 — Número do WhatsApp por clínica, alertas do painel e consumo de IA.
--
-- O ponto sensível deste arquivo é app.clinic_by_phone_number_id: é a segunda
-- função que cruza clínicas no sistema (a primeira é app.claim_due_actions).
-- Ela existe porque o webhook da Meta chega sem saber de quem é — só com o
-- phone_number_id — e precisa descobrir a clínica ANTES de abrir a transação
-- com set_config('app.clinic_id'). Sem ela, a consulta voltaria vazia pela RLS.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Número do WhatsApp da clínica (Meta Cloud API)
-- ---------------------------------------------------------------------
create table app.whatsapp_numbers (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid not null references app.clinics(id) on delete cascade,
  -- Identificador do número na Meta. É o que vem no webhook.
  phone_number_id     text not null unique,
  display_phone_e164  text check (display_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  waba_id             text,
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);

-- RLS ligada, mas de propósito SEM `force`, ao contrário das outras tabelas.
-- `force` faria a RLS valer até para o dono do schema, e é justamente o dono
-- que a função security definer abaixo usa para achar a clínica de um número
-- antes de haver clínica na transação. Para a aplicação (fliqo_app) nada muda:
-- ela não é dona da tabela, continua presa à própria clínica.
alter table app.whatsapp_numbers enable row level security;
create policy tenant_isolation on app.whatsapp_numbers
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert, update, delete on app.whatsapp_numbers to fliqo_app;

-- Único ponto que traduz número da Meta -> clínica. Não lê mais nada, não recebe
-- nada que vire SQL, e devolve só o uuid da clínica.
create or replace function app.clinic_by_phone_number_id(p_phone_number_id text)
returns uuid
language sql stable security definer set search_path = app, pg_temp as $$
  select clinic_id
    from app.whatsapp_numbers
   where phone_number_id = p_phone_number_id
     and active
$$;
revoke all on function app.clinic_by_phone_number_id(text) from public;
grant execute on function app.clinic_by_phone_number_id(text) to fliqo_app;

-- ---------------------------------------------------------------------
-- Alertas do painel — o que a recepção precisa ver e resolver
-- ---------------------------------------------------------------------
create table app.alerts (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  kind             text not null check (kind in (
                     'consulta_em_risco',      -- não confirmou até o prazo
                     'sem_consentimento',      -- mensagem ativa barrada pela LGPD
                     'acao_falhou',            -- ação agendada desistiu depois de N tentativas
                     'horario_vago',           -- ninguém da fila quis a vaga
                     'emergencia',             -- proteção de entrada pegou urgência clínica
                     'conversa_assumida',      -- IA passou para humano
                     'atraso_profissional',
                     'espera_longa')),
  severity         text not null check (severity in ('info', 'atencao', 'urgente')),
  title            text not null,
  body             text,
  appointment_id   uuid references app.appointments(id) on delete cascade,
  conversation_id  uuid references app.conversations(id) on delete cascade,
  patient_id       uuid,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index alerts_abertos on app.alerts (clinic_id, created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------
-- Consumo de IA por clínica — custo por mensagem é o gargalo a vigiar
-- ---------------------------------------------------------------------
create table app.ai_usage (
  id                    uuid primary key default gen_random_uuid(),
  clinic_id             uuid not null references app.clinics(id) on delete cascade,
  conversation_id       uuid references app.conversations(id) on delete set null,
  model                 text not null,
  input_tokens          int not null default 0 check (input_tokens >= 0),
  output_tokens         int not null default 0 check (output_tokens >= 0),
  cache_read_tokens     int not null default 0 check (cache_read_tokens >= 0),
  cache_creation_tokens int not null default 0 check (cache_creation_tokens >= 0),
  created_at            timestamptz not null default now()
);
create index ai_usage_por_clinica on app.ai_usage (clinic_id, created_at desc);

-- Estas duas seguem o padrão das demais: RLS com force.
do $$
declare t text;
begin
  foreach t in array array['alerts', 'ai_usage'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format(
      'create policy tenant_isolation on app.%I using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id())', t);
  end loop;
end $$;
grant select, insert, update, delete on app.alerts, app.ai_usage to fliqo_app;

-- ---------------------------------------------------------------------
-- Fila (pg-boss)
-- ---------------------------------------------------------------------
-- O schema é criado aqui, vazio, para que os privilégios padrão já estejam
-- valendo quando o pg-boss criar as tabelas dele dentro (no db:migrate, com a
-- conexão de dono). Assim a aplicação enfileira sem nunca poder criar schema.
create schema if not exists pgboss;
grant usage on schema pgboss to fliqo_app;
alter default privileges in schema pgboss grant select, insert, update, delete on tables to fliqo_app;
alter default privileges in schema pgboss grant usage, select on sequences to fliqo_app;
alter default privileges in schema pgboss grant execute on functions to fliqo_app;
