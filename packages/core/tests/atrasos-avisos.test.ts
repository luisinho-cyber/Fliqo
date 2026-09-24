import { describe, expect, it } from 'vitest';
import { duracaoParaProjecao, respeitarLimiteDeAvisos, type Aviso } from '../src/index';

describe('duração usada na projeção', () => {
  it('usa a mediana medida quando a amostra é suficiente', () => {
    expect(duracaoParaProjecao({ medianaMin: 55, amostra: 34 }, 40)).toBe(55);
  });

  it('ignora a mediana com amostra pequena: um caso fora da curva viraria verdade', () => {
    expect(duracaoParaProjecao({ medianaMin: 90, amostra: 3 }, 40)).toBe(40);
  });

  it('sem medida nenhuma, vale a agenda', () => {
    expect(duracaoParaProjecao(undefined, 40)).toBe(40);
  });

  it('arredonda a mediana: minuto quebrado não ajuda ninguém', () => {
    expect(duracaoParaProjecao({ medianaMin: 47.5, amostra: 10 }, 40)).toBe(48);
  });

  it('o limite da amostra é configurável, e 8 é a borda', () => {
    expect(duracaoParaProjecao({ medianaMin: 55, amostra: 8 }, 40)).toBe(55);
    expect(duracaoParaProjecao({ medianaMin: 55, amostra: 7 }, 40)).toBe(40);
  });
});

describe('teto de avisos por consulta', () => {
  const paraPaciente = (consultaId: string): Aviso => ({
    para: 'paciente',
    consultaId,
    atrasoMin: 20,
    novoHorario: new Date('2026-11-09T17:20:00Z'),
    tipo: 'atraso',
  });
  const paraRecepcao = (consultaId: string): Aviso => ({
    para: 'recepcao',
    consultaId,
    atrasoMin: 20,
    motivo: 'paciente_ja_na_sala',
  });

  it('deixa passar enquanto não chegou ao teto', () => {
    const avisos = [paraPaciente('c1')];
    expect(respeitarLimiteDeAvisos(avisos, new Map([['c1', 2]]))).toEqual(avisos);
  });

  it('corta o quarto aviso da mesma consulta', () => {
    expect(respeitarLimiteDeAvisos([paraPaciente('c1')], new Map([['c1', 3]]))).toEqual([]);
  });

  it('o teto é por consulta, não por clínica', () => {
    const avisos = [paraPaciente('c1'), paraPaciente('c2')];
    expect(respeitarLimiteDeAvisos(avisos, new Map([['c1', 3]]))).toEqual([paraPaciente('c2')]);
  });

  it('alerta de recepção não gasta a cota do paciente', () => {
    // O alerta é interno: não chega no celular de ninguém.
    const avisos = [paraRecepcao('c1')];
    expect(respeitarLimiteDeAvisos(avisos, new Map([['c1', 9]]))).toEqual(avisos);
  });

  it('o "normalizou" também respeita o teto', () => {
    const normalizou: Aviso = {
      para: 'paciente',
      consultaId: 'c1',
      atrasoMin: 0,
      novoHorario: new Date('2026-11-09T17:00:00Z'),
      tipo: 'normalizou',
    };
    expect(respeitarLimiteDeAvisos([normalizou], new Map([['c1', 3]]))).toEqual([]);
  });
});
