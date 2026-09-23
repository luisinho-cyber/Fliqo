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

/** Verdadeiro quando o host respondeu e recusou a senha (28P01). */
export declare function ehSenhaRecusada(erro: unknown): boolean;

/** A linha de diagnóstico: host, porta, usuário e o motivo. Nunca a senha. */
export declare function diagnostico(url: string, motivo: string): string;

/** Devolve a url se ela tiver host de pooler, usuário `postgres.<ref>` e porta de sessão. */
export declare function conferirAlvo(url: string): string;

/** A conexão de migração resolvida, com o host que respondeu ao `select 1`. */
export declare function resolverAdminUrl(
  bruta: string,
  opcoes?: {
    regiao?: string;
    testar?: (url: string) => Promise<void>;
    registrar?: (linha: string) => void;
  },
): Promise<{ url: string; host: string; resolvido: boolean }>;
