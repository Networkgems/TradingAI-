// TRA-4335 — three instrument defects found by the 2026-09-03 daily journal review.
//
// Defect 1: `/api/health/churn-brake`'s reject counters were since-boot only, so a
// post-reboot read of `opensRejected: 0` was byte-identical whether the cap was
// enforcing perfectly or completely dark. Fix: a DURABLE per-ET-day
// presented/evaluated/rejected guard fold (`churn-brake-guard.jsonl`, the TRA-2598
// conviction-dca-guard pattern in the TRA-1602 cost-aware-gate retained shape).
// The review's stated acceptance: a restart must not zero the retained counters,
// and a deliberately disarmed brake must render differently from an armed-and-
// quiet one. Both are pinned below.
//
// Defect 2: two byte-identical IONQ261009C00039000 twins closed 6.8s apart with
// identical realized R and two different exitReasons (`book_halt_flat` vs
// `profit_lock`), because the book-halt flatten runs after the tick's exit pass
// and which mechanism reaches the row first depends on per-engine tick phase.
// Fix: the flatten's close re-evaluates the row's own profit-lock at the close
// mark and stamps `profit_lock` when the trade-level rule already demanded the
// exit; `book_halt_flat` remains for rows the halt alone closed.
//
// Defect 3: `strategies_inactive_on_tick` on a live engine conflated a deliberate
// per-account opt-out with unresolved broker creds. Fix: `passGateBlockedDetail`
// on the funnel row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeGuardEvent,
  hydrateChurnBrakeGuardFromDisk,
  summarizeChurnBrakeGuard,
  churnBrakeGuardLogPath,
  type ChurnBrakeGuardEvent,
} from './churn-brake-ledger.js';
import {
  __resetEquityEntryFunnelForTests,
  recordEquityEntryPassGated,
  summarizeEquityEntryFunnel,
} from './equity-entry-funnel.js';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z'); // Tue 10:00 ET (EDT)

function guardEvent(overrides: Partial<ChurnBrakeGuardEvent> = {}): ChurnBrakeGuardEvent {
  return {
    ts: TRADING_TIME,
    etDay: '2024-06-04',
    symbol: 'IONQ',
    guardEnabled: true,
    blocked: false,
    count: 1,
    cap: 6,
    ...overrides,
  };
}

describe('TRA-4335 defect 1 — durable churn-brake open-cap guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4335-guard-'));
    clearChurnBrakeLedger();
    hydrateChurnBrakeGuardFromDisk(dir, TRADING_TIME);
  });

  afterEach(() => {
    clearChurnBrakeLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a disarmed brake renders differently from an armed-and-quiet one', () => {
    // Dark: candidates presented, flag off for all of them.
    recordChurnBrakeGuardEvent(guardEvent({ guardEnabled: false, blocked: false }));
    recordChurnBrakeGuardEvent(guardEvent({ guardEnabled: false, blocked: false, symbol: 'AAPL' }));
    const dark = summarizeChurnBrakeGuard();
    expect(dark.state).toBe('dark');
    expect(dark.opensPresented).toBe(2);
    expect(dark.opensEvaluated).toBe(0);
    expect(dark.opensRejected).toBe(0);

    // Armed and quiet: the cap RAN on everything and refused nothing.
    clearChurnBrakeLedger();
    hydrateChurnBrakeGuardFromDisk(mkdtempSync(join(tmpdir(), 'tra4335-g2-')), TRADING_TIME);
    recordChurnBrakeGuardEvent(guardEvent());
    recordChurnBrakeGuardEvent(guardEvent({ symbol: 'AAPL' }));
    const quiet = summarizeChurnBrakeGuard();
    expect(quiet.state).toBe('live_clean');
    expect(quiet.opensPresented).toBe(2);
    expect(quiet.opensEvaluated).toBe(2);
    expect(quiet.opensRejected).toBe(0);

    // The two zero-reject states must not share a rendering.
    expect(dark.state).not.toBe(quiet.state);
  });

  it('a firing cap reads live_firing with per-day, per-symbol rejects', () => {
    recordChurnBrakeGuardEvent(guardEvent());
    recordChurnBrakeGuardEvent(guardEvent({ blocked: true, count: 6, cap: 6 }));
    recordChurnBrakeGuardEvent(guardEvent({ blocked: true, count: 7, cap: 6 }));
    const s = summarizeChurnBrakeGuard();
    expect(s.state).toBe('live_firing');
    expect(s.opensPresented).toBe(3);
    expect(s.opensEvaluated).toBe(3);
    expect(s.opensRejected).toBe(2);
    expect(s.etDays).toEqual(['2024-06-04']);
    expect(s.byEtDay).toHaveLength(1);
    expect(s.byEtDay[0].opensRejected).toBe(2);
    expect(s.byEtDay[0].rejectsBySymbol).toEqual([{ symbol: 'IONQ', count: 2 }]);
  });

  it('a flag flipped mid-window reads mixed', () => {
    recordChurnBrakeGuardEvent(guardEvent({ guardEnabled: false, blocked: false }));
    recordChurnBrakeGuardEvent(guardEvent());
    expect(summarizeChurnBrakeGuard().state).toBe('mixed');
  });

  it('a restart must not zero the retained counters (hydrate round-trip)', () => {
    recordChurnBrakeGuardEvent(guardEvent());
    recordChurnBrakeGuardEvent(guardEvent({ blocked: true, count: 6, cap: 6 }));
    recordChurnBrakeGuardEvent(
      guardEvent({ etDay: '2024-06-05', ts: TRADING_TIME + 24 * 60 * 60 * 1000, symbol: 'AAPL' }),
    );

    // Simulated reboot: wipe memory, re-hydrate from the same DATA_DIR.
    const h = hydrateChurnBrakeGuardFromDisk(dir, TRADING_TIME + 25 * 60 * 60 * 1000);
    expect(h.records).toBe(3);
    expect(h.days).toBe(2);

    const s = summarizeChurnBrakeGuard();
    expect(s.opensPresented).toBe(3);
    expect(s.opensEvaluated).toBe(3);
    expect(s.opensRejected).toBe(1);
    expect(s.etDays).toEqual(['2024-06-04', '2024-06-05']);
    expect(s.durability.hydratedRecords).toBe(3);
    expect(s.durability.hydratedDays).toBe(2);
    expect(s.durability.dataDir).toBe(dir);
    expect(s.durability.appendErrors).toBe(0);
  });

  it('hydrate drops lines outside the retention window and compacts the file', () => {
    const old = guardEvent({ ts: TRADING_TIME - 40 * 24 * 60 * 60 * 1000, etDay: '2024-04-25' });
    const fresh = guardEvent({ blocked: true, count: 6, cap: 6 });
    writeFileSync(
      churnBrakeGuardLogPath(dir),
      JSON.stringify(old) + '\n' + JSON.stringify(fresh) + '\n' + '{"torn', // torn tail line
      'utf8',
    );
    const h = hydrateChurnBrakeGuardFromDisk(dir, TRADING_TIME);
    expect(h.records).toBe(1);
    const s = summarizeChurnBrakeGuard();
    expect(s.etDays).toEqual(['2024-06-04']);
    expect(s.opensRejected).toBe(1);
    // Compaction rewrote the file to the single retained line.
    const lines = readFileSync(churnBrakeGuardLogPath(dir), 'utf8').split('\n').filter(l => l.trim() !== '');
    expect(lines).toHaveLength(1);
  });

  it('a malformed blocked-while-dark line cannot break rejected ≤ evaluated', () => {
    recordChurnBrakeGuardEvent(guardEvent({ guardEnabled: false, blocked: true }));
    const s = summarizeChurnBrakeGuard();
    expect(s.opensPresented).toBe(1);
    expect(s.opensEvaluated).toBe(0);
    expect(s.opensRejected).toBe(0);
    expect(s.state).toBe('dark');
  });

  it('no candidates at all reads no_candidates, never a healthy zero', () => {
    expect(summarizeChurnBrakeGuard().state).toBe('no_candidates');
  });
});

