import { describe, expect, it } from 'vitest';
import { mancheteDoDia, vagasEntreAtendimentos, type ValorDaConsulta } from '../src/hoje';

const em = (hhmm: string): Date => new Date(`2026-03-10T${hhmm}:00-03:00`);

describe('mancheteDoDia', () => {
  it('conta e soma só o que ainda vale no dia', () => {
    const consultas: ValorDaConsulta[] = [
      { status: 'confirmado', precoCents: 25000 },
      { status: 'agendado', precoCents: 30000 },
      { status: 'realizado', precoCents: 12000 },
      { status: 'cancelado', precoCents: 99900 },
      { status: 'faltou', precoCents: 88800 },
    ];
    expect(mancheteDoDia(consultas)).toEqual({
      quantidade: 3,
      naAgendaCents: 67000,
      semConfirmacaoCents: 30000,
    });
  });

  it('trata em_risco como ainda sem confirmação', () => {
    const m = mancheteDoDia([{ status: 'em_risco', precoCents: 45000 }]);
    expect(m.semConfirmacaoCents).toBe(45000);
    expect(m.naAgendaCents).toBe(45000);
  });

  it('não conta o que já foi realizado como sem confirmação', () => {
    const m = mancheteDoDia([{ status: 'realizado', precoCents: 45000 }]);
    expect(m.semConfirmacaoCents).toBe(0);
  });

  it('dia vazio não vira NaN nem divisão', () => {
    expect(mancheteDoDia([])).toEqual({
      quantidade: 0,
      naAgendaCents: 0,
      semConfirmacaoCents: 0,
    });
  });
});

describe('vagasEntreAtendimentos', () => {
  it('acha o buraco entre dois atendimentos', () => {
    const vagas = vagasEntreAtendimentos([
      { inicio: em('09:00'), fim: em('10:00') },
      { inicio: em('11:00'), fim: em('12:00') },
    ]);
    expect(vagas).toEqual([{ inicio: em('10:00'), fim: em('11:00') }]);
  });

  it('ignora folga menor que o mínimo', () => {
    const vagas = vagasEntreAtendimentos([
      { inicio: em('09:00'), fim: em('10:00') },
      { inicio: em('10:10'), fim: em('11:00') },
    ]);
    expect(vagas).toEqual([]);
  });

  it('não inventa vaga antes do primeiro nem depois do último', () => {
    expect(vagasEntreAtendimentos([{ inicio: em('09:00'), fim: em('10:00') }])).toEqual([]);
    expect(vagasEntreAtendimentos([])).toEqual([]);
  });

  it('ordena antes de comparar: a ordem da consulta não é garantida', () => {
    const vagas = vagasEntreAtendimentos([
      { inicio: em('14:00'), fim: em('15:00') },
      { inicio: em('09:00'), fim: em('10:00') },
    ]);
    expect(vagas).toEqual([{ inicio: em('10:00'), fim: em('14:00') }]);
  });

  it('atendimento contido dentro de outro não abre vaga falsa', () => {
    // O bloco longo já cobre o curto: o fim que vale é o mais distante.
    const vagas = vagasEntreAtendimentos([
      { inicio: em('09:00'), fim: em('12:00') },
      { inicio: em('09:30'), fim: em('10:00') },
      { inicio: em('13:00'), fim: em('14:00') },
    ]);
    expect(vagas).toEqual([{ inicio: em('12:00'), fim: em('13:00') }]);
  });
});
