import {
  AMBIENTE_DA_API,
  AMBIENTE_DE_FERRAMENTA,
  AMBIENTE_DO_WORKER,
  ESQUEMAS_DE_AMBIENTE,
} from '@fliqo/core';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * As guardas do deploy.
 *
 * `startCommand` errado, health check faltando e variável de segredo no serviço
 * errado não aparecem em teste de unidade nenhum: aparecem no deploy, com a
 * clínica esperando. Aqui elas aparecem no CI.
 *
 * Este arquivo mora na raiz porque a pergunta é do repositório inteiro, não de um
 * app — os serviços saem do mesmo monorepo, e api e worker disputam o mesmo pooler.
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

interface Railway {
  build?: { builder?: string; buildCommand?: string };
  deploy?: {
    startCommand?: string;
    healthcheckPath?: string;
    healthcheckTimeout?: number;
    restartPolicyType?: string;
  };
}

interface PacoteNpm {
  name?: string;
  scripts?: Record<string, string>;
}

function lerRailway(caminho: string): Railway {
  return JSON.parse(readFileSync(RAIZ + caminho, 'utf8')) as Railway;
}

function lerPacote(caminho: string): PacoteNpm {
  return JSON.parse(readFileSync(RAIZ + caminho, 'utf8')) as PacoteNpm;
}

/**
 * Os serviços do Railway, enumerados — no formato das outras listas do
 * projeto (`SEM_FORCE`, `ACOES_QUE_ENVIAM`). Serviço novo entra aqui por decisão,
 * e serviço que sair da lista sem sair do repositório quebra o CI abaixo.
 */
const SERVICOS = [
  { nome: 'api', pasta: 'apps/api', pacote: '@fliqo/api' },
  { nome: 'worker', pasta: 'apps/worker', pacote: '@fliqo/worker' },
  { nome: 'web', pasta: 'apps/web', pacote: '@fliqo/web' },
  { nome: 'demo', pasta: 'apps/demo', pacote: '@fliqo/demo' },
] as const;

