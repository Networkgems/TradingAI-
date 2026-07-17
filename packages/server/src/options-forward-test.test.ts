import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import type { ChainDay } from '@trading-app/backtest';
import type { IdeaJournalEntry } from './options-idea-journal.js';
import type { IdeaLeg } from './options-ideas-feed.js';
import {
  valueIdea,
  buildForwardTestReport,
  buildAccumulationMonitor,
  renderWeeklyRollupMarkdown,
  structureCostUsd,
  DEFAULT_COST_MODEL,
  type IdeaOutcome,
} from './options-forward-test.js';
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

// ── TRA-678 hardening: costs (F1) + data hygiene (F2/F3/F4) ──────────────────

describe('TRA-678 F1 — transaction-cost haircut', () => {
  it('models a conservative round-trip cost that scales with leg count', () => {
    // 1-lot, default model: legs * 2 sides * ($0.65 commission + $0.02*100 spread).
    expect(structureCostUsd(1)).toBe(5.3); // 1*2*0.65 + 1*2*0.02*100
    expect(structureCostUsd(2)).toBe(10.6);
    expect(structureCostUsd(4)).toBe(21.2); // a 4-leg condor crosses 8 half-spreads
    expect(DEFAULT_COST_MODEL.commissionPerContract).toBeGreaterThan(0);
  });

  it('reports gross pnl unchanged but a cost-NET pnl/R below it', () => {
    // A marginally-positive PRE-cost idea: +$5 gross on a $300 max-loss.
    const e = entry({ legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300 });
    const o = valueIdea(e, [day('2026-02-20', 103.05, [])], ET_NOON('2026-02-23'));
    expect(o.status).toBe('resolved');
    expect(o.pnlUsd).toBe(5); // gross identity preserved (305 intrinsic − 300 debit)
    expect(o.pnlR! > 0).toBe(true); // gross R still positive (0.02 after rounding)
    expect(o.costsUsd).toBe(5.3); // 1-leg round trip
    expect(o.pnlNetUsd).toBe(-0.3); // costs flip a +$5 gross into a net loss
    expect(o.pnlNetUsd! < o.pnlUsd!).toBe(true);
    expect(o.win).toBe(true); // hit-rate is on gross pnl (unchanged)
    expect(o.excluded).toBe(false);
  });

  it('gate evaluates NET R: a positive-gross / negative-net record HOLDs', () => {
    const outcomes: IdeaOutcome[] = [];
    for (let w = 0; w < 8; w++) {
      for (let i = 0; i < 5; i++) {
        outcomes.push({
          key: `w${w}-${i}`, ticker: 'AAA', strategy: 'long_call',
          surfacedDate: '2026-01-05', surfacedWeek: `2026-W${String(w + 2).padStart(2, '0')}`,
          expiration: '2026-02-20', pop: 0.5, maxLossUsd: 300, maxProfitUsd: 600,
          entryNetUsd: -300, status: 'resolved', valuedAt: '2026-02-20', liquidationUsd: 305,
          pnlUsd: 5, pnlR: 0.02, costsUsd: 11, pnlNetUsd: -6, pnlNetR: -0.02,
          win: true, maxLossBreached: false, excluded: false, excludeReason: null, settleLagDays: 0,
        });
      }
    }
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-03-01') });
    expect(report.totals.expectancyR! > 0).toBe(true); // pre-cost edge looks positive…
    expect(report.totals.expectancyNetR! < 0).toBe(true); // …but is negative net of costs
    const gate = evaluateLiveCapitalGate(report);
    expect(gate.passed).toBe(false);
    expect(gate.criteria.find((c) => c.name === 'positive_expectancy')?.pass).toBe(false);
  });
});

