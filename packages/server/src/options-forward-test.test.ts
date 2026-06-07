import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import type { ChainDay } from '@trading-app/backtest';
import type { IdeaJournalEntry } from './options-idea-journal.js';
import type { IdeaLeg } from './options-ideas-feed.js';
import { valueIdea, buildForwardTestReport, type IdeaOutcome } from './options-forward-test.js';
import { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } from './live-capital-gate.js';

// ── helpers ─────────────────────────────────────────────────────────────────

const ET_NOON = (date: string): number => Date.parse(`${date}T17:00:00Z`); // ~noon ET

function row(
  optionType: 'call' | 'put',
  strike: number,
  expiration: string,
  mid: number,
): OptionChainRow {
  return {
    optionSymbol: `X${optionType}${strike}`,
    underlying: 'AAA',
    optionType,
    strike,
    expiration,
    bid: mid - 0.05,
    ask: mid + 0.05,
  };
}

function day(date: string, spot: number, rows: OptionChainRow[]): ChainDay {
  return {
    date,
    bySymbol: new Map([
      ['AAA', { symbol: 'AAA', spot, recordedAt: ET_NOON(date), expirations: [], rows }],
    ]),
  };
}

function entry(partial: Partial<IdeaJournalEntry> & { legs: IdeaLeg[]; entryNetUsd: number }): IdeaJournalEntry {
  return {
    key: 'k',
    surfacedAt: ET_NOON('2026-01-05'),
    surfacedDate: '2026-01-05',
    surfacedWeek: '2026-W02',
    ticker: 'AAA',
    strategy: 'long_call',
    thesis: 't',
    pop: 0.6,
    dte: 30,
    expiration: '2026-02-20',
    maxLossUsd: 300,
    maxProfitUsd: 600,
    breakevens: [103],
    spotAtEntry: 100,
    ivRank: 40,
    ...partial,
  };
}

const leg = (action: 'buy' | 'sell', optionType: 'call' | 'put', strike: number, expiration: string): IdeaLeg => ({
  action,
  optionType,
  strike,
  expiration,
});

// ── valuation ──────────────────────────────────────────────────────────────

