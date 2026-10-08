import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  criarBatimento,
  criarEntrega,
  criarSinaisDeSaude,
  JANELA_DE_SAUDE_MS,
  registrarLaco,
  servidorDeSaude,
  vereditoDeSaude,
  type Batimento,
  type Entrega,
  type SinaisDeSaude,
} from '../src/saude';

/**
 * As duas rotas do worker: `/health` diz se o processo está de pé; `/estado` diz se o trabalho
 * está saindo. Worker travado em silêncio é o pior caso deste produto — ninguém é confirmado e
 * nada avisa —, e é o `/estado` que diz isso, não o `/health`.
 */

/** Valor falso, com o tamanho mínimo que a configuração exige. */
const TOKEN = 'token-falso-do-estado-so-para-teste-0001';
const COM_TOKEN = { headers: { authorization: `Bearer ${TOKEN}` } };

/** Batimento com relógio na mão: nada aqui depende do tempo passar de verdade. */
function batimentoEm(ms: number): Batimento {
  return { marcar: () => undefined, ultimo: () => ms };
}

/**
 * Sinais para o servidor, com cada laço batendo pela última vez no instante pedido.
 *
 * O servidor só aceita batimento registrado, então os laços entram por `registrarLaco`, como
 * em produção — cada um com o relógio parado no próprio instante.
 */
function sinaisCom(ultimasBatidas: Record<string, number>, entrega: Entrega): SinaisDeSaude {
  const sinais: SinaisDeSaude = { batimentos: {}, entrega };
  for (const [nome, ms] of Object.entries(ultimasBatidas)) registrarLaco(sinais, nome, () => ms);
  return sinais;
}

describe('vereditoDeSaude', () => {
  it('laços batendo agora é saudável', () => {
    const v = vereditoDeSaude(
      {
        batimentos: { acoes: batimentoEm(1_000), atrasos: batimentoEm(1_000) },
        entrega: criarEntrega(),
      },
      1_000,
    );
    expect(v.ok).toBe(true);
    expect(v.lacos.acoes?.travado).toBe(false);
  });

  it('um laço travado basta para o serviço não estar saudável', () => {
    // O de atrasos bateu agora; o de ações está parado há mais que a janela.
    const agora = 10 * 60_000 + 5_000;
    const v = vereditoDeSaude(
      {
        batimentos: { acoes: batimentoEm(0), atrasos: batimentoEm(agora) },
        entrega: criarEntrega(),
      },
      agora,
    );
    expect(v.ok).toBe(false);
    expect(v.lacos.acoes?.travado).toBe(true);
    // E o veredito diz QUAL travou: "não saudável" sem nome não ajuda ninguém.
    expect(v.lacos.atrasos?.travado).toBe(false);
  });

  it('dentro da janela, por pouco, ainda é saudável', () => {
    // Trabalhar devagar não é estar travado. Travado falso aqui é alarme falso.
    const agora = JANELA_DE_SAUDE_MS;
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(0) }, entrega: criarEntrega() },
      agora,
    );
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
    expect(vereditoDeSaude({ batimentos: { acoes: b }, entrega: criarEntrega() }, 5_000).ok).toBe(
      true,
    );
  });

  it('marcar renova a idade', () => {
    let relogio = 0;
    const b = criarBatimento(() => relogio);
    relogio = 20 * 60_000;
    expect(vereditoDeSaude({ batimentos: { acoes: b }, entrega: criarEntrega() }, relogio).ok).toBe(
      false,
    );
    b.marcar();
    expect(vereditoDeSaude({ batimentos: { acoes: b }, entrega: criarEntrega() }, relogio).ok).toBe(
      true,
    );
  });
});

describe('registrarLaco', () => {
  it('o laço registrado entra no veredito, e parado aparece travado pelo nome', () => {
    let relogio = 0;
    const sinais = criarSinaisDeSaude();
    registrarLaco(sinais, 'acoes', () => relogio);
    relogio = 2 * JANELA_DE_SAUDE_MS;

    const v = vereditoDeSaude(sinais, relogio);
    expect(v.estado).toBe('travado');
    expect(v.lacos.acoes?.travado).toBe(true);
  });

  it('o batimento devolvido é o MESMO que o veredito lê: marcar nele renova o laço', () => {
    let relogio = 0;
    const sinais = criarSinaisDeSaude();
    const b = registrarLaco(sinais, 'acoes', () => relogio);
    relogio = 2 * JANELA_DE_SAUDE_MS;
    b.marcar();
    expect(vereditoDeSaude(sinais, relogio).estado).toBe('verde');
  });
});

