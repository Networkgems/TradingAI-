import { describe, it, expect } from 'vitest';
import type { Position, TradeSignal } from '@trading-app/shared';
import { PaperAccount, STOCK_SLIPPAGE_BPS } from './paper-account.js';

// TRA-518 — regression-lock the self-heal that force-closes demo positions whose
// protective bracket is structurally invalid. Such positions (negative / NaN /
// wrong-side stop or target — the pre-TRA-520 ASTC & PRFX data) can never hit
// stop or target, so checkExits used to leave them open forever, freezing the
// demo book ("nothing moves, nothing closes, nothing updates").

function zombie(overrides: Partial<Position>): Position {
  return {
    id: 'z1',
    symbol: 'ASTC',
    side: 'buy',
    signalType: 'orb_breakout',
    entryPrice: 49.5,
    quantity: 2,
    stopLoss: -0.215,      // negative — unreachable for a long
    takeProfit: 148.93,
    openedAt: 1,
    mode: 'demo',
    ...overrides,
  };
}

function seed(acc: PaperAccount, pos: Position) {
  acc.importSnapshot({
    cash: 1000,
    equity: 1000,
    initialEquity: 1000,
    dailyPnl: 0,
    openPositions: [pos],
  });
}

describe('PaperAccount.checkExits — invalid-bracket self-heal (TRA-518)', () => {
  it('force-closes a long whose stopLoss is negative (unreachable)', () => {
    const acc = new PaperAccount({ initialEquity: 1000 });
    seed(acc, zombie({}));

    const closed = acc.checkExits(new Map([['ASTC', 45.5]]));

    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('invalid_bracket');
    expect(closed[0].exitPrice).toBe(45.5); // closed at the live price, not the bad bracket
    // long bought @49.5, marked @45.5 → realized loss of (45.5-49.5)*2 = -8
    expect(closed[0].pnl).toBeCloseTo(-8, 6);
    expect(acc.exportSnapshot().openPositions).toHaveLength(0);
  });

  it('force-closes a short whose takeProfit is negative (unreachable)', () => {
    const acc = new PaperAccount({ initialEquity: 1000 });
    seed(acc, zombie({
      id: 'z2', symbol: 'PRFX', side: 'sell',
      entryPrice: 3.05, quantity: 807, stopLoss: 4.64, takeProfit: -0.04,
    }));

    const closed = acc.checkExits(new Map([['PRFX', 2.02]]));

    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('invalid_bracket');
    expect(closed[0].exitPrice).toBe(2.02);
    // short sold @3.05, covered @2.02 → realized profit of (2.02-3.05)*807*-1
    expect(closed[0].pnl).toBeCloseTo((2.02 - 3.05) * 807 * -1, 4);
    expect(acc.exportSnapshot().openPositions).toHaveLength(0);
  });

  it('does NOT touch a healthy bracket, and still honours real stop/target', () => {
    const acc = new PaperAccount({ initialEquity: 1000 });
    seed(acc, zombie({
      id: 'ok1', symbol: 'IREN', side: 'sell',
      entryPrice: 64.08, quantity: 47, stopLoss: 66.75, takeProfit: 58.75,
    }));

    // price between stop and target — nothing should close
    expect(acc.checkExits(new Map([['IREN', 64.5]]))).toHaveLength(0);
    expect(acc.exportSnapshot().openPositions).toHaveLength(1);

    // price reaches the (valid) target — closes the normal way, not as a heal
    const closed = acc.checkExits(new Map([['IREN', 58.0]]));
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).not.toBe('invalid_bracket');
  });

  it('skips healing when no live price is available for the symbol', () => {
    const acc = new PaperAccount({ initialEquity: 1000 });
    seed(acc, zombie({}));

    // empty price map → cannot mark-to-market → leave it for the next tick
    expect(acc.checkExits(new Map())).toHaveLength(0);
    expect(acc.exportSnapshot().openPositions).toHaveLength(1);
  });
});

