import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cifragem do token de acesso da clínica.
 *
 * O token permite enviar mensagem em nome da clínica. Em claro no banco, um
 * dump de backup viraria acesso ao WhatsApp de todas as clínicas de uma vez.
 *
 * AES-256-GCM e não CBC: o GCM autentica. Sem autenticação, quem tivesse acesso
 * de escrita ao banco poderia trocar o ciphertext e a decifragem devolveria
 * lixo em silêncio, em vez de falhar.
 *
 * IV novo a cada cifragem — reusar IV em GCM quebra a cifra, não só o sigilo.
 */

const ALGORITMO = 'aes-256-gcm';
const TAMANHO_IV = 12; // 96 bits, o recomendado para GCM
const TAMANHO_CHAVE = 32;

export interface TokenCifrado {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** Lê a chave do ambiente. Falha no start, não na hora de cifrar. */
export function lerChave(bruta: string | undefined): Buffer {
  if (bruta === undefined || bruta.length === 0) {
    throw new Error('WHATSAPP_TOKEN_KEY não definida — sem ela o token ficaria em claro.');
  }
  const chave = Buffer.from(bruta, 'base64');
  if (chave.length !== TAMANHO_CHAVE) {
    throw new Error(
      `WHATSAPP_TOKEN_KEY precisa ter ${TAMANHO_CHAVE} bytes em base64, tem ${chave.length}.`,
    );
  }
  return chave;
}

export function cifrar(token: string, chave: Buffer): TokenCifrado {
  const iv = randomBytes(TAMANHO_IV);
  const cifra = createCipheriv(ALGORITMO, chave, iv);
  const ciphertext = Buffer.concat([cifra.update(token, 'utf8'), cifra.final()]);
  return { ciphertext, iv, tag: cifra.getAuthTag() };
}

export type ResultadoDecifra = { ok: true; token: string } | { ok: false; motivo: 'adulterado' };

/**
 * Decifra. Falha é resposta, não exceção: token que não decifra significa chave
 * trocada ou banco adulterado, e quem chamou precisa marcar a conexão como
 * 'erro' e pedir reconexão em vez de estourar no meio de um envio.
 */
export function decifrar(guardado: TokenCifrado, chave: Buffer): ResultadoDecifra {
  try {
    const decifra = createDecipheriv(ALGORITMO, chave, guardado.iv);
    decifra.setAuthTag(guardado.tag);
    const token = Buffer.concat([decifra.update(guardado.ciphertext), decifra.final()]).toString(
      'utf8',
    );
    return { ok: true, token };
  } catch {
    // O GCM não distingue chave errada de adulteração — e não deveria.
    return { ok: false, motivo: 'adulterado' };
  }
}

/** Compara segredos sem vazar, pelo tempo, quantos bytes iniciais batem. */
export function segredosIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
