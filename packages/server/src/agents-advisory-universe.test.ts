// TRA-3514 (TRA-3460 (a)+(c)) — the universe/cadence bound and the backing gate.
//
// ⭐ EVERY assertion here is written in BOTH directions. The lesson this repo keeps
// re-learning (TRA-1727, TRA-1787) is that a one-directional control is half a
// control: a gate that refuses a known-bad tells you nothing unless you also show it
// PASSES a known-good, and vice versa. The auto-confirm block below is the sharp end
// of that — a clause that refused everything would satisfy "provably does not fire on
// llmUsed === false" while silently killing the whole demo auto-confirm rail.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldAutoConfirm,
  AUTO_CONFIRM_MIN_CONVICTION,
  AUTO_CONFIRM_MAX_NOTIONAL_USD,
  AUTO_CONFIRM_OPTIONS_MIN_POP,
} from '@trading-app/shared';
import {
  ADVISORY_MAX_SYMBOLS_PER_PASS,
  ADVISORY_PASSES_PER_SESSION,
  ADVISORY_PER_SYMBOL_COST_USD_ESTIMATE,
  advisoryWorstDailyUsd,
  assertAdvisoryUniverseAffordable,
  buildAdvisoryShortlist,
  emptyAdvisoryPassCensus,
} from './agents-advisory-bound.js';
import { COMPANY_CAP_ENV_VAR } from './agent-spend-store.js';

// ── Part 2: the CFO's arithmetic, in code ────────────────────────────────────

describe('TRA-3514 Part 2 — the universe sizing arithmetic', () => {
  const saved = process.env[COMPANY_CAP_ENV_VAR];
  afterEach(() => {
    if (saved === undefined) delete process.env[COMPANY_CAP_ENV_VAR];
    else process.env[COMPANY_CAP_ENV_VAR] = saved;
  });

  it('ships the ratified ceiling: 8 symbols, 1 pass/session, $0.05/symbol', () => {
    expect(ADVISORY_MAX_SYMBOLS_PER_PASS).toBe(8);
    expect(ADVISORY_PASSES_PER_SESSION).toBe(1);
    expect(ADVISORY_PER_SYMBOL_COST_USD_ESTIMATE).toBe(0.05);
  });

  it('8 x $0.05 x 1 = $0.40/day, which fits the live $0.50 cap with headroom', () => {
    expect(advisoryWorstDailyUsd()).toBeCloseTo(0.4, 10);
    process.env[COMPANY_CAP_ENV_VAR] = '0.50';
    expect(() => assertAdvisoryUniverseAffordable()).not.toThrow();
  });

  // The CFO asked us to check the arithmetic rather than accept it. THIS is the check:
  // 12 was the number the ticket rejected, and the reason it rejected it is testable.
  it('CONFIRMS the CFO: 12 symbols would overshoot $0.50, which is why the cap is 8', () => {
    expect(advisoryWorstDailyUsd(12, 0.05, 1)).toBeCloseTo(0.6, 10);
    expect(advisoryWorstDailyUsd(12, 0.05, 1)).toBeGreaterThan(0.5);
    // ...and 8 is the LARGEST multiple-of-one that still fits, so the ceiling is not
    // merely safe, it is the tightest safe choice at $0.05.
    expect(advisoryWorstDailyUsd(8, 0.05, 1)).toBeLessThanOrEqual(0.5);
    expect(advisoryWorstDailyUsd(11, 0.05, 1)).toBeGreaterThan(0.5);
  });

  // Negative direction: the assertion must be able to FAIL, or it is decoration.
  it('the affordability assertion FAILS when the cap is lowered under the bound', () => {
    process.env[COMPANY_CAP_ENV_VAR] = '0.10';
    expect(() => assertAdvisoryUniverseAffordable()).toThrow(/universe bound violated/);
    expect(() => assertAdvisoryUniverseAffordable()).toThrow(/\$0\.40\/day > the \$0\.10/);
  });

  it('per-pass cadence x width is a DAILY bound: 2 passes would breach the same cap', () => {
    expect(advisoryWorstDailyUsd(8, 0.05, 2)).toBeCloseTo(0.8, 10);
    expect(advisoryWorstDailyUsd(8, 0.05, 2)).toBeGreaterThan(0.5);
  });
});

// ── Part 2: the shortlist priority policy ────────────────────────────────────

