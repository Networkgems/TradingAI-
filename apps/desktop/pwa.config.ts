import type { ManifestOptions } from 'vite-plugin-pwa';

/**
 * Base-URL wiring for the PWA manifest — TRA-3803.
 *
 * This app is served from two different roots. Tauri and the server-hosted build
 * serve it from `/`; GitHub Pages serves it from a *project* subpath, which
 * `deploy-pages.yml` passes in as `VITE_BASE=/TradingAI-/`. Every URL the manifest
 * hands to the browser therefore has to be written against the base, never against
 * the domain root.
 *
 * A root-absolute literal like `/manifest.webmanifest` is the trap. It looks correct,
 * it is correct on every `/`-based build, and on Pages it resolves to
 * `https://networkgems.github.io/manifest.webmanifest` — a 404, once per fetch attempt,
 * plus a "Manifest fetch from … failed, code 404" for each. Seven console errors on
 * admin login, all from one leading slash.
 *
 * ⚠️ Vite does **not** rewrite that one for you. It base-prefixes `link[rel=icon]` and
 * `link[rel=apple-touch-icon]` hrefs in `index.html`, so most of the head looks handled —
 * but `rel="manifest"` is not in its asset-attribute table, and a hand-written manifest
 * link is emitted verbatim. `index.html` carries no manifest link at all now; the one in
 * the build is injected by `vite-plugin-pwa`, which does honour the base.
 */

/** Normalize a raw `VITE_BASE` into a value with both a leading and a trailing slash. */
export function resolveBase(rawBase: string | undefined): string {
  const trimmed = rawBase?.trim();
  if (!trimmed) return '/';
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('/')
    ? trimmed
    : `/${trimmed}`;
  return absolute.endsWith('/') ? absolute : `${absolute}/`;
}

/**
 * Build the web-app manifest for a given base. `start_url`, `scope` and every icon `src`
 * are base-prefixed: a `start_url` outside `scope` is a manifest error in Chrome, and
 * root-absolute icon srcs 404 the same way the manifest link did.
 */
export function buildPwaManifest(base: string): Partial<ManifestOptions> {
  return {
    name: 'Trading App',
    short_name: 'TradingApp',
    description: 'AI-powered trading signal dashboard',
    start_url: base,
    scope: base,
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#7c3aed',
    icons: [
      { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
