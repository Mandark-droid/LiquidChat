// ESLint flat config — the "pylint" of this repo.
// Run: npm run lint (check) / npm run lint:fix (autofix incl. import order, like isort).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      'release/**',
      'coverage/**',
      'lib/**',
      '.claude/**',
      'scripts/**',
      '*.config.js',
      'babel.config.js',
      'metro.config.js',
      'react-native.config.js',
      'index.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
      'simple-import-sort': simpleImportSort,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.es2021, __DEV__: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly', AbortController: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: '19.1' } },
    rules: {
      // correctness
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/jsx-key': 'error',
      'react/no-unstable-nested-components': ['warn', { allowAsProps: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
      // typing
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // import ordering (isort)
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: ['__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'jest.setup.ts'],
    languageOptions: { globals: { ...globals.jest, ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
