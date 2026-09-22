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
    expect(s.theoreticalRealizedPnlUsd).toBe(0); // stale marks never price the P&L
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
    const gap = s.demoRealizedPnlUsd - s.theoreticalRealizedPnlUsd;
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
