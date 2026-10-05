// TRA-5131 — the report SURFACE carries the NOT PROMOTABLE marker on the raw uplift.
//
// Condition of the CEO ratification (TRA-5122, 2026-10-04): "`raw` stays visible with an
// explicit `not promotable` marker." The marker lives in ONE exported string
// (RAW_NOT_PROMOTABLE_MARKER / RAW_UPLIFT_COLUMN_HEADER / RAW_NOT_PROMOTABLE_LEGEND) — but a
// constant existing in the module is NOT evidence it reached the page (the TRA-1756
// discipline, TRA-1830 AC4). So this test runs the actual CLI, `scripts/pcr-expectancy.mjs`,
// and asserts on its STDOUT. Deleting the legend line, or un-marking the column header,
// fails these assertions even with the exports intact — that is the negative control.
//
// The fixture is deliberately empty: the cohort table, its header and its legend render on
// every run regardless of sample (every pre-registered cell is published whether or not it
// clears), so an empty ledger exercises exactly the surface under test without a bar join.
//
// NOTE: the CLI imports `packages/backtest/dist/index.js` — this test grades the BUILT
// surface. A missing dist fails loudly below rather than skipping (fail closed).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RAW_NOT_PROMOTABLE_LEGEND,
  RAW_NOT_PROMOTABLE_MARKER,
  RAW_UPLIFT_COLUMN_HEADER,
} from './pcr-expectancy.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repoRoot, 'scripts', 'pcr-expectancy.mjs');
const dist = join(repoRoot, 'packages', 'backtest', 'dist', 'index.js');

describe('TRA-5131 — NOT PROMOTABLE marker on the rendered report page', () => {
  it('the marker reaches the page: measured off the CLI stdout, not off a module constant', () => {
    expect(
      existsSync(dist),
      'packages/backtest/dist/index.js is missing — run `pnpm --filter @trading-app/backtest build` first; this test grades the built report surface',
    ).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'tra5131-'));
    const ledgerPath = join(dir, 'ledger.jsonl');
    const barsPath = join(dir, 'bars.jsonl');
    writeFileSync(ledgerPath, '\n');
    writeFileSync(
      barsPath,
      `${JSON.stringify({ underlying: 'SPY', session: '2026-07-13', high: 1, low: 1, close: 1 })}\n`,
    );

    const res = spawnSync(
      process.execPath,
      [script, '--bars', barsPath, '--ledger', ledgerPath],
      { encoding: 'utf-8', timeout: 120_000 },
    );
    expect(res.error).toBeUndefined();
    // 1 = non-PASS verdict (the expected outcome on an empty ledger); 0 would be PASS.
    // Anything else is the script failing, which must fail THIS test, not pass it.
    expect([0, 1]).toContain(res.status);
    const out = res.stdout ?? '';

    // AC1a — the legend line naming rawUp as NOT PROMOTABLE is on the page, verbatim from
    // the single exported copy (nobody retypes it).
    expect(out).toContain(RAW_NOT_PROMOTABLE_LEGEND);
    expect(RAW_NOT_PROMOTABLE_LEGEND).toContain(RAW_NOT_PROMOTABLE_MARKER);

    // AC1b — the marker is ASSOCIATED with the raw column: the cohort-table header itself
    // carries it, on the same line as the binding ADJ_UP column.
    const header = out
      .split('\n')
      .find((l) => l.includes('ADJ_UP') && l.includes('E[R]trio'));
    expect(header, 'cohort-table header line not found in CLI output').toBeDefined();
    expect(RAW_UPLIFT_COLUMN_HEADER).toContain('rawUp'); // the marked header IS the raw column
    expect(header).toContain(RAW_UPLIFT_COLUMN_HEADER);

    // Negative control for the association: no UNMARKED `rawUp` survives on the header line.
    // Stripping the `(NP)` suffix from the header fails here; deleting the legend fails above.
    expect(header!.replaceAll(RAW_UPLIFT_COLUMN_HEADER, '')).not.toMatch(/rawUp/);
  });
});