describe('o servidor', () => {
  let fechar: (() => void) | undefined;
  afterEach(() => {
    fechar?.();
    fechar = undefined;
  });

  async function subir(
    ultimasBatidas: Record<string, number>,
    agoraMs: number,
    entrega: Entrega = criarEntrega(),
  ): Promise<string> {
    const servidor = servidorDeSaude({
      porta: 0,
      sinais: sinaisCom(ultimasBatidas, entrega),
      tokenDoEstado: TOKEN,
      agora: () => agoraMs,
    });
    fechar = () => servidor.close();
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  it('/estado devolve 200 com os laços vivos', async () => {
    const base = await subir({ acoes: 1_000 }, 1_000);
    const r = await fetch(`${base}/estado`, COM_TOKEN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('/estado devolve 503 com laço travado — veredito para quem lê, não reinício', async () => {
    // O healthcheck do Railway pergunta o /health, só no deploy, e não reinicia nada. Este 503
    // não aciona plataforma nenhuma: reiniciar com laço travado exigiria o worker sair com erro.
    const agora = 30 * 60_000;
    const base = await subir({ acoes: 0 }, agora);
    const r = await fetch(`${base}/estado`, COM_TOKEN);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ ok: false });
  });

  it('qualquer outro caminho é 404: o worker serve as duas rotas e mais nada', async () => {
    const base = await subir({ acoes: 1_000 }, 1_000);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });

  it('o /estado não conta nada além do veredito', async () => {
    /*
     * Versão, variável de ambiente ou nome de clínica aqui é reconhecimento de graça para quem
     * alcançar a porta.
     *
     * A lista é o portão: ela cresceu de duas chaves para quatro quando o veredito passou a
     * medir entrega, e para cinco quando ganhou a causa. Ampliar é decisão, não acidente.
     * `estado` é palavra de conjunto fechado, `causa` nomeia laço e número, e `entrega` são
     * contagens agregadas: nenhum diz de QUAL clínica se trata.
     */
    const base = await subir({ acoes: 1_000 }, 1_000);
    const corpo = await (await fetch(`${base}/estado`, COM_TOKEN)).text();
    expect(Object.keys(JSON.parse(corpo) as object).sort()).toEqual([
      'causa',
      'entrega',
      'estado',
      'lacos',
      'ok',
    ]);
  });

  it('e nenhuma das duas rotas conta id, versão ou variável de ambiente', async () => {
    const base = await subir({ acoes: 1_000 }, 1_000);
    for (const rota of ['/health', '/estado']) {
      const corpo = (await (await fetch(`${base}${rota}`, COM_TOKEN)).text()).toLowerCase();
      for (const agulha of ['version', 'versao', 'node', 'database', 'token', 'key', 'clinic']) {
        expect(corpo, `${rota} conta "${agulha}"`).not.toContain(agulha);
      }
      // O token chega no cabeçalho e não volta em corpo nenhum.
      expect(corpo).not.toContain(TOKEN.toLowerCase());
    }
  });
});

/**
 * As duas perguntas, separadas.
 *
 * `/health` é liveness: "o processo está de pé?". É o que o healthcheck do Railway pergunta no
 * início do deploy. Quando ele passou a saber de entrega, passou a responder outra pergunta
 * com o mesmo nome — e foi isso que o fez mentir. O veredito mora em `/estado`.
 */
describe('o /health é liveness e não sabe nada de entrega', () => {
  let fechar: (() => void) | undefined;
  afterEach(() => {
    fechar?.();
    fechar = undefined;
  });

  /** O pior cenário que o veredito conhece: laço parado há meia hora e trinta represadas. */
  async function subirNoPiorEstado(): Promise<string> {
    const agora = 30 * 60_000;
    const entrega = criarEntrega();
    entrega.marcar(30, agora);
    const servidor = servidorDeSaude({
      porta: 0,
      sinais: sinaisCom({ acoes: 0 }, entrega),
      tokenDoEstado: TOKEN,
      agora: () => agora,
    });
    fechar = () => servidor.close();
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  it('com laço travado e trinta represadas, /health continua 200', async () => {
    const base = await subirNoPiorEstado();
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('e o corpo do /health é só o "estou de pé", sem número nem estado', async () => {
    const base = await subirNoPiorEstado();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
  });

  it('enquanto o /estado, no mesmo instante, diz o que está errado', async () => {
    // Sem esta linha, os dois testes acima passariam com um servidor que nem soubesse do
    // veredito. É ela que prova que a informação existe — só não está no /health.
    const base = await subirNoPiorEstado();
    const r = await fetch(`${base}/estado`, COM_TOKEN);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({
      estado: 'travado',
      entrega: { vencidasRepresadas: 30 },
    });
  });
});

/**
 * A entrega, que é o assunto deste bloco.
 *
 * Antes disto o batimento andava na direção contrária do problema: ele é marcado a cada ação
 * concluída e a cada volta do laço, então uma clínica com o número em erro — cujas ações o
 * `claim_due_actions` deixa de reclamar — produzia rodadas limpas, rápidas, com o batimento
 * batendo. Suprimir o envio MELHORAVA o sinal.
 */
describe('o veredito mede entrega, não só batimento', () => {
  function entregaCom(vencidas: number, emMs: number): Entrega {
    const e = criarEntrega();
    e.marcar(vencidas, emMs);
    return e;
  }

  it('laço vivo e nada represado é verde', () => {
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(1_000) }, entrega: entregaCom(0, 1_000) },
      1_000,
    );
    expect(v.estado).toBe('verde');
    expect(v.ok).toBe(true);
  });

  it('laço vivo com ação de envio represada é DEGRADADO, não verde', () => {
    // O caso que o batimento sozinho não vê: a rodada termina limpa porque não havia o que
    // reclamar, e trinta pacientes continuam sem ser avisados.
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(1_000) }, entrega: entregaCom(30, 1_000) },
      1_000,
    );
    expect(v.estado).toBe('degradado');
    expect(v.ok).toBe(false);
    expect(v.entrega.vencidasRepresadas).toBe(30);
  });

  it('uma ação represada já basta: não existe represamento aceitável', () => {
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(1_000) }, entrega: entregaCom(1, 1_000) },
      1_000,
    );
    expect(v.estado).toBe('degradado');
  });

  it('laço travado vence o degradado: processo parado é o problema maior', () => {
    const agora = 30 * 60_000;
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(0) }, entrega: entregaCom(30, agora) },
      agora,
    );
    expect(v.estado).toBe('travado');
  });

  it('sem medida nenhuma é verde: worker que acabou de subir não nasce degradado', () => {
    // Tratar ausência como problema faria todo deploy começar fora do verde, e aí ninguém
    // olharia o estado nunca mais.
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(1_000) }, entrega: criarEntrega() },
      1_000,
    );
    expect(v.estado).toBe('verde');
    expect(v.entrega.idadeDaMedidaMs).toBeNull();
  });

  it('medida velha não conta como represamento: ela conta como laço travado', () => {
    // Se a medida envelheceu além da janela, o laço que a tira parou — e isso já aparece no
    // batimento. Deixar a medida velha decidir faria o worker ficar degradado para sempre
    // por causa de um número tirado há uma hora.
    const agora = 30 * 60_000;
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(agora) }, entrega: entregaCom(30, 0) },
      agora,
    );
    expect(v.estado).toBe('verde');
    expect(v.entrega.represado).toBe(false);
  });

  it('a causa diz o número no degradado e o laço no travado', () => {
    expect(
      vereditoDeSaude(
        { batimentos: { acoes: batimentoEm(1_000) }, entrega: entregaCom(30, 1_000) },
        1_000,
      ).causa,
    ).toBe('30 ação(ões) de envio vencida(s) que não saíram');

    const agora = 12 * 60_000;
    expect(
      vereditoDeSaude(
        {
          batimentos: { acoes: batimentoEm(0), atrasos: batimentoEm(agora) },
          entrega: criarEntrega(),
        },
        agora,
      ).causa,
    ).toBe('laço parado: "acoes" sem batida há 12 min');
  });

  it('no verde não há causa', () => {
    const v = vereditoDeSaude(
      { batimentos: { acoes: batimentoEm(1_000) }, entrega: criarEntrega() },
      1_000,
    );
    expect(v.causa).toBeNull();
  });

  it('a medida mais nova substitui a anterior', () => {
    const e = criarEntrega();
    e.marcar(30, 1_000);
    e.marcar(0, 2_000);
    const v = vereditoDeSaude({ batimentos: { acoes: batimentoEm(2_000) }, entrega: e }, 2_000);
    expect(v.estado).toBe('verde');
  });
});

