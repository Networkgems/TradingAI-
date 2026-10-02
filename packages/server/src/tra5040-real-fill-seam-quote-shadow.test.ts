// TRA-5040 — the real-fill arm reads ONE field fewer than its sibling.
//
// ── What these controls have to be able to fail ──────────────────────────────
//
// `crossedPnlUsd` resolves its exit book as `markProvenance.quoteAtFire` and then
// TRA-4997's close-seam `exitQuote`; `priceRealFillRow` read only the first. On
// bqb1 at 2026-10-02T03:29Z (`6690770689b5`) that discarded 15 of the 20
// broker-truth rows on the tape under `exit_quote_missing` — inside the one gate
// standing between the OTM sleeve and a live entry.
//
// The fallback therefore ships twice over: as an OPT-IN on the pricer (default
// off, so the shipped census cannot move) and as a SHADOW on the fold. The
// controls that matter are the ones that would catch the two ways this goes
// wrong silently:
//
//   • a fallback that leaks into the DECISION (`admitsRealFill`, `nRealFill`,
//     `loRealFillNet`) — `shadowCrossingTheFloorDecidesNothing` and
//     `nRealFillIsInvariantToTheSeamStamp` both fail if it does; and
//   • a fallback that RE-PRICES a row that already priced — `precedence` pins
//     the fire-tick quote with two deliberately different books on one row, the
//     same negative control `tra4997-exit-quote.test.ts` carries one module over.

