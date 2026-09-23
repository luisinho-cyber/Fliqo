/** Nome do papel com que a aplicação conecta. */
export declare const PAPEL: string;

/** O SQL que troca a senha: só LOGIN e a senha, nada que exija superusuário. */
export declare const SQL_COMANDO_DE_SENHA: string;

/** Lê pg_roles e falha se o papel tiver superuser ou bypassrls. */
export declare function conferirAtributos(cliente: {
  query: (texto: string, valores?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<void>;

/** Dá login e senha ao papel da aplicação. Idempotente: rodar de novo troca a senha. */
export declare function definirPapelDaAplicacao(
  adminUrl: string,
  senha: string,
): Promise<{ criado: boolean }>;
