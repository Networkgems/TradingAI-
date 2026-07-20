import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import {
  spearman,
  pearson,
  median,
  netOTMflow,
  daysBetween,
  rawForwardReturns,
  deMarket,
  isConfirmed,
  computeIc,
  bucketByQuintile,
  isMonotoneIncreasing,
  isMeasured,
  runSentimentStudy,
  HORIZONS,
  type SentimentSymbolDay,
  type Horizon,
  type DatedBar,
} from './sentiment-ic-harness.js';

function chainRow(over: Partial<OptionChainRow>): OptionChainRow {
  return {
    optionSymbol: 'X',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 100,
    expiration: '2026-02-01',
    volume: 0,
    ...over,
  };
}

function symbolDay(over: Partial<SentimentSymbolDay>): SentimentSymbolDay {
  return {
    date: '2026-01-05',
    symbol: 'AAPL',
    netScore: 0,
    tilt: 'neutral',
    taggedCount: 10,
    curatedCount: 0,
    messageCount: 20,
    freshnessMinutes: 30,
    netOTMflow: null,
    usable: true,
    fwd: { '1d': null, '5d': null, '20d': null },
    ...over,
  };
}

describe('primitive stats', () => {
  it('spearman is 1 for a monotone-increasing relation regardless of scale', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 35, 40])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });
  it('pearson/spearman return null on a zero-variance side', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([5], [5])).toBeNull();
  });
  it('median handles even and odd lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('netOTMflow', () => {
  it('is +1 when only OTM calls trade and −1 when only OTM puts trade', () => {
    const calls = [chainRow({ optionType: 'call', strike: 110, volume: 500 })];
    const puts = [chainRow({ optionType: 'put', strike: 90, volume: 500 })];
    expect(netOTMflow(calls, 100, '2026-01-05')).toBe(1);
    expect(netOTMflow(puts, 100, '2026-01-05')).toBe(-1);
  });
  it('ignores ITM contracts and contracts outside the DTE window', () => {
    const rows = [
      chainRow({ optionType: 'call', strike: 90, volume: 999 }), // ITM call — ignored
      chainRow({ optionType: 'call', strike: 110, volume: 100, expiration: '2026-01-10' }), // ~5 DTE — out of window
      chainRow({ optionType: 'call', strike: 110, volume: 300, expiration: '2026-02-01' }), // ~27 DTE — in window
      chainRow({ optionType: 'put', strike: 90, volume: 100, expiration: '2026-02-01' }),
    ];
    // in-window: calls 300, puts 100 → (300-100)/400 = 0.5
    expect(netOTMflow(rows, 100, '2026-01-05')).toBeCloseTo(0.5, 10);
  });
  it('returns null without a spot or without OTM volume', () => {
    expect(netOTMflow([chainRow({ strike: 110, volume: 100 })], null, '2026-01-05')).toBeNull();
    expect(netOTMflow([], 100, '2026-01-05')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-01-05', '2026-02-01')).toBe(27);
  });
});

describe('forward returns (no look-ahead)', () => {
  const bars: DatedBar[] = [
    { date: '2026-01-05', open: 100, close: 101 }, // t (signal day)
    { date: '2026-01-06', open: 102, close: 103 }, // t+1 (entry open = 102)
    { date: '2026-01-07', open: 104, close: 105 },
    { date: '2026-01-08', open: 106, close: 107 },
    { date: '2026-01-09', open: 108, close: 109 },
    { date: '2026-01-12', open: 110, close: 120 }, // t+5 (exit close = 120)
  ];
  it('enters at t+1 open and exits at the horizon close', () => {
    const out = rawForwardReturns(['2026-01-05'], bars);
    const rec = out.get('2026-01-05')!;
    expect(rec['1d']).toBeCloseTo(103 / 102 - 1, 10); // exit close day t+1
    expect(rec['5d']).toBeCloseTo(120 / 102 - 1, 10); // exit close day t+5
    expect(rec['20d']).toBeNull(); // not enough forward bars
  });
  it('de-markets by subtracting the equal-weight cohort mean', () => {
    const raw = new Map<string, Record<Horizon, number | null>>([
      ['2026-01-05|AAPL', { '1d': 0.04, '5d': null, '20d': null }],
      ['2026-01-05|MSFT', { '1d': 0.02, '5d': null, '20d': null }],
    ]);
    const adj = deMarket(raw);
    // cohort mean = 0.03 → AAPL +0.01, MSFT -0.01
    expect(adj.get('2026-01-05|AAPL')!['1d']).toBeCloseTo(0.01, 10);
    expect(adj.get('2026-01-05|MSFT')!['1d']).toBeCloseTo(-0.01, 10);
  });
});

