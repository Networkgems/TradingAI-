import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import {
  deriveOptionAdmissionCapUsd,
  isCoherentOptionAdmissionStamp,
  type OptionAdmissionStamp,
  type OtmMispricingSignal,
} from '@trading-app/shared';
import {
  buildOptionAdmissionStamp,
  fitsLiveOtmReachableBound,
  resolveEffectiveFleetRiskFraction,
  resolveLiveOptionTestBookAggregateCapUsd,
  resolveLiveOtmAdmissibleEntryUsd,
  resolveLiveOtmSizingBasisUsd,
} from './option-exec-flag.js';
import { PaperOptionsAccount, type OptionTradeJournalSetup } from './options-account.js';
import {
  listOptionTradeJournal,
  recordOptionTradeOpen,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalOpen,
} from './option-trade-journal.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  hydrateLiveOptionsFeeSlippageFromDisk,
  liveOptionsFeeSlippageLogPath,
  recordLiveOptionFill,
  summarizeLiveOptionAdmissionStamps,
  summarizeLiveOptionsFeeSlippage,
} from './live-options-fee-slippage-ledger.js';

// TRA-3997 (parent TRA-3703) — stamp the order-site ADMISSION reading on the
// option row. Measured 2026-08-25 on bqb1 `07cc4ba43af6`: `v0nni` sat at
// `headroomSignedUsd −0.35` after two fills ten seconds apart, and the tape
// could not say whether the second order was admitted inside its headroom
// because nothing recorded what the order site read.

// ── The 2026-08-25 numbers, as published on `live-options-fee-slippage` ───────
//
//   v0nni  capUsd 186.65  = 0.4858 × 384.22   (cash + atRisk)
//   admin  capUsd 301.78  = 0.4858 × 621.22
//   A = $500 fleet authorization
const PHI = 0.4858;
const A = 500;

/** Reproduce the order site's reading for one book from its raw operands. */
function readingFor(opts: {
  availableCashUsd: number;
  atRiskUsd: number;
  fleetAtRiskUsd: number | null;
  fleetCapitalUsd: number;
  entryNotionalUsd: number;
  at?: number;
}): OptionAdmissionStamp {
  const fleetSizing = resolveEffectiveFleetRiskFraction(PHI, A, opts.fleetCapitalUsd, 2);
  const basis = resolveLiveOtmSizingBasisUsd(opts.availableCashUsd, opts.atRiskUsd);
  const capUsd = resolveLiveOptionTestBookAggregateCapUsd(
    opts.availableCashUsd, opts.atRiskUsd, A, PHI, opts.fleetCapitalUsd,
  );
  const admissible = resolveLiveOtmAdmissibleEntryUsd(
    capUsd, opts.atRiskUsd, A, { fleetAtRiskUsd: opts.fleetAtRiskUsd, books: opts.fleetAtRiskUsd === null ? 0 : 2 },
  );
  return buildOptionAdmissionStamp({
    admissible,
    openPremiumAtRiskUsd: opts.atRiskUsd,
    capUsd,
    phiEff: fleetSizing.phiEffective,
    sizingBasisUsd: basis,
    fleetCapUsd: A,
    entryNotionalUsd: opts.entryNotionalUsd,
    at: opts.at ?? 1_756_133_419_198, // 2026-08-25T14:50:19.198Z
  });
}

// ── AC3 + AC4 — the stamp, built from the order site's own operands ──────────