describe('o código HTTP de cada estado', () => {
  let fechar: (() => void) | undefined;
  afterEach(() => {
    fechar?.();
    fechar = undefined;
  });

  async function subirCom(vencidas: number, agoraMs: number): Promise<string> {
    const entrega = criarEntrega();
    entrega.marcar(vencidas, agoraMs);
    const servidor = servidorDeSaude({
      porta: 0,
      sinais: sinaisCom({ acoes: agoraMs }, entrega),
      tokenDoEstado: TOKEN,
      agora: () => agoraMs,
    });
    fechar = () => servidor.close();
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  it('com 30 ações represadas, /estado NÃO responde verde', async () => {
    const base = await subirCom(30, 1_000);
    const r = await fetch(`${base}/estado`, COM_TOKEN);
    expect(r.status).not.toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, estado: 'degradado' });
  });

  it('degradado é 207: o worker está atendendo, o que falta é a credencial de uma clínica', async () => {
    /*
     * 207 não é mecanismo de alerta e não aciona nada: ninguém lê o /estado sozinho. Quem
     * avisa é o e-mail do vigia de operador. O código só não pode ser 200, que afirmaria
     * saúde, nem 503, que diria que o processo não está atendendo.
     */
    const base = await subirCom(30, 1_000);
    const r = await fetch(`${base}/estado`, COM_TOKEN);
    expect(r.status).toBe(207);
    expect(r.status).toBeLessThan(300);
  });

  it('nada represado é 200', async () => {
    const base = await subirCom(0, 1_000);
    expect((await fetch(`${base}/estado`, COM_TOKEN)).status).toBe(200);
  });

  it('o corpo do degradado não conta de QUAL clínica é o represamento', async () => {
    // Health check é público. A contagem é agregada; quem precisa saber de qual clínica
    // recebe o e-mail do vigia de operador, que é autenticado por ser e-mail.
    const base = await subirCom(30, 1_000);
    const corpo = await (await fetch(`${base}/estado`, COM_TOKEN)).text();
    expect(corpo).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(corpo.toLowerCase()).not.toContain('clinic');
  });
});

