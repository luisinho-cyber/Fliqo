import {
  custoDasFaltas,
  decidirAvisos,
  formatBRL,
  lancamentosDoAtendimento,
  planejarOferta,
  pontualidade,
  projetarDia,
  projetarFluxo,
  sugerirDuracao,
  TAXAS_PADRAO,
  type Aviso,
  type ConsultaDoDia,
  type LancamentoCaixa,
  type PrevisaoConsulta,
  type TaxasComparecimento,
} from '@fliqo/core';
import {
  CONFIG_FILA,
  DURACOES_REAIS,
  FALTAS_DO_MES,
  FORMA_DE_PAGAMENTO,
  PROCEDIMENTOS,
  RITMO_DA_SEMANA,
  type ConsultaDemo,
} from './dados';

/**
 * A ponte entre o seed fictício e as funções de verdade de packages/core.
 *
 * Nada aqui recalcula regra de negócio. Este arquivo só traduz o formato do seed
 * para o formato que o core espera e devolve o resultado — se a regra mudar no
 * core, a demonstração muda junto, que é o ponto de usar a lógica real.
 */

/**
 * Relógio fixo: 11:12 de hoje. A demonstração precisa ser a mesma em toda
 * apresentação, e às 11:12 a Dra. Ana já acumulou o atraso que a cena 4 mostra.
 */
export function agora(): Date {
  const d = new Date();
  d.setHours(11, 12, 0, 0);
  return d;
}

export function emHoje(hhmm: string, diasAFrente = 0): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = new Date();
  d.setDate(d.getDate() + diasAFrente);
  d.setHours(h, m, 0, 0);
  return d;
}

export function hhmm(d: Date): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function brl(centavos: number): string {
  return formatBRL(centavos);
}

/**
 * A agenda está errada neste procedimento? Quem responde é sugerirDuracao, com a
 * amostra crua das durações medidas.
 */
export function sugestaoDeDuracao(procedimentoId: string) {
  const agenda = PROCEDIMENTOS[procedimentoId]?.duracaoAgendaMin ?? 30;
  return sugerirDuracao(DURACOES_REAIS[procedimentoId] ?? [], agenda);
}

/** Duração que o dia leva de verdade: a medida, quando o core diz que vale trocar. */
export function duracaoEsperada(procedimentoId: string): number {
  const agenda = PROCEDIMENTOS[procedimentoId]?.duracaoAgendaMin ?? 30;
  const s = sugestaoDeDuracao(procedimentoId);
  return s.sugerir ? s.medianaMin : agenda;
}

function paraCore(c: ConsultaDemo): ConsultaDoDia {
  const dias = c.dia === 'hoje' ? 0 : 1;
  const inicio = emHoje(c.horaAgendada, dias);
  const duracaoAgenda = PROCEDIMENTOS[c.procedimentoId]?.duracaoAgendaMin ?? 30;
  return {
    id: c.id,
    inicioAgendado: inicio,
    fimAgendado: new Date(inicio.getTime() + duracaoAgenda * 60_000),
    duracaoEsperadaMin: duracaoEsperada(c.procedimentoId),
    status: c.status,
    ...(c.chegouEm === undefined ? {} : { pacienteChegouEm: emHoje(c.chegouEm, dias) }),
    ...(c.iniciadaEm === undefined ? {} : { iniciadaEm: emHoje(c.iniciadaEm, dias) }),
    ...(c.finalizadaEm === undefined ? {} : { finalizadaEm: emHoje(c.finalizadaEm, dias) }),
  };
}

export function consultasDoDia(
  consultas: ConsultaDemo[],
  dia: 'hoje' | 'amanha',
  profissionalId: string,
): ConsultaDemo[] {
  return consultas
    .filter((c) => c.dia === dia && c.profissionalId === profissionalId)
    .sort((a, b) => a.horaAgendada.localeCompare(b.horaAgendada));
}

