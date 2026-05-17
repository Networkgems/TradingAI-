import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// TRA-409 — desktop test suite. `apps/desktop` previously had zero tests; this
// config is picked up by the repo-level `pnpm -r test`, so the suite runs in CI
// alongside the other workspaces.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    // Allow the suite to pass before more tests land, matching the server package.
    passWithNoTests: true,
  },
});
