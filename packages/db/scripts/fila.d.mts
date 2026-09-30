import type { PgBoss } from 'pg-boss';

export declare const SCHEMA_FILA: string;
export declare const FILA_CONVERSA: string;
export declare const FILA_BOTAO: string;
export declare const FILA_RESPOSTA: string;
export declare const FILA_ATRASOS: string;
export declare const FILA_OFERTA: string;

/**
 * Instância de pg-boss configurada só para enfileirar. `max` é o teto de conexões
 * DESTA instância — ela abre um pool próprio, separado do da Kysely, e sem teto
 * cada serviço consome o dobro do que parece (docs/DEPLOY.md).
 */
export declare function criarFila(connectionString: string, max?: number): PgBoss;

/** Cria o que falta do schema da fila e registra as filas. Conexão de dono. */
export declare function prepararFila(connectionString: string): Promise<string[]>;
