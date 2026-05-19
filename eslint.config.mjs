// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/target/**',
      '**/.tauri/**',
      'apps/desktop/src-tauri/**',
    ],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Node-runtime files. CommonJS/ESM scripts, the PM2 ecosystem config, and the
  // one-off `run-tra*.ts` backtest runners execute under Node, not the browser.
  // Declare Node globals so `process`, `console`, `Buffer`, `module`,
  // `__dirname`, `fetch`, etc. resolve instead of tripping `no-undef`.
  {
    files: [
      '**/*.cjs',
      '**/*.mjs',
      'scripts/**',
      'packages/*/scripts/**',
      'packages/backtest/src/run-tra*.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  // React Hooks correctness — scoped to the desktop/mobile React app.
  // Enforces `rules-of-hooks` and `exhaustive-deps` so missing-dep and
  // stale-closure bugs in the hooks-heavy UI are caught at lint time.
  {
    ...reactHooks.configs['recommended-latest'],
    files: ['apps/desktop/src/**/*.{ts,tsx,js,jsx}'],
  },
);
