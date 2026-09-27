import { describe, expect, it } from 'vitest';
import {
  dataNoFuso,
  diaNoFuso,
  expedienteEmIntervalos,
  noFuso,
  somarDias,
  type FaixaDeExpediente,
} from '../src/index';

const SP = 'America/Sao_Paulo';

// 2026-11-09 é uma segunda-feira.
const SEMANA_COMERCIAL: FaixaDeExpediente[] = [
  { diaDaSemana: 1, de: '08:00', ate: '12:00' },
  { diaDaSemana: 1, de: '13:00', ate: '19:00' },
  { diaDaSemana: 6, de: '08:00', ate: '12:00' },
];

describe('expediente', () => {
  it('converte a hora da clínica para o instante certo, não a hora do servidor', () => {
    // São Paulo está 3 horas atrás de UTC (o Brasil não tem mais horário de verão).
    expect(noFuso('2026-11-09', '08:00', SP).toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(noFuso('2026-01-15', '08:00', SP).toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('respeita o fuso de cada clínica', () => {
    // Manaus fica uma hora atrás de São Paulo o ano todo.
    expect(noFuso('2026-11-09', '08:00', 'America/Manaus').toISOString()).toBe(
      '2026-11-09T12:00:00.000Z',
    );
  });

  it('monta só os blocos dos dias que a clínica atende', () => {
    // Sete dias a partir da segunda 09/11 vão até domingo 15/11: só a segunda
    // (dois blocos, com o almoço no meio) e o sábado têm faixa.
    const blocos = expedienteEmIntervalos(SEMANA_COMERCIAL, '2026-11-09', 7, SP);
    expect(blocos).toHaveLength(3);
    expect(blocos[0]?.inicio.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    expect(blocos[1]?.inicio.toISOString()).toBe('2026-11-09T16:00:00.000Z');
    expect(blocos[2]?.inicio.toISOString()).toBe('2026-11-14T11:00:00.000Z');
  });

  it('usa o dia da semana no fuso da clínica', () => {
    // 2026-11-09T00:30 em São Paulo ainda é 09/11 (segunda), mas 03:30Z do mesmo dia.
    // Se o cálculo usasse UTC, um bloco de domingo apareceria.
    const soDomingo: FaixaDeExpediente[] = [{ diaDaSemana: 0, de: '08:00', ate: '12:00' }];
    expect(expedienteEmIntervalos(soDomingo, '2026-11-09', 1, SP)).toEqual([]);
  });

  it('ignora faixa invertida em vez de criar um bloco negativo', () => {
    const invertida: FaixaDeExpediente[] = [{ diaDaSemana: 1, de: '19:00', ate: '08:00' }];
    expect(expedienteEmIntervalos(invertida, '2026-11-09', 1, SP)).toEqual([]);
  });

  it('somarDias atravessa o fim do mês', () => {
    expect(somarDias('2026-11-30', 1)).toBe('2026-12-01');
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('diaNoFuso', () => {
  it('o dia começa à meia-noite da clínica, não do servidor', () => {
    // 02:30 UTC de 11/03 ainda é 23:30 de 10/03 em São Paulo (UTC-3).
    const d = diaNoFuso(new Date('2026-03-11T02:30:00Z'), 'America/Sao_Paulo');
    expect(d.dataIso).toBe('2026-03-10');
    expect(d.inicio.toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(d.fim.toISOString()).toBe('2026-03-11T03:00:00.000Z');
  });

  it('Manaus vira o dia uma hora depois de São Paulo', () => {
    const instante = new Date('2026-03-11T03:30:00Z');
    expect(dataNoFuso(instante, 'America/Sao_Paulo')).toBe('2026-03-11'); // 00:30
    expect(dataNoFuso(instante, 'America/Manaus')).toBe('2026-03-10'); // 23:30
  });

  it('a janela cobre 24 h e não deixa buraco entre um dia e o seguinte', () => {
    const hoje = diaNoFuso(new Date('2026-07-15T15:00:00Z'), 'America/Sao_Paulo');
    const amanha = diaNoFuso(new Date('2026-07-16T15:00:00Z'), 'America/Sao_Paulo');
    expect(hoje.fim.getTime()).toBe(amanha.inicio.getTime());
  });
});
