import { describe, expect, it } from 'vitest';
import {
  candidatosDeHost,
  conferirAlvo,
  diagnostico,
  ehDoSupabase,
  ehHostErrado,
  ehSenhaRecusada,
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

describe('diagnóstico antes de conectar', () => {
  it('conta host, porta e usuário das três formas, sem a senha', () => {
    for (const bruta of [DIRETA, TRANSACAO, SESSAO]) {
      const linha = diagnostico(
        urlDoSessionPooler({
          ref: REF,
          senha: senhaDaUrl(bruta),
          host: 'aws-0-sa-east-1.pooler.supabase.com',
        }),
        'motivo qualquer',
      );
      expect(linha).toContain('host=aws-0-sa-east-1.pooler.supabase.com');
      expect(linha).toContain('porta=5432');
      expect(linha).toContain(`usuario=postgres.${REF}`);
      expect(linha).not.toContain(SENHA);
    }
  });

  it('sai antes da conexão, não depois — é o que faltava para achar o erro', async () => {
    const ordem: string[] = [];
    await resolverAdminUrl(DIRETA, {
      registrar: () => ordem.push('diagnostico'),
      testar: () => {
        ordem.push('conexao');
        return Promise.resolve();
      },
    });
    expect(ordem).toEqual(['diagnostico', 'conexao']);
  });

  it('diz por que normalizou, conforme a forma que foi colada', async () => {
    const linhaDe = async (bruta: string) => {
      const linhas: string[] = [];
      await resolverAdminUrl(bruta, {
        registrar: (l: string) => linhas.push(l),
        testar: () => Promise.resolve(),
      });
      return linhas[0] ?? '';
    };
    expect(await linhaDe(DIRETA)).toContain('IPv6');
    expect(await linhaDe(TRANSACAO)).toContain('modo sessão');
    expect(await linhaDe(SESSAO)).toContain('host confirmado');
  });

  it('diz quando pulou, e por quê', async () => {
    const linhas: string[] = [];
    await resolverAdminUrl('postgresql://postgres:x@localhost:5432/postgres', {
      registrar: (l: string) => linhas.push(l),
      testar: () => Promise.resolve(),
    });
    expect(linhas[0]).toContain('normalização pulada');
    expect(linhas[0]).toContain('host=localhost');
  });
});

describe('usuário e host andam sempre juntos', () => {
  const HOST = 'aws-0-sa-east-1.pooler.supabase.com';

  it('aceita o alvo montado pela própria montagem', () => {
    const url = urlDoSessionPooler({ ref: REF, senha: SENHA, host: HOST });
    expect(conferirAlvo(url)).toBe(url);
  });

  it('recusa host de pooler com o usuário `postgres` solto', () => {
    // É exatamente o caso que a pessoa suspeitou: host novo, usuário velho.
    expect(() => conferirAlvo(`postgresql://postgres:${SENHA}@${HOST}:5432/postgres`)).toThrow(
      'sem o usuário postgres.<ref>',
    );
  });

  it('recusa usuário com ref apontando para host que não é de pooler', () => {
    expect(() =>
      conferirAlvo(`postgresql://postgres.${REF}:${SENHA}@db.${REF}.supabase.co:5432/postgres`),
    ).toThrow('sem host de pooler');
  });

  it('recusa a porta de transação', () => {
    expect(() =>
      conferirAlvo(`postgresql://postgres.${REF}:${SENHA}@${HOST}:6543/postgres`),
    ).toThrow('fora da porta de sessão');
  });
});

describe('resolução', () => {
  const falhaDeHost = () => Promise.reject(new Error('Tenant or user not found'));

  it('usa o primeiro host que responde', async () => {
    const tentados: string[] = [];
    const { host, url } = await resolverAdminUrl(DIRETA, {
      registrar: () => {},
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
      registrar: () => {},
      testar: (u) => {
        tentados.push(new URL(u).hostname);
        return Promise.resolve();
      },
    });
    expect(tentados).toEqual(['aws-0-us-east-2.pooler.supabase.com']);
  });

  it('normaliza a Transaction pooler para a porta de sessão', async () => {
    const { url } = await resolverAdminUrl(TRANSACAO, {
      registrar: () => {},
      testar: () => Promise.resolve(),
    });
    expect(new URL(url).port).toBe('5432');
    expect(new URL(url).username).toBe(`postgres.${REF}`);
  });

  it('para na hora quando a senha é que está errada, e explica o nome na mensagem', async () => {
    const tentados: string[] = [];
    // A mensagem que o Supavisor devolve cita o papel do banco por trás, não o
    // usuário com que conectamos. Foi isso que fez parecer erro de normalização.
    const auth = Object.assign(new Error('password authentication failed for user "postgres"'), {
      code: '28P01',
    });
    const erro = await resolverAdminUrl(DIRETA, {
      registrar: () => {},
      testar: (u) => {
        tentados.push(new URL(u).hostname);
        return Promise.reject(auth);
      },
    }).then(
      () => new Error('deveria ter falhado'),
      (e: unknown) => e as Error,
    );

    // Um host só: insistir esconderia a senha errada atrás de "nenhum host respondeu".
    expect(tentados).toHaveLength(1);
    expect(erro.message).toContain('recusou a senha');
    expect(erro.message).toContain('DATABASE_ADMIN_URL');
    expect(erro.message).toContain(`postgres.${REF}`);
    expect(erro.message).not.toContain(SENHA);
  });

  it('reconhece senha recusada pelo código e pela mensagem', () => {
    expect(ehSenhaRecusada(Object.assign(new Error('nada'), { code: '28P01' }))).toBe(true);
    expect(ehSenhaRecusada(new Error('password authentication failed for user "postgres"'))).toBe(
      true,
    );
    expect(ehSenhaRecusada(new Error('Tenant or user not found'))).toBe(false);
  });

  it('nunca deixa o host direto passar sem normalizar', async () => {
    // Ele é IPv6: passar direto seria uma falha de rede sem explicação.
    const usados: string[] = [];
    const { url, resolvido } = await resolverAdminUrl(DIRETA, {
      registrar: () => {},
      testar: (u) => {
        usados.push(new URL(u).hostname);
        return Promise.resolve();
      },
    });
    expect(resolvido).toBe(true);
    expect(usados.every((h) => h.endsWith('.pooler.supabase.com'))).toBe(true);
    expect(new URL(url).hostname).not.toContain('db.');
  });

  it('diz quais hosts tentou quando nenhum responde', async () => {
    await expect(
      resolverAdminUrl(DIRETA, { registrar: () => {}, testar: falhaDeHost }),
    ).rejects.toThrow(
      /aws-0-sa-east-1\.pooler\.supabase\.com, aws-1-sa-east-1\.pooler\.supabase\.com/,
    );
  });

  it('a mensagem de erro não leva a senha junto', async () => {
    await expect(
      resolverAdminUrl(DIRETA, { registrar: () => {}, testar: falhaDeHost }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(SENHA) as unknown }),
    );
  });

  it('deixa o banco local passar sem procurar pooler', async () => {
    // docker-compose e CI não têm pooler; falhar aqui quebraria o dia a dia.
    const local = 'postgresql://postgres:postgres@localhost:5432/postgres';
    let tentou = false;
    const r = await resolverAdminUrl(local, {
      registrar: () => {},
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
    await expect(
      resolverAdminUrl(semRef, { registrar: () => {}, testar: () => Promise.resolve() }),
    ).rejects.toThrow('ref do projeto');
  });
});