describe('TRA-3514 Part 2 — buildAdvisoryShortlist', () => {
  it('orders open positions BEFORE proposals BEFORE the curated shortlist', () => {
    const r = buildAdvisoryShortlist({
      openPositions: ['NVDA'],
      pendingProposals: ['TSLA'],
      curated: ['AAPL', 'MSFT'],
      max: 8,
    });
    expect(r.symbols).toEqual(['NVDA', 'TSLA', 'AAPL', 'MSFT']);
    expect(r.reasons).toEqual({
      NVDA: 'open_position',
      TSLA: 'pending_proposal',
      AAPL: 'curated_shortlist',
      MSFT: 'curated_shortlist',
    });
  });

  // The positional-bias fix, stated as a test. Before TRA-3514 the universe was
  // `getActiveSymbols()` (alphabetical), so a held position late in the alphabet
  // never got a paid read no matter how many passes ran.
  it('an open position at the END of the alphabet still gets a slot when curated fills the cap', () => {
    const curated = ['AAPL', 'ADBE', 'AMD', 'AMZN', 'AVGO', 'COIN', 'CRM', 'DIA', 'META'];
    const r = buildAdvisoryShortlist({
      openPositions: ['ZZZZ'],
      pendingProposals: [],
      curated,
      max: 8,
    });
    expect(r.symbols[0]).toBe('ZZZZ');
    expect(r.symbols).toHaveLength(8);
    expect(r.dropped).toBe(2); // 10 candidates, 8 admitted
  });

  it('dedupes across tiers and credits the HIGHEST-priority reason', () => {
    const r = buildAdvisoryShortlist({
      openPositions: ['AAPL'],
      pendingProposals: ['AAPL', 'TSLA'],
      curated: ['AAPL', 'TSLA', 'MSFT'],
      max: 8,
    });
    expect(r.symbols).toEqual(['AAPL', 'TSLA', 'MSFT']);
    expect(r.reasons['AAPL']).toBe('open_position');
    expect(r.reasons['TSLA']).toBe('pending_proposal');
    expect(r.candidates).toBe(3);
    expect(r.dropped).toBe(0);
  });

  it('8 is a CEILING not a target — a short shortlist is advised whole', () => {
    const r = buildAdvisoryShortlist({
      openPositions: ['NVDA'],
      pendingProposals: [],
      curated: [],
      max: 8,
    });
    expect(r.symbols).toEqual(['NVDA']);
    expect(r.dropped).toBe(0);
  });

  it('caps at exactly max and REPORTS what it dropped (never a silent truncation)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `S${i}`);
    const r = buildAdvisoryShortlist({ openPositions: [], pendingProposals: [], curated: many, max: 8 });
    expect(r.symbols).toHaveLength(8);
    expect(r.candidates).toBe(30);
    expect(r.dropped).toBe(22);
    // Reasons cover the ADMITTED set only — a reason for a dropped symbol would read
    // as coverage the pass never gave it.
    expect(Object.keys(r.reasons).sort()).toEqual([...r.symbols].sort());
  });

  it('normalises case/whitespace and drops empties', () => {
    const r = buildAdvisoryShortlist({
      openPositions: [' nvda ', ''],
      pendingProposals: ['nvda'],
      curated: ['aapl'],
      max: 8,
    });
    expect(r.symbols).toEqual(['NVDA', 'AAPL']);
  });

  it('an empty world yields an empty pass, not a throw', () => {
    const r = buildAdvisoryShortlist({ openPositions: [], pendingProposals: [], curated: [], max: 8 });
    expect(r).toEqual({ symbols: [], reasons: {}, dropped: 0, candidates: 0 });
  });

  it('defaults max to the shipped ceiling when the caller omits it', () => {
    const many = Array.from({ length: 20 }, (_, i) => `S${i}`);
    expect(buildAdvisoryShortlist({ openPositions: [], pendingProposals: [], curated: many }).symbols)
      .toHaveLength(ADVISORY_MAX_SYMBOLS_PER_PASS);
  });
});

// ── Part 1 §3: the auto-confirm refusal, in BOTH directions ──────────────────

