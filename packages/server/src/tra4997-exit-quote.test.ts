import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import {
  EXIT_QUOTE_MAX_AGE_MS,
  exitQuoteCrossUsd,
  isUsableQuote,
  resolveExitQuote,
} from './option-exit-quote.js';
import {
  foldCrossedCells,
  foldSpreadCells,
  priceCrossedRow,
  type CrossedPricingRow,
} from './option-crossed-pnl.js';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  summarizeOptionTradeJournal,
} from './option-trade-journal.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

/**
 * TRA-4997 — THE EXIT-SIDE QUOTE IS CAPTURED ON EVERY CLOSE PATH.
 *
 * ## What was broken, measured
 *
 * `/api/health/option-journal?rows=demo` on bqb1 serving `571b38dc`,
 * 2026-10-01T18:39Z: `summary.crossed.priced` **58 of 3,541** resolved rows
 * (1.6%), `unpricedReasons = { contracts_unknown: 2146, exit_quote_missing:
 * 1310, structure_not_crossable: 27 }`, and `summary.slippage.exitSampled`
 * **0** with `avgExitSlippageR` / `avgRoundTripCostR` both `null`.
 *
 * Censused by era and account class off that same read, the 1,310 split cleanly
 * and the split is what this file is built on:
 *
 *   • **1,060** closed BEFORE the TRA-4055 mark stamp shipped (first priced row
 *     is `closeEtDay 2026-08-28`) ⇒ historical, forward-unfixable, ⛔ never
 *     backfilled.
 *   • **228** closed after it and still unpriced — and of those, **189 (83%)
 *     were `book_halt_flat`**, a path that routes through `closeOption`,
 *     evaluates no mark, and therefore stamped no provenance AT ALL. The other
 *     39 were genuine cascade fires (`sl` 27, `profit_lock` 5, `chandelier` 3,
 *     `take_profit_early` 2, `ma20_close_through` 2) on a tick whose
 *     `getOptionQuoteDetail` came back `one_sided` / `absent` / `breaker_open`.
 *
 * So the answer to the ticket's question — "is this purely historical backfill
 * or does a live write path still omit it" — is **a live path still omits it**,
 * and the proof is in the newest 20 closes: 6 of them (09-09 NVTS + PFE, 09-11
 * NOK + SIRI, 09-18 SOFI, 09-22 TLT) carry `exit_quote_missing` under exit
 * reasons that priced fine on their own same-week neighbours.
 *
 * ## The two things that must stay true
 *
 *   1. **No row that already priced may price differently.** The fire-tick
 *      quote wins unconditionally; the stamp is a fallback only.
 *   2. **The fallback is counted, not hidden.** `last_known` coverage is a
 *      weaker measurement than `fire_tick` coverage and nothing in
 *      `crossedPnlUsd` says which you are holding.
 */

const T = 1_760_000_000_000;

/** A long single-leg row reduced to the fields the crossed pricing reads. */
function longRow(over: Partial<CrossedPricingRow> = {}): CrossedPricingRow {
  return {
    outcome: 'LOSS',
    structure: 'single_leg_otm',
    contracts: 2,
    atRiskUsd: 200,
    realizedPnlUsd: -40,
    entryBidAtOpen: 0.95,
    entryAskAtOpen: 1.05,
    ...over,
  };
}