/**
 * O `/estado` é painel de operação: diz a quem pergunta exatamente quando o sistema está
 * fraco. Só responde com o `ESTADO_TOKEN`; sem ele, é indistinguível de rota inexistente.
 * O `/health` continua público, porque não diz nada além de "estou de pé".
 */
describe('o /estado exige ESTADO_TOKEN, o /health não', () => {
  let fechar: (() => void) | undefined;
  afterEach(() => {
    fechar?.();
    fechar = undefined;
  });

  async function subirComToken(token: string | undefined): Promise<string> {
    const sinais = criarSinaisDeSaude();
    registrarLaco(sinais, 'acoes', () => 1_000);
    const servidor = servidorDeSaude({
      porta: 0,
      sinais,
      tokenDoEstado: token,
      agora: () => 1_000,
    });
    fechar = () => servidor.close();
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  /** O 404 de uma rota que não existe: é com ele que o /estado sem token tem de se parecer. */
  async function rotaInexistente(base: string): Promise<{ status: number; corpo: string }> {
    const r = await fetch(`${base}/nada-aqui`);
    return { status: r.status, corpo: await r.text() };
  }

  it('com o token certo, responde o veredito', async () => {
    const base = await subirComToken(TOKEN);
    const r = await fetch(`${base}/estado`, COM_TOKEN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ estado: 'verde', lacos: { acoes: { travado: false } } });
  });

  it('sem token nenhum, 404 igual ao de rota inexistente', async () => {
    const base = await subirComToken(TOKEN);
    const r = await fetch(`${base}/estado`);
    expect({ status: r.status, corpo: await r.text() }).toEqual(await rotaInexistente(base));
    expect(r.status).toBe(404);
  });

  it('com token errado do MESMO tamanho, 404', async () => {
    const errado = TOKEN.slice(0, -1) + (TOKEN.endsWith('1') ? '2' : '1');
    const base = await subirComToken(TOKEN);
    const r = await fetch(`${base}/estado`, { headers: { authorization: `Bearer ${errado}` } });
    expect({ status: r.status, corpo: await r.text() }).toEqual(await rotaInexistente(base));
  });

  it('com token de tamanho diferente, 404 e não 500', async () => {
    // `timingSafeEqual` lança com buffers de tamanhos diferentes. Sem o resumo, isto seria um
    // 500 — e um 500 diz que a rota existe.
    const base = await subirComToken(TOKEN);
    for (const errado of ['x', `${TOKEN}-e-mais-um-pedaco`]) {
      const r = await fetch(`${base}/estado`, { headers: { authorization: `Bearer ${errado}` } });
      expect(r.status, `token "${errado.slice(0, 4)}…"`).toBe(404);
    }
  });

  it('o token certo fora do formato Bearer não passa', async () => {
    const base = await subirComToken(TOKEN);
    for (const cabecalho of [TOKEN, `Basic ${TOKEN}`, `bearer${TOKEN}`]) {
      const r = await fetch(`${base}/estado`, { headers: { authorization: cabecalho } });
      expect(r.status).toBe(404);
    }
  });

  it('sem ESTADO_TOKEN configurado, o /estado fica fechado para todos', async () => {
    // Fechado, não aberto: esquecer a variável não pode virar painel público.
    const base = await subirComToken(undefined);
    expect((await fetch(`${base}/estado`)).status).toBe(404);
    expect((await fetch(`${base}/estado`, COM_TOKEN)).status).toBe(404);
    expect(
      (await fetch(`${base}/estado`, { headers: { authorization: 'Bearer undefined' } })).status,
    ).toBe(404);
  });

  it('e o /health continua 200 sem token nenhum, com ou sem ESTADO_TOKEN configurado', async () => {
    for (const token of [TOKEN, undefined]) {
      const base = await subirComToken(token);
      const r = await fetch(`${base}/health`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      fechar?.();
      fechar = undefined;
    }
  });
});
