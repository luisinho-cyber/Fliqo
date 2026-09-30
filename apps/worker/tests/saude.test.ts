import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  criarBatimento,
  JANELA_DE_SAUDE_MS,
  servidorDeSaude,
  vereditoDeSaude,
  type Batimento,
} from '../src/saude';

/**
 * O health check do worker.
 *
 * Um `/health` que devolve 200 porque o processo existe é pior do que não ter:
 * ele afirma saúde enquanto o laço está travado, e worker travado em silêncio é o
 * pior caso deste produto — ninguém é confirmado e nada avisa.
 */

/** Batimento com relógio na mão: nada aqui depende do tempo passar de verdade. */
function batimentoEm(ms: number): Batimento {
  return { marcar: () => undefined, ultimo: () => ms };
}

describe('vereditoDeSaude', () => {
  it('laços batendo agora é saudável', () => {
    const v = vereditoDeSaude({ acoes: batimentoEm(1_000), atrasos: batimentoEm(1_000) }, 1_000);
    expect(v.ok).toBe(true);
    expect(v.lacos.acoes?.travado).toBe(false);
  });

  it('um laço travado basta para o serviço não estar saudável', () => {
    // O de atrasos bateu agora; o de ações está parado há mais que a janela.
    const agora = 10 * 60_000 + 5_000;
    const v = vereditoDeSaude({ acoes: batimentoEm(0), atrasos: batimentoEm(agora) }, agora);
    expect(v.ok).toBe(false);
    expect(v.lacos.acoes?.travado).toBe(true);
    // E o veredito diz QUAL travou: "não saudável" sem nome não ajuda ninguém.
    expect(v.lacos.atrasos?.travado).toBe(false);
  });

  it('dentro da janela, por pouco, ainda é saudável', () => {
    // Trabalhar devagar não é estar travado. Reiniciar aqui perderia trabalho bom.
    const agora = JANELA_DE_SAUDE_MS;
    const v = vereditoDeSaude({ acoes: batimentoEm(0) }, agora);
    expect(v.ok).toBe(true);
  });

  it('a janela é generosa de propósito: uma tentativa presa não tem teto nosso', () => {
    // O cliente da Meta não põe timeout de socket, então o teto de uma tentativa
    // é o do sistema operacional. Apertar esta janela sem resolver isso derruba o
    // worker no meio de um envio lento mas legítimo.
    expect(JANELA_DE_SAUDE_MS).toBeGreaterThanOrEqual(8 * 60_000);
  });

  it('o batimento nasce vivo: processo que acabou de subir não está travado', () => {
    const b = criarBatimento(() => 5_000);
    expect(vereditoDeSaude({ acoes: b }, 5_000).ok).toBe(true);
  });

  it('marcar renova a idade', () => {
    let relogio = 0;
    const b = criarBatimento(() => relogio);
    relogio = 20 * 60_000;
    expect(vereditoDeSaude({ acoes: b }, relogio).ok).toBe(false);
    b.marcar();
    expect(vereditoDeSaude({ acoes: b }, relogio).ok).toBe(true);
  });
});

describe('o servidor', () => {
  let fechar: (() => void) | undefined;
  afterEach(() => {
    fechar?.();
    fechar = undefined;
  });

  async function subir(batimentos: Record<string, Batimento>, agoraMs: number): Promise<string> {
    const servidor = servidorDeSaude({ porta: 0, batimentos, agora: () => agoraMs });
    fechar = () => servidor.close();
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  it('devolve 200 com os laços vivos', async () => {
    const base = await subir({ acoes: batimentoEm(1_000) }, 1_000);
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('devolve 503 com laço travado — é o código que faz o Railway reiniciar', async () => {
    const agora = 30 * 60_000;
    const base = await subir({ acoes: batimentoEm(0) }, agora);
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false });
  });

  it('qualquer outro caminho é 404: o worker não serve mais nada', async () => {
    const base = await subir({ acoes: batimentoEm(1_000) }, 1_000);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });

  it('a resposta não conta nada além da saúde dos laços', async () => {
    // Health check é público. Versão, variável de ambiente ou nome de clínica ali
    // é reconhecimento de graça para quem varre a internet.
    const base = await subir({ acoes: batimentoEm(1_000) }, 1_000);
    const corpo = await (await fetch(`${base}/health`)).text();
    expect(Object.keys(JSON.parse(corpo) as object).sort()).toEqual(['lacos', 'ok']);
  });
});
