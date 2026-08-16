import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildPwaManifest, resolveBase } from '../pwa.config';

/**
 * TRA-3803 — the app 404'd its own manifest on GitHub Pages.
 *
 * `index.html` carried `<link rel="manifest" href="/manifest.webmanifest">`. Vite
 * base-prefixes `rel="icon"` and `rel="apple-touch-icon"` hrefs but not `rel="manifest"`,
 * so that literal shipped verbatim, resolved to the domain root under the `/TradingAI-/`
 * project subpath, and produced seven console errors on admin login.
 *
 * The regression here is a property of the **built artifact**, not of the source, so the
 * substantive test below builds the app at the Pages base and grades `dist/` — no proxy.
 * Every root-absolute URL in the emitted `index.html` and manifest must sit under the base.
 */

// vitest runs each workspace with cwd at its package root, and under the jsdom
// environment `import.meta.url` is not a file: URL, so it cannot be used here. If that
// assumption ever breaks, this must fail loudly — a test that silently graded nothing
// would read exactly like a passing one.
const DESKTOP_ROOT = process.cwd();
if (!existsSync(join(DESKTOP_ROOT, 'vite.config.ts'))) {
  throw new Error(`expected cwd to be apps/desktop, got ${DESKTOP_ROOT}`);
}

const PAGES_BASE = '/TradingAI-/';

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Root-absolute (`/foo`) but not protocol-relative (`//cdn`) — the class that broke. */
function isRootAbsolute(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//');
}

describe('resolveBase', () => {
  it('defaults to the domain root when VITE_BASE is unset or blank', () => {
    expect(resolveBase(undefined)).toBe('/');
    expect(resolveBase('')).toBe('/');
    expect(resolveBase('   ')).toBe('/');
  });

  it('passes through a well-formed subpath', () => {
    expect(resolveBase(PAGES_BASE)).toBe(PAGES_BASE);
  });

  it('adds the slashes a caller forgot, in both positions', () => {
    // A base missing its trailing slash is the subtle one: `${base}icon-192.png`
    // would otherwise concatenate into `/TradingAI-icon-192.png`.
    expect(resolveBase('/TradingAI-')).toBe(PAGES_BASE);
    expect(resolveBase('TradingAI-')).toBe(PAGES_BASE);
    expect(resolveBase('TradingAI-/')).toBe(PAGES_BASE);
  });

  it('leaves an absolute CDN origin alone apart from the trailing slash', () => {
    expect(resolveBase('https://cdn.example.com/app')).toBe('https://cdn.example.com/app/');
  });
});

describe('buildPwaManifest', () => {
  it('base-prefixes start_url, scope and every icon', () => {
    const manifest = buildPwaManifest(PAGES_BASE);

    expect(manifest.start_url).toBe(PAGES_BASE);
    expect(manifest.scope).toBe(PAGES_BASE);
    expect(manifest.icons).not.toHaveLength(0);
    for (const icon of manifest.icons ?? []) {
      expect(icon.src.startsWith(PAGES_BASE)).toBe(true);
    }
  });

  it('still produces plain root URLs for a `/`-based build', () => {
    const manifest = buildPwaManifest('/');

    expect(manifest.start_url).toBe('/');
    expect(manifest.icons?.[0]?.src).toBe('/icon-192.png');
  });
});

describe('index.html', () => {
  const html = readFileSync(join(DESKTOP_ROOT, 'index.html'), 'utf8');
  const doc = parseHtml(html);

  it('declares no manifest link of its own', () => {
    // vite-plugin-pwa injects the base-correct one at build time. A second, hand-written
    // link wins on document order in Chrome — which is exactly how TRA-3803 happened.
    expect(doc.querySelectorAll('link[rel="manifest"]')).toHaveLength(0);
  });

  it('pairs the deprecated apple meta with the standard one', () => {
    const apple = doc.querySelector('meta[name="apple-mobile-web-app-capable"]');
    if (!apple) return; // fine — the deprecated tag is optional, the pairing is not
    const standard = doc.querySelector('meta[name="mobile-web-app-capable"]');
    expect(standard?.getAttribute('content')).toBe(apple.getAttribute('content'));
  });
});

describe('built artifact at the GitHub Pages base', () => {
  // `deploy-pages.yml` builds with VITE_BASE=/TradingAI-/. Reproduce that exactly, in a
  // subprocess: it is the command CI actually runs, and esbuild refuses to start inside
  // the jsdom environment this suite uses ("your JavaScript environment is broken").
  it(
    'emits exactly one manifest link and no URL outside the base',
    () => {
      const outDir = mkdtempSync(join(tmpdir(), 'tra3803-'));

      try {
        const requireFrom = createRequire(join(DESKTOP_ROOT, 'package.json'));
        // `vite/bin/vite.js` is not in vite's exports map; `vite/package.json` is.
        const viteBin = join(dirname(requireFrom.resolve('vite/package.json')), 'bin', 'vite.js');

        const build = spawnSync(
          process.execPath,
          [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'silent'],
          {
            cwd: DESKTOP_ROOT,
            env: { ...process.env, VITE_BASE: PAGES_BASE },
            encoding: 'utf8',
          },
        );
        expect(build.status, `vite build failed:\n${build.stderr}${build.stdout}`).toBe(0);

        const doc = parseHtml(readFileSync(join(outDir, 'index.html'), 'utf8'));

        const manifestLinks = [...doc.querySelectorAll('link[rel="manifest"]')];
        expect(manifestLinks).toHaveLength(1);
        expect(manifestLinks[0]!.getAttribute('href')).toBe(`${PAGES_BASE}manifest.webmanifest`);

        // The general invariant, so a future <link>/<script> added to the head is covered
        // too — not just the manifest that happened to break.
        const emitted = [
          ...[...doc.querySelectorAll('link[href]')].map((el) => el.getAttribute('href')!),
          ...[...doc.querySelectorAll('script[src]')].map((el) => el.getAttribute('src')!),
        ];
        expect(emitted.length).toBeGreaterThan(0);
        for (const url of emitted.filter(isRootAbsolute)) {
          expect(url.startsWith(PAGES_BASE)).toBe(true);
        }

        expect(doc.querySelector('meta[name="mobile-web-app-capable"]')).not.toBeNull();

        const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.webmanifest'), 'utf8'));
        expect(manifest.start_url).toBe(PAGES_BASE);
        expect(manifest.scope).toBe(PAGES_BASE);
        for (const icon of manifest.icons as Array<{ src: string }>) {
          expect(icon.src.startsWith(PAGES_BASE)).toBe(true);
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
