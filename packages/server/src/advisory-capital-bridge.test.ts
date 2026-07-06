import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import type { ShadowOptionSignal } from '@trading-app/engine';
import { DEFAULT_PORTFOLIO_GREEKS_GATE } from '@trading-app/engine';
import { PaperOptionsAccount } from './options-account.js';
import {
  routeVettedIdeaToPaper,
  perLotStructureGreeks,
  defaultStrategyId,
  type VettedIdea,
  type BridgeConfig,
} from './advisory-capital-bridge.js';
import {
  __resetPromotionStoreForTests,
  getPaperAccruals,
  getStrategyPaperMetrics,
} from './promotion-store.js';

// Inside an ET trading window, pinned Tuesday (matches options-account tests).
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// A bull put spread (credit, ~31 DTE): short the 95 put, long the 90 put. Net
// short vega, modestly negative net delta (short the lower-delta put dominates).
function bullPutSignal(over: Partial<ShadowOptionSignal> = {}): ShadowOptionSignal {
  return {
    symbol: 'AAPL',
    timestamp: TRADING_TIME,
    strategy: 'bull_put_spread',
    legs: [
      { action: 'sell', optionType: 'put', strike: 95, delta: -0.30, optionSymbol: 'AAPL240705P00095000', mark: 2.2 },
      { action: 'buy', optionType: 'put', strike: 90, delta: -0.18, optionSymbol: 'AAPL240705P00090000', mark: 0.4 },
    ],
    expiration: '2024-07-05',
    daysToExpiry: 31,
    shortDelta: 0.30,
    netCredit: 1.8,
    netDebit: null,
    widthPoints: 5,
    sizingIntent: { maxLossPerSpread: 320, riskFraction: 0.01 },
    zoneTouches: null,
    reversalScore: null,
    rationale: 'iv_rank_high short premium',
    ...over,
  };
}

const SPOT = 100;
const resolveSpot = (sym: string): number | undefined => (sym === 'AAPL' ? SPOT : undefined);

function idea(over: Partial<VettedIdea> = {}): VettedIdea {
  return { signal: bullPutSignal(), verdict: 'APPROVE', ...over };
}

const ENABLED: BridgeConfig = { enabled: true };

let dir: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  dir = mkdtempSync(join(tmpdir(), 'bridge-promo-'));
  __resetPromotionStoreForTests(join(dir, 'promotion-gate.json'));
});

afterEach(() => {
  vi.useRealTimers();
  __resetPromotionStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('perLotStructureGreeks', () => {
  it('nets per-leg delta with the sold-leg sign flip', () => {
    const g = perLotStructureGreeks(bullPutSignal(), SPOT, 0.045, 31);
    // sell 95p (delta -0.30 → position +0.30×100) + buy 90p (delta -0.18 → -0.18×100)
    // net = (+30) + (-18) = +12 equivalent shares.
    expect(g.deltaShares).toBeCloseTo(12, 6);
  });

  it('comes out net SHORT vega for a credit structure', () => {
    const g = perLotStructureGreeks(bullPutSignal(), SPOT, 0.045, 31);
    expect(g.vegaDollars).toBeLessThan(0);
  });
});

describe('routeVettedIdeaToPaper — flag + verdict gating', () => {
  it('does nothing when the bridge is flag-disabled', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const out = await routeVettedIdeaToPaper(idea(), acct, resolveSpot, { enabled: false });
    expect(out.status).toBe('disabled');
    expect(acct.getState().dailyOptionsCount).toBe(0);
    expect(await getPaperAccruals(defaultStrategyId(bullPutSignal()))).toHaveLength(0);
  });

  it('refuses to route a non-APPROVE (REVISE/VETO) idea to capital', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    for (const verdict of ['REVISE', 'VETO'] as const) {
      const out = await routeVettedIdeaToPaper(idea({ verdict }), acct, resolveSpot, ENABLED);
      expect(out.status).toBe('not_approved');
    }
    expect(acct.getState().dailyOptionsCount).toBe(0);
  });

  it('reports no_spot when the underlying cannot be priced', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const out = await routeVettedIdeaToPaper(idea(), acct, () => undefined, ENABLED);
    expect(out.status).toBe('no_spot');
  });
});

