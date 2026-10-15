import { describe, expect, it } from 'vitest';
import { ClienteMeta, type CofreDeTokens } from '../src/index';
import type { Relogio } from '../src/limite';

/**
 * Rede ruim no envio: o que repete e o que não repete.
 *
 * Repetir só é seguro quando o pedido com certeza NÃO saiu. Conexão que caiu ou tempo
 * esgotado depois de o pedido sair podem ter deixado a mensagem aceita — e repetir é a
 * mesma confirmação duas vezes no celular do paciente.
 */

const RELOGIO_PARADO: Relogio = { agora: () => 0, esperar: () => Promise.resolve() };
const COFRE: CofreDeTokens = {
  doNumero: () => Promise.resolve('TOKEN-FALSO'),
  esquecer: () => undefined,
};
const ENVIO = { phoneNumberId: '555000111222', paraE164: '+5511999990001', template: 't' };

/** Falha de rede como o `fetch` do Node a produz: TypeError com o código na causa. */
function falhaDeRede(codigo: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(codigo), { code: codigo }),
  });
}

function cliente(buscar: typeof fetch, timeoutMs?: number): ClienteMeta {
  return new ClienteMeta({
    cofre: COFRE,
    relogio: RELOGIO_PARADO,
    buscar,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Um `fetch` que conta as chamadas e responde sempre a mesma coisa. */
function contando(responder: (init?: RequestInit) => Promise<Response>) {
  const chamadas: (RequestInit | undefined)[] = [];
  const buscar: typeof fetch = (_url, init) => {
    chamadas.push(init);
    return responder(init);
  };
  return { buscar, chamadas };
}

describe('conexão que nem abriu: o pedido não saiu, repetir é seguro', () => {
  for (const codigo of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    it(`${codigo} repete as quatro vezes`, async () => {
      const m = contando(() => Promise.reject(falhaDeRede(codigo)));
      const r = await cliente(m.buscar).enviarTemplate(ENVIO);
      expect(m.chamadas).toHaveLength(4);
      expect(r).toMatchObject({ ok: false, motivo: 'temporario' });
    });
  }
});

describe('conexão que caiu depois de o pedido sair: NÃO repete', () => {
  for (const codigo of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) {
    it(`${codigo} é incerto, com uma chamada só`, async () => {
      const m = contando(() => Promise.reject(falhaDeRede(codigo)));
      const r = await cliente(m.buscar).enviarTemplate(ENVIO);
      expect(m.chamadas).toHaveLength(1);
      expect(r).toMatchObject({ ok: false, motivo: 'incerto' });
    });
  }

  it('falha sem código conhecido também é incerta: na dúvida, não duplica', async () => {
    const m = contando(() => Promise.reject(new Error('algo estranho')));
    const r = await cliente(m.buscar).enviarTemplate(ENVIO);
    expect(m.chamadas).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, motivo: 'incerto' });
  });
});

describe('a Meta respondeu 2xx, mas não deu para ler o wamid', () => {
  it('corpo ilegível num 200 é incerto, sem repetir: 2xx é aceite', async () => {
    const m = contando(() => Promise.resolve(new Response('<html>oops', { status: 200 })));
    const r = await cliente(m.buscar).enviarTemplate(ENVIO);
    expect(m.chamadas).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, motivo: 'incerto' });
  });

  it('200 sem wamid também', async () => {
    const m = contando(() => Promise.resolve(new Response('{}', { status: 200 })));
    const r = await cliente(m.buscar).enviarTemplate(ENVIO);
    expect(m.chamadas).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, motivo: 'incerto' });
  });
});

describe('o que já era continua', () => {
  it('503 repete as quatro vezes', async () => {
    const m = contando(() => Promise.resolve(new Response('{}', { status: 503 })));
    const r = await cliente(m.buscar).enviarTemplate(ENVIO);
    expect(m.chamadas).toHaveLength(4);
    expect(r).toMatchObject({ ok: false, motivo: 'temporario' });
  });

  it('503 com corpo ilegível também: o código é que decide', async () => {
    const m = contando(() => Promise.resolve(new Response('<html>', { status: 503 })));
    expect(await cliente(m.buscar).enviarTemplate(ENVIO)).toMatchObject({ motivo: 'temporario' });
    expect(m.chamadas).toHaveLength(4);
  });

  it('200 com wamid é sucesso', async () => {
    const m = contando(() =>
      Promise.resolve(new Response('{"messages":[{"id":"wamid.OK"}]}', { status: 200 })),
    );
    expect(await cliente(m.buscar).enviarTemplate(ENVIO)).toEqual({ ok: true, wamid: 'wamid.OK' });
  });
});

describe('timeout', () => {
  /** Pendura como um pedido de verdade: só termina quando o sinal aborta. */
  function pendurado(init?: RequestInit): Promise<Response> {
    return new Promise((_resolve, rejeitar) => {
      init?.signal?.addEventListener('abort', () => {
        const motivo: unknown = init.signal?.reason;
        rejeitar(motivo instanceof Error ? motivo : new Error('abortado'));
      });
    });
  }

  it('pedido pendurado termina no teto, como incerto, sem repetir', async () => {
    // Sem o teto, este teste esperaria para sempre — como o worker esperava pelo sistema
    // operacional, na casa dos minutos, e depois repetia.
    const m = contando(pendurado);
    const inicio = Date.now();
    const r = await cliente(m.buscar, 50).enviarTemplate(ENVIO);
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(m.chamadas).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, motivo: 'incerto' });
  });

  it('todo pedido sai com sinal de teto', async () => {
    const m = contando(() =>
      Promise.resolve(new Response('{"messages":[{"id":"wamid.OK"}]}', { status: 200 })),
    );
    await cliente(m.buscar).enviarTemplate(ENVIO);
    expect(m.chamadas[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