describe('TRA-4997 resolveExitQuote', () => {
  it('prefers the FIRE-TICK quote over the last-known one, always', () => {
    const got = resolveExitQuote({
      closeTs: T,
      fireQuote: { bid: 0.8, ask: 0.9 },
      fireQuoteAt: T - 1_000,
      lastUsableQuote: { bid: 0.2, ask: 0.3, at: T - 2_000 },
    });
    expect(got).toEqual({ bid: 0.8, ask: 0.9, source: 'fire_tick', at: T - 1_000, ageMs: 1_000 });
  });

  it('falls back to the last-known book when the closing path evaluated no quote', () => {
    // The `book_halt_flat` shape: no provenance at all, but the tick's own quote
    // fan ran seconds earlier.
    const got = resolveExitQuote({
      closeTs: T,
      fireQuote: null,
      lastUsableQuote: { bid: 0.46, ask: 0.52, at: T - 3_000 },
    });
    expect(got).toEqual({ bid: 0.46, ask: 0.52, source: 'last_known', at: T - 3_000, ageMs: 3_000 });
  });

  it('returns null — never a zero-filled stamp — when neither side carries a book', () => {
    expect(resolveExitQuote({ closeTs: T })).toBeNull();
    expect(resolveExitQuote({ closeTs: T, fireQuote: null, lastUsableQuote: null })).toBeNull();
  });

  it('refuses an unusable book on either side rather than stamping it', () => {
    // Crossed, ask-less, and non-finite books are not books. Same predicate as
    // `liveQuoteFor` — a half-empty or crossed order book falls to no stamp.
    expect(isUsableQuote({ bid: 0.9, ask: 0.8 })).toBe(false);
    expect(isUsableQuote({ bid: 0.5, ask: 0 })).toBe(false);
    expect(isUsableQuote({ bid: Number.NaN, ask: 0.5 })).toBe(false);
    // `bid: 0` IS usable — a real, unsellable book. The pricer rejects it on the
    // transacting side as `exit_quote_unusable`, which is a different fact from
    // "no quote was captured" and must not be collapsed into it.
    expect(isUsableQuote({ bid: 0, ask: 0.05 })).toBe(true);
    expect(resolveExitQuote({ closeTs: T, fireQuote: { bid: 0.9, ask: 0.8 } })).toBeNull();
    expect(
      resolveExitQuote({ closeTs: T, fireQuote: { bid: 0.9, ask: 0.8 }, lastUsableQuote: { bid: 0.4, ask: 0.5, at: T } }),
    ).toEqual({ bid: 0.4, ask: 0.5, source: 'last_known', at: T, ageMs: 0 });
  });

  it('floors ageMs at 0 so a clock that ran backwards cannot publish a negative age', () => {
    const got = resolveExitQuote({ closeTs: T, fireQuote: { bid: 1, ask: 1.1 }, fireQuoteAt: T + 5_000 });
    expect(got?.ageMs).toBe(0);
  });
});

describe('TRA-4997 exitQuoteCrossUsd', () => {
  it('is the measured half-spread in dollars, positive = cost', () => {
    // (0.52 − 0.46) / 2 × 2 contracts × 100 = $6.00
    expect(exitQuoteCrossUsd({ bid: 0.46, ask: 0.52 }, 2)).toBe(6);
    expect(exitQuoteCrossUsd({ bid: 1.0, ask: 1.1 }, 1)).toBe(5);
  });

  it('distinguishes a zero-width book (0) from a missing one (null)', () => {
    // ⛔ THE discrimination this whole ticket is about. `exitSampled` was 0 not
    // because the book was tight but because nothing measured it; a measurement
    // that returns 0 for both is the bug, not the fix.
    expect(exitQuoteCrossUsd({ bid: 0.5, ask: 0.5 }, 3)).toBe(0);
    expect(exitQuoteCrossUsd({ bid: 0.9, ask: 0.8 }, 3)).toBeNull();
    expect(exitQuoteCrossUsd({ bid: 0.4, ask: 0.5 }, 0)).toBeNull();
    expect(exitQuoteCrossUsd({ bid: 0.4, ask: 0.5 }, Number.NaN)).toBeNull();
  });
});

