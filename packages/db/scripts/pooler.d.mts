export declare const REGIAO_PADRAO: string;
export declare const PORTA_SESSAO: number;

/** Falso para banco local: não há pooler a descobrir. */
export declare function ehDoSupabase(url: string): boolean;

/** O ref do projeto, do host `db.<ref>.supabase.co` ou do usuário `postgres.<ref>`. */
export declare function refDoProjeto(url: string): string | undefined;

/** Hosts a tentar, em ordem; o da própria string vem primeiro quando é de pooler. */
export declare function candidatosDeHost(url: string, regiao?: string): string[];

export declare function urlDoSessionPooler(partes: {
  ref: string;
  senha: string;
  host: string;
}): string;

/** A senha da URL, já decodificada. */
export declare function senhaDaUrl(url: string): string;

/** Verdadeiro para erro de host/DNS; falso para credencial errada. */
export declare function ehHostErrado(erro: unknown): boolean;

/** A conexão de migração resolvida, com o host que respondeu ao `select 1`. */
export declare function resolverAdminUrl(
  bruta: string,
  opcoes?: { regiao?: string; testar?: (url: string) => Promise<void> },
): Promise<{ url: string; host: string; resolvido: boolean }>;
