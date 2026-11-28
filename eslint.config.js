import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'upstream/**',
      'prompts/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
      '.cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  // With the types: a promise nobody waits for or hands on. Most defects found by the reviews of
  // 2026-11 were of this kind (a call left waiting, a failure nobody heard of); the other rules
  // that need the types are about style, and are left out.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
);
