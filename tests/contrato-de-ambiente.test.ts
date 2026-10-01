import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  lerConfig,
  OPCIONAIS_DA_API,
  pareceCopiadoDoSupabase,
  VARIAVEIS_DA_API,
} from '../apps/api/src/config';
import {
  lerConfigWorker,
  OPCIONAIS_DO_WORKER,
  VARIAVEIS_DO_WORKER,
} from '../apps/worker/src/config';
import { validarAmbienteDoPainel, VARIAVEIS_DO_PAINEL } from '../apps/web/lib/ambiente';

/**
 * O contrato de ambiente dos três serviços.
 *
 * O problema que este arquivo resolve: a lista de variáveis exigidas vive no código e a
 * lista que uma pessoa lê para configurar o Railway vive no DEPLOY.md. As duas podem
 * divergir sem ninguém notar, e já divergiram nesta obra — uma tabela com nomes errados
 * quase fez o `SUPABASE_JWT_SECRET` ser GERADO em vez de copiado, e o sintoma seria
 * "senha errada" com a senha certa, em todo login, sem nada no log apontando para a
 * configuração.
 *
 * Doc errado é pior que doc ausente: o doc ausente manda a pessoa ler o código.
 *
 * O teste compara nos DOIS sentidos, e inclui o `.env.example`, que é a terceira lista
 * dos mesmos nomes. Três listas significam três chances de divergir.
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const DEPLOY = readFileSync(`${RAIZ}docs/DEPLOY.md`, 'utf8');

type Servico = 'api' | 'worker' | 'web';
const SERVICOS: readonly Servico[] = ['api', 'worker', 'web'];

/**
 * `PORT` é lida pelo código e NÃO deve ser configurada à mão: o Railway injeta. É o
 * único caso em que "o código lê" e "não vai para o serviço" são as duas coisas certas,
 * e por isso ela é exceção declarada em vez de buraco no contrato.
 */
const INJETADAS_PELA_PLATAFORMA: readonly string[] = ['PORT'];

/** A tabela do DEPLOY.md, lida como dado. */
function tabelaDoDeploy(): Map<string, Record<Servico, boolean>> {
  const titulo = '## Onde cada variável entra, e onde NÃO entra';
  const de = DEPLOY.indexOf(titulo);
  expect(de, 'a tabela de variáveis sumiu do DEPLOY.md').toBeGreaterThan(0);
  const resto = DEPLOY.slice(de + titulo.length);
  const fim = resto.indexOf('\n## ');
  const secao = fim === -1 ? resto : resto.slice(0, fim);

  const tabela = new Map<string, Record<Servico, boolean>>();
  for (const linha of secao.split('\n')) {
    const celulas = linha.split('|').map((c) => c.trim());
    // | `NOME` | api | worker | web | por quê |  => 7 pedaços com as bordas vazias
    const nome = /^`([A-Z_][A-Z0-9_]*)`$/.exec(celulas[1] ?? '')?.[1];
    if (nome === undefined) continue;
    const marca = (c: string | undefined): boolean => c === '✓';
    tabela.set(nome, {
      api: marca(celulas[2]),
      worker: marca(celulas[3]),
      web: marca(celulas[4]),
    });
  }
  expect(tabela.size, 'nenhuma linha de variável foi lida da tabela').toBeGreaterThan(10);
  return tabela;
}

/** O que cada serviço lê, segundo o próprio código. */
const DO_CODIGO: Record<Servico, readonly string[]> = {
  api: VARIAVEIS_DA_API,
  worker: VARIAVEIS_DO_WORKER,
  web: VARIAVEIS_DO_PAINEL.map((v) => v.nome),
};

