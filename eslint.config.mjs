import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/main/core/scope.ts', 'src/main/core/validation.ts'], rules: { 'no-control-regex': 'off' } },
  { files: ['tests/e2e/**/*.ts'], rules: { 'no-empty-pattern': 'off' } },
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        Electron: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
