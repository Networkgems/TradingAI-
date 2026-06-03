import type { AccountSettings, PaperGateMetrics, Position, PromotionStatus } from '@trading-app/shared';
import {
  computePaperGateMetrics,
  evaluatePromotion,
  resolveStrategyPreset,
  type PromotionTradeSample,
} from '@trading-app/shared';
import { loadCryptoTradeSnapshot, loadStocksTradeSnapshot } from './trade-store.js';
import { getStrategyRecord, getEffectiveThresholds } from './promotion-store.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'promotion-service' });

// TRA-532 — assembles a strategy's `promotion_status` from the three data
// sources the gate spec requires, and decides whether a "go live" transition
// may proceed:
//   • Stage 1 — registered backtest metrics (promotion-store),
//   • Stage 2 — paper metrics RECOMPUTED here from the paper ledger (so the
//     numbers always reflect real monitored trades, never a stored value),
//   • Stage 3 — presence of a `promotion_decision` sign-off (promotion-store).

/**
 * A closed position maps to a {@link PromotionTradeSample} 1:1 — `Position`
 * already carries `pnl`, `entryPrice`, `stopLoss`, `quantity`, and the
 * `openedAt`/`closedAt` timestamps the gate needs to annualize the paper
 * Sharpe (TRA-538). TRA-536 added per-trade `realizedSlippage`/`modeledSlippage`
 * to the paper fill paths; passing them through here populates the gate's
 * slippage ratio, flipping the Stage-2 slippage check from advisory to
 * enforced for any strategy whose trades carry both figures. Positions from
 * snapshots predating TRA-536 leave the fields undefined and stay advisory.
 */
function toSample(p: Position): PromotionTradeSample {
  return {
    pnl: p.pnl,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    quantity: p.quantity,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    realizedSlippage: p.realizedSlippage,
    modeledSlippage: p.modeledSlippage,
  };
}

/**
 * Collect the monitored paper trades for a strategy from the user's ledgers.
 * "Paper" = Demo-mode closed positions captured on the live data feed (the
 * forward test). Crypto Demo trades live in `demoClosedPositions`; stocks Demo
 * trades in the stocks snapshot's `closedPositions`. Filtered to the strategy
 * by `signalType` (crypto strategy ids ARE signal types) and to Demo by `mode`
 * (absent `mode` ↔ legacy demo, included).
 */
export async function collectPaperTrades(username: string, strategyId: string): Promise<Position[]> {
  const out: Position[] = [];
  const isDemo = (p: Position): boolean => p.mode === 'demo' || p.mode === undefined;
  const matches = (p: Position): boolean => p.signalType === strategyId && isDemo(p) && p.closedAt !== undefined;

  const crypto = await loadCryptoTradeSnapshot(username);
  if (crypto) {
    const closed = crypto.demoClosedPositions ?? crypto.closedPositions ?? [];
    out.push(...closed.filter(matches));
  }
  const stocks = await loadStocksTradeSnapshot(username);
  if (stocks) {
    out.push(...(stocks.closedPositions ?? []).filter(matches));
  }
  return out;
}

/**
 * Build the full `promotion_status` for one strategy: per-stage state, the
 * metrics computed from data, the overall `canGoLive` verdict, and the exact
 * blocked reasons. `username` scopes the paper ledger; backtest + sign-off are
 * global (per strategy).
 */
export async function buildPromotionStatus(username: string, strategyId: string): Promise<PromotionStatus> {
  const rec = await getStrategyRecord(strategyId);
  const thresholds = await getEffectiveThresholds(strategyId);

  const backtest = rec?.backtest?.metrics ?? null;

  const paperTrades = await collectPaperTrades(username, strategyId);
  const paper: PaperGateMetrics | null =
    paperTrades.length > 0 ? computePaperGateMetrics(paperTrades.map(toSample)) : null;

  const signoff = rec && rec.decisions.length > 0 ? 'present' : 'absent';

  return evaluatePromotion({ strategyId, backtest, paper, signoff, thresholds });
}

/** Most recent paper metrics for a strategy, used when persisting a sign-off snapshot. */
export async function snapshotPaperMetrics(username: string, strategyId: string): Promise<PaperGateMetrics | null> {
  const trades = await collectPaperTrades(username, strategyId);
  return trades.length > 0 ? computePaperGateMetrics(trades.map(toSample)) : null;
}

/**
 * Would the post-PUT settings have LIVE crypto auto-trading enabled? The gate
 * keys off the crypto live pilot — `mode === 'live'` with crypto auto-trading
 * on — which is the path that flips real capital onto the strategy roster.
 */
function liveCryptoOn(s: AccountSettings): boolean {
  return s.mode === 'live' && s.cryptoAutoTradingEnabledLive === true;
}

export interface LiveTransitionGateResult {
  /** True when the live transition is allowed (or irrelevant — not turning/keeping live). */
  allowed: boolean;
  /** Per-strategy block details when `allowed === false`. */
  blocked: Array<{ strategyId: string; reasons: string[] }>;
}

/**
 * Enforcement decision for `PUT /api/account/settings`. The gate fires whenever
 * the RESULTING state would run live crypto auto-trading: every strategy the
 * active preset would trade live must be fully promoted
 * (`backtest=pass AND paper=pass AND signoff=present`). Any unpromoted strategy
 * blocks the save with the exact failing reasons.
 *
 * Critically, it never blocks a PUT that turns live OFF or leaves it off — only
 * a PUT whose result is "live auto-trading ON" is gated — so a user can always
 * disable live or edit unrelated settings while in Demo.
 */
export async function evaluateLiveTransitionGate(
  username: string,
  updated: AccountSettings,
): Promise<LiveTransitionGateResult> {
  if (!liveCryptoOn(updated)) return { allowed: true, blocked: [] };

  const preset = resolveStrategyPreset(updated.activeStrategyPreset);
  const strategies = preset.enabledStrategies;
  const blocked: Array<{ strategyId: string; reasons: string[] }> = [];

  for (const strategyId of strategies) {
    const status = await buildPromotionStatus(username, strategyId);
    if (!status.canGoLive) blocked.push({ strategyId, reasons: status.blockedReasons });
  }

  if (blocked.length > 0) {
    log.warn('TRA-532 promotion gate blocked live transition', {
      username,
      preset: preset.id,
      blocked: blocked.map(b => b.strategyId),
    });
    return { allowed: false, blocked };
  }
  return { allowed: true, blocked: [] };
}
