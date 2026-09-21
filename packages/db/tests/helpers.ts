/**
 * Os testes de packages/db continuam importando daqui; o conteúdo mora em
 * src/testing.ts para que apps/* também possam usar, via @fliqo/db/testing,
 * sem caminho relativo atravessando pacote.
 */
export * from '../src/testing';
