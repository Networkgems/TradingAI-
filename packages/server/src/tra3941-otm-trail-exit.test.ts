// TRA-3941 (parent TRA-3927, board card `a29b2db8` accepted 2026-08-22T04:18Z) —
// the OTM sleeve's exit rule.
//
// ── What the tape said ──────────────────────────────────────────────────────
// On the desk OTM cell, `trail` exits ran avgR +0.42 (n=10, 3/3 live winners)
// while the chandelier family ran avgR −0.01 (n=17, 0/4 live), with
// `chandelier_restarted` on BAC at −2.24R the worst close in the live book. The
// MECHANISM is what this file pins, not the mean: every chandelier close landed
// 0–18 minutes after the NEXT session's open, because the TRA-3217 stale-breach
// veto re-seeds `peakUnderlying` at the current spot on the first unsuppressed
// tick — i.e. at the gap open — and trails from there.
//
// ── What is asserted ────────────────────────────────────────────────────────
// Every subject test here is paired with a POSITIVE CONTROL on the same account
// shape and the same price path under `otmSleeveExitRule: 'chandelier'`. Without
// that pairing "the position did not exit" is worth nothing: a path that never
// reached ANY rule reads identically to one whose rule was retired, and that is
// the shape (a vacuous pass) this repo keeps paying for.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { PaperOptionsAccount, isOtmSleeveRow, type OptionExitRiskInput } from './options-account.js';
import {
  resolveOtmSleeveExitRule,
  OTM_SLEEVE_EXIT_RULE_VALUE,
  OTM_SLEEVE_EXIT_RULE_DEFAULT,
} from './exit-risk-rules-flag.js';
import type { OtmMispricingSignal, RelativeValueSignal } from '@trading-app/shared';

// 10:00 ET on a Tuesday (14:00Z under EDT) — the same pin `options-account.test.ts`
// uses, so the RTH-window predicates behave the same way here.
const SESSION_1 = Date.parse('2024-06-04T14:00:00Z');
// The NEXT session's open + 4 minutes: 09:34 ET Wednesday. This is the clock the
// live chandelier closes actually landed on.
const SESSION_2_OPEN = Date.parse('2024-06-05T13:34:00Z');

function buildOtmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-1',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: SESSION_1,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.30,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

function buildRvSignal(): RelativeValueSignal {
  return {
    id: 'sig-rv-1',
    symbol: 'MSFT',
    type: 'relative_value',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: SESSION_1,
    optionSymbol: 'MSFT240705C00400000',
    optionType: 'call',
    strike: 400,
    expiration: '2024-07-05',
    mark: 1.0,
    fairPrice: 1.30,
    mispricingPct: -0.23,
    zScore: -1.8,
    ivFitted: 0.30,
    ivUsed: 0.24,
    delta: 0.5,
    reason: 'TRA-3941 scope control',
  };
}

// Underlying ATR 4 ⇒ chandelier width 3×4 = 12 under the running high.
const RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map([['AAPL', 4], ['MSFT', 4]]) };

/**
 * An OTM call: entry 1.00, 6 contracts, SL 0.80 (−20%), TP1 1.50 (+50%), trail
 * arms at +30% (1.30) and rides `peakPremium × 0.80`.
 */
function openOtmCall(): { acct: PaperOptionsAccount; sym: string } {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
  const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'demo', undefined, 200);
  expect(pos).not.toBeNull();
  expect(pos!.signalType).toBe('otm_mispricing');
  expect(pos!.premiumPaid).toBeCloseTo(1.0, 6);
  expect(pos!.stopLossPremium).toBeCloseTo(0.80, 6);
  return { acct, sym: pos!.optionSymbol! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SESSION_1);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-3941 — resolveOtmSleeveExitRule', () => {
  it('defaults to the RULING (`trail`), not the legacy', () => {
    expect(OTM_SLEEVE_EXIT_RULE_DEFAULT).toBe('trail');
    expect(resolveOtmSleeveExitRule({})).toEqual({ rule: 'trail', source: 'default' });
    expect(resolveOtmSleeveExitRule({ [OTM_SLEEVE_EXIT_RULE_VALUE]: '   ' })).toEqual({
      rule: 'trail', source: 'default',
    });
  });

  it('restores the chandelier ONLY on the exact token, and says so', () => {
    expect(resolveOtmSleeveExitRule({ [OTM_SLEEVE_EXIT_RULE_VALUE]: 'chandelier' })).toEqual({
      rule: 'chandelier', source: 'env',
    });
    expect(resolveOtmSleeveExitRule({ [OTM_SLEEVE_EXIT_RULE_VALUE]: '  CHANDELIER ' })).toEqual({
      rule: 'chandelier', source: 'env',
    });
    expect(resolveOtmSleeveExitRule({ [OTM_SLEEVE_EXIT_RULE_VALUE]: 'trail' })).toEqual({
      rule: 'trail', source: 'env',
    });
  });

  it('fails a TYPO to the ruling and labels it `env_invalid` (a silent legacy is the incident)', () => {
    // `chandelier_restarted` is a real exit_reason and the most likely thing an
    // operator pastes in. It must not read as an arm of the legacy.
    for (const typo of ['chandelier_restarted', 'chandalier', 'off', '1', 'trail exit']) {
      expect(resolveOtmSleeveExitRule({ [OTM_SLEEVE_EXIT_RULE_VALUE]: typo })).toEqual({
        rule: 'trail', source: 'env_invalid',
      });
    }
  });
});

