// TRA-4991 (parent TRA-4945) — PUBLISH THE CHANDELIER'S INPUTS.
//
// ── What this file is answering ─────────────────────────────────────────────
// TRA-4945 was asked which condition stamped `exitReason: "chandelier"` on a
// 197-second, ZERO-excursion close (MARA261030P00013000). It could only answer
// by reading SOURCE BYTES against the deployed commit: every published column on
// a chandelier close is in PREMIUM space (`peakPremium`, `entryBasisPremium`,
// `mae.*`, `stopBasisPremium`) and the chandelier decides in SPOT space. A reader
// seeing `peakPremium == entryBasisPremium` and `mae.frac == 0` concluded "a
// trailing stop fired with no trail"; the trail was real, in a space nothing
// published. `git show` is not a surface a reader can re-cut.
//
// ── What is asserted ────────────────────────────────────────────────────────
//  AC1  a chandelier fire stamps the SPOT-space trigger inputs on the row and
//       the journal close row carries them verbatim; the trail's own arithmetic
//       (`peak − mult × atr == chandelierStop`, `spotAtFire <= chandelierStop`)
//       reconciles off the published fields alone.
//       CONTROL — a close by any other rule carries NO `chandelier` key. Absent,
//       never zeroed: a `0` ATR reads as "no volatility", not "not measured".
//  AC3  the high-beta branch COUNTER separates three states a flag cannot —
//       resolved high-beta, resolved base on a MEASURED atrPct, and resolved
//       base because no atrPct was served at all (branch UNREACHABLE).
//  AC5  read-only. The same price path under the same rule still closes under the
//       same bare `chandelier` label, with the same premium — the stamp rides
//       along, it does not move an exit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
} from './option-trade-journal.js';
import {
  CHANDELIER_ATR_PERIOD,
  SHADOW_CANDLE_TIMEFRAME_MS,
  measureCandleTimeframeMs,
  noteChandelierRatchet,
  resetChandelierRatchetLedgerForTests,
  resolveChandelierTrailParams,
  summarizeChandelierRatchets,
  type OptionChandelierAtrSource,
} from './option-chandelier-trail.js';
import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  type Candle,
  type OtmMispricingSignal,
} from '@trading-app/shared';
import { OTM_SLEEVE_EXIT_RULE_VALUE } from './exit-risk-rules-flag.js';

// The TRA-3941 rig, verbatim: 10:00 ET Tuesday, then 09:34 ET Wednesday — the
// clock the live chandelier closes actually landed on.
const SESSION_1 = Date.parse('2024-06-04T14:00:00Z');
const SESSION_2_OPEN = Date.parse('2024-06-05T13:34:00Z');

/** Every AC3 skip cell at zero — the shape a pass that ratcheted every row has. */
const NO_SKIPS = {
  retired: 0, multi_leg: 0, covered_write: 0, no_exit_risk: 0, no_spot_or_atr: 0,
  // TRA-4992's cell. Zero here for the whole of this suite, which runs on the
  // default `shadow_5m` timeframe where the cell is unreachable by construction.
  no_daily_atr: 0,
} as const;

const UATR = 4;
/** base width 3.0 × 4 = 12 under the running high 210 ⇒ stop 198. */
const BASE_STOP = 210 - EXIT_CHANDELIER_ATR_MULT * UATR;

function buildOtmSignal(): OtmMispricingSignal {
  return {
    id: 'sig-4991',
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
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
  };
}

const JOURNAL_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

/**
 * The ATR provenance a real `buildOptionExitRisk` attaches: period 14, spacing
 * MEASURED off the 5m shadow series, bar count.
 */
const ATR_SOURCE: OptionChandelierAtrSource = {
  period: CHANDELIER_ATR_PERIOD,
  timeframeMs: SHADOW_CANDLE_TIMEFRAME_MS,
  // TRA-4992 added the SELECTED series beside the measured spacing. `shadow_5m`
  // keeps this suite's subject the pre-repair default it was written against.
  series: 'shadow_5m',
  bars: 480,
};

function risk(over: Partial<OptionExitRiskInput> = {}): OptionExitRiskInput {
  return {
    underlyingAtrBySymbol: new Map([['AAPL', UATR]]),
    underlyingAtrSourceBySymbol: new Map([['AAPL', ATR_SOURCE]]),
    ...over,
  };
}

