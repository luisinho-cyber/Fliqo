import { applyBp, assertCents, BP_100, splitEven, type BasisPoints, type Cents } from './dinheiro';

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

/** Probabilidade de comparecimento por status, em bp. */
export interface TaxasComparecimento {
  confirmadoBp: BasisPoints;
  agendadoBp: BasisPoints;
  emRiscoBp: BasisPoints;
}

/**
 * Taxas da DEMONSTRAÇÃO. Números inventados, e o nome diz isso.
 *
 * A demo é um protótipo de venda com agenda fabricada: ali tudo é invenção, inclusive
 * estas taxas, e isso é honesto porque nada na demo é da clínica de ninguém.
 *
 * O caixa de verdade NÃO usa isto, e é a diferença que importa. Um número com cara de
 * medida e origem inventada é o pior defeito possível numa tela de dinheiro: ele não
 * quebra teste, continua plausível para sempre, e quem descobre é o dono conferindo
 * contra o extrato no fim do mês — e aí ele perde a confiança na tela inteira, não só
 * nesse número. Quem alimenta o caixa é `chanceDeComparecer`, com o histórico da clínica
 * e piso de amostra. Há teste que impede esta constante de voltar para lá.
 */
export const TAXAS_DA_DEMONSTRACAO: TaxasComparecimento = {
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
  taxas: TaxasComparecimento = TAXAS_DA_DEMONSTRACAO,
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

// ---------------------------------------------------------------------------
// A chance de comparecer sai do histórico da clínica, nunca de uma constante
// ---------------------------------------------------------------------------

/**
 * Os dois grupos em que a chance de comparecer é medida.
 *
 * Por que DOIS, e não um por status: a chance de uma consulta virar dinheiro depende de
 * ela estar confirmada, e isso nós sabemos medir — `appointments.confirmed_at` é gravado.
 * O que NÃO sabemos medir é a diferença entre `agendado` e `em_risco`, porque não
 * guardamos histórico de status: uma consulta que esteve em risco e foi atendida termina
 * como `realizado`, igual a uma que nunca entrou em risco.
 *
 * Então são dois grupos, e isso é uma perda de granularidade em relação às três
 * constantes inventadas que estavam aqui antes — uma perda que vale, porque um número
 * medido e grosso é defensável e um número fino e inventado não é.
 */
export type GrupoDeComparecimento = 'confirmada' | 'sem_confirmacao';

/** Em qual grupo uma consulta da agenda de hoje cai. */
export function grupoDa(status: StatusNoCaixa): GrupoDeComparecimento | undefined {
  if (status === 'confirmado') return 'confirmada';
  if (status === 'agendado' || status === 'em_risco') return 'sem_confirmacao';
  // Realizada, faltou e cancelada já têm desfecho: não há chance a estimar.
  return undefined;
}

export interface AmostraDeComparecimento {
  /**
   * Consultas PASSADAS do grupo. Inclui as canceladas de propósito: a pergunta é "esta
   * consulta vira dinheiro?", e cancelar também é não virar. Tirar as canceladas do
   * denominador inflaria o esperado exatamente nas clínicas que mais cancelam.
   */
  total: number;
  /** Quantas viraram atendimento realizado. */
  compareceram: number;
}

export interface HistoricoDeComparecimento {
  confirmada: AmostraDeComparecimento;
  sem_confirmacao: AmostraDeComparecimento;
  /** Dias de janela que produziram a amostra. A tela precisa dizer isso. */
  janelaDias: number;
}

/**
 * Piso de amostra para a taxa de comparecimento.
 *
 * Trinta, e não os oito de `sugerirDuracao`: os números medem coisas diferentes. Oito
 * atendimentos dão uma mediana de duração utilizável porque a mediana ignora o caso fora
 * da curva. Uma PROPORÇÃO com oito amostras pula 12,5 pontos a cada falta — e uma taxa
 * que anda 12 pontos por evento não é uma taxa, é ruído com casa decimal.
 *
 * Com trinta, uma falta move a taxa em 3,3 pontos. É o ponto em que o número aguenta
 * ser mostrado ao dono e defendido por ele.
 */
export const AMOSTRA_MINIMA_DE_COMPARECIMENTO = 30;

export type ChanceDeComparecer =
  | { ha: true; bp: BasisPoints; amostra: number }
  | { ha: false; motivo: 'amostra_pequena'; amostra: number };

/**
 * A taxa de um grupo, ou a recusa de estimar.
 *
 * Abaixo do piso NÃO multiplica: clínica nova com doze consultas não tem taxa, tem ruído,
 * e multiplicar por ruído produz um número com cara de projeção. A tela mostra o marcado
 * e diz que ainda não há histórico.
 */
export function chanceDeComparecer(
  amostra: AmostraDeComparecimento,
  minimo: number = AMOSTRA_MINIMA_DE_COMPARECIMENTO,
): ChanceDeComparecer {
  if (amostra.total < minimo) {
    return { ha: false, motivo: 'amostra_pequena', amostra: amostra.total };
  }
  // Inteiro em basis points: dinheiro e percentual não passam por float (CLAUDE.md).
  const bp = Math.round((amostra.compareceram * BP_100) / amostra.total);
  return { ha: true, bp, amostra: amostra.total };
}

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
  /** `null` quando não há histórico para projetar. Nunca um palpite. */
  esperadoCents: Cents | null;
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

/**
 * De onde veio o esperado — e esta é a parte que a tela TEM de dizer.
 *
 * Número sem procedência numa tela de dinheiro é número que o dono não pode defender
 * para o sócio. A frase da tela sai daqui: quantos atendimentos entraram na conta e de
 * quantos dias.
 */
export type ProcedenciaDoEsperado =
  | {
      ha: true;
      /** Atendimentos passados que produziram as taxas. */
      amostra: number;
      janelaDias: number;
      /** A taxa de cada grupo usado no período, em bp, para quem quiser conferir. */
      porGrupo: Partial<Record<GrupoDeComparecimento, BasisPoints>>;
    }
  | {
      ha: false;
      motivo: 'sem_historico';
      /** O que existe hoje, e o que falta. A tela diz os dois. */
      amostra: number;
      minimo: number;
    };

export interface ResumoDoCaixa {
  consultas: number;
  marcadoCents: Cents;
  /**
   * `null` quando a clínica ainda não tem histórico de comparecimento suficiente.
   *
   * Nulo e não "igual ao marcado": igualar esconderia a diferença entre "nada vai se
   * perder" e "não sei dizer", que são coisas opostas para quem está decidindo.
   */
  esperadoCents: Cents | null;
  realizadoCents: Cents;
  procedencia: ProcedenciaDoEsperado;
  /** O que a falta custou no período: o mesmo número de `custoDasFaltas`. */
  faltas: { quantidade: number; valor: Cents };
  semPreco: SemPrecoCadastrado;
  porProfissional: LinhaDoCaixa[];
  porProcedimento: LinhaDoCaixa[];
}

/**
 * Valor ESPERADO de uma consulta, dado o que a clínica mediu.
 *
 * Realizada vale o preço cheio — já aconteceu, não há chance a ponderar. Faltou e
 * cancelada valem zero, pelo mesmo motivo ao contrário. Só o que ainda vai acontecer
 * precisa de taxa, e é por isso que um período inteiramente PASSADO não exige histórico
 * nenhum: o desfecho de cada consulta dele já é conhecido.
 */
function esperadoDa(
  c: ConsultaNoCaixa,
  taxaDoGrupo: ReadonlyMap<GrupoDeComparecimento, BasisPoints>,
): Cents {
  if (c.status === 'realizado') return c.preco;
  const grupo = grupoDa(c.status);
  if (grupo === undefined) return 0;
  const bp = taxaDoGrupo.get(grupo);
  // Sem taxa do grupo não se chega aqui: `resumirCaixa` já devolveu esperado nulo.
  return bp === undefined ? 0 : applyBp(c.preco, bp);
}

/**
 * Acumulador interno: aqui o esperado é sempre número.
 *
 * O `null` é decisão de SAÍDA — "não sei dizer" —, e misturá-lo na soma obrigaria cada
 * acumulação a escolher entre tratar nulo como zero ou propagá-lo, que são dois jeitos
 * diferentes de errar. Quem apaga a coluna é `apagarEsperado`, uma vez, no fim.
 */
type LinhaAcumulada = Omit<LinhaDoCaixa, 'esperadoCents'> & { esperadoCents: Cents };

function somar(
  linhas: Map<string, LinhaAcumulada>,
  id: string,
  v: Omit<LinhaAcumulada, 'id'>,
): void {
  const atual: LinhaAcumulada = linhas.get(id) ?? {
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
 * Duas coisas que a assinatura impõe:
 *
 * O histórico é PARÂMETRO, e não tem padrão. Antes havia `taxas = TAXAS_PADRAO`, e aquele
 * padrão era o defeito: quem chamasse sem pensar recebia um esperado inventado com cara de
 * medida. Agora quem chama tem de entregar o histórico da clínica, ou dizer `undefined` e
 * aceitar que não há esperado.
 *
 * O arredondamento é POR CONSULTA, e não no total: é assim que as linhas por profissional
 * e por procedimento somam exatamente o total da manchete. Arredondar o agregado faria a
 * tabela não fechar com a frase acima dela, e uma tabela de dinheiro que não fecha é pior
 * do que nenhuma tabela.
 */
export function resumirCaixa(
  consultas: readonly ConsultaNoCaixa[],
  historico?: HistoricoDeComparecimento,
  minimoDeAmostra: number = AMOSTRA_MINIMA_DE_COMPARECIMENTO,
): ResumoDoCaixa {
  const consideradas = consultas.filter((c) => c.status !== 'cancelado' && c.precoCadastrado);

  /*
   * Só os grupos que o período USA precisam de histórico.
   *
   * Uma semana inteiramente passada não tem consulta em aberto, então não consome taxa
   * nenhuma e o esperado é exato sem histórico. E uma clínica que nunca deixa consulta sem
   * confirmar não deve perder a projeção por falta de amostra num grupo que ela não usa.
   */
  const gruposUsados = new Set<GrupoDeComparecimento>();
  for (const c of consideradas) {
    const grupo = grupoDa(c.status);
    if (grupo !== undefined) gruposUsados.add(grupo);
  }

  const taxaDoGrupo = new Map<GrupoDeComparecimento, BasisPoints>();
  const faltando: ChanceDeComparecer[] = [];
  for (const grupo of gruposUsados) {
    const chance =
      historico === undefined
        ? ({ ha: false, motivo: 'amostra_pequena', amostra: 0 } as const)
        : chanceDeComparecer(historico[grupo], minimoDeAmostra);
    if (chance.ha) taxaDoGrupo.set(grupo, chance.bp);
    else faltando.push(chance);
  }

  const semEsperado = faltando.length > 0;
  const procedencia: ProcedenciaDoEsperado = semEsperado
    ? {
        ha: false,
        motivo: 'sem_historico',
        // A MENOR amostra entre as que faltam: é a que a clínica precisa crescer.
        amostra: Math.min(...faltando.map((f) => f.amostra)),
        minimo: minimoDeAmostra,
      }
    : {
        ha: true,
        amostra: amostraUsada(historico, gruposUsados),
        janelaDias: historico?.janelaDias ?? 0,
        porGrupo: Object.fromEntries(taxaDoGrupo),
      };

  const porProfissional = new Map<string, LinhaAcumulada>();
  const porProcedimento = new Map<string, LinhaAcumulada>();
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

    const m = CONTAM_COMO_MARCADO.includes(c.status) ? c.preco : 0;
    const e = semEsperado ? 0 : esperadoDa(c, taxaDoGrupo);
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

  const maiorMarcadoPrimeiro = (a: LinhaAcumulada, b: LinhaAcumulada) =>
    b.marcadoCents - a.marcadoCents;
  // Sem histórico, a coluna não existe — nem no total, nem nas linhas. Zerar seria dizer
  // "nada vai entrar", e igualar ao marcado seria dizer "tudo vai entrar".
  const apagarEsperado = (l: LinhaAcumulada): LinhaDoCaixa =>
    semEsperado ? { ...l, esperadoCents: null } : l;

  return {
    consultas: total,
    marcadoCents: marcado,
    esperadoCents: semEsperado ? null : esperado,
    realizadoCents: realizado,
    procedencia,
    faltas: custoDasFaltas(faltas),
    semPreco: {
      consultas: consultasSemPreco,
      procedimentos: semPreco.size,
      procedimentoIds: [...semPreco].sort(),
    },
    porProfissional: [...porProfissional.values()].sort(maiorMarcadoPrimeiro).map(apagarEsperado),
    porProcedimento: [...porProcedimento.values()].sort(maiorMarcadoPrimeiro).map(apagarEsperado),
  };
}

/** A amostra que sustenta a projeção: a soma dos grupos que o período realmente usa. */
function amostraUsada(
  historico: HistoricoDeComparecimento | undefined,
  grupos: ReadonlySet<GrupoDeComparecimento>,
): number {
  if (historico === undefined) return 0;
  let n = 0;
  for (const grupo of grupos) n += historico[grupo].total;
  return n;
}