import { describe, expect, it } from 'vitest';
import { EXIT_QUOTE_MAX_AGE_MS } from './option-exit-quote.js';
import { priceRealFillRow } from './option-real-fill-r.js';
import {
  buildTapeExpectancyTable,
  tapeExpectancyCellKey,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';
import { type CostGateConfig } from './option-cost-gate.js';
import { type OptionTradeJournalRecord } from './option-trade-journal.js';

const OTM = 'single_leg_otm';
const T0 = 1_700_000_000_000;
const KEY = tapeExpectancyCellKey(OTM, '0.50-0.55');

/** The live bar at the time of filing: 0.0036 + 0.235 + 0.10 = 0.3386R. */
const BAR: CostGateConfig = {
  optionsCost: { commissionR: 0.0036, makerAdjustedSpreadCrossR: 0.235 },
  equityCost: { commissionR: 0, makerAdjustedSpreadCrossR: 0.02 },
  safetyMarginR: 0.1,
  optionsMinGrossR: 0.3,
};

/**
 * A synthetic CLOSED broker-fill row, rigged so the arithmetic is legible:
 * `contracts: 1`, `entryFillPremium: 1.00` ⇒ denominator 100, so
 * `rFillNet = 4·netPnlUsd/100 = netPnlUsd/25`.
 *
 * `fireBid`/`seamBid` are the two exit books, independently settable, and
 * deliberately DIFFERENT in the precedence control: the exit cross is
 * `(exitFillPremium − bid)·100`, so each book produces its own `rFillNet` and
 * "which book priced this" is readable off the number itself, not just off the
 * provenance field that is also asserted.
 */
function row(opts: {
  fireBid?: number | null;
  seamBid?: number | null;
  seamAgeMs?: number | null;
  realizedPnlUsd?: number;
  exitFillPremium?: number;
  brokerFill?: boolean;
  realizedR?: number;
  delta?: number;
}): OptionTradeJournalRecord {
  const exitFillPremium = opts.exitFillPremium ?? 0.8;
  const fireBid = opts.fireBid ?? null;
  const seamBid = opts.seamBid ?? null;
  const brokerFill = opts.brokerFill ?? true;
  return {
    structure: OTM,
    outcome: 'WIN',
    entryDelta: opts.delta ?? 0.52,
    realizedR: opts.realizedR ?? -0.3,
    closeTs: T0,
    mode: 'live',
    contracts: 1,
    ...(brokerFill
      ? {
          pnlBasis: 'broker-fill',
          feesUsd: 0.65,
          entryFillPremium: 1.0,
          exitFillPremium,
          realizedPnlUsd: opts.realizedPnlUsd ?? -20,
        }
      : {}),
    ...(fireBid === null
      ? {}
      : {
          markProvenance: {
            markSource: 'quote',
            staleMarkTicks: 0,
            at: T0,
            quoteAtFire: { bid: fireBid, ask: fireBid + 0.05 },
          },
        }),
    ...(seamBid === null
      ? {}
      : {
          exitQuote: {
            bid: seamBid,
            ask: seamBid + 0.05,
            source: 'last_known',
            at: T0 - 1_000,
            // `null` models a stamp whose own age is unreadable, which the
            // resolver treats as stale rather than as young.
            ...(opts.seamAgeMs === null ? {} : { ageMs: opts.seamAgeMs ?? 1_000 }),
          },
        }),
  } as unknown as OptionTradeJournalRecord;
}

function cellOf(
  rows: OptionTradeJournalRecord[],
  minCellRealFillN?: number,
): TapeExpectancyCell {
  const t = buildTapeExpectancyTable(rows, {
    windowDays: null,
    nowMs: T0,
    config: BAR,
    ...(minCellRealFillN === undefined ? {} : { minCellRealFillN }),
  });
  const found = t.cells.find((c) => c.cellKey === KEY);
  if (!found) throw new Error(`no ${KEY} in [${t.cells.map((c) => c.cellKey).join(', ')}]`);
  return found;
}

describe('TRA-5040 — the close-seam exit quote, as an opt-in on the pricer', () => {
  it('default OFF: a row with a usable seam quote and no fire quote still drops exit_quote_missing', () => {
    const r = row({ fireBid: null, seamBid: 0.7 });
    const p = priceRealFillRow(r as never);
    expect(p.unpriced).toBe('exit_quote_missing');
    expect(p.rFillNet).toBeNull();
    expect(p.exitQuoteSource).toBeNull();
    // The shipped call site passes no opts at all — same result, byte for byte.
    expect(priceRealFillRow(r as never, {})).toEqual(p);
  });

  it('fallback ON: the same row prices off the seam book, and says so', () => {
    const p = priceRealFillRow(row({ fireBid: null, seamBid: 0.7 }) as never, {
      seamQuoteFallback: true,
    });
    expect(p.unpriced).toBeNull();
    expect(p.exitQuoteSource).toBe('last_known');
    // cross = (0.80 − 0.70)·100 = $10 ⇒ net = −20 − 10 = −$30 ⇒ R = −30/25.
    expect(p.exitCrossUsd).toBeCloseTo(10, 10);
    expect(p.netPnlUsd).toBeCloseTo(-30, 10);
    expect(p.rFillNet).toBeCloseTo(-1.2, 10);
  });

  it('precedence: a row carrying BOTH books prices off the fire tick, and the fallback cannot move it', () => {
    const r = row({ fireBid: 0.6, seamBid: 0.7 });
    const off = priceRealFillRow(r as never);
    const on = priceRealFillRow(r as never, { seamQuoteFallback: true });
    // fire bid 0.60 ⇒ cross $20 ⇒ net −$40 ⇒ −1.6; the seam book would read −1.2,
    // so this assertion fails if the precedence is ever reordered.
    expect(off.rFillNet).toBeCloseTo(-1.6, 10);
    expect(on).toEqual(off);
    expect(on.exitQuoteSource).toBe('fire_tick');
  });

  it('a seam quote past EXIT_QUOTE_MAX_AGE_MS reads exit_quote_stale, not missing and not priced', () => {
    const p = priceRealFillRow(
      row({ fireBid: null, seamBid: 0.7, seamAgeMs: EXIT_QUOTE_MAX_AGE_MS + 1 }) as never,
      { seamQuoteFallback: true },
    );
    expect(p.unpriced).toBe('exit_quote_stale');
    expect(p.rFillNet).toBeNull();
    // Boundary, the other side: exactly at the bound is still usable, so the
    // refusal is `>` and not `>=`.
    const at = priceRealFillRow(
      row({ fireBid: null, seamBid: 0.7, seamAgeMs: EXIT_QUOTE_MAX_AGE_MS }) as never,
      { seamQuoteFallback: true },
    );
    expect(at.unpriced).toBeNull();
  });

  it('a seam quote whose own age is unreadable is stale, never assumed fresh', () => {
    const p = priceRealFillRow(row({ fireBid: null, seamBid: 0.7, seamAgeMs: null }) as never, {
      seamQuoteFallback: true,
    });
    expect(p.unpriced).toBe('exit_quote_stale');
  });

  it('the basis stamp still decides first: a mid-booked row with a seam quote reads not_broker_fill', () => {
    const p = priceRealFillRow(
      row({ fireBid: null, seamBid: 0.7, brokerFill: false }) as never,
      { seamQuoteFallback: true },
    );
    expect(p.unpriced).toBe('not_broker_fill');
  });
});

describe('TRA-5040 — the fold publishes the recovery as a shadow and decides nothing with it', () => {
  const priced = row({ fireBid: 0.75, realizedR: -0.3 });
  const seamOnly = [
    row({ fireBid: null, seamBid: 0.7, realizedR: -0.2 }),
    row({ fireBid: null, seamBid: 0.7, realizedR: -0.1 }),
    row({ fireBid: null, seamBid: 0.7, realizedR: 0.1 }),
  ];
  const seamStale = row({
    fireBid: null,
    seamBid: 0.7,
    seamAgeMs: EXIT_QUOTE_MAX_AGE_MS + 1,
    realizedR: 0.2,
  });

  it('counts the recoverable rows, holds the stale one apart, and leaves nRealFill where it was', () => {
    const c = cellOf([priced, ...seamOnly, seamStale]);
    expect(c.n).toBe(5);
    expect(c.nRealFill).toBe(1);
    expect(c.realFillSeamRecovered).toBe(3);
    expect(c.realFillSeamStale).toBe(1);
    expect(c.nRealFillSeamShadow).toBe(4);
    expect(c.realFillUnavailableReason).toContain('TRA-5040 seam-quote shadow: +3 recoverable (1 stale)');
  });

  it('nRealFill and the real-fill bound are INVARIANT to the seam stamp — strip it and nothing in the decision moves', () => {
    const withStamp = cellOf([priced, ...seamOnly]);
    const withoutStamp = cellOf([
      priced,
      ...seamOnly.map((r) => {
        const { exitQuote: _dropped, ...rest } = r as unknown as Record<string, unknown>;
        return rest as unknown as OptionTradeJournalRecord;
      }),
    ]);
    expect(withStamp.nRealFill).toBe(withoutStamp.nRealFill);
    expect(withStamp.loRealFillNet).toBe(withoutStamp.loRealFillNet);
    expect(withStamp.admitsRealFill).toBe(withoutStamp.admitsRealFill);
    expect(withStamp.admits).toBe(withoutStamp.admits);
    expect(withStamp.meanR_gate).toBe(withoutStamp.meanR_gate);
    // …and the ONLY difference is the shadow trio.
    expect(withStamp.realFillSeamRecovered).toBe(3);
    expect(withoutStamp.realFillSeamRecovered).toBe(0);
  });

  it('a shadow that CROSSES the real-fill floor still promotes nothing — the load-bearing control', () => {
    // Floor of 2: nRealFill=1 is below it, the shadow's 4 is above it.
    const c = cellOf([priced, ...seamOnly], 2);
    expect(c.nRealFill).toBe(1);
    expect(c.nRealFillSeamShadow).toBeGreaterThanOrEqual(2);
    expect(c.admitsRealFill).toBe(false);
    expect(c.admits).toBe(false);
    expect(c.realFillUnavailableReason).toContain('nRealFill=1');
    expect(c.realFillUnavailableReason).toContain('NOT counted in the decision');
  });

  it('a cell whose misses are all not_broker_fill publishes a MEASURED zero recovery, not an absence', () => {
    const c = cellOf([priced, row({ fireBid: 0.7, brokerFill: false, realizedR: 0.4 })]);
    expect(c.realFillSeamRecovered).toBe(0);
    expect(c.nRealFillSeamShadow).toBe(c.nRealFill);
    expect(c.realFillUnavailableReason).toContain('seam-quote shadow: +0 recoverable');
  });
});
