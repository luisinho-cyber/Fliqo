import { operador, type Db } from '@fliqo/db';
import type { ClienteWhatsApp } from '@fliqo/whatsapp';
import type { Logger } from 'pino';
import { rodarUmaVez } from './acoes';
import { rodarLacoVigiado, type Parada } from './parada';
import { registrarLaco, type SinaisDeSaude } from './saude';

/**
 * O laço das ações agendadas, fora do `index.ts`.
 *
 * Ele morava no arquivo de topo, que sobe servidor e laço no import e por isso nenhum teste
 * alcança. A medida de entrega ficou guardada por um teste que lia o TEXTO do `index.ts` — a
 * mesma classe de defeito que ela existe para corrigir: um sinal que confere a forma e não o
 * valor. Aqui o laço é importável e testado pelo que faz (health-represado.test.ts).
 *
 * O laço se registra nos sinais de saúde AQUI, e não no `index.ts`: quem roda o laço é quem
 * cria e marca o batimento e a medida, então não existe jeito de ligar o laço sem que o
 * `/estado` o enxergue. Os sinais são obrigatórios aqui e no servidor — esquecê-los, de um
 * lado ou do outro, não compila.
 */

/** A cada 30 s, sem sobrepor uma rodada na outra. */
export const INTERVALO_DO_LACO_DE_ACOES_MS = 30_000;

export interface DependenciasDoLacoDeAcoes {
  parada: Parada;
  db: Db;
  whatsapp: ClienteWhatsApp;
  log: Pick<Logger, 'info' | 'error'>;
  sinais: SinaisDeSaude;
  agora?: () => number;
}

/** O nome com que o laço aparece no `/estado`. */
export const NOME_DO_LACO_DE_ACOES = 'acoes';

/** Resolve quando a volta em curso termina depois de pedida a parada. */
export function iniciarLacoDeAcoes(dep: DependenciasDoLacoDeAcoes): Promise<void> {
  const agora = dep.agora ?? Date.now;
  const batimento = registrarLaco(dep.sinais, NOME_DO_LACO_DE_ACOES, agora);
  const { entrega } = dep.sinais;

  return rodarLacoVigiado({
    parada: dep.parada,
    batimento,
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

      /*
       * A medida vem DEPOIS da rodada, de propósito: o que sobra represado depois de o laço
       * fazer o que podia é a definição do problema. Medir antes contaria o lote que a própria
       * rodada ia resolver.
       */
      entrega.marcar(await operador.vencidasRepresadas(dep.db), agora());

      if (r.pegas > 0 || r.devolvidas > 0) dep.log.info(r, 'rodada de ações');
    },
  });
}
