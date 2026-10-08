import { describe, expect, it } from 'vitest';
import { lerConfigWorker } from '../src/config';

/** O mínimo para o worker subir. Tudo falso: nenhum destes valores abre coisa alguma. */
const BASE = {
  DATABASE_URL: 'postgresql://falso@localhost:5432/falso',
  WHATSAPP_TOKEN_KEY: 'chave-falsa',
  ANTHROPIC_API_KEY: 'chave-falsa',
  EMAIL_API_KEY: 'chave-falsa',
  EMAIL_REMETENTE: 'avisos@sua-clinica.com.br',
  OPERADOR_EMAIL: 'operador@sua-clinica.com.br',
};

describe('ESTADO_TOKEN', () => {
  it('ausente, o worker sobe e o /estado fica fechado', () => {
    // O deploy que chega antes de a variável existir não pode cair por causa dela.
    expect(lerConfigWorker(BASE).ESTADO_TOKEN).toBeUndefined();
  });

  it('com 32 caracteres ou mais, é aceito', () => {
    const token = 'x'.repeat(32);
    expect(lerConfigWorker({ ...BASE, ESTADO_TOKEN: token }).ESTADO_TOKEN).toBe(token);
  });

  it('curto, o worker NÃO sobe, e o erro nomeia a variável sem mostrar o valor', () => {
    const curto = 'senha123';
    expect(() => lerConfigWorker({ ...BASE, ESTADO_TOKEN: curto })).toThrow(/ESTADO_TOKEN/);
    expect(() => lerConfigWorker({ ...BASE, ESTADO_TOKEN: curto })).not.toThrow(/senha123/);
  });
});
