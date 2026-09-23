import { describe, expect, it } from 'vitest';
import {
  candidatosDeHost,
  ehDoSupabase,
  ehHostErrado,
  refDoProjeto,
  resolverAdminUrl,
  senhaDaUrl,
  urlDoSessionPooler,
} from '../scripts/pooler.mjs';

/**
 * Senha fictícia em todos os casos. O que se testa aqui é o parser e a montagem
 * da string — nenhuma conexão de verdade é aberta.
 */
const REF = 'abcdefghijklmnop';
const SENHA = 'Senha-Ficticia-123';
const DIRETA = `postgresql://postgres:${SENHA}@db.${REF}.supabase.co:5432/postgres`;
const TRANSACAO = `postgresql://postgres.${REF}:${SENHA}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
const SESSAO = `postgresql://postgres.${REF}:${SENHA}@aws-1-sa-east-1.pooler.supabase.com:5432/postgres`;

describe('ref do projeto', () => {
  it('acha no host da conexão direta', () => {
    expect(refDoProjeto(DIRETA)).toBe(REF);
  });

  it('acha no usuário das conexões de pooler', () => {
    expect(refDoProjeto(TRANSACAO)).toBe(REF);
    expect(refDoProjeto(SESSAO)).toBe(REF);
  });

  it('devolve undefined quando a string não é do Supabase', () => {
    expect(refDoProjeto('postgresql://postgres:x@localhost:5432/postgres')).toBeUndefined();
  });

  it('reclama de string que nem é URL', () => {
    expect(() => refDoProjeto('isto-nao-e-url')).toThrow('não é uma URL válida');
  });
});

describe('é do Supabase?', () => {
  it('reconhece as três formas do Supabase e o banco local', () => {
    expect(ehDoSupabase(DIRETA)).toBe(true);
    expect(ehDoSupabase(TRANSACAO)).toBe(true);
    expect(ehDoSupabase('postgresql://postgres:x@localhost:5432/postgres')).toBe(false);
  });
});

describe('senha', () => {
  it('sai decodificada, para não ser codificada duas vezes na montagem', () => {
    const comSimbolos = `postgresql://postgres:Se%40nha%3A1@db.${REF}.supabase.co:5432/postgres`;
    expect(senhaDaUrl(comSimbolos)).toBe('Se@nha:1');
  });

  it('aceita % solto sem quebrar', () => {
    // 'desconto100%' não é escape válido; decodificar levantaria erro.
    const comPorcento = `postgresql://postgres:desconto100%@db.${REF}.supabase.co:5432/postgres`;
    expect(senhaDaUrl(comPorcento)).toBe('desconto100%');
  });
});

