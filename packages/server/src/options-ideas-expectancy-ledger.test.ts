import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateIdeasExpectancyShadow,
  DEFAULT_EXPECTANCY_GATE_CONFIG,
} from '@trading-app/agents';
import {
  recordExpectancyShadowSlate,
  hydrateOptionsIdeasExpectancyFromDisk,
  summarizeOptionsIdeasExpectancy,
  summarizeSlate,
  clearOptionsIdeasExpectancyLedger,
  optionsIdeasExpectancyLogPath,
  EXPECTANCY_LEDGER_WINDOW_DAYS,
} from './options-ideas-expectancy-ledger.js';

// TRA-2199 (parent TRA-2175 → TRA-2005) — the reader for the SHADOW expectancy
// ledger that `options-research.ts` computed and then discarded.
//
// What these prove, in the order the defect needs them:
//   1. the ledger is now READ at all (a slate reaches disk and comes back);
//   2. `enabled` separates "gate off, nothing recorded" from "gate on, nothing
//      qualified" — the conflation that made this leg look armed while inert;
//   3. the persisted row is REDACTED (aggregate only — no ticker, no idea text),
//      because the probe serving it is no-auth on bqb1;
//   4. counts survive a restart, since bqb1 reboots before a post-close grade.

const NOW = Date.UTC(2026, 6, 23, 14, 0, 0); // 2026-07-23, RTH ET

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ideas-expectancy-'));
  clearOptionsIdeasExpectancyLedger();
});
afterEach(() => {
  clearOptionsIdeasExpectancyLedger();
  rmSync(dir, { recursive: true, force: true });
});

/** The TRA-2000 leak case: a penny-wide credit spread that is −EV at its own POP. */
const NEGATIVE_EV_IDEA = {
  ticker: 'QQQ',
  strategy: 'bull_put_spread',
  rank: 1,
  pop: 0.766,
  maxLossUsd: 324,
  creditUsd: 76,
  ivRank: 60,
};

/** A credit spread wide enough to clear both the E[R] and credit/width tests. */
const POSITIVE_EV_IDEA = {
  ticker: 'SPY',
  strategy: 'bear_call_spread',
  rank: 2,
  pop: 0.8,
  maxLossUsd: 200,
  creditUsd: 300,
  ivRank: 70,
};

function shadowOf(ideas: Array<Record<string, unknown>>) {
  return evaluateIdeasExpectancyShadow(ideas as never, DEFAULT_EXPECTANCY_GATE_CONFIG);
}

