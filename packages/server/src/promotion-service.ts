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
  isSymbolUniverseSubset,
  promotionStrategyClass,
  resolveStrategyPreset,
  resolveStrategySymbolUniverse,
  LIVE_RATIFIED_CRYPTO_PRESETS,
  type CryptoStrategyType,
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

/**
 * TRA-2343 — the strategies a settings snapshot would put on REAL CAPITAL,
 * split by the axis that exposes them. This is the unit the gate must compare
 * across a save; the axis boolean alone is too coarse (see
 * {@link evaluateLiveTransitionGate}).
 *
 * Mirrors the axis rules exactly: a non-live mode exposes nothing, live crypto
 * exposes the ACTIVE PRESET's roster (TRA-1916), and options-production exposes
 * the board-named options sleeves — but only while the env-aware flag is armed,
 * so the legacy crypto-only trigger stays behaviour-preserving with it off.
 *
 * TRA-2351 — `axes` is injectable so a caller that is authorizing an action the
 * snapshot does not yet describe (see {@link evaluateLiveCryptoStartGate}) grades
 * the roster of the axis it is actually turning on. Defaults to the snapshot's
 * own axes, so every existing caller is unchanged.
 */
function guardedRosterByAxis(
  s: AccountSettings,
  envAware: boolean,
  axes: { crypto: boolean; optionsProduction: boolean } = realCapitalIntentAxes(s),
): { crypto: string[]; optionsProduction: string[] } {
  // TRA-4601 — the options-production axis is now graded UNCONDITIONALLY.
  //
  // THE DEFECT THIS CLOSES. The axis used to be gated on `envAware`
  // (PROMOTION_GATE_ENV_AWARE), which defaults OFF, is absent from the
  // production intent manifest, and is not declared in render.yaml. With the
  // shipped default, routing options to Tradier PRODUCTION was never checked
  // against the named RV/OTM promotion records — the gate was decorative on the
  // one axis that spends real money.
  //
  // It is ALSO the load-bearing half once crypto is removed. The legacy trigger
  // is crypto-only: with `axes.crypto` permanently false, a default-OFF
  // `envAware` leaves `guardedRosterByAxis` returning two empty arrays, i.e. a
  // gate that cannot fire on anything. Deleting crypto while this stayed
  // flag-gated would have silently disarmed promotion entirely.
  //
  // Sandbox remains exempt (see `realCapitalIntentAxes` — the axis is only true
  // for Tradier Production), so zero-capital paper is not blocked, and the
  // TRA-1590 de-escalation exemption upstream still lets an operator always
  // move TOWARD safety. `envAware` is retained only for the crypto axis it
  // originally described and is no longer consulted here.
  void envAware;
  return {
    crypto: axes.crypto ? [...resolveStrategyPreset(s.activeStrategyPreset).enabledStrategies] : [],
    optionsProduction: axes.optionsProduction ? [...OPTIONS_PRODUCTION_STRATEGIES] : [],
  };
}

/**
 * TRA-2348 — the strategies whose LIVE SYMBOL UNIVERSE this save WIDENS beyond
 * what the board has ratified for real money, keyed by strategyId.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. TRA-2343 moved the graded unit from the axis
 * boolean to the strategy ROSTER, which closes "arm the axis under `no_trade`,
 * then re-select the real preset". It does not close the same shape one level
 * finer, because every shipped live crypto preset enables the SAME single
 * strategy:
 *
 *   crypto_core_live_canary_btc → ['dca'], universe {BTC-USD}
 *   crypto_core_live_majors     → ['dca'], universe {BTC-USD, ETH-USD, SOL-USD}
 *   crypto_core                 → ['dca'], universe ⊤ (≈395 Coinbase pairs)
 *
 * So a save that swaps `crypto_core_live_canary_btc` → `crypto_core` while live
 * crypto is already ON produces roster {dca} → {dca}: an EMPTY delta and no axis
 * flip, so the gate is silent while the universe widens ≈130×. The promotion
 * record is keyed by strategyId alone, so a canary/majors sign-off grandfathers
 * a 395-pair roster — and QuantTrader's sign-off is explicitly NO-GO on exactly
 * that universe (TRA-1304). The graded unit is (strategy, UNIVERSE).
 *
 * WHY A RE-GRADE IS NOT THE REMEDY. The obvious fix — "treat a widening as newly
 * exposed and grade it" — is a NO-OP here. Reaching this state requires `dca` to
 * be fully promoted already (that is how you got live), and `buildPromotionStatus`
 * is universe-blind, so re-grading `dca` returns canGoLive:true and the widening
 * sails through. The check has to be a REFUSAL against a universe the board named,
 * not another lookup in a record that cannot answer the question.
 *
 * BOTH DIRECTIONS (TRA-1590). Only a WIDENING is refused, measured as a subset
 * test on the effective universe:
 *   • majors → canary, `crypto_core` → majors, anything → `no_trade` — NARROWING,
 *     never gated.
 *   • an unrelated edit that holds the same preset — ⊤ ⊆ ⊤ / list ⊆ itself, so no
 *     widening, never gated. The TRA-1590 hold-exposure exemption survives.
 *   • canary → majors — a widening, but `crypto_core_live_majors` IS ratified, so
 *     it is allowed. That is the TRA-1304 step-up ("on canary PASS the step-up is
 *     env-only, no code change and no re-gate"), preserved deliberately.
 *   • crypto axis OFF in the result — no live universe at all, nothing to widen.
 *
 * With no `previous` snapshot (the crypto-start path) the previous universe is
 * EMPTY, so any live universe reads as a widening and must be ratified — the same
 * fail-closed posture the rest of the gate takes on that path.
 */