describe('buildOptionAdmissionStamp (TRA-3997 AC3 + AC4)', () => {
  it('AC3 — `capUsd` is re-derivable from the row alone, on the v0nni numbers', () => {
    // v0nni at 14:50:19Z: the XLF row ($116) is already open, the $71 BULL
    // order is being admitted. cash 268.22 + atRisk 116 = basis 384.22.
    const s = readingFor({
      availableCashUsd: 268.22, atRiskUsd: 116, fleetAtRiskUsd: 116 + 187, fleetCapitalUsd: 384.22 + 621.22,
      entryNotionalUsd: 71,
    });
    expect(s.sizingBasisUsd).toBeCloseTo(384.22, 2);
    expect(s.phiEff).toBeCloseTo(PHI, 6);
    expect(s.capUsd).toBe(186.65); // the published figure, to the cent
    expect(deriveOptionAdmissionCapUsd(s.phiEff, s.sizingBasisUsd, s.fleetCapUsd)).toBe(s.capUsd);
    // The four fields the ask names, all non-null (AC1 shape).
    expect(s.admissibleEntryUsd).toBeCloseTo(70.65, 2);
    expect(s.openPremiumAtRiskUsd).toBe(116);
    expect(s.admissibleBoundBy).toBe('book');
    expect(s.entryNotionalUsd).toBe(71);
    expect(s.admissionSource).toBe('otm_reachable_bound');
    expect(isCoherentOptionAdmissionStamp(s)).toBe(true);
    // And the one comparison the stamp exists to make is now ONE line on the
    // row: $71 against $70.65 — this reading would NOT have admitted the order.
    // (Whether the live site read a larger cap is exactly what the stamp will
    // settle on the NEXT order; today's is out of scope.)
    expect(fitsLiveOtmReachableBound(s.entryNotionalUsd, {
      admissibleUsd: s.admissibleEntryUsd, boundBy: s.admissibleBoundBy,
      bookHeadroomSignedUsd: 0, fleetHeadroomSignedUsd: null, fleetAtRiskUsd: null, fleetAtRiskBooks: 0,
    })).toBe(false);
  });

  it('AC4 — `admissibleBoundBy` DISCRIMINATES: fleet-bound vs book-bound vs unreadable', () => {
    // v0nni flat (atRisk 0, cap ≈ 186) while admin holds $358 ⇒ A − Σ = $142
    // binds before the book's own $186 does.
    const fleet = readingFor({
      availableCashUsd: 384.22, atRiskUsd: 0, fleetAtRiskUsd: 358, fleetCapitalUsd: 384.22 + 621.22,
      entryNotionalUsd: 100,
    });
    expect(fleet.admissibleBoundBy).toBe('fleet_reachable');
    expect(fleet.admissibleEntryUsd).toBe(142);
    expect(fleet.fleetAtRiskUsd).toBe(358);

    // admin-like: cap 301.78, atRisk 187 ⇒ book headroom 114.78 < fleet 126.
    const book = readingFor({
      availableCashUsd: 434.22, atRiskUsd: 187, fleetAtRiskUsd: 187 + 187, fleetCapitalUsd: 384.22 + 621.22,
      entryNotionalUsd: 100,
    });
    expect(book.admissibleBoundBy).toBe('book');
    expect(book.admissibleEntryUsd).toBeCloseTo(114.78, 2);

    // Fleet at-risk unreadable ⇒ per-book only, and the row SAYS so.
    const unreadable = readingFor({
      availableCashUsd: 384.22, atRiskUsd: 0, fleetAtRiskUsd: null, fleetCapitalUsd: 384.22 + 621.22,
      entryNotionalUsd: 100,
    });
    expect(unreadable.admissibleBoundBy).toBe('fleet_unreadable');
    expect(unreadable.fleetAtRiskUsd).toBeNull();

    // Three distinct values from the same builder — not a constant.
    expect(new Set([fleet, book, unreadable].map((s) => s.admissibleBoundBy)).size).toBe(3);
  });

  it('cash unreadable ⇒ basis null, cap 0, `none` — the row records the fail-closed read, not a default', () => {
    const fleetSizing = resolveEffectiveFleetRiskFraction(PHI, A, 1005.44, 2);
    const capUsd = resolveLiveOptionTestBookAggregateCapUsd(null, 0, A, PHI, 1005.44);
    const s = buildOptionAdmissionStamp({
      admissible: resolveLiveOtmAdmissibleEntryUsd(capUsd, 0, A, { fleetAtRiskUsd: 0, books: 2 }),
      openPremiumAtRiskUsd: 0,
      capUsd,
      phiEff: fleetSizing.phiEffective,
      sizingBasisUsd: resolveLiveOtmSizingBasisUsd(null, 0),
      fleetCapUsd: A,
      entryNotionalUsd: 50,
      at: 1,
    });
    expect(s.sizingBasisUsd).toBeNull();
    expect(s.capUsd).toBe(0);
    expect(s.admissibleBoundBy).toBe('none');
    expect(deriveOptionAdmissionCapUsd(s.phiEff, s.sizingBasisUsd, s.fleetCapUsd)).toBeNull();
    expect(isCoherentOptionAdmissionStamp(s)).toBe(true);
  });

  it('coherence refuses a partial / non-finite / off-vocabulary object whole', () => {
    const good = readingFor({ availableCashUsd: 300, atRiskUsd: 0, fleetAtRiskUsd: 0, fleetCapitalUsd: 600, entryNotionalUsd: 50 });
    expect(isCoherentOptionAdmissionStamp(good)).toBe(true);
    expect(isCoherentOptionAdmissionStamp({ ...good, capUsd: NaN })).toBe(false);
    expect(isCoherentOptionAdmissionStamp({ ...good, admissibleBoundBy: 'fleet' })).toBe(false);
    expect(isCoherentOptionAdmissionStamp({ ...good, entryNotionalUsd: 0 })).toBe(false);
    expect(isCoherentOptionAdmissionStamp({ ...good, admissionSource: 'other' })).toBe(false);
    const { phiEff: _omit, ...partial } = good;
    void _omit;
    expect(isCoherentOptionAdmissionStamp(partial)).toBe(false);
    expect(isCoherentOptionAdmissionStamp(null)).toBe(false);
    expect(isCoherentOptionAdmissionStamp(undefined)).toBe(false);
  });
});

