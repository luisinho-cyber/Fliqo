import { describe, expect, it } from 'vitest';
import { semSegredos } from '../scripts/segredos.mjs';

/**
 * Os scripts de banco rodam num workflow do GitHub, e a saída fica guardada.
 * O que não pode aparecer ali é senha — nem a do dono do schema, nem a do papel
 * da aplicação.
 */
describe('limpeza de segredos na saída dos scripts', () => {
  const URL = 'postgresql://postgres:Senha-Do-Dono-123@db.projeto.supabase.co:5432/postgres';
  const SENHA = 'senha-do-fliqo-app-9876';

  it('tira o segredo inteiro quando ele aparece', () => {
    const limpo = semSegredos(`falha ao conectar em ${URL}`, [URL, SENHA]);
    expect(limpo).not.toContain('Senha-Do-Dono-123');
    expect(limpo).toContain('[removido]');
  });

  it('tira a senha do papel mesmo solta no meio do texto', () => {
    const limpo = semSegredos(`alter role falhou com ${SENHA} no comando`, [URL, SENHA]);
    expect(limpo).not.toContain(SENHA);
  });

  it('tira a senha de uma URL que ninguém passou na lista', () => {
    // A rede de segurança: um erro pode trazer uma URL que o script não conhece.
    const outra = 'postgres://fliqo_app:OutraSenha@pooler.supabase.com:6543/postgres';
    const limpo = semSegredos(`falhou em ${outra}`, []);
    expect(limpo).not.toContain('OutraSenha');
    // O resto continua legível: sem isso, o erro vira inútil.
    expect(limpo).toContain('pooler.supabase.com:6543');
  });

  it('não estraga um texto sem segredo nenhum', () => {
    expect(semSegredos('role "fliqo_app" does not exist', [URL, SENHA])).toBe(
      'role "fliqo_app" does not exist',
    );
  });

  it('ignora entrada vazia ou curta demais para ser segredo', () => {
    // Substituir uma string de 1 caractere deixaria a mensagem ilegível.
    expect(semSegredos('erro de conexao', ['a', '', undefined])).toBe('erro de conexao');
  });
});