/** Efeito cascata do dia, direto de projetarDia. */
export function previsaoDoDia(
  consultas: ConsultaDemo[],
  dia: 'hoje' | 'amanha',
  profissionalId: string,
  momento = agora(),
): Map<string, PrevisaoConsulta> {
  const doDia = consultasDoDia(consultas, dia, profissionalId).map(paraCore);
  return new Map(projetarDia(doDia, momento).map((p) => [p.id, p]));
}

/** Quem avisar agora, direto de decidirAvisos. */
export function avisosDoDia(
  consultas: ConsultaDemo[],
  profissionalId: string,
  jaAvisado: ReadonlyMap<string, number> = new Map(),
  momento = agora(),
): Aviso[] {
  const doDia = consultasDoDia(consultas, 'hoje', profissionalId).map(paraCore);
  const previsao = projetarDia(doDia, momento);
  return decidirAvisos(doDia, previsao, jaAvisado, momento);
}

/** Pontualidade do dia de um profissional, direto de pontualidade. */
export function pontualidadeDoDia(
  consultas: ConsultaDemo[],
  profissionalId: string,
  momento = agora(),
) {
  const finalizadas = [
    ...previsaoDoDia(consultas, 'hoje', profissionalId, momento).values(),
  ].filter((p) => p.situacao === 'finalizada');
  return pontualidade(finalizadas);
}

