import { CompiledQuery } from 'kysely';
import type { Trx } from './withClinic';

/** O mínimo que o pg-boss precisa para rodar SQL numa conexão que não é dele. */
export interface ConexaoExterna {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Deixa o pg-boss enfileirar DENTRO da transação que já está aberta.
 *
 * Sem isto, gravar a mensagem e criar o job seriam dois commits: se o job saísse
 * primeiro, o worker poderia ler uma conversa cuja mensagem ainda não existe; se
 * saísse depois e a chamada falhasse, a mensagem ficaria gravada e nunca seria
 * respondida. Na mesma transação, ou as duas coisas acontecem ou nenhuma.
 */
export function comoConexaoDoBoss(trx: Trx): ConexaoExterna {
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const r = await trx.executeQuery(CompiledQuery.raw(text, values));
      return { rows: [...r.rows] };
    },
  };
}
