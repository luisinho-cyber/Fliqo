import { AMBIENTE_DO_WORKER, type ConfigDoEsquema } from '@fliqo/core';

/**
 * A configuração do worker, pelo esquema único (packages/core/src/ambiente.ts).
 *
 * Lá estão a obrigatoriedade, o formato e a origem de cada variável — e é de lá que saem
 * também o tipo abaixo e a tabela do DEPLOY.md. Quem lê o ambiente é `travarAmbiente`, na
 * primeira instrução do apps/worker/src/index.ts.
 */
export type ConfigWorker = ConfigDoEsquema<typeof AMBIENTE_DO_WORKER>;