describe('TRA-4997 priceCrossedRow — the fallback adds coverage and nothing else', () => {
  it('⛔ NEGATIVE CONTROL: a row with a fire-tick quote ignores the stamp entirely', () => {
    // Both present, deliberately DIFFERENT prices. If the precedence is ever
    // reordered this assertion is what goes red — and with it the guarantee
    // that no already-priced row's crossed number moved.
    const row = longRow({
      markProvenance: { quoteAtFire: { bid: 0.8, ask: 0.9 }, at: T },
      exitQuote: { bid: 0.1, ask: 0.2, source: 'last_known', at: T - 1_000, ageMs: 1_000 },
    });
    const p = priceCrossedRow(row);
    // (0.80 − 1.05) × 100 × 2 = −$50.00 — the fire-tick number, not −$190.
    expect(p.crossedPnlUsd).toBe(-50);
    expect(p.crossedExitQuoteSource).toBe('fire_tick');
    expect(p.crossedExitQuoteAgeMs).toBeNull();
  });

  it('prices the book_halt_flat shape that used to read exit_quote_missing', () => {
    const before = priceCrossedRow(longRow({ markProvenance: { quoteAtFire: null, at: T } }));
    expect(before.crossedPnlUsd).toBeNull();
    expect(before.crossedUnpriced).toBe('exit_quote_missing');

    const after = priceCrossedRow(
      longRow({
        markProvenance: { quoteAtFire: null, at: T },
        exitQuote: { bid: 0.46, ask: 0.52, source: 'last_known', at: T - 3_000, ageMs: 3_000 },
      }),
    );
    // (0.46 − 1.05) × 100 × 2 = −$118.00
    expect(after.crossedPnlUsd).toBe(-118);
    expect(after.crossedR).toBe(-0.59);
    expect(after.crossedUnpriced).toBeNull();
    expect(after.crossedExitQuoteSource).toBe('last_known');
    expect(after.crossedExitQuoteAgeMs).toBe(3_000);
  });

  it('refuses a stale stamp under its OWN reason, not exit_quote_missing', () => {
    // "we have a book and it is too old" and "we never had a book" license
    // different conclusions. One bucket for both is how a coverage gap reads as
    // a feed outage.
    const p = priceCrossedRow(
      longRow({
        exitQuote: {
          bid: 0.46,
          ask: 0.52,
          source: 'last_known',
          at: T - EXIT_QUOTE_MAX_AGE_MS - 1,
          ageMs: EXIT_QUOTE_MAX_AGE_MS + 1,
        },
      }),
    );
    expect(p.crossedPnlUsd).toBeNull();
    expect(p.crossedUnpriced).toBe('exit_quote_stale');
    // ...and the boundary itself is INSIDE the bound.
    const atBound = priceCrossedRow(
      longRow({
        exitQuote: { bid: 0.46, ask: 0.52, source: 'last_known', at: T, ageMs: EXIT_QUOTE_MAX_AGE_MS },
      }),
    );
    expect(atBound.crossedUnpriced).toBeNull();
  });

  it('treats a stamp with an unreadable age as stale, never as fresh', () => {
    const p = priceCrossedRow(
      longRow({
        exitQuote: { bid: 0.46, ask: 0.52, source: 'last_known', at: T, ageMs: Number.NaN },
      }),
    );
    expect(p.crossedUnpriced).toBe('exit_quote_stale');
  });

  it('a stamped bid of 0 on a long reads exit_quote_unusable, not missing', () => {
    const p = priceCrossedRow(
      longRow({ exitQuote: { bid: 0, ask: 0.05, source: 'last_known', at: T, ageMs: 500 } }),
    );
    expect(p.crossedUnpriced).toBe('exit_quote_unusable');
  });

  it('⛔ forward-only: the six live post-stamp misses stay unpriced without a stamp', () => {
    // 2026-09-09 NVTS/PFE, 09-11 NOK/SIRI, 09-18 SOFI, 09-22 TLT — cascade
    // fires whose tick served no usable quote, read live 2026-10-01. They
    // predate this writer, carry no `exitQuote`, and are NOT retroactively
    // priceable. ⛔ A reconstructed book is a fabricated column.
    for (const r of [
      longRow({ structure: 'single_leg_directional', markProvenance: { quoteAtFire: null, at: T } }),
      longRow({ structure: 'single_leg_directional' }),
    ]) {
      expect(priceCrossedRow(r).crossedUnpriced).toBe('exit_quote_missing');
    }
  });
});

describe('TRA-4997 foldCrossedCells — the fallback ships a counter', () => {
  const fireRow = longRow({ markProvenance: { quoteAtFire: { bid: 0.8, ask: 0.9 }, at: T } });
  const stampRow = longRow({
    exitQuote: { bid: 0.46, ask: 0.52, source: 'last_known', at: T - 4_000, ageMs: 4_000 },
  });
  const stampRow2 = longRow({
    exitQuote: { bid: 0.5, ask: 0.56, source: 'last_known', at: T - 8_000, ageMs: 8_000 },
  });
  const blindRow = longRow();

  it('partitions coverage by which book priced it, exhaustively', () => {
    const f = foldCrossedCells([fireRow, stampRow, stampRow2, blindRow]);
    expect(f.priced).toBe(3);
    expect(f.pricedByFireTickQuote).toBe(1);
    expect(f.pricedByLastKnownQuote).toBe(2);
    // The invariant: the partition is exhaustive over `priced`.
    expect(f.pricedByFireTickQuote + f.pricedByLastKnownQuote).toBe(f.priced);
    expect(f.unpriced).toBe(1);
    expect(f.unpricedReasons).toEqual({ exit_quote_missing: 1 });
    expect(f.lastKnownQuoteMeanAgeMs).toBe(6_000);
  });

  it('⛔ reports a null mean age when nothing used the fallback — never 0', () => {
    const f = foldCrossedCells([fireRow, blindRow]);
    expect(f.pricedByLastKnownQuote).toBe(0);
    // An unmeasured age reading 0 would say "every fallback resolved inside the
    // closing tick", which is a claim about rows that do not exist.
    expect(f.lastKnownQuoteMeanAgeMs).toBeNull();
  });

  it('keeps crossedPnlUsd and bookedPnlUsdPriced a MATCHED fold over the wider sample', () => {
    const f = foldCrossedCells([fireRow, stampRow, blindRow]);
    // fire: (0.80 − 1.05) × 200 = −50; stamp: (0.46 − 1.05) × 200 = −118.
    expect(f.crossedPnlUsd).toBe(-168);
    // Booked is summed over the SAME two rows, never the blind third.
    expect(f.bookedPnlUsdPriced).toBe(-80);
    expect(f.spreadDragUsd).toBe(-88);
  });
});

