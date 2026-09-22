/** Substitui cada segredo (e a senha de qualquer URL) por `[removido]`. */
export declare function semSegredos(texto: string, segredos?: (string | undefined)[]): string;

/** Imprime o erro já limpo e encerra o processo com falha. */
export declare function falhar(erro: unknown, segredos?: (string | undefined)[]): never;