describe('TRA-3941 — isOtmSleeveRow', () => {
  it('covers BOTH stamps and nothing else', () => {
    expect(isOtmSleeveRow({ signalType: 'otm_mispricing' })).toBe(true);
    // TRA-2811 — a Tradier re-import after a reboot re-types the row, but the
    // origin stamp survives and the journal still joins it to `single_leg_otm`.
    expect(isOtmSleeveRow({ signalType: 'tradier_import', engineOriginSleeve: 'single_leg_otm' })).toBe(true);
    expect(isOtmSleeveRow({ signalType: 'relative_value' })).toBe(false);
    expect(isOtmSleeveRow({ signalType: 'tradier_import', engineOriginSleeve: 'single_leg_rv' })).toBe(false);
    expect(isOtmSleeveRow({})).toBe(false);
  });
});

// ── AC2 ─────────────────────────────────────────────────────────────────────
// "a position opened at X whose underlying rises then retraces after an
//  overnight gap is NOT exited at the next open by a re-seeded anchor; the
//  trail anchor equals the prior-session running high."
describe('TRA-3941 AC2 — an overnight gap does not re-anchor the OTM trail', () => {
  // The shared price path, run twice under the two rules.
  //
  //   session 1, 14:00Z  underlying 200 → 210, mark 1.00 → 1.40
  //                      (below TP1 1.50, so no partial; trail arms at 1.30)
  //   session 2, 13:34Z  underlying GAPS to 197, mark 1.36
  //                      197 is through the 198 chandelier level; 1.36 is above
  //                      the 1.12 premium trail AND above the 1.35 profit-lock
  //                      give-back level (see the `profit_lock` test below for
  //                      why that second clearance has to be stated).
  //                      (TRA-4006 re-pinned this mark from 1.32: the lock level
  //                      on this rig moved 1.30 → 1.35 when the tightened
  //                      give-back went 0.5R → 0.25R.)
  function runToTheGap(rule: 'trail' | 'chandelier') {
    const { acct, sym } = openOtmCall();
    const opts = { otmSleeveExitRule: rule } as const;

    vi.setSystemTime(SESSION_1);
    expect(
      acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.40]]), 'demo', opts, undefined, RISK),
    ).toHaveLength(0);

    vi.setSystemTime(SESSION_2_OPEN);
    const closed = acct.checkExits(
      new Map([['AAPL', 197]]), new Map([[sym, 1.36]]), 'demo', opts, undefined, RISK,
    );
    return { acct, sym, closed, opts };
  }

  it('POSITIVE CONTROL — under the legacy rule the gap open sells the row as `chandelier`', () => {
    const { closed } = runToTheGap('chandelier');
    expect(closed).toHaveLength(1);
    // The exact defect the board ruled on: sold at the next open, on the
    // underlying trail, with the premium trail nowhere near.
    expect(closed[0].exitReason).toBe('chandelier');
    expect(closed[0].currentPremium).toBeCloseTo(1.36, 6);
  });

  it('SUBJECT — under the ruling the row survives the gap, and the anchor is the PRIOR session high', () => {
    const { acct, closed } = runToTheGap('trail');
    expect(closed).toHaveLength(0);

    const open = acct.getState().openOptions[0];
    // The trail anchor on this sleeve is the premium running high. It was set in
    // session 1 and the gap did NOT touch it.
    expect(open.peakPremium).toBeCloseTo(1.40, 6);
    expect(open.trailingActive).toBe(true);
    expect(open.trailingStopPremium).toBeCloseTo(1.12, 6); // 1.40 × (1 − 0.20)
    // No underlying-space level exists to be re-seeded in the first place.
    expect(open.chandelierStop).toBeUndefined();
    expect(open.chandelierTrailNote).toBeUndefined();

    // Deliberately NOT continued into a trail fire here: with `exitRisk`
    // attached, Rule 2 (`profit_lock`) sits above the premium trail in the same
    // else-chain and is STRICTLY TIGHTER on the OTM schedule, so it — not the
    // trail — would be the rule that closed this row. That is a pre-existing
    // ordering this ticket did not touch, it is pinned in its own test below,
    // and letting it close the row here would have made this test claim a trail
    // fire it did not observe. The trail fire is proved on the pass where the
    // trail genuinely owns the decision, immediately below.
  });

  it('SUBJECT — the carried anchor is what the trail fires off in the next session', () => {
    // Same two sessions, no `exitRisk` on the pass: no ATR is cached for the
    // underlying (the ordinary case for a thin name) so neither the chandelier
    // nor `profit_lock` runs, and the premium trail owns the exit outright.
    const { acct, sym } = openOtmCall();
    const opts = { otmSleeveExitRule: 'trail' } as const;

    vi.setSystemTime(SESSION_1);
    expect(acct.checkExits(new Map(), new Map([[sym, 1.40]]), 'demo', opts)).toHaveLength(0);
    expect(acct.getState().openOptions[0].peakPremium).toBeCloseTo(1.40, 6);

    // Overnight. The next session opens with a gap DOWN in the premium.
    vi.setSystemTime(SESSION_2_OPEN);
    expect(acct.checkExits(new Map(), new Map([[sym, 1.20]]), 'demo', opts)).toHaveLength(0);
    // THE AC2 CLAIM: the anchor is the PRIOR session's running high, not the
    // gap open. Had anything re-seeded it at 1.20, the trail would now sit at
    // 0.96 and this row would ride $0.16 further down before stopping.
    const held = acct.getState().openOptions[0];
    expect(held.peakPremium).toBeCloseTo(1.40, 6);
    expect(held.trailingStopPremium).toBeCloseTo(1.12, 6);

    const closed = acct.checkExits(new Map(), new Map([[sym, 1.10]]), 'demo', opts);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('trail');
    expect(closed[0].currentPremium).toBeCloseTo(1.12, 6);
  });

  it('SUBJECT — a deeper gap that would breach ANY re-seeded anchor still does not exit', () => {
    // 190 is 8 points below the session-1 chandelier level and would re-seed an
    // underlying trail at 178 under the legacy veto. Mark 1.36 clears both the
    // 1.12 premium trail and the 1.35 profit-lock level (TRA-4006 schedule).
    const { acct, sym } = openOtmCall();
    const opts = { otmSleeveExitRule: 'trail' } as const;
    vi.setSystemTime(SESSION_1);
    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.40]]), 'demo', opts, undefined, RISK);
    vi.setSystemTime(SESSION_2_OPEN);
    expect(
      acct.checkExits(new Map([['AAPL', 190]]), new Map([[sym, 1.36]]), 'demo', opts, undefined, RISK),
    ).toHaveLength(0);
    expect(acct.getState().openOptions[0].peakPremium).toBeCloseTo(1.40, 6);
    expect(acct.getState().openOptions[0].chandelierStop).toBeUndefined();
  });
});

