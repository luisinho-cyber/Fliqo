import { defineConfig, devices } from '@playwright/test';

const PORTA = 3100;
const executavel = process.env['CHROMIUM_EXECUTAVEL'];

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${String(PORTA)}`,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    ...(executavel === undefined ? {} : { launchOptions: { executablePath: executavel } }),
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
    { name: 'celular', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `node scripts/servir.mjs ${String(PORTA)}`,
    url: `http://127.0.0.1:${String(PORTA)}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
