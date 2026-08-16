import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { buildPwaManifest, resolveBase } from './pwa.config';

const host = process.env.TAURI_DEV_HOST;

// Resolved once and used for both `base` and the manifest — the manifest's URLs and
// the app's base have to agree, and reading `VITE_BASE` twice is how they drift apart.
const base = resolveBase(process.env.VITE_BASE);

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: buildPwaManifest(base),
      workbox: {
        // Cache app shell and static assets; skip API and WebSocket routes
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Take over immediately when a new SW is installed, instead of
        // waiting for every PWA tab to close. Without this, mobile users who
        // keep the app open never see new releases — TRA-198 was reported
        // as "still present" because the previous SW kept serving the stale
        // bundle even after the offending section was removed in source.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
  ],
  base,
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows'
      ? 'chrome105'
      : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
