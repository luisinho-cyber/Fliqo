export interface PoliticaQueAlcanca {
  nome: string;
  comandos: string[];
}

export interface CasoDeConferencia {
  funcao: string;
  tabela: string;
  dono: string;
  rlsForcada: boolean;
  donoEhSuperusuario: boolean;
  donoTemBypassRls: boolean;
  /** `undefined` quando não foi possível assumir o papel do dono para perguntar. */
  rlsAtivaParaODono: boolean | undefined;
  politicasQueNomeiamODono: PoliticaQueAlcanca[];
  /** 'select' sempre; mais 'update'/'insert'/'delete' quando o corpo escreve. */
  comandosNecessarios: string[];
}

export type Veredito = { ok: true; porque: string } | { ok: false; mensagem: string };

export interface Resultado {
  linhas: (CasoDeConferencia & Veredito)[];
  falhas: string[];
  naoQualificadas: string[];
  /** Referências a app.<algo> que não são tabela nem função conhecida. */
  naoConferidas: string[];
  usuarioAtual: string;
}

/** As tabelas de `app` que o corpo cita como `app.<tabela>`. */
export declare function tabelasReferenciadas(prosrc: string, tabelasDeApp: string[]): string[];

/** Referências a `app.<algo>` que a conferência não sabe conferir (view, tabela que sumiu). */
export declare function referenciasNaoConferidas(
  prosrc: string,
  tabelasDeApp: string[],
  funcoesDeApp: string[],
): string[];

/** Tabela conhecida citada sem o prefixo `app.` — o parser não a enxerga. */
export declare function referenciasSemEsquema(prosrc: string, tabelasDeApp: string[]): string[];

/** Os comandos que a função precisa naquela tabela: ler sempre, escrever quando escreve. */
export declare function comandosNecessarios(prosrc: string, tabela: string): string[];

/** Os comandos que uma política cobre, a partir de `pg_policy.polcmd`. */
export declare function comandosDaPolitica(polcmd: string): string[];

export declare function veredito(caso: CasoDeConferencia): Veredito;

export declare function conferir(cliente: unknown): Promise<Resultado>;

export declare function relatorio(r: Resultado): string;
