import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * As quatro travas, conferidas subindo os serviços de verdade.
 *
 * A guarda anterior era de TEXTO: procurava `recusarAdminUrl(` nos dois `index.ts`. Ela não
 * sabia dizer se a chamada estava antes ou depois do pool, não sabia se a função ainda fazia
 * o que o nome dizia, e a companheira dela — que procurava `DATABASE_ADMIN_URL: z.` — morreu
 * no #37 sem ninguém notar, porque os configs deixaram de usar Zod. Uma guarda que aprova
 * qualquer coisa é pior do que nenhuma: ela ocupa o lugar da que faltava.
 *
 * Aqui o teste faz o que o Railway faz. Roda `tsx src/index.ts` — o `startCommand` de verdade,
 * conferido em tests/deploy.test.ts — com um ambiente montado à mão, e exige que o processo
 * MORRA com a mensagem certa. Não há como isso passar com a trava quebrada.
 *
 * Nenhum valor aqui conecta em nada: o host não existe, e é isso que prova a ordem. Quando a
 * trava pega, o processo morre ANTES de tentar a rede; o caso de controle no fim do arquivo
 * passa pela trava e aí sim esbarra no host — que é a diferença entre "trava funcionando" e
 * "tudo morre de qualquer jeito".
 */

const RAIZ = fileURLToPath(new URL('../', import.meta.url));
const TSX = `${RAIZ}node_modules/.bin/tsx`;

/** Subir um serviço custa o start do tsx mais a tentativa de rede do caso de controle. */
const PRAZO_MS = 60_000;

/** A chave do cofre tem de ter 32 bytes, ou a trava `malformada` pega o caso errado. */
const CHAVE_DO_COFRE = Buffer.alloc(32, 7).toString('base64');

/**
 * A conexão da aplicação, falsa e bem formada.
 *
 * `fliqo_app` porque é o papel que a aplicação usa; host que não resolve porque o teste não
 * tem banco; sem espaço reservado em caixa alta, que é outra coisa que a trava `malformada`
 * recusa — e recusá-la aqui faria todo caso passar pelo motivo errado.
 */
const URL_DA_APLICACAO = 'postgresql://fliqo_app:senha-falsa@pooler.invalido.exemplo:6543/postgres';

/** A mesma conexão com o papel do DONO do schema, que não passa pela RLS. */
const URL_DO_DONO = 'postgresql://postgres:senha-falsa@direto.invalido.exemplo:5432/postgres';

interface Servico {
  readonly nome: string;
  readonly servico: string;
  readonly entrada: string;
  /** Ambiente completo: com ele o serviço passa pelas quatro travas. */
  readonly completo: Record<string, string>;
  /** Uma obrigatória qualquer, para o caso `faltando`. */
  readonly umaObrigatoria: string;
}

const SERVICOS: readonly Servico[] = [
  {
    nome: 'api',
    servico: 'a api',
    entrada: 'apps/api/src/index.ts',
    completo: {
      DATABASE_URL: URL_DA_APLICACAO,
      WHATSAPP_APP_SECRET: 'segredo-falso',
      WHATSAPP_VERIFY_TOKEN: 'frase-falsa',
      SUPABASE_JWT_SECRET: 'jwt-falso',
      META_APP_ID: '000000000000000',
      META_APP_SECRET: 'segredo-falso-do-app',
      WHATSAPP_TOKEN_KEY: CHAVE_DO_COFRE,
      PORT: '3999',
      LOG_LEVEL: 'silent',
    },
    umaObrigatoria: 'SUPABASE_JWT_SECRET',
  },
  {
    nome: 'worker',
    servico: 'o worker',
    entrada: 'apps/worker/src/index.ts',
    completo: {
      DATABASE_URL: URL_DA_APLICACAO,
      WHATSAPP_TOKEN: 'token-falso',
      ANTHROPIC_API_KEY: 'chave-falsa',
      PORT: '3998',
      LOG_LEVEL: 'silent',
    },
    umaObrigatoria: 'ANTHROPIC_API_KEY',
  },
];

interface Saida {
  codigo: number | null;
  stderr: string;
  stdout: string;
  expirou: boolean;
}

/**
 * Sobe um serviço com o ambiente dado e devolve como ele morreu.
 *
 * O ambiente é montado do zero, e não herdado: o job de testes tem a `DATABASE_ADMIN_URL` no
 * ambiente legitimamente — é com ela que o banco descartável é criado —, e herdá-la faria
 * todo caso deste arquivo bater na trava `proibida` por acidente.
 */