describe('TRA-678 F2 — fallback-priced ideas excluded from metrics', () => {
  it('marks a fallback-priced entry excluded and keeps it out of the gate denominators', () => {
    const fb = entry({
      key: 'fb', legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300, priced: false,
    });
    const ok = entry({
      key: 'ok', legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300, priced: true,
    });
    const outcomes = [
      valueIdea(fb, [day('2026-02-20', 110, [])], ET_NOON('2026-02-23')),
      valueIdea(ok, [day('2026-02-20', 110, [])], ET_NOON('2026-02-23')),
    ];
    expect(outcomes[0]!.excluded).toBe(true);
    expect(outcomes[0]!.excludeReason).toBe('fallback_priced');
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-02-23') });
    expect(report.totals.resolved).toBe(1); // only the real-priced idea counts
    expect(report.totals.excluded).toBe(1);
  });
});

describe('TRA-678 F3 — stale settlement quarantine', () => {
  it('settles on the next trading day without quarantine (lag ≤ 1)', () => {
    // Expiration Mon 2026-02-02; settle Tue 2026-02-03 (1 trading day).
    const e = entry({
      legs: [leg('buy', 'call', 100, '2026-02-02')], entryNetUsd: -300, expiration: '2026-02-02',
    });
    const o = valueIdea(e, [day('2026-02-03', 110, [])], ET_NOON('2026-02-06'));
    expect(o.status).toBe('resolved');
    expect(o.settleLagDays).toBe(1);
    expect(o.excluded).toBe(false);
  });

  it('quarantines a settlement chain that lags expiry by > 1 trading day', () => {
    // Expiration Mon 2026-02-02; nearest chain Thu 2026-02-05 (3 trading days).
    const e = entry({
      legs: [leg('buy', 'call', 100, '2026-02-02')], entryNetUsd: -300, expiration: '2026-02-02',
    });
    const o = valueIdea(e, [day('2026-02-05', 110, [])], ET_NOON('2026-02-09'));
    expect(o.status).toBe('resolved'); // still valued for transparency
    expect(o.settleLagDays).toBe(3);
    expect(o.excluded).toBe(true);
    expect(o.excludeReason).toBe('stale_settlement');
    const report = buildForwardTestReport([o], { asOf: ET_NOON('2026-02-09') });
    expect(report.totals.resolved).toBe(0); // excluded from the gate sample
    expect(report.totals.excluded).toBe(1);
  });
});

