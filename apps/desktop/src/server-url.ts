// Single source of truth for the backend (WebSocket bus + HTTP API) URL.
// Both the dashboard WebSocket and every HTTP fetch (including the VersionChip
// health poll) derive from this one value, so a wrong origin here breaks the
// live banner AND shows `build ?` on the chip.
//
// TRA-547 — the frontend kept pointing at the wrong backend because the only
// committed answer to "where is the backend?" used to be `window.location`
// (same-origin). That silently breaks on GitHub Pages: the public site is
// served from `networkgems.github.io`, which is static hosting with NO backend
// of its own, so the same-origin guess resolves to `wss://networkgems.github.io`
// and every socket/API call fails. The real production backend lives on Render.
//
// Resolution order (first match wins):
//   1. VITE_SERVER_URL — build-time override baked in for hosted/web
//      deployments (CI sets it from a secret; a local `.env` can point at a
//      staging backend). Always wins when present.
//   2. Packaged Tauri (TRA-545): the desktop app serves its UI from the
//      `tauri.localhost` custom-protocol origin. That origin is NOT a server —
//      the trading server runs locally on :4242 — so deriving a backend URL
//      from `window.location` there points every fetch/WebSocket at a dead
//      origin. Detect Tauri via its custom-protocol host or the injected
//      `__TAURI_INTERNALS__` (same probe telemetry.ts uses) and use the local
//      server.
//   3. localhost / 127.0.0.1 — local dev, or the server hosting its own web
//      build: talk to the local server on :4242 regardless of the page's port.
//   4. *.github.io — the public site has no backend of its own; use the
//      canonical production backend below. This is the fail-safe: even if the
//      CI secret is dropped or wrong, the live site still finds the backend.
//   5. anything else — the frontend is being served BY the backend itself
//      (Render serving the built UI directly, or a custom domain that proxies
//      the API), so derive same-origin.
//
// PROD_BACKEND_URL is the ONE place the production backend host is hardcoded.
// If the backend moves, change it here (and the CI `VITE_SERVER_URL` secret).
export const PROD_BACKEND_URL = 'wss://tradingai-bqb1.onrender.com';
const LOCAL_BACKEND_URL = 'ws://localhost:4242';

function resolveServerUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL;
  if (fromEnv) return fromEnv;

  // No DOM (SSR / tests): assume local dev.
  if (typeof window === 'undefined') return LOCAL_BACKEND_URL;

  const { hostname, protocol, host } = window.location;

  // Packaged Tauri — the UI origin is the custom protocol, never the backend.
  const isTauri =
    hostname === 'tauri.localhost' ||
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null;
  if (isTauri) return LOCAL_BACKEND_URL;

  // Loopback host (dev server on :1420/:5173, or server-hosted web on :4242).
  if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_BACKEND_URL;

  // GitHub Pages (or any *.github.io) is backend-less static hosting.
  if (hostname.endsWith('github.io')) return PROD_BACKEND_URL;

  // Served by the backend itself / behind a same-origin proxy.
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProto}://${host}`;
}

export const SERVER_URL: string = resolveServerUrl();

export const HTTP_URL: string = SERVER_URL.replace(/^ws/, 'http');
