import type {
  AccountSettings,
  AccumulationGateMetrics,
  AccumulationPositionSample,
  PaperGateMetrics,
  Position,
  PromotionStatus,
} from '@trading-app/shared';
import {
  computeAccumulationGateMetrics,
  computePaperGateMetrics,
  evaluatePromotion,
  promotionStrategyClass,
  resolveStrategyPreset,
  type PromotionTradeSample,
} from '@trading-app/shared';
import { loadCryptoTradeSnapshot, loadStocksTradeSnapshot } from './trade-store.js';
import { getStrategyRecord, getEffectiveThresholds } from './promotion-store.js';
import { collectPcsShadowPaperSamples } from './pcs-shadow-ledger.js';
import { getAllUsers } from './users.js';
import { isPromotionGateEnvAwareEnabled } from './promotion-gate-env-aware-flag.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'promotion-service' });

// TRA-1916 — the OPTIONS sleeves an options → Tradier-Production go-live is
// gated on. The board named these two on TRA-1916: Relative Value
// (`single_leg_rv`) and OTM Mispricing (`single_leg_otm`). Kept as a named
// roster (not the crypto preset) so an options production switch is judged on
// options-strategy evidence. Fail-closed: neither has cleared net-of-fee
// forward validation yet (TRA-1690 RV, TRA-1585 OTM), so both currently BLOCK.
export const OPTIONS_PRODUCTION_STRATEGIES = ['single_leg_rv', 'single_leg_otm'] as const;

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
 *
 * TRA-936 — the SupertrendConfluence forward-test book additionally lands its
 * closed trades in the DURABLE `supertrendPaperClosed` ledger, which (unlike
 * `closedPositions`) is not wiped by the nightly TRA-219 archive. We union both
 * lists and de-dupe by position id so the Stage-2 count is cumulative and
 * restart-stable: within a session a trade appears in both lists (same id ⇒
 * counted once); after the nightly archive `closedPositions` is empty and the
 * durable ledger carries the history forward.
 */
export async function collectPaperTrades(username: string, strategyId: string): Promise<Position[]> {
  const isDemo = (p: Position): boolean => p.mode === 'demo' || p.mode === undefined;
  const matches = (p: Position): boolean => p.signalType === strategyId && isDemo(p) && p.closedAt !== undefined;

  // De-dupe by position id across the (possibly overlapping) source lists.
  const byId = new Map<string, Position>();
  const add = (p: Position): void => { if (matches(p)) byId.set(p.id, p); };

  const crypto = await loadCryptoTradeSnapshot(username);
  if (crypto) {
    const closed = crypto.demoClosedPositions ?? crypto.closedPositions ?? [];
    closed.forEach(add);
  }
  const stocks = await loadStocksTradeSnapshot(username);
  if (stocks) {
    (stocks.closedPositions ?? []).forEach(add);
    (stocks.supertrendPaperClosed ?? []).forEach(add);
  }
  return [...byId.values()];
}

/**
 * TRA-1461 — a demo position maps 1:1 to an {@link AccumulationPositionSample}:
 * `Position` already carries the blended `entryPrice` (cost basis), the fixed
 * `stopLoss`, the accumulated `quantity`, the TRA-961 `dcaFills`/`dcaHold`
 * accumulation fields, and the `openedAt`/`closedAt`/`exitReason` lifecycle the
 * accumulation gate needs.
 */
function toAccumSample(p: Position): AccumulationPositionSample {
  return {
    side: p.side,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    quantity: p.quantity,
    fills: p.dcaFills,
    hold: p.dcaHold,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    exitReason: p.exitReason,
  };
}

/**
 * TRA-1461 — collect the monitored PAPER positions for an `accumulate`/hold-mode
 * strategy. Unlike {@link collectPaperTrades} (closed-only) this returns the OPEN
 * demo accumulation positions — which by construction never close — alongside any
 * closed demo positions for the strategy (so the gate can spot a hold-mode
 * violation, i.e. a held position sold outside its catastrophe stop). Scoped to
 * Demo by `mode` and to the strategy by `signalType`. DCA is a crypto strategy,
 * so the demo book is the crypto snapshot's open + demo-closed lists.
 */