describe('TRA-4335 defect 2 — deterministic exit stamp on the book-halt flatten', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
    return {
      id: 'sig-4335',
      symbol: 'IONQ',
      type: 'otm_mispricing',
      side: 'buy',
      entryPrice: 1.0,
      stopLoss: 0.75,
      takeProfit: 1.5,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
      optionSymbol: 'IONQ261009C00039000',
      optionType: 'call',
      strike: 39,
      expiration: '2026-10-09',
      mark: 1.0,
      theo: 1.3,
      mispricingPct: -0.23,
      delta: 0.18,
      ...overrides,
    };
  }

  function openCall(): { acct: PaperOptionsAccount; id: string } {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal(), 'demo', undefined, 200);
    expect(pos).not.toBeNull();
    return { acct, id: pos!.id };
  }

  it('re-stamps `profit_lock` when the flattened row was lock-eligible at the close mark', () => {
    const { acct, id } = openCall();
    const open = acct.getState().openOptions[0];
    // A peak well past the arm (peakR ≫ 0.75) with the close mark retraced past
    // the give-back allowance — exactly the state the 2026-09-03 twins were in.
    open.peakPremium = 2.0;
    const closed = acct.closeOption(id, 1.1, 'book_halt_flat');
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('profit_lock');
    expect(acct.getState().closedOptions[0].exitReason).toBe('profit_lock');
  });

  it('keeps `book_halt_flat` on a row the halt alone closed (lock never armed)', () => {
    const { acct, id } = openCall();
    // No peak beyond entry: the profit lock is disarmed, so the halt is the cause.
    const closed = acct.closeOption(id, 0.95, 'book_halt_flat');
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('book_halt_flat');
    expect(acct.getState().closedOptions[0].exitReason).toBe('book_halt_flat');
  });

  it('does not touch any other close reason (manual stays manual on a lock-eligible row)', () => {
    const { acct, id } = openCall();
    const open = acct.getState().openOptions[0];
    open.peakPremium = 2.0;
    const closed = acct.closeOption(id, 1.1);
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('manual');
  });
});

describe('TRA-4335 defect 3 — strategies_inactive_on_tick sub-cause on the funnel', () => {
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  it('carries the detail beside the reason on a live engine', () => {
    recordEquityEntryPassGated('live', 'engine-2', 'strategies_inactive_on_tick', TRADING_TIME, 'live_equity_toggle_off');
    const live = summarizeEquityEntryFunnel().live;
    expect(live).toHaveLength(1);
    expect(live[0].passGateBlockedReason).toBe('strategies_inactive_on_tick');
    expect(live[0].passGateBlockedDetail).toBe('live_equity_toggle_off');
  });

  it('drops a stray detail on any other reason so the pair cannot disagree', () => {
    recordEquityEntryPassGated('live', 'engine-1', 'market_closed', TRADING_TIME, 'live_equity_client_missing');
    const live = summarizeEquityEntryFunnel().live;
    expect(live[0].passGateBlockedReason).toBe('market_closed');
    expect(live[0].passGateBlockedDetail).toBeNull();
  });

  it('stays null when no detail is recorded (existing callers unchanged)', () => {
    recordEquityEntryPassGated('demo', 'engine-9', 'market_closed');
    const demo = summarizeEquityEntryFunnel().demo;
    expect(demo[0].passGateBlockedDetail).toBeNull();
  });
});
