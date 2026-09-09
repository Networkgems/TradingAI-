// TRA-4317 (AC1) — PUBLISH THE GAP: the profit-lock release level, the mark at
// fire and the fill are three different prices, and until this shipped only two
// of them survived to the journal close row. On 4/4 armed `profit_lock`
// releases (desk, 2026-08-26..09-03) the realized fill landed a mean −0.417R
// under the rule's own computed level (t ≈ 10.8), and establishing that took a
// hand re-derivation from constants because the level — `max(peakR − giveBackR,
// floorR)` AS THE RULE SAW IT, on the basis (executable bid vs mid, TRA-4285)
// actually in force on the firing tick — exists nowhere on the wire.
//
// What is asserted:
//   1. A quoted give-back fire stamps `profitLockFire` on the row in the
//      EXECUTABLE basis — level in R and premium, the mid the tick served, the
//      bid it priced against — and the journal close row publishes it verbatim.
//   2. A dark-tick fire stamps the legacy MID basis with `execBidAtFire: null`,
//      so a reader can tell which basis produced the level.
//   3. CONTROL — a close by any other rule (here the premium trail) carries no
//      stamp: absent stays absent, the column is never fabricated.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
} from './option-trade-journal.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const MIN = 60_000;

// ETHA geometry, verbatim from `tra4285-profit-lock-executable-basis.test.ts`:
// broker-fill entry 1.28 → stopLossPremium 1.024 (−20% OTM stop) → R = 0.256.
const ENTRY = 1.28;
const R_UNIT = 0.256;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4317',
    symbol: 'ETHA',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: ENTRY,
    stopLoss: 0.96,
    takeProfit: 1.92,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'ETHA241002C00019000',
    optionType: 'call',
    strike: 19,
    expiration: '2024-10-02',
    mark: ENTRY,
    theo: 1.66,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
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

// No ATR ⇒ the chandelier is inert; no ladder ⇒ the scalar 0.75/0.40 rule.
const RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };

let tmpFile: string;