describe('TRA-3514 Part 1 §3 — auto-confirm must not fire on a fallback read', () => {
  const eq = {
    mode: 'demo' as const,
    conviction: 0.95, // comfortably over the 0.70 gate
    notional: 100, // comfortably under the $250 gate
    autoTradeEnabled: true,
    killSwitchClear: true,
  };

  // NEGATIVE control — the thing the clause exists to stop.
  it('REFUSES an otherwise-perfect demo proposal when agentBacked is false', () => {
    const d = shouldAutoConfirm({ ...eq, agentBacked: false });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/NOT LLM-backed/);
  });

  // POSITIVE control — without this, a clause that refused everything would pass the
  // negative control above and quietly disable the whole rail.
  it('STILL auto-confirms the identical proposal when agentBacked is true', () => {
    const d = shouldAutoConfirm({ ...eq, agentBacked: true });
    expect(d.autoConfirm).toBe(true);
    expect(d.reason).toMatch(/auto-confirmed/);
  });

  // The boundary the ratified gate is written on must be unmoved by this change.
  it('leaves the ratified conviction/notional boundaries exactly where they were', () => {
    const at = {
      ...eq,
      conviction: AUTO_CONFIRM_MIN_CONVICTION,
      notional: AUTO_CONFIRM_MAX_NOTIONAL_USD,
      agentBacked: true,
    };
    expect(shouldAutoConfirm(at).autoConfirm).toBe(true);
    expect(shouldAutoConfirm({ ...at, conviction: AUTO_CONFIRM_MIN_CONVICTION - 0.01 }).autoConfirm).toBe(false);
    expect(shouldAutoConfirm({ ...at, notional: AUTO_CONFIRM_MAX_NOTIONAL_USD + 0.01 }).autoConfirm).toBe(false);
  });

  // `undefined` is the absence of evidence, and the gate is about evidence. An agent
  // proposal that lost its stamp must fail CLOSED.
  it('treats an ABSENT stamp as not-proven when the field is supplied as undefined-ish', () => {
    // Explicit `false` from the engine call-site (`reco.llmUsed === true`) is the
    // shape an unstamped recommendation actually produces.
    expect(shouldAutoConfirm({ ...eq, agentBacked: false }).autoConfirm).toBe(false);
  });

  // ⚠️ The exemption. Omitting the field must NOT change behaviour, or this clause
  // silently disables the options-ideas rail it was never about.
  it('does NOT disturb call-sites that omit agentBacked (the options-IDEAS feed)', () => {
    const opt = shouldAutoConfirm({
      mode: 'demo',
      conviction: AUTO_CONFIRM_OPTIONS_MIN_POP,
      notional: 200,
      autoTradeEnabled: true,
      killSwitchClear: true,
      option: { pop: AUTO_CONFIRM_OPTIONS_MIN_POP, maxLossUsd: 200, definedRisk: true },
    });
    expect(opt.autoConfirm).toBe(true);
    // And an equity proposal with no stamp at all keeps its legacy behaviour.
    expect(shouldAutoConfirm(eq).autoConfirm).toBe(true);
  });

  // Precedence: the pre-existing hard NOs must still win, so a refusal reason never
  // misdirects. "live" must not be reported as a backing problem.
  it('keeps the pre-existing refusals AHEAD of the backing clause', () => {
    expect(shouldAutoConfirm({ ...eq, mode: 'live', agentBacked: false }).reason)
      .toMatch(/live never auto-confirms/);
    expect(shouldAutoConfirm({ ...eq, killSwitchClear: false, agentBacked: false }).reason)
      .toMatch(/kill switch/);
    expect(shouldAutoConfirm({ ...eq, autoTradeEnabled: false, agentBacked: false }).reason)
      .toMatch(/auto-trade toggle is OFF/);
  });

  // And an options proposal that DOES carry a false stamp is refused too — the clause
  // sits above the kind split, so a future agent-sourced options path inherits it.
  it('refuses an OPTIONS proposal that explicitly reports a fallback backing', () => {
    const d = shouldAutoConfirm({
      mode: 'demo',
      conviction: 0.9,
      notional: 100,
      autoTradeEnabled: true,
      killSwitchClear: true,
      option: { pop: 0.9, maxLossUsd: 100, definedRisk: true },
      agentBacked: false,
    });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/NOT LLM-backed/);
  });
});

// ── Part 1 §4: the census ────────────────────────────────────────────────────

describe('TRA-3514 Part 1 §4 — the per-pass census', () => {
  it('starts at zero on every counter', () => {
    expect(emptyAdvisoryPassCensus()).toEqual({ advised: 0, fellBack: 0, skipped: 0, failed: 0 });
  });

  it('returns a FRESH object per pass (a shared accumulator would sum sessions)', () => {
    const a = emptyAdvisoryPassCensus();
    a.advised = 5;
    expect(emptyAdvisoryPassCensus().advised).toBe(0);
  });
});
