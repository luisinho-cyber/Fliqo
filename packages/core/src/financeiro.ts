import { applyBp, assertCents, splitEven, type BasisPoints, type Cents } from './dinheiro';

export interface FormaDePagamento {
  nome: string;             // 'Pix', 'Crédito 3x', 'Convênio Amil'
  taxaBp: BasisPoints;      // taxa da maquininha / operadora
  diasParaReceber: number;  // D+N da primeira parcela
  parcelas: number;         // 1 = à vista
}

export interface LancamentoCaixa {
  tipo: 'receita' | 'despesa';
  status: 'previsto' | 'realizado';
  categoria: 'procedimento' | 'taxa_pagamento' | 'comissao' | 'insumo';
  descricao: string;
  valor: Cents;
  vencimento: string;       // AAAA-MM-DD (data local da clínica)
  parcela?: number;
}

export interface Atendimento {
  procedimento: string;
  preco: Cents;             // snapshot gravado na consulta
  custoInsumos: Cents;
  comissaoBp: BasisPoints;
  data: string;             // AAAA-MM-DD do atendimento
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`); // meio-dia UTC: imune a horário de verão
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
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
      descricao: fp.parcelas > 1 ? `${a.procedimento} (${i + 1}/${fp.parcelas}) — ${fp.nome}` : `${a.procedimento} — ${fp.nome}`,
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
    out.push({ tipo: 'despesa', status: 'previsto', categoria: 'comissao', descricao: `Comissão — ${a.procedimento}`, valor: comissao, vencimento: a.data });
  }
  if (a.custoInsumos > 0) {
    out.push({ tipo: 'despesa', status: 'realizado', categoria: 'insumo', descricao: `Insumos — ${a.procedimento}`, valor: a.custoInsumos, vencimento: a.data });
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

export const TAXAS_PADRAO: TaxasComparecimento = { confirmadoBp: 9_500, agendadoBp: 8_000, emRiscoBp: 5_000 };

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
  const bpPorStatus = { confirmado: taxas.confirmadoBp, agendado: taxas.agendadoBp, em_risco: taxas.emRiscoBp };
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
