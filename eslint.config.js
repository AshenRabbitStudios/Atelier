// Flat ESLint config (ESLint 9). Correctness/style gate; Prettier owns formatting.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules', 'out', 'dist', 'coverage', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      // `unknown` is the codebase default; allow narrowly-scoped, justified casts.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Match tsconfig: unused vars are errors, but allow leading-underscore opt-outs.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // No stray logging; the one intentional log (main's billing warning) opts out inline.
      'no-console': 'error'
    }
  },
  // Node scripts and config files (plain JS/ESM) — Node globals, console allowed.
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node, fetch: 'readonly' } }
  },
  // React renderer: hooks rules + flag any unsanctioned dangerouslySetInnerHTML.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, react },
    settings: { react: { version: 'detect' } },
    rules: { ...reactHooks.configs.recommended.rules, 'react/no-danger': 'error' }
  },
  // Tests may use loose typing for fixtures/mocks.
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },
  prettier
)
