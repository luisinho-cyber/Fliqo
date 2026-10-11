import {
  AMBIENTE_DA_API,
  exigirAmbiente,
  type AmbienteConhecido,
  type ConfigDoEsquema,
} from '@fliqo/core';

/**
 * A configuração da api vem do esquema único (packages/core/src/ambiente.ts).
 *
 * Falha no start, não na primeira requisição: subir sem o segredo do webhook significaria
 * aceitar qualquer mensagem como se fosse da Meta. E falha dizendo TODAS as variáveis com
 * problema de uma vez — uma por vez custou três deploys em sequência.
 *
 * `DATABASE_ADMIN_URL` não está no esquema da api, e não é esquecimento: declarar uma variável
 * que o serviço não usa ensina a quem lê que ela é necessária, e daí ela acaba configurada no
 * Railway. Quem recusa é `recusarAdminUrl`, no caminho de start (apps/api/src/index.ts).
 */
export type Config = ConfigDoEsquema<typeof AMBIENTE_DA_API>;

export function lerConfig(env: AmbienteConhecido = process.env): Config {
  return exigirAmbiente('a api', AMBIENTE_DA_API, env);
}
