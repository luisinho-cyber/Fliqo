import { describe, expect, it } from 'vitest';
import { recusarAdminUrl } from '../src/conexao';

/**
 * A recusa da URL de dono do schema.
 *
 * O dono do schema NÃO passa pela RLS (CLAUDE.md, regra 2). Um serviço que atende
 * requisição não tem por que conhecer essa conexão — e um que a conhece está a uma
 * linha de virar vazamento entre clínicas, num apuro de madrugada.
 *
 * Isto é o que torna "não vai para o Railway em hipótese nenhuma" verificável, em
 * vez de uma linha num documento que ninguém lê na hora de criar o serviço.
 */

const URL_DO_DONO = 'postgresql://postgres:Senha-Do-Dono@db.projeto.supabase.co:5432/postgres';

describe('recusarAdminUrl', () => {
  it('estoura quando a variável está no ambiente, nomeando o serviço', () => {
    expect(() => recusarAdminUrl('a api', { DATABASE_ADMIN_URL: URL_DO_DONO })).toThrow(/a api/);
    expect(() => recusarAdminUrl('o worker', { DATABASE_ADMIN_URL: URL_DO_DONO })).toThrow(
      /o worker/,
    );
  });

  it('a mensagem nomeia a variável e diz o que fazer, sem repetir o valor', () => {
    let mensagem = '';
    try {
      recusarAdminUrl('a api', { DATABASE_ADMIN_URL: URL_DO_DONO });
    } catch (erro) {
      mensagem = erro instanceof Error ? erro.message : String(erro);
    }
    expect(mensagem).toContain('DATABASE_ADMIN_URL');
    expect(mensagem).toContain('Remova a variável deste serviço');
    // A mensagem vai para o log do Railway. Repetir a URL ali seria publicar a
    // senha do dono do schema para resolver um erro de configuração.
    expect(mensagem).not.toContain('Senha-Do-Dono');
    expect(mensagem).not.toContain('db.projeto.supabase.co');
  });

  it('deixa passar quando a variável não existe', () => {
    expect(() => recusarAdminUrl('a api', {})).not.toThrow();
  });

  it('string vazia é ausência, não configuração', () => {
    // O Railway grava variável vazia quando alguém apaga o valor e salva.
    expect(() => recusarAdminUrl('a api', { DATABASE_ADMIN_URL: '' })).not.toThrow();
  });

  /**
   * Ela lê o ambiente que recebe, não o global.
   *
   * Isto é o que permite testá-la dentro de um CI que TEM `DATABASE_ADMIN_URL` no
   * ambiente — o workflow de migração e o job de testes precisam dela para criar o
   * banco descartável. Uma recusa que olhasse `process.env` por conta própria
   * quebraria o próprio pipeline que a aplica. Onde ela é chamada de verdade está
   * garantido em `tests/deploy.test.ts`.
   */
  it('julga o ambiente que recebe, não o global', () => {
    const comVariavel = { DATABASE_ADMIN_URL: URL_DO_DONO };
    expect(() => recusarAdminUrl('a api', comVariavel)).toThrow();
    // O mesmo processo, ambiente diferente: nenhum estado global no meio.
    expect(() => recusarAdminUrl('a api', {})).not.toThrow();
  });
});