// TRA-954 — conviction-DCA scale-in book mutation. addToPosition blends the
// average entry, increases qty, and keeps the protective stop FIXED (average
// size, never the stop). It is the demo-book primitive the engine's DCA pass
// calls once the pure `evaluateEquityDcaAdd` core returns an add/shrink verdict.
describe('PaperAccount.addToPosition — conviction DCA scale-in (TRA-954)', () => {
  function openLong(): { acc: PaperAccount; id: string } {
    const acc = new PaperAccount({ initialEquity: 100_000 });
    acc.importSnapshot({
      cash: 100_000,
      equity: 100_000,
      initialEquity: 100_000,
      dailyPnl: 0,
      openPositions: [{
        id: 'p1', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout',
        entryPrice: 100, quantity: 10, stopLoss: 90, takeProfit: 130,
        openedAt: 1, mode: 'demo',
      }],
    });
    return { acc, id: 'p1' };
  }

  it('blends the average entry and increases qty while keeping the stop fixed', () => {
    const { acc, id } = openLong();
    const cashBefore = acc.getState().availableCash;

    const updated = acc.addToPosition(id, 5, 97);

    expect(updated).not.toBeNull();
    // blended avg = (100*10 + 97*5) / 15 = 99
    expect(updated!.entryPrice).toBeCloseTo(99, 9);
    expect(updated!.quantity).toBe(15);
    expect(updated!.stopLoss).toBe(90); // unchanged — we average size, never the stop
    // cash debited by the add cost only
    expect(acc.getState().availableCash).toBeCloseTo(cashBefore - 97 * 5, 6);
  });

  it('preserves the R invariant: blended (avg-stop)*qty stays bounded', () => {
    const { acc, id } = openLong();
    // entry risk = (100-90)*10 = 100. Add 5 @ 97 → blended (99-90)*15 = 135.
    const updated = acc.addToPosition(id, 5, 97)!;
    const blendedRisk = (updated.entryPrice - updated.stopLoss) * updated.quantity;
    expect(blendedRisk).toBeCloseTo(135, 6);
    // The pure core owns shrink/skip to keep this ≤ R; here we only assert the
    // mutation reports the exact blended risk the engine logs as evidence.
  });

  it('refuses an add it cannot afford (cost exceeds cash) and leaves the book intact', () => {
    const acc = new PaperAccount({ initialEquity: 100_000 });
    acc.importSnapshot({
      cash: 100, equity: 100, initialEquity: 100, dailyPnl: 0,
      openPositions: [{
        id: 'p2', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout',
        entryPrice: 100, quantity: 1, stopLoss: 90, takeProfit: 130, openedAt: 1, mode: 'demo',
      }],
    });
    expect(acc.addToPosition('p2', 1000, 100)).toBeNull(); // 100k cost vs 100 cash
    const pos = acc.getState().openPositions[0];
    expect(pos.quantity).toBe(1);
    expect(pos.entryPrice).toBe(100);
  });

  it('returns null for an unknown position or a non-positive add', () => {
    const { acc, id } = openLong();
    expect(acc.addToPosition('nope', 5, 97)).toBeNull();
    expect(acc.addToPosition(id, 0, 97)).toBeNull();
    expect(acc.addToPosition(id, -3, 97)).toBeNull();
    expect(acc.addToPosition(id, 5, 0)).toBeNull();
  });
});

// TRA-536 — the stocks paper fill path stamps realized (live-fill drift from the
// strategy's intended entry) and modeled (5 bps budget) slippage so the Stage-2
// promotion gate can enforce its realized-≤-1.5×-modeled check.
function stockSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-1',
    symbol: 'AAPL',
    type: 'orb_breakout',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskRewardRatio: 2,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('PaperAccount slippage instrumentation (TRA-536)', () => {
  it('stamps realized + modeled slippage at open and carries them through close', () => {
    const acc = new PaperAccount({ initialEquity: 100_000 });
    // Intended entry 100; live fill drifts to 100.25.
    const opened = acc.openPosition(stockSignal(), 100.25);
    expect(opened).not.toBeNull();
    const qty = opened!.quantity;
    expect(opened!.realizedSlippage).toBeCloseTo(Math.abs(100.25 - 100) * qty, 9);
    expect(opened!.modeledSlippage).toBeCloseTo((STOCK_SLIPPAGE_BPS / 10_000) * 100.25 * qty, 9);

    // Price reaches takeProfit — the figures survive onto the closed position.
    const closed = acc.checkExits(new Map([['AAPL', 110]]));
    expect(closed).toHaveLength(1);
    expect(closed[0].realizedSlippage).toBeCloseTo(opened!.realizedSlippage!, 9);
    expect(closed[0].modeledSlippage).toBeCloseTo(opened!.modeledSlippage!, 9);
  });
});

