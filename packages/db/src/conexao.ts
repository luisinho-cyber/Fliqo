import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Banco } from './schema';

export type Db = Kysely<Banco>;

// `bigint` do Postgres chega como string no driver e é assim que sai daqui:
// converter para Number perderia precisão acima de 2^53. Dinheiro em centavos
// vira `number` só nas bordas, depois de validado (packages/core, assertCents).

/** Cria uma conexão. Em produção, a URL é a do papel da aplicação — nunca a do dono do schema. */
export function criarDb(connectionString: string, maxConexoes = 10): Db {
  return new Kysely<Banco>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: maxConexoes }),
    }),
  });
}

let padrao: Db | undefined;

/**
 * Conexão da aplicação, a partir de DATABASE_URL. Memoizada: um pool por processo.
 * Os testes não usam isto — eles passam a própria conexão para `withClinic`.
 */
export function dbDoAmbiente(): Db {
  if (padrao) return padrao;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL não definida. A aplicação conecta como fliqo_app, nunca como dono do schema.',
    );
  }
  padrao = criarDb(url);
  return padrao;
}
