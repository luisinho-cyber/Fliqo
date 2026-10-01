-- =====================================================================
-- 0012 — Modo convidado: a Fliqo sobre a agenda que a clínica já usa.
--
-- A clínica que não vai trocar de sistema hoje ainda perde horário por falta de
-- confirmação. O modo convidado é a Fliqo entrando pela porta estreita: ela lê a
-- agenda do outro sistema, confirma, chama a lista de espera, avisa atraso e
-- atende pelo WhatsApp — e não finge ser a fonte da verdade do que não é dela.
--
-- Três peças aqui: a chave natural que torna reimportação idempotente, o registro
-- da importação com o motivo de cada linha recusada, e a flag que desliga o que
-- não faz sentido quando a verdade está em outro lugar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A flag
-- ---------------------------------------------------------------------
-- Desliga prontuário e financeiro. Não é permissão nem plano: é uma afirmação
-- sobre ONDE está a verdade. Prontuário e caixa parciais são pior do que
-- ausentes — um número que não fecha com o outro sistema faz a clínica
-- desconfiar dos números que ESTÃO certos, e aí a agenda também perde crédito.
--
-- A lista de recursos que a flag desliga é enumerada no código
-- (packages/core/src/importacao.ts), com teste que exige prontuário e financeiro
-- nela. Aqui fica só o fato.
alter table app.clinics
  add column guest_mode boolean not null default false;

comment on column app.clinics.guest_mode is
  'A agenda da clínica vive em outro sistema; a Fliqo opera sobre ela. Desliga prontuário e financeiro.';

-- ---------------------------------------------------------------------
-- Consulta importada se reconhece
-- ---------------------------------------------------------------------
alter table app.appointments drop constraint appointments_source_check;
alter table app.appointments add constraint appointments_source_check
  check (source in ('recepcao', 'ia', 'lista_espera', 'online', 'importado'));

-- ---------------------------------------------------------------------
-- A chave natural: importar o mesmo arquivo duas vezes não duplica consulta
-- ---------------------------------------------------------------------
-- (clinic_id, professional_id, starts_at, patient_id). O telefone entra por
-- `patient_id`, e não como coluna: a deduplicação por telefone normalizado
-- acontece ANTES, em `pacientes.acharOuCriarPorTelefone`, então o paciente já É a
-- forma canônica do telefone. Guardar o telefone aqui criaria uma segunda verdade
-- sobre quem é a pessoa.
--
-- Índice ÚNICO, e não parcial por status: consulta cancelada na Fliqo continua
-- ocupando a chave. Reimportar o arquivo de ontem não ressuscita o que a recepção
-- cancelou hoje — a reimportação conta aquela linha como "já existia", que é a
-- verdade.
--
-- Isto é mais estreito do que o `no_double_booking`, que já proíbe dois pacientes
-- no mesmo intervalo do mesmo profissional nos status ativos. Os dois convivem de
-- propósito, e a importação os distingue: conflito de CHAVE é linha repetida
-- (ignorada em silêncio é correto, porque nada mudou); conflito de INTERVALO é
-- horário ocupado por outra pessoa, que é recusa com motivo.
create unique index appointment_natural_key
  on app.appointments (clinic_id, professional_id, starts_at, patient_id);

-- ---------------------------------------------------------------------
-- O relatório da importação
-- ---------------------------------------------------------------------
create table app.schedule_imports (
  id             uuid primary key default gen_random_uuid(),
  clinic_id      uuid not null references app.clinics(id) on delete cascade,
  -- Quem importou. Mudança de agenda em lote sem autor é a pergunta sem resposta
  -- de segunda-feira, igual ao carimbo de duração da 0011.
  actor_user_id  uuid not null,
  file_name      text not null,
  rows_total     int  not null check (rows_total >= 0),
  rows_imported  int  not null check (rows_imported >= 0),
  rows_repeated  int  not null check (rows_repeated >= 0),
  rows_rejected  int  not null check (rows_rejected >= 0),
  created_at     timestamptz not null default now(),
  -- As quatro contas têm de fechar com o total. Relatório que não soma é
  -- relatório que esconde linha, e esconder linha é exatamente o que esta
  -- tabela existe para impedir.
  constraint contas_fecham check (rows_imported + rows_repeated + rows_rejected = rows_total)
);
create index on app.schedule_imports (clinic_id, created_at desc);

alter table app.schedule_imports enable row level security;
alter table app.schedule_imports force row level security;
create policy tenant_isolation on app.schedule_imports
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert on app.schedule_imports to fliqo_app;

-- Linha recusada, com o motivo. Nunca some em silêncio.
--
-- Guarda o NÚMERO DA LINHA e um rótulo curto, e NÃO guarda o telefone nem a linha
-- crua. Duas razões. A primeira é que o número da linha é o que resolve o
-- problema: quem vai consertar abre a planilha na linha 37. A segunda é que
-- telefone de paciente não precisa de uma cópia a mais em tabela nova — e linha
-- recusada por telefone inválido não teria o que mascarar de todo jeito.
create table app.schedule_import_rows (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references app.clinics(id) on delete cascade,
  import_id   uuid not null references app.schedule_imports(id) on delete cascade,
  line_number int  not null check (line_number > 0),
  reason      text not null,
  -- O nome como veio na planilha, cortado. Serve para a pessoa reconhecer a
  -- linha sem abrir o arquivo; vazio quando a coluna de nome é que faltou.
  label       text not null default '',
  constraint label_curto check (length(label) <= 120)
);
create index on app.schedule_import_rows (import_id, line_number);

alter table app.schedule_import_rows enable row level security;
alter table app.schedule_import_rows force row level security;
create policy tenant_isolation on app.schedule_import_rows
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert on app.schedule_import_rows to fliqo_app;