describe('valueIdea — defined-risk forward valuation', () => {
  it('resolves a long-call debit as a win at intrinsic value', () => {
    const e = entry({ legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    const chains = [day('2026-02-20', 110, [])]; // settle: spot 110, ITM by 10
    const o = valueIdea(e, chains, ET_NOON('2026-02-23'));
    expect(o.status).toBe('resolved');
    expect(o.win).toBe(true);
    expect(o.pnlUsd).toBe(700); // 10*100 intrinsic − 300 debit
    expect(o.pnlR).toBeCloseTo(700 / 300, 2);
    expect(o.maxLossBreached).toBe(false);
  });

  it('resolves a long-call debit as a max loss when it expires OTM (no breach)', () => {
    const e = entry({ legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    const o = valueIdea(e, [day('2026-02-20', 95, [])], ET_NOON('2026-02-23'));
    expect(o.status).toBe('resolved');
    expect(o.win).toBe(false);
    expect(o.pnlUsd).toBe(-300); // total debit lost, exactly maxLoss
    expect(o.maxLossBreached).toBe(false);
  });

  it('resolves a credit spread: keeps the credit when it expires safe', () => {
    const e = entry({
      strategy: 'bull_put_spread',
      legs: [leg('sell', 'put', 100, '2026-02-20'), leg('buy', 'put', 95, '2026-02-20')],
      entryNetUsd: 150, // $1.50 credit
      maxLossUsd: 350,
      maxProfitUsd: 150,
    });
    const o = valueIdea(e, [day('2026-02-20', 105, [])], ET_NOON('2026-02-23'));
    expect(o.status).toBe('resolved');
    expect(o.win).toBe(true);
    expect(o.pnlUsd).toBe(150); // both puts OTM → keep full credit
  });

  it('resolves a credit spread to exactly −maxLoss below the long strike (bounded, no breach)', () => {
    const e = entry({
      strategy: 'bull_put_spread',
      legs: [leg('sell', 'put', 100, '2026-02-20'), leg('buy', 'put', 95, '2026-02-20')],
      entryNetUsd: 150,
      maxLossUsd: 350,
      maxProfitUsd: 150,
    });
    const o = valueIdea(e, [day('2026-02-20', 90, [])], ET_NOON('2026-02-23'));
    expect(o.status).toBe('resolved');
    expect(o.win).toBe(false);
    expect(o.pnlUsd).toBe(-350); // (−10 + 5)*100 + 150 = −350 = −maxLoss
    expect(o.maxLossBreached).toBe(false);
  });

  it('marks an open idea to market at the latest priceable chain', () => {
    const e = entry({
      legs: [leg('buy', 'call', 100, '2026-03-20')],
      entryNetUsd: -300,
      expiration: '2026-03-20',
    });
    const chains = [
      day('2026-01-12', 102, [row('call', 100, '2026-03-20', 3.5)]),
      day('2026-01-20', 105, [row('call', 100, '2026-03-20', 5.0)]), // latest, mid 5.00
    ];
    const o = valueIdea(e, chains, ET_NOON('2026-01-21'));
    expect(o.status).toBe('open');
    expect(o.win).toBeNull();
    expect(o.valuedAt).toBe('2026-01-20');
    expect(o.pnlUsd).toBe(200); // 5.00*100 − 300
  });

  it('returns no_data when no forward chain covers the symbol', () => {
    const e = entry({ legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    const o = valueIdea(e, [], ET_NOON('2026-01-10'));
    expect(o.status).toBe('no_data');
    expect(o.pnlUsd).toBeNull();
  });

  it('returns awaiting_data past expiry when no settlement chain exists', () => {
    const e = entry({ legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    // A chain exists but only BEFORE expiry — nothing to settle against.
    const chains = [day('2026-02-10', 101, [row('call', 100, '2026-02-20', 2.5)])];
    const o = valueIdea(e, chains, ET_NOON('2026-02-25'));
    expect(o.status).toBe('awaiting_data');
  });

  it('never uses a chain recorded before the surface date (no look-ahead)', () => {
    const e = entry({
      legs: [leg('buy', 'call', 100, '2026-03-20')],
      entryNetUsd: -300,
      surfacedDate: '2026-01-15',
      expiration: '2026-03-20',
    });
    const chains = [
      day('2026-01-10', 200, [row('call', 100, '2026-03-20', 99)]), // pre-surface, must be ignored
    ];
    const o = valueIdea(e, chains, ET_NOON('2026-01-20'));
    expect(o.status).toBe('no_data');
  });
});

// ── report ────────────────────────────────────────────────────────────────

describe('buildForwardTestReport', () => {
  it('aggregates hit-rate, expectancy and POP calibration by week', () => {
    const win = entry({ key: 'w', legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    const loss = entry({ key: 'l', legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    const outcomes: IdeaOutcome[] = [
      valueIdea(win, [day('2026-02-20', 110, [])], ET_NOON('2026-02-23')),
      valueIdea(loss, [day('2026-02-20', 95, [])], ET_NOON('2026-02-23')),
    ];
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-02-23') });
    expect(report.totals.resolved).toBe(2);
    expect(report.totals.wins).toBe(1);
    expect(report.totals.hitRate).toBe(0.5);
    expect(report.totals.expectancyUsd).toBe(200); // (700 + −300)/2
    expect(report.weeks).toHaveLength(1);
    expect(report.weeks[0]!.week).toBe('2026-W02');
    expect(report.totals.popCalibrationGap).toBeCloseTo(0.5 - 0.6, 5);
  });

  it('excludes open/awaiting/no_data from the hit-rate denominator', () => {
    const open = entry({
      key: 'o',
      legs: [leg('buy', 'call', 100, '2026-03-20')],
      entryNetUsd: -300,
      expiration: '2026-03-20',
    });
    const outcomes = [
      valueIdea(open, [day('2026-01-12', 102, [row('call', 100, '2026-03-20', 3.5)])], ET_NOON('2026-01-13')),
    ];
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-01-13') });
    expect(report.totals.open).toBe(1);
    expect(report.totals.resolved).toBe(0);
    expect(report.totals.hitRate).toBeNull();
  });
});

// ── gate ─────────────────────────────────────────────────────────────────

describe('evaluateLiveCapitalGate', () => {
  it('HOLDs on an empty/insufficient track record', () => {
    const report = buildForwardTestReport([], { asOf: ET_NOON('2026-02-23') });
    const gate = evaluateLiveCapitalGate(report);
    expect(gate.passed).toBe(false);
    expect(gate.criteria.find((c) => c.name === 'sample_size')?.pass).toBe(false);
    expect(gate.summary).toMatch(/HOLD/);
  });

  it('passes only when every criterion is met', () => {
    // Synthesize 8 weeks × 5 winning resolved ideas (40 total), all wins, with
    // POP set so calibration is exact (hit-rate 1.0 vs stated 1.0).
    const outcomes: IdeaOutcome[] = [];
    for (let w = 0; w < 8; w++) {
      for (let i = 0; i < 5; i++) {
        outcomes.push({
          key: `w${w}-${i}`,
          ticker: 'AAA',
          strategy: 'long_call',
          surfacedDate: '2026-01-05',
          surfacedWeek: `2026-W${String(w + 2).padStart(2, '0')}`,
          expiration: '2026-02-20',
          pop: 1.0,
          maxLossUsd: 300,
          maxProfitUsd: 600,
          entryNetUsd: -300,
          status: 'resolved',
          valuedAt: '2026-02-20',
          liquidationUsd: 600,
          pnlUsd: 300,
          pnlR: 1.0,
          win: true,
          maxLossBreached: false,
        });
      }
    }
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-03-01') });
    const gate = evaluateLiveCapitalGate(report, LIVE_CAPITAL_GATE);
    expect(report.totals.resolved).toBe(40);
    expect(report.totals.weeksWithResolved).toBe(8);
    expect(gate.passed).toBe(true);
    expect(gate.summary).toMatch(/PASS/);
  });

  it('HOLDs when a defined-risk breach is present even if expectancy is strong', () => {
    const outcomes: IdeaOutcome[] = [];
    for (let w = 0; w < 8; w++) {
      for (let i = 0; i < 5; i++) {
        outcomes.push({
          key: `w${w}-${i}`,
          ticker: 'AAA',
          strategy: 'long_call',
          surfacedDate: '2026-01-05',
          surfacedWeek: `2026-W${String(w + 2).padStart(2, '0')}`,
          expiration: '2026-02-20',
          pop: 1.0,
          maxLossUsd: 300,
          maxProfitUsd: 600,
          entryNetUsd: -300,
          status: 'resolved',
          valuedAt: '2026-02-20',
          liquidationUsd: 600,
          pnlUsd: 300,
          pnlR: 1.0,
          win: true,
          maxLossBreached: w === 0 && i === 0, // a single breach
        });
      }
    }
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-03-01') });
    const gate = evaluateLiveCapitalGate(report);
    expect(report.totals.maxLossBreaches).toBe(1);
    expect(gate.passed).toBe(false);
    expect(gate.criteria.find((c) => c.name === 'defined_risk_integrity')?.pass).toBe(false);
  });
});