describe('isConfirmed (S2 subset)', () => {
  it('requires same-sign netScore/flow above both floors', () => {
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: 0.3 }))).toBe(true);
    expect(isConfirmed(symbolDay({ netScore: -0.4, netOTMflow: -0.3 }))).toBe(true);
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: -0.3 }))).toBe(false); // disagree
    expect(isConfirmed(symbolDay({ netScore: 0.1, netOTMflow: 0.3 }))).toBe(false); // netScore below floor
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: 0.05 }))).toBe(false); // flow below floor
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: null }))).toBe(false); // no chain
  });
});

describe('computeIc', () => {
  it('recovers a strong positive cross-sectional relation', () => {
    // One day, 5 symbols where higher netScore ⇒ higher forward return.
    const days: SentimentSymbolDay[] = [0.1, 0.2, 0.3, 0.4, 0.5].map((s, i) =>
      symbolDay({
        symbol: `S${i}`,
        netScore: s,
        fwd: { '1d': s * 0.1, '5d': null, '20d': null },
      }),
    );
    const ic = computeIc(days);
    expect(ic['1d'].nDays).toBe(1);
    expect(ic['1d'].meanIC).toBeCloseTo(1, 10);
    expect(ic['1d'].pooledIC).toBeCloseTo(1, 10);
  });
  it('skips days narrower than the minimum cross-section', () => {
    const days = [
      symbolDay({ symbol: 'A', netScore: 0.1, fwd: { '1d': 0.01, '5d': null, '20d': null } }),
      symbolDay({ symbol: 'B', netScore: 0.2, fwd: { '1d': 0.02, '5d': null, '20d': null } }),
    ];
    expect(computeIc(days)['1d'].nDays).toBe(0);
  });
});

describe('bucketByQuintile + monotonicity', () => {
  it('produces 5 ascending-mean buckets for a monotone signal', () => {
    const days: SentimentSymbolDay[] = [];
    for (let i = 0; i < 50; i++) {
      const s = i / 50;
      days.push(symbolDay({ symbol: `S${i}`, netScore: s, fwd: { '1d': s, '5d': null, '20d': null } }));
    }
    const buckets = bucketByQuintile(days, '1d');
    expect(buckets).toHaveLength(5);
    expect(isMonotoneIncreasing(buckets)).toBe(true);
  });
});

describe('runSentimentStudy + §4 gate', () => {
  it('returns PENDING_FLOW on an empty sample (0 chain-days dominates; never a spurious FAIL)', () => {
    // TRA-1182: with no flow data captured the gate cannot be FAIL; an empty
    // sample is the degenerate case of "S2 unmeasured" + S1 below the bar.
    const report = runSentimentStudy([]);
    expect(report.verdict).toBe('PENDING_FLOW');
    expect(report.sample.nTradingDays).toBe(0);
    expect(report.sample.nChainDays).toBe(0);
    expect(report.verdictReasons[0]).toMatch(/S2 \(flow-confirmed\) unmeasured/);
    expect(report.verdictReasons.join(' ')).toMatch(/S1 \(sentiment-alone\).*INCONCLUSIVE/);
  });

  it('counts usable vs buzz-only cohorts and never throws on a thin real-ish sample', () => {
    const days: SentimentSymbolDay[] = [
      symbolDay({ symbol: 'AAPL', taggedCount: 10, usable: true, fwd: { '1d': 0.01, '5d': null, '20d': null } }),
      symbolDay({ symbol: 'MSFT', taggedCount: 2, usable: false, fwd: { '1d': 0.02, '5d': null, '20d': null } }),
    ];
    const report = runSentimentStudy(days);
    expect(report.sample.nUsableSymbolDays).toBe(1);
    expect(report.sample.nBuzzOnlySymbolDays).toBe(1);
    expect(report.verdict).toBe('PENDING_FLOW'); // 0 chain-days ⇒ S2 unmeasured (TRA-1182)
  });
});