/** Open the OTM call with the journal armed, underlying anchored at 200. */
function openOtmCall(): { acct: PaperOptionsAccount; sym: string; id: string } {
  // Pinned here, not left to the caller: an open attempted at SESSION_2's 09:34
  // ET is refused by the entry-side guards, and a `null` position would read as a
  // failure of whatever the test was actually asserting.
  vi.setSystemTime(SESSION_1);
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
  const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'demo', undefined, 200, JOURNAL_SETUP);
  expect(pos).not.toBeNull();
  expect(pos!.underlyingEntryPrice).toBeCloseTo(200, 6);
  return { acct, sym: pos!.optionSymbol!, id: pos!.id };
}

/**
 * Session 1 ratchets the trail to the 210 high; session 2 gaps the underlying to
 * `spot` and the premium to `mark`. Under `otmSleeveExitRule: 'chandelier'` (the
 * legacy, restored by env token) the OTM sleeve keeps the underlying trail, which
 * is the mechanism under test.
 */
function runToTheGap(
  spot: number,
  mark: number,
  exitRisk: OptionExitRiskInput,
): { acct: PaperOptionsAccount; sym: string; id: string; closed: ReturnType<PaperOptionsAccount['checkExits']> } {
  const { acct, sym, id } = openOtmCall();
  const opts = { otmSleeveExitRule: 'chandelier' } as const;

  vi.setSystemTime(SESSION_1);
  expect(
    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo', opts, undefined, exitRisk),
  ).toHaveLength(0);

  vi.setSystemTime(SESSION_2_OPEN);
  const closed = acct.checkExits(
    new Map([['AAPL', spot]]), new Map([[sym, mark]]), 'demo', opts, undefined, exitRisk,
  );
  return { acct, sym, id, closed };
}

