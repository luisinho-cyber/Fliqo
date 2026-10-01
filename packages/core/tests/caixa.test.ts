import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AMOSTRA_MINIMA_DE_COMPARECIMENTO,
  chanceDeComparecer,
  grupoDa,
  resumirCaixa,
  type ConsultaNoCaixa,
  type HistoricoDeComparecimento,
  type StatusNoCaixa,
} from '../src';

/**
 * Marcado × esperado × realizado.
 *
 * Tudo em centavos inteiros, e as três perguntas que o dono faz: quanto está na
 * agenda, quanto deve entrar de verdade, quanto já entrou. A distância entre as duas
 * primeiras é o que a tela existe para mostrar.
 */

const PRECO = 25_000; // R$ 250,00

/**
 * Histórico com amostra folgada. Os números são do cenário, não do mercado: é isso que
 * diferencia o esperado medido do esperado inventado.
 *
 * 190 de 200 confirmadas = 95%; 160 de 200 sem confirmar = 80%.
 */
const HISTORICO: HistoricoDeComparecimento = {
  confirmada: { total: 200, compareceram: 190 },
  sem_confirmacao: { total: 200, compareceram: 160 },
  janelaDias: 90,
};

/** Clínica nova: doze consultas com desfecho. Não é taxa, é ruído. */
const CLINICA_NOVA: HistoricoDeComparecimento = {
  confirmada: { total: 8, compareceram: 8 },
  sem_confirmacao: { total: 4, compareceram: 3 },
  janelaDias: 90,
};

function consulta(status: StatusNoCaixa, o: Partial<ConsultaNoCaixa> = {}): ConsultaNoCaixa {
  return {
    profissionalId: 'ana',
    procedimentoId: 'limpeza',
    status,
    preco: PRECO,
    precoCadastrado: true,
    ...o,
  };
}

describe('o que conta como marcado', () => {
  it('cancelada não conta em nada — o horário voltou a estar livre', () => {
    const r = resumirCaixa([consulta('cancelado')], HISTORICO);
    expect(r).toMatchObject({
      consultas: 0,
      marcadoCents: 0,
      esperadoCents: 0,
      realizadoCents: 0,
    });
    expect(r.porProfissional).toEqual([]);
    expect(r.porProcedimento).toEqual([]);
  });

  /**
   * Faltou CONTINUA em marcado, e é de propósito: ela ocupou a agenda, e a distância
   * entre marcado e esperado é exatamente o que a falta custou. Tirá-la de marcado
   * esconderia o número que vende o sistema.
   */
  it('faltou conta como marcado, não como esperado, e não como realizado', () => {
    const r = resumirCaixa([consulta('faltou')], HISTORICO);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.esperadoCents).toBe(0);
    expect(r.realizadoCents).toBe(0);
    expect(r.faltas).toEqual({ quantidade: 1, valor: PRECO });
  });

  it('realizada conta nos três, pelo preço cheio', () => {
    // Já aconteceu: não há chance de comparecer para ponderar.
    const r = resumirCaixa([consulta('realizado')], HISTORICO);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.esperadoCents).toBe(PRECO);
    expect(r.realizadoCents).toBe(PRECO);
  });

  it('confirmada usa a taxa MEDIDA das confirmadas da clínica', () => {
    // 190/200 = 95% — porque é o que esta clínica fez, não porque 95 é um número bonito.
    const r = resumirCaixa([consulta('confirmado')], HISTORICO);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.esperadoCents).toBe(Math.round((PRECO * 9_500) / 10_000));
    expect(r.realizadoCents).toBe(0);
  });

  it.each(['agendado', 'em_risco'] as const)('%s usa a taxa das não confirmadas', (status) => {
    // 160/200 = 80%. Os dois status caem no mesmo grupo porque o banco não guarda
    // histórico de status: medir a diferença entre eles seria inventá-la.
    const r = resumirCaixa([consulta(status)], HISTORICO);
    expect(r.esperadoCents).toBe(Math.round((PRECO * 8_000) / 10_000));
  });

  it('confirmar aumenta o esperado, e realizar aumenta mais', () => {
    const esperado = (s: StatusNoCaixa) =>
      resumirCaixa([consulta(s)], HISTORICO).esperadoCents ?? 0;
    expect(esperado('agendado')).toBeLessThan(esperado('confirmado'));
    expect(esperado('confirmado')).toBeLessThan(esperado('realizado'));
  });
});

