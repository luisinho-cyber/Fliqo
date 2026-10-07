import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Os testes de banco recriam o mesmo banco descartável: rodam um arquivo por vez.
    fileParallelism: false,
    // A apps/demo é testada pelo Playwright (npm run e2e:demo), não pelo Vitest.
    // `tests-e2e` é do Playwright: os `.spec.ts` de lá usam o runner dele, não o do Vitest.
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/demo/**', 'tests-e2e/**'],
  },
});
