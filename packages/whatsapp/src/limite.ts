/**
 * Limitador de envio por número.
 *
 * A Meta limita quantas mensagens um número novo pode mandar, e estourar o limite
 * derruba a reputação do número da clínica — que é o contato dos pacientes dela.
 * Por isso o cliente segura o ritmo em vez de disparar tudo de uma vez.
 */
export interface Relogio {
  agora(): number;
  esperar(ms: number): Promise<void>;
}

export const RELOGIO_REAL: Relogio = {
  agora: () => Date.now(),
  esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class LimitadorPorNumero {
  readonly #intervaloMs: number;
  readonly #relogio: Relogio;
  readonly #proximoLivre = new Map<string, number>();

  constructor(porSegundo = 10, relogio: Relogio = RELOGIO_REAL) {
    this.#intervaloMs = Math.ceil(1000 / porSegundo);
    this.#relogio = relogio;
  }

  /** Espera o necessário para o próximo envio daquele número respeitar o ritmo. */
  async aguardarVez(phoneNumberId: string): Promise<void> {
    const agora = this.#relogio.agora();
    const livreEm = this.#proximoLivre.get(phoneNumberId) ?? 0;
    const espera = Math.max(0, livreEm - agora);
    this.#proximoLivre.set(phoneNumberId, Math.max(agora, livreEm) + this.#intervaloMs);
    if (espera > 0) await this.#relogio.esperar(espera);
  }
}
