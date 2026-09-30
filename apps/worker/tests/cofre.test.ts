import { randomBytes } from 'node:crypto';
import { criarDb, type Db } from '@fliqo/db';
import { ownerPool, resetDatabase, seed, urlDoTester, type Scenario } from '@fliqo/db/testing';
import { cifrar, type CofreDeTokens } from '@fliqo/whatsapp';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarCofre, TETO_DE_ENTRADAS, VALIDADE_MS } from '../src/cofre';

/**
 * O cofre de tokens de envio.
 *
 * Antes dele, o worker mandava tudo com um token único de ambiente e o token
 * cifrado da clínica não era usado por ninguém: conectar o WhatsApp guardava a
 * credencial e a mensagem continuava saindo pelo número da Fliqo.
 */

const CHAVE = randomBytes(32);

let owner: pg.Pool;
let db: Db;
let c: Scenario;
let relogio = 0;

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
  relogio = 1_000_000;
});

function cofre(opcoes: { teto?: number; validade?: number } = {}): CofreDeTokens {
  return criarCofre({
    db,
    chave: CHAVE,
    agora: () => relogio,
    ...(opcoes.teto === undefined ? {} : { tetoDeEntradas: opcoes.teto }),
    ...(opcoes.validade === undefined ? {} : { validadeMs: opcoes.validade }),
  });
}

async function conectar(
  clinicId: string,
  phoneNumberId: string,
  token: string,
  o: { chave?: Buffer; ativo?: boolean } = {},
): Promise<void> {
  const g = cifrar(token, o.chave ?? CHAVE);
  await owner.query(
    `insert into app.whatsapp_numbers
       (clinic_id, phone_number_id, status, active, token_ciphertext, token_iv, token_tag, token_updated_at)
     values ($1,$2,'conectado',$3,$4,$5,$6, now())`,
    [clinicId, phoneNumberId, o.ativo ?? true, g.ciphertext, g.iv, g.tag],
  );
}

/** Troca o token no banco por baixo do cofre, sem avisar ninguém. */
async function trocarNoBanco(phoneNumberId: string, token: string): Promise<void> {
  const g = cifrar(token, CHAVE);
  await owner.query(
    `update app.whatsapp_numbers
        set token_ciphertext=$2, token_iv=$3, token_tag=$4, token_updated_at=now()
      where phone_number_id=$1`,
    [phoneNumberId, g.ciphertext, g.iv, g.tag],
  );
}

describe('cada clínica tem o token dela', () => {
  it('dois números conectados devolvem dois tokens diferentes', async () => {
    await conectar(c.clinicA, 'PN-A', 'TOKEN-DA-A');
    await conectar(c.clinicB, 'PN-B', 'TOKEN-DA-B');
    const k = cofre();

    expect(await k.doNumero('PN-A')).toBe('TOKEN-DA-A');
    expect(await k.doNumero('PN-B')).toBe('TOKEN-DA-B');
  });

  it('número que ninguém conectou não tem token', async () => {
    expect(await cofre().doNumero('PN-QUE-NAO-EXISTE')).toBeUndefined();
  });

  /**
   * Desligado é desligado. `clinicaDoNumero` filtra `active`, então o cofre nem
   * chega a abrir transação — e sem token o envio falha definitivo, que é o que
   * "o dono desligou o WhatsApp" tem de significar.
   */
  it('número desativado não tem token, mesmo com o token ainda gravado', async () => {
    await conectar(c.clinicA, 'PN-OFF', 'TOKEN-ORFAO', { ativo: false });
    expect(await cofre().doNumero('PN-OFF')).toBeUndefined();
  });

  it('chave que não decifra devolve undefined em vez de estourar', async () => {
    // É o estado de quem trocou WHATSAPP_TOKEN_KEY sem rodar a recifragem: a
    // clínica precisa reconectar, e o envio falha em vez de derrubar o worker.
    await conectar(c.clinicA, 'PN-CHAVE-ERRADA', 'TOKEN', { chave: randomBytes(32) });
    expect(await cofre().doNumero('PN-CHAVE-ERRADA')).toBeUndefined();
  });
});