describe('TRA-4997 foldSpreadCells', () => {
  it('measures the exit spread over the same rows the cross priced', () => {
    // Before TRA-4997 this row contributed nothing to `spreads.exit` — which is
    // the other half of why `avgRoundTripCostR` read null.
    const f = foldSpreadCells([
      longRow({ exitQuote: { bid: 0.46, ask: 0.52, source: 'last_known', at: T, ageMs: 1_000 } }),
      longRow(),
    ]);
    expect(f.exit.sampled).toBe(1);
    // (0.52 − 0.46) / 0.49 = 0.12244…
    expect(f.exit.mean).toBeCloseTo(0.12245, 5);
  });
});

// ── THE WRITE PATH ──────────────────────────────────────────────────────────
// Everything above grades the READER. The defect was in the WRITER, and a
// reader test cannot see it: the fallback is dead code until a close path
// actually stamps a book. These drive `PaperOptionsAccount` end to end and
// assert the journal CLOSE ROW — the surface
// `/api/health/option-journal?rows=all` serves.

const OPEN_TS = Date.parse('2024-06-05T15:00:00.000Z'); // 11:00 ET, Wednesday
const SPOT = 200;
const QUOTE = { bid: 0.46, ask: 0.52 };

function otmSignal(): OtmMispricingSignal {
  return {
    id: 'sig-otm-4997',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: OPEN_TS,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
    // The TRA-3990 / TRA-1656 entry-quote snapshot. Without it the row cannot
    // price on the ENTRY side either, and the fixture would grade
    // `entry_quote_missing` no matter what the exit stamp did — a control that
    // agrees with itself.
    bid: 0.95,
    ask: 1.05,
  };
}

const JOURNAL_SETUP = {
  ivRank: 50,
  trend: 'down' as const,
  sentiment: 0,
  sentimentIcBand: null,
  agentConviction: 0.5,
  entryDelta: 0.18,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: null,
};