function subir(entrada: string, env: Record<string, string>): Saida {
  const r = spawnSync(TSX, [entrada], {
    cwd: RAIZ,
    encoding: 'utf8',
    timeout: PRAZO_MS,
    env: {
      // O mínimo para o node e o tsx acharem o que precisam.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
  });
  return {
    codigo: r.status,
    stderr: r.stderr,
    stdout: r.stdout,
    expirou: r.error !== undefined && 'code' in r.error && r.error.code === 'ETIMEDOUT',
  };
}

/** A trava morreu antes de qualquer conexão: nenhum erro de rede no caminho. */
function morreuAntesDaRede(saida: Saida): void {
  expect(saida.codigo, 'o processo não morreu').not.toBe(0);
  expect(saida.expirou, 'o processo ficou pendurado em vez de morrer').toBe(false);
  for (const deRede of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'getaddrinfo']) {
    expect(saida.stderr, `chegou a tentar a rede antes de travar (${deRede})`).not.toContain(
      deRede,
    );
  }
}

describe.each(SERVICOS)(
  '$nome: cada trava mata o processo',
  ({ servico, entrada, completo, umaObrigatoria }) => {
    it(
      'faltando: sem uma obrigatória, o processo morre nomeando a que falta',
      () => {
        const sem = Object.fromEntries(
          Object.entries(completo).filter(([nome]) => nome !== umaObrigatoria),
        );
        const saida = subir(entrada, sem);

        morreuAntesDaRede(saida);
        expect(saida.stderr).toContain(`${servico} não sobe`);
        expect(saida.stderr).toContain(umaObrigatoria);
        expect(saida.stderr).toContain('falta');
      },
      PRAZO_MS,
    );

    it(
      'malformada: com a conexão do dono do schema em DATABASE_URL, o processo morre',
      () => {
        // Este é o caso que a RLS não salvaria: as consultas funcionariam e enxergariam TODAS
        // as clínicas, porque o dono do schema não passa pela RLS (CLAUDE.md, regra 2).
        const saida = subir(entrada, { ...completo, DATABASE_URL: URL_DO_DONO });

        morreuAntesDaRede(saida);
        expect(saida.stderr).toContain('DATABASE_URL');
        expect(saida.stderr).toContain('fliqo_app');
        // A senha não entra na mensagem: ela sobe no log do Railway.
        expect(saida.stderr).not.toContain('senha-falsa');
      },
      PRAZO_MS,
    );

    it(
      'proibida: com DATABASE_ADMIN_URL no ambiente, o processo morre',
      () => {
        const saida = subir(entrada, { ...completo, DATABASE_ADMIN_URL: URL_DO_DONO });

        morreuAntesDaRede(saida);
        expect(saida.stderr).toContain('DATABASE_ADMIN_URL');
        expect(saida.stderr).toContain('Remova a variável deste serviço');
        expect(saida.stderr).not.toContain('senha-falsa');
      },
      PRAZO_MS,
    );

    it(
      'vazada: com uma NEXT_PUBLIC_ no ambiente, o processo morre',
      () => {
        const saida = subir(entrada, {
          ...completo,
          NEXT_PUBLIC_SUPABASE_SERVICE_KEY: 'chave-que-iria-para-o-navegador',
        });

        morreuAntesDaRede(saida);
        expect(saida.stderr).toContain('NEXT_PUBLIC_SUPABASE_SERVICE_KEY');
        expect(saida.stderr).toContain('navegador');
      },
      PRAZO_MS,
    );

    /**
     * O controle, e o teste mais importante do arquivo.
     *
     * Sem ele, uma trava que recusasse TUDO passaria nos quatro casos acima. Com o ambiente
     * certo o serviço tem de PASSAR pelas travas — e então morrer na rede, porque o host do
     * teste não existe. "Morreu" e "morreu pelo motivo certo" não são a mesma coisa.
     */
    it(
      'com o ambiente certo, as travas deixam passar e o serviço vai tentar o banco',
      () => {
        const saida = subir(entrada, completo);

        expect(saida.stderr, 'a trava recusou um ambiente completo e válido').not.toContain(
          'não sobe',
        );
        // Ou morreu na rede, ou ficou tentando: as duas provam que passou das travas.
        const chegouNaRede =
          saida.expirou ||
          ['ENOTFOUND', 'EAI_AGAIN', 'getaddrinfo', 'ECONNREFUSED'].some((e) =>
            saida.stderr.includes(e),
          );
        expect(chegouNaRede, `não passou das travas nem chegou à rede: ${saida.stderr}`).toBe(true);
      },
      PRAZO_MS,
    );
  },
);
