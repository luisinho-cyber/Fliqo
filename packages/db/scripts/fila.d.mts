import type { PgBoss } from 'pg-boss';

export declare const SCHEMA_FILA: string;
export declare const FILA_CONVERSA: string;

/** Instância de pg-boss configurada só para enfileirar. */
export declare function criarFila(connectionString: string): PgBoss;

/** Cria o que falta do schema da fila e registra as filas. Conexão de dono. */
export declare function prepararFila(connectionString: string): Promise<string[]>;
