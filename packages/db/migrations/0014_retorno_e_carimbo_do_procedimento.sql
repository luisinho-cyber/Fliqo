-- =====================================================================
-- 0014 — Retorno do procedimento, e quando o cadastro nasceu e mudou.
--
-- Aditiva: quatro colunas novas em app.procedures, uma constraint nova sobre as duas
-- primeiras, e nada mais. Nenhuma coluna existente muda de tipo, nenhuma constraint
-- antiga é alterada, nenhum dado é reescrito. Toda linha que já existe continua válida
-- pelos defaults.
--
-- NÃO MEXE EM RLS, e não precisa: `tenant_isolation` filtra por `clinic_id = app.clinic_id()`,
-- que é regra de LINHA. Coluna nova numa tabela já protegida nasce protegida — não existe
-- política por coluna aqui para esquecer de atualizar.
-- =====================================================================

alter table app.procedures
  -- O retorno é do PROCEDIMENTO, não da consulta: "harmonização pede retorno em 15 dias"
  -- é característica do que se faz, e é o cadastro que sabe. A consulta de retorno em si
  -- é uma consulta comum, marcada depois — nada aqui agenda nada.
  add column requires_followup boolean     not null default false,
  add column followup_days     int,
  -- Quando o cadastro nasceu e quando mudou pela última vez.
  --
  -- `duration_updated_at` (0011) responde "quem encurtou a limpeza?", que é uma pergunta
  -- mais estreita: ela carimba só a duração, porque só a duração tem uma sugestão
  -- automática atrás dela. Preço mudado não tem carimbo nenhum hoje, e "desde quando a
  -- limpeza custa isso?" é a primeira pergunta de quem confere o Caixa de um mês contra
  -- o extrato. `updated_at` é o mínimo que responde isso sem inventar log de auditoria.
  --
  -- `default now()` nas linhas que já existem é uma mentira pequena e assumida: elas vão
  -- dizer que nasceram no dia da migração. A alternativa seria deixar nulo e tratar nulo
  -- em toda leitura, para um dado que ninguém tem como recuperar de qualquer forma.
  add column created_at        timestamptz not null default now(),
  add column updated_at        timestamptz not null default now();

-- Os dois campos de retorno andam juntos ou não andam.
--
-- Sem isto, `requires_followup = true` com `followup_days` nulo passa, e a tela tem de
-- decidir o que mostrar para "pede retorno em (nada)". E `followup_days = 30` com
-- `requires_followup = false` passa também, e aí existem dois jeitos de dizer a mesma
-- coisa — que é como um relatório futuro acaba contando metade dos retornos.
--
-- Teto de 365 dias: mais do que um ano não é retorno de procedimento, é lembrete de
-- recall, que é outro assunto e vai ter outra régua.
--
-- `case` e não `(A and B) or (C and D)`, e a diferença NÃO é de estilo. Com
-- `requires_followup = true` e `followup_days` nulo, a primeira metade vira
-- `true and (null between 1 and 365)`, que é NULL; a segunda vira false; e `null or false`
-- é NULL — e CHECK que resulta em NULL PASSA. A versão com `or` aceitava calado exatamente
-- o estado que esta constraint existe para proibir. Quem pegou foi o teste que insere o par
-- inconsistente direto pelo dono do schema.
alter table app.procedures
  add constraint procedures_followup_check check (
    case
      when requires_followup then followup_days is not null and followup_days between 1 and 365
      else followup_days is null
    end
  );
