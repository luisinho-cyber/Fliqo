import { validarAmbienteDoPainel } from './lib/ambiente';

/**
 * O Next chama `register` uma vez, quando o servidor sobe e ANTES de atender a primeira
 * requisição. É o único lugar do painel equivalente ao `index.ts` da api e do worker.
 *
 * Estourar aqui derruba o processo, o health check não responde, e o Railway marca o
 * deploy como falho em vez de promover um painel que não consegue logar ninguém.
 */
export function register(): void {
  validarAmbienteDoPainel();
}
