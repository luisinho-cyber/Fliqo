import { describe, expect, it } from 'vitest';
import { centavosDoCampo, retornoDoCampo } from '../lib/formato';

/**
 * Reais digitados no campo para centavos inteiros.
 *
 * Existe porque é a borda em que dinheiro quase vira float. `Number('1234,56') * 100`
 * passa por 123455.99999999999 em alguns valores, e `toFixed` para cálculo é proibido
 * (CLAUDE.md, regra 1). Aqui os centavos são LIDOS como dígitos, não calculados — e é
 * este teste que prova que continua assim.
 */
describe('centavos do campo', () => {
  it('vírgula decimal, que é o que a clínica digita', () => {
    expect(centavosDoCampo('250,00')).toBe(25_000);
    expect(centavosDoCampo('1.234,56')).toBe(123_456);
    expect(centavosDoCampo('0,50')).toBe(50);
  });

  it('ponto decimal também, para quem digita no teclado numérico', () => {
    expect(centavosDoCampo('250.00')).toBe(25_000);
    expect(centavosDoCampo('3500.5')).toBe(350_050);
  });

  /**
   * O caso que separa milhar de decimal: "1.234" é mil duzentos e trinta e quatro reais,
   * não um real e vinte e três. Três dígitos depois do separador nunca são centavos.
   */
  it('separador de milhar não vira decimal', () => {
    expect(centavosDoCampo('1.234')).toBe(123_400);
    expect(centavosDoCampo('3.500')).toBe(350_000);
    expect(centavosDoCampo('1.234.567')).toBe(123_456_700);
  });

  it('inteiro sem separador é reais', () => {
    expect(centavosDoCampo('250')).toBe(25_000);
    expect(centavosDoCampo('0')).toBe(0);
  });

  it('um dígito depois da vírgula é dezena de centavo', () => {
    expect(centavosDoCampo('250,5')).toBe(25_050);
  });

  /** Campo vazio é zero, e "sem preço cadastrado" é um estado que a tela nomeia. */
  it('vazio é zero', () => {
    expect(centavosDoCampo('')).toBe(0);
    expect(centavosDoCampo('   ')).toBe(0);
  });

  it('todo resultado é inteiro, nunca float', () => {
    for (const entrada of ['0,07', '19,99', '1.999,99', '7,77', '0,01', '12.345,67']) {
      const c = centavosDoCampo(entrada);
      expect(Number.isSafeInteger(c), `${entrada} virou ${String(c)}`).toBe(true);
    }
  });

  it('os centavos saem exatos nos valores que o float erraria', () => {
    // 19,99 * 100 em ponto flutuante dá 1998.9999999999998.
    expect(centavosDoCampo('19,99')).toBe(1_999);
    expect(centavosDoCampo('1.234,57')).toBe(123_457);
    expect(centavosDoCampo('8,21')).toBe(821);
  });

  it('texto que não é número não vira preço aleatório', () => {
    expect(centavosDoCampo('abc')).toBe(0);
    expect(centavosDoCampo('-50')).toBe(0);
  });
});

describe('o campo de retorno', () => {
  it('vazio significa não pede retorno', () => {
    expect(retornoDoCampo('')).toEqual({ exige: false });
    expect(retornoDoCampo('   ')).toEqual({ exige: false });
  });

  it('número significa pede retorno naquele prazo', () => {
    expect(retornoDoCampo('15')).toEqual({ exige: true, emDias: 15 });
    expect(retornoDoCampo(' 180 ')).toEqual({ exige: true, emDias: 180 });
  });

  it('zero não é "não pede": é um prazo que a API vai recusar', () => {
    // Apagar o campo é como se diz "não pede". Digitar 0 é erro de digitação, e esconder
    // isso aqui faria o procedimento salvar sem o retorno que a pessoa quis cadastrar.
    expect(retornoDoCampo('0')).toEqual({ exige: true, emDias: 0 });
  });

  it('valor que não é número vai para a API como NaN, e é ela que nomeia o campo', () => {
    const r = retornoDoCampo('amanhã');
    expect(r.exige).toBe(true);
    expect(r.exige && Number.isNaN(r.emDias)).toBe(true);
  });
});
