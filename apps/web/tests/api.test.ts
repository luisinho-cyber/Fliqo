import { describe, expect, it } from 'vitest';
import { chamarApi } from '../lib/api';

/**
 * O cliente da nossa API.
 *
 * O que importa aqui é a tradução do 401: ele não é "erro", é "a sessão
 * acabou" — e é por esse caminho que a tela manda a pessoa para o login.
 */

const ENV: NodeJS.ProcessEnv = { API_URL: 'https://api.exemplo', NODE_ENV: 'test' };
const TOKEN = 'token-de-teste-que-nao-pode-vazar';

function respondendo(status: number, corpo: unknown = {}): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(corpo), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

describe('chamarApi', () => {
  it('leva o token como Bearer e a clínica no cabeçalho', async () => {
    let visto: Request | undefined;
    const espiao: typeof fetch = (url, init) => {
      visto = new Request(url, init);
      return Promise.resolve(new Response('[]', { status: 200 }));
    };

    await chamarApi('/api/hoje', { token: TOKEN, clinicaId: 'abc', buscar: espiao }, ENV);

    expect(visto?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(visto?.headers.get('x-clinica')).toBe('abc');
    expect(visto?.url).toBe('https://api.exemplo/api/hoje');
  });

  it('401 vira sem_sessao: é o que manda a tela para o login', async () => {
    const r = await chamarApi('/api/hoje', { token: TOKEN, buscar: respondendo(401) }, ENV);
    expect(r).toEqual({ ok: false, motivo: 'sem_sessao' });
  });

  it('403 vira sem_acesso: a sessão vale, a clínica é que não é dela', async () => {
    const r = await chamarApi('/api/hoje', { token: TOKEN, buscar: respondendo(403) }, ENV);
    expect(r).toEqual({ ok: false, motivo: 'sem_acesso' });
  });

  it('500 e rede fora viram indisponivel, não login', async () => {
    // Deslogar quem só perdeu a rede seria perder o trabalho da recepção.
    expect(await chamarApi('/x', { token: TOKEN, buscar: respondendo(500) }, ENV)).toEqual({
      ok: false,
      motivo: 'indisponivel',
    });

    const caiu: typeof fetch = () => Promise.reject(new Error('rede'));
    expect(await chamarApi('/x', { token: TOKEN, buscar: caiu }, ENV)).toEqual({
      ok: false,
      motivo: 'indisponivel',
    });
  });

  it('erro de rede não carrega o token na mensagem', async () => {
    const caiu: typeof fetch = () => Promise.reject(new Error(`falhou com ${TOKEN}`));
    const r = await chamarApi('/x', { token: TOKEN, buscar: caiu }, ENV);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('devolve o corpo quando deu certo', async () => {
    const r = await chamarApi<{ a: number }>(
      '/x',
      { token: TOKEN, buscar: respondendo(200, { a: 1 }) },
      ENV,
    );
    expect(r).toEqual({ ok: true, dados: { a: 1 } });
  });

  it('sem API_URL não chuta endereço nenhum', async () => {
    await expect(
      chamarApi('/x', { token: TOKEN, buscar: respondendo(200) }, { NODE_ENV: 'test' }),
    ).rejects.toThrow('API_URL');
  });
});