describe('o código e o DEPLOY.md dizem a mesma coisa', () => {
  const tabela = tabelaDoDeploy();

  /** Sentido 1: variável no código e não no doc. Quem configura o Railway não a cadastra. */
  it.each(SERVICOS)('toda variável que o %s lê está marcada para ele no doc', (servico) => {
    const faltandoNoDoc = DO_CODIGO[servico]
      .filter((nome) => !INJETADAS_PELA_PLATAFORMA.includes(nome))
      .filter((nome) => tabela.get(nome)?.[servico] !== true);

    expect(
      faltandoNoDoc,
      `o ${servico} lê estas variáveis e o DEPLOY.md não manda configurá-las: quem monta o ` +
        'Railway pelo doc vai subir um serviço que não liga',
    ).toEqual([]);
  });

  /** Sentido 2: variável no doc e não no código. A pessoa cadastra segredo que ninguém usa. */
  it.each(SERVICOS)('toda variável marcada para o %s no doc é lida por ele', (servico) => {
    const sobrandoNoDoc = [...tabela.entries()]
      .filter(([, onde]) => onde[servico])
      .map(([nome]) => nome)
      .filter((nome) => !DO_CODIGO[servico].includes(nome));

    expect(
      sobrandoNoDoc,
      `o DEPLOY.md manda configurar estas no ${servico} e o código dele não as lê: segredo ` +
        'cadastrado onde não é usado é um lugar a mais de onde ele vaza',
    ).toEqual([]);
  });

  /**
   * Variável que a tabela marca em nenhum serviço não pode ser declarada por serviço
   * nenhum. É a regra que mantém `DATABASE_ADMIN_URL` fora dos três.
   */
  it('variável marcada em nenhum serviço não é declarada por nenhum', () => {
    const emNenhum = [...tabela.entries()]
      .filter(
        ([nome, onde]) =>
          !onde.api && !onde.worker && !onde.web && !INJETADAS_PELA_PLATAFORMA.includes(nome),
      )
      .map(([nome]) => nome);
    expect(
      emNenhum.length,
      'a tabela deixou de marcar alguma variável como "em nenhum"',
    ).toBeGreaterThan(0);

    for (const nome of emNenhum) {
      for (const servico of SERVICOS) {
        expect(
          DO_CODIGO[servico],
          `${nome} está marcada "em nenhum serviço" e o ${servico} a declara`,
        ).not.toContain(nome);
      }
    }
  });

  /** A terceira lista dos mesmos nomes. */
  it('o .env.example tem exatamente os nomes da tabela', () => {
    const noExemplo = new Set(
      readFileSync(`${RAIZ}.env.example`, 'utf8')
        .split('\n')
        .map((l) => /^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
        .filter((n): n is string => n !== undefined),
    );

    const daTabela = [...tabela.keys()].filter((n) => !INJETADAS_PELA_PLATAFORMA.includes(n));
    // NODE_ENV é posta pelo `next start`, não por quem copia o .env: fica fora do exemplo.
    const semExemplo = daTabela.filter((n) => n !== 'NODE_ENV' && !noExemplo.has(n));
    expect(semExemplo, 'estas estão na tabela e não no .env.example').toEqual([]);

    const semTabela = [...noExemplo].filter((n) => !tabela.has(n));
    expect(semTabela, 'estas estão no .env.example e não na tabela do DEPLOY.md').toEqual([]);
  });

  it('a tabela cobre os três serviços, e não só dois', () => {
    // Guarda contra a coluna do web ser esquecida quando alguém editar a tabela.
    for (const servico of SERVICOS) {
      const marcadas = [...tabela.values()].filter((onde) => onde[servico]).length;
      expect(marcadas, `nenhuma variável marcada para o ${servico}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Falhar no start, com nome e serviço
// ---------------------------------------------------------------------------

/**
 * Ambientes falsos, por serviço. Nenhum valor de verdade — os nomes dizem isso em
 * português, e o teste de vazamento no fim do arquivo confere que continua assim.
 */
const CHAVE_FALSA = Buffer.alloc(32, 7).toString('base64');
const JWT_FALSO = 'SEGREDO_FALSO_DE_TESTE_NAO_USE_1234567890';

const AMBIENTE_FALSO: Record<Servico, NodeJS.ProcessEnv> = {
  api: {
    DATABASE_URL: 'postgresql://falso:falso@localhost:5432/falso',
    WHATSAPP_APP_SECRET: 'falso',
    WHATSAPP_VERIFY_TOKEN: 'falso',
    SUPABASE_JWT_SECRET: JWT_FALSO,
    META_APP_ID: 'falso',
    META_APP_SECRET: 'falso',
    WHATSAPP_TOKEN_KEY: CHAVE_FALSA,
  },
  worker: {
    DATABASE_URL: 'postgresql://falso:falso@localhost:5432/falso',
    WHATSAPP_TOKEN: 'falso',
    ANTHROPIC_API_KEY: 'falso',
  },
  web: {
    API_URL: 'http://localhost:1',
    SUPABASE_URL: 'http://localhost:1',
    SUPABASE_ANON_KEY: 'falso',
    NODE_ENV: 'production',
  },
};

/** O mesmo ambiente sem UMA variável. Construir é melhor que `delete`: diz o que o teste faz. */
function semA(env: NodeJS.ProcessEnv, excluida: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([nome]) => nome !== excluida));
}

const VALIDAR: Record<Servico, (env: NodeJS.ProcessEnv) => void> = {
  api: (env) => {
    lerConfig(env);
  },
  worker: (env) => {
    lerConfigWorker(env);
  },
  web: (env) => {
    validarAmbienteDoPainel(env);
  },
};

/** As obrigatórias de cada serviço: faltar tem de derrubar. */
const OBRIGATORIAS: Record<Servico, readonly string[]> = {
  api: VARIAVEIS_DA_API.filter((n) => !OPCIONAIS_DA_API.includes(n)),
  worker: VARIAVEIS_DO_WORKER.filter((n) => !OPCIONAIS_DO_WORKER.includes(n)),
  web: VARIAVEIS_DO_PAINEL.filter((v) => v.obrigatoria).map((v) => v.nome),
};

/**
 * Quem É obrigatória, por LITERAL.
 *
 * `OBRIGATORIAS` é derivada do código, e derivada é cega para a mudança que importa: pôr
 * `.default('')` numa variável de segredo a transforma em opcional, e o teste abaixo
 * simplesmente para de conferi-la — passa verde enquanto o serviço passa a subir
 * degradado, que é exatamente o que o pedido proíbe.
 *
 * Esta lista é escrita à mão de propósito. Afrouxar uma variável exige apagar o nome dela
 * daqui, e aí alguém decidiu em vez de deixar escorregar.
 */
const SEM_PADRAO_POSSIVEL: Record<Servico, readonly string[]> = {
  api: [
    'DATABASE_URL',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'SUPABASE_JWT_SECRET',
    'META_APP_ID',
    'META_APP_SECRET',
    'WHATSAPP_TOKEN_KEY',
  ],
  worker: ['DATABASE_URL', 'WHATSAPP_TOKEN', 'ANTHROPIC_API_KEY'],
  web: ['API_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'NODE_ENV'],
};

describe('nenhuma variável de segredo ganha padrão', () => {
  it.each(SERVICOS)('as obrigatórias declaradas do %s continuam obrigatórias', (servico) => {
    for (const nome of SEM_PADRAO_POSSIVEL[servico]) {
      expect(
        OBRIGATORIAS[servico],
        `${nome} deixou de ser obrigatória no ${servico}: serviço que sobe sem ela atende ` +
          'requisição e falha na hora de usá-la, que é o pior momento possível',
      ).toContain(nome);
    }
  });

  it.each(SERVICOS)('a lista declarada do %s não guarda nome que o código não lê', (servico) => {
    // Lista órfã é permissão que ninguém revisa, igual à de exceções de cor.
    for (const nome of SEM_PADRAO_POSSIVEL[servico]) {
      expect(DO_CODIGO[servico], `${nome} está na lista e o ${servico} não a lê`).toContain(nome);
    }
  });
});

describe('variável faltando derruba o serviço, dizendo qual', () => {
  it.each(SERVICOS)('o ambiente falso completo do %s é aceito', (servico) => {
    expect(() => {
      VALIDAR[servico](AMBIENTE_FALSO[servico]);
    }).not.toThrow();
  });

  it.each(SERVICOS)('cada obrigatória do %s, faltando, derruba com o nome dela', (servico) => {
    expect(
      OBRIGATORIAS[servico].length,
      `o ${servico} não tem obrigatória nenhuma`,
    ).toBeGreaterThan(0);

    for (const nome of OBRIGATORIAS[servico]) {
      const env = semA(AMBIENTE_FALSO[servico], nome);

      let erro: unknown;
      try {
        VALIDAR[servico](env);
      } catch (e) {
        erro = e;
      }
      const mensagem = erro instanceof Error ? erro.message : '';
      expect(erro, `${servico} subiu sem ${nome}`).toBeInstanceOf(Error);
      // O NOME da variável, porque quem lê está no Railway e não no código.
      expect(mensagem, `a mensagem do ${servico} não diz "${nome}"`).toContain(nome);
      // E o SERVIÇO, porque os três sobem do mesmo repositório e os logs se parecem.
      expect(mensagem, `a mensagem não diz de qual serviço é`).toContain(servico);
    }
  });

  it.each(SERVICOS)('as opcionais do %s não derrubam quando faltam', (servico) => {
    const opcionais = DO_CODIGO[servico].filter((n) => !OBRIGATORIAS[servico].includes(n));
    for (const nome of opcionais) {
      const env = semA(AMBIENTE_FALSO[servico], nome);
      expect(() => {
        VALIDAR[servico](env);
      }, `${servico} derrubou por falta de ${nome}, que tem padrão`).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// A URL de dono do schema
// ---------------------------------------------------------------------------

/**
 * A guarda que impede o app de rodar como dono do schema, conferida nos TRÊS serviços
 * por comportamento.
 *
 * A api e o worker usam `recusarAdminUrl` de `@fliqo/db`; o painel tem a própria cópia,
 * porque ele não importa o pacote de banco (CLAUDE.md, regra 10). Amarrar os dois textos
 * seria frágil; amarrar o comportamento é o que importa.
 */
describe('DATABASE_ADMIN_URL derruba os três serviços', () => {
  it('a api e o worker recusam no caminho de start', () => {
    // A recusa deles vive no index.ts, não no config: o job de testes e o workflow de
    // migração têm a variável no ambiente legitimamente, e uma recusa na leitura do
    // schema derrubaria o próprio CI que aplica a regra.
    for (const arquivo of ['apps/api/src/index.ts', 'apps/worker/src/index.ts']) {
      expect(
        readFileSync(RAIZ + arquivo, 'utf8'),
        `${arquivo} não recusa a URL de dono do schema`,
        // A CHAMADA, com o parêntese: procurar só o identificador acha a linha de
        // `import` e passa verde com a chamada apagada. Foi o que aconteceu aqui na
        // primeira versão deste teste.
      ).toContain('recusarAdminUrl(');
    }
  });

  it('o painel recusa, e a mensagem diz o nome e o serviço', () => {
    const env = { ...AMBIENTE_FALSO.web, DATABASE_ADMIN_URL: 'postgresql://falso' };
    let erro: unknown;
    try {
      validarAmbienteDoPainel(env);
    } catch (e) {
      erro = e;
    }
    const mensagem = erro instanceof Error ? erro.message : '';
    expect(erro, 'o painel subiu conhecendo a URL de dono do schema').toBeInstanceOf(Error);
    expect(mensagem).toContain('DATABASE_ADMIN_URL');
    expect(mensagem).toContain('painel');
  });

  it('o painel confere a URL de dono ANTES de reclamar do que falta', () => {
    // Com tudo faltando E a URL de dono presente, a primeira coisa dita é a URL de dono:
    // ela é a que não pode ser "resolvida preenchendo o resto".
    let erro: unknown;
    try {
      validarAmbienteDoPainel({ DATABASE_ADMIN_URL: 'postgresql://falso' });
    } catch (e) {
      erro = e;
    }
    expect(erro instanceof Error ? erro.message : '').toContain('DATABASE_ADMIN_URL');
  });

  /**
   * A ORDEM, que é metade do pedido: validar antes de abrir porta ou conectar banco.
   *
   * Ler a configuração depois de `criarDb` significaria abrir conexão com o pooler para
   * depois descobrir que falta um segredo — e, pior, significaria que uma variável
   * faltando aparece como erro de banco, que manda quem está depurando para o lugar
   * errado.
   */
  it('a api e o worker leem a configuração ANTES de conectar e de ouvir', () => {
    const ordem: Record<string, { ler: string; depois: readonly string[] }> = {
      'apps/api/src/index.ts': { ler: 'lerConfig(', depois: ['criarDb(', 'criarFila(', 'listen('] },
      'apps/worker/src/index.ts': {
        ler: 'lerConfigWorker(',
        depois: ['criarDb(', 'criarFila(', 'servidorDeSaude('],
      },
    };

    for (const [arquivo, { ler, depois }] of Object.entries(ordem)) {
      const fonte = readFileSync(RAIZ + arquivo, 'utf8');
      const onde = fonte.indexOf(ler);
      expect(onde, `${arquivo} não lê a configuração`).toBeGreaterThan(0);
      for (const chamada of depois) {
        const alvo = fonte.indexOf(chamada);
        expect(alvo, `${arquivo} não chama ${chamada}`).toBeGreaterThan(0);
        expect(onde, `${arquivo} chama ${chamada} antes de validar a configuração`).toBeLessThan(
          alvo,
        );
      }
    }
  });

  it('nenhum serviço declara a URL de dono no schema de configuração', () => {
    for (const config of ['apps/api/src/config.ts', 'apps/worker/src/config.ts']) {
      expect(
        readFileSync(RAIZ + config, 'utf8'),
        `${config} declara DATABASE_ADMIN_URL no schema`,
      ).not.toMatch(/DATABASE_ADMIN_URL:\s*z\./);
    }
  });

  it('a guarda do painel roda antes de o Next abrir porta', () => {
    // O instrumentation.ts do Next roda DEPOIS de a porta subir — o Next imprime "Ready"
    // e só então falha. Então o `start` chama o script primeiro, e o `&&` corta a linha.
    const pacote = JSON.parse(readFileSync(`${RAIZ}apps/web/package.json`, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const start = pacote.scripts.start ?? '';
    expect(start, 'o start do painel não confere o ambiente antes').toContain('conferir-ambiente');
    expect(
      start.indexOf('conferir-ambiente'),
      'a conferência tem de vir ANTES do next start',
    ).toBeLessThan(start.indexOf('next start'));
    expect(start, 'sem && o next sobe mesmo com a conferência falhando').toContain('&&');
  });
});

// ---------------------------------------------------------------------------
// O segredo que não se gera
// ---------------------------------------------------------------------------

describe('SUPABASE_JWT_SECRET tem de ser o do Supabase', () => {
  it('recusa o que um gerador produz', () => {
    // `openssl rand -base64 32` e os gerenciadores de senha produzem +, / e =, que não
    // aparecem no segredo do Supabase. É esse engano que produz "senha errada" com a
    // senha certa, em todo login, sem nada no log.
    for (const gerado of ['abc+def/ghi=', `${'a'.repeat(40)}=`, 'uma frase com espaco']) {
      expect(pareceCopiadoDoSupabase(gerado), `${gerado} deveria ser recusado`).toBe(false);
    }
  });

  it('aceita o formato que o Supabase emite', () => {
    expect(pareceCopiadoDoSupabase('a'.repeat(40))).toBe(true);
    expect(pareceCopiadoDoSupabase(JWT_FALSO)).toBe(true);
  });

  it('o serviço não sobe com segredo gerado, e a mensagem manda pegar no Supabase', () => {
    const env = { ...AMBIENTE_FALSO.api, SUPABASE_JWT_SECRET: `${'x'.repeat(43)}=` };
    let erro: unknown;
    try {
      lerConfig(env);
    } catch (e) {
      erro = e;
    }
    const mensagem = erro instanceof Error ? erro.message : '';
    expect(erro).toBeInstanceOf(Error);
    expect(mensagem).toContain('SUPABASE_JWT_SECRET');
    expect(mensagem.toLowerCase()).toContain('não gere');
  });

  it('segredo curto é recusado: não dá para assinar token com meia chave', () => {
    const env = { ...AMBIENTE_FALSO.api, SUPABASE_JWT_SECRET: 'curto' };
    expect(() => {
      lerConfig(env);
    }).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it('o DEPLOY.md diz onde pegar, e diz para não gerar', () => {
    // A tabela é o que eu leio configurando o Railway; se ela não disser isto, a próxima
    // pessoa gera um valor e perde a tarde.
    const linha = DEPLOY.split('\n').filter((l) => l.includes('SUPABASE_JWT_SECRET'));
    expect(linha.length, 'SUPABASE_JWT_SECRET não aparece no DEPLOY.md').toBeGreaterThan(0);
    const juntas = linha.join(' ');
    expect(juntas, 'falta dizer onde pegar').toMatch(/JWT Secret/);
    expect(juntas, 'falta dizer para NÃO gerar').toMatch(/não gere/);
  });
});

// ---------------------------------------------------------------------------
// Nenhum valor real em lugar nenhum
// ---------------------------------------------------------------------------

/**
 * Formatos de credencial de verdade. A lista é de FORMAS, não de valores: procurar por
 * "o segredo que a gente usa" exigiria escrever o segredo no teste.
 *
 * As três se identificam sozinhas — um valor com esse formato é uma credencial, não um
 * exemplo. Por isso NÃO há padrão de string de conexão aqui: o segredo dela é a senha, e
 * senha falsa não tem forma diferente de senha real. Uma guarda que acusa o fixture
 * legítimo (os testes do pooler precisam de URL com cara de Supabase para exercitar o
 * parser) ensina a acrescentar exceção, e é assim que guarda morre. Esse lado é coberto
 * pelo teste do `.env.example` e pelo `.env` fora do git, em tests/deploy.test.ts.
 */
const FORMAS_DE_CREDENCIAL: readonly { nome: string; padrao: RegExp }[] = [
  { nome: 'token do Supabase (JWT)', padrao: /\beyJ[A-Za-z0-9_-]{20,}/ },
  { nome: 'chave de provedor de IA', padrao: /\bsk-[a-z]+-[A-Za-z0-9_-]{20,}/ },
  { nome: 'token longo da Meta', padrao: /\bEAA[A-Za-z0-9]{40,}/ },
];

const IGNORAR = new Set([
  'node_modules',
  '.next',
  'out',
  'dist',
  'coverage',
  '.git',
  'test-results',
  'playwright-report',
]);

function arquivosDeTexto(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = `${dir}/${nome}`;
    if (statSync(caminho).isDirectory()) {
      achados.push(...arquivosDeTexto(caminho));
      continue;
    }
    if (/\.(ts|tsx|mjs|js|json|md|sql|ya?ml|example|html)$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

describe('nenhum valor de verdade no repositório', () => {
  it.each(FORMAS_DE_CREDENCIAL)('não há $nome em arquivo nenhum', ({ padrao }) => {
    const infratores = arquivosDeTexto(RAIZ.replace(/\/$/, ''))
      // Este próprio arquivo descreve as formas: ele não pode se acusar.
      .filter((f) => !f.endsWith('tests/contrato-de-ambiente.test.ts'))
      .filter((f) => padrao.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(RAIZ.length));

    expect(infratores, 'credencial de verdade commitada: troque a chave antes de remover').toEqual(
      [],
    );
  });
});
