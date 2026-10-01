-- =====================================================================
-- 0011 — Pontualidade: a medida que já existia vira tela, e o ajuste de
-- duração passa a ter autor.
--
-- A 0002 criou duas views e ninguém nunca as leu por fora do cálculo de
-- atraso: `professional_punctuality` (quanto cada profissional começa depois
-- do horário) e `procedure_real_durations` (quanto cada procedimento dura de
-- verdade com cada profissional). Medir sem mostrar não muda nada — o dono
-- continua marcando botox de 40 minutos que leva 55, e o dia continua
-- desandando depois da terceira consulta.
--
-- Esta migração acrescenta as duas peças que faltavam para fechar o ciclo:
-- a medida POR PROCEDIMENTO (porque é o procedimento que tem cadastro) e o
-- carimbo de quem mexeu no cadastro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Quem ajustou a duração, e quando
-- ---------------------------------------------------------------------
-- Duração cadastrada é o que decide quantos pacientes cabem no dia e, por
-- consequência, quanto a clínica fatura. Mudança dessas sem autor é a
-- discussão de segunda-feira que não tem resposta: "quem encurtou a limpeza?".
--
-- Os dois campos são inseparáveis, pela mesma razão do carimbo do 0009: valor
-- sem data não diz se é de hoje ou de dois anos atrás, e data sem autor não
-- responde a pergunta que a clínica vai fazer. O check faz o par existir junto
-- ou não existir — não há terceiro estado para alguém interpretar.
--
-- Nulo nos dois é o cadastro original, nunca ajustado. É o estado da maioria
-- das linhas e não quer dizer que faltou informação.
alter table app.procedures
  add column duration_updated_at timestamptz,
  add column duration_updated_by uuid,
  add constraint duracao_carimbada check (
    (duration_updated_by is null) = (duration_updated_at is null)
  );

-- ---------------------------------------------------------------------
-- A duração real POR PROCEDIMENTO
-- ---------------------------------------------------------------------
-- A view da 0002 agrupa por profissional E procedimento, e está certa para o
-- que faz: a Linha do Dia projeta a agenda de UMA pessoa, então a duração que
-- interessa lá é a daquela pessoa.
--
-- Aqui a pergunta é outra. O ajuste altera `procedures.duration_minutes`, que
-- é da clínica inteira e vale para todo profissional. Sugerir a partir da
-- mediana de um profissional só seria propor que a clínica reorganize o dia de
-- todos por causa do ritmo de um. E a mediana das medianas não é a mediana: com
-- uma profissional rápida e três lentos, a conta sai do lado errado.
--
-- Então a amostra desta view é o procedimento, atravessando a equipe. Mesma
-- janela de 90 dias da 0002, de propósito: duração de procedimento muda com
-- técnica e equipamento, e ano passado não descreve o mês que vem.
create view app.procedure_real_durations_by_procedure
with (security_invoker = true) as
select a.clinic_id,
       a.procedure_id,
       p.name                                                             as procedure_name,
       p.duration_minutes                                                 as scheduled_minutes,
       p.duration_updated_at,
       count(*)::int                                                      as sample_size,
       percentile_cont(0.5) within group (
         order by extract(epoch from (a.finished_at - a.started_at)) / 60) as median_minutes
  from app.appointments a
  join app.procedures p on p.id = a.procedure_id
 where a.status = 'realizado'
   and a.started_at is not null
   and a.finished_at is not null
   and a.started_at > now() - interval '90 days'
 group by a.clinic_id, a.procedure_id, p.name, p.duration_minutes, p.duration_updated_at;

comment on view app.procedure_real_durations_by_procedure is
  'Mediana real por procedimento, atravessando a equipe. Alimenta a sugestão de ajuste de cadastro, que vale para todo profissional.';

grant select on app.procedure_real_durations_by_procedure to fliqo_app;