function widenedBeyondRatifiedUniverse(
  updated: AccountSettings,
  previous: AccountSettings | undefined,
  next: { crypto: boolean },
  prev: { crypto: boolean },
): Map<string, string> {
  const blocks = new Map<string, string>();
  if (!next.crypto) return blocks;

  const nextPreset = resolveStrategyPreset(updated.activeStrategyPreset);
  // The previous LIVE universe is empty unless live crypto was already on: an
  // axis that was OFF exposed nothing, so it grandfathers nothing. This is the
  // same rule the roster delta uses, and the reason the crypto-start path (no
  // `previous`) is fail-closed here too.
  const prevPreset =
    previous && prev.crypto ? resolveStrategyPreset(previous.activeStrategyPreset) : null;

  for (const strategyId of nextPreset.enabledStrategies) {
    const nextUniverse = resolveStrategySymbolUniverse(nextPreset, strategyId);
    const prevUniverse = prevPreset
      ? resolveStrategySymbolUniverse(prevPreset, strategyId as CryptoStrategyType)
      : [];
    if (isSymbolUniverseSubset(nextUniverse, prevUniverse)) continue;
    if (LIVE_RATIFIED_CRYPTO_PRESETS.includes(nextPreset.id)) continue;

    const describe = (u: readonly string[] | null): string =>
      u === null
        ? 'the FULL Coinbase-tradable USD universe (≈395 pairs, unbounded — it grows with the catalog)'
        : u.length === 0
          ? 'nothing'
          : u.join(', ');
    blocks.set(
      strategyId,
      `TRA-2348 — this save WIDENS the live symbol universe for '${strategyId}' from `
        + `${describe(prevUniverse)} to ${describe(nextUniverse)} by selecting preset `
        + `'${nextPreset.id}', which is not on the board-ratified live-crypto list `
        + `(${LIVE_RATIFIED_CRYPTO_PRESETS.join(', ')}). A promotion sign-off is granted for a `
        + 'UNIVERSE, not just a strategy id: QuantTrader\'s live-money sign-off is CONDITIONAL GO '
        + 'on the OOS-validated majors and NO-GO on the full catalog (TRA-1304), so a majors or '
        + 'canary sign-off does not carry over to a wider one. Narrowing back to a ratified preset '
        + 'is never blocked, and turning live crypto OFF in this same save always succeeds.',
    );
  }
  return blocks;
}

export interface LiveTransitionGateResult {
  /** True when the live transition is allowed (or irrelevant — not turning/keeping live). */
  allowed: boolean;
  /** Per-strategy block details when `allowed === false`. */
  blocked: Array<{ strategyId: string; reasons: string[] }>;
}

