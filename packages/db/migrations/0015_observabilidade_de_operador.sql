-- =====================================================================
-- 0015 — Observabilidade de operador: a SEXTA função security definer.
--
-- SOBRE O NÚMERO DESTE ARQUIVO: esta branch sai da resiliência do WhatsApp, cujas
-- migrações terminam na 0010, mas a fila de merge já tem 0011 a 0014 em outras
-- branches. O número 0015 é para o log de migração de PRODUÇÃO ficar em ordem
-- crescente, que é como um humano o lê num dia ruim. O migrador aplica em ordem
-- lexical e não exige sequência contínua, então o buraco de 0011 a 0014 nesta
-- branch é esperado e se fecha quando as outras mesclarem.
--
-- SE A ORDEM DA FILA MUDAR, este arquivo tem de ser renumerado ANTES de mesclar.
-- Renomear é legal enquanto a migração não foi aplicada em produção; depois, não
-- (CLAUDE.md, regra 8).
--
-- O que entra:
--   1. app.operator_health() — security definer, SÓ LEITURA, agregada.
--   2. app.operator_notices — o estado do reenvio, com RLS forçada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. A função de operador
-- ---------------------------------------------------------------------
-- Ela cruza clínicas de propósito, e é a sexta a fazer isso. As cinco anteriores
-- existem porque algo acontece ANTES de haver clínica na transação (o webhook, o
-- claim, o login). Esta é a primeira que cruza por outra razão: a pergunta é do
-- operador, e a resposta é sobre todas as clínicas de uma vez.
--
-- O que a torna aceitável é o RETORNO, não o propósito:
--
--   * só agregado — contagens e carimbos, nunca uma linha de ninguém;
--   * nenhum id de paciente, nenhum telefone, nenhum conteúdo de mensagem;
--   * `app.messages` entra como `count(*)` e nada mais: o corpo da mensagem não é
--     lido, selecionado nem devolvido.
--
-- O nome da clínica entra porque e-mail sem ele obriga o operador a abrir o banco
-- para saber de quem se trata, e aí o aviso deixa de ser acionável. Nome de clínica
-- é dado de empresa, não de pessoa.
--
-- `security definer` + `search_path = app, pg_temp`: sem o search_path fixo, quem
-- controlasse o caminho de resolução de nomes escolheria qual `messages` a função lê.
create or replace function app.operator_health(
  p_janela_de_silencio_horas int default 3
)
returns table (
  clinic_id            uuid,
  clinic_name          text,
  whatsapp_fora_desde  timestamptz,
  enviadas_ultima_hora bigint,
  enviadas_na_janela   bigint,
  vencidas_na_janela   bigint,
  qualidade            text
)
language sql
security definer
set search_path = app, pg_temp
stable
as $$
  select
    c.id,
    c.name,
    -- O alerta MAIS ANTIGO ainda aberto: é a idade do problema, não a do último
    -- registro. `criarSeNaoHouverAberto` mantém um só, mas min() não depende disso.
    (select min(a.created_at)
       from app.alerts a
      where a.clinic_id = c.id and a.kind = 'whatsapp_fora' and a.resolved_at is null),
    (select count(*)
       from app.messages m
      where m.clinic_id = c.id
        and m.direction = 'saida'
        and m.created_at >= now() - interval '1 hour'),
    (select count(*)
       from app.messages m
      where m.clinic_id = c.id
        and m.direction = 'saida'
        and m.created_at >= now() - make_interval(hours => p_janela_de_silencio_horas)),
    -- O que DEVERIA ter saído: ação de envio que venceu na janela. `action_kind_envia`
    -- (0010) é quem decide o que manda mensagem — não uma lista de nomes repetida aqui.
    (select count(*)
       from app.scheduled_actions s
      where s.clinic_id = c.id
        and app.action_kind_envia(s.kind)
        and s.due_at >= now() - make_interval(hours => p_janela_de_silencio_horas)
        and s.due_at <= now()),
    (select w.quality_rating
       from app.whatsapp_numbers w
      where w.clinic_id = c.id and w.active
      order by w.created_at desc
      limit 1)
  from app.clinics c
  where c.active
    and not c.is_demo
$$;

comment on function app.operator_health(int) is
  'Saúde por clínica para o operador. Retorno AGREGADO: contagens e carimbos, nunca linha de paciente, telefone ou conteúdo de mensagem.';

-- `public` não executa: quem chama é o worker, com o papel da aplicação.
revoke all on function app.operator_health(int) from public;
grant execute on function app.operator_health(int) to fliqo_app;

-- ---------------------------------------------------------------------
-- 2. O estado do reenvio
-- ---------------------------------------------------------------------
-- Alerta de uma vez só é o buraco que a régua da clínica ainda tem: abre UM alerta e,
-- se ninguém resolver, o silêncio continua para sempre sem nada aparecer de novo.
-- Esta tabela é o que permite reenviar enquanto a causa persiste, com teto.
--
-- RLS LIGADA E FORÇADA, como todas as outras. Não precisa de exceção porque o worker
-- grava DENTRO de `withClinic(clinicId)`, uma clínica por vez: a leitura cruzada é da
-- função definer acima, a escrita é por clínica. Nenhuma tabela nova fora da RLS e
-- nenhuma sétima função.
create table app.operator_notices (
  clinic_id      uuid        not null references app.clinics(id) on delete cascade,
  -- A lista é a mesma de CAUSAS_DE_OPERADOR, em packages/core. Causa nova sem passar
  -- pelos dois lados não tem teto, não tem intervalo e não tem nome nesta coluna.
  cause          text        not null check (cause in ('whatsapp_fora', 'silencio', 'qualidade')),
  -- Quando a causa apareceu, e quando o último e-mail saiu. Os dois porque "está assim
  -- há quanto tempo?" e "quando eu avisei?" são perguntas diferentes.
  first_seen_at  timestamptz not null default now(),
  last_sent_at   timestamptz not null default now(),
  sends          int         not null default 1 check (sends >= 1),
  -- Uma linha por (clínica, causa): é o que torna o teto e o intervalo contáveis sem
  -- varrer histórico.
  primary key (clinic_id, cause)
);

alter table app.operator_notices enable row level security;
alter table app.operator_notices force row level security;
create policy tenant_isolation on app.operator_notices
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert, update, delete on app.operator_notices to fliqo_app;
