// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
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
