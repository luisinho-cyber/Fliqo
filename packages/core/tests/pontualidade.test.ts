import { describe, expect, it } from 'vitest';
import {
  AMOSTRA_MINIMA,
  duracaoParaProjecao,
  GRADE_DA_AGENDA_MIN,
  LIMIAR_DE_DIVERGENCIA_MIN,
  SUGESTAO_PADRAO,
  medianaDe,
  percentualNoHorario,
  sugerirDuracaoPelaMediana,
  TOLERANCIA_PONTUALIDADE_MIN,
} from '../src';

/**
 * A regra da sugestão de duração, nos dois limites que decidem se ela aparece.
 *
 * Os dois limites são o assunto do teste porque são o que separa "a Fliqo achou a
 * causa do atraso" de "a Fliqo está palpitando": um a menos em qualquer um dos
 * dois e a tela começa a propor mudança de cadastro por acidente estatístico.
 */

const medida = (medianaMin: number, amostra: number) => ({ medianaMin, amostra });

describe('sugerir duração pela mediana', () => {
  it('sugere quando a amostra basta e a divergência importa', () => {
    expect(sugerirDuracaoPelaMediana(medida(54, 8), 40)).toEqual({
      sugerir: true,
      cadastradaMin: 40,
      novaDuracaoMin: 55,
      medianaMin: 54,
      amostra: 8,
    });
  });

  it('a amostra mínima é limite fechado: 8 sugere, 7 não', () => {
    expect(sugerirDuracaoPelaMediana(medida(54, AMOSTRA_MINIMA), 40).sugerir).toBe(true);
    expect(sugerirDuracaoPelaMediana(medida(54, AMOSTRA_MINIMA - 1), 40)).toEqual({
      sugerir: false,
      motivo: 'amostra_pequena',
    });
  });

  /**
   * Exatamente no limiar, sugere. Não é indiferença de um minuto: dez minutos de
   * divergência são, por definição, o bastante para o paciente seguinte sair do
   * "no horário" — é o mesmo dez da tolerância. O caso de igualdade cai do lado
   * de avisar.
   */
  it('o limiar de divergência é limite fechado', () => {
    const cadastrada = 40;
    expect(
      sugerirDuracaoPelaMediana(medida(cadastrada + LIMIAR_DE_DIVERGENCIA_MIN, 12), cadastrada)
        .sugerir,
    ).toBe(true);
    expect(
      sugerirDuracaoPelaMediana(medida(cadastrada + LIMIAR_DE_DIVERGENCIA_MIN - 1, 12), cadastrada),
    ).toEqual({ sugerir: false, motivo: 'divergencia_pequena' });
  });

  it('procedimento que dura MENOS também vira sugestão', () => {
    // Meia hora cadastrada para algo que leva quinze minutos é uma vaga por
    // paciente que a clínica está jogando fora.
    const s = sugerirDuracaoPelaMediana(medida(16, 20), 30);
    expect(s).toMatchObject({ sugerir: true, cadastradaMin: 30, novaDuracaoMin: 20 });
  });

  it('arredonda para cima na grade de cinco minutos', () => {
    // 51 → 55, e não 50: reservar a menos devolve o atraso para o dia todo.
    expect(sugerirDuracaoPelaMediana(medida(51, 10), 30)).toMatchObject({ novaDuracaoMin: 55 });
    // Já na grade, fica onde está — arredondar para cima não é somar cinco.
    expect(sugerirDuracaoPelaMediana(medida(55, 10), 30)).toMatchObject({ novaDuracaoMin: 55 });
  });

  it('a mediana crua vai junto, sem arredondar: a tela mostra o dado', () => {
    expect(sugerirDuracaoPelaMediana(medida(52.5, 9), 40)).toMatchObject({
      medianaMin: 52.5,
      novaDuracaoMin: 55,
    });
  });

  /**
   * O mesmo número nos dois lugares, de propósito. Se alguém afrouxar a amostra da
   * sugestão sem afrouxar a da projeção, a tela passa a propor ajuste com base
   * numa medida em que ela própria não confia para desenhar o bloco.
   */
  it('a projeção da Linha do Dia e a sugestão exigem a mesma amostra', () => {
    const naAgenda = 40;
    const poucos = { medianaMin: 54, amostra: AMOSTRA_MINIMA - 1 };
    expect(duracaoParaProjecao(poucos, naAgenda)).toBe(naAgenda);
    expect(sugerirDuracaoPelaMediana(poucos, naAgenda).sugerir).toBe(false);

    const bastantes = { medianaMin: 54, amostra: AMOSTRA_MINIMA };
    expect(duracaoParaProjecao(bastantes, naAgenda)).toBe(54);
    expect(sugerirDuracaoPelaMediana(bastantes, naAgenda).sugerir).toBe(true);
  });
});

describe('mediana', () => {
  it('ímpar é o do meio, par é a média dos dois do meio', () => {
    expect(medianaDe([10, 30, 20])).toBe(20);
    expect(medianaDe([10, 20, 30, 40])).toBe(25);
  });

  it('amostra vazia não tem mediana — e não é zero', () => {
    expect(medianaDe([])).toBeUndefined();
  });

  it('não reordena a amostra de quem chamou', () => {
    const amostra = [30, 10, 20];
    medianaDe(amostra);
    expect(amostra).toEqual([30, 10, 20]);
  });
});

describe('percentual no horário', () => {
  it('arredonda para inteiro', () => {
    expect(percentualNoHorario({ atendimentos: 3, noHorario: 2 })).toBe(67);
  });

  it('sem atendimento nenhum é null, nunca 0%', () => {
    // 0% acusaria de atrasar em tudo quem não atendeu ninguém.
    expect(percentualNoHorario({ atendimentos: 0, noHorario: 0 })).toBeNull();
  });

  it('tudo no horário é 100', () => {
    expect(percentualNoHorario({ atendimentos: 12, noHorario: 12 })).toBe(100);
  });
});

describe('as constantes são números escritos, não acidentes', () => {
  it('o limiar de divergência é a tolerância de pontualidade', () => {
    expect(LIMIAR_DE_DIVERGENCIA_MIN).toBe(TOLERANCIA_PONTUALIDADE_MIN);
  });

  /**
   * Os dois valores presos por LITERAL, e não pela própria constante.
   *
   * Todo teste acima monta o cenário a partir de `AMOSTRA_MINIMA`, o que está certo
   * para provar o comportamento no limite — e é cego para o limite MUDAR: baixar a
   * constante para 7 move o cenário junto e nenhum teste reclama. Foi o que
   * aconteceu aqui, e é a mesma família de falso-verde do gradiente da identidade.
   *
   * Oito amostras e dez minutos são decisão de produto, não detalhe de
   * implementação: quem quiser mexer tem de mexer nesta linha e explicar por quê.
   */
  it('a amostra mínima é 8 e o limiar é 10 minutos', () => {
    expect(AMOSTRA_MINIMA).toBe(8);
    expect(TOLERANCIA_PONTUALIDADE_MIN).toBe(10);
  });

  /** A grade de cinco minutos é a da agenda da clínica, e arredonda para cima. */
  it('a grade da agenda é de 5 minutos', () => {
    expect(GRADE_DA_AGENDA_MIN).toBe(5);
    expect(SUGESTAO_PADRAO).toEqual({
      amostraMinima: AMOSTRA_MINIMA,
      diferencaMinimaMin: LIMIAR_DE_DIVERGENCIA_MIN,
      arredondarPara: GRADE_DA_AGENDA_MIN,
    });
  });
});
