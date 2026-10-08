import { operador, type Db } from '@fliqo/db';
import type { ClienteWhatsApp } from '@fliqo/whatsapp';
import type { Logger } from 'pino';
import { rodarUmaVez } from './acoes';
import { rodarLaco, type Parada } from './parada';
import { criarBatimento, criarEntrega, type Batimento, type Entrega } from './saude';

/**
 * O laço das ações agendadas, fora do `index.ts`.
 *
 * Ele morava no arquivo de topo, que sobe servidor e laço no import e por isso nenhum teste
 * alcança. A medida de entrega ficou guardada por um teste que lia o TEXTO do `index.ts` — a
 * mesma classe de defeito que ela existe para corrigir: um sinal que confere a forma e não o
 * valor. Aqui o laço é importável e testado pelo que faz (health-represado.test.ts).
 *
 * O batimento e a medida nascem AQUI, e não no `index.ts`: quem roda o laço é quem os marca,
 * então não existe jeito de ligar o laço sem eles. O que sobra para o `index.ts` é entregá-los
 * ao servidor de saúde, e lá a `entrega` é obrigatória — esquecê-la não compila.
 */

/** A cada 30 s, sem sobrepor uma rodada na outra. */
export const INTERVALO_DO_LACO_DE_ACOES_MS = 30_000;

export interface DependenciasDoLacoDeAcoes {
  parada: Parada;
  db: Db;
  whatsapp: ClienteWhatsApp;
  log: Pick<Logger, 'info' | 'error'>;
  agora?: () => number;
}

export interface LacoDeAcoes {
  /** Resolve quando a volta em curso termina depois de pedida a parada. */
  terminou: Promise<void>;
  batimento: Batimento;
  entrega: Entrega;
}

export function iniciarLacoDeAcoes(dep: DependenciasDoLacoDeAcoes): LacoDeAcoes {
  const agora = dep.agora ?? Date.now;
  const batimento = criarBatimento(agora);
  const entrega = criarEntrega();

  const terminou = rodarLaco({
    parada: dep.parada,
    intervaloMs: INTERVALO_DO_LACO_DE_ACOES_MS,
    // Uma rodada ruim não pode matar o worker: o próximo ciclo tenta de novo.
    aoFalhar: (erro) => {
      dep.log.error({ erro: erro instanceof Error ? erro.message : erro }, 'rodada falhou');
    },
    tarefa: async () => {
      const r = await rodarUmaVez({
        db: dep.db,
        whatsapp: dep.whatsapp,
        aoProgredir: batimento.marcar,
      });
      batimento.marcar();

      /*
       * A medida vem DEPOIS da rodada, de propósito: o que sobra represado depois de o laço
       * fazer o que podia é a definição do problema. Medir antes contaria o lote que a própria
       * rodada ia resolver.
       */
      entrega.marcar(await operador.vencidasRepresadas(dep.db), agora());

      if (r.pegas > 0 || r.devolvidas > 0) dep.log.info(r, 'rodada de ações');
    },
  });

  return { terminou, batimento, entrega };
}
