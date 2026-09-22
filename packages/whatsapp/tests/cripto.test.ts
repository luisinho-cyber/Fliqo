import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cifrar, decifrar, lerChave, segredosIguais } from '../src/cripto';

const chave = randomBytes(32);

describe('cifragem do token', () => {
  it('o que cifra, decifra', () => {
    expect(decifrar(cifrar('EAAG-token-da-clinica', chave), chave)).toEqual({
      ok: true,
      token: 'EAAG-token-da-clinica',
    });
  });

  it('o mesmo token cifrado duas vezes dá resultados diferentes', () => {
    // IV novo a cada vez: reusar IV em GCM quebra a cifra.
    const a = cifrar('mesmo-token', chave);
    const b = cifrar('mesmo-token', chave);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('ciphertext adulterado é recusado, não devolve lixo', () => {
    const guardado = cifrar('token-original', chave);
    const adulterado = Buffer.from(guardado.ciphertext);
    adulterado[0] = (adulterado[0] ?? 0) ^ 0xff;
    expect(decifrar({ ...guardado, ciphertext: adulterado }, chave)).toEqual({
      ok: false,
      motivo: 'adulterado',
    });
  });

  it('tag de autenticação trocada é recusada', () => {
    const guardado = cifrar('token-original', chave);
    expect(decifrar({ ...guardado, tag: randomBytes(16) }, chave)).toEqual({
      ok: false,
      motivo: 'adulterado',
    });
  });

  it('chave errada não decifra', () => {
    expect(decifrar(cifrar('token-original', chave), randomBytes(32)).ok).toBe(false);
  });
});

describe('leitura da chave', () => {
  it('aceita 32 bytes em base64', () => {
    expect(lerChave(chave.toString('base64')).length).toBe(32);
  });

  it('recusa ausente e do tamanho errado', () => {
    expect(() => lerChave(undefined)).toThrow(/não definida/);
    expect(() => lerChave(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('comparação de segredos', () => {
  it('iguais e diferentes', () => {
    expect(segredosIguais('abc', 'abc')).toBe(true);
    expect(segredosIguais('abc', 'abd')).toBe(false);
    expect(segredosIguais('abc', 'abcd')).toBe(false);
  });
});
