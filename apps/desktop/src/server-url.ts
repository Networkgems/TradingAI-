// Resolve the backend URL. Both the dashboard WebSocket and every HTTP fetch
// (including the VersionChip health poll) derive from this single value, so a
// wrong origin here breaks the live banner AND shows `build ?` on the chip.
//
// Resolution priority:
//   1. VITE_SERVER_URL — baked at build time for hosted/web deployments.
//   2. Packaged Tauri (TRA-545): the desktop app serves its UI from the
//      `tauri.localhost` custom-protocol origin. That origin is NOT a server —
//      the trading server runs locally on :4242 — so deriving a backend URL
//      from `window.location` there points every fetch/WebSocket at a dead
//      origin (the recurring "build ?" chip + OFFLINE banner). Detect Tauri via
//      its custom-protocol host or the injected `__TAURI_INTERNALS__` (same
//      probe telemetry.ts uses) and talk to the local server instead.
//   3. Loopback (local dev, or the server hosting its own web build) — use the
//      loopback server on :4242 regardless of the page's port.
//   4. A real remote host — derive from window.location so the frontend hits
//      its own origin.
const LOCAL_SERVER = 'ws://localhost:4242';

function resolveServerUrl(): string {
  const baked = import.meta.env.VITE_SERVER_URL;
  if (baked) return baked;
  if (typeof window === 'undefined') return LOCAL_SERVER;

  const { hostname, host, protocol } = window.location;

  // Packaged Tauri — the UI origin is the custom protocol, never the backend.
  const isTauri =
    hostname === 'tauri.localhost' ||
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null;
  if (isTauri) return LOCAL_SERVER;

  // Loopback host (dev server on :1420/:5173, or server-hosted web on :4242).
  if (hostname === 'localhost' || hostname === '127.0.0.1') return LOCAL_SERVER;

  // Real remote host — same-origin backend.
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
}

export const SERVER_URL: string = resolveServerUrl();

export const HTTP_URL: string = SERVER_URL.replace(/^ws/, 'http');
