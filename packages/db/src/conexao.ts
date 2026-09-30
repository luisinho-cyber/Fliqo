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

/**
 * Recusa subir se a URL de dono do schema estiver no ambiente.
 *
 * O dono do schema NÃO passa pela RLS (CLAUDE.md, regra 2). Um processo que
 * atende requisição não tem por que conhecer essa conexão, e um processo que a
 * conhece é um bug de configuração a uma linha de distância de virar vazamento
 * entre clínicas — basta alguém trocar `criarDb(config.DATABASE_URL)` por ela
 * num apuro de madrugada.
 *
 * Isto mora no CAMINHO DE START, nunca na leitura do schema de configuração: a
 * variável existe legitimamente no workflow de migração e nos jobs de teste, e
 * uma recusa no schema derrubaria o próprio CI que aplica esta regra.
 */
export function recusarAdminUrl(quem: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.DATABASE_ADMIN_URL === undefined || env.DATABASE_ADMIN_URL === '') return;
  // A mensagem não repete o valor: ela nomeia a variável, e nada mais.
  throw new Error(
    `${quem} não sobe com DATABASE_ADMIN_URL no ambiente. ` +
      'Essa conexão é do dono do schema, não passa pela RLS e só as migrações a usam. ' +
      'Remova a variável deste serviço.',
  );
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