describe('a lista de serviços descreve o repositório', () => {
  it('todo app com railway.json está enumerado', () => {
    const daRaiz = JSON.parse(readFileSync(`${RAIZ}package.json`, 'utf8')) as {
      workspaces: string[];
    };
    expect(daRaiz.workspaces).toContain('apps/*');

    const comConfig = ['api', 'worker', 'web', 'demo'].filter((app) => {
      try {
        readFileSync(`${RAIZ}apps/${app}/railway.json`, 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    expect(comConfig.sort()).toEqual(SERVICOS.map((s) => s.nome).sort());
  });
});

describe.each(SERVICOS)('$nome', ({ pasta, pacote }) => {
  const railway = lerRailway(`${pasta}/railway.json`);
  const npm = lerPacote(`${pasta}/package.json`);

  it('o startCommand chama um script que existe de verdade', () => {
    const comando = railway.deploy?.startCommand;
    expect(comando, 'sem startCommand o Railway não sabe o que rodar').toBeDefined();
    // `npm start --workspace @fliqo/x`: confere o nome do workspace E o script.
    expect(comando).toContain(pacote);
    const script = /npm (\w+) --workspace/.exec(comando ?? '')?.[1];
    expect(
      Object.keys(npm.scripts ?? {}),
      `script "${script ?? '?'}" não existe em ${pasta}`,
    ).toContain(script);
  });

  it('o nome do pacote no startCommand é o nome real do workspace', () => {
    expect(npm.name).toBe(pacote);
  });

  /**
   * Health check em TODOS, worker incluído. Um worker sem health check morre em
   * silêncio, e silêncio aqui significa nenhuma confirmação enviada e ninguém
   * sabendo — o pior caso deste produto.
   */
  it('tem health check', () => {
    expect(railway.deploy?.healthcheckPath).toBe('/health');
    expect(railway.deploy?.healthcheckTimeout).toBeGreaterThan(0);
  });

  it('reinicia sozinho quando cai', () => {
    expect(railway.deploy?.restartPolicyType).toBe('ON_FAILURE');
  });

  it('o build instala a partir do lockfile', () => {
    // `npm install` no build resolveria versões diferentes das testadas aqui.
    expect(railway.build?.buildCommand).toContain('npm ci');
  });
});

describe('a porta vem do ambiente, nunca fixa no código', () => {
  it('api e worker declaram PORT no esquema, com padrões diferentes', () => {
    /*
     * Pelo ESQUEMA, não pelo texto do config.ts: a configuração dos dois passou a sair de
     * packages/core/src/ambiente.ts, e guarda que confere texto de arquivo deixa de ver a
     * coisa no dia em que ela muda de lugar — foi o que aconteceu com esta.
     *
     * Padrões diferentes porque os dois sobem na mesma máquina em desenvolvimento: iguais,
     * o segundo não escutaria.
     */
    const porta = (esquema: readonly { nome: string; padrao?: string | number }[]) =>
      esquema.find((v) => v.nome === 'PORT');
    expect(porta(AMBIENTE_DA_API)?.padrao).toBe(3000);
    expect(porta(AMBIENTE_DO_WORKER)?.padrao).toBe(3100);
  });

  it('o painel usa a PORT que o Railway injeta', () => {
    const npm = lerPacote('apps/web/package.json');
    expect(npm.scripts?.start).toContain('PORT');
  });
});

/**
 * As travas do ambiente são a PRIMEIRA instrução de cada serviço.
 *
 * Aqui se confere só a POSIÇÃO, que é estrutura de arquivo e não dá para observar
 * de fora: um serviço que abriu o pool com a conexão errada e só depois reclamou
 * já fez o que a trava existe para impedir. Que cada trava mate o processo de
 * verdade é conferido subindo os dois serviços, em tests/travas-de-ambiente.test.ts.
 *
 * A versão anterior desta seção conferia TEXTO — procurava `recusarAdminUrl(` nos
 * dois `index.ts` e `DATABASE_ADMIN_URL: z.` nos dois `config.ts`. O segundo guard
 * morreu no #37, quando os configs deixaram de usar Zod: ele passou a aprovar
 * qualquer coisa, inclusive a declaração que ele existia para proibir. Guarda que
 * confere texto não vê a coisa mudar de lugar; guarda que sobe o processo, vê.
 */
describe('as travas do ambiente vêm antes de qualquer conexão', () => {
  const ENTRADAS = [
    { arquivo: 'apps/api/src/index.ts', servico: 'a api' },
    { arquivo: 'apps/worker/src/index.ts', servico: 'o worker' },
  ] as const;

  /*
   * Pela ÁRVORE SINTÁTICA, e não pelas linhas do arquivo. A primeira tentativa aqui
   * procurava a primeira linha que não começasse com `import`, e o import de várias
   * linhas do worker já a enganou na primeira execução — que é a mesma fragilidade
   * dos guards de texto que esta seção substitui. Comentário não é nó, e import de
   * seis linhas é um nó só.
   */
  it.each(ENTRADAS)('$arquivo trava o ambiente na primeira instrução', ({ arquivo, servico }) => {
    const fonte = ts.createSourceFile(
      arquivo,
      readFileSync(RAIZ + arquivo, 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
    );
    const primeira = fonte.statements.find((s) => !ts.isImportDeclaration(s));

    expect(primeira, `${arquivo} não tem instrução nenhuma`).toBeDefined();
    const texto = primeira?.getText(fonte) ?? '';
    expect(texto, `${arquivo} faz outra coisa antes de travar o ambiente`).toContain(
      'travarAmbiente(',
    );
    expect(texto, `${arquivo} não nomeia o serviço na mensagem de recusa`).toContain(
      `'${servico}'`,
    );
  });

  it('nenhum config.ts tem caminho de leitura próprio', () => {
    /*
     * Dois caminhos de validação é a divergência que o esquema único acabou. E a
     * leitura não pode morar no config: as travas `proibida` e `vazada` recusam a
     * `DATABASE_ADMIN_URL`, que o job de testes e o workflow de migração têm no
     * ambiente legitimamente — uma recusa no carregamento do módulo derrubaria o
     * próprio CI que aplica a regra.
     */
    for (const config of ['apps/api/src/config.ts', 'apps/worker/src/config.ts']) {
      const fonte = readFileSync(RAIZ + config, 'utf8');
      expect(fonte, `${config} lê o ambiente fora do caminho de start`).not.toMatch(
        /travarAmbiente\(|exigirAmbiente\(|lerAmbiente\(|process\.env/,
      );
    }
  });

  it('nenhum esquema de serviço declara uma variável proibida', () => {
    // Pelos DADOS, não pelo texto: declarar uma variável que o serviço não usa
    // ensina a quem lê que ela é necessária, e daí ela acaba no Railway.
    const proibidas = AMBIENTE_DE_FERRAMENTA.filter((f) => f.proibidaNoServico).map((f) => f.nome);
    for (const [servico, esquema] of Object.entries(ESQUEMAS_DE_AMBIENTE)) {
      for (const v of esquema) {
        expect(
          proibidas,
          `${servico} declara ${v.nome}, que nenhum serviço pode conhecer`,
        ).not.toContain(v.nome);
      }
    }
  });
});

/**
 * Teto de conexões explícito nos dois serviços que falam com o banco.
 *
 * São dois pools por serviço — Kysely e pg-boss — e o pooler do Supabase é
 * compartilhado com as migrações. Sem teto, cada serviço consome o dobro do que
 * parece e o pooler esgota no primeiro pico; o sintoma é erro de conexão que
 * parece problema do banco.
 */
describe('o pool tem teto', () => {
  it('api e worker passam o teto para criarDb e criarFila', () => {
    for (const arquivo of ['apps/api/src/index.ts', 'apps/worker/src/index.ts']) {
      const fonte = readFileSync(RAIZ + arquivo, 'utf8');
      expect(fonte, `${arquivo} chama criarDb sem teto`).toMatch(
        /criarDb\(config\.DATABASE_URL,\s*POOL_CONSULTAS\)/,
      );
      expect(fonte, `${arquivo} chama criarFila sem teto`).toMatch(
        /criarFila\(config\.DATABASE_URL,\s*POOL_DA_FILA\)/,
      );
    }
  });

  it('a soma dos tetos está documentada no DEPLOY.md', () => {
    // O número sem o motivo escrito é um número que alguém vai mexer no escuro.
    const deploy = readFileSync(`${RAIZ}docs/DEPLOY.md`, 'utf8');
    expect(deploy).toContain('POOL_CONSULTAS');
    expect(deploy).toContain('POOL_DA_FILA');
  });
});

describe('nenhum segredo no repositório', () => {
  it('o .env.example só tem nomes, e os valores de exemplo são visivelmente falsos', () => {
    const exemplo = readFileSync(`${RAIZ}.env.example`, 'utf8');
    const preenchidas = exemplo
      .split('\n')
      .filter((l) => !l.startsWith('#') && l.includes('='))
      .map((l) => l.split('='))
      .filter(([, valor]) => (valor ?? '').trim().length > 0);

    for (const [nome, ...resto] of preenchidas) {
      const valor = resto.join('=');
      // O que sobra preenchido é placeholder (SEU_PROJETO, SENHA_DO_...) ou porta.
      expect(
        /SEU_|SENHA_|HOST_|sua-clinica|^\d+$|^info$/.test(valor),
        `${nome ?? ''} parece ter valor de verdade no .env.example`,
      ).toBe(true);
    }
  });

  it('o .env está ignorado pelo git', () => {
    expect(readFileSync(`${RAIZ}.gitignore`, 'utf8')).toMatch(/^\.env$/m);
  });
});

/**
 * As guardas dos fluxos do GitHub Actions.
 *
 * Um job sem `permissions:` herda o padrão da organização, que costuma ser leitura E
 * escrita; e `actions/checkout` sem `persist-credentials: false` deixa esse token em
 * `.git/config` do runner. Os três fluxos rodam `npm ci` depois do checkout, e `npm ci`
 * executa postinstall de dependência — a distância entre uma dependência comprometida e
 * escrita no repositório era um `cat`. No `migrar-banco` o mesmo job recebe
 * `DATABASE_ADMIN_URL`, a conexão de dono do schema, que não passa pela RLS.
 *
 * Fica aqui, e não num fluxo que se confere no olho, porque a regra é a mesma para todo
 * job e para todo checkout: fluxo novo ou job novo passa por isto ou quebra o CI.
 */
const FLUXOS = ['ci.yml', 'migrar-banco.yml', 'conferir-rls.yml'] as const;

function lerFluxo(nome: string): string {
  return readFileSync(`${RAIZ}.github/workflows/${nome}`, 'utf8');
}

describe('os fluxos do Actions rodam com o mínimo de privilégio', () => {
  it('todo fluxo do repositório está enumerado', () => {
    const noDisco = readdirSync(`${RAIZ}.github/workflows`).filter((f) => f.endsWith('.yml'));
    expect([...noDisco].sort()).toEqual([...FLUXOS].sort());
  });

  it('todo job declara permissions com contents: read', () => {
    for (const nome of FLUXOS) {
      // Só o que vem DEPOIS de `jobs:`. Antes dele há chaves de dois espaços que não
      // são job (`push:` e `workflow_dispatch:`, sob `on:`), e contá-las fazia a guarda
      // acusar o migrar-banco de ter três jobs.
      const fluxo = lerFluxo(nome).split(/^jobs:$/m)[1] ?? '';
      // Um job é uma chave de dois espaços sob `jobs:`; `permissions` e `runs-on` vêm
      // com quatro. Contar os dois e comparar é o que pega o job novo sem o bloco.
      const jobs = [...fluxo.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
      const comPermissao = [...fluxo.matchAll(/^ {4}permissions:\n {6}contents: read$/gm)];
      expect(jobs.length, `${nome} não tem job`).toBeGreaterThan(0);
      expect(
        comPermissao.length,
        `${nome} tem ${String(jobs.length)} job(s) e ${String(comPermissao.length)} bloco(s) de permissions`,
      ).toBe(jobs.length);
    }
  });

  it('nenhum job pede escrita em contents', () => {
    for (const nome of FLUXOS) {
      expect(lerFluxo(nome), `${nome} pede escrita`).not.toMatch(/contents:\s*write/);
    }
  });

  it('todo checkout desliga a persistência da credencial', () => {
    for (const nome of FLUXOS) {
      const fluxo = lerFluxo(nome);
      const checkouts = [...fluxo.matchAll(/uses: actions\/checkout@/g)].length;
      const desligados = [...fluxo.matchAll(/^ {10}persist-credentials: false$/gm)].length;
      expect(checkouts, `${nome} não faz checkout`).toBeGreaterThan(0);
      expect(
        desligados,
        `${nome} tem ${String(checkouts)} checkout(s) e ${String(desligados)} com persist-credentials: false`,
      ).toBe(checkouts);
    }
  });
});