// ── TRA-1182: S1-only safe grading so the gate can't spuriously FAIL on absent flow ──
describe('TRA-1182 — flow-coverage guard (PENDING_FLOW vs spurious FAIL)', () => {
  /**
   * Build a sample that clears the §4 bar (≥20 trading days, ≥300 usable
   * symbol-days). `flow` controls whether option-chain (S2) data is present.
   */
  function bulkDays(opts: {
    nDays: number;
    nSymbols: number;
    netScore: (sym: number, day: number) => number;
    fwd: (sym: number, day: number) => number | null;
    flow?: (sym: number, day: number) => number | null;
    taggedCount?: number;
    freshnessMinutes?: number;
  }): SentimentSymbolDay[] {
    const out: SentimentSymbolDay[] = [];
    for (let d = 0; d < opts.nDays; d++) {
      // Real rolling dates so a 60-day sample doesn't produce `2026-03-61`.
      const date = new Date(Date.UTC(2026, 2, 1) + d * 86_400_000).toISOString().slice(0, 10);
      for (let s = 0; s < opts.nSymbols; s++) {
        const f = opts.fwd(s, d);
        out.push(
          symbolDay({
            date,
            symbol: `S${s}`,
            netScore: opts.netScore(s, d),
            netOTMflow: opts.flow ? opts.flow(s, d) : null,
            taggedCount: opts.taggedCount ?? 10,
            freshnessMinutes: opts.freshnessMinutes ?? 30,
            usable: true,
            fwd: { '1d': f, '5d': f, '20d': f },
          }),
        );
      }
    }
    return out;
  }

  it('returns PENDING_FLOW (not FAIL) when the sample bar is met but 0 chain-days are captured', () => {
    // Bar met (20 × 16 = 320 usable, 20 trading days), S1 dead (flat fwd), NO flow.
    const days = bulkDays({
      nDays: 20,
      nSymbols: 16,
      netScore: (s) => (s + 1) / 16,
      fwd: () => 0.01, // zero cross-sectional variance ⇒ dead IC
      // no flow ⇒ 0 chain-days
    });
    const report = runSentimentStudy(days);
    expect(report.sample.nUsableSymbolDays).toBe(320);
    expect(report.sample.nTradingDays).toBe(20);
    expect(report.sample.nChainDays).toBe(0);
    expect(report.verdict).toBe('PENDING_FLOW');
    expect(report.verdict).not.toBe('FAIL');
    // An S1-graded PASS/FAIL/INCONCLUSIVE line is emitted alongside the PENDING note.
    expect(report.verdictReasons.join(' ')).toMatch(/S1 \(sentiment-alone\).*(PASS|FAIL|INCONCLUSIVE)/);
    // It must NOT have killed the direction off absent flow data.
    expect(report.verdictReasons.join(' ')).not.toMatch(/kill the direction/);
  });

  it('spot check on the accruing sample (8 sentiment days, 0 chain-days) is PENDING_FLOW, not FAIL', () => {
    const days = bulkDays({
      nDays: 8,
      nSymbols: 6,
      netScore: (s) => (s + 1) / 6,
      fwd: (s) => (s + 1) / 6, // some signal, but sample below the §4 bar
    });
    const report = runSentimentStudy(days);
    expect(report.sample.nChainDays).toBe(0);
    expect(report.verdict).toBe('PENDING_FLOW');
    // Below the bar ⇒ the S1 grade is INCONCLUSIVE (keep collecting), not a FAIL.
    expect(report.verdictReasons.join(' ')).toMatch(/S1 \(sentiment-alone\).*INCONCLUSIVE/);
  });

  it('still fires the S2-driven FAIL once S2 is MEASURED and dead (true negative, no regression)', () => {
    // Bar met, chain-days present, and — the part that makes this a real true
    // negative — the S2 subset is non-empty with RESOLVED forward returns, so the
    // IC is genuinely measured. netScore clears NETSCORE_FLOOR and flow agrees in
    // sign, so every symbol-day is confirmed. The cross-sectional relation flips
    // sign every other day ⇒ daily ICs alternate +1/−1 ⇒ meanIC = 0 across 20
    // measured days: a signal that was looked at and found dead.
    const days = bulkDays({
      // MUST stay EVEN: the alternating ±IC construction lands meanIC at exactly 0
      // only because nDays is even (10×+1, 10×−1). At odd nDays the residual 1/nDays
      // clears IC_FLOOR (0.03) and the verdict flips FAIL→INCONCLUSIVE, silently
      // dismantling this regression guard (measured: 21→0.0476, 19→0.0526). If you
      // raise the day count for coverage, keep it even.
      nDays: 20,
      nSymbols: 16,
      netScore: (s) => 0.3 + s * 0.01, // ≥ NETSCORE_FLOOR, varied for rank variance
      fwd: (s, d) => (d % 2 === 0 ? s : -s) * 0.001,
      flow: () => 0.3, // same sign as netScore ⇒ confirmed
    });
    const report = runSentimentStudy(days);
    expect(report.sample.nChainDays).toBe(20);
    expect(report.sample.nConfirmedSymbolDays).toBe(320);
    // The separator: this FAIL is backed by real coverage, unlike TRA-2076 Case B.
    for (const h of HORIZONS) {
      expect(report.s2Ic[h].nDays).toBe(20);
      expect(report.s2Ic[h].nPairs).toBe(320);
      expect(report.s2Ic[h].meanIC).not.toBeNull();
      expect(report.s2Ic[h].meanIC).toBeCloseTo(0, 10); // the pair's whole point: SAME value as Case B's null-vs-0
    }
    expect(report.verdict).toBe('FAIL');
    expect(report.verdictReasons.join(' ')).toMatch(/kill the direction/);
  });

  it('grades zero CONFIRMED symbol-days as INCONCLUSIVE, not FAIL', () => {
    // Chain data captured, but netScore below the confirmation floor ⇒ the S2
    // subset is empty ⇒ nothing was measured. Pre-TRA-2076 this returned FAIL.
    const days = bulkDays({
      nDays: 20,
      nSymbols: 16,
      netScore: () => 0, // below NETSCORE_FLOOR ⇒ never confirmed
      fwd: () => 0.01,
      flow: () => 0.3,
    });
    const report = runSentimentStudy(days);
    expect(report.sample.nChainDays).toBe(20);
    expect(report.sample.nConfirmedSymbolDays).toBe(0);
    expect(report.verdict).toBe('INCONCLUSIVE');
    expect(report.verdictReasons.join(' ')).toMatch(/zero coverage/);
    expect(report.verdictReasons.join(' ')).not.toMatch(/kill the direction/);
  });
});

