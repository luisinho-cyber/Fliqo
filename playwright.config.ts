import { defineConfig, devices } from '@playwright/test';

/**
 * O painel de verdade, num navegador de verdade.
 *
 * Mora na RAIZ, e não em apps/web, por duas razões que se somam: ele sobe a API junto, então
 * não é "o painel"; e `apps/web/tests/guardas.test.ts` varre tudo dentro de apps/web
 * procurando `.from(` e segredo de configuração — guardas corretos, que existem porque aquele
 * diretório vai para o navegador. Um arquivo de e2e que precisa nomear `META_APP_SECRET` para
 * subir a API não tem o que fazer lá dentro, e afrouxar o guarda para acomodá-lo seria trocar
 * proteção por conveniência.
 *
 * O que o teste de integração não alcança: o dado que atravessou webhook, banco e API
 * chegando RENDERIZADO na tela que a recepção olha. Entre a resposta da API e o texto na
 * página há sessão, cookie, componente de servidor e formatação — e cada um deles já quebrou
 * sozinho em algum produto.
 *
 * Sobem dois serviços: a nossa API e o painel. `DATABASE_ADMIN_URL` é apagada nos dois de
 * propósito — `recusarAdminUrl` recusa subir com ela, e esse guarda é para valer também
 * aqui. Quem precisa dela é só o `global-setup`, que migra e semeia.
 */
const PORTA_API = 3401;
const PORTA_WEB = 3402;
const PORTA_AUTH = 3403;

const URL_DO_TESTER =
  process.env['PLAYWRIGHT_DATABASE_URL'] ??
  'postgres://fliqo_tester:fliqo_tester@localhost:5432/fliqo_test';

const executavel = process.env['CHROMIUM_EXECUTAVEL'] ?? process.env['PLAYWRIGHT_CHROMIUM'];

/**
 * O mesmo segredo que o `global-setup` usa para assinar o token da sessão, e que a API usa
 * para verificá-lo. Alfanumérico e com 32+ caracteres porque é o formato que a guarda do
 * `SUPABASE_JWT_SECRET` exige. Visivelmente falso, como manda a regra.
 */
const JWT_SECRET = 'SEGREDO_FALSO_DE_TESTE_NAO_USE_1234567890';

/**
 * O Supabase Auth falso, e NÃO um endereço inventado que não responde.
 *
 * O `proxy.ts` chama `getUser()`, que valida o token contra o servidor de autenticação — é a
 * decisão certa dele, e é o que faz cookie forjado não entrar. Então o e2e sobe um servidor
 * que responde `/auth/v1/user` conferindo a assinatura, igual ao Graph API falso do teste de
 * integração: o terceiro é mockado na borda HTTP, a produção não é afrouxada.
 *
 * O nome do cookie de sessão sai do HOST desta URL: o supabase-js usa
 * `sb-${hostname.split('.')[0]}-auth-token`, então `127.0.0.1` dá `sb-127-auth-token`.
 * Mudar a porta é inofensivo; mudar o host exige mudar `COOKIE_DA_SESSAO`.
 */
const SUPABASE_URL = `http://127.0.0.1:${String(PORTA_AUTH)}`;

const ambienteComum = {
  DATABASE_URL: URL_DO_TESTER,
  // Vazio conta como ausente para `recusarAdminUrl`, e é o que deixa a API subir.
  DATABASE_ADMIN_URL: '',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  LOG_LEVEL: 'silent',
};

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${String(PORTA_WEB)}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    ...(executavel === undefined ? {} : { launchOptions: { executablePath: executavel } }),
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: [
    {
      command: `node tests-e2e/supabase-auth-falso.mjs ${String(PORTA_AUTH)}`,
      url: `http://127.0.0.1:${String(PORTA_AUTH)}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 30_000,
      env: { SUPABASE_JWT_SECRET: JWT_SECRET },
    },
    {
      command: 'npx tsx apps/api/src/index.ts',
      url: `http://127.0.0.1:${String(PORTA_API)}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        ...ambienteComum,
        PORT: String(PORTA_API),
        WHATSAPP_APP_SECRET: 'segredo-do-app-da-meta-para-teste',
        WHATSAPP_VERIFY_TOKEN: 'token-de-verificacao-de-teste',
        META_APP_ID: 'app-de-teste',
        META_APP_SECRET: 'segredo-do-app-de-teste',
        WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
    },
    {
      command: `npx next dev -p ${String(PORTA_WEB)}`,
      cwd: 'apps/web',
      url: `http://127.0.0.1:${String(PORTA_WEB)}/login`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        ...ambienteComum,
        PORT: String(PORTA_WEB),
        API_URL: `http://127.0.0.1:${String(PORTA_API)}`,
        SUPABASE_URL,
        SUPABASE_ANON_KEY: 'chave-anonima-falsa-de-teste',
      },
    },
  ],
});

export const DADOS_DO_E2E = { JWT_SECRET, SUPABASE_URL, URL_DO_TESTER, PORTA_WEB };
