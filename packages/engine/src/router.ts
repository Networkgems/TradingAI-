import type { Candle, TradeSignal, SignalType } from '@trading-app/shared';
import type { RegimeDetector, Regime } from './regime.js';
import type { MomentumStrategy } from './strategies/momentum.js';
import type { MeanReversionCryptoStrategy } from './strategies/mean-reversion-crypto.js';
import type { BreakoutVolStrategy } from './strategies/breakout-vol.js';

/**
 * Per-tick decision the router would have produced if it took every signal
 * generated this evaluation. Surfaced for diagnostics so the engine and tests
 * can see why a particular strategy was suppressed by the dedupe rule even
 * though it would otherwise have fired.
 */
export interface RouterEvaluation {
  /** Active regime label after the detector has consumed this bar. */
  regime: Regime;
  /** The signal the router elected to forward to the engine, or `null`. */
  signal: TradeSignal | null;
  /**
   * Every strategy that fired this tick, ordered by descending priority. When
   * `signal` is non-null it equals `fired[0].signal`; the rest are the signals
   * that lost the dedupe joust. Empty when no strategy fired.
   */
  fired: ReadonlyArray<{ priority: SignalType; signal: TradeSignal }>;
}

/**
 * Dedupe priority for {@link StrategyRouter}. Higher index = higher priority.
 * The router takes the first strategy in this list that produced a signal on
 * the current tick. Defaults to the TRA-208 spec ordering:
 *   momentum > breakout_vol > mean_reversion
 *
 * The reasoning: trend trades (momentum) get the cleanest expected value when
 * a regime is trending, so when both momentum and breakout fire on the same
 * bar — typically a `flat → trend` transition the breakout caught early —
 * we route the trend signal. Breakout outranks mean-reversion because the
 * regime gates already make the overlap rare; when it does happen, the
 * volatility-expansion premise dominates the range premise.
 */
export type RouterPriority = ReadonlyArray<SignalType>;

export const DEFAULT_ROUTER_PRIORITY: RouterPriority = [
  'momentum',
  'breakout_vol',
  'mean_reversion',
];

export interface StrategyRouterOptions {
  regime: RegimeDetector;
  momentum: MomentumStrategy;
  meanReversion: MeanReversionCryptoStrategy;
  breakout: BreakoutVolStrategy;
  /**
   * Override the default {@link DEFAULT_ROUTER_PRIORITY} dedupe ordering. The
   * list MUST contain only signal types this router produces (`momentum`,
   * `breakout_vol`, `mean_reversion`) — unknown types are tolerated but never
   * match, which would silently drop their signals.
   */
  priority?: RouterPriority;
}

/**
 * Strategy router for the regime-aware roster (TRA-208).
 *
 * Wires a single shared {@link RegimeDetector} into momentum / breakout /
 * mean-reversion so all three see the same hysteresis-confirmed regime label
 * each bar. Picking eligible strategies is the regime detector's job — gating
 * here would just duplicate the gate each strategy already enforces — so we
 * call every strategy with the active label and let each one bail itself out.
 * That keeps the router's behaviour identical to the strategies' own opinions
 * on what regime they fire in, even as the spec evolves (e.g. breakout's
 * `flat → high_vol` transition window is a strategy-internal rule, not
 * something the router needs to know about).
 *
 * Dedupe: when more than one strategy fires on the same bar, the highest-
 * priority one wins (default `momentum > breakout_vol > mean_reversion`).
 * Because each strategy already deduplicates internally (cooldowns, regime
 * gates), simultaneous fires are rare in practice — the dedupe rule mostly
 * matters at regime-transition bars where the in-flight regime label briefly
 * agrees with two strategies' premises.
 *
 * Lifetime: one router per symbol. The {@link RegimeDetector} carries
 * per-symbol hysteresis state, so sharing one router across symbols would
 * pollute the regime label across uncorrelated tapes. The crypto engine
 * (TRA-208 wiring) lazily creates one router per symbol for this reason.
 */
export class StrategyRouter {
  private readonly regime: RegimeDetector;
  private readonly momentum: MomentumStrategy;
  private readonly meanReversion: MeanReversionCryptoStrategy;
  private readonly breakout: BreakoutVolStrategy;
  private readonly priority: RouterPriority;

  constructor(opts: StrategyRouterOptions) {
    this.regime = opts.regime;
    this.momentum = opts.momentum;
    this.meanReversion = opts.meanReversion;
    this.breakout = opts.breakout;
    this.priority = opts.priority ?? DEFAULT_ROUTER_PRIORITY;
  }

  /** Active regime label without consuming a bar. */
  currentRegime(): Regime {
    return this.regime.current();
  }

  /**
   * Evaluate the full roster against `candles` for `symbol` and return the
   * single highest-priority signal that fired this tick — or `null` when
   * nothing fired. Use {@link evaluateDetailed} when you need to see the
   * losers of the dedupe joust too (diagnostics, tests).
   */
  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    return this.evaluateDetailed(symbol, candles).signal;
  }

  /**
   * Same as {@link evaluate} but returns the full per-tick decision: the
   * regime label after the detector consumed this bar, every strategy that
   * fired ordered by priority, and the elected signal (`fired[0]` or null).
   */
  evaluateDetailed(symbol: string, candles: Candle[]): RouterEvaluation {
    // Tick the detector once for this bar. Every regime-aware strategy below
    // is then called with the post-update label so they share one hysteresis
    // state. Returning early on an empty candle window matches the strategies'
    // own short-circuits and keeps the regime stuck at `flat` (its default).
    const regime: Regime = candles.length === 0
      ? this.regime.current()
      : this.regime.update(candles);

    const fired: Array<{ priority: SignalType; signal: TradeSignal }> = [];

    // Each strategy enforces its own regime gate (momentum: trend_*; mean-rev:
    // range; breakout: high_vol or flat). We still call all three: the gate is
    // strategy-specific (breakout deliberately fires on the `flat → high_vol`
    // transition bar, for example) and centralizing it here would risk drift
    // every time a strategy's spec changes.
    const momentumSig = this.momentum.evaluate(symbol, candles, regime);
    if (momentumSig) fired.push({ priority: 'momentum', signal: momentumSig });

    const breakoutSig = this.breakout.evaluate(symbol, candles, regime);
    if (breakoutSig) fired.push({ priority: 'breakout_vol', signal: breakoutSig });

    const meanRevSig = this.meanReversion.evaluate(symbol, candles, regime);
    if (meanRevSig) fired.push({ priority: 'mean_reversion', signal: meanRevSig });

    if (fired.length === 0) return { regime, signal: null, fired: [] };

    // Sort by configured priority. A smaller index in `priority` wins, so use
    // `indexOf` and treat unknowns as +∞ — they sink to the bottom rather than
    // silently winning by default. Stable sort preserves declaration order
    // when two strategies have the same priority index (shouldn't happen in
    // practice but cheap insurance).
    const ranked = [...fired].sort((a, b) => {
      const ai = this.priority.indexOf(a.priority);
      const bi = this.priority.indexOf(b.priority);
      const aRank = ai === -1 ? Number.POSITIVE_INFINITY : ai;
      const bRank = bi === -1 ? Number.POSITIVE_INFINITY : bi;
      return aRank - bRank;
    });

    return { regime, signal: ranked[0].signal, fired: ranked };
  }

  /** Reset the underlying detector's hysteresis state. Test/backtest helper. */
  reset(): void {
    this.regime.reset();
  }
}
