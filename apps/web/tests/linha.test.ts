import { describe, expect, it } from 'vitest';
import { hhmm, janelaDoDia, largura, marcasDeHora, pct } from '../lib/linha';

const SP = 'America/Sao_Paulo';
const em = (hora: string): number => Date.parse(`2026-03-10T${hora}:00-03:00`);

describe('janelaDoDia', () => {
  it('cobre o primeiro e o último bloco, com margem dos dois lados', () => {
    const j = janelaDoDia(
      [
        { inicioMs: em('09:00'), fimMs: em('10:00') },
        { inicioMs: em('16:00'), fimMs: em('17:00') },
      ],
      em('12:00'),
    );
    expect(j.inicioMs).toBe(em('08:30'));
    expect(j.fimMs).toBe(em('17:30'));
  });

  it('inclui o agora mesmo quando ele está fora dos blocos', () => {
    const j = janelaDoDia([{ inicioMs: em('14:00'), fimMs: em('15:00') }], em('08:00'));
    expect(j.inicioMs).toBe(em('07:30'));
    expect(pct(em('08:00'), j)).toBeGreaterThan(0);
  });

  it('dia sem consulta ainda tem faixa de seis horas', () => {
    const j = janelaDoDia([], em('10:00'));
    expect((j.fimMs - j.inicioMs) / 3_600_000).toBe(6);
  });

  it('um bloco só não vira uma faixa de uma hora', () => {
    const j = janelaDoDia([{ inicioMs: em('10:00'), fimMs: em('11:00') }], em('10:30'));
    expect((j.fimMs - j.inicioMs) / 3_600_000).toBe(6);
  });
});

describe('pct', () => {
  const j = { inicioMs: em('08:00'), fimMs: em('18:00') };

  it('põe o meio da faixa em 50%', () => {
    expect(pct(em('13:00'), j)).toBe(50);
  });

  it('gruda na borda em vez de sair da faixa', () => {
    expect(pct(em('06:00'), j)).toBe(0);
    expect(pct(em('23:00'), j)).toBe(100);
  });

  it('faixa de largura zero não vira divisão por zero', () => {
    expect(pct(em('10:00'), { inicioMs: em('10:00'), fimMs: em('10:00') })).toBe(0);
  });
});

describe('largura', () => {
  const j = { inicioMs: em('08:00'), fimMs: em('18:00') };

  it('uma hora em dez horas ocupa 10%', () => {
    expect(largura(3_600_000, j)).toBe(10);
  });

  it('consulta curta ainda aparece: nunca largura zero', () => {
    expect(largura(0, j)).toBeGreaterThan(0);
  });

  it('não passa de 100%', () => {
    expect(largura(40 * 3_600_000, j)).toBe(100);
  });
});

describe('marcasDeHora', () => {
  it('marca as horas cheias no relógio da clínica', () => {
    const marcas = marcasDeHora({ inicioMs: em('08:30'), fimMs: em('11:30') }, SP);
    expect(marcas.map((m) => m.rotulo)).toEqual(['09:00', '10:00', '11:00']);
  });

  it('a hora é a da clínica, não a do servidor', () => {
    // O mesmo instante é 09:00 em São Paulo e 08:00 em Manaus.
    expect(hhmm(em('09:00'), SP)).toBe('09:00');
    expect(hhmm(em('09:00'), 'America/Manaus')).toBe('08:00');
  });
});
