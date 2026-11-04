import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import testQualityPlugin from '../eslint-plugins/test-quality.mjs';

export default [
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'cinematicai-test-quality': testQualityPlugin,
    },
    rules: {
      // MEDIUM #51: Promote no-explicit-any to error for non-test source files.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_+', varsIgnorePattern: '^_+' }],
      'no-undef': 'off',
      'no-unused-vars': 'off',
      // Source files must not read process.env at module level (M2 guardrail).
      // The rule skips files that are allowlisted in the plugin itself.
      'cinematicai-test-quality/no-module-level-process-env': 'error',
      // MEDIUM #50: Catch local function declarations that shadow imported
      // bindings — a class of name-collision bugs that can slip past review.
      'cinematicai-test-quality/no-local-imported-function-collision': 'warn',
      // Exported guardrails that were not enabled in earlier configs.
      'cinematicai-test-quality/prefer-genre-map': 'warn',
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    plugins: {
      'cinematicai-test-quality': testQualityPlugin,
    },
    rules: {
      'no-constant-binary-expression': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Test-quality guardrails (see ../../eslint-plugins/test-quality.mjs).
      // Each rule pins a contract that bit the codebase at some point;
      // see the rule's docs for the historical bug it prevents.
      'cinematicai-test-quality/no-trivial-assertions': 'error',
      'cinematicai-test-quality/click-needs-assertion': 'error',
      'cinematicai-test-quality/test-against-project-middleware': 'error',
    },
  },
];
