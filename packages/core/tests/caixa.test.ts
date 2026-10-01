import { describe, expect, it } from 'vitest';
import { resumirCaixa, TAXAS_PADRAO, type ConsultaNoCaixa, type StatusNoCaixa } from '../src';

/**
 * Marcado × esperado × realizado.
 *
 * Tudo em centavos inteiros, e as três perguntas que o dono faz: quanto está na
 * agenda, quanto deve entrar de verdade, quanto já entrou. A distância entre as duas
 * primeiras é o que a tela existe para mostrar.
 */

const PRECO = 25_000; // R$ 250,00

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
    const r = resumirCaixa([consulta('cancelado')]);
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
    const r = resumirCaixa([consulta('faltou')]);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.esperadoCents).toBe(0);
    expect(r.realizadoCents).toBe(0);
    expect(r.faltas).toEqual({ quantidade: 1, valor: PRECO });
  });

  it('realizada conta nos três, pelo preço cheio', () => {
    // Já aconteceu: não há chance de comparecer para ponderar.
    const r = resumirCaixa([consulta('realizado')]);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.esperadoCents).toBe(PRECO);
    expect(r.realizadoCents).toBe(PRECO);
  });

  it.each([
    ['confirmado', TAXAS_PADRAO.confirmadoBp],
    ['agendado', TAXAS_PADRAO.agendadoBp],
    ['em_risco', TAXAS_PADRAO.emRiscoBp],
  ] as const)('%s entra em esperado ponderado pela chance de comparecer', (status, bp) => {
    const r = resumirCaixa([consulta(status)]);
    expect(r.marcadoCents).toBe(PRECO);
    expect(r.esperadoCents).toBe(Math.round((PRECO * bp) / 10_000));
    expect(r.realizadoCents).toBe(0);
  });

  it('em risco vale menos que agendado, que vale menos que confirmado', () => {
    // A ordem é o que faz a tela ser útil: a régua de confirmação muda o número.
    const esperado = (s: StatusNoCaixa) => resumirCaixa([consulta(s)]).esperadoCents;
    expect(esperado('em_risco')).toBeLessThan(esperado('agendado'));
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
    const r = resumirCaixa([
      consulta('confirmado'),
      consulta('confirmado', {
        procedimentoId: 'da-planilha',
        preco: 0,
        precoCadastrado: false,
      }),
    ]);
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
    const r = resumirCaixa([
      consulta('confirmado', { procedimentoId: 'da-planilha', preco: 0, precoCadastrado: false }),
    ]);
    expect(r.porProfissional).toEqual([]);
    expect(r.porProcedimento).toEqual([]);
  });

  it('conta procedimentos DISTINTOS, não consultas', () => {
    // "2 procedimentos sem preço cadastrado" é o que leva ao cadastro; o número de
    // consultas afetadas é outra informação, e vai separada.
    const r = resumirCaixa([
      consulta('confirmado', { procedimentoId: 'a', preco: 0, precoCadastrado: false }),
      consulta('confirmado', { procedimentoId: 'a', preco: 0, precoCadastrado: false }),
      consulta('confirmado', { procedimentoId: 'b', preco: 0, precoCadastrado: false }),
    ]);
    expect(r.semPreco).toEqual({ consultas: 3, procedimentos: 2, procedimentoIds: ['a', 'b'] });
  });

  /**
   * Cortesia de verdade é diferente: preço zero CADASTRADO vale zero, e entra na conta
   * como zero. É a distinção que a coluna de origem existe para permitir.
   */
  it('cortesia cadastrada entra na conta valendo zero, e não vira pendência', () => {
    const r = resumirCaixa([consulta('realizado', { preco: 0, precoCadastrado: true })]);
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
    const r = resumirCaixa(cenario);
    for (const eixo of [r.porProfissional, r.porProcedimento]) {
      expect(eixo.reduce((s, l) => s + l.marcadoCents, 0)).toBe(r.marcadoCents);
      expect(eixo.reduce((s, l) => s + l.esperadoCents, 0)).toBe(r.esperadoCents);
      expect(eixo.reduce((s, l) => s + l.realizadoCents, 0)).toBe(r.realizadoCents);
      expect(eixo.reduce((s, l) => s + l.consultas, 0)).toBe(r.consultas);
    }
  });

  it('a maior divergência vem primeiro: é a linha que custa mais', () => {
    const r = resumirCaixa(cenario);
    const marcados = r.porProcedimento.map((l) => l.marcadoCents);
    expect([...marcados].sort((a, b) => b - a)).toEqual(marcados);
  });

  it('esperado nunca passa de marcado', () => {
    const r = resumirCaixa(cenario);
    expect(r.esperadoCents).toBeLessThanOrEqual(r.marcadoCents);
    for (const l of [...r.porProfissional, ...r.porProcedimento]) {
      expect(l.esperadoCents).toBeLessThanOrEqual(l.marcadoCents);
    }
  });

  it('realizado nunca passa de esperado', () => {
    const r = resumirCaixa(cenario);
    expect(r.realizadoCents).toBeLessThanOrEqual(r.esperadoCents);
  });

  it('a conta inteira confere, centavo por centavo', () => {
    const r = resumirCaixa(cenario);
    // Marcado: tudo menos a cancelada.
    expect(r.marcadoCents).toBe(25_000 + 90_000 + 25_000 + 150_000 + 25_000);
    // Esperado: realizada cheia, confirmada a 95%, agendada a 80%, em risco a 50%,
    // faltou zero, cancelada fora.
    expect(r.esperadoCents).toBe(25_000 + 85_500 + 20_000 + 75_000);
    expect(r.realizadoCents).toBe(25_000);
    expect(r.faltas).toEqual({ quantidade: 1, valor: 25_000 });
  });
});

describe('centavos inteiros, sempre', () => {
  it('todo valor devolvido é inteiro', () => {
    const r = resumirCaixa([
      consulta('confirmado', { preco: 33_333 }),
      consulta('agendado', { preco: 1 }),
      consulta('em_risco', { preco: 7 }),
    ]);
    const todos = [
      r.marcadoCents,
      r.esperadoCents,
      r.realizadoCents,
      r.faltas.valor,
      ...r.porProfissional.flatMap((l) => [l.marcadoCents, l.esperadoCents, l.realizadoCents]),
      ...r.porProcedimento.flatMap((l) => [l.marcadoCents, l.esperadoCents, l.realizadoCents]),
    ];
    for (const v of todos) expect(Number.isSafeInteger(v), `${v} não é inteiro`).toBe(true);
  });

  it('preço que não é inteiro em centavos estoura, em vez de arredondar sozinho', () => {
    // Float em dinheiro é bug, não entrada válida: tem de quebrar alto.
    expect(() => resumirCaixa([consulta('confirmado', { preco: 250.5 })])).toThrow(RangeError);
  });

  it('período sem consulta nenhuma é zero em tudo, e não erro', () => {
    expect(resumirCaixa([])).toMatchObject({
      consultas: 0,
      marcadoCents: 0,
      esperadoCents: 0,
      realizadoCents: 0,
      faltas: { quantidade: 0, valor: 0 },
      semPreco: { consultas: 0, procedimentos: 0, procedimentoIds: [] },
    });
  });
});
