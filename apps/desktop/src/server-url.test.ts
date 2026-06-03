// TRA-545 — backend-URL resolution. Both the dashboard WebSocket and the
// VersionChip health poll derive from SERVER_URL/HTTP_URL, so the regressions
// guarded here are "build ?" chip + OFFLINE banner in packaged builds.
//
// SERVER_URL is computed at module-eval time from window.location and the baked
// VITE_SERVER_URL, so each case stubs the environment then re-imports the
// module fresh via vi.resetModules() + dynamic import.
import { describe, it, expect, afterEach, vi } from 'vitest';

async function loadWith(opts: {
  location?: Partial<Location> & { __tauri?: boolean };
  serverUrlEnv?: string;
}): Promise<{ SERVER_URL: string; HTTP_URL: string }> {
  vi.resetModules();
  if (opts.serverUrlEnv === undefined) vi.stubEnv('VITE_SERVER_URL', '');
  else vi.stubEnv('VITE_SERVER_URL', opts.serverUrlEnv);

  if (opts.location) {
    const { __tauri, ...loc } = opts.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { protocol: 'http:', ...loc },
    });
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = __tauri
      ? {}
      : undefined;
  }
  return import('./server-url');
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('server-url resolution (TRA-545)', () => {
  it('honours a baked VITE_SERVER_URL above everything else', async () => {
    const { SERVER_URL, HTTP_URL } = await loadWith({
      serverUrlEnv: 'wss://api.example.com',
      location: { hostname: 'tauri.localhost', host: 'tauri.localhost' },
    });
    expect(SERVER_URL).toBe('wss://api.example.com');
    expect(HTTP_URL).toBe('https://api.example.com');
  });

  it('uses the local server for a packaged Tauri custom-protocol origin', async () => {
    const { SERVER_URL, HTTP_URL } = await loadWith({
      location: { hostname: 'tauri.localhost', host: 'tauri.localhost', protocol: 'https:' },
    });
    expect(SERVER_URL).toBe('ws://localhost:4242');
    expect(HTTP_URL).toBe('http://localhost:4242');
  });

  it('uses the local server when __TAURI_INTERNALS__ is injected', async () => {
    const { HTTP_URL } = await loadWith({
      location: { hostname: 'localhost', host: 'localhost:1420', __tauri: true },
    });
    expect(HTTP_URL).toBe('http://localhost:4242');
  });

  it('uses the loopback server regardless of the dev page port', async () => {
    const { SERVER_URL } = await loadWith({
      location: { hostname: 'localhost', host: 'localhost:1420' },
    });
    expect(SERVER_URL).toBe('ws://localhost:4242');
  });

  it('derives a same-origin secure backend for a real remote host', async () => {
    const { SERVER_URL, HTTP_URL } = await loadWith({
      location: { hostname: 'app.onrender.com', host: 'app.onrender.com', protocol: 'https:' },
    });
    expect(SERVER_URL).toBe('wss://app.onrender.com');
    expect(HTTP_URL).toBe('https://app.onrender.com');
  });
});