/**
 * TRA-2351 — real-capital intent the CALLER is authorizing that the `updated`
 * snapshot does not (yet) describe.
 *
 * The gate's contract is "grade this resulting state". A caller that hands it a
 * state contradicting the action it is authorizing gets a correct answer to the
 * wrong question — which is exactly how `POST /api/crypto/trading/start` stayed
 * ungated: it resolves its mode from the REQUEST BODY, so an operator persisted
 * as `demo` could start LIVE crypto while the snapshot still read `demo`, and
 * every axis term collapsed to false. Declaring the intent here restores the
 * contract WITHOUT rewriting the snapshot — so only the declared axis is lifted
 * and no unrelated axis (e.g. options → Tradier Production) is dragged on with
 * it.
 *
 * Prefer {@link evaluateLiveCryptoStartGate} over passing this by hand: a
 * caller that must remember an optional argument is a caller that will forget.
 */
export interface LiveTransitionIntent {
  /**
   * The action turns ON live crypto auto-trading regardless of the snapshot's
   * persisted `mode`. Lifts the crypto axis only.
   */
  liveCrypto?: boolean;
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
 * supplied, only real-capital exposure the save NEWLY adds is gated. Holding
 * or reducing exposure (options production -> sandbox, or any edit that keeps an
 * already-live axis unchanged) always saves, so an operator can move toward
 * safety without first clearing a gate the current state already fails.
 *
 * TRA-2343 — "newly adds" is measured on the guarded STRATEGY ROSTER, not on the
 * axis boolean. Firing only on an axis flip left the gate bypassable in two
 * saves (arm the axis under the empty `no_trade` roster, then re-select the real
 * preset — which is not an axis escalation). It also refuses an escalation onto
 * an empty roster outright.
 *
 * TRA-2351 — `intent` lets a caller declare real-capital intent the snapshot does
 * not carry. See {@link LiveTransitionIntent}; the crypto-start path must use
 * {@link evaluateLiveCryptoStartGate} rather than composing this by hand.
 *
 * TRA-2348 — the roster delta is itself too coarse for crypto, where every live
 * preset enables the same single strategy and only the SYMBOL UNIVERSE differs.
 * A save that widens that universe past what the board ratified for real money is
 * refused outright — see {@link widenedBeyondRatifiedUniverse}. Narrowing and
 * holding stay unblocked.
 */
export async function evaluateLiveTransitionGate(
  username: string,
  updated: AccountSettings,
  previous?: AccountSettings,
  intent?: LiveTransitionIntent,
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
  //
  // TRA-2351 — the declared intent is OR'd into the resulting axes. It can only
  // ever turn an axis ON, never off, so it cannot loosen the gate; and it is
  // scoped to the crypto axis so an unrelated options-production posture is not
  // dragged into a crypto-start decision.
  const snapshotAxes = realCapitalIntentAxes(updated);
  const next = {
    crypto: snapshotAxes.crypto || intent?.liveCrypto === true,
    optionsProduction: snapshotAxes.optionsProduction,
  };
  const prev = previous
    ? realCapitalIntentAxes(previous)
    : { crypto: false, optionsProduction: false };
  const cryptoEscalates = next.crypto && !prev.crypto;
  // The legacy crypto-only trigger never considered the options axis; keep it
  // ungated there so the env-aware flag remains the only switch that arms it.
  const optionsEscalates = envAware && next.optionsProduction && !prev.optionsProduction;

  // TRA-2343 — fire on the ROSTER DELTA, not on the axis boolean.
  //
  // Firing on `axisNewlyOn` alone was bypassable in two saves, each one allowed
  // by the rules above:
  //   A. preset `no_trade` (enabledStrategies: []) + mode live + live crypto ON.
  //      The crypto axis escalates, so the gate fired — but onto an EMPTY
  //      roster, the `for` loop below never ran, and it returned allowed.
  //   B. preset `no_trade` → `crypto_core`. The axis is now on→on, so
  //      `cryptoEscalates` is false, the gate never fired, and `dca` was never
  //      graded. Net: live DCA across ~395 Coinbase pairs with zero promotion
  //      evidence — the exact state TRA-532 exists to prevent.
  // The axis is coarser than the risk it stands for: "live crypto is ON" is
  // latched, but the roster it exposes can change afterwards, and a roster
  // change is not an escalation of the axis.
  //
  // So we compare the guarded ROSTERS before/after and gate every strategy the
  // save NEWLY exposes to real capital. This keeps the TRA-1590 de-escalation
  // exemption intact by construction — anything already exposed under the
  // previous snapshot is grandfathered exactly as before (that grandfathering
  // IS the exemption), so holding or reducing exposure still never blocks,
  // while ADDING a strategy to a live axis is graded even when no axis flips.
  // Without a `previous` snapshot (the TRA-575 crypto-start path) the previous
  // roster is empty ⇒ everything reads as newly-exposed, reproducing the
  // pre-1590 fail-closed trigger verbatim.
  //
  // Scope: this guards the settings-write path only. The BOOT path that
  // force-writes `mode:live` + the crypto arm from env (TRA-2336) does not
  // route through here and is held by the TRA-2342 interlock instead — but a
  // later preset change through the API is now graded, which is the point.
  const nextRoster = guardedRosterByAxis(updated, envAware, next);
  const prevRoster = previous
    ? guardedRosterByAxis(previous, envAware)
    : { crypto: [], optionsProduction: [] };
  const alreadyExposed = new Set([...prevRoster.crypto, ...prevRoster.optionsProduction]);
  const strategies = [...new Set([...nextRoster.crypto, ...nextRoster.optionsProduction])].filter(
    id => !alreadyExposed.has(id),
  );

  // TRA-2343 hardening — an EMPTY enumeration must never sail through a
  // fail-closed check. A save that newly activates a real-capital axis while
  // its roster resolves to nothing (the `no_trade` stand-down preset, or an
  // unknown preset id, which `resolveStrategyPreset` also falls back to
  // `no_trade` for) is refused outright rather than silently approved. Nothing
  // legitimate is lost: an empty roster trades nothing, so there is no reason
  // to arm the axis for it — and arming it is precisely the stepping stone
  // above. Scoped to an ESCALATING axis, so no de-escalation can trip it.
  const emptyRosterAxes: Array<{ axis: string; detail: string }> = [];
  if (cryptoEscalates && nextRoster.crypto.length === 0) {
    emptyRosterAxes.push({
      axis: 'live crypto auto-trading',
      detail: `active preset '${resolveStrategyPreset(updated.activeStrategyPreset).id}' enables no strategies`,
    });
  }
  if (optionsEscalates && nextRoster.optionsProduction.length === 0) {
    emptyRosterAxes.push({
      axis: 'options → Tradier Production',
      detail: 'no options sleeve is named on the production roster',
    });
  }

  // TRA-2348 — the roster delta above is STRATEGY-granular; this is the same
  // comparison one level finer, on the (strategy, UNIVERSE) pair. It is computed
  // BEFORE the `strategies.length === 0` early return on purpose: the defect it
  // closes produces an EMPTY roster delta by construction ({dca} → {dca}), so a
  // check placed after that return could never fire.
  const universeBlocks = widenedBeyondRatifiedUniverse(updated, previous, next, prev);

  const blocked: Array<{ strategyId: string; reasons: string[] }> = emptyRosterAxes.map(e => ({
    strategyId: `(${e.axis})`,
    reasons: [
      `TRA-2343 — this save turns ON ${e.axis} with an EMPTY strategy roster (${e.detail}). `
      + 'A real-capital axis is never armed against an empty roster: turn the axis on together '
      + 'with the promoted strategies it should trade. '
      // TRA-2351 — an operator on the Options+Stock go-live path (TRA-1575) hits
      // this because a STALE live-crypto flag rides along with their mode flip;
      // they do not want live crypto at all, and the sentence above names the
      // wrong remedy for them. Turning the axis OFF is a de-escalation, so it
      // saves in the SAME request — say so, or the refusal reads as a deadlock.
      + `If you did not mean to arm ${e.axis} at all, turn it OFF in this same save — `
      + 'reducing exposure is never blocked.',
    ],
  }));

  if (strategies.length === 0 && blocked.length === 0 && universeBlocks.size === 0) {
    return { allowed: true, blocked: [] };
  }

  // TRA-1916 — each strategy is graded on ITS OWN promotion evidence. The prior
  // code always looped over the active *crypto* preset's roster, so an
  // options → Tradier-Production switch was judged entirely against the crypto
  // `dca` strategy (every shipped preset is crypto-only). That was wrong twice:
  // it false-blocked options on a failing crypto strategy, AND it never checked
  // any options sleeve's promotion at all. The rosters are now assembled per
  // axis by `guardedRosterByAxis`:
  //   • live crypto        → the active crypto preset's enabledStrategies
  //   • options production → OPTIONS_PRODUCTION_STRATEGIES (the board named
  //     Relative Value + OTM Mispricing on TRA-1916)
  // Fail-closed is preserved by construction: buildPromotionStatus →
  // evaluatePromotion returns canGoLive:false for any sleeve without a full
  // backtest+paper+signoff record, so an unpromoted options sleeve BLOCKS
  // (honoring the TRA-1897 HOLD) and the gate only opens once a named options
  // sleeve actually clears its net-of-fee promotion evidence.
  for (const strategyId of strategies) {
    const status = await buildPromotionStatus(username, strategyId);
    if (!status.canGoLive) blocked.push({ strategyId, reasons: status.blockedReasons });
  }

  // TRA-2348 — merge the universe refusals into the per-strategy entries rather
  // than appending a separate pseudo-strategy row. A universe widening IS a
  // property of that strategy's exposure, so a caller reading
  // `blocked.map(b => b.strategyId)` sees the strategy at fault either way, and
  // a strategy that fails BOTH checks reports both reasons in one entry instead
  // of appearing twice.
  for (const [strategyId, reason] of universeBlocks) {
    const existing = blocked.find(b => b.strategyId === strategyId);
    if (existing) existing.reasons.push(reason);
    else blocked.push({ strategyId, reasons: [reason] });
  }

  if (blocked.length > 0) {
    log.warn('TRA-532 promotion gate blocked live transition', {
      username,
      escalatingAxes: { crypto: cryptoEscalates, optionsProduction: optionsEscalates },
      preset: resolveStrategyPreset(updated.activeStrategyPreset).id,
      previousPreset: previous ? resolveStrategyPreset(previous.activeStrategyPreset).id : null,
      // TRA-2343 — the newly-exposed set, not the whole roster: what the save
      // ADDS to real capital is what was graded.
      newlyExposed: strategies,
      alreadyExposed: [...alreadyExposed],
      emptyRosterAxes: emptyRosterAxes.map(e => e.axis),
      // TRA-2348 — named separately from `newlyExposed`: a universe widening has
      // an EMPTY roster delta by construction, so without this key the log line
      // for the defect reads as "nothing was newly exposed" while refusing.
      universeWidened: [...universeBlocks.keys()],
      blocked: blocked.map(b => b.strategyId),
    });
    return { allowed: false, blocked };
  }
  return { allowed: true, blocked: [] };
}

/**
 * TRA-2351 — the ONLY correct way to gate `POST /api/crypto/trading/start`.
 *
 * THE DEFECT THIS EXISTS TO MAKE UNREACHABLE. That route resolves its mode from
 * the REQUEST BODY (`resolveTradingMode` — a body `mode` wins outright over
 * `settings.mode`), but used to compose the snapshot it handed the gate as
 * `{ ...settings, cryptoAutoTradingEnabledLive: true }` — carrying the PERSISTED
 * mode. For an operator on `demo` sending `{"mode":"live"}` the gate was asked to
 * authorize a LIVE start against a snapshot that read DEMO, so
 * `realCapitalIntentAxes` short-circuited to all-false and every downstream term
 * of the TRA-2343 roster delta collapsed: no escalating axis, both rosters empty,
 * `emptyRosterAxes` empty ⇒ ALLOWED. Not "graded and passed" — never graded, with
 * no TRA-532 refusal log. The route then PERSISTED `cryptoAutoTradingEnabledLive:
 * true`, and that arm is durable: its one remaining condition is the go-live
 * arming step itself (`TRADIER_ENV=production` force-writes `mode:'live'` in the
 * equity boot-arm, user-context.ts). Live crypto on an ungraded roster.
 *
 * The remedy is a NAMED entry point rather than an optional argument on the
 * general gate, because the failure was one of composition at the call site: a
 * route that hands over a raw snapshot can hand over the wrong one, whereas a
 * route that names the action cannot. Callers pass their CURRENT settings; the
 * live arm and the live intent are applied here, together, once.
 *
 * Nothing is persisted by this function — the caller decides what to save.
 */
export async function evaluateLiveCryptoStartGate(
  username: string,
  settings: AccountSettings,
): Promise<LiveTransitionGateResult> {
  return evaluateLiveTransitionGate(
    username,
    { ...settings, cryptoAutoTradingEnabledLive: true },
    undefined,
    { liveCrypto: true },
  );
}
