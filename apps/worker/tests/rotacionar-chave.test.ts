import { randomBytes } from 'node:crypto';
import { criarDb, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { cifrar, decifrar } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rotacionar } from '../src/rotacionar-chave';

/**
 * A chave vive só em variável de ambiente. Trocar a variável sem recifrar
 * deixaria todos os tokens ilegíveis e todas as clínicas teriam que reconectar.
 */

const ANTIGA = randomBytes(32);
const NOVA = randomBytes(32);
const urlDono = process.env.DATABASE_ADMIN_URL ?? '';

let owner: pg.Pool;
let db: Db;
let c: Scenario;

/** A conexão do teste roda com a URL de dono trocada para o banco descartável. */
function urlDonoDoTeste(): string {
  const u = new URL(urlDoTester());
  u.username = 'postgres';
  u.password = 'postgres';
  return u.toString();
}

beforeAll(async () => {
  await resetDatabase();
  owner = ownerPool();
  c = await seed(owner);
  db = criarDb(urlDoTester());
}, 60_000);

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

beforeEach(async () => {
  await owner.query('delete from app.whatsapp_numbers');
});

async function guardarNumero(phoneNumberId: string, token: string, chave: Buffer): Promise<void> {
  const g = cifrar(token, chave);
  await owner.query(
    `insert into app.whatsapp_numbers
       (clinic_id, phone_number_id, status, token_ciphertext, token_iv, token_tag, token_updated_at)
     values ($1,$2,'conectado',$3,$4,$5, now())`,
    [c.clinicA, phoneNumberId, g.ciphertext, g.iv, g.tag],
  );
}

async function lerGuardado(phoneNumberId: string) {
  const { rows } = await owner.query<{
    token_ciphertext: Buffer;
    token_iv: Buffer;
    token_tag: Buffer;
  }>(
    `select token_ciphertext, token_iv, token_tag from app.whatsapp_numbers
      where phone_number_id = $1`,
    [phoneNumberId],
  );
  const l = rows[0]!;
  return { ciphertext: l.token_ciphertext, iv: l.token_iv, tag: l.token_tag };
}

describe('trocar a chave do token', () => {
  it('recifra todos os tokens: decifram com a nova e não com a antiga', async () => {
    await guardarNumero('PN-1', 'token-clinica-um', ANTIGA);
    await guardarNumero('PN-2', 'token-clinica-dois', ANTIGA);

    const resumo = await rotacionar(
      urlDonoDoTeste(),
      ANTIGA.toString('base64'),
      NOVA.toString('base64'),
    );

    expect(resumo).toEqual({ recifrados: 2, falharam: [] });
    expect(decifrar(await lerGuardado('PN-1'), NOVA)).toEqual({
      ok: true,
      token: 'token-clinica-um',
    });
    expect(decifrar(await lerGuardado('PN-2'), NOVA)).toEqual({
      ok: true,
      token: 'token-clinica-dois',
    });
    // A chave antiga não abre mais nada — é o ponto de trocar a chave.
    expect(decifrar(await lerGuardado('PN-1'), ANTIGA).ok).toBe(false);
  });

  it('um token ilegível não derruba a rotação nem é apagado', async () => {
    await guardarNumero('PN-BOM', 'token-bom', ANTIGA);
    // Cifrado com outra chave: a rotação não consegue abrir.
    await guardarNumero('PN-RUIM', 'token-perdido', randomBytes(32));

    const resumo = await rotacionar(
      urlDonoDoTeste(),
      ANTIGA.toString('base64'),
      NOVA.toString('base64'),
    );

    expect(resumo.recifrados).toBe(1);
    expect(resumo.falharam).toEqual(['PN-RUIM']);
    // O ruim continua lá para quem opera decidir o que fazer.
    const { rows } = await owner.query('select id from app.whatsapp_numbers');
    expect(rows).toHaveLength(2);
  });

  it('rodar de novo com a chave já trocada não estraga nada', async () => {
    await guardarNumero('PN-1', 'token-clinica-um', ANTIGA);
    await rotacionar(urlDonoDoTeste(), ANTIGA.toString('base64'), NOVA.toString('base64'));
    // Segunda passada, agora de NOVA para NOVA: continua decifrando.
    const segunda = await rotacionar(
      urlDonoDoTeste(),
      NOVA.toString('base64'),
      NOVA.toString('base64'),
    );
    expect(segunda.recifrados).toBe(1);
    expect(decifrar(await lerGuardado('PN-1'), NOVA)).toEqual({
      ok: true,
      token: 'token-clinica-um',
    });
  });

  it('chave do tamanho errado falha antes de tocar no banco', async () => {
    await guardarNumero('PN-1', 'token-clinica-um', ANTIGA);
    await expect(
      rotacionar(urlDonoDoTeste(), randomBytes(16).toString('base64'), NOVA.toString('base64')),
    ).rejects.toThrow(/32 bytes/);
    // Nada foi mexido.
    expect(decifrar(await lerGuardado('PN-1'), ANTIGA).ok).toBe(true);
  });

  it('exige as duas chaves', async () => {
    await expect(rotacionar(urlDono, undefined, NOVA.toString('base64'))).rejects.toThrow(
      /não definida/,
    );
  });
});