describe('TRA-678 F4 — guard the R denominator', () => {
  it('does not substitute denom=1: a non-positive max-loss yields null R and is excluded', () => {
    const e = entry({
      legs: [leg('buy', 'call', 100, '2026-02-20')], entryNetUsd: -300, maxLossUsd: 0,
    });
    const o = valueIdea(e, [day('2026-02-20', 110, [])], ET_NOON('2026-02-23'));
    expect(o.status).toBe('resolved');
    expect(o.pnlUsd).toBe(700); // dollars still computed
    expect(o.pnlR).toBeNull(); // NOT 700 (the old denom=1 distortion)
    expect(o.pnlNetR).toBeNull();
    expect(o.excluded).toBe(true);
    expect(o.excludeReason).toBe('non_positive_max_loss');
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
          costsUsd: 6,
          pnlNetUsd: 294,
          pnlNetR: 0.98,
          win: true,
          excluded: false,
          excludeReason: null,
          settleLagDays: 0,
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
          costsUsd: 6,
          pnlNetUsd: 294,
          pnlNetR: 0.98,
          win: true,
          excluded: false,
          excludeReason: null,
          settleLagDays: 0,
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

// ── TRA-1971 — accumulation monitor ──────────────────────────────────────────

describe('buildAccumulationMonitor', () => {
  const GATE = { minWeeksWithResolved: 8, minResolvedIdeas: 30 };

  it('reports the clock NOT started and every blocker when nothing is wired', () => {
    // The current 0/6 reality: no creds, no chains, no journaled ideas.
    const report = buildForwardTestReport([], { asOf: ET_NOON('2026-07-16') });
    const m = buildAccumulationMonitor({
      report,
      gate: GATE,
      chainOutDir: '/data/option-chains',
      chainDates: [],
      journalCount: 0,
      firstJournaledDate: null,
      lastJournaledDate: null,
      tradierConfigured: false,
      anthropicConfigured: false,
    });
    expect(m.clock.started).toBe(false);
    expect(m.clock.blockedOn).toEqual([
      'tradier_token_unset',
      'anthropic_key_unset',
      'no_chain_partitions',
      'no_journaled_ideas',
    ]);
    expect(m.chains).toMatchObject({
      outDir: '/data/option-chains',
      partitionDays: 0,
      firstRecordedDate: null,
      lastRecordedDate: null,
    });
    expect(m.journal).toMatchObject({ ideaCount: 0, firstJournaledDate: null });
    // The full window is still ahead of it.
    expect(m.gate.weeksRemaining).toBe(8);
    expect(m.gate.resolvedRemaining).toBe(30);
    expect(m.accumulation.surfaced).toBe(0);
  });

  it('starts the clock once BOTH feeds have produced their first durable artifact', () => {
    const report = buildForwardTestReport([], { asOf: ET_NOON('2026-07-16') });
    const m = buildAccumulationMonitor({
      report,
      gate: GATE,
      chainOutDir: '/data/option-chains',
      chainDates: ['2026-07-10', '2026-07-13', '2026-07-14'],
      journalCount: 5,
      firstJournaledDate: '2026-07-11',
      lastJournaledDate: '2026-07-14',
      tradierConfigured: true,
      anthropicConfigured: true,
    });
    expect(m.clock.started).toBe(true);
    expect(m.clock.blockedOn).toEqual([]);
    expect(m.chains.firstRecordedDate).toBe('2026-07-10');
    expect(m.chains.lastRecordedDate).toBe('2026-07-14');
    expect(m.chains.partitionDays).toBe(3);
    expect(m.journal).toMatchObject({
      ideaCount: 5,
      firstJournaledDate: '2026-07-11',
      lastJournaledDate: '2026-07-14',
    });
  });

  it('does NOT start the clock when one feed is producing but the other is empty', () => {
    // Chains recording, but no ideas journaled yet (Anthropic key still unset).
    const report = buildForwardTestReport([], { asOf: ET_NOON('2026-07-16') });
    const m = buildAccumulationMonitor({
      report,
      gate: GATE,
      chainOutDir: '/data/option-chains',
      chainDates: ['2026-07-14'],
      journalCount: 0,
      firstJournaledDate: null,
      lastJournaledDate: null,
      tradierConfigured: true,
      anthropicConfigured: false,
    });
    expect(m.clock.started).toBe(false);
    expect(m.clock.blockedOn).toEqual(['anthropic_key_unset', 'no_journaled_ideas']);
  });

  it('surfaces accumulation counts and clamps remaining-to-gate at zero once cleared', () => {
    // Simulate a matured record: many resolved ideas across many weeks so both
    // gate remainders floor at 0 (never go negative).
    const outcomes: IdeaOutcome[] = [];
    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < 4; i++) {
        outcomes.push({
          key: `w${w}-${i}`,
          ticker: 'AAA',
          strategy: 'long_call',
          surfacedDate: `2026-0${1 + Math.floor(w / 4)}-0${1 + (w % 4)}`,
          surfacedWeek: `2026-W${String(w + 2).padStart(2, '0')}`,
          expiration: '2026-02-20',
          pop: 0.6,
          maxLossUsd: 300,
          maxProfitUsd: 600,
          entryNetUsd: -300,
          status: 'resolved',
          valuedAt: '2026-02-20',
          liquidationUsd: 450,
          pnlUsd: 150,
          pnlR: 0.5,
          costsUsd: 6,
          pnlNetUsd: 144,
          pnlNetR: 0.48,
          win: true,
          excluded: false,
          excludeReason: null,
          settleLagDays: 0,
          maxLossBreached: false,
        });
      }
    }
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-07-16') });
    const m = buildAccumulationMonitor({
      report,
      gate: GATE,
      chainOutDir: '/data/option-chains',
      chainDates: ['2026-01-05'],
      journalCount: outcomes.length,
      firstJournaledDate: '2026-01-05',
      lastJournaledDate: '2026-03-01',
      tradierConfigured: true,
      anthropicConfigured: true,
    });
    expect(m.accumulation.resolved).toBe(40);
    expect(m.accumulation.weeksWithResolved).toBe(10);
    expect(m.gate.weeksRemaining).toBe(0); // 8 needed, 10 have → clamped, not −2
    expect(m.gate.resolvedRemaining).toBe(0); // 30 needed, 40 have → clamped
  });
});

describe('renderWeeklyRollupMarkdown', () => {
  const emptyMonitor = (blockedOn: string[]) =>
    buildAccumulationMonitor({
      report: buildForwardTestReport([], { asOf: ET_NOON('2026-07-16') }),
      gate: { minWeeksWithResolved: 8, minResolvedIdeas: 30 },
      chainOutDir: '/data/option-chains',
      chainDates: [],
      journalCount: 0,
      firstJournaledDate: null,
      lastJournaledDate: null,
      tradierConfigured: false,
      anthropicConfigured: false,
    });

  it('renders the not-started state with the gate HOLD verdict and blockers', () => {
    const report = buildForwardTestReport([], { asOf: ET_NOON('2026-07-16') });
    const md = renderWeeklyRollupMarkdown({
      monitor: emptyMonitor([]),
      report,
      gatePassed: false,
      gateSummary: 'HOLD — insufficient track record',
    });
    expect(md).toContain('AI Options Ideas — Forward-Test Roll-Up');
    expect(md).toContain('NOT started');
    expect(md).toContain('tradier_token_unset');
    expect(md).toContain('⛔ HOLD');
    // Gate bars are surfaced so the reader sees the target, not just the current.
    expect(md).toContain('| Weeks with resolved ideas | 0 | 8 | 8 |');
    expect(md).toContain('| Resolved ideas | 0 | 30 | 30 |');
  });

  it('renders a per-week table when weeks have resolved ideas', () => {
    const outcomes: IdeaOutcome[] = [
      {
        key: 'k1',
        ticker: 'AAA',
        strategy: 'long_call',
        surfacedDate: '2026-01-05',
        surfacedWeek: '2026-W02',
        expiration: '2026-02-20',
        pop: 0.6,
        maxLossUsd: 300,
        maxProfitUsd: 600,
        entryNetUsd: -300,
        status: 'resolved',
        valuedAt: '2026-02-20',
        liquidationUsd: 600,
        pnlUsd: 300,
        pnlR: 1.0,
        costsUsd: 6,
        pnlNetUsd: 294,
        pnlNetR: 0.98,
        win: true,
        excluded: false,
        excludeReason: null,
        settleLagDays: 0,
        maxLossBreached: false,
      },
    ];
    const report = buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-02-23') });
    const monitor = buildAccumulationMonitor({
      report,
      gate: { minWeeksWithResolved: 8, minResolvedIdeas: 30 },
      chainOutDir: '/data/option-chains',
      chainDates: ['2026-01-05'],
      journalCount: 1,
      firstJournaledDate: '2026-01-05',
      lastJournaledDate: '2026-01-05',
      tradierConfigured: true,
      anthropicConfigured: true,
    });
    const md = renderWeeklyRollupMarkdown({
      monitor,
      report,
      gatePassed: false,
      gateSummary: 'HOLD — needs more weeks',
    });
    expect(md).toContain('STARTED');
    expect(md).toContain('### Recent weeks');
    expect(md).toContain('2026-W02');
  });
});
