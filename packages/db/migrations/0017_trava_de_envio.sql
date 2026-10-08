-- =====================================================================
-- 0017 — Trava de envio: a mesma mensagem não sai duas vezes para a mesma consulta.
--
-- A idempotência por wamid (0001) protege o que CHEGA. A saída não tinha trava
-- nenhuma: o wamid do envio nem era gravado, e o único registro de que a ação
-- saiu era o `status = 'feito'`, na mesma transação do envio. Qualquer caminho
-- que reexecutasse a ação — requeue, retentativa, dois workers — mandava a
-- confirmação de novo, e quem via primeiro era a clínica.
--
-- O desenho é o do `no_double_booking`: quem decide é o banco, não um SELECT
-- antes do envio.
--
--   1. ANTES de chamar a Meta, o worker reserva a linha (clínica, consulta,
--      template). A segunda tentativa bate 23505 e é tratada como "já saiu".
--   2. Depois do 200, a MESMA linha recebe o wamid e o momento.
--   3. Envio que falhou desfaz a reserva na mesma transação.
--
-- O índice cobre a reserva ainda sem wamid, e não só o envio concluído, de
-- propósito: é o que faz o segundo worker ESPERAR o primeiro em vez de chamar a
-- Meta em paralelo. Um índice parcial `where wamid is not null` só acusaria o
-- conflito no update, depois de os dois já terem enviado.
--
-- "Só envio concluído fica gravado" é garantido de outro jeito: um gatilho
-- adiado recusa o COMMIT de qualquer linha sem wamid. Reserva esquecida por um
-- bug não pode virar trava eterna — seria a confirmação que nunca mais sai.
--
-- O que sobra, aceito e escrito: o worker cair entre o 200 da Meta e o commit.
-- A transação volta inteira, reserva junto, e a ação é reexecutada. Ali o
-- envio é "pelo menos uma vez": só a Meta sabe que a mensagem saiu.
-- =====================================================================

create table app.envios (
  id              uuid        primary key default gen_random_uuid(),
  clinic_id       uuid        not null references app.clinics(id) on delete cascade,
  appointment_id  uuid        not null references app.appointments(id) on delete cascade,
  template_name   text        not null,
  -- O horário da consulta no momento do envio. Entra na chave: se um dia algo mover
  -- a MESMA consulta para outro horário (hoje remarcar cria outra), a confirmação do
  -- horário novo é outra mensagem e passa, em vez de bater numa trava esquecida.
  appointment_starts_at timestamptz not null,
  -- Rastro de qual ação mandou. A trava NÃO depende dele: uma ação duplicada para
  -- a mesma consulta também é segurada pelo índice.
  action_id       uuid        references app.scheduled_actions(id) on delete set null,
  wamid           text,
  enviado_em      timestamptz,
  created_at      timestamptz not null default now(),
  constraint envio_wamid_e_momento_juntos check ((wamid is null) = (enviado_em is null))
);

create unique index envio_unico_por_consulta
  on app.envios (clinic_id, appointment_id, template_name, appointment_starts_at);

/*
 * Lê a linha de NOVO, em vez de olhar NEW: o gatilho é adiado, e o evento do
 * INSERT carrega a linha como era no insert — sem wamid —, mesmo que o update
 * já a tenha completado. Linha apagada (reserva desfeita) não existe mais e passa.
 */
create function app.envio_sem_wamid_nao_fica()
returns trigger
language plpgsql as $$
begin
  if exists (select 1 from app.envios where id = new.id and wamid is null) then
    raise exception 'envio % chegou ao commit sem wamid: reserva não concluída nem desfeita', new.id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger envio_concluido_no_commit
  after insert or update on app.envios
  deferrable initially deferred
  for each row execute function app.envio_sem_wamid_nao_fica();

alter table app.envios enable row level security;
alter table app.envios force row level security;
create policy tenant_isolation on app.envios
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert, update, delete on app.envios to fliqo_app;
