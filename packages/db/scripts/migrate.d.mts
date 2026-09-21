/**
 * Tipos do migrador. O script é JavaScript puro para ser executável direto por
 * `node`, sem passo de build; esta declaração é o que dá tipo a quem o importa.
 */

export interface ResumoMigracao {
  /** Versões aplicadas nesta execução, na ordem em que foram aplicadas. */
  aplicadas: string[];
  /** Versões que já estavam registradas no banco e foram puladas. */
  puladas: string[];
}

export declare function migrar(connectionString: string): Promise<ResumoMigracao>;
