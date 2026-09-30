import { describe, expect, it } from 'vitest';
import { lerAfirmacao } from '../src/pertinencia';

/**
 * A pertinência é a afirmação do template, não um número de minutos.
 *
 * Os dois casos de virada de dia são o teste que importa, porque é onde qualquer
 * limite em minutos erra: ele acerta um dos dois e erra o outro, sempre.
 */

const SP = 'America/Sao_Paulo';
const em = (quando: string): Date => new Date(Date.parse(quando));

describe('"sua consulta de amanhã"', () => {
  it('às 23h, uma consulta às 8h de amanhã: nove horas, e "amanhã" É VERDADE', () => {
    const r = lerAfirmacao(
      'consulta_amanha_ou_depois',
      em('2026-10-02T08:00:00-03:00'),
      em('2026-10-01T23:00:00-03:00'),
      SP,
    );
    expect(r).toEqual({ vale: true });
  });

  it('às 9h, uma consulta às 23h de HOJE: catorze horas, e "amanhã" É FALSO', () => {
    // Mais longe no relógio do que o caso acima, e mentira do mesmo jeito. É por
    // isso que a regra não pode ser distância.
    const r = lerAfirmacao(
      'consulta_amanha_ou_depois',
      em('2026-10-01T23:00:00-03:00'),
      em('2026-10-01T09:00:00-03:00'),
      SP,
    );
    expect(r).toEqual({ vale: false, motivo: 'afirmacao_venceu' });
  });

  it('depois de amanhã também é "amanhã ou depois"', () => {
    const r = lerAfirmacao(
      'consulta_amanha_ou_depois',
      em('2026-10-05T10:00:00-03:00'),
      em('2026-10-01T09:00:00-03:00'),
      SP,
    );
    expect(r).toEqual({ vale: true });
  });

  it('um minuto depois da meia-noite da clínica, "amanhã" já virou hoje', () => {
    // 00:01 do dia 2: a consulta das 8h do dia 2 deixou de ser "amanhã".
    const r = lerAfirmacao(
      'consulta_amanha_ou_depois',
      em('2026-10-02T08:00:00-03:00'),
      em('2026-10-02T00:01:00-03:00'),
      SP,
    );
    expect(r).toEqual({ vale: false, motivo: 'afirmacao_venceu' });
  });
});

describe('"sua consulta de hoje"', () => {
  it('vale enquanto a consulta é hoje e ainda não começou', () => {
    const r = lerAfirmacao(
      'consulta_hoje_ainda_por_vir',
      em('2026-10-01T15:00:00-03:00'),
      em('2026-10-01T13:00:00-03:00'),
      SP,
    );
    expect(r).toEqual({ vale: true });
  });

  it('consulta de amanhã torna "hoje" falso, mesmo faltando poucas horas', () => {
    // O lembrete que cruza a meia-noite: o texto diria hoje sobre um horário de
    // amanhã. Melhor não sair do que sair mentindo.
    const r = lerAfirmacao(
      'consulta_hoje_ainda_por_vir',
      em('2026-10-02T00:30:00-03:00'),
      em('2026-10-01T22:30:00-03:00'),
      SP,
    );
    expect(r).toEqual({ vale: false, motivo: 'afirmacao_venceu' });
  });
});

describe('o piso: consulta no passado', () => {
  it.each(['consulta_amanha_ou_depois', 'consulta_hoje_ainda_por_vir'] as const)(
    'para %s, consulta que já começou nunca é pertinente',
    (afirmacao) => {
      const r = lerAfirmacao(
        afirmacao,
        em('2026-10-01T09:00:00-03:00'),
        em('2026-10-01T09:30:00-03:00'),
        SP,
      );
      expect(r).toEqual({ vale: false, motivo: 'consulta_no_passado' });
    },
  );

  it('o instante exato do começo já é passado', () => {
    const inicio = em('2026-10-01T09:00:00-03:00');
    expect(lerAfirmacao('consulta_hoje_ainda_por_vir', inicio, inicio, SP)).toEqual({
      vale: false,
      motivo: 'consulta_no_passado',
    });
  });
});

describe('o fuso é o da clínica', () => {
  it('o mesmo par de instantes muda de veredito entre fusos', () => {
    // O caso das 23h para as 8h, lido de dois lugares:
    //   São Paulo  -> agora é dia 1 às 23h, consulta é dia 2 às 8h  => amanhã, VERDADE
    //   Tóquio     -> agora é dia 2 às 11h, consulta é dia 2 às 20h => hoje, FALSO
    const agora = em('2026-10-01T23:00:00-03:00');
    const consulta = em('2026-10-02T08:00:00-03:00');

    expect(lerAfirmacao('consulta_amanha_ou_depois', consulta, agora, SP)).toEqual({ vale: true });
    expect(
      lerAfirmacao('consulta_amanha_ou_depois', consulta, agora, 'Asia/Tokyo'),
      'no fuso de Tóquio a consulta cai hoje, e "amanhã" seria mentira',
    ).toEqual({ vale: false, motivo: 'afirmacao_venceu' });
  });

  it('Manaus vira o dia uma hora depois de São Paulo', () => {
    // 00:30 em SP do dia 2 é 23:30 em Manaus do dia 1.
    const agora = em('2026-10-02T00:30:00-03:00');
    const consulta = em('2026-10-02T10:00:00-03:00');

    expect(lerAfirmacao('consulta_amanha_ou_depois', consulta, agora, SP)).toEqual({
      vale: false,
      motivo: 'afirmacao_venceu',
    });
    expect(
      lerAfirmacao('consulta_amanha_ou_depois', consulta, agora, 'America/Manaus'),
      'em Manaus ainda é o dia anterior, então "amanhã" continua verdade',
    ).toEqual({ vale: true });
  });
});
