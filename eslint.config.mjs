import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Regra de dependência do CLAUDE.md, escrita como lint para não depender de disciplina:
//   core  -> não importa nada do projeto
//   ai/db -> importam core, e só core
//   apps  -> importam pacotes; nenhum pacote importa app
const APPS = '@fliqo/{api,web,worker}';

const proibirApps = {
  group: [APPS],
  message: 'Pacote nunca importa app (CLAUDE.md, regra de dependência).',
};

// `../../algo` sempre sai da raiz do pacote — de src/ ou de tests/, dois níveis chegam em packages/.
const proibirFugaRelativa = {
  group: ['../../*'],
  message: 'Importe outro pacote pelo nome (@fliqo/core), não por caminho relativo.',
};

export default tseslint.config(
  {
    // docs/referencia/* é código do projeto anterior, guardado como referência de porte
    // (Fase 2 do roteiro). Não é compilado nem publicado, então não é lintado.
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/.next/**',
      '**/out/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/next-env.d.ts',
      'coverage/**',
      'docs/**',
    ],
  },

  // ------------------------------------------------------------------
  // TypeScript: strict com informação de tipo (typescript-eslint strict)
  // ------------------------------------------------------------------
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        // vitest.config.ts está fora do tsconfig (que cobre só src/ e tests/),
        // mas ainda queremos lintá-lo.
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // O log é do pino, com clinicId e requestId (CLAUDE.md, estilo de código).
      'no-console': 'error',
      // Interpolar número é seguro e é o que as mensagens de erro do domínio fazem
      // ("recebido: 3500"). O que a regra existe para pegar — objeto virando
      // "[object Object]", null, any — continua barrado.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [proibirApps, proibirFugaRelativa] },
      ],
    },
  },

  {
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@fliqo/*'],
              message: 'core não importa nada do projeto (CLAUDE.md, regra de dependência).',
            },
            proibirFugaRelativa,
          ],
        },
      ],
    },
  },

  {
    files: ['packages/ai/**/*.ts', 'packages/db/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@fliqo/*', '!@fliqo/core'],
              message:
                'Este pacote só pode importar @fliqo/core (CLAUDE.md, regra de dependência).',
            },
            proibirFugaRelativa,
          ],
        },
      ],
    },
  },

  // ------------------------------------------------------------------
  // Scripts e configuração em JavaScript puro (sem checagem de tipo)
  // ------------------------------------------------------------------
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
    rules: { 'no-console': 'error' },
  },

  {
    // O migrador é uma ferramenta de linha de comando: a saída dele é o produto.
    files: ['packages/db/scripts/**'],
    rules: { 'no-console': 'off' },
  },

  {
    // Scripts da demonstração: também são linha de comando, e um deles roda
    // código dentro do navegador (document, window).
    files: ['apps/demo/scripts/**'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly' } },
    rules: { 'no-console': 'off' },
  },

  {
    // A tela da demonstração é um app Next: os componentes rodam no navegador.
    files: ['apps/demo/**/*.{ts,tsx}'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
  },

  // ------------------------------------------------------------------
  // Testes
  // ------------------------------------------------------------------
  {
    files: ['packages/*/tests/**/*.ts', 'apps/*/tests/**/*.ts'],
    rules: {
      // `pg` devolve linha como `any` — tipar isso é a camada de acesso da Fase 1,
      // não o teste. Em src/ as regras continuam valendo.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Montar cenário indexando array (`pacientes[0]!`) é legítimo no teste:
      // se o índice não existir, o teste quebra, que é exatamente o que se quer.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  // Desliga o que conflita com o Prettier. Precisa ser o último.
  eslintConfigPrettier,
);