describe('preço que ninguém cadastrou', () => {
  /**
   * O caso que a importação de agenda cria. Zero tem dois significados, e somá-los
   * juntos faz a tela mentir com cara de verde.
   */
  it('sai das três somas e é contada à parte', () => {
    const r = resumirCaixa(
      [
        consulta('confirmado'),
        consulta('confirmado', {
          procedimentoId: 'da-planilha',
          preco: 0,
          precoCadastrado: false,
        }),
      ],
      HISTORICO,
    );
    expect(r.consultas, 'a consulta sem preço entrou na contagem das somas').toBe(1);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.semPreco).toEqual({
      consultas: 1,
      procedimentos: 1,
      procedimentoIds: ['da-planilha'],
    });
  });

  it('não aparece nas linhas por profissional nem por procedimento', () => {
    // Linha com "3 consultas, R$ 0" leria como receita zero, que é a mentira.
    const r = resumirCaixa(
      [consulta('confirmado', { procedimentoId: 'da-planilha', preco: 0, precoCadastrado: false })],
      HISTORICO,
    );
    expect(r.porProfissional).toEqual([]);
    expect(r.porProcedimento).toEqual([]);
  });

  it('conta procedimentos DISTINTOS, não consultas', () => {
    // "2 procedimentos sem preço cadastrado" é o que leva ao cadastro; o número de
    // consultas afetadas é outra informação, e vai separada.
    const r = resumirCaixa(
      [
        consulta('confirmado', { procedimentoId: 'a', preco: 0, precoCadastrado: false }),
        consulta('confirmado', { procedimentoId: 'a', preco: 0, precoCadastrado: false }),
        consulta('confirmado', { procedimentoId: 'b', preco: 0, precoCadastrado: false }),
      ],
      HISTORICO,
    );
    expect(r.semPreco).toEqual({ consultas: 3, procedimentos: 2, procedimentoIds: ['a', 'b'] });
  });

  /**
   * Cortesia de verdade é diferente: preço zero CADASTRADO vale zero, e entra na conta
   * como zero. É a distinção que a coluna de origem existe para permitir.
   */
  it('cortesia cadastrada entra na conta valendo zero, e não vira pendência', () => {
    const r = resumirCaixa([consulta('realizado', { preco: 0, precoCadastrado: true })], HISTORICO);
    expect(r.consultas).toBe(1);
    expect(r.marcadoCents).toBe(0);
    expect(r.semPreco.procedimentos).toBe(0);
  });
});

