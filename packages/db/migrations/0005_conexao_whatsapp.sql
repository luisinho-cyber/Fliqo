-- =====================================================================
-- 0005 — Conexão do número da clínica (Embedded Signup com coexistência).
--
-- O token de acesso da clínica fica aqui, CIFRADO. Ele permite enviar mensagem
-- em nome da clínica: em claro no banco, um dump de backup viraria acesso ao
-- WhatsApp de todas as clínicas.
--
-- AES-256-GCM: o ciphertext, o IV e a tag de autenticação em colunas separadas.
-- A tag é o que impede alguém com acesso de escrita ao banco de trocar o token
-- por outro sem que a decifragem falhe.
-- =====================================================================

create type app.whatsapp_status as enum ('pendente', 'conectado', 'erro', 'desconectado');

alter table app.whatsapp_numbers
  add column status            app.whatsapp_status not null default 'pendente',
  -- Coexistência: a clínica segue usando o app do celular no mesmo número.
  add column coexistencia      boolean not null default false,
  add column token_ciphertext  bytea,
  add column token_iv          bytea,
  add column token_tag         bytea,
  add column token_updated_at  timestamptz,
  add column connected_at      timestamptz,
  add column last_error        text,
  -- Ou as três partes do token estão presentes, ou nenhuma. Meio token é um bug
  -- que só apareceria na hora de enviar mensagem.
  add constraint token_completo check (
    (token_ciphertext is null and token_iv is null and token_tag is null) or
    (token_ciphertext is not null and token_iv is not null and token_tag is not null)
  ),
  -- Conectado sem token não existe: seria a clínica achando que pode enviar.
  add constraint conectado_tem_token check (
    status <> 'conectado' or token_ciphertext is not null
  );

-- Histórico de conexões, para a clínica ver o que aconteceu sem expor o token.
create table app.whatsapp_connection_events (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  whatsapp_number_id uuid references app.whatsapp_numbers(id) on delete cascade,
  kind             text not null check (kind in ('conectou', 'reconectou', 'falhou', 'desconectou')),
  detail           text,
  created_at       timestamptz not null default now()
);
create index on app.whatsapp_connection_events (clinic_id, created_at desc);

alter table app.whatsapp_connection_events enable row level security;
alter table app.whatsapp_connection_events force row level security;
create policy tenant_isolation on app.whatsapp_connection_events
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert, update, delete on app.whatsapp_connection_events to fliqo_app;
