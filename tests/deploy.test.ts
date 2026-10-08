import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * As guardas do deploy.
 *
 * `startCommand` errado, health check faltando e variável de segredo no serviço
 * errado não aparecem em teste de unidade nenhum: aparecem no deploy, com a
 * clínica esperando. Aqui elas aparecem no CI.
 *
 * Este arquivo mora na raiz porque a pergunta é do repositório inteiro, não de um
 * app — os três serviços saem do mesmo monorepo e disputam o mesmo pooler.
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
 * Os três serviços do Railway, enumerados — no formato das outras listas do
 * projeto (`SEM_FORCE`, `ACOES_QUE_ENVIAM`). Serviço novo entra aqui por decisão,
 * e serviço que sair da lista sem sair do repositório quebra o CI abaixo.
 */
const SERVICOS = [
  { nome: 'api', pasta: 'apps/api', pacote: '@fliqo/api' },
  { nome: 'worker', pasta: 'apps/worker', pacote: '@fliqo/worker' },
  { nome: 'web', pasta: 'apps/web', pacote: '@fliqo/web' },
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
   * Health check nos TRÊS, worker incluído. Ele roda só no início do deploy e é o
   * que impede um deploy que não sobe de entrar no lugar do que estava no ar. Não
   * vigia o serviço depois disso.
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
  it('api e worker leem PORT da configuração', () => {
    for (const config of ['apps/api/src/config.ts', 'apps/worker/src/config.ts']) {
      expect(readFileSync(RAIZ + config, 'utf8'), `${config} não lê PORT`).toContain('PORT');
    }
  });

  it('o painel usa a PORT que o Railway injeta', () => {
    const npm = lerPacote('apps/web/package.json');
    expect(npm.scripts?.start).toContain('PORT');
  });
});

/**
 * A recusa do `DATABASE_ADMIN_URL` mora no caminho de START, e só lá.
 *
 * Se ela estivesse na leitura do schema de configuração, quebraria o próprio CI:
 * o job de testes e o workflow de migração têm a variável no ambiente
 * legitimamente, porque é com ela que o banco descartável é criado. Esta guarda
 * é o que impede alguém de "melhorar" isso movendo a recusa para o config.
 */
describe('a recusa da URL de dono do schema', () => {
  const CHAMADORES = ['apps/api/src/index.ts', 'apps/worker/src/index.ts'] as const;

  it('é chamada no start dos dois serviços', () => {
    for (const arquivo of CHAMADORES) {
      expect(readFileSync(RAIZ + arquivo, 'utf8'), `${arquivo} não recusa a URL de dono`).toContain(
        'recusarAdminUrl(',
      );
    }
  });

  it('não é chamada de nenhum schema de configuração', () => {
    for (const config of ['apps/api/src/config.ts', 'apps/worker/src/config.ts']) {
      expect(
        readFileSync(RAIZ + config, 'utf8'),
        `${config} recusaria a variável no carregamento e derrubaria o CI`,
      ).not.toContain('recusarAdminUrl(');
    }
  });

  it('nenhum serviço declara DATABASE_ADMIN_URL como configuração sua', () => {
    // Declarar uma variável que o serviço não usa ensina a quem lê que ela é
    // necessária — e daí ela acaba configurada no Railway.
    for (const config of ['apps/api/src/config.ts', 'apps/worker/src/config.ts']) {
      const fonte = readFileSync(RAIZ + config, 'utf8');
      // Só a declaração do Zod conta: comentário explicando a ausência pode ficar.
      expect(fonte, `${config} declara DATABASE_ADMIN_URL no schema`).not.toMatch(
        /DATABASE_ADMIN_URL:\s*z\./,
      );
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