// ── AC2 — the row is born with the PRE-order at-risk, and the journal agrees ─

const TRADING_TIME = Date.parse('2026-08-25T14:50:19.198Z');

function buildSignal(over: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-1',
    symbol: 'XLF',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.16,
    stopLoss: 0.87,
    takeProfit: 1.74,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'XLF260930C00058000',
    optionType: 'call',
    strike: 58,
    expiration: '2026-09-30',
    mark: 1.16,
    theo: 1.4,
    mispricingPct: -0.17,
    delta: 0.2,
    bid: 1.14,
    ask: 1.18,
    ...over,
  } as OtmMispricingSignal;
}

function setupWith(admission?: OptionAdmissionStamp): OptionTradeJournalSetup {
  return {
    ivRank: null,
    trend: 'sideways',
    entryDelta: 0.2,
    sentiment: null,
    sentimentIcBand: null,
    agentConviction: null,
    riskThrottleMultiplier: 1,
    riskThrottleDecided: 1,
    riskThrottleSizingPath: null,
    ...(admission ? { admission } : {}),
  };
}

describe('the row and the journal open line carry the PRE-order reading (TRA-3997 AC2)', () => {
  let tmpFile: string;
  let counter = 0;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TRADING_TIME);
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra3997-${process.pid}-${counter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  const settle = () => new Promise<void>((r) => setTimeout(r, 10));

  it('stamped `openPremiumAtRiskUsd` equals the at-risk BEFORE the order, not after; journal row is the same object', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // A live row already open — the XLF fill from 14:50:09Z.
    const first = acct.openOptionFromCandidate(buildSignal(), 'live', undefined, 58, setupWith(), 1);
    expect(first).not.toBeNull();
    const pre = acct.openPremiumAtRiskForMode('live').usd;
    expect(pre).toBe(116);
    // No stamp on a row opened without a reading (RV/directional shape).
    expect(first!.admission).toBeUndefined();

    // The order site's reading for the BULL order, off the pre-order fold.
    const stamp = readingFor({
      availableCashUsd: 268.22, atRiskUsd: pre, fleetAtRiskUsd: pre + 187, fleetCapitalUsd: 1005.44,
      entryNotionalUsd: 71,
    });
    const second = acct.openOptionFromCandidate(
      buildSignal({ id: 'sig-2', symbol: 'BULL', optionSymbol: 'BULL261002C00009000', expiration: '2026-10-02', strike: 9, mark: 0.71, entryPrice: 0.71 }),
      'live', undefined, 9, setupWith(stamp), 1,
    );
    expect(second).not.toBeNull();
    const post = acct.openPremiumAtRiskForMode('live').usd;
    expect(post).toBe(187);

    // AC2 — the row holds the PRE-order fold, not the post-order one.
    expect(second!.admission).toEqual(stamp);
    expect(second!.admission!.openPremiumAtRiskUsd).toBe(pre);
    expect(second!.admission!.openPremiumAtRiskUsd).not.toBe(post);

    // Journal: same object on the `open` line, absent on the unstamped row (AC5).
    await settle();
    const rows = await listOptionTradeJournal();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(second!.id)?.admission).toEqual(stamp);
    expect(byId.get(first!.id)?.admission).toBeUndefined();

    // Reload from disk — the archive-served path — still carries it verbatim.
    setOptionTradeJournalFileForTests(tmpFile);
    const reloaded = await listOptionTradeJournal();
    expect(reloaded.find((r) => r.id === second!.id)?.admission).toEqual(stamp);
    expect(reloaded.find((r) => r.id === first!.id)?.admission).toBeUndefined();

    // Snapshot round-trip (the restart path): structural, so the row keeps it.
    const snap = JSON.parse(JSON.stringify(acct.exportSnapshot()));
    const again = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    again.importSnapshot(snap);
    const restored = again.getState().openOptions.find((o) => o.id === second!.id);
    expect(restored?.admission).toEqual(stamp);
  });

  it('AC5 — a pre-TRA-3997 journal row folds back with NO stamp: absent, never reconstructed', async () => {
    const open: OptionTradeJournalOpen = {
      id: 'pre-cut', openTs: 1, symbol: 'AAPL', structure: 'single_leg_otm', mode: 'live', ivRank: null,
      trend: 'up', sentiment: null, entryDelta: 0.5, entryDte: 40, atRiskUsd: 100,
    };
    await recordOptionTradeOpen(open);
    const rows = await listOptionTradeJournal();
    expect(rows[0].admission).toBeUndefined();
    expect('admission' in rows[0]).toBe(false);
  });
});

