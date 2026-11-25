import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', 'playwright-report', 'test-results']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.{js,ts}', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/engine/**', 'src/cli/**', 'src/importers/**', 'src/workers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^react(-dom)?(/|$)',
              message: 'Headless code must not depend on React.',
            },
            {
              regex: '^(@/|(\\.\\./)+)(features|app)(/|$)',
              message: 'Headless code must not import UI layers (features, app).',
            },
          ],
        },
      ],
    },
  },
  prettier,
]);
