import type {
  AccountSettings,
  PaperGateMetrics,
  Position,
  PromotionStatus,
} from '@trading-app/shared';
import {
  computePaperGateMetrics,
  evaluatePromotion,
  promotionStrategyClass,
  type PromotionTradeSample,
} from '@trading-app/shared';
import { loadStocksTradeSnapshot } from './trade-store.js';
import { getStrategyRecord, getEffectiveThresholds } from './promotion-store.js';
import { collectPcsShadowPaperSamples } from './pcs-shadow-ledger.js';
import { getAllUsers } from './users.js';
import { isPromotionGateEnvAwareEnabled } from './promotion-gate-env-aware-flag.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'promotion-service' });

// TRA-1916 — the OPTIONS sleeves an options → Tradier-Production go-live is
// gated on. The board named these two on TRA-1916: Relative Value
// (`single_leg_rv`) and OTM Mispricing (`single_leg_otm`). Kept as a named
// roster so an options production switch is judged on
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
 * forward test). Stocks Demo trades live in the stocks snapshot's
 * `closedPositions`. Filtered to the strategy by `signalType` and to Demo by
 * `mode` (absent `mode` ↔ legacy demo, included).
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

  const stocks = await loadStocksTradeSnapshot(username);
  if (stocks) {
    (stocks.closedPositions ?? []).forEach(add);
    (stocks.supertrendPaperClosed ?? []).forEach(add);
  }
  return [...byId.values()];
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

  // TRA-1461 — class-aware Stage 2. The `accumulate` class validated on the
  // crypto DCA demo book, which was removed with the crypto engine (TRA-4629);
  // with no accumulation ledger source the leg stays `null`, which is
  // fail-closed (evaluatePromotion returns canGoLive:false without evidence).
  const strategyClass = promotionStrategyClass(strategyId);
  let paper: PaperGateMetrics | null = null;
  if (strategyClass !== 'accumulate') {
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

  return evaluatePromotion({ strategyId, strategyClass, backtest, backtestVerdict, accumulationBacktest, paper, accumulation: null, signoff, thresholds });
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
  // The `accumulate` ledger source (crypto DCA demo book) was removed with the
  // crypto engine (TRA-4629); that leg stays `null` = fail-closed.
  const strategyClass = promotionStrategyClass(strategyId);
  let paper: PaperGateMetrics | null = null;
  if (strategyClass !== 'accumulate') {
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

  return evaluatePromotion({ strategyId, strategyClass, backtest, backtestVerdict, accumulationBacktest, paper, accumulation: null, signoff, thresholds });
}

/** Most recent paper metrics for a strategy, used when persisting a sign-off snapshot. */
export async function snapshotPaperMetrics(username: string, strategyId: string): Promise<PaperGateMetrics | null> {
  const trades = await collectPaperTrades(username, strategyId);
  return trades.length > 0 ? computePaperGateMetrics(trades.map(toSample)) : null;
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
 * TRA-1590 — the REAL-CAPITAL "intent axes" the promotion gate guards. Each is
 * a distinct way the resulting live config would place real-money orders.
 * De-escalation logic compares axes before/after a PUT and gates only an axis
 * the save NEWLY activates, so an operator can always hold or reduce exposure.
 * A non-live mode has no axes active. (The live-crypto axis was removed with
 * the crypto engine, TRA-4629; options → Tradier Production is the remaining
 * real-capital axis.)
 */
function realCapitalIntentAxes(s: AccountSettings): { optionsProduction: boolean } {
  if (s.mode !== 'live') return { optionsProduction: false };
  return { optionsProduction: optionsProductionIntent(s) };
}

/**
 * TRA-2343 — the strategies a settings snapshot would put on REAL CAPITAL,
 * split by the axis that exposes them. This is the unit the gate must compare
 * across a save; the axis boolean alone is too coarse (see
 * {@link evaluateLiveTransitionGate}).
 *
 * TRA-4601 — the options-production axis is graded UNCONDITIONALLY (not behind
 * PROMOTION_GATE_ENV_AWARE, which defaults OFF and is absent from the
 * production intent manifest). This is the load-bearing half now that crypto is
 * removed (TRA-4629): the legacy trigger was crypto-only, so leaving this
 * flag-gated would have silently disarmed promotion entirely. Sandbox remains
 * exempt (see `realCapitalIntentAxes` — the axis is only true for Tradier
 * Production), so zero-capital paper is not blocked, and the TRA-1590
 * de-escalation exemption upstream still lets an operator always move TOWARD
 * safety.
 */
function guardedRosterByAxis(
  s: AccountSettings,
  axes: { optionsProduction: boolean } = realCapitalIntentAxes(s),
): { optionsProduction: string[] } {
  return {
    optionsProduction: axes.optionsProduction ? [...OPTIONS_PRODUCTION_STRATEGIES] : [],
  };
}

export interface LiveTransitionGateResult {
  /** True when the live transition is allowed (or irrelevant — not turning/keeping live). */
  allowed: boolean;
  /** Per-strategy block details when `allowed === false`. */
  blocked: Array<{ strategyId: string; reasons: string[] }>;
}

/**
 * Enforcement decision for `PUT /api/account/settings`. The gate fires whenever
 * the RESULTING state would newly place real-capital orders: every strategy the
 * save newly exposes must be fully promoted
 * (`backtest=pass AND paper=pass AND signoff=present`). Any unpromoted strategy
 * blocks the save with the exact failing reasons.
 *
 * Critically, it never blocks a PUT that turns live OFF or leaves it off — only
 * a PUT whose result adds real-capital exposure is gated — so a user can always
 * disable live or edit unrelated settings while in Demo.
 *
 * TRA-1590 — it also never blocks a de-escalation: when a `previous` snapshot is
 * supplied, only real-capital exposure the save NEWLY adds is gated. Holding
 * or reducing exposure (options production -> sandbox, or any edit that keeps an
 * already-live axis unchanged) always saves, so an operator can move toward
 * safety without first clearing a gate the current state already fails.
 *
 * TRA-2343 — "newly adds" is measured on the guarded STRATEGY ROSTER, not on the
 * axis boolean. Firing only on an axis flip left the gate bypassable in two
 * saves (arm the axis first, then select the roster — which is not an axis
 * escalation). It also refuses an escalation onto an empty roster outright.
 */
export async function evaluateLiveTransitionGate(
  username: string,
  updated: AccountSettings,
  previous?: AccountSettings,
): Promise<LiveTransitionGateResult> {
  // TRA-1436 — environment-aware trigger, behind PROMOTION_GATE_ENV_AWARE.
  // Tradier Sandbox (paper) risks zero real capital and is exempt — it IS the
  // Stage-2 paper environment the gate demands, so blocking it is circular.
  // Since TRA-4601 the options-production ROSTER is graded unconditionally
  // (see `guardedRosterByAxis`); the flag now only arms the empty-roster
  // refusal below, preserving its pre-TRA-4629 behaviour exactly.
  const envAware = isPromotionGateEnvAwareEnabled();

  // TRA-1590 — de-escalation exemption. The gate exists to block a PUT that
  // INCREASES real-capital intent; a PUT that merely holds or REDUCES it must
  // never block, so an operator can always move toward safety even while a
  // gate-failing live path is being wound down. We compare the guarded axes
  // before/after and fire ONLY on an axis the save newly activates. Without a
  // `previous` snapshot we treat every active axis as newly-on, which
  // reproduces the pre-1590 fail-closed trigger verbatim.
  const next = realCapitalIntentAxes(updated);
  const prev = previous
    ? realCapitalIntentAxes(previous)
    : { optionsProduction: false };
  const optionsEscalates = envAware && next.optionsProduction && !prev.optionsProduction;

  // TRA-2343 — fire on the ROSTER DELTA, not on the axis boolean. The axis is
  // coarser than the risk it stands for: the axis flip is latched, but the
  // roster it exposes can change afterwards, and a roster change is not an
  // escalation of the axis.
  //
  // We compare the guarded ROSTERS before/after and gate every strategy the
  // save NEWLY exposes to real capital. This keeps the TRA-1590 de-escalation
  // exemption intact by construction — anything already exposed under the
  // previous snapshot is grandfathered exactly as before (that grandfathering
  // IS the exemption), so holding or reducing exposure still never blocks,
  // while ADDING a strategy to a live axis is graded even when no axis flips.
  // Without a `previous` snapshot the previous roster is empty ⇒ everything
  // reads as newly-exposed, reproducing the fail-closed trigger verbatim.
  const nextRoster = guardedRosterByAxis(updated, next);
  const prevRoster = previous
    ? guardedRosterByAxis(previous)
    : { optionsProduction: [] };
  const alreadyExposed = new Set(prevRoster.optionsProduction);
  const strategies = [...new Set(nextRoster.optionsProduction)].filter(
    id => !alreadyExposed.has(id),
  );

  // TRA-2343 hardening — an EMPTY enumeration must never sail through a
  // fail-closed check. A save that newly activates a real-capital axis while
  // its roster resolves to nothing is refused outright rather than silently
  // approved. Nothing legitimate is lost: an empty roster trades nothing, so
  // there is no reason to arm the axis for it — and arming it is precisely the
  // stepping stone the roster-delta rule exists to close. Scoped to an
  // ESCALATING axis, so no de-escalation can trip it.
  const emptyRosterAxes: Array<{ axis: string; detail: string }> = [];
  if (optionsEscalates && nextRoster.optionsProduction.length === 0) {
    emptyRosterAxes.push({
      axis: 'options → Tradier Production',
      detail: 'no options sleeve is named on the production roster',
    });
  }

  const blocked: Array<{ strategyId: string; reasons: string[] }> = emptyRosterAxes.map(e => ({
    strategyId: `(${e.axis})`,
    reasons: [
      `TRA-2343 — this save turns ON ${e.axis} with an EMPTY strategy roster (${e.detail}). `
      + 'A real-capital axis is never armed against an empty roster: turn the axis on together '
      + 'with the promoted strategies it should trade. '
      + `If you did not mean to arm ${e.axis} at all, turn it OFF in this same save — `
      + 'reducing exposure is never blocked.',
    ],
  }));

  if (strategies.length === 0 && blocked.length === 0) {
    return { allowed: true, blocked: [] };
  }

  // TRA-1916 — each strategy is graded on ITS OWN promotion evidence, from the
  // per-axis roster (options production → OPTIONS_PRODUCTION_STRATEGIES; the
  // board named Relative Value + OTM Mispricing on TRA-1916). Fail-closed is
  // preserved by construction: buildPromotionStatus → evaluatePromotion
  // returns canGoLive:false for any sleeve without a full
  // backtest+paper+signoff record, so an unpromoted options sleeve BLOCKS
  // (honoring the TRA-1897 HOLD) and the gate only opens once a named options
  // sleeve actually clears its net-of-fee promotion evidence.
  for (const strategyId of strategies) {
    const status = await buildPromotionStatus(username, strategyId);
    if (!status.canGoLive) blocked.push({ strategyId, reasons: status.blockedReasons });
  }

  if (blocked.length > 0) {
    log.warn('TRA-532 promotion gate blocked live transition', {
      username,
      escalatingAxes: { optionsProduction: optionsEscalates },
      // TRA-2343 — the newly-exposed set, not the whole roster: what the save
      // ADDS to real capital is what was graded.
      newlyExposed: strategies,
      alreadyExposed: [...alreadyExposed],
      emptyRosterAxes: emptyRosterAxes.map(e => e.axis),
      blocked: blocked.map(b => b.strategyId),
    });
    return { allowed: false, blocked };
  }
  return { allowed: true, blocked: [] };
}