describe('montagem da string alvo', () => {
  it('monta o Session pooler com usuário, host e porta certos', () => {
    expect(
      urlDoSessionPooler({ ref: REF, senha: SENHA, host: 'aws-0-sa-east-1.pooler.supabase.com' }),
    ).toBe(
      `postgresql://postgres.${REF}:${SENHA}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
    );
  });

  it('codifica símbolos que teriam outro significado na URL', () => {
    const url = urlDoSessionPooler({ ref: REF, senha: 'a@b:c/d', host: 'h' });
    expect(url).toContain('a%40b%3Ac%2Fd');
    // E volta ao original quando lido de novo: ida e volta sem perder nada.
    expect(senhaDaUrl(url)).toBe('a@b:c/d');
  });
});

describe('ordem dos hosts candidatos', () => {
  it('parte de aws-0 e depois aws-1 quando a string é a direta', () => {
    expect(candidatosDeHost(DIRETA)).toEqual([
      'aws-0-sa-east-1.pooler.supabase.com',
      'aws-1-sa-east-1.pooler.supabase.com',
    ]);
  });

  it('respeita a região configurada', () => {
    expect(candidatosDeHost(DIRETA, 'us-east-2')[0]).toBe('aws-0-us-east-2.pooler.supabase.com');
  });

  it('tenta primeiro o host que veio na string, sem repetir', () => {
    // Quem colou a string certa não deve pagar uma tentativa errada antes.
    expect(candidatosDeHost(SESSAO)).toEqual([
      'aws-1-sa-east-1.pooler.supabase.com',
      'aws-0-sa-east-1.pooler.supabase.com',
    ]);
  });
});

describe('o que é erro de host e o que é erro de senha', () => {
  it('trata "Tenant or user not found" e falha de DNS como host errado', () => {
    expect(ehHostErrado(new Error('Tenant or user not found'))).toBe(true);
    expect(ehHostErrado(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }))).toBe(true);
    // Host que existe no DNS mas não responde: o pg estoura sem código nenhum.
    expect(ehHostErrado(new Error('timeout expired'))).toBe(true);
  });

  it('não trata senha errada como host errado', () => {
    const auth = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    expect(ehHostErrado(auth)).toBe(false);
  });
});

describe('resolução', () => {
  const falhaDeHost = () => Promise.reject(new Error('Tenant or user not found'));

  it('usa o primeiro host que responde', async () => {
    const tentados: string[] = [];
    const { host, url } = await resolverAdminUrl(DIRETA, {
      testar: (u) => {
        tentados.push(new URL(u).hostname);
        return new URL(u).hostname.startsWith('aws-1') ? Promise.resolve() : falhaDeHost();
      },
    });
    expect(tentados).toEqual([
      'aws-0-sa-east-1.pooler.supabase.com',
      'aws-1-sa-east-1.pooler.supabase.com',
    ]);
    expect(host).toBe('aws-1-sa-east-1.pooler.supabase.com');
    expect(url).toBe(urlDoSessionPooler({ ref: REF, senha: SENHA, host }));
  });

  it('leva a região configurada até os hosts que tenta', async () => {
    const tentados: string[] = [];
    await resolverAdminUrl(DIRETA, {
      regiao: 'us-east-2',
      testar: (u) => {
        tentados.push(new URL(u).hostname);
        return Promise.resolve();
      },
    });
    expect(tentados).toEqual(['aws-0-us-east-2.pooler.supabase.com']);
  });

  it('normaliza a Transaction pooler para a porta de sessão', async () => {
    const { url } = await resolverAdminUrl(TRANSACAO, { testar: () => Promise.resolve() });
    expect(new URL(url).port).toBe('5432');
    expect(new URL(url).username).toBe(`postgres.${REF}`);
  });

  it('para na hora quando a senha é que está errada', async () => {
    const tentados: string[] = [];
    const auth = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    await expect(
      resolverAdminUrl(DIRETA, {
        testar: (u) => {
          tentados.push(new URL(u).hostname);
          return Promise.reject(auth);
        },
      }),
    ).rejects.toThrow('password authentication failed');
    // Um host só: insistir esconderia a senha errada atrás de "nenhum host respondeu".
    expect(tentados).toHaveLength(1);
  });

  it('diz quais hosts tentou quando nenhum responde', async () => {
    await expect(resolverAdminUrl(DIRETA, { testar: falhaDeHost })).rejects.toThrow(
      /aws-0-sa-east-1\.pooler\.supabase\.com, aws-1-sa-east-1\.pooler\.supabase\.com/,
    );
  });

  it('a mensagem de erro não leva a senha junto', async () => {
    await expect(resolverAdminUrl(DIRETA, { testar: falhaDeHost })).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(SENHA) as unknown }),
    );
  });

  it('deixa o banco local passar sem procurar pooler', async () => {
    // docker-compose e CI não têm pooler; falhar aqui quebraria o dia a dia.
    const local = 'postgresql://postgres:postgres@localhost:5432/postgres';
    let tentou = false;
    const r = await resolverAdminUrl(local, {
      testar: () => {
        tentou = true;
        return Promise.resolve();
      },
    });
    expect(r).toEqual({ url: local, host: 'localhost', resolvido: false });
    expect(tentou).toBe(false);
  });

  it('recusa string do Supabase sem ref em vez de tentar adivinhar', async () => {
    const semRef = 'postgresql://postgres:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres';
    await expect(resolverAdminUrl(semRef, { testar: () => Promise.resolve() })).rejects.toThrow(
      'ref do projeto',
    );
  });
});
