import { applyBp, assertCents, splitEven, type BasisPoints, type Cents } from './dinheiro';

export interface FormaDePagamento {
  nome: string; // 'Pix', 'Crédito 3x', 'Convênio Amil'
  taxaBp: BasisPoints; // taxa da maquininha / operadora
  diasParaReceber: number; // D+N da primeira parcela
  parcelas: number; // 1 = à vista
}

export interface LancamentoCaixa {
  tipo: 'receita' | 'despesa';
  status: 'previsto' | 'realizado';
  categoria: 'procedimento' | 'taxa_pagamento' | 'comissao' | 'insumo';
  descricao: string;
  valor: Cents;
  vencimento: string; // AAAA-MM-DD (data local da clínica)
  parcela?: number;
}

export interface Atendimento {
  procedimento: string;
  preco: Cents; // snapshot gravado na consulta
  custoInsumos: Cents;
  comissaoBp: BasisPoints;
  data: string; // AAAA-MM-DD do atendimento
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`); // meio-dia UTC: imune a horário de verão
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay)); // 31/01 + 1 mês = 28 ou 29/02
  return target.toISOString().slice(0, 10);
}

/**
 * Atendimento realizado -> lançamentos no fluxo de caixa.
 * Receita bruta nas datas em que o dinheiro CAI (não na data da consulta),
 * taxa e comissão como despesas separadas, para o dono ver o custo de cada forma de pagamento.
 */
export function lancamentosDoAtendimento(a: Atendimento, fp: FormaDePagamento): LancamentoCaixa[] {
  assertCents(a.preco, 'preço');
  assertCents(a.custoInsumos, 'insumos');
  const out: LancamentoCaixa[] = [];
  const parcelas = splitEven(a.preco, fp.parcelas);
  const primeira = addDays(a.data, fp.diasParaReceber);

  parcelas.forEach((valor, i) => {
    const vencimento = addMonths(primeira, i);
    out.push({
      tipo: 'receita',
      status: 'previsto',
      categoria: 'procedimento',
      descricao:
        fp.parcelas > 1
          ? `${a.procedimento} (${i + 1}/${fp.parcelas}) — ${fp.nome}`
          : `${a.procedimento} — ${fp.nome}`,
      valor,
      vencimento,
      ...(fp.parcelas > 1 ? { parcela: i + 1 } : {}),
    });
    const taxa = applyBp(valor, fp.taxaBp);
    if (taxa > 0) {
      out.push({
        tipo: 'despesa',
        status: 'previsto',
        categoria: 'taxa_pagamento',
        descricao: `Taxa ${fp.nome}${fp.parcelas > 1 ? ` (${i + 1}/${fp.parcelas})` : ''}`,
        valor: taxa,
        vencimento,
        ...(fp.parcelas > 1 ? { parcela: i + 1 } : {}),
      });
    }
  });

  const comissao = applyBp(a.preco, a.comissaoBp);
  if (comissao > 0) {
    out.push({
      tipo: 'despesa',
      status: 'previsto',
      categoria: 'comissao',
      descricao: `Comissão — ${a.procedimento}`,
      valor: comissao,
      vencimento: a.data,
    });
  }
  if (a.custoInsumos > 0) {
    out.push({
      tipo: 'despesa',
      status: 'realizado',
      categoria: 'insumo',
      descricao: `Insumos — ${a.procedimento}`,
      valor: a.custoInsumos,
      vencimento: a.data,
    });
  }
  return out;
}

export interface ConsultaFutura {
  data: string;
  preco: Cents;
  status: 'agendado' | 'confirmado' | 'em_risco';
}

/** Probabilidade de comparecimento por status, em bp. Calibre com o histórico real da clínica. */
export interface TaxasComparecimento {
  confirmadoBp: BasisPoints;
  agendadoBp: BasisPoints;
  emRiscoBp: BasisPoints;
}

export const TAXAS_PADRAO: TaxasComparecimento = {
  confirmadoBp: 9_500,
  agendadoBp: 8_000,
  emRiscoBp: 5_000,
};

export interface DiaProjetado {
  data: string;
  entradas: Cents;
  saidas: Cents;
  receitaAgendaEsperada: Cents; // agenda × chance de comparecer (ainda não é dinheiro)
  saldoAcumulado: Cents;
}

/**
 * Fluxo de caixa projetado: lançamentos já previstos + receita esperada da agenda.
 * A agenda entra pelo valor ESPERADO (preço × probabilidade de comparecer), não pelo valor cheio —
 * é isso que diferencia de uma planilha que conta toda consulta marcada como dinheiro no bolso.
 */
export function projetarFluxo(
  saldoInicial: number,
  lancamentos: Pick<LancamentoCaixa, 'tipo' | 'valor' | 'vencimento'>[],
  agenda: ConsultaFutura[],
  inicio: string,
  dias: number,
  taxas: TaxasComparecimento = TAXAS_PADRAO,
): DiaProjetado[] {
  const bpPorStatus = {
    confirmado: taxas.confirmadoBp,
    agendado: taxas.agendadoBp,
    em_risco: taxas.emRiscoBp,
  };
  const out: DiaProjetado[] = [];
  let saldo = saldoInicial;
  for (let i = 0; i < dias; i++) {
    const data = addDays(inicio, i);
    const doDia = lancamentos.filter((l) => l.vencimento === data);
    const entradas = doDia.filter((l) => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const saidas = doDia.filter((l) => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const receitaAgendaEsperada = agenda
      .filter((c) => c.data === data)
      .reduce((s, c) => s + applyBp(c.preco, bpPorStatus[c.status]), 0);
    saldo += entradas - saidas;
    out.push({ data, entradas, saidas, receitaAgendaEsperada, saldoAcumulado: saldo });
  }
  return out;
}

/** O número que vende o sistema: quanto as faltas custaram no período. */
export function custoDasFaltas(faltas: { preco: Cents }[]): { quantidade: number; valor: Cents } {
  return { quantidade: faltas.length, valor: faltas.reduce((s, f) => s + f.preco, 0) };
}

// ---------------------------------------------------------------------------
// O caixa do período: marcado × esperado × realizado
// ---------------------------------------------------------------------------

/**
 * A pergunta que a tela Caixa responde: quanto está marcado, quanto deve entrar de
 * verdade, e quanto já entrou. A distância entre os dois primeiros é o que a Fliqo
 * existe para fechar.
 *
 * Mora aqui, e não na rota, pelo mesmo motivo de `projetarFluxo`: é regra de negócio
 * sobre dinheiro, e dinheiro tem de ser testável sem banco.
 */

export type StatusNoCaixa =
  'agendado' | 'confirmado' | 'em_risco' | 'cancelado' | 'faltou' | 'realizado';

export interface ConsultaNoCaixa {
  profissionalId: string;
  procedimentoId: string;
  status: StatusNoCaixa;
  /** Snapshot do preço gravado na consulta. */
  preco: Cents;
  /**
   * O procedimento tem preço cadastrado?
   *
   * Preço zero tem dois significados que NÃO podem ser somados juntos: cortesia de
   * verdade (vale zero) e preço que ninguém cadastrou ainda (vale desconhecido). A
   * importação de agenda cria procedimento com zero porque o cadastro vive no outro
   * sistema; somar isso como receita esperada de R$ 0 faz a tela mentir com cara de
   * verde, que é a pior forma de errar um número de dinheiro.
   *
   * Quem não tem preço cadastrado sai das três somas e é CONTADO à parte.
   */
  precoCadastrado: boolean;
}

/**
 * `cancelado` fica fora de tudo: o horário voltou a estar livre, e consulta cancelada
 * não está marcada. `faltou` continua em `marcado` — ela ocupou a agenda, e é
 * justamente a distância entre marcado e esperado que mostra o que a falta custou.
 */
const CONTAM_COMO_MARCADO: readonly StatusNoCaixa[] = [
  'agendado',
  'confirmado',
  'em_risco',
  'realizado',
  'faltou',
];

export interface LinhaDoCaixa {
  id: string;
  consultas: number;
  marcadoCents: Cents;
  esperadoCents: Cents;
  realizadoCents: Cents;
}

export interface SemPrecoCadastrado {
  /** Quantas consultas ficaram fora das somas. */
  consultas: number;
  /** Quantos procedimentos distintos estão sem preço. É o N da frase na tela. */
  procedimentos: number;
  /** Os ids, para a tela poder levar ao cadastro de cada um. */
  procedimentoIds: string[];
}

export interface ResumoDoCaixa {
  consultas: number;
  marcadoCents: Cents;
  esperadoCents: Cents;
  realizadoCents: Cents;
  /** O que a falta custou no período: o mesmo número de `custoDasFaltas`. */
  faltas: { quantidade: number; valor: Cents };
  semPreco: SemPrecoCadastrado;
  porProfissional: LinhaDoCaixa[];
  porProcedimento: LinhaDoCaixa[];
}

/**
 * Valor ESPERADO de uma consulta.
 *
 * Realizada vale o preço cheio — já aconteceu, não há chance a ponderar. Faltou vale
 * zero, pelo mesmo motivo ao contrário. O que ainda vai acontecer vale preço × chance
 * de comparecer, que é o que separa a Fliqo de uma planilha que conta toda consulta
 * marcada como dinheiro no bolso.
 */
function esperadoDa(c: ConsultaNoCaixa, taxas: TaxasComparecimento): Cents {
  switch (c.status) {
    case 'realizado':
      return c.preco;
    case 'faltou':
    case 'cancelado':
      return 0;
    case 'confirmado':
      return applyBp(c.preco, taxas.confirmadoBp);
    case 'agendado':
      return applyBp(c.preco, taxas.agendadoBp);
    case 'em_risco':
      return applyBp(c.preco, taxas.emRiscoBp);
  }
}

function somar(linhas: Map<string, LinhaDoCaixa>, id: string, v: Omit<LinhaDoCaixa, 'id'>): void {
  const atual = linhas.get(id) ?? {
    id,
    consultas: 0,
    marcadoCents: 0,
    esperadoCents: 0,
    realizadoCents: 0,
  };
  linhas.set(id, {
    id,
    consultas: atual.consultas + v.consultas,
    marcadoCents: atual.marcadoCents + v.marcadoCents,
    esperadoCents: atual.esperadoCents + v.esperadoCents,
    realizadoCents: atual.realizadoCents + v.realizadoCents,
  });
}

/**
 * O resumo do período. Centavos inteiros do começo ao fim.
 *
 * O arredondamento é POR CONSULTA, e não no total: é assim que as linhas por
 * profissional e por procedimento somam exatamente o total da manchete. Arredondar o
 * agregado faria a tabela não fechar com a frase acima dela, e uma tabela de dinheiro
 * que não fecha é pior do que nenhuma tabela.
 */
export function resumirCaixa(
  consultas: readonly ConsultaNoCaixa[],
  taxas: TaxasComparecimento = TAXAS_PADRAO,
): ResumoDoCaixa {
  const porProfissional = new Map<string, LinhaDoCaixa>();
  const porProcedimento = new Map<string, LinhaDoCaixa>();
  const semPreco = new Set<string>();
  const faltas: { preco: Cents }[] = [];

  let total = 0;
  let marcado = 0;
  let esperado = 0;
  let realizado = 0;
  let consultasSemPreco = 0;

  for (const c of consultas) {
    assertCents(c.preco, 'preço da consulta');
    if (c.status === 'cancelado') continue;

    if (!c.precoCadastrado) {
      // Fora das somas e contada à parte: o valor dela é desconhecido, não zero.
      semPreco.add(c.procedimentoId);
      consultasSemPreco++;
      continue;
    }

    const estaMarcada = CONTAM_COMO_MARCADO.includes(c.status);
    const m = estaMarcada ? c.preco : 0;
    const e = esperadoDa(c, taxas);
    const r = c.status === 'realizado' ? c.preco : 0;

    total++;
    marcado += m;
    esperado += e;
    realizado += r;
    if (c.status === 'faltou') faltas.push({ preco: c.preco });

    const valores = { consultas: 1, marcadoCents: m, esperadoCents: e, realizadoCents: r };
    somar(porProfissional, c.profissionalId, valores);
    somar(porProcedimento, c.procedimentoId, valores);
  }

  const maiorMarcadoPrimeiro = (a: LinhaDoCaixa, b: LinhaDoCaixa) =>
    b.marcadoCents - a.marcadoCents;

  return {
    consultas: total,
    marcadoCents: marcado,
    esperadoCents: esperado,
    realizadoCents: realizado,
    faltas: custoDasFaltas(faltas),
    semPreco: {
      consultas: consultasSemPreco,
      procedimentos: semPreco.size,
      procedimentoIds: [...semPreco].sort(),
    },
    porProfissional: [...porProfissional.values()].sort(maiorMarcadoPrimeiro),
    porProcedimento: [...porProcedimento.values()].sort(maiorMarcadoPrimeiro),
  };
}