describe('options-ideas expectancy shadow ledger (TRA-2199)', () => {
  it('records a slate to disk and reads it back — the ledger is no longer discarded', () => {
    hydrateOptionsIdeasExpectancyFromDisk(dir);
    const shadow = shadowOf([NEGATIVE_EV_IDEA, POSITIVE_EV_IDEA]);
    recordExpectancyShadowSlate(shadow, NOW);

    const raw = readFileSync(optionsIdeasExpectancyLogPath(dir), 'utf8').trim();
    expect(raw.split('\n')).toHaveLength(1);

    const summary = summarizeOptionsIdeasExpectancy(NOW, {
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1',
    });
    expect(summary.slates).toBe(1);
    expect(summary.counts.total).toBe(2);
    expect(summary.counts.drop).toBe(1);
    expect(summary.counts.admit).toBe(1);
    expect(summary.dropCodes.credit_width_below_breakeven).toBe(1);
    expect(summary.dropRate).toBeCloseTo(0.5, 10);
    expect(summary.stats.n).toBe(2);
    expect(summary.lastSlateAt).toBe(new Date(NOW).toISOString());
  });

  it('separates "gate off, nothing recorded" from "gate on, nothing qualified"', () => {
    hydrateOptionsIdeasExpectancyFromDisk(dir);

    // Gate OFF: the producer never builds a shadow, so the ledger stays empty. The
    // `enabled:false` flag is the ONLY thing that says why — without it this is
    // indistinguishable from an armed gate that found nothing.
    const off = summarizeOptionsIdeasExpectancy(NOW, {});
    expect(off.enabled).toBe(false);
    expect(off.slates).toBe(0);
    expect(off.dropRate).toBeNull();
    expect(off.flag).toBe('ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE');

    // Gate ON with a slate that scored nothing droppable: same zero drop count, but
    // now provably because nothing qualified — slates > 0.
    recordExpectancyShadowSlate(shadowOf([POSITIVE_EV_IDEA]), NOW);
    const on = summarizeOptionsIdeasExpectancy(NOW, {
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: 'true',
    });
    expect(on.enabled).toBe(true);
    expect(on.slates).toBe(1);
    expect(on.counts.drop).toBe(0);
    expect(on.dropRate).toBe(0);
  });

  it('persists an aggregate-only row — no ticker, no rank, no idea text', () => {
    const rec = summarizeSlate(shadowOf([NEGATIVE_EV_IDEA, POSITIVE_EV_IDEA]), NOW);
    const serialized = JSON.stringify(rec);

    // The probe is no-auth on bqb1, so the redaction is a security boundary, not
    // just tidiness. Assert on the serialized row: tickers must not survive, and
    // neither may the gate's human-readable `reasons` — those interpolate live
    // per-idea numbers, so a fragment unique to them is the right probe. (Field
    // names like `meanBreakevenCreditWidth` are aggregates and are meant to be here.)
    expect(serialized).not.toContain('QQQ');
    expect(serialized).not.toContain('SPY');
    expect(serialized).not.toContain('E[R]=');
    expect(serialized).not.toContain('credit not provided');
    expect(serialized).not.toContain('reasons');

    // What DOES survive is the aggregate slice — by structure family, not symbol.
    expect(Object.keys(rec.byStrategy).sort()).toEqual([
      'bear_call_spread',
      'bull_put_spread',
    ]);
    expect(rec.byStrategy.bull_put_spread?.drop).toBe(1);
    expect(rec.etDay).toBe('2026-07-23');
  });

  it('classifies drop causes into stable codes, not interpolated reason strings', () => {
    hydrateOptionsIdeasExpectancyFromDisk(dir);
    // ivRank null → the gate's bare drop (check 3), which carries no finite E[R].
    recordExpectancyShadowSlate(
      shadowOf([{ ...NEGATIVE_EV_IDEA, ivRank: null }, NEGATIVE_EV_IDEA]),
      NOW,
    );
    const s = summarizeOptionsIdeasExpectancy(NOW, {
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1',
    });
    expect(s.dropCodes.iv_rank_floor).toBe(1);
    expect(s.dropCodes.credit_width_below_breakeven).toBe(1);
    expect(s.counts.drop).toBe(2);
  });

  it('survives a restart — counts rebuild from the JSONL, not from since-boot memory', () => {
    hydrateOptionsIdeasExpectancyFromDisk(dir);
    recordExpectancyShadowSlate(shadowOf([NEGATIVE_EV_IDEA]), NOW);
    recordExpectancyShadowSlate(shadowOf([NEGATIVE_EV_IDEA]), NOW + 60_000);

    // bqb1 reboots ~daily; an in-memory counter would read a structural 0 here.
    const h = hydrateOptionsIdeasExpectancyFromDisk(dir);
    expect(h.slates).toBe(2);
    expect(h.days).toBe(1);

    const s = summarizeOptionsIdeasExpectancy(NOW + 120_000, {
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1',
    });
    expect(s.slates).toBe(2);
    expect(s.counts.drop).toBe(2);
    expect(s.durability.dataDir).toBe(dir);
  });

  it('windows the cohort so a stale slate cannot carry a verdict forever', () => {
    hydrateOptionsIdeasExpectancyFromDisk(dir);
    const stale = NOW - (EXPECTANCY_LEDGER_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;
    recordExpectancyShadowSlate(shadowOf([NEGATIVE_EV_IDEA]), stale);
    recordExpectancyShadowSlate(shadowOf([NEGATIVE_EV_IDEA]), NOW);

    const s = summarizeOptionsIdeasExpectancy(NOW, {
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1',
    });
    expect(s.slates).toBe(1);
    expect(s.counts.total).toBe(1);
  });

  it('is inert when no dataDir is configured — accounting never breaks the feed', () => {
    // No hydrate ⇒ no dataDir. The in-memory rollup still folds; only IO is skipped.
    const rec = recordExpectancyShadowSlate(shadowOf([NEGATIVE_EV_IDEA]), NOW);
    expect(rec.counts.drop).toBe(1);
    const s = summarizeOptionsIdeasExpectancy(NOW, {
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1',
    });
    expect(s.slates).toBe(1);
    // TRA-1681 — a memory-only store must publish itself as ephemeral so a reader
    // never mistakes a wiped DATA_DIR for a quiet gate.
    expect(s.durability.ephemeral).toBe(true);
  });
});
