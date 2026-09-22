import { describe, expect, it } from 'vitest';
import {
  custoDasFaltas,
  efeitoDaResposta,
  horariosLivres,
  interpretarResposta,
  lancamentosDoAtendimento,
  margemDeContribuicao,
  PAYLOAD_BOTOES,
  planejarEnvio,
  planejarOferta,
  precoPorMarkupDivisor,
  projetarFluxo,
  quebrarEmBaloes,
  splitEven,
  sugestoesVariadas,
} from '../src';

describe('dinheiro', () => {
  it('parcelas somam exatamente o total', () => {
    expect(splitEven(10_000, 3)).toEqual([3_334, 3_333, 3_333]);
    const p = splitEven(123_457, 7);
    expect(p.reduce((a, b) => a + b, 0)).toBe(123_457);
  });
  it('recusa float', () => {
    expect(() => splitEven(10.5, 2)).toThrow(RangeError);
  });
});

describe('precificação (markup divisor)', () => {
  it('caso canônico: custo R$ 50 -> R$ 80,75, não R$ 69,04', () => {
    const preco = precoPorMarkupDivisor(5_000, {
      impostoBp: 808,
      taxaCartaoBp: 1_000,
      comissaoBp: 0,
      lucroBp: 2_000,
    });
    expect(preco).toBe(8_075);
  });
  it('percentuais >= 100% são rejeitados', () => {
    expect(() =>
      precoPorMarkupDivisor(5_000, {
        impostoBp: 5_000,
        taxaCartaoBp: 3_000,
        comissaoBp: 1_000,
        lucroBp: 1_000,
      }),
    ).toThrow();
  });
  it('lucro que sobra bate com o lucro pedido', () => {
    const preco = precoPorMarkupDivisor(5_000, {
      impostoBp: 808,
      taxaCartaoBp: 1_000,
      comissaoBp: 0,
      lucroBp: 2_000,
    });
    const m = margemDeContribuicao(preco, 5_000, {
      impostoBp: 808,
      taxaCartaoBp: 1_000,
      comissaoBp: 0,
    });
    expect(Math.abs(m.bp - 2_000)).toBeLessThanOrEqual(1);
  });
});

describe('financeiro', () => {
  const atendimento = {
    procedimento: 'Botox',
    preco: 150_000,
    custoInsumos: 40_000,
    comissaoBp: 1_000,
    data: '2026-01-31',
  };

  it('crédito 3x: receita nas datas em que o dinheiro cai, taxa e comissão separadas', () => {
    const l = lancamentosDoAtendimento(atendimento, {
      nome: 'Crédito 3x',
      taxaBp: 350,
      diasParaReceber: 30,
      parcelas: 3,
    });
    const receitas = l.filter((x) => x.tipo === 'receita');
    expect(receitas.map((r) => r.valor)).toEqual([50_000, 50_000, 50_000]);
    expect(receitas.map((r) => r.vencimento)).toEqual(['2026-03-02', '2026-04-02', '2026-05-02']);
    expect(l.filter((x) => x.categoria === 'taxa_pagamento').reduce((s, x) => s + x.valor, 0)).toBe(
      5_250,
    );
    expect(l.find((x) => x.categoria === 'comissao')?.valor).toBe(15_000);
    expect(l.find((x) => x.categoria === 'insumo')?.status).toBe('realizado');
  });

  it('parcela mensal respeita fim de mês (31/01 -> 28/02)', () => {
    const l = lancamentosDoAtendimento(
      { ...atendimento, data: '2026-01-31' },
      { nome: 'Crédito 2x', taxaBp: 0, diasParaReceber: 0, parcelas: 2 },
    );
    expect(l.filter((x) => x.tipo === 'receita').map((r) => r.vencimento)).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
  });

  it('Pix à vista: uma receita, sem taxa', () => {
    const l = lancamentosDoAtendimento(
      { ...atendimento, comissaoBp: 0, custoInsumos: 0 },
      { nome: 'Pix', taxaBp: 0, diasParaReceber: 0, parcelas: 1 },
    );
    expect(l).toEqual([
      {
        tipo: 'receita',
        status: 'previsto',
        categoria: 'procedimento',
        descricao: 'Botox — Pix',
        valor: 150_000,
        vencimento: '2026-01-31',
      },
    ]);
  });

  it('projeção pondera a agenda pela chance de comparecer', () => {
    const dias = projetarFluxo(
      100_000,
      [{ tipo: 'despesa', valor: 30_000, vencimento: '2026-02-02' }],
      [
        { data: '2026-02-01', preco: 20_000, status: 'confirmado' },
        { data: '2026-02-01', preco: 20_000, status: 'em_risco' },
      ],
      '2026-02-01',
      2,
    );
    expect(dias[0]!.receitaAgendaEsperada).toBe(19_000 + 10_000);
    expect(dias[1]!.saldoAcumulado).toBe(70_000);
  });

  it('custo das faltas', () => {
    expect(custoDasFaltas([{ preco: 20_000 }, { preco: 35_000 }])).toEqual({
      quantidade: 2,
      valor: 55_000,
    });
  });
});

