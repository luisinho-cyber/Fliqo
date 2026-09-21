import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Os testes de banco recriam o mesmo banco descartável: rodam um arquivo por vez.
    fileParallelism: false,
  },
});
