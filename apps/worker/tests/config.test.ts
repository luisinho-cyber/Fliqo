import type { AmbienteConhecido } from '@fliqo/core';
import { describe, expect, it } from 'vitest';
import { lerConfigWorker } from '../src/config';

/**
 * O mínimo para o worker subir. Tudo falso: nenhum destes valores abre coisa alguma.
 *
 * Falso mas com o FORMATO certo, e isso não é zelo: o esquema único cobra formato
 * (`DATABASE_URL` conectando como `fliqo_app`, chave de 32 bytes em base64). Com a base
 * inválida, o caso do token curto passava porque o start falhava por OUTRA variável — teste
 * verde pelo motivo errado, que é o que esta base existe para não ser.
 */
const BASE: AmbienteConhecido = {
  DATABASE_URL: 'postgresql://fliqo_app.ref-falso:senha-falsa@pooler.exemplo:6543/postgres',
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
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
    // E é SÓ o token: com a base válida, o erro tem uma variável, não quatro.
    expect(() => lerConfigWorker({ ...BASE, ESTADO_TOKEN: curto })).toThrow(
      /1 variável de ambiente com problema/,
    );
  });
});
