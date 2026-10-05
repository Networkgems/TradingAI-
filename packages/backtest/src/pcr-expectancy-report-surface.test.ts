import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runPcrExpectancy } from './pcr-expectancy.js';
import { synth } from './pcr-synth.fixture.js';

// TRA-5131 — condition of the TRA-5122 ratification (2026-10-04): `raw` is published
// but NOT PROMOTABLE, and the marker must sit ON the report surface, not in a source
// comment or only in the harness's head.
//
// These tests MEASURE the rendered surfaces (TRA-1756 discipline, TRA-1830 AC4):
//  - the verdict's `reasons[]` — the text that gets pasted into tickets; and
//  - the stdout of `scripts/pcr-expectancy.mjs` — the table a human reads.
// They assert the marker is ASSOCIATED WITH the raw figure, not merely that the
// string exists somewhere. Deleting the marker from either surface fails the
// corresponding test; asserting a module constant would not notice.

describe('TRA-5131 — the raw uplift carries a NOT PROMOTABLE marker in reasons[]', () => {
  it('quotes raw with the marker attached to the raw figure itself (DECISIVE NO-GO reason)', () => {
    // The anti-predictive FAIL control from the TRA-1726 suite — the only reasons[]
    // site that quotes rawUpliftR is the DECISIVE NO-GO reason, so render it.
    const { ledger, bars } = synth({ sessions: 30, seed: 5, edge: 'real', gamma: 2.0 });
    const report = runPcrExpectancy(ledger, bars, {
      iters: 400,
      seed: 11,
      primaryInterpretation: 'confirming',
    });
    expect(report.verdict).toBe('FAIL');

    const noGo = report.reasons.find((r) => r.includes('DECISIVE NO-GO'));
    expect(noGo).toBeDefined();

    // ASSOCIATION, not existence: the marker must follow the raw figure directly,
    // inside the same parenthetical, before the placebo decomposition.
    expect(noGo!).toMatch(/raw -?\d+\.\d{4}R \[NOT PROMOTABLE — TRA-5122\], of which/);

    // And the BINDING figure must NOT carry it — mislabelling the adjusted uplift as
    // not-promotable would invert the ratification.
    expect(noGo!).toMatch(/bias-adjusted uplift -?\d+\.\d{4}R;/);
    expect(noGo!).not.toMatch(/bias-adjusted uplift -?\d+\.\d{4}R \[NOT PROMOTABLE/);
  });
});

describe('TRA-5131 — the CLI report surface marks the raw column NOT PROMOTABLE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tra5131-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // TRA-5177 — the spawned CLI loads compiled dist, not src, so on a checkout where
  // packages/backtest/dist is unbuilt the spawn can only crash — and that red would
  // read exactly like a deleted marker. Skip loudly with the cause in the title
  // instead; the reasons[] leg above runs in-process and still guards the marker.
  const distModules = ['pcr-expectancy.js', 'pcr-cross-sectional.js'].map((f) =>
    fileURLToPath(new URL(`../dist/${f}`, import.meta.url)),
  );
  const distBuilt = distModules.every((p) => existsSync(p));
  const cliIt = distBuilt ? it : it.skip;

  cliIt(
    'rendered table header tags the raw column, and the legend expands the tag' +
      (distBuilt
        ? ''
        : ' — SKIPPED: packages/backtest/dist is unbuilt so the spawned CLI cannot load;' +
          ' run `pnpm --filter @trading-app/backtest build` (TRA-5177)'),
    () => {
    // A real spawned run of the actual script — the page itself, not the module.
    // Small zero-edge world: the marker claim is about the rendering, not the verdict.
    const { ledger, bars } = synth({ sessions: 6, seed: 77, edge: 'none' });
    const ledgerPath = join(dir, 'ledger.jsonl');
    const barsPath = join(dir, 'bars.jsonl');
    writeFileSync(ledgerPath, ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(barsPath, bars.map((b) => JSON.stringify(b)).join('\n') + '\n');

    const script = fileURLToPath(new URL('../../../scripts/pcr-expectancy.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, '--ledger', ledgerPath, '--bars', barsPath], {
      encoding: 'utf-8',
      timeout: 110_000,
    });
    // TRA-5177 — a crashed child must say "the CLI crashed", never "the header is
    // missing". spawnSync sets `.error` only on spawn failure, and the CLI exits 1 BY
    // DESIGN on any non-PASS verdict (this zero-edge world grades non-PASS), so neither
    // `.error` nor a bare `status === 0` can tell "ran and graded" from "died on
    // import". The discriminator is the render itself: a run that printed the report
    // banner executed; one that printed nothing crashed, and stderr says why.
    expect(run.error, `spawn failed: ${String(run.error)}`).toBeUndefined();
    expect(
      run.stdout,
      `the CLI crashed before rendering (exit ${run.status}, signal ${run.signal}).\n` +
        `stderr:\n${run.stderr}`,
    ).toContain('TRA-1664 — PCR shadow expectancy');
    const out = run.stdout;

    // (1) The column header itself carries the tag, one space left of ADJ_UP — a
    // reader who reads ONLY the table cannot mistake rawUp for the promotable number.
    const header = out.split('\n').find((l) => l.includes('nTrio') && l.includes('ADJ_UP'));
    expect(header).toBeDefined();
    expect(header!).toMatch(/rawUp\(NP\)\s+placebo\s+ADJ_UP/);

    // (2) The legend expands the tag, names the column, says NOT PROMOTABLE, and
    // cites the ratification — on the same rendered line, so the association is
    // on the page and not reconstructed by the reader.
    const legend = out.split('\n').find((l) => l.includes('NOT PROMOTABLE'));
    expect(legend).toBeDefined();
    expect(legend!).toMatch(/rawUp\(NP\).*NOT PROMOTABLE.*TRA-5122/);
  }, 120_000);
});
