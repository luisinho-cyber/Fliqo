-- =====================================================================
-- 0008 — qualificação do lead, uma linha por conversa
--
-- O que a recepção sabe sobre quem está do outro lado e a agenda não guarda:
-- o que a pessoa quer, quanto está disposta a gastar e a leitura de quem
-- atendeu. Hoje isso vive na cabeça de quem respondeu e some quando essa
-- pessoa sai de férias.
--
-- Quem escreve é a recepção, pelo painel. A assistente NÃO escreve aqui: ela
-- ganha a ferramenta em revisão própria, junto com o validarChamada dela.
--
-- Origem, convênio e urgência não moram aqui: são derivados do que já existe
-- (quem escreveu primeiro na conversa, os convênios do perfil da clínica, o
-- motivo do handover) e montados na leitura. Guardar cópia deles seria criar
-- uma segunda verdade que envelhece sozinha.
--
-- LGPD: estas linhas são dado sobre paciente. Quando a política de retenção,
-- exportação e exclusão virar código, esta tabela entra nela junto com
-- patients, messages e conversations.
-- =====================================================================

-- As outras tabelas do schema têm `unique (clinic_id, id)`; conversations não
-- tinha. É essa unicidade que permite a chave estrangeira composta abaixo, que
-- é o que torna impossível apontar para conversa de outra clínica.
alter table app.conversations add constraint conversations_clinic_id_id_key unique (clinic_id, id);

create table app.lead_qualifications (
  conversation_id  uuid primary key references app.conversations(id) on delete cascade,
  clinic_id        uuid not null references app.clinics(id) on delete cascade,
  -- Texto curto escrito por gente: "harmonização", "clareamento para o casamento".
  interest         text check (interest is null or length(interest) <= 200),
  -- RÓTULO, não dinheiro: nenhuma conta sai daqui, nada vira centavo nem float
  -- (CLAUDE.md, regra 1). Serve para priorizar retorno, não para cobrar.
  --
  -- Sete faixas, com folga de propósito. Migração é só de acréscimo, então cada
  -- faixa nova depois é uma migração — e lista apertada não faz a recepção
  -- desistir, faz ela escrever o orçamento dentro de `note`, que é mil
  -- caracteres de texto livre sobre paciente. Pior para retenção, pior para
  -- exportação, pior para qualquer conta que se queira fazer depois.
  --
  -- Os cortes seguem o que uma clínica cobra de verdade: limpeza na primeira
  -- faixa, clareamento na segunda, harmonização e implante avulso no meio,
  -- reabilitação oral nas duas últimas.
  budget_band      text check (budget_band in (
                     'nao_informado',
                     'ate_500',
                     'de_500_a_1k',
                     'de_1k_a_3k',
                     'de_3k_a_10k',
                     'de_10k_a_30k',
                     'acima_30k')),
  -- A leitura de quem atendeu. Nunca conteúdo copiado da conversa.
  note             text check (note is null or length(note) <= 1000),
  -- Quem editou por último: o `sub` do JWT, não o que o navegador mandou.
  --
  -- Sem chave estrangeira de propósito por ora: o usuário mora no Supabase Auth,
  -- fora deste schema, e não há para onde apontar. Quando existir log de
  -- auditoria, este campo precisa passar a apontar para algo que continue
  -- existindo depois que a pessoa sair da clínica — e vai faltar um `created_at`
  -- para saber quando a qualificação nasceu, que hoje `updated_at` esconde a
  -- cada edição. Anotado em docs/OPERACAO.md.
  updated_by       uuid,
  updated_at       timestamptz not null default now(),
  foreign key (clinic_id, conversation_id) references app.conversations (clinic_id, id)
);

alter table app.lead_qualifications enable row level security;
alter table app.lead_qualifications force row level security;
create policy tenant_isolation on app.lead_qualifications
  using (clinic_id = app.clinic_id()) with check (clinic_id = app.clinic_id());
grant select, insert, update, delete on app.lead_qualifications to fliqo_app;
