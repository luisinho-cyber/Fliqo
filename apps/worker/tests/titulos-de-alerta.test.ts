import { describe, expect, it } from 'vitest';
import { quandoDaConsulta, tituloDeEnvioIncerto, tituloDeFalha } from '../src/titulos-de-alerta';

/**
 * O título do alerta é o que a recepção lê na tela Hoje. Ele diz QUEM e QUANDO, no fuso
 * da clínica, e nunca o nome interno da ação.
 */

const MARIA = {
  paciente: 'Maria Souza',
  // 17:30 UTC é 14:30 em São Paulo.
  inicio: new Date('2026-10-15T17:30:00Z'),
  fuso: 'America/Sao_Paulo',
};

const TIPOS = ['confirmacao', 'lembrete_final', 'marcar_risco', 'expirar_oferta'] as const;

describe('quando', () => {
  it('dia e hora no fuso da clínica, não em UTC', () => {
    expect(quandoDaConsulta(MARIA.inicio, MARIA.fuso)).toBe('15/10 às 14:30');
  });

  it('a virada do dia também segue o fuso', () => {
    // 01:00 UTC do dia 16 ainda é 22:00 do dia 15 em São Paulo.
    expect(quandoDaConsulta(new Date('2026-10-16T01:00:00Z'), MARIA.fuso)).toBe('15/10 às 22:00');
  });
});

describe('envio incerto', () => {
  it('diz o que, para quem e quando', () => {
    expect(tituloDeEnvioIncerto('confirmacao', MARIA)).toBe(
      'Não sei se a confirmação chegou para Maria Souza — consulta 15/10 às 14:30',
    );
    expect(tituloDeEnvioIncerto('lembrete_final', MARIA)).toBe(
      'Não sei se o lembrete chegou para Maria Souza — consulta 15/10 às 14:30',
    );
  });

  it('sem consulta achada, ainda é frase de gente', () => {
    expect(tituloDeEnvioIncerto('confirmacao', undefined)).toBe(
      'Não sei se a confirmação chegou ao paciente',
    );
  });
});

describe('falha definitiva', () => {
  it('diz o que, para quem e quando', () => {
    expect(tituloDeFalha('confirmacao', MARIA)).toBe(
      'Não consegui enviar a confirmação para Maria Souza — consulta 15/10 às 14:30',
    );
    expect(tituloDeFalha('marcar_risco', MARIA)).toBe(
      'Não consegui marcar em risco a consulta de Maria Souza — consulta 15/10 às 14:30',
    );
    expect(tituloDeFalha('expirar_oferta', undefined)).toBe(
      'Não consegui encerrar a oferta de vaga',
    );
  });
});

describe('nenhum título vaza o nome interno da ação', () => {
  it('com e sem consulta, em todos os tipos', () => {
    for (const tipo of TIPOS) {
      for (const c of [MARIA, undefined]) {
        for (const titulo of [tituloDeFalha(tipo, c), tituloDeEnvioIncerto(tipo, c)]) {
          for (const interno of TIPOS) expect(titulo, titulo).not.toContain(interno);
        }
      }
    }
  });
});