describe('TRA-4997 the write path — closeOption stamps the exit book', () => {
  let tmpFile: string;
  let counter = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(OPEN_TS);
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra4997-journal-${process.pid}-${counter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  const openRow = () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(otmSignal(), 'demo', 50_000, SPOT, JOURNAL_SETUP);
    expect(pos).not.toBeNull();
    return { acct, pos: pos!, sym: pos!.optionSymbol! };
  };

  it('THE INCIDENT SHAPE: a book_halt_flat close now carries exitQuote + a measured cross', async () => {
    const { acct, sym } = openRow();
    // The quote fan runs every engine tick, above the exit pass. This is what
    // ratchets `lastUsableQuote` onto the open row.
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    // …and 4 s later the give-back halt flattens the book. `closeOption`
    // evaluates no mark, so `markProvenance` is — correctly — still absent.
    vi.setSystemTime(OPEN_TS + 4_000);
    const closed = acct.closeOption(acct.getState().openOptions[0]!.id, undefined, 'book_halt_flat');
    expect(closed).not.toBeNull();
    expect(closed!.exitMarkProvenance).toBeUndefined();

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exitReason).toBe('book_halt_flat');
    // ⛔ The TRA-4055 column is UNCHANGED — its absence still means "this path
    // evaluated no mark". That is why the stamp is a separate field.
    expect(rows[0]!.markProvenance).toBeUndefined();
    expect(rows[0]!.exitQuote).toEqual({
      bid: 0.46,
      ask: 0.52,
      source: 'last_known',
      at: OPEN_TS,
      ageMs: 4_000,
    });
    // ((0.52 − 0.46) / 2) × contracts × 100, positive = cost.
    const contracts = rows[0]!.contracts!;
    expect(rows[0]!.exitSlippageUsd).toBeCloseTo(0.03 * contracts * 100, 6);
    expect(rows[0]!.exitSlippageBasis).toBe('quote_cross');

    // …and the row is now priceable at the cross and SAMPLED for exit slippage —
    // the two cells the acceptance names.
    const summary = summarizeOptionTradeJournal(rows);
    expect(summary.crossed.priced).toBe(1);
    expect(summary.crossed.pricedByLastKnownQuote).toBe(1);
    expect(summary.crossed.lastKnownQuoteMeanAgeMs).toBe(4_000);
    expect(summary.crossed.unpricedReasons).toEqual({});
    expect(summary.slippage.exitSampled).toBe(1);
    expect(summary.slippage.avgExitSlippageR).not.toBeNull();
    expect(summary.slippage.roundTripSampled).toBe(1);
    expect(summary.slippage.avgRoundTripCostR).not.toBeNull();
  });

  it('⛔ NEGATIVE CONTROL: a tick that served NO book stamps nothing at all', async () => {
    const { acct } = openRow();
    // No `refreshOptionQuotes` ever — the `no_capability` / `breaker_open` world.
    vi.setSystemTime(OPEN_TS + 4_000);
    expect(acct.closeOption(acct.getState().openOptions[0]!.id, undefined, 'book_halt_flat')).not.toBeNull();
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    // ⛔ Absent, not zero-filled. A `{bid:0, ask:0}` stamp here would publish a
    // zero-width book and a $0.00 exit cost on a row nobody measured — the exact
    // reading this ticket exists to kill.
    expect(rows[0]!.exitQuote).toBeUndefined();
    expect(rows[0]!.exitSlippageUsd).toBeUndefined();
    expect(rows[0]!.exitSlippageBasis).toBeUndefined();
    const summary = summarizeOptionTradeJournal(rows);
    expect(summary.crossed.priced).toBe(0);
    expect(summary.crossed.unpricedReasons).toEqual({ exit_quote_missing: 1 });
    expect(summary.slippage.exitSampled).toBe(0);
    expect(summary.slippage.avgExitSlippageR).toBeNull();
  });

  it('⛔ a quote fan AFTER the close cannot be stamped onto it (the async-drain trap)', async () => {
    const { acct, sym } = openRow();
    const id = acct.getState().openOptions[0]!.id;
    vi.setSystemTime(OPEN_TS + 4_000);
    expect(acct.closeOption(id, undefined, 'manual')).not.toBeNull();
    // A later pass fans a DIFFERENT book while the journal write is still queued.
    // `queueJournalClose` resolved synchronously, so this cannot reach the row.
    vi.setSystemTime(OPEN_TS + 60_000);
    acct.refreshOptionQuotes(new Map([[sym, { bid: 9, ask: 9.5 }]]));
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows[0]!.exitQuote).toBeUndefined();
  });

  it('a stale last-known book is stamped with its true age and refused by the pricer', async () => {
    const { acct, sym } = openRow();
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    // The feed goes dark for well past the measurement bound, then the row is
    // closed manually. The stamp is still written — the AGE is what refuses it,
    // and `exit_quote_stale` is a different verdict from `exit_quote_missing`.
    vi.setSystemTime(OPEN_TS + EXIT_QUOTE_MAX_AGE_MS + 60_000);
    expect(acct.closeOption(acct.getState().openOptions[0]!.id, undefined, 'manual')).not.toBeNull();
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows[0]!.exitQuote).toMatchObject({
      source: 'last_known',
      ageMs: EXIT_QUOTE_MAX_AGE_MS + 60_000,
    });
    const summary = summarizeOptionTradeJournal(rows);
    expect(summary.crossed.priced).toBe(0);
    expect(summary.crossed.unpricedReasons).toEqual({ exit_quote_stale: 1 });
    // The cross is still a real measurement of the book that WAS there, so the
    // slippage cell is written. The two columns answer different questions and
    // are allowed to disagree; `exitSlippageBasis` is what makes that readable.
    expect(rows[0]!.exitSlippageBasis).toBe('quote_cross');
  });
});