// ── AC1 — the fill record carries it; absent rows say WHY ────────────────────

describe('fee/slippage fill record carries the admission reading (TRA-3997 AC1 + AC5)', () => {
  const dirs: string[] = [];
  const freshDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'tra3997-ledger-'));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    clearLiveOptionsFeeSlippageLedger();
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  const base = (over: Record<string, unknown> = {}) => ({
    ts: 1000, etDay: '2026-08-25', sleeve: 'single_leg_otm' as const, book: 'v0nni',
    optionSymbol: 'BULL261002C00009000', side: 'buy_to_open' as const, contracts: 1,
    submittedLimit: 0.71, askAtSubmit: 0.71, midAtSubmit: 0.7, filledPrice: 0.71, fees: null, orderId: 143231531,
    ...over,
  });

  it('a stamped open records the four fields non-null and `admissionReason: null`', () => {
    const stamp = readingFor({ availableCashUsd: 268.22, atRiskUsd: 116, fleetAtRiskUsd: 303, fleetCapitalUsd: 1005.44, entryNotionalUsd: 71 });
    recordLiveOptionFill({ ...base(), admission: stamp });
    const rec = summarizeLiveOptionsFeeSlippage().records[0];
    expect(rec.admission).toEqual(stamp);
    expect(rec.admissionReason).toBeNull();
    for (const k of ['admissibleEntryUsd', 'openPremiumAtRiskUsd', 'capUsd', 'admissibleBoundBy'] as const) {
      expect(rec.admission![k]).not.toBeNull();
    }
    expect(deriveOptionAdmissionCapUsd(rec.admission!.phiEff, rec.admission!.sizingBasisUsd, rec.admission!.fleetCapUsd)).toBe(rec.admission!.capUsd);
  });

  it('a sleeve that never consulted the bound records `not_evaluated_on_path`; no reason at all is `unstamped`; a malformed object is refused whole', () => {
    recordLiveOptionFill({ ...base({ ts: 1 }), admission: null, admissionReason: 'not_evaluated_on_path' });
    recordLiveOptionFill({ ...base({ ts: 2 }) });
    recordLiveOptionFill({ ...base({ ts: 3 }), admission: { capUsd: 100 } as never });
    // The summary serves newest-first; grade in append order.
    const recs = [...summarizeLiveOptionsFeeSlippage().records].sort((a, b) => a.ts - b.ts);
    expect(recs.map((r) => [r.admission, r.admissionReason])).toEqual([
      [null, 'not_evaluated_on_path'],
      [null, 'unstamped'],
      [null, 'malformed_stamp'],
    ]);
    // Both keys PRESENT on every record — absent must keep meaning pre-cut.
    for (const r of recs) {
      expect('admission' in r).toBe(true);
      expect('admissionReason' in r).toBe(true);
    }
  });

  it('hydrate: a pre-cut line reads `unstamped` (BLIND, never back-filled); a stamped line survives verbatim', () => {
    const dir = freshDir();
    const stamp = readingFor({ availableCashUsd: 384.22, atRiskUsd: 0, fleetAtRiskUsd: 358, fleetCapitalUsd: 1005.44, entryNotionalUsd: 100 });
    const preCut = JSON.stringify({
      mode: 'live', ts: 5000, etDay: '2026-08-25', sleeve: 'single_leg_otm', book: 'v0nni',
      optionSymbol: 'XLF260930C00058000', side: 'buy_to_open', contracts: 1,
      submittedLimit: 1.16, askAtSubmit: 1.16, midAtSubmit: 1.15, filledPrice: 1.16,
      fees: null, feeSource: null, slippageVsAsk: 0, slippageVsMid: 0.01, orderId: 143231479, origin: 'fill',
    });
    const stamped = JSON.stringify({
      ...JSON.parse(preCut), ts: 6000, optionSymbol: 'BULL261002C00009000', orderId: 143231531,
      admission: stamp, admissionReason: null,
    });
    const close = JSON.stringify({
      ...JSON.parse(preCut), ts: 7000, side: 'sell_to_close', orderId: 143231600,
    });
    writeFileSync(liveOptionsFeeSlippageLogPath(dir), [preCut, stamped, close].join('\n') + '\n', 'utf8');
    const h = hydrateLiveOptionsFeeSlippageFromDisk(dir, 8000);
    expect(h.records).toBe(3);
    const recs = [...summarizeLiveOptionsFeeSlippage().records].sort((a, b) => a.ts - b.ts);
    expect(recs[0].admission).toBeNull();
    expect(recs[0].admissionReason).toBe('unstamped');
    expect(recs[1].admission).toEqual(stamp);
    expect(recs[1].admissionReason).toBeNull();

    // The census the health route publishes: opens only, discriminating.
    const census = summarizeLiveOptionAdmissionStamps(recs);
    expect(census).toEqual({
      rows: 2,
      stamped: 1,
      byBoundBy: { book: 0, fleet_reachable: 1, both: 0, fleet_unreadable: 0, none: 0 },
      absent: { not_evaluated_on_path: 0, unstamped: 1, malformed_stamp: 0 },
      insideHeadroom: 1,
      lastStampedAt: 6000,
    });
  });

  it('census on an empty tape: 0 everywhere and `lastStampedAt: null` — never-exercised, not clean', () => {
    const census = summarizeLiveOptionAdmissionStamps([]);
    expect(census.rows).toBe(0);
    expect(census.stamped).toBe(0);
    expect(census.lastStampedAt).toBeNull();
  });
});
