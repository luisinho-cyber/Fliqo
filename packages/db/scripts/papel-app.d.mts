/** Nome do papel com que a aplicação conecta. */
export declare const PAPEL: string;

/** Dá login e senha ao papel da aplicação. Idempotente: rodar de novo troca a senha. */
export declare function definirPapelDaAplicacao(
  adminUrl: string,
  senha: string,
): Promise<{ criado: boolean }>;
