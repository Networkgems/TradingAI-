/**
 * TRA-4457 — the fleet fold that PUBLISHES the sma200 sweep census.
 *
 * `sma200-validity.test.ts` grades the per-engine verdict and
 * `sma200-scan-census.test.ts` grades that the engine populates it. Neither
 * covers the step that was actually missing: getting the census onto a surface
 * a grader can curl. `21b15106` shipped both fields on `EngineState` and no
 * health route passed them through — measured live on bqb1 `f3ce18b6` (pid 77,
 * 2026-09-16): 65 engines on `/api/health/options-pipeline`, zero exposing
 * either key, because that route projects state down to a fixed whitelist.
 *
 * The arms below are the ones a reader gets wrong. In particular a fleet that
 * scored symbols and fired NOTHING must read `SWEPT`, and "no sweep has
 * finished yet" must never read as `BLIND`.
 */
import { describe, it, expect } from 'vitest';
import { summarizeSma200Sweeps } from './health-routes.js';
import type { EngineState } from '../signal-engine.js';

const NOW = Date.UTC(2026, 8, 16, 1, 0, 0);

/** A census whose counters are internally consistent with its verdict. */
function census(over: Record<string, number> = {}) {
  return {
    startedAt: NOW - 60_000,
    finishedAt: NOW - 30_000,
    considered: 0,
    evaluated: 0,
    starvedBreakerOpen: 0,
    starvedShortHistory: 0,
    fetchFailed: 0,
    fired: 0,
    voided: 0,
    maxDistAtr: null,
    ...over,
  };
}

/**
 * An engine served by a build that CARRIES the census. Both keys are present;
 * `null` means "no sweep has finished yet", which is a different fact from the
 * keys being absent entirely.
 */
function engine(
  stats: ReturnType<typeof census> | null,
  verdict: 'SWEPT' | 'BLIND' | 'NO_UNIVERSE' | null,
  mode = 'demo',
) {
  return { mode, state: { sma200ScanStats: stats, sma200SweepVerdict: verdict } as unknown as EngineState };
}

/** An engine served by a build PREDATING the census — neither key exists. */
function legacyEngine(mode = 'demo') {
  return { mode, state: {} as EngineState };
}

describe('summarizeSma200Sweeps (TRA-4457 — publishing the sweep census)', () => {
  it('an empty fleet is NO_SWEEP_YET, never BLIND', () => {
    const r = summarizeSma200Sweeps([], NOW);
    expect(r.verdict).toBe('NO_SWEEP_YET');
    expect(r.graded).toBe(0);
    expect(r.newestSweepAt).toBeNull();
    expect(r.newestSweepAgeMs).toBeNull();
  });

  it('THE LOAD-BEARING ARM: scored symbols + fired ZERO reads SWEPT, not BLIND', () => {
    const r = summarizeSma200Sweeps(
      [engine(census({ considered: 751, evaluated: 745, starvedShortHistory: 6 }), 'SWEPT')],
      NOW,
    );
    expect(r.verdict).toBe('SWEPT');
    expect(r.totals.fired).toBe(0);
    expect(r.totals.evaluated).toBe(745);
  });

  it('breaker-starved fleet reads BLIND — an empty feed there is not a quiet market', () => {
    const r = summarizeSma200Sweeps(
      [engine(census({ considered: 751, starvedBreakerOpen: 751 }), 'BLIND')],
      NOW,
    );
    expect(r.verdict).toBe('BLIND');
    expect(r.byVerdict).toEqual({ SWEPT: 0, BLIND: 1, NO_UNIVERSE: 0 });
    expect(r.totals.starvedBreakerOpen).toBe(751);
  });

  it('a mixed fleet is PARTIAL_BLIND — one healthy engine does not clear the starved ones', () => {
    const r = summarizeSma200Sweeps(
      [
        engine(census({ considered: 751, evaluated: 745 }), 'SWEPT'),
        engine(census({ considered: 751, starvedBreakerOpen: 751 }), 'BLIND'),
      ],
      NOW,
    );
    expect(r.verdict).toBe('PARTIAL_BLIND');
    expect(r.graded).toBe(2);
  });

  it('an empty watchlist everywhere is NO_UNIVERSE, kept out of BLIND', () => {
    const r = summarizeSma200Sweeps([engine(census(), 'NO_UNIVERSE'), engine(census(), 'NO_UNIVERSE')], NOW);
    expect(r.verdict).toBe('NO_UNIVERSE');
  });

  it('NO_UNIVERSE alongside a real sweep does NOT suppress the SWEPT verdict', () => {
    const r = summarizeSma200Sweeps(
      [engine(census(), 'NO_UNIVERSE'), engine(census({ considered: 10, evaluated: 10 }), 'SWEPT')],
      NOW,
    );
    expect(r.verdict).toBe('SWEPT');
  });

  it('a fleet that has not swept yet is NO_SWEEP_YET and contributes no counters', () => {
    const r = summarizeSma200Sweeps([engine(null, null), engine(null, null)], NOW);
    expect(r.verdict).toBe('NO_SWEEP_YET');
    expect(r.neverSwept).toBe(2);
    expect(r.graded).toBe(0);
    expect(r.totals.considered).toBe(0);
  });

  it('ABSENT ≠ AGREE: a build without the census counts as unpublished, not as never-swept', () => {
    const r = summarizeSma200Sweeps([legacyEngine(), legacyEngine()], NOW);
    expect(r.unpublished).toBe(2);
    expect(r.neverSwept).toBe(0);
    expect(r.graded).toBe(0);
    expect(r.verdict).toBe('NO_SWEEP_YET');
  });

  it('WHOLE FLEET: live engines are folded, not filtered out, and are counted separately', () => {
    const r = summarizeSma200Sweeps(
      [
        engine(census({ considered: 5, evaluated: 5, fired: 1 }), 'SWEPT', 'live'),
        engine(census({ considered: 5, evaluated: 5 }), 'SWEPT', 'demo'),
      ],
      NOW,
    );
    expect(r.engines).toBe(2);
    expect(r.liveEngines).toBe(1);
    expect(r.graded).toBe(2);
    expect(r.totals.fired).toBe(1);
  });

  it('newestSweepAt takes the MAX finishedAt and ages it against the injected clock', () => {
    const r = summarizeSma200Sweeps(
      [
        engine(census({ considered: 1, evaluated: 1, finishedAt: NOW - 600_000 }), 'SWEPT'),
        engine(census({ considered: 1, evaluated: 1, finishedAt: NOW - 5_000 }), 'SWEPT'),
      ],
      NOW,
    );
    expect(r.newestSweepAt).toBe(new Date(NOW - 5_000).toISOString());
    expect(r.newestSweepAgeMs).toBe(5_000);
  });

  it('a legacy engine cannot dilute a BLIND verdict into a pass', () => {
    const r = summarizeSma200Sweeps(
      [legacyEngine(), engine(census({ considered: 751, starvedBreakerOpen: 751 }), 'BLIND')],
      NOW,
    );
    expect(r.verdict).toBe('BLIND');
    expect(r.unpublished).toBe(1);
    expect(r.graded).toBe(1);
  });
});