describe('as linhas fecham com o total', () => {
  const cenario: ConsultaNoCaixa[] = [
    consulta('realizado', { profissionalId: 'ana', procedimentoId: 'limpeza', preco: 25_000 }),
    consulta('confirmado', { profissionalId: 'ana', procedimentoId: 'clareamento', preco: 90_000 }),
    consulta('agendado', { profissionalId: 'bruno', procedimentoId: 'limpeza', preco: 25_000 }),
    consulta('em_risco', { profissionalId: 'bruno', procedimentoId: 'botox', preco: 150_000 }),
    consulta('faltou', { profissionalId: 'ana', procedimentoId: 'limpeza', preco: 25_000 }),
    consulta('cancelado', { profissionalId: 'bruno', procedimentoId: 'botox', preco: 150_000 }),
  ];

  /**
   * A invariante que obriga o arredondamento a ser por consulta. Se o esperado fosse
   * arredondado no agregado, a tabela não fecharia com a frase acima dela — e tabela de
   * dinheiro que não fecha é pior do que tabela nenhuma.
   */
  it('a soma das linhas é exatamente o total, nos três números', () => {
    const r = resumirCaixa(cenario, HISTORICO);
    // O cenário tem histórico, então o esperado existe: um nulo aqui é defeito, não caso.
    expect(r.esperadoCents).not.toBeNull();
    for (const eixo of [r.porProfissional, r.porProcedimento]) {
      expect(eixo.reduce((s, l) => s + l.marcadoCents, 0)).toBe(r.marcadoCents);
      expect(eixo.reduce((s, l) => s + (l.esperadoCents ?? Number.NaN), 0)).toBe(r.esperadoCents);
      expect(eixo.reduce((s, l) => s + l.realizadoCents, 0)).toBe(r.realizadoCents);
      expect(eixo.reduce((s, l) => s + l.consultas, 0)).toBe(r.consultas);
    }
  });

  it('a maior divergência vem primeiro: é a linha que custa mais', () => {
    const r = resumirCaixa(cenario, HISTORICO);
    const marcados = r.porProcedimento.map((l) => l.marcadoCents);
    expect([...marcados].sort((a, b) => b - a)).toEqual(marcados);
  });

  it('esperado nunca passa de marcado', () => {
    const r = resumirCaixa(cenario, HISTORICO);
    expect(r.esperadoCents ?? Number.NaN).toBeLessThanOrEqual(r.marcadoCents);
    for (const l of [...r.porProfissional, ...r.porProcedimento]) {
      expect(l.esperadoCents ?? Number.NaN).toBeLessThanOrEqual(l.marcadoCents);
    }
  });

  it('realizado nunca passa de esperado', () => {
    const r = resumirCaixa(cenario, HISTORICO);
    expect(r.realizadoCents).toBeLessThanOrEqual(r.esperadoCents ?? Number.NaN);
  });

  it('a conta inteira confere, centavo por centavo', () => {
    const r = resumirCaixa(cenario, HISTORICO);
    // Marcado: tudo menos a cancelada.
    expect(r.marcadoCents).toBe(25_000 + 90_000 + 25_000 + 150_000 + 25_000);
    // Esperado: realizada cheia, confirmada a 95% (190/200 desta clínica), agendada e em
    // risco a 80% (160/200), faltou zero, cancelada fora. Em risco NÃO tem taxa própria:
    // o banco não guarda histórico de status, e inventar a diferença é o que esta fase
    // existe para desfazer.
    expect(r.esperadoCents).toBe(25_000 + 85_500 + 20_000 + 120_000);
    expect(r.realizadoCents).toBe(25_000);
    expect(r.faltas).toEqual({ quantidade: 1, valor: 25_000 });
  });
});

describe('centavos inteiros, sempre', () => {
  it('todo valor devolvido é inteiro', () => {
    const r = resumirCaixa(
      [
        consulta('confirmado', { preco: 33_333 }),
        consulta('agendado', { preco: 1 }),
        consulta('em_risco', { preco: 7 }),
      ],
      HISTORICO,
    );
    const todos = [
      r.marcadoCents,
      r.esperadoCents ?? Number.NaN,
      r.realizadoCents,
      r.faltas.valor,
      ...r.porProfissional.flatMap((l) => [
        l.marcadoCents,
        l.esperadoCents ?? Number.NaN,
        l.realizadoCents,
      ]),
      ...r.porProcedimento.flatMap((l) => [
        l.marcadoCents,
        l.esperadoCents ?? Number.NaN,
        l.realizadoCents,
      ]),
    ];
    for (const v of todos) expect(Number.isSafeInteger(v), `${v} não é inteiro`).toBe(true);
  });

  it('preço que não é inteiro em centavos estoura, em vez de arredondar sozinho', () => {
    // Float em dinheiro é bug, não entrada válida: tem de quebrar alto.
    expect(() => resumirCaixa([consulta('confirmado', { preco: 250.5 })], HISTORICO)).toThrow(
      RangeError,
    );
  });

  it('período sem consulta nenhuma é zero em tudo, e não erro', () => {
    expect(resumirCaixa([], HISTORICO)).toMatchObject({
      consultas: 0,
      marcadoCents: 0,
      esperadoCents: 0,
      realizadoCents: 0,
      faltas: { quantidade: 0, valor: 0 },
      semPreco: { consultas: 0, procedimentos: 0, procedimentoIds: [] },
    });
  });
});