let tmpFile: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SESSION_1);
  resetChandelierRatchetLedgerForTests(SESSION_1);
  tmpFile = join(tmpdir(), `tra4991-journal-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

// ── AC1 ─────────────────────────────────────────────────────────────────────

describe('TRA-4991 AC1 — the chandelier publishes its SPOT-space trigger inputs', () => {
  it('stamps the trail at the fire and the journal close row carries it verbatim', async () => {
    // 197 is through the 198 base-width level; the premium 1.36 clears the 1.12
    // premium trail, so the underlying trail genuinely owns this decision.
    const { acct, closed, id } = runToTheGap(197, 1.36, risk());
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('chandelier');

    const fire = closed[0]!.chandelierFire!;
    expect(fire).toBeDefined();
    expect(fire.at).toBe(SESSION_2_OPEN);
    // The label is carried on the stamp as WELL as on `exitReason`, so a
    // supersede that rewrites the row's reason cannot erase the trail's own
    // account of which mechanism fired.
    expect(fire.exitReason).toBe('chandelier');
    // Long the UNDERLYING for a call — not the option side (the book is always
    // long the premium).
    expect(fire.side).toBe('buy');

    // The six quantities AC1 names, none of which survives the close anywhere
    // else on the wire.
    expect(fire.peakUnderlying).toBeCloseTo(210, 6);
    expect(fire.chandelierStop).toBeCloseTo(BASE_STOP, 6); // 198
    expect(fire.underlyingEntryPrice).toBeCloseTo(200, 6);
    expect(fire.spotAtFire).toBeCloseTo(197, 6);
    expect(fire.atr).toBeCloseTo(UATR, 6);
    expect(fire.atrPeriod).toBe(CHANDELIER_ATR_PERIOD);
    expect(fire.atrTimeframeMs).toBe(SHADOW_CANDLE_TIMEFRAME_MS);
    expect(fire.atrBars).toBe(ATR_SOURCE.bars);

    // ⭐ THE POINT: the trail's arithmetic now reconciles off the PUBLISHED
    // fields alone — no constant, no source read. This is the derivation
    // TRA-4945 had to do with `git show`.
    expect(fire.peakUnderlying - fire.atrMult * fire.atr).toBeCloseTo(fire.chandelierStop, 6);
    // TRA-5101 — and the row SAYS it reconciles, to FULL precision (strict
    // equality, not a tolerance): the stop last moved on this very tick's
    // inputs, so recomposing them is bit-identical arithmetic.
    expect(fire.peakUnderlying - fire.atrMult * fire.atr).toBe(fire.chandelierStop);
    expect(fire.stopReconstructs).toBe(true);
    expect(fire.stopNonReconstructionReason).toBeUndefined();
    expect(fire.stopBasis).toBeUndefined();
    expect(fire.spotAtFire).toBeLessThanOrEqual(fire.chandelierStop);
    // …and the excursion that PREMIUM space reported as zero is visible here:
    // the underlying ran 200 → 210 and gave back 13.
    expect(fire.peakUnderlying - fire.underlyingEntryPrice).toBeCloseTo(10, 6);
    expect(fire.peakUnderlying - fire.spotAtFire).toBeCloseTo(13, 6);

    // The multiplier regime, and the comparison it was made with, on the row.
    expect(fire.atrMult).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT, 9);
    expect(fire.highBeta).toBe(false);
    expect(fire.atrMultBase).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT, 9);
    expect(fire.atrMultHighBeta).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT_HIGHBETA, 9);
    expect(fire.highBetaAtrPct).toBeCloseTo(EXIT_CHANDELIER_HIGHBETA_ATRPCT, 9);
    // No ATR% was served on this rig, so the high-beta branch was UNREACHABLE
    // rather than declined — `null`, never `0`.
    expect(fire.atrPct).toBeNull();
    // A trail anchored on a real entry spot carries no provenance note.
    expect(fire.trailNote).toBeUndefined();

    // …and the journal close row publishes the WHOLE object verbatim. `toEqual`
    // on purpose: a field added to the stamp that never reaches the journal is
    // the exact defect this ticket is about, and this goes red when a writer
    // forgets to plumb one.
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    const closedRow = rows.find((r) => r.id === id);
    expect(closedRow).toBeDefined();
    expect(closedRow!.outcome).not.toBe('OPEN');
    expect(closedRow!.exitReason).toBe('chandelier');
    expect(closedRow!.chandelier).toEqual(fire);
  });

  it('a spot-seeded trail says so on the stamp, and the seed is readable beside the `0` anchor', async () => {
    // TRA-2893's imported-row state: no honest entry anchor, so the trail is
    // seeded from the first spot it sees. The `0` here is a ROUTINE state and the
    // pair (`underlyingEntryPrice: 0`, `trailNote: 'spot_seeded'`) is what makes
    // it readable instead of looking like corruption.
    const { acct, sym, id } = openOtmCall();
    const open = acct.getState().openOptions[0]!;
    open.underlyingEntryPrice = 0;
    const opts = { otmSleeveExitRule: 'chandelier' } as const;
    const exitRisk = risk();

    // Seeding tick: anchor 205, stop 193 — it cannot fire on its own seed.
    vi.setSystemTime(SESSION_1);
    expect(
      acct.checkExits(new Map([['AAPL', 205]]), new Map([[sym, 1.4]]), 'demo', opts, undefined, exitRisk),
    ).toHaveLength(0);
    expect(acct.getState().openOptions[0]!.chandelierTrailNote).toBe('spot_seeded');

    vi.setSystemTime(SESSION_2_OPEN);
    const closed = acct.checkExits(
      new Map([['AAPL', 192]]), new Map([[sym, 1.36]]), 'demo', opts, undefined, exitRisk,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('chandelier_spot_seeded');

    const fire = closed[0]!.chandelierFire!;
    expect(fire.exitReason).toBe('chandelier_spot_seeded');
    expect(fire.trailNote).toBe('spot_seeded');
    expect(fire.underlyingEntryPrice).toBe(0);
    expect(fire.peakUnderlying).toBeCloseTo(205, 6);
    expect(fire.chandelierStop).toBeCloseTo(205 - EXIT_CHANDELIER_ATR_MULT * UATR, 6);

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows.find((r) => r.id === id)!.chandelier).toEqual(fire);
  });

  it('CONTROL — a close by another rule carries NO `chandelier` key (absent, never a zeroed object)', async () => {
    // Same rig, no ATR at all ⇒ the chandelier never arms; the premium trail
    // (peak 1.40 × 0.80 = 1.12) takes the row instead.
    const { acct, sym, id } = openOtmCall();
    const opts = { otmSleeveExitRule: 'chandelier' } as const;

    vi.setSystemTime(SESSION_1);
    expect(acct.checkExits(new Map(), new Map([[sym, 1.4]]), 'demo', opts)).toHaveLength(0);
    vi.setSystemTime(SESSION_2_OPEN);
    const closed = acct.checkExits(new Map(), new Map([[sym, 1.05]]), 'demo', opts);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).not.toMatch(/^chandelier/);
    expect(closed[0]!.chandelierFire).toBeUndefined();

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    const row = rows.find((r) => r.id === id)!;
    // ⛔ The KEY is absent — not `{ atr: 0, … }`. A `0` ATR reads as "no
    // volatility" rather than "not measured", and the two license opposite
    // conclusions about the same close.
    expect('chandelier' in row).toBe(false);
    expect(row.chandelier).toBeUndefined();
  });
});

// ── TRA-5101 — the published inputs reconstruct the stop, or the row says why ─
//
// The stop is a MONOTONE ratchet (`chandelierStop` clamps against
// `prevTrailStop`), so the level can be CARRIED from an earlier tick whose
// ATR/multiplier differ from the firing tick's. Measured 2026-10-04 off live
// b2dca7c1: NU's close row published chandelierStop 13.199253350520513 whose
// implied extreme missed the published peakUnderlying 13.0601 by 0.013%, while
// XLF reconstructed to full precision — the difference being only WHEN each
// stop last advanced. The block must either recompose its own stop exactly or
// name the reason it cannot.

describe('TRA-5101 — a ratchet-held stop names itself and ships the basis that reconstructs it', () => {
  it('ATR grew after the level last advanced ⇒ `stopReconstructs: false`, reason named, basis exact', async () => {
    const { acct, sym, id } = openOtmCall();
    const opts = { otmSleeveExitRule: 'chandelier' } as const;

    // Session 1: ATR 4 under the 210 high ⇒ the ratchet ACCEPTS 198. That tick
    // is the stop's basis.
    vi.setSystemTime(SESSION_1);
    expect(
      acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo', opts, undefined, risk()),
    ).toHaveLength(0);
    const open = acct.getState().openOptions[0]!;
    expect(open.chandelierStop).toBe(210 - EXIT_CHANDELIER_ATR_MULT * UATR);
    expect(open.chandelierStopBasis).toEqual({
      at: SESSION_1, peakUnderlying: 210, atr: UATR, atrPct: null, atrMult: EXIT_CHANDELIER_ATR_MULT,
    });

    // Session 2: the NU shape — ATR rises to 5, so this tick's candidate is
    // 210 − 15 = 195 and the ratchet HOLDS 198 (a rising ATR must never loosen
    // the stop). Spot 197 is through the held level ⇒ fire. The firing tick's
    // published inputs now CANNOT recompose the stop.
    const widerAtr = 5;
    vi.setSystemTime(SESSION_2_OPEN);
    const closed = acct.checkExits(
      new Map([['AAPL', 197]]), new Map([[sym, 1.36]]), 'demo', opts, undefined,
      risk({ underlyingAtrBySymbol: new Map([['AAPL', widerAtr]]) }),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('chandelier');

    const fire = closed[0]!.chandelierFire!;
    // The firing tick's own inputs, verbatim — truthful, just not the ones the
    // level came from.
    expect(fire.atr).toBe(widerAtr);
    expect(fire.peakUnderlying).toBe(210);
    expect(fire.chandelierStop).toBe(BASE_STOP); // 198, held
    expect(fire.peakUnderlying - fire.atrMult * fire.atr).not.toBe(fire.chandelierStop); // 195 ≠ 198
    // ⭐ THE POINT: the row SAYS so, names why, and ships the inputs that DO
    // reconstruct the level — to full precision, strict equality.
    expect(fire.stopReconstructs).toBe(false);
    expect(fire.stopNonReconstructionReason).toBe('ratchet_held_prior_level');
    expect(fire.stopBasis).toEqual({
      at: SESSION_1, peakUnderlying: 210, atr: UATR, atrPct: null, atrMult: EXIT_CHANDELIER_ATR_MULT,
    });
    expect(fire.stopBasis!.peakUnderlying - fire.stopBasis!.atrMult * fire.stopBasis!.atr)
      .toBe(fire.chandelierStop);

    // AC5 posture — the verdict is observe-only: same label, same premium.
    expect(closed[0]!.currentPremium).toBeCloseTo(1.36, 6);

    // …and the journal close row carries the verdict, the reason and the basis
    // verbatim (`toEqual` so a field that never reaches the journal goes red).
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows.find((r) => r.id === id)!.chandelier).toEqual(fire);
  });

  it('a stop PERSISTED by a pre-TRA-5101 build has no captured basis: the reason says so, ⛔ nothing is fabricated', async () => {
    // A row that last ratcheted on an older build: level present, basis never
    // captured. The ratchet must not invent one after the fact.
    const { acct, sym, id } = openOtmCall();
    const open = acct.getState().openOptions[0]!;
    open.peakUnderlying = 210;
    open.chandelierStop = BASE_STOP; // 198, from inputs this build never saw
    expect(open.chandelierStopBasis).toBeUndefined();
    const opts = { otmSleeveExitRule: 'chandelier' } as const;

    // First tick on THIS build serves the wider ATR, so the ratchet HOLDS the
    // inherited level (candidate 195 < 198) — no basis is ever stamped — and
    // spot 197 fires through it on the same pass.
    vi.setSystemTime(SESSION_2_OPEN);
    const closed = acct.checkExits(
      new Map([['AAPL', 197]]), new Map([[sym, 1.36]]), 'demo', opts, undefined,
      risk({ underlyingAtrBySymbol: new Map([['AAPL', 5]]) }),
    );
    expect(closed).toHaveLength(1);

    const fire = closed[0]!.chandelierFire!;
    expect(fire.chandelierStop).toBe(BASE_STOP);
    expect(fire.stopReconstructs).toBe(false);
    expect(fire.stopNonReconstructionReason).toBe('stop_predates_basis_stamp');
    // ⛔ ABSENT, never reconstructed: the setting tick's inputs were never
    // captured, and a backfilled basis is a fabricated column.
    expect('stopBasis' in fire).toBe(false);

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows.find((r) => r.id === id)!.chandelier).toEqual(fire);
  });

  it('the basis FOLLOWS the stop: a later advance restamps it, and the fire off that tick reconstructs', () => {
    const { acct, sym } = openOtmCall();
    const opts = { otmSleeveExitRule: 'chandelier' } as const;

    vi.setSystemTime(SESSION_1);
    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo', opts, undefined, risk());
    // The high advances to 214 on the same ATR ⇒ the ratchet accepts 202 and
    // the basis moves WITH the level — it is the setting tick's record, not
    // the first tick's.
    vi.setSystemTime(SESSION_2_OPEN);
    acct.checkExits(new Map([['AAPL', 214]]), new Map([[sym, 1.42]]), 'demo', opts, undefined, risk());
    const open = acct.getState().openOptions[0]!;
    expect(open.chandelierStop).toBe(214 - EXIT_CHANDELIER_ATR_MULT * UATR);
    expect(open.chandelierStopBasis).toEqual({
      at: SESSION_2_OPEN, peakUnderlying: 214, atr: UATR, atrPct: null, atrMult: EXIT_CHANDELIER_ATR_MULT,
    });
  });
});

// ── AC5 — read-only ─────────────────────────────────────────────────────────

describe('TRA-4991 AC5 — no exit behaviour moved', () => {
  it('the bare `chandelier` label, the fire premium and the retirement are all unchanged', () => {
    // The TRA-3941 positive control, re-run: same path, same rule, same label,
    // same premium. The stamp rides along.
    const legacy = runToTheGap(197, 1.36, risk());
    expect(legacy.closed).toHaveLength(1);
    expect(legacy.closed[0]!.exitReason).toBe('chandelier');
    expect(legacy.closed[0]!.currentPremium).toBeCloseTo(1.36, 6);

    // …and under the TRA-3941 RULING the whole family is still retired on this
    // sleeve: no level, no note, no stamp, no fire. A stamp that appeared on a
    // retired row would mean the ratchet had been resurrected.
    const { acct, sym } = openOtmCall();
    const opts = { otmSleeveExitRule: 'trail' } as const;
    vi.setSystemTime(SESSION_1);
    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo', opts, undefined, risk());
    vi.setSystemTime(SESSION_2_OPEN);
    const closed = acct.checkExits(
      new Map([['AAPL', 197]]), new Map([[sym, 1.36]]), 'demo', opts, undefined, risk(),
    );
    expect(closed).toHaveLength(0);
    const row = acct.getState().openOptions[0]!;
    expect(row.chandelierStop).toBeUndefined();
    expect(row.chandelierFire).toBeUndefined();
    // Only the legacy run ratcheted. The retired row's two passes are still SEEN
    // and attributed — "retired" is a reading, not an absence.
    const all = summarizeChandelierRatchets().all;
    expect(all.ratchets).toBe(2);
    expect(all.skipped.retired).toBe(2);
    expect(all.rowsSeen).toBe(4);
  });
});

// ── AC3 — the high-beta branch counter ──────────────────────────────────────

describe('TRA-4991 AC3 — the high-beta multiplier is COUNTED, not flagged', () => {
  it('a ratchet with NO atrPct lands in `baseAtrPctAbsent`: the branch was unreachable, not declined', () => {
    const { acct, sym } = openOtmCall();
    vi.setSystemTime(SESSION_1);
    acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' }, undefined, risk(),
    );
    const tally = summarizeChandelierRatchets().byMode.demo;
    expect(tally.rowsSeen).toBe(1);
    expect(tally.ratchets).toBe(1);
    expect(tally.skipped).toEqual(NO_SKIPS);
    expect(tally.highBeta).toBe(0);
    expect(tally.base).toBe(0);
    // ⛔ THE DISCRIMINATION: `highBeta: 0` here is NOT a reading about
    // volatility. No atrPct was served, so `chandelierMultiplier` could not even
    // evaluate its comparison.
    expect(tally.baseAtrPctAbsent).toBe(1);
    expect(tally.maxAtrPct).toBeNull();
  });

  it('a MEASURED atrPct under the threshold lands in `base`, and over it in `highBeta`', () => {
    const under = EXIT_CHANDELIER_HIGHBETA_ATRPCT / 2;
    const over = EXIT_CHANDELIER_HIGHBETA_ATRPCT * 2;

    const low = openOtmCall();
    vi.setSystemTime(SESSION_1);
    low.acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[low.sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' }, undefined,
      risk({ underlyingAtrPctBySymbol: new Map([['AAPL', under]]) }),
    );
    let tally = summarizeChandelierRatchets().byMode.demo;
    expect(tally).toMatchObject({ ratchets: 1, base: 1, highBeta: 0, baseAtrPctAbsent: 0 });
    expect(tally.maxAtrPct).toBeCloseTo(under, 9);
    // The width the trail actually used is the base one.
    expect(low.acct.getState().openOptions[0]!.chandelierStop).toBeCloseTo(BASE_STOP, 6);

    const high = openOtmCall();
    high.acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[high.sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' }, undefined,
      risk({ underlyingAtrPctBySymbol: new Map([['AAPL', over]]) }),
    );
    tally = summarizeChandelierRatchets().byMode.demo;
    expect(tally).toMatchObject({ ratchets: 2, base: 1, highBeta: 1, baseAtrPctAbsent: 0 });
    // `maxAtrPct` is a MAX over the process, so it moved to the larger reading.
    expect(tally.maxAtrPct).toBeCloseTo(over, 9);
    // …and the WIDER multiplier is what the row's level reflects: 210 − 3.5×4.
    expect(high.acct.getState().openOptions[0]!.chandelierStop)
      .toBeCloseTo(210 - EXIT_CHANDELIER_ATR_MULT_HIGHBETA * UATR, 6);
    // A fire on that row would publish the same regime on the stamp.
    expect(summarizeChandelierRatchets().all.highBeta).toBe(1);
  });

  it('the three cells PARTITION `ratchets`, and the books are not pooled', () => {
    noteChandelierRatchet('live', 0.09, EXIT_CHANDELIER_ATR_MULT_HIGHBETA);
    noteChandelierRatchet('live', 0.01, EXIT_CHANDELIER_ATR_MULT);
    noteChandelierRatchet('demo', undefined, EXIT_CHANDELIER_ATR_MULT);
    const s = summarizeChandelierRatchets();

    // ⚠ A pooled counter would let demo volatility answer a question asked about
    // real money. The live book's reading is its own.
    expect(s.byMode.live).toEqual({
      rowsSeen: 2, ratchets: 2, skipped: NO_SKIPS,
      highBeta: 1, base: 1, baseAtrPctAbsent: 0, maxAtrPct: 0.09,
    });
    expect(s.byMode.demo).toEqual({
      rowsSeen: 1, ratchets: 1, skipped: NO_SKIPS,
      highBeta: 0, base: 0, baseAtrPctAbsent: 1, maxAtrPct: null,
    });
    for (const t of [s.byMode.live, s.byMode.demo, s.all]) {
      expect(t.highBeta + t.base + t.baseAtrPctAbsent).toBe(t.ratchets);
    }
    expect(s.all.maxAtrPct).toBe(0.09);
    expect(s.sinceBootAt).toBe(SESSION_1);
  });

  // ── the DENOMINATOR ───────────────────────────────────────────────────────
  // Measured on live 7b99dda8cd30 minutes after the first deploy: `ratchets: 0`
  // on both books — and the whole book was TWO `bull_put` combos, which the
  // single-leg trail never evaluates. So that zero was a 0/0. A bare `ratchets:
  // 0` reads identically to "the trail ran all session and never went high beta",
  // which is the "reads the same whether the branch is live or dead" vacuity AC3
  // exists to kill, one level up. `rowsSeen` + `skipped` is the fix.

  it('a COMBO book produces rowsSeen > 0 with 0 ratchets, attributed to `multi_leg` — the live 0/0, made readable', () => {
    const { acct, sym } = openOtmCall();
    // Turn the row into a combo the way the book does: a `legs[]` array means the
    // single-leg chandelier does not evaluate it at all.
    const open = acct.getState().openOptions[0]!;
    open.legs = [
      { optionSymbol: open.optionSymbol!, optionType: 'put', strike: 190, side: 'buy', ratio: 1, expiration: '2024-07-05' },
      { optionSymbol: 'AAPL240705P00195000', optionType: 'put', strike: 195, side: 'sell', ratio: 1, expiration: '2024-07-05' },
    ] as never;

    vi.setSystemTime(SESSION_1);
    acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' }, undefined, risk(),
    );
    const t = summarizeChandelierRatchets().byMode.demo;
    // ⛔ The discrimination: rowsSeen is NON-zero, ratchets is zero, and the
    // reason is named. "Nothing was eligible" and "eligible, never high beta" are
    // now different readings.
    expect(t.rowsSeen).toBe(1);
    expect(t.ratchets).toBe(0);
    expect(t.skipped.multi_leg).toBe(1);
    expect(t.rowsSeen).toBe(t.ratchets + Object.values(t.skipped).reduce((a, n) => a + n, 0));
  });

  it('a COVERED WRITE is counted and attributed, so a CSP book does not read as a book whose trail ran', () => {
    const { acct, sym } = openOtmCall();
    acct.getState().openOptions[0]!.coveredWrite = true as never;
    vi.setSystemTime(SESSION_1);
    acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' }, undefined, risk(),
    );
    const t = summarizeChandelierRatchets().byMode.demo;
    expect(t).toMatchObject({ rowsSeen: 1, ratchets: 0 });
    expect(t.skipped.covered_write).toBe(1);
  });

  it('a RETIRED OTM row is counted and attributed to `retired`, not silently absent', () => {
    const { acct, sym } = openOtmCall();
    vi.setSystemTime(SESSION_1);
    // The TRA-3941 ruling: the family is retired on this sleeve. The row is still
    // SEEN — that is what stops "the sleeve is retired" reading as "no data".
    acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'trail' }, undefined, risk(),
    );
    const t = summarizeChandelierRatchets().byMode.demo;
    expect(t).toMatchObject({ rowsSeen: 1, ratchets: 0 });
    expect(t.skipped.retired).toBe(1);
  });

  it('no `exitRisk` at all is `no_exit_risk` — a STRUCTURAL zero, named as one', () => {
    const { acct, sym } = openOtmCall();
    vi.setSystemTime(SESSION_1);
    // The exit-risk master off: no input attached, so the ratchet cannot run. The
    // route publishes `exitRiskMaster` beside the census for exactly this case.
    acct.checkExits(new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo', { otmSleeveExitRule: 'chandelier' });
    const t = summarizeChandelierRatchets().byMode.demo;
    expect(t).toMatchObject({ rowsSeen: 1, ratchets: 0 });
    expect(t.skipped.no_exit_risk).toBe(1);
  });

  it('eligible but no ATR for the underlying is `no_spot_or_atr` — the nearest cell to a real absence', () => {
    const { acct, sym } = openOtmCall();
    vi.setSystemTime(SESSION_1);
    // `exitRisk` attached but carrying no ATR for AAPL: the trail WOULD have run
    // had the feed reached it, which is a different fact from a retired sleeve.
    acct.checkExits(
      new Map([['AAPL', 210]]), new Map([[sym, 1.4]]), 'demo',
      { otmSleeveExitRule: 'chandelier' }, undefined,
      { underlyingAtrBySymbol: new Map() },
    );
    const t = summarizeChandelierRatchets().byMode.demo;
    expect(t).toMatchObject({ rowsSeen: 1, ratchets: 0 });
    expect(t.skipped.no_spot_or_atr).toBe(1);
  });
});

