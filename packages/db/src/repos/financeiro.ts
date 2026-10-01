import { sql, type Insertable, type Selectable } from 'kysely';
import type { StatusConsulta, TabelaCaixa } from '../schema';
import type { Trx } from '../withClinic';

export type Lancamento = Selectable<TabelaCaixa>;

export interface LancamentoNovo {
  tipo: 'receita' | 'despesa';
  status: 'previsto' | 'realizado' | 'cancelado';
  categoria: string;
  descricao: string;
  valorCentavos: number;
  vencimento: Date;
  consultaId?: string;
  parcela?: number;
}

function paraLinha(clinicId: string, l: LancamentoNovo): Insertable<TabelaCaixa> {
  return {
    clinic_id: clinicId,
    kind: l.tipo,
    status: l.status,
    category: l.categoria,
    description: l.descricao,
    amount_cents: l.valorCentavos,
    due_date: l.vencimento,
    appointment_id: l.consultaId ?? null,
    installment_no: l.parcela ?? null,
  };
}

/**
 * Grava os lançamentos de um atendimento de uma vez só. `lancamentosDoAtendimento`
 * de packages/core é quem calcula receita, taxa, comissão e insumo; aqui só persiste.
 */
export async function lancar(
  trx: Trx,
  clinicId: string,
  lancamentos: LancamentoNovo[],
): Promise<Lancamento[]> {
  if (lancamentos.length === 0) return [];
  return trx
    .insertInto('app.cash_entries')
    .values(lancamentos.map((l) => paraLinha(clinicId, l)))
    .returningAll()
    .execute();
}

export async function listarPorPeriodo(trx: Trx, de: Date, ate: Date): Promise<Lancamento[]> {
  return trx
    .selectFrom('app.cash_entries')
    .selectAll()
    .where('due_date', '>=', de)
    .where('due_date', '<=', ate)
    .where('status', '<>', 'cancelado')
    .orderBy('due_date')
    .execute();
}

export interface ConsultaDoCaixa {
  professional_id: string;
  profissional: string;
  procedure_id: string;
  procedimento: string;
  status: StatusConsulta;
  precoCents: number;
  precoCadastrado: boolean;
}

/**
 * As consultas do período, com o que o caixa precisa saber de cada uma.
 *
 * `precoCadastrado` olha a origem do procedimento E o snapshot da consulta:
 * `importado` com snapshot zero é preço que ninguém cadastrou, porque o cadastro vive
 * no outro sistema (0012). Cortesia de verdade tem origem `cadastro` e vale zero.
 *
 * O critério é no SNAPSHOT e não só no procedimento de propósito: se a clínica
 * cadastrar o preço depois, as consultas novas passam a contar, e as antigas continuam
 * valendo desconhecido — porque é isso que elas são. Inventar o preço de hoje para uma
 * consulta de março seria somar um número que ninguém cobrou.
 *
 * O preço somado é sempre o snapshot da consulta, nunca o preço atual do procedimento:
 * mudar a tabela não altera o passado (0001).
 */
export async function consultasDoPeriodo(
  trx: Trx,
  de: Date,
  ate: Date,
): Promise<ConsultaDoCaixa[]> {
  const linhas = await trx
    .selectFrom('app.appointments as a')
    .innerJoin('app.professionals as pr', 'pr.id', 'a.professional_id')
    .innerJoin('app.procedures as p', 'p.id', 'a.procedure_id')
    .select([
      'a.professional_id',
      'pr.name as profissional',
      'a.procedure_id',
      'p.name as procedimento',
      'a.status',
      'a.price_cents',
      'p.source as origem_do_procedimento',
    ])
    .where('a.starts_at', '>=', de)
    .where('a.starts_at', '<', ate)
    .execute();

  return linhas.map((l) => ({
    professional_id: l.professional_id,
    profissional: l.profissional,
    procedure_id: l.procedure_id,
    procedimento: l.procedimento,
    status: l.status,
    // bigint chega como string do driver; o Number é seguro porque centavos de uma
    // consulta cabem muito dentro do inteiro seguro.
    precoCents: Number(l.price_cents),
    precoCadastrado: !(l.origem_do_procedimento === 'importado' && Number(l.price_cents) === 0),
  }));
}

/**
 * Janela do histórico de comparecimento.
 *
 * Noventa dias, os mesmos das views de duração (0002/0011): comportamento de clínica muda
 * com régua de confirmação, com equipe e com bairro, e o ano passado não descreve o mês que
 * vem. Mesma janela em todo o produto para que dois números da mesma tela não falem de
 * períodos diferentes.
 */
export const JANELA_DO_HISTORICO_DIAS = 90;

/**
 * A taxa de comparecimento medida da clínica, por grupo.
 *
 * Só consultas com DESFECHO entram: `realizado`, `faltou` ou `cancelado`. Uma consulta de
 * três dias atrás ainda em `agendado` não é uma falta — é uma consulta que a recepção não
 * marcou, e contá-la como não comparecimento rebaixaria a taxa por desleixo de registro em
 * vez de por comportamento de paciente.
 *
 * O grupo vem de `confirmed_at`, que é o que o banco guarda. Não existe histórico de
 * status, então não há como medir `em_risco` separado de `agendado` — e inventar essa
 * diferença é exatamente o que esta função existe para não fazer.
 *
 * Uma honestidade a registrar: a taxa mede o que a clínica REGISTRA. Clínica que nunca
 * marca falta aparece com taxa alta. Isso não tem conserto aqui; tem na tela Hoje, que é
 * onde o toque de "faltou" acontece.
 */
export async function historicoDeComparecimento(
  trx: Trx,
  agora: Date,
  janelaDias = JANELA_DO_HISTORICO_DIAS,
): Promise<{ confirmada: Amostra; sem_confirmacao: Amostra; janelaDias: number }> {
  const de = new Date(agora.getTime() - janelaDias * 86_400_000);
  const r = await sql<{ confirmada: boolean; total: string; compareceram: string }>`
    select (a.confirmed_at is not null) as confirmada,
           count(*)                                            as total,
           count(*) filter (where a.status = 'realizado')       as compareceram
      from app.appointments a
     where a.starts_at >= ${de}
       and a.starts_at < ${agora}
       and a.status in ('realizado', 'faltou', 'cancelado')
     group by 1
  `.execute(trx);

  const vazia: Amostra = { total: 0, compareceram: 0 };
  const saida = { confirmada: { ...vazia }, sem_confirmacao: { ...vazia }, janelaDias };
  for (const linha of r.rows) {
    const grupo = linha.confirmada ? 'confirmada' : 'sem_confirmacao';
    saida[grupo] = { total: Number(linha.total), compareceram: Number(linha.compareceram) };
  }
  return saida;
}

interface Amostra {
  total: number;
  compareceram: number;
}