describe('routeVettedIdeaToPaper — places an approved, gate-passing idea', () => {
  it('opens the combo in paper and records the accrual in the promotion store', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const out = await routeVettedIdeaToPaper(idea(), acct, resolveSpot, ENABLED);

    expect(out.status).toBe('placed');
    if (out.status === 'placed') {
      expect(out.strategyId).toBe('option:bull_put_spread');
      expect(out.position.contracts).toBe(1);
      expect(out.position.maxLossUsd).toBe(320);
      expect(out.position.optionSymbol).toContain('COMBO:AAPL:bull_put_spread');
    }
    expect(acct.getState().dailyOptionsCount).toBe(1);

    // Accrual recorded (open, no realized P&L yet) → Stage-2 metrics still null.
    const accruals = await getPaperAccruals('option:bull_put_spread');
    expect(accruals).toHaveLength(1);
    expect(accruals[0]!.entryRiskUsd).toBe(320);
    expect(accruals[0]!.pnl).toBeUndefined();
    expect(await getStrategyPaperMetrics('option:bull_put_spread')).toBeNull();
  });
});

describe('routeVettedIdeaToPaper — rejected by portfolio-Greeks gate', () => {
  it('rejects (and books nothing) when the trade would breach the net-delta band', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Tighten the delta band below the structure's ~12-share contribution.
    const cfg: BridgeConfig = {
      enabled: true,
      gate: { ...DEFAULT_PORTFOLIO_GREEKS_GATE, maxAbsNetDelta: 5 },
    };
    const out = await routeVettedIdeaToPaper(idea(), acct, resolveSpot, cfg);
    expect(out.status).toBe('rejected_by_gate');
    if (out.status === 'rejected_by_gate') expect(out.reason).toContain('net delta');
    // No paper position, no cash consumed, no accrual recorded.
    expect(acct.getState().dailyOptionsCount).toBe(0);
    expect(acct.getState().optionsCash).toBe(50_000);
    expect(await getPaperAccruals('option:bull_put_spread')).toHaveLength(0);
  });

  it('rejects when the per-trade max-loss ceiling is breached', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const cfg: BridgeConfig = {
      enabled: true,
      gate: { ...DEFAULT_PORTFOLIO_GREEKS_GATE, maxTradeLossUsd: 100 },
    };
    const out = await routeVettedIdeaToPaper(idea(), acct, resolveSpot, cfg);
    expect(out.status).toBe('rejected_by_gate');
    if (out.status === 'rejected_by_gate') expect(out.reason).toContain('max loss');
    expect(acct.getState().optionsCash).toBe(50_000);
  });

  it('rejects when the open-position cap is already reached', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 200_000, managedAccountRatio: 0.5 });
    // Pre-fill the book with single-leg paper positions up to the cap so the
    // portfolio gate's position count binds (combos would dedup; single legs
    // each take a slot).
    // Loosen concentration so the OPEN-POSITION cap is the binding gate here
    // (otherwise a 2-name book trips the 35% concentration cap first).
    const cfg: BridgeConfig = {
      enabled: true,
      gate: { ...DEFAULT_PORTFOLIO_GREEKS_GATE, maxOpenPositions: 1, maxNameConcentrationPct: 1 },
    };
    // First placement fills the one allowed slot.
    const first = await routeVettedIdeaToPaper(idea(), acct, resolveSpot, cfg);
    expect(first.status).toBe('placed');
    // A different structure (so it isn't dedup-rejected) now exceeds the cap.
    const second = await routeVettedIdeaToPaper(
      idea({ signal: bullPutSignal({ strategy: 'bear_call_spread', symbol: 'MSFT' }) }),
      acct,
      (s) => (s === 'MSFT' ? 250 : resolveSpot(s)),
      cfg,
    );
    expect(second.status).toBe('rejected_by_gate');
    if (second.status === 'rejected_by_gate') expect(second.reason).toContain('open positions');
  });
});

describe('routeVettedIdeaToPaper — executor declines for a non-portfolio reason', () => {
  it('surfaces execution_rejected when the structure busts the per-trade gate', async () => {
    // $1k equity → TRA-1348 governor = max(2%×1k=$20, min($500, 5%×1k=$50)) = $50;
    // a single $320 max-loss lot can't be trimmed below one and is refused by the
    // executor's own pre-trade gate.
    const acct = new PaperOptionsAccount({ initialEquity: 1_000, managedAccountRatio: 0.5 });
    const out = await routeVettedIdeaToPaper(idea(), acct, resolveSpot, ENABLED);
    expect(out.status).toBe('execution_rejected');
    expect(acct.getState().optionsCash).toBe(1_000);
    expect(await getPaperAccruals('option:bull_put_spread')).toHaveLength(0);
  });
});