// ── AC2 — the parameterisation ──────────────────────────────────────────────

describe('TRA-4991 AC2 — the resolved trail parameterisation', () => {
  const saved = process.env[OTM_SLEEVE_EXIT_RULE_VALUE];
  afterEach(() => {
    if (saved === undefined) delete process.env[OTM_SLEEVE_EXIT_RULE_VALUE];
    else process.env[OTM_SLEEVE_EXIT_RULE_VALUE] = saved;
  });

  it('publishes the multipliers, the ATR source and the sleeve rule with its source', () => {
    const p = resolveChandelierTrailParams({});
    expect(p.atrMult).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT, 9);
    expect(p.atrMultHighBeta).toBeCloseTo(EXIT_CHANDELIER_ATR_MULT_HIGHBETA, 9);
    expect(p.highBetaAtrPct).toBeCloseTo(EXIT_CHANDELIER_HIGHBETA_ATRPCT, 9);
    // ⚠ `compiled`: there is NO env override for the three above in this build.
    // Published so a reader stops hunting for a key instead of concluding one
    // was unset.
    expect(p.multSource).toBe('compiled');
    expect(p.atrPeriod).toBe(CHANDELIER_ATR_PERIOD);
    expect(p.atrTimeframeMs).toBe(SHADOW_CANDLE_TIMEFRAME_MS);
    // Nothing set IS the TRA-3941 ruling — and the route says so rather than
    // leaving it to be inferred from a `render.yaml` absence.
    expect(p.otmSleeveExitRule).toMatchObject({
      rule: 'trail', source: 'default', chandelierRetired: true,
      envKey: OTM_SLEEVE_EXIT_RULE_VALUE,
    });
  });

  it('a TYPO in the sleeve key is visible as `env_invalid`, still retired', () => {
    const p = resolveChandelierTrailParams({ [OTM_SLEEVE_EXIT_RULE_VALUE]: 'chandalier' });
    expect(p.otmSleeveExitRule.source).toBe('env_invalid');
    expect(p.otmSleeveExitRule.chandelierRetired).toBe(true);
  });

  it('an explicit legacy arm reports the chandelier LIVE on the sleeve', () => {
    const p = resolveChandelierTrailParams({ [OTM_SLEEVE_EXIT_RULE_VALUE]: 'chandelier' });
    expect(p.otmSleeveExitRule).toMatchObject({
      rule: 'chandelier', source: 'env', chandelierRetired: false,
    });
  });
});

