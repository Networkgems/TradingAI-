import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;

// TRA-3051 — `/api/health/execution-quality` was registered TWICE in `index.ts`:
//
//   8284:  app.get('/api/health/execution-quality', ...)   // TRA-2046 — order-quality telemetry
//   8308:  app.get('/api/health/execution-quality', ...)   // TRA-1981 — realized-vs-modeled KPI
//
// Express matches in registration order and neither handler calls `next()` — both
// terminate with `res.json(...)` / `res.status(500).json(...)`. So :8284 answered every
// request and :8308 had never run in production. Confirmed live on `7a53176`:
//
//   GET https://tradingai-bqb1.onrender.com/api/health/execution-quality
//   {"issue":"TRA-2046","telemetry":{...}}
//
// The TRA-1981 payload — `decayRatio`, the per-asset-class realized-vs-modeled fold, the
// options fee/slippage ledger leg — was unreadable for the whole life of the route. That
// KPI is the OOS check TRA-1981 names as the justification for arming the liquidity-gate
// veto, so a live risk control was gated on a number nobody could read.
//
// ⚠️ Why this needs a TEST and not just the rename: the fix is one line, but the FAILURE
// MODE is invisible. A doubled path does not throw, does not warn, and does not 404 — the
// shadowed handler is simply never invoked, and the caller gets a well-formed 200 from the
// winner. From outside, "this probe reports nothing" and "this probe does not exist" are
// byte-identical. Nothing in typecheck, lint, or the existing suite could see it. This file
// is the only thing standing between the next doubled path and another silent months-long
// outage, so it scans the SOURCE rather than asserting on the two known handlers.

type Registration = { method: string; path: string; file: string; line: number };

/** `app.get('/x', ...)` / `someRouter.post("/y", ...)` — the shapes actually used in this package. */
const ROUTE_RE = /\b(?:app|router|[A-Za-z_]*[Rr]outer)\.(get|post|put|patch|delete|all)\(\s*['`"]([^'`"]+)['`"]/g;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') tsFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function collectRegistrations(): Registration[] {
  const found: Registration[] = [];
  for (const file of tsFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    ROUTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_RE.exec(source)) !== null) {
      found.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file: file.slice(file.lastIndexOf(sep) + 1),
        line: source.slice(0, match.index).split('\n').length,
      });
    }
  }
  return found;
}

describe('TRA-3051 — no route path is registered twice', () => {
  it('finds no method+path registered more than once across the server sources', () => {
    const registrations = collectRegistrations();

    // Guard the guard: if the scan matches nothing, an "all unique" pass is vacuous.
    // `index.ts` alone carries well over a hundred routes, so a low count means the
    // regex has drifted away from the registration style, not that routes vanished.
    expect(registrations.length).toBeGreaterThan(100);

    const byKey = new Map<string, Registration[]>();
    for (const reg of registrations) {
      const key = `${reg.method} ${reg.path}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(reg);
      else byKey.set(key, [reg]);
    }

    const duplicated = [...byKey.entries()]
      .filter(([, regs]) => regs.length > 1)
      .map(([key, regs]) => `${key}\n     ${regs.map((r) => `${r.file}:${r.line}`).join('\n     ')}`);

    // A duplicated path means the LATER handler is dead code that still reads like a
    // shipped feature. If this fires, the fix is a naming decision (give the shadowed
    // block its own path) or a merge — not deleting whichever block you found second.
    expect(
      duplicated,
      `Route path(s) registered more than once — the later handler(s) can never run:\n\n  ${duplicated.join('\n\n  ')}\n`,
    ).toEqual([]);
  });

  it('keeps the two execution-quality probes on distinct paths', () => {
    // The specific regression. Pinned by path AND by the issue tag each handler emits,
    // because the two bodies are only distinguishable by that field from outside.
    const source = readFileSync(join(SRC, 'index.ts'), 'utf8');

    const bare = source.match(/app\.get\('\/api\/health\/execution-quality'/g) ?? [];
    const kpi = source.match(/app\.get\('\/api\/health\/execution-quality-kpi'/g) ?? [];

    expect(bare).toHaveLength(1);
    expect(kpi).toHaveLength(1);

    // Both blocks survive the fix — they measure different things and both are wanted.
    expect(source).toContain("issue: 'TRA-2046'");
    expect(source).toContain("issue: 'TRA-1981'");
  });
});
