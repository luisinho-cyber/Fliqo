import { describe, expect, it } from 'vitest';
import { criarParada, rodarLaco, rodarLacoVigiado } from '../src/parada';
import { criarSinaisDeSaude, registrarLaco } from '../src/saude';

/**
 * A parada limpa, testada onde ela mora.
 *
 * O que está em jogo: a cada deploy o Railway manda SIGTERM. Se o worker sair no
 * meio de uma ação, a linha fica em `executando` até o `requeue_stuck_actions`
 * passar — e aí o requeue deixa de ser rede de segurança para virar o caminho
 * normal de todo deploy.
 */

/** Uma promessa que o teste resolve na mão, para segurar a volta do laço. */
function represa(): { promessa: Promise<void>; liberar: () => void } {
  let liberar = (): void => undefined;
  const promessa = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return { promessa, liberar };
}

describe('dormir', () => {
  it('acorda na hora quando a parada é pedida no meio da espera', async () => {
    const parada = criarParada();
    const comecou = Date.now();
    // Dois minutos: é o sono do laço de atrasos. Esperá-lo inteiro levaria SIGKILL.
    const sono = parada.dormir(120_000);
    parada.pedir();
    await sono;
    expect(Date.now() - comecou).toBeLessThan(1_000);
  });

  it('nem começa a dormir se a parada já foi pedida', async () => {
    const parada = criarParada();
    parada.pedir();
    const comecou = Date.now();
    await parada.dormir(120_000);
    expect(Date.now() - comecou).toBeLessThan(1_000);
  });

  it('acorda TODAS as esperas em curso, não só a primeira', async () => {
    // São dois laços dormindo ao mesmo tempo. Acordar um só deixaria o outro
    // segurando a saída até o sono dele terminar.
    const parada = criarParada();
    const sonos = [parada.dormir(120_000), parada.dormir(120_000), parada.dormir(120_000)];
    parada.pedir();
    const comecou = Date.now();
    await Promise.all(sonos);
    expect(Date.now() - comecou).toBeLessThan(1_000);
  });
});

describe('rodarLaco', () => {
  it('roda voltas até a parada ser pedida', async () => {
    const parada = criarParada();
    let voltas = 0;
    const laco = rodarLaco({
      parada,
      intervaloMs: 1,
      aoFalhar: () => undefined,
      tarefa: async () => {
        voltas += 1;
        if (voltas === 3) parada.pedir();
        await Promise.resolve();
      },
    });
    await laco;
    expect(voltas).toBe(3);
  });

  /**
   * O teste que justifica o arquivo: a parada pedida NO MEIO de uma volta não
   * interrompe a volta. É isso que evita ação pela metade a cada deploy.
   */
  it('a volta em curso termina antes de o laço resolver', async () => {
    const parada = criarParada();
    const seguro = represa();
    let terminou = false;

    const laco = rodarLaco({
      parada,
      intervaloMs: 1,
      aoFalhar: () => undefined,
      tarefa: async () => {
        await seguro.promessa;
        terminou = true;
      },
    });

    // A volta está presa. Pedir parada aqui é o SIGTERM chegando no meio dela.
    parada.pedir();

    let resolveu = false;
    void laco.then(() => {
      resolveu = true;
    });
    // Duas voltas do microtask queue: se o laço fosse sair sem esperar, sairia aqui.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveu, 'o laço saiu antes de a volta terminar').toBe(false);
    expect(terminou).toBe(false);

    seguro.liberar();
    await laco;
    expect(terminou).toBe(true);
  });

  it('volta que estoura não mata o laço, e o erro chega a quem registra', async () => {
    const parada = criarParada();
    const erros: unknown[] = [];
    let voltas = 0;

    await rodarLaco({
      parada,
      intervaloMs: 1,
      aoFalhar: (erro) => erros.push(erro),
      tarefa: async () => {
        voltas += 1;
        if (voltas === 1) throw new Error('rodada ruim');
        if (voltas === 2) parada.pedir();
        await Promise.resolve();
      },
    });

    expect(voltas).toBe(2);
    expect((erros[0] as Error).message).toBe('rodada ruim');
  });
});

describe('rodarLacoVigiado', () => {
  it('volta concluída bate o batimento', async () => {
    let relogio = 0;
    const batimento = registrarLaco(criarSinaisDeSaude(), 'teste', () => relogio);
    const parada = criarParada();
    const laco = rodarLacoVigiado({
      parada,
      batimento,
      intervaloMs: 60_000,
      aoFalhar: () => undefined,
      tarefa: () => {
        relogio = 5_000;
        return Promise.resolve();
      },
    });
    parada.pedir();
    await laco;
    expect(batimento.ultimo()).toBe(5_000);
  });

  it('volta que falha NÃO bate: falhar sempre é a forma mais comum de estar parado', async () => {
    let relogio = 0;
    const batimento = registrarLaco(criarSinaisDeSaude(), 'teste', () => relogio);
    const parada = criarParada();
    const falhas: unknown[] = [];
    const laco = rodarLacoVigiado({
      parada,
      batimento,
      intervaloMs: 60_000,
      aoFalhar: (erro) => falhas.push(erro),
      tarefa: () => {
        relogio = 5_000;
        return Promise.reject(new Error('banco fora'));
      },
    });
    parada.pedir();
    await laco;
    expect(falhas).toHaveLength(1);
    expect(batimento.ultimo()).toBe(0);
  });
});