/** Dá tempo de oferecer a vaga? Quem responde é planejarOferta. */
export function planoDaVaga(inicioDaVaga: Date, momento = agora()) {
  return planejarOferta(CONFIG_FILA, inicioDaVaga, momento);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Lançamentos de tudo que já foi realizado, direto de lancamentosDoAtendimento. */
export function lancamentosRealizados(consultas: ConsultaDemo[]): LancamentoCaixa[] {
  const hoje = iso(new Date());
  return consultas
    .filter((c) => c.status === 'realizado')
    .flatMap((c) => {
      const p = PROCEDIMENTOS[c.procedimentoId];
      if (!p) return [];
      return lancamentosDoAtendimento(
        {
          procedimento: p.nome,
          preco: p.precoCentavos,
          custoInsumos: p.custoInsumosCentavos,
          comissaoBp: p.comissaoBp,
          data: hoje,
        },
        FORMA_DE_PAGAMENTO,
      );
    });
}

/** A agenda marcada daqui em diante, montada a partir do ritmo da semana. */
function agendaDosProximosDias(apartirDe: number, dias: number) {
  const out: { data: string; preco: number; status: 'agendado' | 'confirmado' | 'em_risco' }[] = [];
  for (let d = apartirDe; d < dias; d++) {
    const data = emHoje('09:00', d);
    for (const vaga of RITMO_DA_SEMANA[data.getDay()] ?? []) {
      out.push({
        data: iso(data),
        preco: PROCEDIMENTOS[vaga.procedimentoId]?.precoCentavos ?? 0,
        status: vaga.status,
      });
    }
  }
  return out;
}

/** Projeção de caixa, direto de projetarFluxo. */
export function fluxoProjetado(
  consultas: ConsultaDemo[],
  dias = 45,
  taxas: TaxasComparecimento = TAXAS_PADRAO,
) {
  const hoje = iso(new Date());
  const agenda = consultas
    .filter(
      (c): c is ConsultaDemo & { status: 'agendado' | 'confirmado' | 'em_risco' } =>
        c.status === 'agendado' || c.status === 'confirmado' || c.status === 'em_risco',
    )
    .map((c) => ({
      data: iso(emHoje(c.horaAgendada, c.dia === 'hoje' ? 0 : 1)),
      preco: PROCEDIMENTOS[c.procedimentoId]?.precoCentavos ?? 0,
      status: c.status,
    }));

  return projetarFluxo(
    0,
    lancamentosRealizados(consultas),
    [...agenda, ...agendaDosProximosDias(2, dias)],
    hoje,
    dias,
    taxas,
  );
}

/** Toda consulta marcada como se todo mundo comparecesse: a conta da planilha. */
const TODOS_COMPARECEM: TaxasComparecimento = {
  confirmadoBp: 10_000,
  agendadoBp: 10_000,
  emRiscoBp: 10_000,
};

export interface PontoDoCaixa {
  data: string;
  marcado: number;
  esperado: number;
}

/**
 * As duas linhas da tela de Caixa: o que está marcado e o que a clínica pode
 * mesmo esperar. A distância entre elas é o custo das faltas, dia a dia.
 */
export function marcadoEEsperado(consultas: ConsultaDemo[], dias = 45): PontoDoCaixa[] {
  const cheio = fluxoProjetado(consultas, dias, TODOS_COMPARECEM);
  const provavel = fluxoProjetado(consultas, dias);
  let acMarcado = 0;
  let acEsperado = 0;
  return cheio.map((d, i) => {
    const par = provavel[i];
    acMarcado += d.saldoAcumulado - (i > 0 ? (cheio[i - 1]?.saldoAcumulado ?? 0) : 0);
    acMarcado += d.receitaAgendaEsperada;
    acEsperado += d.saldoAcumulado - (i > 0 ? (cheio[i - 1]?.saldoAcumulado ?? 0) : 0);
    acEsperado += par?.receitaAgendaEsperada ?? 0;
    return { data: d.data, marcado: acMarcado, esperado: acEsperado };
  });
}

/** O número que o dono sente: quanto as faltas custaram. */
export function faltasDoMes() {
  return custoDasFaltas(
    FALTAS_DO_MES.map((f) => ({ preco: PROCEDIMENTOS[f.procedimentoId]?.precoCentavos ?? 0 })),
  );
}

/** Quanto está marcado no dia e quanto ainda não foi confirmado. */
export function manchete(consultas: ConsultaDemo[], dia: 'hoje' | 'amanha') {
  const doDia = consultas.filter((c) => c.dia === dia && c.status !== 'cancelado');
  const preco = (c: ConsultaDemo) => PROCEDIMENTOS[c.procedimentoId]?.precoCentavos ?? 0;
  const naAgenda = doDia.reduce((s, c) => s + preco(c), 0);
  const semConfirmacao = doDia
    .filter((c) => c.status === 'agendado' || c.status === 'em_risco')
    .reduce((s, c) => s + preco(c), 0);
  return { quantidade: doDia.length, naAgenda, semConfirmacao };
}

/**
 * Calculadora: quanto as faltas custam por ano nesta clínica.
 * Os números entram pela URL para o vendedor abrir a tela já com os da clínica.
 */
export interface EntradaCalculadora {
  consultasPorMes: number;
  faltaPct: number;
  ticketCentavos: number;
}

export const CALCULADORA_PADRAO: EntradaCalculadora = {
  consultasPorMes: 320,
  faltaPct: 12,
  ticketCentavos: 45000,
};

export function lerCalculadoraDaUrl(busca: string): EntradaCalculadora {
  const p = new URLSearchParams(busca);
  const num = (chave: string, padrao: number, min: number, max: number): number => {
    const cru = p.get(chave);
    if (cru === null) return padrao;
    const v = Number(cru.replace(',', '.'));
    if (!Number.isFinite(v)) return padrao;
    return Math.min(max, Math.max(min, v));
  };
  return {
    consultasPorMes: Math.round(num('consultas', CALCULADORA_PADRAO.consultasPorMes, 1, 20000)),
    faltaPct: num('falta', CALCULADORA_PADRAO.faltaPct, 0, 100),
    ticketCentavos: Math.round(
      num('ticket', CALCULADORA_PADRAO.ticketCentavos / 100, 1, 1_000_000) * 100,
    ),
  };
}

export function contaDaCalculadora(e: EntradaCalculadora) {
  const faltasPorMes = Math.round((e.consultasPorMes * e.faltaPct) / 100);
  // Dinheiro é inteiro em centavos: nunca float (regra 1 do projeto).
  const perdaMes = faltasPorMes * e.ticketCentavos;
  // A régua de confirmação com lista de espera recupera parte. 60% é o piso
  // conservador que usamos na conversa comercial.
  const recuperadoMes = Math.round(perdaMes * 0.6);
  return {
    faltasPorMes,
    perdaMes,
    perdaAno: perdaMes * 12,
    recuperadoMes,
    recuperadoAno: recuperadoMes * 12,
  };
}