// TRA-1268 (TRA-1250 Rules 1-2) — the demo-equity exit loop layers an ATR
// chandelier trail (Rule 1) and a trade-level profit-lock give-back cap
// (Rule 2) on top of the hard bracket. Both fire ONLY when the caller supplies
// the `EquityExitRiskInput` (gated behind `EXIT_RISK_RULES_ENABLED`), so the
// legacy behaviour is unchanged when it is absent.
describe('PaperAccount.checkExits — ATR chandelier + profit-lock (TRA-1268)', () => {
  function seedLong(overrides: Partial<Position> = {}): { acc: PaperAccount; id: string } {
    const acc = new PaperAccount({ initialEquity: 100_000 });
    acc.importSnapshot({
      cash: 100_000, equity: 100_000, initialEquity: 100_000, dailyPnl: 0,
      openPositions: [{
        id: 'p1', symbol: 'AAPL', side: 'buy', signalType: 'orb_breakout',
        entryPrice: 100, quantity: 10, stopLoss: 90, takeProfit: 200,
        openedAt: 1, mode: 'demo', ...overrides,
      }],
    });
    return { acc, id: 'p1' };
  }

  it('ratchets the chandelier up on a rally and exits when the trail breaks (long)', () => {
    const { acc } = seedLong();
    // ATR 2 → trail width 3×2 = 6 below the running high.
    const risk = { atrBySymbol: new Map([['AAPL', 2]]) };

    // Rally to 120: trail ratchets to 120−6 = 114; still above → no exit.
    expect(acc.checkExits(new Map([['AAPL', 120]]), risk)).toHaveLength(0);

    // Pull back to 113 (< 114 trail) → chandelier fires at the live price.
    const closed = acc.checkExits(new Map([['AAPL', 113]]), risk);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('chandelier');
    expect(closed[0].exitPrice).toBe(113);
    expect(closed[0].pnl).toBeCloseTo((113 - 100) * 10, 6);
    expect(acc.getState().openPositions).toHaveLength(0);
  });

  it('exits on the trade-level profit-lock give-back before the hard stop (long)', () => {
    // Wide ATR (3) keeps the chandelier trail well below the give-back level so
    // the profit-lock is the rule that actually fires. R = entry−stop = 10.
    const { acc } = seedLong({ stopLoss: 90, takeProfit: 500 });
    const risk = { atrBySymbol: new Map([['AAPL', 3]]) };

    // Run to +3R (price 130): armed, peakR 3.0, tightened give-back 0.25R
    // (TRA-4006; was 0.5R).
    expect(acc.checkExits(new Map([['AAPL', 130]]), risk)).toHaveLength(0);

    // Retrace to +2.75R (price 127.5 = peakR−0.25R) → profit-lock exit; chandelier
    // trail (130−9 = 121) has NOT been hit, proving it's the give-back cap.
    // (Pre-TRA-4006 this pinned price 125 = peakR−0.5R.)
    const closed = acc.checkExits(new Map([['AAPL', 127.5]]), risk);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('profit_lock');
    expect(closed[0].exitPrice).toBe(127.5);
  });

  it('mirrors the chandelier for a short (trail ratchets down, exit on rebound)', () => {
    const { acc } = seedLong({ side: 'sell', entryPrice: 100, stopLoss: 110, takeProfit: 50 });
    const risk = { atrBySymbol: new Map([['AAPL', 2]]) };

    // Drop to 80: trail ratchets to 80+6 = 86; still below → no exit.
    expect(acc.checkExits(new Map([['AAPL', 80]]), risk)).toHaveLength(0);

    // Rebound to 87 (≥ 86 trail) → chandelier fires.
    const closed = acc.checkExits(new Map([['AAPL', 87]]), risk);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('chandelier');
    expect(closed[0].exitPrice).toBe(87);
    // Short P&L = (87−100)×10×−1 = +130.
    expect(closed[0].pnl).toBeCloseTo((87 - 100) * 10 * -1, 6);
  });

  it('is a no-op when the caller does not pass the exit-risk inputs (flag dark)', () => {
    const { acc } = seedLong();
    // Same rally + pullback that tripped the chandelier above — with no risk
    // input the position stays open (price is between the hard stop and target).
    expect(acc.checkExits(new Map([['AAPL', 120]]))).toHaveLength(0);
    expect(acc.checkExits(new Map([['AAPL', 113]]))).toHaveLength(0);
    expect(acc.getState().openPositions).toHaveLength(1);
  });

  it('still honours the hard take-profit ahead of the give-back rules', () => {
    const { acc } = seedLong({ takeProfit: 118 });
    const risk = { atrBySymbol: new Map([['AAPL', 2]]) };
    const closed = acc.checkExits(new Map([['AAPL', 118]]), risk);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('target');
    expect(closed[0].exitPrice).toBe(118);
  });
});
