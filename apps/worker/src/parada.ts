import type { BatimentoRegistrado } from './saude';

/**
 * Parada limpa.
 *
 * O Railway manda SIGTERM a cada deploy. Um worker que morre no meio de uma ação
 * deixa a linha em `executando` até `requeue_stuck_actions` passar — ou seja,
 * TODO deploy criaria ações travadas, e o requeue deixaria de ser rede de
 * segurança para virar o caminho normal.
 *
 * Então o sinal não mata: ele pede parada. Os laços deixam de reclamar trabalho
 * novo, terminam o que está na mão, e só então o processo sai.
 */

export interface Parada {
  /** Já foi pedida? Os laços consultam antes de começar outra volta. */
  pedida: () => boolean;
  /** Dorme, mas acorda na hora se a parada for pedida no meio da espera. */
  dormir: (ms: number) => Promise<void>;
  pedir: () => void;
}

export function criarParada(): Parada {
  let pedida = false;
  // Cada espera em curso registra como ser acordada. Sem isto, encerrar
  // esperaria o sono inteiro — dois minutos no laço de atrasos, tempo de sobra
  // para o Railway perder a paciência e mandar SIGKILL.
  const esperando = new Set<() => void>();

  return {
    pedida: () => pedida,
    dormir(ms: number): Promise<void> {
      if (pedida) return Promise.resolve();
      return new Promise((resolve) => {
        const acordar = (): void => {
          clearTimeout(relogio);
          esperando.delete(acordar);
          resolve();
        };
        const relogio = setTimeout(acordar, ms);
        esperando.add(acordar);
      });
    },
    pedir(): void {
      pedida = true;
      for (const acordar of [...esperando]) acordar();
    },
  };
}

export interface Laco {
  /** O que fazer em cada volta. Uma volta nunca é interrompida no meio. */
  tarefa: () => Promise<void>;
  intervaloMs: number;
  parada: Parada;
  aoFalhar: (erro: unknown) => void;
}

/**
 * Um laço que só sai ENTRE voltas.
 *
 * A promessa devolvida resolve quando a volta em curso terminou — é ela que
 * `encerrar` aguarda. Uma volta ruim não mata o laço: a próxima tenta de novo.
 */
export async function rodarLaco(laco: Laco): Promise<void> {
  while (!laco.parada.pedida()) {
    try {
      await laco.tarefa();
    } catch (erro) {
      laco.aoFalhar(erro);
    }
    await laco.parada.dormir(laco.intervaloMs);
  }
}

export interface LacoVigiado extends Laco {
  /** Só batimento que já está no `/estado`: o tipo recusa o que `criarBatimento` devolve. */
  batimento: BatimentoRegistrado;
}

/**
 * Um laço que aparece no `/estado`: bate a cada volta concluída.
 *
 * A batida mora aqui, e não na tarefa de cada laço, para não depender de alguém lembrar de
 * marcá-la. Volta que falha não bate: falhar sempre é a forma mais comum de estar parado.
 */
export function rodarLacoVigiado(laco: LacoVigiado): Promise<void> {
  return rodarLaco({
    ...laco,
    tarefa: async () => {
      await laco.tarefa();
      laco.batimento.marcar();
    },
  });
}
