import {
  AMBIENTE_DO_WORKER,
  exigirAmbiente,
  type AmbienteConhecido,
  type ConfigDoEsquema,
} from '@fliqo/core';

/**
 * A configuração do worker vem do esquema único (packages/core/src/ambiente.ts).
 *
 * Lá estão a obrigatoriedade, o formato e a origem de cada variável — e é de lá que saem
 * também o tipo abaixo e a tabela do DEPLOY.md. Falha no start com a lista completa do que
 * falta, não uma variável por deploy.
 */
export type ConfigWorker = ConfigDoEsquema<typeof AMBIENTE_DO_WORKER>;

export function lerConfigWorker(env: AmbienteConhecido = process.env): ConfigWorker {
  return exigirAmbiente('o worker', AMBIENTE_DO_WORKER, env);
}