function liveAccount() {
  vi.setSystemTime(TRADING_TIME);
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: false,
  });
  const pos = acct.openOptionFromCandidate(buildSignal(), 'live', 50_000, undefined, JOURNAL_SETUP);
  expect(pos).not.toBeNull();
  const sym = pos!.optionSymbol!;
  const tick = (quote: { bid: number; ask: number } | null, waitAndHold = true) => {
    acct.refreshOptionQuotes(quote ? new Map([[sym, quote]]) : new Map());
    const mid = quote ? (quote.bid + quote.ask) / 2 : ENTRY;
    return acct.checkExits(
      new Map([['ETHA', 19]]),
      new Map([[sym, mid]]),
      'live',
      { waitAndHold },
      undefined,
      RISK,
    );
  };
  const row = () => acct.getState().openOptions[0];
  return { acct, tick, row, id: pos!.id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  tmpFile = join(tmpdir(), `tra4317-journal-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-4317 AC1 — the profit-lock release level is published on the close row', () => {
  it('a quoted give-back fire stamps the level in the EXECUTABLE basis and the journal close row carries it verbatim', async () => {
    const { acct, tick, row, id } = liveAccount();

    // Arm on the executable basis: bid 1.48 ≥ ENTRY + 0.75R = 1.472.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    expect(row().profitLockFire).toBeUndefined(); // armed ≠ fired

    // Bid 1.37 ≤ release level 1.48 − 0.40R = 1.3776 ⇒ the give-back leg fires.
    const FIRE_TIME = TRADING_TIME + 3 * MIN;
    vi.setSystemTime(FIRE_TIME);
    const staged = tick({ bid: 1.37, ask: 1.47 });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');

    // The stamp, in the basis the rule decided on: peakR = (1.48 − 1.28)/0.256
    // = 0.78125, levelR = 0.38125, levelPremium = 1.3776 — against the served
    // mid 1.42 and the bid 1.37 the decision priced.
    const fire = row().profitLockFire!;
    expect(fire).toBeDefined();
    expect(fire.at).toBe(FIRE_TIME);
    expect(fire.levelR).toBeCloseTo(0.38125, 9);
    expect(fire.levelPremium).toBeCloseTo(ENTRY + 0.38125 * R_UNIT, 9); // 1.3776
    expect(fire.markAtFire).toBeCloseTo(1.42, 9);
    expect(fire.execBidAtFire).toBe(1.37);

    // TRA-4246 (AC2) — the decision's own operands ride the same stamp, so
    // "did the rule arm, and from what peak" is a READ. `peakPremiumAtFire` is
    // 1.48, the EXECUTABLE peak (`peakPremiumExec`) this quoted tick decided
    // on, NOT the mid high-water mark 1.58 — grading the level against the mid
    // peak is the half-spread error TRA-4285 removed.
    expect(fire.armed).toBe(true);
    expect(fire.peakPremiumAtFire).toBeCloseTo(1.48, 9);
    expect(fire.peakR).toBeCloseTo(0.78125, 9);
    expect(fire.giveBackR).toBeCloseTo(0.4, 9);
    expect(fire.stopBasisPremium).toBeCloseTo(R_UNIT, 9); // 0.256 = the row's OWN R
    // …and `levelR` reconciles to them without any constant: peakR − giveBackR.
    expect(fire.peakR - fire.giveBackR).toBeCloseTo(fire.levelR, 9);

    // …and the close row publishes it verbatim, beside the fill it explains:
    // level 1.3776 vs fill 1.37 — the gap TRA-4317 measured, now a column.
    const finalised = acct.finalizePendingExit(id, 1.37);
    expect(finalised!.exitReason).toBe('profit_lock');
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    // `toEqual` on the WHOLE object on purpose: the close row must carry the
    // stamp verbatim, and a field added to the stamp that never reaches the
    // journal is the exact defect TRA-4246 (AC2) is about. This assertion goes
    // red when a writer forgets to plumb one.
    expect(rows[0]!.profitLockFire).toEqual({
      at: FIRE_TIME,
      levelR: fire.levelR,
      levelPremium: fire.levelPremium,
      markAtFire: fire.markAtFire,
      execBidAtFire: 1.37,
      armed: true,
      peakPremiumAtFire: fire.peakPremiumAtFire,
      peakR: fire.peakR,
      giveBackR: fire.giveBackR,
      stopBasisPremium: fire.stopBasisPremium,
    });
  });

  it('a dark-tick fire stamps the legacy MID basis with execBidAtFire null, so the basis is readable off the row', () => {
    const { tick, row } = liveAccount();

    // Quoted run-up ratchets the mid peak to 1.53; then the feed goes dark and
    // the row is marked at ENTRY. Mid basis: peakR = (1.53 − 1.28)/0.256 =
    // 0.9765625, levelR = 0.5765625, levelPremium = 1.4276.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    const FIRE_TIME = TRADING_TIME + 2 * MIN;
    vi.setSystemTime(FIRE_TIME);
    const staged = tick(null);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');

    const fire = row().profitLockFire!;
    expect(fire.levelR).toBeCloseTo(0.5765625, 9);
    expect(fire.levelPremium).toBeCloseTo(ENTRY + 0.5765625 * R_UNIT, 9); // 1.4276
    expect(fire.markAtFire).toBe(ENTRY); // the dark tick's mid mark
    expect(fire.execBidAtFire).toBeNull(); // ⇔ the mid basis was in force
  });

  it('CONTROL — a premium-trail close carries no stamp: the column is never fabricated for another rule', async () => {
    const { acct, tick, row, id } = liveAccount();

    // Engage the trail by hand (peak 1.50 ⇒ trail at 1.20); mid 1.15 fires the
    // trail while the profit lock stays unarmed on the executable basis (the
    // exec peak seeds at this tick's under-water 1.10 bid).
    row().trailingActive = true;
    row().peakPremium = 1.5;
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    const fired = tick({ bid: 1.1, ask: 1.2 });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.pendingExit!.journalReason).toBe('trail');
    expect(row().profitLockFire).toBeUndefined();

    const finalised = acct.finalizePendingExit(id, 1.1);
    expect(finalised!.exitReason).toBe('trail');
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.profitLockFire).toBeUndefined();
  });
});
