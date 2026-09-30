import { describe, expect, it } from 'vitest';
import { ClienteMeta, type CofreDeTokens } from '../src/index';
import type { Relogio } from '../src/limite';

/**
 * O token de envio é por clínica, e ele muda sem ninguém avisar: a clínica
 * reconecta, a Meta revoga, a chave de cifragem é rotacionada.
 *
 * Com token em cache e a régua de hoje — 401 vira `recusado`, e `recusado` não
 * repete —, um token que mudou entre a conexão e o envio QUEIMARIA a ação: a
 * confirmação do paciente morreria como falha definitiva por causa de uma
 * credencial velha em memória. É esse buraco que estes testes fecham.
 */

const RELOGIO_PARADO: Relogio = { agora: () => 0, esperar: () => Promise.resolve() };

/**
 * Cofre na mão, COM cache — como o de verdade.
 *
 * O cache é o que faz este teste valer: o cliente não guarda token nenhum, então
 * a defasagem que a renovação conserta mora no cofre. Um falso sem cache leria o
 * valor novo de primeira e provaria nada.
 */
function cofreFalso(fonte: Record<string, string | undefined>) {
  const cache = new Map<string, string | undefined>();
  const esquecidos: string[] = [];
  const cofre: CofreDeTokens = {
    doNumero: (phoneNumberId) => {
      if (!cache.has(phoneNumberId)) cache.set(phoneNumberId, fonte[phoneNumberId]);
      return Promise.resolve(cache.get(phoneNumberId));
    },
    esquecer: (phoneNumberId) => {
      esquecidos.push(phoneNumberId);
      cache.delete(phoneNumberId);
    },
  };
  return { cofre, esquecidos };
}

/** Meta falsa que só aceita os tokens que o teste declarar válidos. */
function metaFalsa(validos: () => string[]) {
  const vistos: { url: string; token: string }[] = [];
  const buscar: typeof fetch = (entrada, init) => {
    const url = entrada instanceof Request ? entrada.url : entrada.toString();
    const cabecalhos = new Headers(init?.headers);
    const token = (cabecalhos.get('authorization') ?? '').replace('Bearer ', '');
    vistos.push({ url, token });

    if (!validos().includes(token)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'Error validating access token', code: 190 } }),
          { status: 401 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }), { status: 200 }),
    );
  };
  return { buscar, vistos };
}

function envio(phoneNumberId = 'PN-A') {
  return { phoneNumberId, paraE164: '+5511999990000', template: 'confirmacao_consulta' };
}

describe('token trocado entre dois envios', () => {
  it('o segundo envio usa o token novo, sem falhar', async () => {
    const tokens: Record<string, string | undefined> = { 'PN-A': 'TOKEN-VELHO' };
    let aceitos = ['TOKEN-VELHO'];
    const { cofre, esquecidos } = cofreFalso(tokens);
    const meta = metaFalsa(() => aceitos);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio: RELOGIO_PARADO });

    // Primeiro envio: token em mão ainda vale.
    expect(await cliente.enviarTemplate(envio())).toMatchObject({ ok: true });

    // A clínica reconectou: a Meta passa a aceitar só o token novo, e o cofre já
    // sabe dele — o que está velho é a entrada em cache do cliente.
    aceitos = ['TOKEN-NOVO'];
    tokens['PN-A'] = 'TOKEN-NOVO';

    const r = await cliente.enviarTemplate(envio());
    expect(r, 'um token trocado não pode queimar a ação').toMatchObject({ ok: true });
    // Esqueceu uma vez e repetiu com o fresco: duas chamadas neste segundo envio.
    expect(esquecidos).toEqual(['PN-A']);
    expect(meta.vistos.map((v) => v.token)).toEqual(['TOKEN-VELHO', 'TOKEN-VELHO', 'TOKEN-NOVO']);
  });
});

describe('token de verdade inválido', () => {
  it('uma retentativa e para — não vira laço', async () => {
    const { cofre, esquecidos } = cofreFalso({ 'PN-A': 'TOKEN-MORTO' });
    const meta = metaFalsa(() => []);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio: RELOGIO_PARADO });

    const r = await cliente.enviarTemplate(envio());
    // Motivo próprio: é o que permite ao worker marcar o número em erro uma vez,
    // em vez de tratar como recusa comum e alertar por ação.
    expect(r).toMatchObject({ ok: false, motivo: 'credencial' });
    // Exatamente duas: a original e a renovada. Nem uma terceira, nem o backoff
    // de falha temporária — são coisas diferentes e não se somam.
    expect(meta.vistos).toHaveLength(2);
    expect(esquecidos).toEqual(['PN-A']);
  });

  it('a renovação não consome o orçamento de retentativa de instabilidade', async () => {
    // Se a renovação por credencial gastasse uma das quatro tentativas de rede, um
    // token trocado no meio de uma instabilidade perderia a mensagem duas vezes.
    let esperas = 0;
    const relogio: Relogio = {
      agora: () => 0,
      esperar: () => {
        esperas += 1;
        return Promise.resolve();
      },
    };
    const { cofre } = cofreFalso({ 'PN-A': 'TOKEN-MORTO' });
    const meta = metaFalsa(() => []);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio });

    await cliente.enviarTemplate(envio());
    expect(esperas, 'a renovação não dorme: ela é imediata').toBe(0);
  });
});

