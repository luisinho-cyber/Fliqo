import { describe, expect, it } from 'vitest';
import {
  decidirAvisos,
  esperandoDemais,
  pontualidade,
  projetarDia,
  sugerirDuracao,
  type ConsultaDoDia,
} from '../src';

const h = (hh: number, mm = 0) => new Date(Date.UTC(2026, 10, 10, hh, mm));

/** Dia da Dra. Ana: consultas de 40 min na agenda, mas o procedimento dura 55 de verdade. */
function dia(): ConsultaDoDia[] {
  const c = (id: string, ini: Date, extra: Partial<ConsultaDoDia> = {}): ConsultaDoDia => ({
    id,
    inicioAgendado: ini,
    fimAgendado: new Date(ini.getTime() + 40 * 60_000),
    duracaoEsperadaMin: 55,
    status: 'confirmado',
    ...extra,
  });
  return [
    c('c1', h(9), { iniciadaEm: h(9, 5) }),
    c('c2', h(9, 40), { pacienteChegouEm: h(9, 30) }),
    c('c3', h(10, 20)),
    c('c4', h(11, 30)), // buraco de 30 min antes dela absorve parte do atraso
    c('c5', h(16)), // fora da janela de aviso de 3h
  ];
}

describe('previsão de atraso em cascata', () => {
  const prev = projetarDia(dia(), h(9, 30));
  const atraso = Object.fromEntries(prev.map((p) => [p.id, p.atrasoMin]));

  it('acumula o atraso consulta a consulta', () => {
    expect(atraso).toEqual({ c1: 5, c2: 20, c3: 35, c4: 20, c5: 0 });
  });

  it('buraco na agenda absorve atraso', () => {
    expect(atraso.c4).toBeLessThan(atraso.c3!);
  });

  it('atendimento que passou do esperado empurra todos a partir de agora', () => {
    const p = projetarDia(dia(), h(10, 15)); // c1 ainda em sala às 10h15 (esperado 10h00)
    expect(p.find((x) => x.id === 'c2')!.inicioPrevisto).toEqual(h(10, 15));
  });

  it('consulta cancelada não entra na conta', () => {
    const d = dia();
    d[1]!.status = 'cancelado';
    const p = projetarDia(d, h(9, 30));
    expect(p.find((x) => x.id === 'c3')!.atrasoMin).toBe(0); // c1 termina 10h00, c3 é 10h20
  });
});

describe('quem avisar', () => {
  const consultas = dia();
  const agora = h(9, 30);
  const prev = projetarDia(consultas, agora);

  it('WhatsApp para quem ainda não saiu; recepção fala com quem já está na sala; ninguém fora da janela', () => {
    const avisos = decidirAvisos(consultas, prev, new Map(), agora);
    expect(avisos).toEqual([
      { para: 'recepcao', consultaId: 'c2', atrasoMin: 20, motivo: 'paciente_ja_na_sala' },
      { para: 'paciente', consultaId: 'c3', atrasoMin: 35, novoHorario: h(10, 55), tipo: 'atraso' },
      { para: 'paciente', consultaId: 'c4', atrasoMin: 20, novoHorario: h(11, 50), tipo: 'atraso' },
    ]);
  });

  it('não reavisa por variação pequena', () => {
    const avisos = decidirAvisos(
      consultas,
      prev,
      new Map([
        ['c3', 30],
        ['c4', 20],
        ['c2', 20],
      ]),
      agora,
    );
    expect(avisos).toEqual([]);
  });

  it('se o atraso some depois do aviso, avisa que pode vir no horário normal', () => {
    const normal = projetarDia(
      dia().map((c) => ({ ...c, duracaoEsperadaMin: 40 })),
      agora,
    );
    const avisos = decidirAvisos(consultas, normal, new Map([['c4', 20]]), agora);
    expect(avisos).toContainEqual({
      para: 'paciente',
      consultaId: 'c4',
      atrasoMin: 0,
      novoHorario: h(11, 30),
      tipo: 'normalizou',
    });
  });
});

describe('sala de espera e causa raiz', () => {
  it('alerta a recepção quando alguém espera 15 min ou mais após o horário', () => {
    expect(esperandoDemais(dia(), h(9, 58))).toEqual([{ consultaId: 'c2', esperandoMin: 18 }]);
  });

  it('sugere corrigir a duração do procedimento na agenda', () => {
    expect(sugerirDuracao([50, 55, 52, 60, 48, 55, 58, 53], 40)).toEqual({
      sugerir: true,
      novaDuracaoMin: 55,
      medianaMin: 54,
      amostra: 8,
    });
  });

  it('não sugere com pouca amostra nem por diferença pequena', () => {
    expect(sugerirDuracao([60, 60, 60], 40)).toEqual({ sugerir: false });
    expect(sugerirDuracao([44, 45, 46, 45, 44, 46, 45, 45], 40)).toEqual({ sugerir: false });
  });

  it('pontualidade do profissional', () => {
    expect(
      pontualidade([
        { id: 'a', inicioPrevisto: h(9), atrasoMin: 0, situacao: 'finalizada' },
        { id: 'b', inicioPrevisto: h(10), atrasoMin: 25, situacao: 'finalizada' },
      ]),
    ).toEqual({ atendimentos: 2, noHorarioPct: 50, atrasoMedioMin: 13 });
  });
});
