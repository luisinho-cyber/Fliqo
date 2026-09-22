import { describe, expect, it } from 'vitest';
import { normalizarTelefoneBR, mesmoTelefone } from '../src/telefone';

/**
 * O caso que motiva isto: a Meta entrega o telefone de formas diferentes, e sem
 * normalizar o mesmo paciente vira duas fichas.
 */
describe('normalizarTelefoneBR', () => {
  it('aceita celular com 9, com e sem +55', () => {
    expect(normalizarTelefoneBR('+5511987654321')).toEqual({ ok: true, e164: '+5511987654321' });
    expect(normalizarTelefoneBR('5511987654321')).toEqual({ ok: true, e164: '+5511987654321' });
    expect(normalizarTelefoneBR('11987654321')).toEqual({ ok: true, e164: '+5511987654321' });
  });

  it('põe o 9 no celular que chegou sem ele', () => {
    // É assim que a Meta costuma devolver wa_id de número brasileiro antigo.
    expect(normalizarTelefoneBR('+551187654321')).toEqual({ ok: true, e164: '+5511987654321' });
    expect(normalizarTelefoneBR('551187654321')).toEqual({ ok: true, e164: '+5511987654321' });
    expect(normalizarTelefoneBR('1187654321')).toEqual({ ok: true, e164: '+5511987654321' });
  });

  it('as duas formas do mesmo celular viram exatamente o mesmo E.164', () => {
    const com = normalizarTelefoneBR('5511987654321');
    const sem = normalizarTelefoneBR('551187654321');
    expect(com.ok && sem.ok && com.e164 === sem.e164).toBe(true);
  });

  it('não inventa 9 em telefone fixo', () => {
    // Fixo tem 8 dígitos e começa com 2 a 5. Virar 9xxxx quebraria o número.
    expect(normalizarTelefoneBR('+551133334444')).toEqual({ ok: true, e164: '+551133334444' });
    expect(normalizarTelefoneBR('1133334444')).toEqual({ ok: true, e164: '+551133334444' });
  });

  it('ignora máscara de digitação', () => {
    expect(normalizarTelefoneBR('(11) 98765-4321')).toEqual({ ok: true, e164: '+5511987654321' });
    expect(normalizarTelefoneBR('+55 (11) 8765-4321')).toEqual({
      ok: true,
      e164: '+5511987654321',
    });
  });

  it('preserva número estrangeiro sem mexer', () => {
    expect(normalizarTelefoneBR('+14155552671')).toEqual({ ok: true, e164: '+14155552671' });
  });

  it('recusa o que não dá para salvar, em vez de gravar lixo', () => {
    expect(normalizarTelefoneBR('')).toEqual({ ok: false, motivo: 'vazio' });
    expect(normalizarTelefoneBR('abc')).toEqual({ ok: false, motivo: 'vazio' });
    expect(normalizarTelefoneBR('11999')).toEqual({ ok: false, motivo: 'curto_demais' });
    // 20 não é DDD de lugar nenhum (99 é Maranhão, e vale).
    expect(normalizarTelefoneBR('+5520987654321')).toEqual({ ok: false, motivo: 'ddd_invalido' });
    expect(normalizarTelefoneBR('+5599987654321')).toEqual({ ok: true, e164: '+5599987654321' });
  });
});

describe('mesmoTelefone', () => {
  it('reconhece o mesmo número escrito de jeitos diferentes', () => {
    expect(mesmoTelefone('+5511987654321', '551187654321')).toBe(true);
    expect(mesmoTelefone('(11) 98765-4321', '+55 11 8765 4321')).toBe(true);
  });

  it('não confunde números diferentes', () => {
    expect(mesmoTelefone('+5511987654321', '+5511987654322')).toBe(false);
    expect(mesmoTelefone('+5511987654321', '+5521987654321')).toBe(false);
  });
});