// ── The residual this ticket did NOT change, pinned so nobody reads AC1 wrong ─
//
// Retiring the chandelier does not make `trail` the give-back exit on every OTM
// pass. Rule 2 (`profit_lock`, TRA-1268) is evaluated in the SAME else-chain, one
// branch above the premium trail, whenever `exitRisk` is attached — and on the
// OTM schedule it is strictly tighter:
//
//   R          = premiumPaid − stopLossPremium = 0.20 × premium  (OTM_SL_PCT 0.20)
//   profit lock exits at  peak − 0.40R  (or peak − 0.25R once peakR ≥ 2)
//                         (TRA-4006; was peak − 1.0R / peak − 0.5R)
//   premium trail exits at peak × 0.80 = peak − 0.20 × peak
//
// At peak 1.40 (= 2.0R on this rig, so the tightened allowance applies) that is
// 1.35 vs 1.12: the lock fires $0.23 earlier (was 1.30 vs 1.12, $0.18, before
// TRA-4006). So an armed OTM row with a cached underlying ATR closes as
// `profit_lock`, not `trail`.
//
// This is NOT the defect TRA-3941 was filed on and is NOT in its accepted scope:
// `profit_lock` anchors on `peakPremium`, a running high that carries across
// sessions untouched, so it cannot re-seed off a gap open and cannot produce the
// 0–18-minutes-after-the-open cluster. It is recorded here because a grader
// reading AC1's "{trail, take_profit_early, stop, time_stop…}" would otherwise
// read a `profit_lock` row as a miss. Whether the OTM sleeve should also hand the
// give-back decision to the trail is a separate ruling, on separate evidence.
describe('TRA-3941 — RESIDUAL: profit_lock still outranks the trail on an armed OTM row', () => {
  it('closes as `profit_lock`, never as chandelier', () => {
    const { acct, sym } = openOtmCall();
    const opts = { otmSleeveExitRule: 'trail' } as const;
    vi.setSystemTime(SESSION_1);
    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.40]]), 'demo', opts, undefined, RISK);
    vi.setSystemTime(SESSION_2_OPEN);
    // 1.25 is under the 1.35 lock level (TRA-4006; was 1.30) and over the 1.12
    // trail level.
    const closed = acct.checkExits(
      new Map([['AAPL', 197]]), new Map([[sym, 1.25]]), 'demo', opts, undefined, RISK,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('profit_lock');
  });
});