describe('sem token', () => {
  it('não chama a Meta e falha definitivo', async () => {
    const { cofre, esquecidos } = cofreFalso({});
    const meta = metaFalsa(() => ['qualquer']);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio: RELOGIO_PARADO });

    const r = await cliente.enviarTemplate(envio('PN-SEM-TOKEN'));
    // `credencial` e não `temporario`: repetir não cria credencial nenhuma.
    expect(r).toMatchObject({ ok: false, motivo: 'credencial' });
    expect(meta.vistos, 'gastou chamada de rede sem ter com que autenticar').toHaveLength(0);
    // Nem tentou renovar: sem token não há credencial velha para esquecer.
    expect(esquecidos).toEqual([]);
  });

  it('o "digitando" simplesmente não acontece, e não estoura', async () => {
    const { cofre } = cofreFalso({});
    const meta = metaFalsa(() => ['qualquer']);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio: RELOGIO_PARADO });

    await expect(
      cliente.marcarDigitando({ phoneNumberId: 'PN-A', wamidRecebido: 'wamid.X' }),
    ).resolves.toBeUndefined();
    expect(meta.vistos).toHaveLength(0);
  });
});

describe('cada clínica manda com a credencial dela', () => {
  it('dois números, dois tokens, na mesma instância do cliente', async () => {
    const { cofre } = cofreFalso({ 'PN-A': 'TOKEN-DA-A', 'PN-B': 'TOKEN-DA-B' });
    const meta = metaFalsa(() => ['TOKEN-DA-A', 'TOKEN-DA-B']);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio: RELOGIO_PARADO });

    await cliente.enviarTemplate(envio('PN-A'));
    await cliente.enviarTemplate(envio('PN-B'));

    expect(meta.vistos[0]?.token).toBe('TOKEN-DA-A');
    expect(meta.vistos[0]?.url).toContain('PN-A');
    expect(meta.vistos[1]?.token).toBe('TOKEN-DA-B');
    expect(meta.vistos[1]?.url).toContain('PN-B');
  });

  it('nenhum token vai na URL — ele vai no cabeçalho', async () => {
    const { cofre } = cofreFalso({ 'PN-A': 'TOKEN-DA-A' });
    const meta = metaFalsa(() => ['TOKEN-DA-A']);
    const cliente = new ClienteMeta({ cofre, buscar: meta.buscar, relogio: RELOGIO_PARADO });
    await cliente.enviarTemplate(envio('PN-A'));
    for (const v of meta.vistos) expect(v.url).not.toContain('TOKEN-DA-A');
  });
});

describe('o que conta como credencial recusada', () => {
  it('o código 190 conta, mesmo com status 400', async () => {
    // A Meta usa 400 com OAuthException 190 tanto quanto 401. Tratar só o status
    // deixaria metade dos tokens expirados virando falha definitiva sem renovar.
    let vezes = 0;
    const buscar: typeof fetch = () => {
      vezes += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'expirado', code: 190 } }), {
          status: 400,
        }),
      );
    };
    const { cofre, esquecidos } = cofreFalso({ 'PN-A': 'TOKEN-VELHO' });
    const cliente = new ClienteMeta({ cofre, buscar, relogio: RELOGIO_PARADO });

    await cliente.enviarTemplate(envio());
    expect(vezes).toBe(2);
    expect(esquecidos).toEqual(['PN-A']);
  });

  it('400 comum NÃO renova credencial: template errado não é token velho', async () => {
    let vezes = 0;
    const buscar: typeof fetch = () => {
      vezes += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'template inexistente', code: 132001 } }), {
          status: 400,
        }),
      );
    };
    const { cofre, esquecidos } = cofreFalso({ 'PN-A': 'TOKEN-BOM' });
    const cliente = new ClienteMeta({ cofre, buscar, relogio: RELOGIO_PARADO });

    const r = await cliente.enviarTemplate(envio());
    expect(r).toMatchObject({ ok: false, motivo: 'recusado' });
    expect(vezes, 'renovar credencial aqui só gastaria limite do número').toBe(1);
    expect(esquecidos).toEqual([]);
  });

  it('429 continua sendo temporário, e continua repetindo com backoff', async () => {
    let vezes = 0;
    const buscar: typeof fetch = () => {
      vezes += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'limite' } }), { status: 429 }),
      );
    };
    const { cofre, esquecidos } = cofreFalso({ 'PN-A': 'TOKEN-BOM' });
    const cliente = new ClienteMeta({ cofre, buscar, relogio: RELOGIO_PARADO });

    const r = await cliente.enviarTemplate(envio());
    expect(r).toMatchObject({ ok: false, motivo: 'temporario' });
    expect(vezes).toBe(4);
    expect(esquecidos).toEqual([]);
  });
});