describe('de onde sai a chance de comparecer', () => {
  /**
   * A condição que bloqueava o merge. O esperado era preço × constante — 0,95, 0,80, 0,50
   * escritas no código, com um comentário dizendo "calibre com o histórico real" que ninguém
   * calibrou. Número plausível, sem procedência, que não quebra teste nenhum: o dono confere
   * contra o extrato no fim do mês, não bate, e perde a confiança na tela inteira.
   *
   * Agora a taxa é medida. Estes testes são o que impede a constante de voltar.
   */
  it('a taxa é a razão medida, em basis points inteiros', () => {
    expect(chanceDeComparecer({ total: 200, compareceram: 190 })).toEqual({
      ha: true,
      bp: 9_500,
      amostra: 200,
    });
    // Arredondamento para bp inteiro: percentual não passa por float (CLAUDE.md, regra 1).
    expect(chanceDeComparecer({ total: 300, compareceram: 211 })).toMatchObject({ bp: 7_033 });
  });

  it('abaixo do piso não há taxa, e o motivo é a amostra', () => {
    expect(
      chanceDeComparecer({ total: AMOSTRA_MINIMA_DE_COMPARECIMENTO - 1, compareceram: 20 }),
    ).toEqual({
      ha: false,
      motivo: 'amostra_pequena',
      amostra: AMOSTRA_MINIMA_DE_COMPARECIMENTO - 1,
    });
    expect(
      chanceDeComparecer({ total: AMOSTRA_MINIMA_DE_COMPARECIMENTO, compareceram: 20 }).ha,
    ).toBe(true);
  });

  /**
   * O piso é 30 e não 8, e a diferença tem razão: oito atendimentos dão uma mediana de
   * duração utilizável, porque a mediana ignora o caso fora da curva. Uma PROPORÇÃO com oito
   * amostras pula 12,5 pontos a cada falta.
   */
  it('o piso é 30, escrito por valor', () => {
    expect(AMOSTRA_MINIMA_DE_COMPARECIMENTO).toBe(30);
  });

  it('o piso faz uma falta mover a taxa em cerca de 3 pontos, não 12', () => {
    const com = (total: number, faltas: number) =>
      chanceDeComparecer({ total, compareceram: total - faltas });
    const noPiso = com(AMOSTRA_MINIMA_DE_COMPARECIMENTO, 0);
    const noPisoComUmaFalta = com(AMOSTRA_MINIMA_DE_COMPARECIMENTO, 1);
    const salto = (noPiso.ha ? noPiso.bp : 0) - (noPisoComUmaFalta.ha ? noPisoComUmaFalta.bp : 0);
    expect(salto).toBeLessThan(400); // menos de 4 pontos percentuais
  });

  it('só dois grupos, e só o que ainda vai acontecer consome taxa', () => {
    expect(grupoDa('confirmado')).toBe('confirmada');
    expect(grupoDa('agendado')).toBe('sem_confirmacao');
    expect(grupoDa('em_risco')).toBe('sem_confirmacao');
    // Desfecho conhecido não tem chance a estimar.
    for (const resolvido of ['realizado', 'faltou', 'cancelado'] as const) {
      expect(grupoDa(resolvido)).toBeUndefined();
    }
  });
});

describe('clínica nova não tem esperado inventado', () => {
  /** A terceira condição: sem histórico, o esperado NÃO inventa. */
  it('sem histórico suficiente, o esperado é nulo e o marcado continua', () => {
    const r = resumirCaixa([consulta('confirmado'), consulta('agendado')], CLINICA_NOVA);
    expect(r.marcadoCents).toBe(PRECO * 2);
    expect(r.esperadoCents, 'a clínica nova recebeu um esperado chutado').toBeNull();
    expect(r.realizadoCents).toBe(0);
  });

  it('sem histórico nenhum também não inventa', () => {
    const r = resumirCaixa([consulta('confirmado')]);
    expect(r.esperadoCents).toBeNull();
    expect(r.procedencia).toEqual({
      ha: false,
      motivo: 'sem_historico',
      amostra: 0,
      minimo: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
    });
  });

  it('as LINHAS também ficam sem esperado, não com zero', () => {
    // Zero leria como "nada vai entrar", que é o oposto de "não sei dizer".
    const r = resumirCaixa([consulta('confirmado')], CLINICA_NOVA);
    for (const l of [...r.porProfissional, ...r.porProcedimento]) {
      expect(l.esperadoCents).toBeNull();
      expect(l.marcadoCents).toBe(PRECO);
    }
  });

  it('a procedência diz quanto falta para haver projeção', () => {
    const r = resumirCaixa([consulta('confirmado'), consulta('agendado')], CLINICA_NOVA);
    expect(r.procedencia).toEqual({
      ha: false,
      motivo: 'sem_historico',
      // A MENOR amostra entre os grupos usados: é a que a clínica precisa crescer.
      amostra: 4,
      minimo: AMOSTRA_MINIMA_DE_COMPARECIMENTO,
    });
  });

  /**
   * Com histórico, a procedência carrega o que a tela precisa escrever: quantos
   * atendimentos e de quantos dias. É o que torna o número defensável para o sócio.
   */
  it('com histórico, a procedência traz amostra e janela', () => {
    const r = resumirCaixa([consulta('confirmado')], HISTORICO);
    expect(r.procedencia).toEqual({
      ha: true,
      amostra: 200,
      janelaDias: 90,
      porGrupo: { confirmada: 9_500 },
    });
  });

  /**
   * Só os grupos USADOS exigem amostra. Um período inteiramente passado não tem consulta em
   * aberto, então o esperado é exato sem histórico nenhum — e uma clínica que nunca deixa
   * consulta sem confirmar não perde a projeção por um grupo que ela não usa.
   */
  it('período só com desfecho conhecido projeta sem histórico', () => {
    const r = resumirCaixa([consulta('realizado'), consulta('faltou')]);
    expect(r.esperadoCents).toBe(PRECO);
    expect(r.procedencia.ha).toBe(true);
  });

  it('um grupo sem amostra não derruba a projeção do grupo que tem', () => {
    const soConfirmadas: HistoricoDeComparecimento = {
      confirmada: { total: 200, compareceram: 190 },
      sem_confirmacao: { total: 2, compareceram: 1 },
      janelaDias: 90,
    };
    // O período usa só o grupo que tem amostra.
    expect(resumirCaixa([consulta('confirmado')], soConfirmadas).esperadoCents).toBe(23_750);
    // E se usar o grupo sem amostra, não projeta nada — não dá para somar meia projeção.
    expect(resumirCaixa([consulta('agendado')], soConfirmadas).esperadoCents).toBeNull();
  });
});