export async function collectAccumulationPositions(username: string, strategyId: string): Promise<Position[]> {
  const isDemo = (p: Position): boolean => p.mode === 'demo' || p.mode === undefined;
  const matches = (p: Position): boolean => p.signalType === strategyId && isDemo(p);
  const out: Position[] = [];
  const crypto = await loadCryptoTradeSnapshot(username);
  if (crypto) {
    (crypto.openPositions ?? []).forEach(p => {
      if (matches(p) && p.closedAt === undefined) out.push(p);
    });
    const closed = crypto.demoClosedPositions ?? crypto.closedPositions ?? [];
    closed.forEach(p => {
      if (matches(p) && p.closedAt !== undefined) out.push(p);
    });
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
  // TRA-541 — when a TRA-540 optimization verdict was registered, it is
  // authoritative for Stage 1: the leg passes iff verdict.pass is true.
  const backtestVerdict = rec?.backtest?.verdict ?? null;
  // TRA-1465 — the accumulate-class Stage-1 source (ignored for close strategies).
  const accumulationBacktest = rec?.backtest?.accumulationBacktest ?? null;

  // TRA-1461 — class-aware Stage 2. `accumulate` (hold-mode DCA) validates on
  // accumulation correctness (open demo positions never close); `close` keeps
  // the closed-trade PF/expectancy paper leg.
  const strategyClass = promotionStrategyClass(strategyId);
  let paper: PaperGateMetrics | null = null;
  let accumulation: AccumulationGateMetrics | null = null;
  if (strategyClass === 'accumulate') {
    const positions = await collectAccumulationPositions(username, strategyId);
    accumulation = positions.length > 0 ? computeAccumulationGateMetrics(positions.map(toAccumSample), Date.now()) : null;
  } else {
    const paperTrades = await collectPaperTrades(username, strategyId);
    // TRA-1618 — the weekly QQQ PCS forward test accrues its Stage-2 fills in the
    // durable PCS shadow ledger rather than the demo trade book, so union its
    // settled samples in. Flag-gated (ENABLE_PCS_SHADOW, default OFF) and scoped
    // to the base-PCS strategy id inside the collector, so it is inert for every
    // other strategy and until the shadow leg is armed.
    const shadowSamples = await collectPcsShadowPaperSamples(strategyId);
    const samples = [...paperTrades.map(toSample), ...shadowSamples];
    paper = samples.length > 0 ? computePaperGateMetrics(samples) : null;
  }

  const signoff = rec && rec.decisions.length > 0 ? 'present' : 'absent';

  return evaluatePromotion({ strategyId, strategyClass, backtest, backtestVerdict, accumulationBacktest, paper, accumulation, signoff, thresholds });
}

/**
 * TRA-803 — promotion-gate status for the PUBLIC, tokenless read-only probe
 * (`GET /api/health/promotion-gate/:strategyId`), extending the TRA-799 pattern
 * to the Stage-2 paper gate. Identical gate evaluation to
 * {@link buildPromotionStatus}, with one difference: the Stage-2 paper ledger is
 * aggregated across EVERY user rather than scoped to one authenticated caller,
 * so the probe reports the TOTAL monitored paper trades accrued for the strategy
 * — the figure the Stage-2 go/no-go is judged on — without needing a Render
 * identity (QuantTrader has no working production creds; see TRA-799/TRA-802).
 * Stage-1 backtest, Stage-3 sign-off, and the thresholds are already global per
 * strategy. The returned {@link PromotionStatus} is pure gate telemetry: per-
 * stage state, the computed metrics, `canGoLive`, and the blocked reasons — no
 * per-user data, no account internals, no secrets. The gate logic is untouched,
 * so `canGoLive` remains the same safety invariant the authenticated route
 * reports.
 */
export async function buildPublicPromotionProbe(strategyId: string): Promise<PromotionStatus> {
  const rec = await getStrategyRecord(strategyId);
  const thresholds = await getEffectiveThresholds(strategyId);

  const backtest = rec?.backtest?.metrics ?? null;
  const backtestVerdict = rec?.backtest?.verdict ?? null;
  // TRA-1465 — the accumulate-class Stage-1 source (ignored for close strategies).
  const accumulationBacktest = rec?.backtest?.accumulationBacktest ?? null;

  // TRA-1461 — class-aware Stage 2, aggregated across every user (see the
  // authenticated {@link buildPromotionStatus} for the per-class rationale).
  const strategyClass = promotionStrategyClass(strategyId);
  let paper: PaperGateMetrics | null = null;
  let accumulation: AccumulationGateMetrics | null = null;
  if (strategyClass === 'accumulate') {
    const positions: Position[] = [];
    for (const u of getAllUsers()) {
      positions.push(...(await collectAccumulationPositions(u.username, strategyId)));
    }
    accumulation = positions.length > 0 ? computeAccumulationGateMetrics(positions.map(toAccumSample), Date.now()) : null;
  } else {
    const paperTrades: Position[] = [];
    for (const u of getAllUsers()) {
      paperTrades.push(...(await collectPaperTrades(u.username, strategyId)));
    }
    // TRA-1618 — union the weekly QQQ PCS forward-test samples (see the
    // authenticated build path). The shadow ledger is global (not per-user), so
    // it is collected once, not per user.
    const shadowSamples = await collectPcsShadowPaperSamples(strategyId);
    const samples = [...paperTrades.map(toSample), ...shadowSamples];
    paper = samples.length > 0 ? computePaperGateMetrics(samples) : null;
  }

  const signoff = rec && rec.decisions.length > 0 ? 'present' : 'absent';

  return evaluatePromotion({ strategyId, strategyClass, backtest, backtestVerdict, accumulationBacktest, paper, accumulation, signoff, thresholds });
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

/**
 * TRA-1436 — does the resulting live config route OPTIONS orders to Tradier
 * PRODUCTION (real money)? Sandbox (paper) uses simulated fills against real
 * chains and risks zero real capital, so it is the intended paper-validation
 * path and is NOT gated. The legacy un-suffixed default is `sandbox` (see
 * AccountSettings.liveTradierEnvOptions), so an absent field reads as Sandbox.
 */
function optionsProductionIntent(s: AccountSettings): boolean {
  return (s.liveTradierEnvOptions ?? 'sandbox') === 'production';
}

/**
 * TRA-1436 — would the post-PUT settings place REAL-CAPITAL live orders, the
 * state the TRA-532 promotion gate exists to guard?
 *   • Crypto — Coinbase live has NO sandbox, so `mode==='live'` with crypto
 *     auto-trading ON is always real capital and stays gated as-is (#2).
 *   • Options — real capital ⇔ Tradier Environment = Production. Sandbox (paper)
 *     risks zero real capital and must NOT be gated (#1); Production stays
 *     fail-closed (#3).
 * Used only when the environment-aware gate is armed; otherwise the legacy
 * crypto-only trigger (`liveCryptoOn`) is preserved verbatim.
 */
function liveRealCapitalIntent(s: AccountSettings): boolean {
  if (s.mode !== 'live') return false;
  return liveCryptoOn(s) || optionsProductionIntent(s);
}

/**
 * TRA-1590 — the independent REAL-CAPITAL "intent axes" the promotion gate
 * guards. Each is a distinct way the resulting live config would place
 * real-money orders. De-escalation logic compares axes before/after a PUT and
 * gates only an axis the save NEWLY activates, so an operator can always hold
 * or reduce exposure (e.g. options production -> sandbox while live crypto,
 * separately being wound down, stays on). A non-live mode has no axes active.
 */
function realCapitalIntentAxes(s: AccountSettings): { crypto: boolean; optionsProduction: boolean } {
  if (s.mode !== 'live') return { crypto: false, optionsProduction: false };
  return { crypto: liveCryptoOn(s), optionsProduction: optionsProductionIntent(s) };
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
 *
 * TRA-1590 — it also never blocks a de-escalation: when a `previous` snapshot is
 * supplied, only a real-capital axis the save NEWLY activates is gated. Holding
 * or reducing exposure (options production -> sandbox, or any edit that keeps an
 * already-live axis unchanged) always saves, so an operator can move toward
 * safety without first clearing a gate the current state already fails.
 */
export async function evaluateLiveTransitionGate(
  username: string,
  updated: AccountSettings,
  previous?: AccountSettings,
): Promise<LiveTransitionGateResult> {
  // TRA-1436 — environment-aware trigger, behind PROMOTION_GATE_ENV_AWARE
  // (default OFF ⇒ legacy crypto-only trigger, behaviour-preserving). When
  // armed, the gate fires on real-capital intent: live crypto auto-trading (no
  // sandbox) OR options routed to Tradier PRODUCTION. Tradier Sandbox (paper)
  // risks zero real capital and is exempt — it IS the Stage-2 paper environment
  // the gate demands, so blocking it is circular. This only ever LOOSENS the
  // gate for zero-capital Sandbox; Production stays fail-closed.
  const envAware = isPromotionGateEnvAwareEnabled();

  // TRA-1590 — de-escalation exemption. The gate exists to block a PUT that
  // INCREASES real-capital intent; a PUT that merely holds or REDUCES it must
  // never block, so an operator can always move toward safety even while a
  // gate-failing live path is being wound down (e.g. route options
  // production -> sandbox while live crypto stays on pending the board's
  // disable). We compare the guarded axes before/after and fire ONLY on an axis
  // the save newly activates. Without a `previous` snapshot (e.g. the
  // TRA-575 crypto-start path) we treat every active axis as newly-on, which
  // reproduces the pre-1590 fail-closed trigger verbatim.
  const next = realCapitalIntentAxes(updated);
  const prev = previous
    ? realCapitalIntentAxes(previous)
    : { crypto: false, optionsProduction: false };
  const cryptoEscalates = next.crypto && !prev.crypto;
  // The legacy crypto-only trigger never considered the options axis; keep it
  // ungated there so the env-aware flag remains the only switch that arms it.
  const optionsEscalates = envAware && next.optionsProduction && !prev.optionsProduction;
  const gateFires = cryptoEscalates || optionsEscalates;
  if (!gateFires) return { allowed: true, blocked: [] };

  // TRA-1916 — gate each escalating axis against ITS OWN strategy roster. The
  // prior code always looped over the active *crypto* preset's roster, so an
  // options → Tradier-Production switch was judged entirely against the crypto
  // `dca` strategy (every shipped preset is crypto-only). That was wrong twice:
  // it false-blocked options on a failing crypto strategy, AND it never checked
  // any options sleeve's promotion at all. We now assemble the roster from the
  // axes that actually escalate:
  //   • crypto escalation  → the active crypto preset's enabledStrategies
  //   • options production  → OPTIONS_PRODUCTION_STRATEGIES (the board named
  //     Relative Value + OTM Mispricing on TRA-1916)
  // Fail-closed is preserved by construction: buildPromotionStatus →
  // evaluatePromotion returns canGoLive:false for any sleeve without a full
  // backtest+paper+signoff record, so an unpromoted options sleeve BLOCKS
  // (honoring the TRA-1897 HOLD) and the gate only opens once a named options
  // sleeve actually clears its net-of-fee promotion evidence.
  const preset = resolveStrategyPreset(updated.activeStrategyPreset);
  const rosterStrategies: string[] = [];
  if (cryptoEscalates) rosterStrategies.push(...preset.enabledStrategies);
  if (optionsEscalates) rosterStrategies.push(...OPTIONS_PRODUCTION_STRATEGIES);
  const strategies = [...new Set(rosterStrategies)];
  const blocked: Array<{ strategyId: string; reasons: string[] }> = [];

  for (const strategyId of strategies) {
    const status = await buildPromotionStatus(username, strategyId);
    if (!status.canGoLive) blocked.push({ strategyId, reasons: status.blockedReasons });
  }

  if (blocked.length > 0) {
    log.warn('TRA-532 promotion gate blocked live transition', {
      username,
      escalatingAxes: { crypto: cryptoEscalates, optionsProduction: optionsEscalates },
      preset: preset.id,
      roster: strategies,
      blocked: blocked.map(b => b.strategyId),
    });
    return { allowed: false, blocked };
  }
  return { allowed: true, blocked: [] };
}