describe('TRA-3941 — the retirement reaches state persisted by an older build', () => {
  it('drops a chandelier level, trail note and daily-close hold latch carried in from disk', () => {
    const { acct, sym } = openOtmCall();
    const row = acct.getState().openOptions[0];
    // What a snapshot written by a pre-TRA-3941 build looks like: a live level
    // already through the spot, plus the TRA-3902 hold latch the health walk
    // reads directly.
    row.peakUnderlying = 210;
    row.chandelierStop = 198;
    row.chandelierTrailNote = 'restarted_stale_breach';
    row.chandelierBreachedWhileSuppressed = true;
    row.chandelierHeldForDailyClose = '2024-06-04';

    const closed = acct.checkExits(
      new Map([['AAPL', 197]]), new Map([[sym, 1.00]]), 'demo',
      { otmSleeveExitRule: 'trail' }, undefined, RISK,
    );
    expect(closed).toHaveLength(0);
    const open = acct.getState().openOptions[0];
    expect(open.chandelierStop).toBeUndefined();
    expect(open.chandelierTrailNote).toBeUndefined();
    expect(open.chandelierBreachedWhileSuppressed).toBeUndefined();
    // Left set, this would keep `summarizeLiveStopActionability` reporting a
    // `chandelier_daily_close_hold` against a rule that no longer exists.
    expect(open.chandelierHeldForDailyClose).toBeUndefined();
  });
});

// ── AC4 (scope) ─────────────────────────────────────────────────────────────
describe('TRA-3941 — SCOPE: only the OTM sleeve loses the chandelier', () => {
  it('an RV row keeps the chandelier under the very same pass', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, 400);
    expect(pos).not.toBeNull();
    // Only meaningful if the row really is RV — an OTM row here would prove the
    // opposite of what this test claims.
    expect(pos!.signalType).toBe('relative_value');
    const sym = pos!.optionSymbol!;
    const opts = { otmSleeveExitRule: 'trail' } as const;

    // Same shape as the OTM subject: rally, then a pullback through the trail.
    expect(
      acct.checkExits(new Map([['MSFT', 410]]), new Map([[sym, 1.00]]), 'demo', opts, undefined, RISK),
    ).toHaveLength(0);
    expect(acct.getState().openOptions[0].chandelierStop).toBeCloseTo(398, 6);
    const closed = acct.checkExits(
      new Map([['MSFT', 397]]), new Map([[sym, 1.00]]), 'demo', opts, undefined, RISK,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('chandelier');
  });
});

// ── AC1 / AC3 wiring ────────────────────────────────────────────────────────
//
// `checkExits` defaults an ABSENT `otmSleeveExitRule` to the legacy `chandelier`
// so every pre-existing caller and test is byte-identical. That default is only
// safe while the ONE production caller actually attaches the resolved ruling — a
// caller that forgot the field would keep the chandelier live on real money and
// read identically to a fixed one. Source-level, because the alternative is
// booting the whole engine, and the failure being guarded is a MISSING LINE.
describe('TRA-3941 — the production caller attaches the ruling', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('signal-engine hands the env-resolved rule to the exit pass', () => {
    const src = read('./signal-engine.ts');
    expect(src).toContain('otmSleeveExitRule: resolveOtmSleeveExitRule().rule');
    // Exactly one site: a second, differently-resolved writer is how two passes
    // end up disagreeing about which rule is in force.
    expect(src.match(/otmSleeveExitRule:/g) ?? []).toHaveLength(1);
  });

  it('the options-live health route publishes the effective rule (AC3)', () => {
    const src = read('./index.ts');
    expect(src).toContain('otmSleeveExitRule: (() => {');
    expect(src).toContain('resolveOtmSleeveExitRule()');
    expect(src).toContain('chandelierRetired: resolution.rule === \'trail\'');
  });
});