describe('agenda', () => {
  const d = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m));
  const agora = d(6);

  it('não oferece horário ocupado nem que não caiba no expediente', () => {
    const livres = horariosLivres({
      expediente: [{ inicio: d(9), fim: d(12) }],
      ocupados: [{ inicio: d(10), fim: d(11) }],
      duracaoMin: 60,
      passoMin: 30,
      agora,
    });
    expect(livres).toEqual([d(9), d(11)]);
  });

  it('respeita antecedência mínima', () => {
    const livres = horariosLivres({
      expediente: [{ inicio: d(9), fim: d(12) }],
      ocupados: [],
      duracaoMin: 60,
      passoMin: 30,
      agora: d(9, 10),
      antecedenciaMinimaMin: 60,
    });
    expect(livres[0]).toEqual(d(10, 30));
  });

  it('sugestões espalhadas em períodos diferentes', () => {
    const livres = [d(9), d(9, 30), d(10), d(14), d(14, 30), d(17)];
    expect(sugestoesVariadas(livres, 3, 180)).toEqual([d(9), d(14), d(17)]);
  });
});

describe('lista de espera e confirmação', () => {
  const cfg = { modo: 'lote' as const, tamanhoLote: 3, timeoutMin: 20, antecedenciaMinimaMin: 60 };
  const agora = new Date('2026-11-10T12:00:00Z');

  it('vaga daqui a 3h: oferta para 3 pessoas, 20 min para responder', () => {
    const p = planejarOferta(cfg, new Date('2026-11-10T15:00:00Z'), agora);
    expect(p).toEqual({ ofertar: true, quantos: 3, expiraEm: new Date('2026-11-10T12:20:00Z') });
  });

  it('vaga daqui a 1h10: oferta encurta para caber antes da antecedência mínima', () => {
    const p = planejarOferta(cfg, new Date('2026-11-10T13:10:00Z'), agora);
    expect(p).toEqual({ ofertar: true, quantos: 3, expiraEm: new Date('2026-11-10T12:10:00Z') });
  });

  it('vaga daqui a 40 min: não oferta', () => {
    expect(planejarOferta(cfg, new Date('2026-11-10T12:40:00Z'), agora)).toEqual({
      ofertar: false,
      motivo: 'em_cima_da_hora',
    });
  });

  it('modo sequencial oferta para 1 por vez', () => {
    const p = planejarOferta(
      { ...cfg, modo: 'sequencial' },
      new Date('2026-11-10T18:00:00Z'),
      agora,
    );
    expect(p.ofertar && p.quantos).toBe(1);
  });

  it('botões do template são lidos sem IA; texto livre vai para a IA', () => {
    expect(
      efeitoDaResposta(interpretarResposta({ payloadBotao: PAYLOAD_BOTOES.CONFIRMAR })),
    ).toEqual({ acao: 'marcar_confirmado' });
    expect(
      efeitoDaResposta(interpretarResposta({ payloadBotao: PAYLOAD_BOTOES.CANCELAR })).acao,
    ).toBe('liberar_horario_e_ofertar');
    expect(efeitoDaResposta(interpretarResposta({ texto: 'vou atrasar uns 10 min' }))).toEqual({
      acao: 'encaminhar_para_ia',
    });
  });
});

describe('humanização', () => {
  it('nunca responde mais rápido que o mínimo da clínica', () => {
    const p = planejarEnvio('oi', 'Oi! Tudo bem?', undefined, () => 0);
    expect(p.aguardarAntesMs).toBeGreaterThanOrEqual(4_000);
  });

  it('quebra resposta longa em até 3 balões sem cortar frase', () => {
    const texto =
      'Temos horário na terça às 14h com a Dra. Ana. Também tenho quinta às 9h30, se for melhor para a senhora. ' +
      'O procedimento leva uns 40 minutos. Chegue uns 10 minutinhos antes para o cadastro. ' +
      'Qualquer coisa me chama por aqui. Posso reservar algum desses?';
    const b = quebrarEmBaloes(texto);
    expect(b.length).toBeLessThanOrEqual(3);
    expect(b.join(' ')).toBe(texto);
    b.forEach((x) => expect(x).toMatch(/[.!?]$/));
  });
});