// ── the measured timeframe ──────────────────────────────────────────────────

describe('TRA-4991 — the ATR timeframe on a row is MEASURED, not asserted', () => {
  const bar = (t: number): Candle => ({
    symbol: 'AAPL', timestamp: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
  });

  it('measures the median spacing and is immune to one session gap', () => {
    const base = Date.parse('2024-06-04T13:30:00Z');
    const fiveMin = [0, 1, 2, 3].map((i) => bar(base + i * 5 * 60_000));
    expect(measureCandleTimeframeMs(fiveMin)).toBe(5 * 60_000);
    // One overnight gap must not become the reading.
    const withGap = [...fiveMin, bar(base + 20 * 3_600_000)];
    expect(measureCandleTimeframeMs(withGap)).toBe(5 * 60_000);
    // A re-pointed series reports ITSELF — which is the whole reason the row
    // carries a measurement and not the published constant (TRA-4992 will move
    // this, and the row has to move with it).
    const daily = [0, 1, 2].map((i) => bar(base + i * 86_400_000));
    expect(measureCandleTimeframeMs(daily)).toBe(86_400_000);
  });

  it('⛔ returns null, never 0, when it cannot measure', () => {
    expect(measureCandleTimeframeMs(undefined)).toBeNull();
    expect(measureCandleTimeframeMs([])).toBeNull();
    expect(measureCandleTimeframeMs([bar(1)])).toBeNull();
  });
});
