import { AMBIENTE_DA_API, type ConfigDoEsquema } from '@fliqo/core';

/**
 * A configuração da api, pelo esquema único (packages/core/src/ambiente.ts).
 *
 * Só o tipo mora aqui: quem lê o ambiente é `travarAmbiente`, na primeira instrução do
 * apps/api/src/index.ts, e é lá que estão as quatro travas. Uma função de leitura própria
 * neste arquivo seria um segundo caminho de validação — e dois caminhos é exatamente a
 * divergência que o esquema único acabou.
 *
 * `DATABASE_ADMIN_URL` não está no esquema da api, e não é esquecimento: declarar uma variável
 * que o serviço não usa ensina a quem lê que ela é necessária, e daí ela acaba configurada no
 * Railway. Quem a recusa é a trava `proibida`, no caminho de start.
 */
export type Config = ConfigDoEsquema<typeof AMBIENTE_DA_API>;
