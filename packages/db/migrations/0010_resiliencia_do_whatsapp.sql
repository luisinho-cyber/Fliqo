-- =====================================================================
-- 0010 — Queda de WhatsApp: a ação espera em vez de queimar.
--
-- O problema, medido no código antes de existir esta migração: o token de uma
-- clínica é revogado às 2h; as confirmações de amanhã vencem, são reclamadas uma
-- a uma e falham como definitivo; às 9h alguém reconecta e descobre que os
-- trinta pacientes nunca foram confirmados. Uma queda de três horas comia um dia
-- inteiro de confirmação, em silêncio.
--
-- A resposta tem três peças aqui: um status terminal que não é falha, uma
-- propriedade que diz quem envia mensagem, e um claim que respeita as duas.
-- O raciocínio inteiro está em docs/OPERACAO.md.
-- =====================================================================

-- ---------------------------------------------------------------------
-- sem_proposito: terminal, e NÃO é falha
-- ---------------------------------------------------------------------
-- Ação represada durante a queda pode não fazer mais sentido quando o número
-- volta: "confirme sua consulta de amanhã" sobre um horário de ontem é mentira.
-- Encerrar como `erro` abriria alerta para uma consequência esperada da queda, e
-- alerta que não pede ação nenhuma ensina a recepção a ignorar alerta.
alter table app.scheduled_actions drop constraint scheduled_actions_status_check;
alter table app.scheduled_actions add constraint scheduled_actions_status_check
  check (status in ('pendente', 'executando', 'feito', 'cancelado', 'erro', 'sem_proposito'));

-- ---------------------------------------------------------------------
-- Quem envia mensagem
-- ---------------------------------------------------------------------
-- A exclusão no claim é por PROPRIEDADE, não por nome caso a caso. A primeira
-- versão desta regra excluía `expirar_oferta` olhando o nome, e o nome engana:
-- expirar não depende do WhatsApp, mas `expirarEPassarAdiante` oferece a vaga à
-- próxima rodada, e isso manda mensagem.
--
-- A lista aqui é a dos que NÃO enviam, e é curta de propósito: valor novo na enum
-- cai no lado "envia", ou seja, é SEGURADO durante a queda. Segurar uma ação é
-- recuperável; queimá-la não é. Quem falha alto quando um tipo novo entra sem
-- decisão é o teste em packages/db/tests, não a produção.
create or replace function app.action_kind_envia(p_kind app.action_kind)
returns boolean
language sql immutable as $$
  select p_kind not in ('marcar_risco')
$$;
comment on function app.action_kind_envia(app.action_kind) is
  'Este tipo de ação manda mensagem para o paciente? Valor desconhecido devolve true: segurar é recuperável, queimar não.';

-- ---------------------------------------------------------------------
-- O claim passa a respeitar o número em erro
-- ---------------------------------------------------------------------
-- Ela lê app.whatsapp_numbers, que tem RLS ligada mas SEM `force` (0003, e a
-- exceção está nomeada em packages/db/tests/rls-cobertura.test.ts): o dono do
-- schema — que é quem executa esta função — lê a tabela sem precisar de política.
--
-- `active and status = 'erro'` de propósito: `marcarErro` não desativa o número
-- nem apaga o token, porque a clínica volta reconectando. Número desativado é
-- outra história, e o caminho de envio já para antes, em `ativoDaClinica`.
create or replace function app.claim_due_actions(p_limit int)
returns setof app.scheduled_actions
language sql security definer set search_path = app, pg_temp as $$
  update app.scheduled_actions s
     set status = 'executando', attempts = s.attempts + 1
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

-- ---------------------------------------------------------------------
-- O alerta que nomeia a causa
-- ---------------------------------------------------------------------
-- Antes disto, trinta consultas viravam trinta alertas `acao_falhou`, e nenhum
-- deles dizia "o WhatsApp da clínica está fora". Um alerta por causa, não por
-- ação.
alter table app.alerts drop constraint alerts_kind_check;
alter table app.alerts add constraint alerts_kind_check
  check (kind in (
    'consulta_em_risco',
    'sem_consentimento',
    'acao_falhou',
    'horario_vago',
    'emergencia',
    'conversa_assumida',
    'atraso_profissional',
    'espera_longa',
    'whatsapp_fora'));