// ── TRA-2076: zero IC coverage is INCONCLUSIVE, never FAIL ───────────────────
describe('TRA-2076 — IC-coverage precondition (mean([]) === 0 false zero)', () => {
  /**
   * Case B verbatim from TRA-2076: 60 dates × 6 symbols, every day-count clears
   * its §4 bar, chain flow present on every symbol-day, real varied netScore —
   * and ONLY the daily bars missing (`fwd` all-null). This is what
   * `TRA822_NO_FETCH=1` or a rate-limited daily feed produces. No existing guard
   * engages: `nChainDays` is sourced from chain snapshots and `nTradingDays` /
   * `nUsableSymbolDays` count sentiment symbol-days whose `usable` flag never
   * considers whether `fwd` resolved.
   */
  function caseBDays(): SentimentSymbolDay[] {
    const out: SentimentSymbolDay[] = [];
    for (let d = 0; d < 60; d++) {
      const date = new Date(Date.UTC(2026, 4, 1) + d * 86_400_000).toISOString().slice(0, 10);
      for (let s = 0; s < 6; s++) {
        out.push(
          symbolDay({
            date,
            symbol: `S${s}`,
            netScore: 0.3 + s * 0.05, // real varied netScore, clears NETSCORE_FLOOR
            taggedCount: 40,
            freshnessMinutes: 5,
            netOTMflow: 0.42, // chains load fine
            usable: true,
            fwd: { '1d': null, '5d': null, '20d': null }, // ONLY the bars missing
          }),
        );
      }
    }
    return out;
  }

  it('returns INCONCLUSIVE (never FAIL) when every day-count clears its bar but no forward return resolved', () => {
    const report = runSentimentStudy(caseBDays());

    // Every guard that exists today is satisfied — this is why the bug was live.
    expect(report.sample.nTradingDays).toBe(60);
    expect(report.sample.nUsableSymbolDays).toBe(360);
    expect(report.sample.nChainDays).toBe(60);
    expect(report.sample.nConfirmedSymbolDays).toBe(360);

    // ...and yet nothing was measured.
    for (const h of HORIZONS) {
      expect(report.s2Ic[h].nDays).toBe(0);
      expect(report.s2Ic[h].nPairs).toBe(0);
      expect(report.s2Ic[h].meanIC).toBeNull(); // NOT 0 — `0` is never "not measured"
      expect(report.s2Ic[h].icir).toBeNull();
      expect(report.confirmedVsAloneDelta[h]).toBeNull();
    }

    expect(report.verdict).toBe('INCONCLUSIVE');
    expect(report.verdict).not.toBe('FAIL');
    expect(report.verdictReasons.join(' ')).toMatch(/zero coverage/);
    expect(report.verdictReasons.join(' ')).toMatch(/nDays=0, nPairs=0/);
    // It must not have killed the direction off data that never arrived.
    expect(report.verdictReasons.join(' ')).not.toMatch(/kill the direction/);
  });

  it('computeIc reports null (not 0) for an unmeasured horizon', () => {
    const ic = computeIc([]);
    for (const h of HORIZONS) {
      expect(ic[h].meanIC).toBeNull();
      expect(ic[h].icStd).toBeNull();
      expect(ic[h].icir).toBeNull();
      expect(ic[h].nDays).toBe(0);
      expect(ic[h].nPairs).toBe(0);
      expect(isMeasured(ic[h])).toBe(false);
    }
  });

  it('gradeSignalAlone has the same precondition — a zero-coverage S1 is INCONCLUSIVE', () => {
    // Same Case-B shape but with NO flow, so the run takes the PENDING_FLOW path
    // and S1 is graded standalone. S1's `!anySignal` branch had the identical hole.
    const days = caseBDays().map((d) => ({ ...d, netOTMflow: null }));
    const report = runSentimentStudy(days);
    expect(report.sample.nChainDays).toBe(0);
    expect(report.verdict).toBe('PENDING_FLOW');
    const joined = report.verdictReasons.join(' ');
    expect(joined).toMatch(/S1 \(sentiment-alone\).*zero IC coverage/);
    expect(joined).toMatch(/S1 \(sentiment-alone\).*INCONCLUSIVE/);
    // The S1 FAIL branch must not have fired. (Matched precisely: the
    // PENDING_FLOW preamble legitimately contains "measured-dead signal".)
    expect(joined).not.toMatch(/S1 \(sentiment-alone\) IC indistinguishable from zero/);
  });
});
