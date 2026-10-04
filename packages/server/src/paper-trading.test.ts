// TRA-4657 — the paper book proven to (a) fill at the touch, never the mid,
// (b) be BORN under the TRA-4655 choke point (a refusal is logged, not
// dropped, and never enters the book), (c) settle theoretical P&L net of
// spread + commissions, (d) fold an honest daily summary, and (e) carry the
// zero-live-orders property structurally (no broker import exists to call).

import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  __resetHardControlsForTest,
  engageHardKillSwitch,
  hydrateHardControlsFromDisk,
  requestForceCloseAll,
} from './hard-controls.js';
import {
  appendEngineBasisRestatement,
  configureEngineBasisRestatementLog,
} from './engine-basis-restatement-log.js';
import { etDateKey } from './et-clock.js';
import {
  buildPaperDailySummary,
  forceCloseAllPaperPositions,
  getPaperLedgerRowsForDay,
  getPaperTradingState,
  initPaperTrading,
  isPaperTradingEnabled,
  PAPER_EQUITY_HALF_SPREAD_FRAC,
  paperLedgerFlushForTests,
  recordPaperEquityClose,
  recordPaperEquityOpen,
  recordPaperOptionClose,
  recordPaperOptionOpen,
  recordPaperSignal,
  setPaperTradingLedgerFileForTests,
  simulatePaperFill,
  BASIS_DELTA_ZERO_EPSILON_USD,
  classifyBasisDelta,
  type PaperCloseRow,
  type PaperOpenRow,
} from './paper-trading.js';

// A weekday mid-session instant: 2026-09-16 14:00 ET (same as hard-controls').
const NOW = Date.parse('2026-09-16T18:00:00.000Z');
const ET_DAY = '2026-09-16';

let dir: string;
let idSeq = 0;

function optOpen(overrides: Record<string, unknown> = {}) {
  return {
    id: `opt-${++idSeq}`,
    symbol: 'ABC',
    optionSymbol: 'ABC260918C00100000',
    contracts: 1,
    premiumPaid: 1.0,
    openedAt: NOW - 1_000,
    signalId: `sig-${idSeq}`,
    entryBidAtOpen: 0.9,
    entryAskAtOpen: 1.1,
    entrySpreadPct: 0.2,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paper-trading-'));
  setPaperTradingLedgerFileForTests(join(dir, 'paper-trading.jsonl'));
  __resetHardControlsForTest({ dataDir: dir, nowMs: NOW });
  hydrateHardControlsFromDisk(NOW);
  process.env['ENABLE_PAPER_TRADING'] = '1';
  delete process.env['PAPER_FILL_AGGRESSION'];
});

afterEach(() => {
  delete process.env['ENABLE_PAPER_TRADING'];
  delete process.env['PAPER_FILL_AGGRESSION'];
  setPaperTradingLedgerFileForTests(null);
});

describe('fill math — at the touch, never the mid', () => {
  it('a full-aggression buy fills AT THE ASK off a real quote', () => {
    const f = simulatePaperFill({ side: 'buy', midPerShare: 1.0, bid: 0.9, ask: 1.1, aggression: 1 });
    expect(f.fillPerShare).toBeCloseTo(1.1, 10);
    expect(f.spreadSource).toBe('quoted');
    expect(f.slippagePerShare).toBeCloseTo(0.1, 10);
  });

  it('a full-aggression sell fills AT THE BID', () => {
    const f = simulatePaperFill({ side: 'sell', midPerShare: 1.0, bid: 0.9, ask: 1.1, aggression: 1 });
    expect(f.fillPerShare).toBeCloseTo(0.9, 10);
  });

  it('slippage = halfSpread × aggression (the AC formula), at f = 0.5', () => {
    const f = simulatePaperFill({ side: 'buy', midPerShare: 1.0, bid: 0.9, ask: 1.1, aggression: 0.5 });
    expect(f.slippagePerShare).toBeCloseTo(0.05, 10);
    expect(f.fillPerShare).toBeCloseTo(1.05, 10);
  });

  it('no quote ⇒ falls back to the stamped entry spread, then the default haircut — never a free mid fill', () => {
    const fromStamp = simulatePaperFill({ side: 'buy', midPerShare: 2.0, entrySpreadPct: 0.2, aggression: 1 });
    expect(fromStamp.spreadSource).toBe('modeled_entry_spread');
    expect(fromStamp.fillPerShare).toBeCloseTo(2.0 + 2.0 * 0.1, 10);

    const fromDefault = simulatePaperFill({ side: 'buy', midPerShare: 2.0, aggression: 1 });
    expect(fromDefault.spreadSource).toBe('modeled_default');
    expect(fromDefault.slippagePerShare).toBeGreaterThan(0);
  });

  it('equity fills use the modeled bps half-spread', () => {
    const f = simulatePaperFill({ side: 'buy', midPerShare: 100, aggression: 1, equityModeled: true });
    expect(f.spreadSource).toBe('modeled_equity');
    expect(f.fillPerShare).toBeCloseTo(100 * (1 + PAPER_EQUITY_HALF_SPREAD_FRAC), 10);
  });
});

