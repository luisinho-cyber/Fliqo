import { describe, expect, it } from 'vitest';
import { CORTE_DE_FRESCOR_DIAS, diaEMes, diasDeCalendario, lerQualidade } from '../lib/qualidade';

/**
 * A regra dos dois estados, testada onde ela mora: numa função pura.
 *
 * O que está em jogo não é formatação. É a tela não dizer "verde" sobre um dado
 * de três meses atrás — e o teste que prova isso é o que impede alguém de, mais
 * tarde, "melhorar" a tela mostrando o valor com uma ressalva ao lado.
 */

const SP = 'America/Sao_Paulo';
const agora = Date.parse('2026-09-30T14:00:00-03:00');
const menosDias = (n: number): string => new Date(agora - n * 86_400_000).toISOString();

describe('leitura fresca', () => {
  it('o valor é o protagonista e a idade vem junto', () => {
    expect(lerQualidade('verde', menosDias(3), agora, SP)).toEqual({
      estado: 'recente',
      rotulo: 'Verde',
      tom: 'ok',
      idade: 'apurado há 3 dias',
    });
  });

  it('hoje e ontem se escrevem como gente escreve', () => {
    expect(lerQualidade('amarelo', menosDias(0), agora, SP)).toMatchObject({
      idade: 'apurado hoje',
      rotulo: 'Amarelo',
      tom: 'atencao',
    });
    expect(lerQualidade('vermelho', menosDias(1), agora, SP)).toMatchObject({
      idade: 'apurado ontem',
      tom: 'risco',
    });
  });

  it('no corte exato ainda é fresca', () => {
    const r = lerQualidade('verde', menosDias(CORTE_DE_FRESCOR_DIAS), agora, SP);
    expect(r.estado).toBe('recente');
  });
});

describe('leitura velha', () => {
  it('um dia depois do corte o valor desaparece', () => {
    const r = lerQualidade('verde', menosDias(CORTE_DE_FRESCOR_DIAS + 1), agora, SP);
    expect(r).toEqual({ estado: 'antiga', data: '22/09', idade: 'há 8 dias' });
  });

  /**
   * O ponto do produto, escrito como teste: verde de noventa dias atrás não
   * chega à tela nem como rótulo, nem como tom, nem em letra miúda.
   */
  it('o rótulo e o tom não sobram em lugar nenhum do resultado', () => {
    const r = lerQualidade('verde', menosDias(92), agora, SP);
    expect(r.estado).toBe('antiga');
    const tudo = JSON.stringify(r);
    expect(tudo).not.toContain('Verde');
    expect(tudo).not.toContain('ok');
    expect(r).toMatchObject({ data: '30/06', idade: 'há 92 dias' });
  });
});

describe('sem leitura', () => {
  it('valor sem carimbo, carimbo sem valor e data impossível caem no mesmo lugar', () => {
    expect(lerQualidade('verde', null, agora, SP)).toEqual({ estado: 'sem_leitura' });
    expect(lerQualidade(null, menosDias(1), agora, SP)).toEqual({ estado: 'sem_leitura' });
    expect(lerQualidade('verde', 'nem-data-isso', agora, SP)).toEqual({ estado: 'sem_leitura' });
  });

  it('"ainda sem nota" da Meta é leitura, e aparece como tal', () => {
    // 'desconhecida' é o que a Meta manda para número novo. É informação: o
    // número existe e ainda não foi classificado. Sumir com isso faria a tela
    // parecer quebrada.
    expect(lerQualidade('desconhecida', menosDias(2), agora, SP)).toMatchObject({
      estado: 'recente',
      rotulo: 'Ainda sem nota',
      tom: 'neutro',
    });
  });
});

describe('a idade conta dias do calendário da clínica', () => {
  it('trinta horas atrás na virada do dia é "ontem", não "há 1 dia e pouco"', () => {
    // 23:00 de ontem no relógio de São Paulo, lido às 14:00 de hoje: 15 horas.
    const ontemTarde = Date.parse('2026-09-29T23:00:00-03:00');
    expect(diasDeCalendario(ontemTarde, agora, SP)).toBe(1);
    expect(lerQualidade('verde', new Date(ontemTarde).toISOString(), agora, SP)).toMatchObject({
      idade: 'apurado ontem',
    });
  });

  it('meia-noite e dez em São Paulo já é hoje, mesmo sendo ainda ontem em UTC', () => {
    // 03:10Z é 00:10 em São Paulo: mesmo dia da clínica que 14:00 local.
    const deMadrugada = Date.parse('2026-09-30T03:10:00Z');
    expect(diasDeCalendario(deMadrugada, agora, SP)).toBe(0);
  });

  it('apuração no futuro vale zero, não um número negativo', () => {
    // Relógio errado em algum lado não é informação sobre o número.
    expect(diasDeCalendario(agora + 5 * 86_400_000, agora, SP)).toBe(0);
    expect(lerQualidade('verde', menosDias(-5), agora, SP)).toMatchObject({
      estado: 'recente',
      idade: 'apurado hoje',
    });
  });

  it('o fuso é o da clínica, não o do servidor', () => {
    const instante = Date.parse('2026-06-12T02:30:00Z');
    // 02:30Z é 23:30 do dia 11 em São Paulo e 11:30 do dia 12 em Tóquio.
    expect(diaEMes(instante, SP)).toBe('11/06');
    expect(diaEMes(instante, 'Asia/Tokyo')).toBe('12/06');
  });
});