describe('a constante inventada não volta', () => {
  /**
   * A guarda contra a reincidência.
   *
   * `TAXAS_DA_DEMONSTRACAO` existe e vai continuar existindo: a demo é um protótipo de
   * venda com agenda fabricada, e inventar número lá é honesto porque nada ali é de clínica
   * nenhuma. O defeito era usá-la no caixa de verdade — e o jeito de voltar a cometê-lo é
   * alguém querer que o esperado "apareça" numa clínica nova e lembrar que existe uma
   * constante pronta.
   *
   * O teste lê o código do caixa. Não é elegante, e é a única coisa que impede o retorno:
   * um esperado inventado não quebra teste de valor nenhum, porque continua plausível.
   */
  it('o módulo do caixa não usa as taxas da demonstração', () => {
    const fonte = readFileSync(new URL('../src/financeiro.ts', import.meta.url), 'utf8');
    const doCaixa = fonte.slice(fonte.indexOf('export function resumirCaixa'));
    expect(
      doCaixa,
      'o caixa voltou a usar taxa inventada: o esperado precisa vir de chanceDeComparecer',
    ).not.toContain('TAXAS_DA_DEMONSTRACAO');
  });

  it('resumirCaixa não tem padrão de taxa: quem chama entrega o histórico ou aceita nulo', () => {
    // Um padrão aqui seria o defeito de volta, com outro nome: quem chamasse sem pensar
    // receberia um número com cara de medida.
    const fonte = readFileSync(new URL('../src/financeiro.ts', import.meta.url), 'utf8');
    const assinatura = fonte.slice(
      fonte.indexOf('export function resumirCaixa'),
      fonte.indexOf('): ResumoDoCaixa {'),
    );
    expect(assinatura).toContain('historico?: HistoricoDeComparecimento');
    expect(assinatura, 'voltou a haver taxa com padrão na assinatura').not.toMatch(/taxas[^)]*=/);
  });

  it('a constante da demonstração diz no nome que é da demonstração', () => {
    // O nome antigo, `TAXAS_PADRAO`, convidava ao uso: "padrão" soa como "o certo".
    //
    // A conferência é da DECLARAÇÃO, não do texto: o comentário que conta esta história
    // cita o nome antigo, e deve citar. Procurar o nome solto acusaria a própria
    // explicação — mesma cegueira do `recusarAdminUrl` sem o parêntese.
    const fonte = readFileSync(new URL('../src/financeiro.ts', import.meta.url), 'utf8');
    expect(fonte, 'a constante com o nome que convida ao uso voltou').not.toMatch(
      /export const TAXAS_PADRAO\b/,
    );
    expect(fonte).toMatch(/export const TAXAS_DA_DEMONSTRACAO\b/);
  });
});