describe('born under the choke point (TRA-4655 contract)', () => {
  it('an admitted open books at the ask and lands in the paper book', () => {
    const r = recordPaperOptionOpen(optOpen(), 'demo', NOW);
    expect(r).toEqual({ recorded: true, admitted: true });
    const rows = getPaperLedgerRowsForDay(ET_DAY);
    const open = rows.find((x) => x.kind === 'open') as PaperOpenRow;
    expect(open.admit.allowed).toBe(true);
    expect(open.fill.fillPerShare).toBeCloseTo(1.1, 10);
    expect(open.notionalUsd).toBeCloseTo(110, 10);
    expect(getPaperTradingState().openPositions).toHaveLength(1);
  });

  it('a kill-switch refusal is LOGGED as a refusal and never enters the book', () => {
    engageHardKillSwitch('cto', 'drill', NOW);
    const r = recordPaperOptionOpen(optOpen(), 'demo', NOW);
    expect(r).toEqual({ recorded: true, admitted: false });
    const open = getPaperLedgerRowsForDay(ET_DAY).find((x) => x.kind === 'open') as PaperOpenRow;
    expect(open.admit.reasonCode).toBe('kill_switch_engaged');
    expect(getPaperTradingState().openPositions).toHaveLength(0);
  });

  it('the paper book rehearses the 3-position cap: the 4th open is refused', () => {
    for (let i = 0; i < 3; i++) {
      expect(recordPaperOptionOpen(optOpen(), 'demo', NOW).admitted).toBe(true);
    }
    const fourth = recordPaperOptionOpen(optOpen(), 'demo', NOW);
    expect(fourth.admitted).toBe(false);
    const refusals = getPaperLedgerRowsForDay(ET_DAY)
      .filter((x): x is PaperOpenRow => x.kind === 'open' && !x.admit.allowed);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].admit.reasonCode).toBe('max_open_positions');
  });

  it('the $300 notional cap grades the THEORETICAL (ask-side) notional', () => {
    // mid 2.75 × 100 = $275 clears the cap; ask 3.10 × 100 = $310 must not.
    const r = recordPaperOptionOpen(
      optOpen({ premiumPaid: 2.75, entryBidAtOpen: 2.4, entryAskAtOpen: 3.1 }),
      'demo',
      NOW,
    );
    expect(r.admitted).toBe(false);
    const open = getPaperLedgerRowsForDay(ET_DAY).find((x) => x.kind === 'open') as PaperOpenRow;
    expect(open.admit.reasonCode).toBe('max_order_notional');
  });

  it('a replayed position id is refused as a duplicate (idempotency consumed)', async () => {
    const o = optOpen();
    expect(recordPaperOptionOpen(o, 'demo', NOW).admitted).toBe(true);
    await paperLedgerFlushForTests();
    // Same id replayed after a restart (memory gone, ledger + hard-controls
    // idempotency map on disk): refused, book unchanged.
    setPaperTradingLedgerFileForTests(join(dir, 'paper-trading.jsonl'));
    const again = recordPaperOptionOpen(o, 'demo', NOW);
    expect(again.admitted).toBe(false);
    expect(getPaperTradingState().openPositions).toHaveLength(1);
  });
});

describe('closes settle theoretical P&L net of spread + commissions', () => {
  it('open at ask, close at bid: both crossings and both commissions charged', () => {
    const o = optOpen(); // mid 1.00, fill 1.10
    recordPaperOptionOpen(o, 'demo', NOW);
    recordPaperOptionClose(
      { id: o.id, symbol: o.symbol, optionSymbol: o.optionSymbol, contracts: 1, currentPremium: 1.5, closedAt: NOW + 60_000, entrySpreadPct: 0.2, pnl: 50, exitReason: 'tp1' },
      'demo',
    );
    const close = getPaperLedgerRowsForDay(ET_DAY).find((x) => x.kind === 'close') as PaperCloseRow;
    // exit mid 1.50, stamped spread 20% ⇒ half-spread 0.15 ⇒ sell fills 1.35.
    expect(close.fill.fillPerShare).toBeCloseTo(1.35, 10);
    // (1.35 − 1.10) × 100 − 0.65 − 0.65 = 23.70 vs the demo book's gross $50.
    expect(close.paperPnlUsd).toBeCloseTo(23.7, 10);
    expect(close.demoPnlUsd).toBe(50);
    expect(close.matchedOpen).toBe(true);
    expect(getPaperTradingState().openPositions).toHaveLength(0);
  });

  it('a close with no admitted open settles nothing and says so', () => {
    recordPaperOptionClose(
      { id: 'never-opened', symbol: 'ABC', contracts: 1, currentPremium: 1.0, closedAt: NOW },
      'demo',
    );
    const close = getPaperLedgerRowsForDay(ET_DAY).find((x) => x.kind === 'close') as PaperCloseRow;
    expect(close.matchedOpen).toBe(false);
    expect(close.paperPnlUsd).toBeNull();
    expect(buildPaperDailySummary(ET_DAY).unmatchedCloses).toBe(1);
  });

  it('an equity round trip charges the modeled spread on both legs', () => {
    const id = 'eq-1';
    recordPaperEquityOpen(
      { id, symbol: 'XYZ', side: 'buy', entryPrice: 100, quantity: 2, openedAt: NOW - 1_000 },
      'demo',
      NOW,
    );
    recordPaperEquityClose(
      { id, symbol: 'XYZ', side: 'buy', quantity: 2, exitPrice: 100, closedAt: NOW + 1_000, pnl: 0 },
      'demo',
    );
    const close = getPaperLedgerRowsForDay(ET_DAY).find((x) => x.kind === 'close') as PaperCloseRow;
    // Flat mid-to-mid, so paper P&L is exactly minus both half-spread legs.
    expect(close.paperPnlUsd).toBeCloseTo(-2 * 100 * PAPER_EQUITY_HALF_SPREAD_FRAC * 2, 10);
  });
});

describe('daily summary (AC 4)', () => {
  it('folds signals, admitted/refused opens, closes, slippage and P&L for the day', () => {
    recordPaperSignal(
      { id: 's1', symbol: 'ABC', type: 'orb_breakout', side: 'buy', entryPrice: 10, stopLoss: 9, takeProfit: 12, riskRewardRatio: 2, timestamp: NOW - 5_000 },
      'demo',
    );
    const o = optOpen();
    recordPaperOptionOpen(o, 'demo', NOW);
    engageHardKillSwitch('cto', 'drill', NOW);
    recordPaperOptionOpen(optOpen(), 'demo', NOW); // refused
    const s = buildPaperDailySummary(ET_DAY);
    expect(s.signals).toBe(1);
    expect(s.opens.admitted).toBe(1);
    expect(s.opens.refused).toBe(1);
    expect(s.opens.refusedByReason['kill_switch_engaged']).toBe(1);
    // One admitted open: slippage 0.10/share × 100 = $10, commission $0.65.
    expect(s.slippageAssumedUsd).toBeCloseTo(10, 10);
    expect(s.commissionAssumedUsd).toBeCloseTo(0.65, 10);
    expect(s.openPositionsNow).toBe(1);
    expect(s.enabled).toBe(true);
  });
});

