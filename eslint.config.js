import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', 'dist-e2e-*', 'playwright-report', 'test-results']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.{js,ts}', 'e2e/**/*.ts', 'scripts/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/engine/**', 'src/cli/**', 'src/importers/**', 'src/workers/**', 'src/model/**'],
    // The model's one React binding.
    ignores: ['src/model/react.ts', 'src/model/react.test.ts'],
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
  {
    // The simulation worker must not bundle zod: value imports from the model may only come from
    // its schema-free modules. Type imports are erased and always fine.
    files: ['src/engine/**', 'src/workers/sim.worker.ts'],
    ignores: ['src/engine/**/*.test.ts', 'src/engine/testing.ts', 'src/engine/client.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message: 'The simulation worker must not bundle zod.',
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
<<<<<<< HEAD
              regex: '^@/model(?!/(vlans|defaults|result|ipv6|remote)$)(/.*)?$',
              message:
                'Value imports into the simulation worker must come from @/model/vlans, @/model/defaults, @/model/result, @/model/ipv6 or @/model/remote, so zod stays out of the worker.',
=======
              regex: '^@/model(?!/(vlans|defaults|result|ipv6|l2)$)(/.*)?$',
              message:
                'Value imports into the simulation worker must come from @/model/vlans, @/model/defaults, @/model/result, @/model/ipv6 or @/model/l2, so zod stays out of the worker.',
>>>>>>> 077026b (feat(model): add the data for CDP, LLDP, EtherChannel and port security)
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  prettier,
]);