describe('cache', () => {
  it('não vai ao banco de novo dentro da validade', async () => {
    await conectar(c.clinicA, 'PN-A', 'TOKEN-1');
    const k = cofre();
    expect(await k.doNumero('PN-A')).toBe('TOKEN-1');

    await trocarNoBanco('PN-A', 'TOKEN-2');
    expect(await k.doNumero('PN-A'), 'leu o banco quando devia servir do cache').toBe('TOKEN-1');
  });

  it('relê depois da validade', async () => {
    await conectar(c.clinicA, 'PN-A', 'TOKEN-1');
    const k = cofre();
    await k.doNumero('PN-A');
    await trocarNoBanco('PN-A', 'TOKEN-2');

    relogio += VALIDADE_MS + 1;
    expect(await k.doNumero('PN-A')).toBe('TOKEN-2');
  });

  /**
   * É este o gancho que a renovação por credencial recusada usa. Sem ele, um token
   * trocado ficaria velho em memória até a validade vencer — e a ação da clínica
   * queimaria nesse meio-tempo.
   */
  it('esquecer derruba a entrada antes da validade', async () => {
    await conectar(c.clinicA, 'PN-A', 'TOKEN-1');
    const k = cofre();
    await k.doNumero('PN-A');
    await trocarNoBanco('PN-A', 'TOKEN-2');

    k.esquecer('PN-A');
    expect(await k.doNumero('PN-A')).toBe('TOKEN-2');
  });

  it('esquecer um número não derruba o do vizinho', async () => {
    await conectar(c.clinicA, 'PN-A', 'TOKEN-DA-A');
    await conectar(c.clinicB, 'PN-B', 'TOKEN-DA-B');
    const k = cofre();
    await k.doNumero('PN-A');
    await k.doNumero('PN-B');

    await trocarNoBanco('PN-A', 'NOVO-DA-A');
    await trocarNoBanco('PN-B', 'NOVO-DA-B');
    k.esquecer('PN-A');

    expect(await k.doNumero('PN-A')).toBe('NOVO-DA-A');
    expect(await k.doNumero('PN-B'), 'derrubou a entrada errada').toBe('TOKEN-DA-B');
  });

  it('esquecer número que nunca entrou no cofre não faz nada', () => {
    expect(() => {
      cofre().esquecer('PN-NUNCA-VISTO');
    }).not.toThrow();
  });
});

describe('o teto de entradas', () => {
  it('passando do teto, a entrada mais antiga sai', async () => {
    // Cada entrada é um token EM CLARO em memória: o teto é quantas credenciais
    // um dump de heap exporia de uma vez.
    await conectar(c.clinicA, 'PN-A', 'TOKEN-DA-A');
    await conectar(c.clinicB, 'PN-B', 'TOKEN-DA-B');
    const k = cofre({ teto: 1 });

    await k.doNumero('PN-A');
    await k.doNumero('PN-B'); // empurra PN-A para fora

    await trocarNoBanco('PN-A', 'NOVO-DA-A');
    expect(await k.doNumero('PN-A'), 'PN-A devia ter saído do cofre').toBe('NOVO-DA-A');
  });

  it('o teto é um número escrito, não o infinito', () => {
    // Guarda contra alguém "simplificar" o cofre tirando o teto: sem ele, a
    // memória cresce com o número de clínicas.
    expect(TETO_DE_ENTRADAS).toBeGreaterThan(0);
    expect(TETO_DE_ENTRADAS).toBeLessThanOrEqual(256);
  });

  it('a validade existe e é curta', () => {
    expect(VALIDADE_MS).toBeGreaterThan(0);
    expect(VALIDADE_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