describe('force-close (control 7, the paper leg)', () => {
  it('flattens every open paper row and stamps the marks stale', async () => {
    recordPaperOptionOpen(optOpen(), 'demo', NOW);
    recordPaperOptionOpen(optOpen(), 'demo', NOW);
    const r = await forceCloseAllPaperPositions(NOW + 10_000);
    expect(r).toEqual({ closed: 2, errors: [] });
    const fc = getPaperLedgerRowsForDay(ET_DAY).filter((x) => x.kind === 'force_close') as PaperCloseRow[];
    expect(fc).toHaveLength(2);
    expect(fc.every((x) => x.markStale === true && x.paperPnlUsd === null)).toBe(true);
    const s = buildPaperDailySummary(ET_DAY);
    expect(s.forceCloses).toBe(2);
    // Stale marks never price the P&L — and TRA-4874: that is published as `null`
    // under `only_force_closes`, not as a `0` indistinguishable from a flat day.
    expect(s.theoreticalRealizedPnlUsd).toBeNull();
    expect(s.pnlBasis).toBe('only_force_closes');
    expect(getPaperTradingState().openPositions).toHaveLength(0);
  });

  it('initPaperTrading registers the paper-book handler on the shared registry', async () => {
    initPaperTrading();
    recordPaperOptionOpen(optOpen(), 'demo', NOW);
    const result = await requestForceCloseAll('cto', 'drill', NOW);
    const paper = result.handlers.find((h) => h.name === 'paper-book');
    expect(paper?.ok).toBe(true);
    expect(paper?.closed).toBe(1);
  });
});

