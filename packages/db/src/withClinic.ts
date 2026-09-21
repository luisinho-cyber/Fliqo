import { sql, type Transaction } from 'kysely';
import { dbDoAmbiente, type Db } from './conexao';
import type { Banco } from './schema';

/** Transação já "dentro" de uma clínica. Toda query da aplicação recebe isto. */
export type Trx = Transaction<Banco>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abre uma transação e fixa o tenant nela (CLAUDE.md, regra 2).
 *
 * `set_config(..., true)` é local à transação: ao terminar, o valor some sozinho,
 * e a conexão volta ao pool sem clínica. Sem isso, a próxima requisição herdaria
 * o tenant da anterior — que é exatamente o vazamento que a RLS existe para impedir.
 */
export async function withClinic<T>(
  clinicId: string,
  fn: (trx: Trx) => Promise<T>,
  db: Db = dbDoAmbiente(),
): Promise<T> {
  // `app.clinic_id()` faz o cast para uuid; um valor inválido viraria erro de
  // banco no meio da transação. Falhar aqui aponta para o bug de quem chamou.
  if (!UUID.test(clinicId)) throw new TypeError(`clinicId não é um uuid: ${clinicId}`);

  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.clinic_id', ${clinicId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Executa `fn` sob um savepoint e devolve `undefined` se ela violar uma constraint
 * que o chamador trata.
 *
 * Existe porque no Postgres um erro aborta a transação inteira: sem savepoint,
 * capturar o 23P01 de "horário ocupado" deixaria a transação inutilizável e
 * derrubaria junto o que já tinha sido feito nela.
 */
export async function sobSavepoint<T>(
  trx: Trx,
  nome: string,
  fn: () => Promise<T>,
  esperado: (erro: unknown) => boolean,
): Promise<T | undefined> {
  const id = sql.raw(nome);
  await sql`savepoint ${id}`.execute(trx);
  try {
    const saida = await fn();
    await sql`release savepoint ${id}`.execute(trx);
    return saida;
  } catch (erro) {
    await sql`rollback to savepoint ${id}`.execute(trx);
    if (esperado(erro)) return undefined;
    throw erro;
  }
}