describe('flag + persistence + zero-live-orders', () => {
  it('flag off ⇒ every recorder is inert and reports so', () => {
    delete process.env['ENABLE_PAPER_TRADING'];
    expect(isPaperTradingEnabled()).toBe(false);
    expect(recordPaperSignal({ id: 's', symbol: 'A', type: 't', timestamp: NOW }, 'demo')).toEqual({ recorded: false });
    expect(recordPaperOptionOpen(optOpen(), 'demo', NOW)).toEqual({ recorded: false });
    expect(recordPaperEquityClose({ id: 'x', symbol: 'A', side: 'buy', quantity: 1 }, 'demo')).toEqual({ recorded: false });
    expect(getPaperLedgerRowsForDay(ET_DAY)).toHaveLength(0);
  });

  it('the fold survives a restart: rows and open book rebuild from disk', async () => {
    const file = join(dir, 'paper-trading.jsonl');
    const o = optOpen();
    recordPaperOptionOpen(o, 'demo', NOW);
    recordPaperSignal({ id: 's1', symbol: 'ABC', type: 'orb', timestamp: NOW }, 'demo');
    await paperLedgerFlushForTests();
    // Simulate a process restart: same file, empty memory.
    setPaperTradingLedgerFileForTests(file);
    const state = getPaperTradingState();
    expect(state.rowsLoaded).toBe(2);
    expect(state.openPositions).toHaveLength(1);
    expect(state.openPositions[0].positionId).toBe(o.id);
  });

  it('a corrupt ledger line is skipped, never fatal', async () => {
    const file = join(dir, 'paper-trading.jsonl');
    recordPaperSignal({ id: 's1', symbol: 'ABC', type: 'orb', timestamp: NOW }, 'demo');
    await paperLedgerFlushForTests();
    writeFileSync(file, `${readFileSync(file, 'utf-8')}{not json\n`, 'utf-8');
    setPaperTradingLedgerFileForTests(file);
    expect(getPaperTradingState().rowsLoaded).toBe(1);
  });

  it('ZERO live orders, structurally: the module imports no broker client', () => {
    const src = readFileSync(join(__dirname, 'paper-trading.ts'), 'utf-8');
    const imports = src.split('\n').filter((l) => /^import /.test(l) || /from '\.\.?\//.test(l));
    for (const line of imports) {
      expect(line).not.toMatch(/tradier|coinbase|okx|broker|smart-open|@trading-app\/engine/i);
    }
    // And no HTTP client of any kind to smuggle one in.
    expect(src).not.toMatch(/\bfetch\s*\(|axios|https?\.request/);
  });
});

// ---------------------------------------------------------------------------
// TRA-4781 — the two P&L legs do not share an entry basis, and the payload
// must SAY so. The defect these cover is not a wrong number: it is that a
// shared-basis payload and a split-basis payload were byte-indistinguishable.
// ---------------------------------------------------------------------------

describe('TRA-4781 — the basis split is readable on the row', () => {
  function restatement(positionId: string, before: number, after: number, contracts = 2) {
    return {
      ts: NOW,
      positionId,
      optionSymbol: 'ABC260918C00100000',
      contracts,
      premiumPaidBefore: before,
      premiumPaidAfter: after,
      ratio: after / before,
      brokerCostBasisUsd: after * contracts * 100,
      tp1PremiumBefore: before * 1.5,
      tp1PremiumAfter: after * 1.5,
      stopLossPremiumBefore: before * 0.5,
      stopLossPremiumAfter: after * 0.5,
      trailingStopPremiumBefore: 0,
      trailingStopPremiumAfter: 0,
      trailingActive: false,
      tp1RatioBefore: 1.5,
      tp1RatioAfter: 1.5,
      stopRatioBefore: 0.5,
      stopRatioAfter: 0.5,
    };
  }

  function closeRows(): PaperCloseRow[] {
    return getPaperLedgerRowsForDay(ET_DAY).filter((r): r is PaperCloseRow => r.kind === 'close');
  }

  it('THE BRIDGE: demo − theoretical = spread + commissions + basisDeltaUsd, to the cent', () => {
    configureEngineBasisRestatementLog(dir);
    const open = optOpen({ id: 'bridge-1', contracts: 2, premiumPaid: 1.0, entryBidAtOpen: 0.9, entryAskAtOpen: 1.1 });
    recordPaperOptionOpen(open, 'paper', NOW);
    // The reconcile moves the engine's basis to broker truth 23s later; the
    // tee is NEVER told, which is the whole defect.
    appendEngineBasisRestatement(dir, restatement('bridge-1', 1.0, 0.95));
    recordPaperOptionClose({
      id: 'bridge-1', symbol: 'ABC', optionSymbol: 'ABC260918C00100000', contracts: 2,
      currentPremium: 1.5, entrySpreadPct: 0.2, closedAt: NOW,
      premiumPaid: 0.95,             // restated — what `pnl` below was struck against
      pnl: (1.5 - 0.95) * 2 * 100,   // 110.00, the engine's own demo number
    }, 'paper');

    const row = closeRows()[0]!;
    expect(row.entryBasisAtOpen).toBeCloseTo(1.0, 10);
    expect(row.entryBasisRestated).toBeCloseTo(0.95, 10);
    expect(row.basisDeltaUsd).toBeCloseTo(10.0, 10);
    expect(row.basisRestatementCount).toBe(1);

    // The legs themselves are UNCHANGED — this ticket makes the split legible,
    // it does not restate the tee (TRA-4781 §2: additive, never mutating).
    expect(row.demoPnlUsd).toBeCloseTo(110.0, 10);
    expect(row.paperPnlUsd).toBeCloseTo(47.4, 10);

    const s = buildPaperDailySummary(ET_DAY);
    // TRA-4874 — the bridge is only computable over a non-empty population, and
    // the payload now SAYS which it is. Assert that before subtracting.
    expect(s.pnlBasis).toBe('matched_closes');
    expect(s.demoPnlCloses).toBe(1);
    const gap = s.demoRealizedPnlUsd! - s.theoreticalRealizedPnlUsd!;
    expect(gap).toBeCloseTo(62.6, 10);
    // Residual $0.0000 — the same control the live 2026-09-22 fixture ran.
    expect(gap - (s.slippageAssumedUsd + s.commissionAssumedUsd + s.basisDeltaUsd)).toBeCloseTo(0, 10);
    expect(s.basisDeltaUsd).toBeCloseTo(10.0, 10);
    expect(s.basisCloses).toEqual({ inFold: 1, unreadable: 0, unstamped: 0, neverRestated: 0 });
  });

  it('⛔ THE DISCRIMINATOR: never-restated and restated-at-zero-delta are NOT the same row', () => {
    configureEngineBasisRestatementLog(dir);
    // A: the restatement landed and happened to move nothing.
    recordPaperOptionOpen(optOpen({ id: 'zero-delta', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    appendEngineBasisRestatement(dir, restatement('zero-delta', 1.0, 1.0, 1));
    recordPaperOptionClose({
      id: 'zero-delta', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 1.0, pnl: 20,
    }, 'paper');

    // B: a `quantity_mismatch` row the restatement never reached at all.
    recordPaperOptionOpen(optOpen({ id: 'never', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'never', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 1.0, pnl: 20,
    }, 'paper');

    const [a, b] = closeRows();
    // Identical on every pre-TRA-4781 field — this is what made them the same row.
    expect(a!.basisDeltaUsd).toBeCloseTo(0, 10);
    expect(b!.basisDeltaUsd).toBeCloseTo(0, 10);
    expect(a!.demoPnlUsd).toBe(b!.demoPnlUsd);
    expect(a!.paperPnlUsd).toBe(b!.paperPnlUsd);
    // ...and separated only by the census.
    expect(a!.basisRestatementCount).toBe(1);
    expect(b!.basisRestatementCount).toBe(0);
    expect(a!.basisRestatementCount).not.toBe(b!.basisRestatementCount);

    const s = buildPaperDailySummary(ET_DAY);
    expect(s.basisCloses).toEqual({ inFold: 2, unreadable: 0, unstamped: 0, neverRestated: 1 });
  });

  it('an UNREADABLE census is null, never 0 — it must not read as "never restated"', () => {
    configureEngineBasisRestatementLog(join(dir, 'no-such-dir'));
    recordPaperOptionOpen(optOpen({ id: 'blind', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'blind', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 1.0, pnl: 20,
    }, 'paper');

    const row = closeRows()[0]!;
    expect(row.basisRestatementCount).toBeNull();
    expect(row.basisRestatementCount).not.toBe(0);
    // An unreadable row is NOT folded into the basis total as a zero.
    const s = buildPaperDailySummary(ET_DAY);
    expect(s.basisCloses).toEqual({ inFold: 0, unreadable: 1, unstamped: 0, neverRestated: 0 });
    expect(s.basisDeltaUsd).toBe(0);
  });

  it('a row written BEFORE this shipped buckets as `unstamped`, not as a zero delta', () => {
    const file = join(dir, 'legacy.jsonl');
    // A pre-TRA-4781 close row: no basis fields on it at all.
    writeFileSync(file, `${JSON.stringify({
      kind: 'close', instrument: 'option', atMs: NOW, etDay: ET_DAY, mode: 'paper',
      positionId: 'legacy-1', symbol: 'ABC', occ: null, exitReason: 'tp', qty: 1, multiplier: 100,
      midPerShare: 1.2, fill: { fillPerShare: 1.08, slippagePerShare: 0.12, spreadSource: 'modeled_entry_spread', halfSpreadFrac: 0.1, aggression: 1 },
      commissionUsd: 0.65, demoPnlUsd: 20, paperPnlUsd: 18, matchedOpen: true,
    })}\n`, 'utf-8');
    setPaperTradingLedgerFileForTests(file);

    const s = buildPaperDailySummary(ET_DAY);
    expect(s.basisCloses).toEqual({ inFold: 0, unreadable: 0, unstamped: 1, neverRestated: 0 });
    expect(s.basisDeltaUsd).toBe(0);
    // The legacy row's own P&L still counts — only its basis term is unknown.
    expect(s.demoRealizedPnlUsd).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// TRA-4874 item 4 — `theoreticalRealizedPnlUsd: 0` was byte-identical across a
// measured breakeven, a no-trade day, a flattened day and a day where every
// close was unbookable (the real 2026-09-23 / 09-24 sessions, 12 unmatched
// closes each). The row level was already honest; the DAY SUMMARY flattened it.
// These cover the separation, not a changed number.
// ---------------------------------------------------------------------------

describe('TRA-4874 — the day summary cannot publish a zero it never measured', () => {
  /** A hand-written matched close, so a MEASURED zero is expressible exactly. */
  function legacyClose(overrides: Record<string, unknown>): string {
    return `${JSON.stringify({
      kind: 'close', instrument: 'option', atMs: NOW, etDay: ET_DAY, mode: 'paper',
      positionId: 'm-1', symbol: 'ABC', occ: null, exitReason: 'tp', qty: 1, multiplier: 100,
      midPerShare: 1.2,
      fill: { fillPerShare: 1.08, slippagePerShare: 0.12, spreadSource: 'modeled_entry_spread', halfSpreadFrac: 0.1, aggression: 1 },
      commissionUsd: 0, demoPnlUsd: 0, paperPnlUsd: 0, matchedOpen: true,
      entryBasisAtOpen: 1.2, entryBasisRestated: 1.2, basisDeltaUsd: 0, basisRestatementCount: 1,
      ...overrides,
    })}\n`;
  }

  function seed(lines: string): void {
    const file = join(dir, 'tra4874.jsonl');
    writeFileSync(file, lines, 'utf-8');
    setPaperTradingLedgerFileForTests(file);
  }

  it('⛔ THE DISCRIMINATOR: a MEASURED breakeven and an ALL-UNBOOKABLE day are no longer the same payload', () => {
    // A — one matched close that really did settle at exactly zero.
    seed(legacyClose({}));
    const measured = buildPaperDailySummary(ET_DAY);
    expect(measured.theoreticalRealizedPnlUsd).toBe(0);
    expect(measured.pnlBasis).toBe('matched_closes');
    expect(measured.pnlCloses).toEqual({ inFold: 1, unmatched: 0, noMark: 0 });

    // B — the 2026-09-23 shape: closes landed, not one could be settled.
    setPaperTradingLedgerFileForTests(join(dir, 'b.jsonl'));
    for (let i = 0; i < 12; i++) {
      recordPaperOptionClose(
        { id: `unbookable-${i}`, symbol: 'MSTR', contracts: 1, currentPremium: 1.0, closedAt: NOW, pnl: -5 },
        'paper',
      );
    }
    const unbookable = buildPaperDailySummary(ET_DAY);
    expect(unbookable.closes).toBe(12);
    expect(unbookable.unmatchedCloses).toBe(12);
    expect(unbookable.theoreticalRealizedPnlUsd).toBeNull();
    expect(unbookable.pnlBasis).toBe('all_closes_unbookable');
    expect(unbookable.pnlCloses).toEqual({ inFold: 0, unmatched: 12, noMark: 0 });

    // The cell that used to carry the whole story: identical. That is the defect.
    const asPublishedBefore = (s: { theoreticalRealizedPnlUsd: number | null }) => s.theoreticalRealizedPnlUsd ?? 0;
    expect(asPublishedBefore(measured)).toBe(asPublishedBefore(unbookable));
    expect(measured.pnlBasis).not.toBe(unbookable.pnlBasis);

    // And the demo leg survives the same day — a real number beside a null
    // theoretical is itself the tell that closes happened and none were bookable.
    expect(unbookable.demoRealizedPnlUsd).toBe(-60);
    expect(unbookable.demoPnlCloses).toBe(12);
  });

  it('a NO-TRADE day and a FLATTENED day are separated too, and neither publishes a number', async () => {
    const quiet = buildPaperDailySummary(ET_DAY);
    expect(quiet.closes).toBe(0);
    expect(quiet.theoreticalRealizedPnlUsd).toBeNull();
    expect(quiet.demoRealizedPnlUsd).toBeNull();
    expect(quiet.pnlBasis).toBe('no_closes');

    recordPaperOptionOpen(optOpen(), 'paper', NOW);
    await forceCloseAllPaperPositions(NOW + 5_000);
    const flattened = buildPaperDailySummary(ET_DAY);
    expect(flattened.forceCloses).toBe(1);
    expect(flattened.closes).toBe(0); // a force-close is not a settleable close
    expect(flattened.theoreticalRealizedPnlUsd).toBeNull();
    expect(flattened.pnlBasis).toBe('only_force_closes');
    expect(flattened.pnlBasis).not.toBe(quiet.pnlBasis);
  });

  it('the denominator is an EXHAUSTIVE partition: inFold + unmatched + noMark === closes', () => {
    // inFold: a real matched round trip.
    const o = optOpen({ id: 'in-fold' });
    recordPaperOptionOpen(o, 'paper', NOW);
    recordPaperOptionClose(
      { id: o.id, symbol: o.symbol, optionSymbol: o.optionSymbol, contracts: 1, currentPremium: 1.5, entrySpreadPct: 0.2, closedAt: NOW, pnl: 50 },
      'paper',
    );
    // unmatched: never opened.
    recordPaperOptionClose({ id: 'nope', symbol: 'ABC', contracts: 1, currentPremium: 1.0, closedAt: NOW, pnl: 1 }, 'paper');
    // noMark: matched, but the exit price is missing ⇒ mid 0 ⇒ no P&L to strike.
    recordPaperEquityOpen({ id: 'eq-nm', symbol: 'XYZ', side: 'buy', entryPrice: 10, quantity: 1, openedAt: NOW - 1_000 }, 'paper', NOW);
    recordPaperEquityClose({ id: 'eq-nm', symbol: 'XYZ', side: 'buy', quantity: 1, closedAt: NOW, pnl: 3 }, 'paper');

    const s = buildPaperDailySummary(ET_DAY);
    expect(s.pnlCloses).toEqual({ inFold: 1, unmatched: 1, noMark: 1 });
    expect(s.pnlCloses.inFold + s.pnlCloses.unmatched + s.pnlCloses.noMark).toBe(s.closes);
    // One row folded, so the total is MEASURED — over a population of one, named.
    expect(s.pnlBasis).toBe('matched_closes');
    expect(s.theoreticalRealizedPnlUsd).toBeCloseTo(23.7, 10);
    // ⛔ And the noMark row is NOT the unmatched row: `unmatchedCloses` counts 1,
    // the P&L denominator excludes 2. Reading either as the other is the bug.
    expect(s.unmatchedCloses).toBe(1);
  });

  it('the route payload carries the discriminator, not just the type (state + summary agree)', () => {
    // `getPaperTradingState().today` folds the CURRENT ET day, not the fixture's,
    // so the row has to be stamped today or the route reads an empty day.
    const today = etDateKey(Date.now());
    seed(legacyClose({ etDay: today, atMs: Date.now(), paperPnlUsd: null, matchedOpen: false, demoPnlUsd: null }));
    const state = getPaperTradingState();
    expect(state.today.etDay).toBe(today);
    expect(state.today.closes).toBe(1);
    expect(state.today.theoreticalRealizedPnlUsd).toBeNull();
    expect(state.today.demoRealizedPnlUsd).toBeNull();
    expect(state.today.pnlBasis).toBe('all_closes_unbookable');
    expect(state.today.pnlCloses.unmatched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TRA-5010 — `basisRestatementCount` explains ONE FAMILY of the writers of
// `premiumPaid`, and it was being read as a complete account of the basis gap.
//
// The durable restatement log has FOUR feeders; `premiumPaid` is assigned at
// TWELVE sites. So `basisDeltaUsd != 0` next to `basisRestatementCount: 0` is a
// legitimate live reading — "the basis moved, through a path that does not
// append" — and the shipped doc comment said the opposite ("a basisDeltaUsd of
// 0.00 is structural"). A consumer drew the inverse conclusion from the same
// bytes, which is the TRA-4781 defect re-appearing inside TRA-4781's own fix.
//
// Confirmed on bqb1 2026-09-28 (`faae938837bf`): the census read
// `logPresent: true, count: 22, malformedLines: 0`, newest record
// 2026-09-01T19:08:40Z — while TRA-4781's own 2026-09-22 fixture moved the basis
// by $13.80 net across four pairs, BOTH WAYS (GME +17.22, TLT -8.93). Readable
// census, zero records, basis moved anyway.
//
// These cover the SEPARATION, not a changed number. Nothing below widens the
// census: that would destroy its one clean property (an append-only log).
// ---------------------------------------------------------------------------

describe('TRA-5010 — a measured 0 does not mean the basis never moved', () => {
  function closeRows(): PaperCloseRow[] {
    return getPaperLedgerRowsForDay(ET_DAY).filter((r): r is PaperCloseRow => r.kind === 'close');
  }
  function restatement(positionId: string, before: number, after: number, contracts = 1) {
    return {
      ts: NOW, positionId, optionSymbol: 'ABC260918C00100000', contracts,
      premiumPaidBefore: before, premiumPaidAfter: after, ratio: after / before,
      brokerCostBasisUsd: after * contracts * 100,
      tp1PremiumBefore: before * 1.5, tp1PremiumAfter: after * 1.5,
      stopLossPremiumBefore: before * 0.5, stopLossPremiumAfter: after * 0.5,
      trailingStopPremiumBefore: 0, trailingStopPremiumAfter: 0, trailingActive: false,
      tp1RatioBefore: 1.5, tp1RatioAfter: 1.5, stopRatioBefore: 0.5, stopRatioAfter: 0.5,
    };
  }

  it('★ THE DEFECT: a basis that MOVED with an empty census reads `unlogged_writer`, not "structural"', () => {
    configureEngineBasisRestatementLog(dir);
    // The LIVE condition, reproduced: the log EXISTS and is readable and holds
    // records for OTHER positions (bqb1 2026-09-28: `logPresent: true, count: 22`)
    // — just none for this row. Without a seed the census reads `null` (absent
    // file), which is a different cell entirely and would not exercise this one.
    appendEngineBasisRestatement(dir, restatement('some-other-row', 1.0, 0.9));
    // The 2026-09-22 shape: the tee anchored at 1.00, the engine settled against
    // 0.95, and NOTHING appended. On live code that is `average_on_add` or the
    // adoption overwrite; the census cannot see either.
    recordPaperOptionOpen(optOpen({ id: 'moved-unlogged', contracts: 2, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'moved-unlogged', symbol: 'ABC', contracts: 2, currentPremium: 1.5,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 0.95, pnl: (1.5 - 0.95) * 2 * 100,
      basisWriter: 'average_on_add',
    }, 'paper');

    const row = closeRows()[0]!;
    // The census is READABLE and it holds nothing — a measured 0, not a null.
    expect(row.basisRestatementCount).toBe(0);
    // And the basis moved $10.00 anyway. These two cells together are the point.
    expect(row.basisDeltaUsd).toBeCloseTo(10.0, 10);
    expect(row.basisDeltaAttribution).toBe('unlogged_writer');
    // ...and the row now names WHICH writer, which no log could have told us.
    expect(row.basisWriter).toBe('average_on_add');
  });

  it('⛔ THE VACUOUS CELL: nothing-to-explain must not read like explained', () => {
    configureEngineBasisRestatementLog(dir);
    // The LIVE condition, reproduced: the log EXISTS and is readable and holds
    // records for OTHER positions (bqb1 2026-09-28: `logPresent: true, count: 22`)
    // — just none for this row. Without a seed the census reads `null` (absent
    // file), which is a different cell entirely and would not exercise this one.
    appendEngineBasisRestatement(dir, restatement('some-other-row', 1.0, 0.9));
    // A: census readable + empty, basis moved         -> unlogged_writer
    recordPaperOptionOpen(optOpen({ id: 'a-moved', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'a-moved', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 0.9, pnl: 30,
    }, 'paper');
    // B: census readable + empty, basis did NOT move   -> no_delta_no_restatement
    recordPaperOptionOpen(optOpen({ id: 'b-still', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'b-still', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 1.0, pnl: 20,
    }, 'paper');
    // C: the LOGGED path landed                        -> logged_restatement
    recordPaperOptionOpen(optOpen({ id: 'c-logged', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    appendEngineBasisRestatement(dir, restatement('c-logged', 1.0, 0.9));
    recordPaperOptionClose({
      id: 'c-logged', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 0.9, pnl: 30,
      basisWriter: 'broker_reconcile',
    }, 'paper');

    const [a, b, c] = closeRows();
    // ⛔ A and B are IDENTICAL on `basisRestatementCount` — both a measured 0 —
    // which is exactly why that field cannot carry this question.
    expect(a!.basisRestatementCount).toBe(0);
    expect(b!.basisRestatementCount).toBe(0);
    expect(a!.basisRestatementCount).toBe(b!.basisRestatementCount);
    // The new cell separates them.
    expect(a!.basisDeltaAttribution).toBe('unlogged_writer');
    expect(b!.basisDeltaAttribution).toBe('no_delta_no_restatement');
    expect(c!.basisDeltaAttribution).toBe('logged_restatement');
    expect(new Set([a, b, c].map(r => r!.basisDeltaAttribution)).size).toBe(3);
    // ⛔ The control on the REJECTED design. A boolean `explainedByRestatement`
    // has three cells for four readings, so B (nothing to explain) and C (gap
    // accounted for) would both have to read `true` — a vacuous pass that reads
    // identically to a real one. Assert the enum does NOT collapse that way.
    expect(b!.basisDeltaAttribution).not.toBe(c!.basisDeltaAttribution);
  });

  it('the summary partition is EXHAUSTIVE over `inFold`, and `neverRestated` is the sum of two cells', () => {
    configureEngineBasisRestatementLog(dir);
    const mk = (id: string, restated: number, logged: boolean, writer?: string) => {
      recordPaperOptionOpen(optOpen({ id, contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
      if (logged) appendEngineBasisRestatement(dir, restatement(id, 1.0, restated));
      recordPaperOptionClose({
        id, symbol: 'ABC', contracts: 1, currentPremium: 1.2, entrySpreadPct: 0.2,
        closedAt: NOW, premiumPaid: restated, pnl: (1.2 - restated) * 100,
        ...(writer ? { basisWriter: writer as never } : {}),
      }, 'paper');
    };
    mk('s-logged', 0.9, true, 'broker_reconcile');
    mk('s-unlogged-1', 0.9, false, 'average_on_add');
    mk('s-unlogged-2', 1.1, false, 'import_adopted');  // the OTHER sign
    mk('s-still', 1.0, false, 'engine_open_mark');

    const s = buildPaperDailySummary(ET_DAY);
    expect(s.basisCloses.inFold).toBe(4);
    expect(s.basisAttribution).toEqual({
      loggedRestatement: 1, unloggedWriter: 2, noDeltaNoRestatement: 1,
    });
    // The sum identity — what makes the partition auditable rather than asserted.
    const a = s.basisAttribution;
    expect(a.loggedRestatement + a.unloggedWriter + a.noDeltaNoRestatement).toBe(s.basisCloses.inFold);
    // ⛔ `neverRestated` is NOT the structural-zero count, and never was. Its
    // shipped doc comment claimed it was.
    expect(s.basisCloses.neverRestated).toBe(3);
    expect(s.basisCloses.neverRestated).toBe(a.unloggedWriter + a.noDeltaNoRestatement);
    expect(s.basisCloses.neverRestated).not.toBe(a.noDeltaNoRestatement);
    // Both signs really are present — a one-signed writer (demo slippage) cannot
    // produce this, which is the sign evidence TRA-5010 rests on.
    expect(s.basisDeltaUsd).toBeCloseTo(10 + 10 - 10, 10);
    expect(s.basisWriters).toEqual({
      broker_reconcile: 1, average_on_add: 1, import_adopted: 1, engine_open_mark: 1,
    });
  });

  it('an UNREADABLE census attributes nothing — `census_unreadable`, never `unlogged_writer`', () => {
    configureEngineBasisRestatementLog(join(dir, 'no-such-dir'));
    recordPaperOptionOpen(optOpen({ id: 'blind-5010', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'blind-5010', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 0.9, pnl: 30,
    }, 'paper');

    const row = closeRows()[0]!;
    expect(row.basisRestatementCount).toBeNull();
    // The basis plainly moved, but we cannot say the log did not hold it.
    expect(row.basisDeltaUsd).toBeCloseTo(10.0, 10);
    expect(row.basisDeltaAttribution).toBe('census_unreadable');
    expect(row.basisDeltaAttribution).not.toBe('unlogged_writer');
    // It stays OUT of the fold, so it cannot enter the exhaustive partition.
    const s = buildPaperDailySummary(ET_DAY);
    expect(s.basisCloses).toEqual({ inFold: 0, unreadable: 1, unstamped: 0, neverRestated: 0 });
    expect(s.basisAttribution).toEqual({ loggedRestatement: 0, unloggedWriter: 0, noDeltaNoRestatement: 0 });
    expect(s.basisWriters).toEqual({});
  });

  it('a row with no matched open attributes NOTHING — null, not a bucket', () => {
    configureEngineBasisRestatementLog(dir);
    recordPaperOptionClose({
      id: 'never-opened', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 0.9, pnl: 30,
    }, 'paper');
    const row = closeRows()[0]!;
    expect(row.matchedOpen).toBe(false);
    expect(row.basisDeltaUsd).toBeNull();
    expect(row.basisDeltaAttribution).toBeNull();
  });

  it('an UNSTAMPED writer is its own key, never attributed to one of the ten', () => {
    configureEngineBasisRestatementLog(dir);
    // The LIVE condition, reproduced: the log EXISTS and is readable and holds
    // records for OTHER positions (bqb1 2026-09-28: `logPresent: true, count: 22`)
    // — just none for this row. Without a seed the census reads `null` (absent
    // file), which is a different cell entirely and would not exercise this one.
    appendEngineBasisRestatement(dir, restatement('some-other-row', 1.0, 0.9));
    // A position opened before the stamp shipped: the engine passes no writer.
    recordPaperOptionOpen(optOpen({ id: 'pre-stamp', contracts: 1, premiumPaid: 1.0 }), 'paper', NOW);
    recordPaperOptionClose({
      id: 'pre-stamp', symbol: 'ABC', contracts: 1, currentPremium: 1.2,
      entrySpreadPct: 0.2, closedAt: NOW, premiumPaid: 0.9, pnl: 30,
    }, 'paper');
    const row = closeRows()[0]!;
    expect(row.basisWriter).toBeNull();
    // ⛔ null is UNSTAMPED, not "no writer" — the basis plainly had one.
    expect(row.basisDeltaAttribution).toBe('unlogged_writer');
    expect(buildPaperDailySummary(ET_DAY).basisWriters).toEqual({ unstamped: 1 });
  });

  it('the classifier is a pure total function over the four readings', () => {
    // Not computable — no delta to attribute. ⛔ Must not read as a bucket.
    expect(classifyBasisDelta(0, null)).toBeNull();
    expect(classifyBasisDelta(3, undefined)).toBeNull();
    expect(classifyBasisDelta(0, Number.NaN)).toBeNull();
    // Census unreadable wins over the delta's value, in BOTH delta directions.
    expect(classifyBasisDelta(null, 10)).toBe('census_unreadable');
    expect(classifyBasisDelta(null, 0)).toBe('census_unreadable');
    expect(classifyBasisDelta(undefined, -10)).toBe('census_unreadable');
    // Logged, at any delta including exactly zero (TRA-4781's measured zero).
    expect(classifyBasisDelta(1, 0)).toBe('logged_restatement');
    expect(classifyBasisDelta(7, -3.25)).toBe('logged_restatement');
    // The two readings a bare `0` collapsed.
    expect(classifyBasisDelta(0, 17.22)).toBe('unlogged_writer');
    expect(classifyBasisDelta(0, -8.93)).toBe('unlogged_writer');
    expect(classifyBasisDelta(0, 0)).toBe('no_delta_no_restatement');
    // ⛔ The epsilon is a float-noise guard, NOT a materiality threshold: a
    // sub-cent move is still a move. Anything larger re-merges the two cells.
    expect(BASIS_DELTA_ZERO_EPSILON_USD).toBeLessThan(1e-6);
    expect(classifyBasisDelta(0, 0.004)).toBe('unlogged_writer');
    expect(classifyBasisDelta(0, BASIS_DELTA_ZERO_EPSILON_USD / 2)).toBe('no_delta_no_restatement');
  });

  it('⛔ SOURCE CENSUS: every writer of `premiumPaid` stamps `basisWriter` — a 13th cannot land silently', () => {
    // The instrument this ticket is about failed because ONE writer family fed
    // the log and eight did not, and nothing in the build could notice. This is
    // the guard: if someone adds a writer without a tag, the counts diverge and
    // this goes red. It reads the SOURCE, because no unit test over the payload
    // can see a site that was never wired.
    const src = readFileSync(join(__dirname, 'options-account.ts'), 'utf-8');
    const lines = src.split(/\r?\n/);

    // (a) every position MINT carries a `basisWriter` key.
    const mints = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.trim() === 'const position: OptionPosition = {');
    expect(mints.length).toBe(8);
    for (const [, i] of mints) {
      const block = lines.slice(i, i + 20).join('\n');
      expect(block, `position mint at options-account.ts:${i + 1} has no basisWriter`)
        .toMatch(/basisWriter: '/);
    }

    // (b) every in-place MUTATION of `<obj>.premiumPaid` stamps within 8 lines.
    //     `const premiumPaid =` locals are excluded by the required `.`.
    const mutations = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => /\w+\.premiumPaid\s*=\s*[^=]/.test(l));
    expect(mutations.length).toBe(4);
    for (const [, i] of mutations) {
      const block = lines.slice(i, i + 8).join('\n');
      expect(block, `premiumPaid mutation at options-account.ts:${i + 1} does not stamp basisWriter`)
        .toMatch(/basisWriter = /);
    }

    // (c) ⛔ the restatement LOG's feeders, named. TRA-5010's own table listed
    //     `operator_restatement` as UNLOGGED; it has appended since 2026-08-22
    //     (ea73fb029), and that is what rules the operator pin out as the cause
    //     of a both-ways gap on a session the census shows nothing for.
    const feeders = [...src.matchAll(/recordEngineBasisRestatement\(\s*\w+,\s*[^,)]+,\s*'([a-z_]+)'/g)]
      .map(m => m[1]!);
    expect(new Set(feeders)).toEqual(
      new Set(['recorded_fill_repair', 'operator_restatement', 'desk_lot_split']));
    // ...plus the un-tagged default call, which is the broker reconcile.
    expect(src).toMatch(/recordEngineBasisRestatement\(existing, incoming\.premiumPaid\);/);
  });
});
