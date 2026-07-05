// Shared types and utilities across all packages

// TRA-532 — Live-Trading Promotion Gate (pure core: thresholds, metric
// computation from data, per-stage evaluation, overall verdict, audit record).
export * from './promotion-gate.js';

// TRA-534 — News-sentiment scorer (lexicon-v1) + per-symbol aggregate.
export * from './news-sentiment.js';

// TRA-602 — StockTwits social-sentiment aggregate.
export * from './social-sentiment.js';

// TRA-598 (C3) — first-class "no day trading" guardrail: central config block
// + pure decision helpers shared by idea-gen and the order-time paths.
export * from './day-trading-guardrail.js';

// TRA-954 — risk-capped conviction DCA (scale-in) sizing layer for equities +
// options: config surface + the exact R-cap solver and the equity/option gates.
export * from './conviction-dca.js';

// TRA-1303 — Position Advisor readout data contract (next DCA add + sell plan
// per held demo-book symbol). Types only; the server fills it by re-running the
// shipped engine cores read-only.
export * from './position-advisor.js';

// TRA-950 — structured review block (leaders / invalidation / gapRisk / regime)
// persisted with each pre/post-market review and wired into both decision paths.
export * from './review-block.js';
import type { ReviewBlock } from './review-block.js';

export type Side = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected';
export type SignalType =
  | 'orb_breakout'
  | 'reversal'
  | 'macd_cross'   // legacy MacdBollingerStrategy — kept so historical positions/snapshots still type-check
  | 'macd_trend'   // TRA-170: trend-continuation half of the split MACD-Bollinger
  | 'bb_fade'      // TRA-170: pure mean-reversion half
  | 'momentum'     // TRA-205: MA-cross + Donchian breakout, gated to trend regimes
  | 'mean_reversion' // TRA-206: regime-gated RSI+BB mean reversion (range-only, long+short)
  | 'breakout_vol' // TRA-207: consolidation + volume-confirmed breakout, high-vol regime
  | 'ichimoku'
  | 'scalping'
  | 'swing_trade'
  | 'dca'          // TRA-693: dollar-cost-averaging accumulation — long-only, trend-gated, cadence-paced
  | 'otm_mispricing'
  | 'relative_value' // TRA-191: options chain relative-value scanner (IV skew + monotonic + no-arb)
  | 'sma200_pullback' // TRA-451: pullback-to-200 bounce (continuation long), daily bars
  | 'sma200_reclaim'  // TRA-451: 200-SMA reclaim reversal (trend-change swing), daily bars
  | 'supertrend_confluence' // TRA-728: Supertrend + MA-stack + MACD + RSI confluence (options, router-gated off in Phase 1)
  | 'tsmom_majors' // TRA-821: time-series-momentum on BTC/ETH/SOL — daily, long-or-flat, band-exit (TRA-817 workstream C)
  | 'tradier_import'; // TRA-323: position imported from Tradier (opened directly on the broker, synced into TradeAI to be closed here)
export type OptionType = 'call' | 'put';

export interface Candle {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * TRA-427 — set when this bar was synthesised to bridge a genuine
   * exchange data gap (no upstream OHLCV for the interval). Synthetic bars
   * are flat (O=H=L=C = prior close) with zero volume. Absent on real bars.
   */
  synthetic?: boolean;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  type: SignalType;
  side: Side;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  timestamp: number;
  /**
   * TRA-231 — account mode the signal fired under. The dashboard's Signals
   * panel filters to entries matching the currently active mode so a flip
   * between Demo and Live shows each side's history independently. Optional
   * for back-compat with persisted snapshots written before the field
   * existed; absent ↔ legacy demo (only mode that emitted signals pre-field).
   */
  mode?: AccountMode;
  /**
   * TRA-243 — short human-readable reason a live signal failed to open a
   * position on Coinbase (e.g. "no spendable cash", "below $1 minimum",
   * "spot account cannot open shorts", or the Coinbase REST error message).
   * Surfaced on the dashboard signal card so the user can diagnose silent
   * skips themselves instead of mining server logs. Absent on success and
   * on demo-mode signals (demo never skips for liquidity reasons).
   */
  liveSkipReason?: string;
  /**
   * TRA-261 — strategy / pre-route suppression reason: stamped when a signal
   * fired but a strategy-level gate blocked the engine from routing it (e.g.
   * MR shorts off-strategy, perp universe gate, funding/regime/spread/OI
   * short filters). Distinct from `liveSkipReason` (broker-side reject); a
   * signal carrying `signalSkipReason` is a deliberately-suppressed signal,
   * shown on the dashboard so the user knows the strategy fired and why we
   * declined to route it. Absent on signals that proceed normally.
   */
  signalSkipReason?: string;
  /**
   * TRA-1289 (TRA-1288 Option A) — marks a fill that opened via the DEMO-ONLY,
   * flag-gated forward-test path for an un-gate-passed router (today only the
   * primary swing router `sma200_pullback` under `ENABLE_SMA200_DEMO_FORWARD_TEST`).
   * These paper fills exist purely to forward-test signal accuracy (TRA-955)
   * and MUST NOT be read as OOS-keeper-gate evidence: TRA-1242 accrual and any
   * promotion logic use this flag to distinguish them from real gate-passed
   * fills. Absent on every normal signal; only ever set in demo mode.
   */
  forwardTestOnly?: boolean;
}

/**
 * Signal emitted by the OTM mispricing scanner (TRA-159) for cheap OTM contracts
 * — long-only path. `entryPrice` is the per-share option mark so the existing
 * watchlist UI can render it without special-casing; option-specific fields ride
 * along on the same record so `PaperOptionsAccount.openOptionFromCandidate` can
 * sticker the position with the OCC symbol, strike, and theo without a second
 * lookup.
 */
export interface OtmMispricingSignal extends TradeSignal {
  type: 'otm_mispricing';
  side: 'buy';
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  /** Per-share mark used as the entry premium. */
  mark: number;
  /** Black-Scholes theoretical price for the contract at scan time. */
  theo: number;
  /** (mark − theo) / theo. Negative for `cheap` candidates. */
  mispricingPct: number;
  /** Sign-adjusted Black-Scholes delta from the scanner. */
  delta: number;
}

/**
 * Signal emitted by the options chain relative-value scanner (TRA-191).
 * Long-only entry when a contract trades cheap relative to its same-expiration
 * IV skew — short legs are deferred to a future defined-risk-spread iteration.
 *
 * `entryPrice` is the per-share mark; the option-specific fields ride along on
 * the same record so `PaperOptionsAccount.openOptionFromRvCandidate` can
 * sticker the position with the OCC symbol, strike, and fair-value reference.
 */
export interface RelativeValueSignal extends TradeSignal {
  type: 'relative_value';
  side: 'buy';
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  /** Per-share mid (entry premium). */
  mark: number;
  /** Black-Scholes price built from the fitted skew IV. */
  fairPrice: number;
  /** (mark − fairPrice) / fairPrice. Negative for cheap candidates. */
  mispricingPct: number;
  /** IV residual versus fitted skew, in standard deviations. */
  zScore: number;
  /** σ predicted by the fitted skew at this strike. */
  ivFitted: number;
  /** σ used for this row (Tradier mid IV / smvVol / BS-implied fallback). */
  ivUsed: number;
  /** Sign-adjusted Black-Scholes delta at the fitted IV. */
  delta: number;
  /** Free-text reason mirrored from the scanner — surfaces in the UI feed. */
  reason: string;
  /**
   * TRA-957/TRA-970 — grading sleeve. Under Option A the RV single-leg path is
   * folded into the directional swing sleeve (trend-gated, delta-targeted,
   * 30–45 DTE), so its fills grade as `'directional'` against the swing spec —
   * unambiguously, not blended with the separate vol-mispricing book.
   */
  sleeve?: 'directional';
}

/**
 * TRA-451 — signal emitted by the SMA-200 trend-filter scanner. Covers the
 * pullback-to-200 bounce (`sma200_pullback`) and the 200-SMA reclaim reversal
 * (`sma200_reclaim`), both computed on daily bars. `entryPrice` is the latest
 * daily close and `stopLoss` is the spec-defined protective stop; the extra
 * fields ride along so the Signals tab can render the spec UI row (RSI,
 * dist_atr, trend-quality badge) without a second lookup.
 *
 * TRA-460 — `sma200_pullback` (Signal 2 v2) cleared the TRA-455 acceptance
 * gate and the engine opens a live position off it; `sma200_reclaim`
 * (Signal 3) failed validation and stays display-only.
 */
export interface Sma200Signal extends TradeSignal {
  type: 'sma200_pullback' | 'sma200_reclaim';
  side: 'buy';
  /** RSI(14) at the fire bar. */
  rsi: number;
  /** (close − SMA200) / ATR(14) — distance to the 200-SMA in ATRs. */
  distAtr: number;
  /** Signal-1 uptrend-quality gate state at the fire bar. */
  trendQuality: boolean;
  /** Reclaim-only: SMA50 > SMA200 golden-cross secondary confirmation. */
  goldenCross?: boolean;
  /** Human-readable context label from the spec ("continuation …" etc.). */
  context: string;
}

/** Result of a protective-bracket sanity check (TRA-520). */
export interface BracketCheck {
  ok: boolean;
  /** Human-readable failure reason; present only when `ok === false`. */
  reason?: string;
}

/**
 * TRA-520 — validate that a signal's / position's protective bracket is
 * structurally sound before it is emitted or opened.
 *
 * Invariants enforced:
 *   - `entryPrice`, `stopLoss`, `takeProfit` are all finite and **positive**
 *     (a non-positive stop/target is unreachable, so the exit never fires).
 *   - The stop and target sit on the correct side of entry for the direction:
 *       long  (`buy`):  `stopLoss < entry < takeProfit`
 *       short (`sell`): `takeProfit < entry < stopLoss`
 *
 * A negative stop on a long leaves the position with no real downside
 * protection; a negative target on a short can never be reached. Both were
 * observed in the wild (ASTC `stopLoss=-0.215`, PRFX `takeProfit=-0.04`) and
 * silently disabled the risk-management exits — this check rejects them.
 */
export function validateBracket(
  side: Side,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
): BracketCheck {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { ok: false, reason: `entry must be a positive finite price (got ${entryPrice})` };
  }
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    return { ok: false, reason: `stopLoss must be a positive finite price (got ${stopLoss})` };
  }
  if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
    return { ok: false, reason: `takeProfit must be a positive finite price (got ${takeProfit})` };
  }
  if (side === 'buy') {
    if (stopLoss >= entryPrice) {
      return { ok: false, reason: `long stopLoss ${stopLoss} must be below entry ${entryPrice}` };
    }
    if (takeProfit <= entryPrice) {
      return { ok: false, reason: `long takeProfit ${takeProfit} must be above entry ${entryPrice}` };
    }
  } else {
    if (stopLoss <= entryPrice) {
      return { ok: false, reason: `short stopLoss ${stopLoss} must be above entry ${entryPrice}` };
    }
    if (takeProfit >= entryPrice) {
      return { ok: false, reason: `short takeProfit ${takeProfit} must be below entry ${entryPrice}` };
    }
  }
  return { ok: true };
}

/**
 * Why a closed position exited. Surfaced in `Position.exitReason` so backtest
 * trade logs can break PnL down by lifecycle path:
 *   - `stop`         hard stop hit at `stopLoss`
 *   - `target`       initial take-profit hit at `takeProfit`
 *   - `time_stop`    per-strategy bar-count cap reached without stop/target
 *   - `trailing`     trailing-stop ratchet exited (incl. break-even after +Nx ATR)
 *   - `rsi_alt_exit` mean-reversion alternate exit (RSI re-crossed 50 from
 *                    the entry-side extreme, beating the BB-middle target)
 *   - `invalid_bracket` TRA-518 — self-heal close of a position whose protective
 *                    bracket was structurally invalid (negative/NaN stop or
 *                    target, or on the wrong side of entry; predates the
 *                    TRA-520 `validateBracket` guard). Such a bracket can never
 *                    hit stop or target, so the position would otherwise stay
 *                    open forever ("demo account never closes anything"). The
 *                    monitor force-closes it at the live price.
 */
export type ExitReason =
  | 'stop'
  | 'target'
  | 'time_stop'
  | 'trailing'
  | 'rsi_alt_exit'
  | 'tsmom_band_exit' // TRA-821: tsmom_majors long-or-flat exit when trailing L-day return crosses below -exitBandPct
  | 'chandelier'  // TRA-1268: ATR chandelier trailing-stop ratchet exit (Rule 1)
  | 'profit_lock' // TRA-1268: trade-level profit-lock give-back-cap exit (Rule 2)
  | 'invalid_bracket';

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  signalType: SignalType;
  /**
   * TRA-333 — id of the TradeSignal that opened this position. Optional so
   * (a) snapshots persisted before the field existed still rehydrate, and
   * (b) non-signal entries (imported wallet holdings — see TRA-318) can
   * coexist without a synthesized id. Every signal-driven open path stamps
   * this from `signal.id`; the dashboard uses presence to distinguish
   * signal-sourced positions from imported ones.
   */
  signalId?: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  pnl?: number;
  /**
   * TRA-211: which lifecycle path closed the position. Optional so legacy
   * call-sites that only stamp `pnl` keep type-checking; the backtest runner
   * always sets it.
   */
  exitReason?: ExitReason;
  /**
   * TRA-211: bars the position was held for, set on close. Drives per-strategy
   * time-stop diagnostics in the trade log.
   */
  barsHeld?: number;
  /**
   * TRA-231 — account mode the position was opened under. The dashboard's
   * Open Positions / Closed Positions tabs filter to entries matching the
   * currently active mode so flipping Demo ↔ Live shows each side's history
   * independently. Optional for back-compat with snapshots persisted before
   * the field existed; absent ↔ legacy demo (live equity wasn't wired yet).
   */
  mode?: AccountMode;
  /**
   * TRA-1289 (TRA-1288 Option A) — set on a demo paper position opened via the
   * flag-gated forward-test path for an un-gate-passed router (`sma200_pullback`
   * under `ENABLE_SMA200_DEMO_FORWARD_TEST`). Stamped from `signal.forwardTestOnly`
   * so TRA-1242 accrual / any promotion logic can tell these signal-accuracy
   * paper fills apart from real gate-passed fills and never treat them as OOS
   * keeper-gate evidence. Absent on every non-forward-test position; demo-only.
   */
  forwardTestOnly?: boolean;
  /**
   * TRA-249-C — instrument family the position was opened against. Spot
   * positions (the default and only kind pre-TRA-249) keep the field absent
   * so persisted snapshots and every non-crypto-live caller continue to
   * type-check and serialize byte-identically. `'perp'` is set on Coinbase
   * INTX perpetual shorts the live crypto account opens via the routing
   * fork so the dashboard can render leverage/margin/liq-price alongside
   * the entry.
   */
  productType?: 'spot' | 'perp';
  /** TRA-249-C — perp leverage multiplier (1× in the first epic pass). Spot positions leave this undefined. */
  leverage?: number;
  /** TRA-249-C — initial USD margin posted for a perp position (≈ entry × qty / leverage at open). */
  marginUsd?: number;
  /** TRA-249-C — informational liquidation price for a perp position. Approximate at open; the exchange recomputes as the position moves. */
  liquidationPrice?: number;
  /**
   * TRA-249-D — cumulative funding paid (negative) or received (positive) on
   * an open perp position, in USD. Each hourly accrual adds `fundingRate ×
   * notional × sideMultiplier`; on close the value is folded into `pos.pnl`
   * so the closed-positions API surfaces total realized P&L matching the
   * Coinbase statement. Absent on spot positions and on perps that have not
   * yet seen a funding tick.
   */
  fundingPnl?: number;
  /** TRA-249-D — wall-clock ms of the last funding accrual on this position. Diagnostics + idempotency. */
  lastFundingAccrualAt?: number;
  /**
   * TRA-338 — provider that supplied the entry price stamped on this position.
   * Crypto entries must come from Coinbase Exchange (the same venue we trade
   * on); this audit field records that fact on the persisted snapshot so a
   * future incident can be triaged from the trades API in seconds rather than
   * by reconstructing the cascade order from the logs.
   *
   * Background: TRA-337 found that a Yahoo-fallback ghost MEGA-USD quote
   * ($4.05, frozen 2022) opened a paper position whose current Coinbase price
   * was $0.12 — a 97% phantom loss with no audit trail. From TRA-338 forward
   * `'coinbase'` is the only legal value on a crypto entry; `'yahoo'` /
   * `'cmc'` may appear on legacy snapshots for pre-fix positions, and
   * `'unknown'` is the back-fill for positions persisted before the field
   * existed. Stocks / options paths do not stamp this today.
   */
  quoteSource?: PositionQuoteSource;
  /**
   * TRA-415 — set on equity positions imported from Tradier by the periodic
   * live-equity reconcile sweep (a stock opened out-of-band on the Tradier
   * web UI, or left behind by a failed mirror order). Distinguishes these
   * rows from engine-opened live equity mirrors so the reconciler can drop
   * them when Tradier no longer reports the symbol without touching the
   * engine's own bookkeeping. Absent on every engine-opened position.
   */
  importedFromTradier?: boolean;
  /**
   * TRA-536 — realized entry slippage cost in account currency: the magnitude
   * of the drift between the price the strategy intended to enter at
   * (`signal.entryPrice`) and the live price the paper fill actually executed
   * at (`Position.entryPrice`), times quantity — i.e.
   * `|fillPrice − signalEntryPrice| × quantity`. Stamped at open by the paper
   * fill paths (stocks + crypto demo). Consumed by the TRA-532 Stage-2
   * promotion gate, which compares Σrealized ÷ Σmodeled against the
   * `maxSlippageRatio` cap. Optional → back-compat with snapshots persisted
   * before the field existed (those keep the slippage check advisory).
   */
  realizedSlippage?: number;
  /**
   * TRA-536 — modeled slippage budget in account currency for this trade's
   * entry fill: `slippageBps/10000 × entryNotional`, using the same 5 bps
   * per-fill assumption the backtest cost model charges (crypto
   * `CRYPTO_SLIPPAGE_BPS`, equity `backtest-equity` `SLIPPAGE_BPS`). The gate
   * divides realized by this to detect live fills that drift materially worse
   * than the cost model assumed. Optional for the same back-compat reason as
   * {@link realizedSlippage}.
   */
  modeledSlippage?: number;
  /**
   * TRA-961 — DCA accumulation hold flag. When true this position is a held DCA
   * accumulation: the per-leg take-profit is NOT enforced on exit (a 4R TP would
   * close the position and defeat "hold and accumulate"), so the only automatic
   * exit is the catastrophe stop (or a future portfolio-level rule). Set on the
   * initial DCA entry when accumulation mode is on and re-affirmed on every add.
   * Absent → legacy per-leg TP behavior (every non-DCA path serializes
   * byte-identically). See {@link dcaFills}.
   */
  dcaHold?: boolean;
  /**
   * TRA-961 — number of fills (initial entry + accumulation adds) blended into
   * this DCA position. 1 at entry, incremented on each add. Drives the
   * "multiple fills averaging one growing position" acceptance evidence and the
   * dashboard's accumulation badge. Absent on legacy / non-DCA positions.
   */
  dcaFills?: number;
}

/**
 * TRA-338 — provenance label for the entry price written onto a Position.
 * Mirrors the providers in `crypto-feed.ts`'s cascade plus a `'manual'` slot
 * for human-driven opens (admin tooling, reconciliation imports) and an
 * `'unknown'` back-fill for pre-TRA-338 snapshots.
 */
export type PositionQuoteSource = 'coinbase' | 'coingecko' | 'yahoo' | 'cmc' | 'manual' | 'unknown';

export interface AccountState {
  totalEquity: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
  weeklyPnl?: number;
  monthlyPnl?: number;
  yearlyPnl?: number;
  allTimePnl?: number;
  /**
   * TRA-367 — broker-reported option buying power (Tradier margin/PDT/cash
   * account flavour). Surfaced in live mode so the Options panel can show
   * the real "cash available for options trades" instead of the paper
   * bookkeeping bucket (which mixes demo + live opens). Absent in demo or
   * when Tradier hasn't returned a balance yet.
   */
  optionBuyingPower?: number;
  /**
   * TRA-483 — broker-reported day-trade buying power (PDT day-trading
   * limit) from Tradier. Surfaced in live mode so the Options panel can
   * show the real DTBP alongside `optionBuyingPower` — when DTBP=$0 the
   * broker rejects same-day round trips even with positive option BP, so
   * the live engine also gates RV opens against it. Absent in demo, on
   * cash accounts (no DTBP), or before the first balance fetch.
   */
  dayTradeBuyingPower?: number;
  /**
   * TRA-725 — Tradier account-panel parity fields, surfaced in live mode so
   * the Stocks dashboard can render a card mirroring what Tradier shows. All
   * are live-only (sourced from the broker balance) and absent in demo or
   * before the first balance fetch, so the card degrades gracefully ("—").
   *
   * `settledFunds` doubles as Tradier's "Settled Funds" and "Settled Cash"
   * (same source: total_cash − unsettled_funds). The three *Value fields are
   * Tradier's per-asset-class market values.
   */
  settledFunds?: number;
  stockLongValue?: number;
  optionLongValue?: number;
  optionShortValue?: number;
}

export const DEFAULT_RISK_PER_TRADE = 0.01; // 1% of account equity
export const MANAGED_ACCOUNT_RATIO = 0.5;   // 50% of total account auto-managed

// ── Strategy Presets (TRA-325) ────────────────────────────────────────────────
//
// Named, read-only library of crypto-strategy configurations the Settings UI
// can switch between without a code change. Each preset declares which crypto
// strategies are enabled and an optional symbol whitelist that scopes signal
// emission to a subset of the watchlist.
//
// Adding a preset is a code change (no UI editor in v1, by design). The active
// preset id lives on `AccountSettings.activeStrategyPreset`; the engine reads
// it on every tick so a switch takes effect on the next 60s evaluation
// (no restart required). The legacy `LIVE_STRATEGY_PRESET` env var continues
// to act as a process-wide forced override — set on Render, it pins every
// user/engine to the named preset regardless of saved settings.

/**
 * Canonical preset identifiers — the literal union doubles as runtime validation.
 *
 * TRA-697 retired the OOS-failed legacy crypto roster: the `legacy_5`,
 * `bb_fade_sol_doge`, and `tra405_validated` presets were dropped after
 * QuantTrader's TRA-695 verdict (the legacy timing strategies and the
 * macd_bollinger/bb_fade edge all fail the lower-CI-bound OOS robustness gate)
 * and the TRA-693 board decision (approval `cf17cc82`) to run a DCA-only
 * forward paper leg instead. Only the live-relevant presets survive: `no_trade`
 * (the live stand-down) and `crypto_core` (the go-forward DCA-only roster).
 */
export type StrategyPresetId = 'no_trade' | 'crypto_core' | 'crypto_core_live_majors';

/** Crypto-strategy SignalTypes routable by the engine. Subset of {@link SignalType}. */
export type CryptoStrategyType =
  | 'bb_fade'
  | 'swing_trade'
  | 'momentum'
  | 'mean_reversion'
  | 'breakout_vol'
  | 'dca'; // TRA-694: dollar-cost-averaging accumulation (direct, non-router strategy)

export interface StrategyPreset {
  id: StrategyPresetId;
  /** Human-readable label rendered in the Settings UI. */
  displayName: string;
  /** One-line summary shown alongside the preset card. */
  description: string;
  /**
   * Strategies allowed to emit signals while this preset is active. Strategies
   * outside this set are evaluated as no-ops (engine returns null without
   * running indicators), keeping CPU off the hot path.
   */
  enabledStrategies: readonly CryptoStrategyType[];
  /**
   * Optional whitelist scoping signal emission to these symbols. Compared
   * case-sensitively against the engine's product ids (e.g. 'SOL-USD').
   * `null` means no preset-level filter — the existing per-strategy gates
   * (long universe, perp-shorts universe, denylist) apply unchanged.
   *
   * Applies to *every* enabled strategy uniformly. For strategies validated on
   * different symbol sets, use {@link strategyUniverse} instead.
   */
  symbolFilter: readonly string[] | null;
  /**
   * TRA-421 — optional per-strategy universe whitelist. Maps a strategy id to
   * the symbols that strategy is validated to trade; a strategy emits a signal
   * only when the symbol is in its list. A strategy absent from this map is
   * gated by {@link symbolFilter} alone. An explicit empty array disables the
   * strategy on every symbol.
   *
   * This is the lever the TRA-405 §8 out-of-sample go/no-go calls for: the
   * macd_bollinger mean-reversion edge survives costs only on BTC-USD and
   * SOL-USD, so the live `bb_fade` strategy (its productionised form — see the
   * `tra405_validated` preset) is mapped to exactly those two symbols while
   * other strategies on the same preset keep their own (or no) universe.
   * Evaluated in addition to {@link symbolFilter}; both gates must pass.
   */
  strategyUniverse?: Readonly<Partial<Record<CryptoStrategyType, readonly string[]>>>;
}

/**
 * Read-only preset library. TRA-697 retired the OOS-failed legacy roster
 * (`legacy_5`, `bb_fade_sol_doge`, `tra405_validated`) — see {@link StrategyPresetId}
 * — leaving the two live-relevant presets:
 *   • `no_trade`   — TRA-434 risk stand-down preset: zero enabled strategies
 *                    and an empty symbol whitelist, so every per-tick
 *                    `strategyEnabled()` / `symbolAllowed()` check returns
 *                    false and the engine opens NO new entries. Exit/position-
 *                    management logic is not gated by the preset, so positions
 *                    already open continue to close on their own stop/target
 *                    rules. Used by the `LIVE_STRATEGY_PRESET` env var (and as
 *                    the resolver's default — see {@link DEFAULT_STRATEGY_PRESET_ID})
 *                    to keep the live crypto engine stood down.
 *                    TRA-456: `LIVE_STRATEGY_PRESET` is scoped to the LIVE
 *                    engine only — the demo engine ignores it and runs
 *                    `DEMO_STRATEGY_PRESET` (default `crypto_core`), so the
 *                    live stand-down never blanks the paper-money demo board.
 *   • `crypto_core` — TRA-698 go-forward roster: DCA only, scoped to the
 *                     OOS-survivable liquid majors {BTC-USD, SOL-USD}. Demo/
 *                     paper-only forward leg; LIVE stays `no_trade` until the
 *                     leg proves out and the board re-approves under TRA-693.
 *
 * Future presets are added here without code changes elsewhere — the engine
 * resolves by id, the UI lists `Object.values(STRATEGY_PRESETS)`.
 */
export const STRATEGY_PRESETS: Readonly<Record<StrategyPresetId, StrategyPreset>> = {
  no_trade: {
    id: 'no_trade',
    displayName: 'No-trade — engine paused',
    description:
      'Risk stand-down (TRA-434): no strategies enabled and an empty symbol whitelist, so the engine opens no new entries on any symbol. Open positions still close on their existing exit logic. Used to pause the live crypto pilot after the TRA-432 NO-GO verdict.',
    enabledStrategies: [] as const,
    symbolFilter: [] as const,
  },
  // TRA-693 / TRA-694 / TRA-698 — the post-TRA-432 replacement roster.
  //
  // The legacy timing strategies (momentum / breakout_vol / mean_reversion /
  // bb_fade) all failed the CTO-adopted lower-CI-bound OOS robustness gate, so
  // the live engine was stood down to `no_trade`. `crypto_core` is the board's
  // recommended rebuild: dollar-cost averaging (DCA) — robust by construction
  // because it does not need a per-trade edge that beats costs.
  //
  // TRA-695 backtested the original DCA + disciplined-swing roster on the
  // TRA-405 4H caches and returned NO-GO for swing on all 6 symbols (too
  // inactive at 4H, TRA-540 gate verdict.pass=false) and beta-not-alpha for
  // DCA (OOS 2025-26 deep-bear drawdowns), with the only OOS-survivable
  // accumulation core being the liquid majors {BTC-USD, SOL-USD}. On the
  // TRA-693 gate (board approval `cf17cc82`, 2026-06-07) the board adopted the
  // recommended path: DROP swing entirely and run `crypto_core` as a DCA-only
  // forward paper leg on {BTC-USD, SOL-USD} before any live capital.
  //
  // TRA-698 sets this go-forward config: DCA only, BTC/SOL only. Demo/paper
  // only — the live cutover (`LIVE_STRATEGY_PRESET`) stays `no_trade`, owned by
  // parent TRA-693 under board approval, and will not promote until the forward
  // paper leg shows OOS-positive, risk-adjusted, after-cost results AND the
  // board re-approves. The forward leg runs under the TRA-526 2%/trade hard cap
  // and global kill-switch.
  crypto_core: {
    id: 'crypto_core',
    displayName: 'Crypto Core — DCA across all Coinbase-tradable cryptos',
    description:
      'TRA-693 board directive: dollar-cost-averaging accumulation (long-only, trend-gated, cadence-paced) across the FULL Coinbase-tradable USD universe (≈395 pairs), not just BTC/SOL. DCA is robust by construction (no per-trade cost edge required), the failure mode that benched the legacy roster, and the trend gate (price > 200-day EMA) keeps entries to assets in an established uptrend. The engine sources the live universe from the Coinbase product catalog; minute-bar fetching is skipped under this DCA-only preset so the daily-bar feed stays inside Coinbase rate limits at full breadth. Demo/paper under the TRA-526 2% cap + kill-switch; LIVE stays no_trade until the forward leg proves out and the board re-approves real-money crypto via the TRA-532 promotion gate.',
    enabledStrategies: ['dca'] as const,
    // TRA-693 — no per-strategy universe cap: DCA is evaluated on every active
    // (Coinbase-tradable, non-denylisted) symbol the engine resolves. symbolFilter
    // stays null so the preset-wide gate is open and breadth is governed by the
    // engine's active-symbol universe (sourced from the Coinbase product catalog).
    symbolFilter: null,
  },
  // TRA-1304 — LIVE-MONEY DCA preset, universe pinned to the OOS-validated
  // liquid majors. QuantTrader's live-money sign-off (CONDITIONAL GO) blocks
  // flipping DCA live against `crypto_core`'s full ~395-pair `symbolFilter: null`
  // universe: only BTC/ETH/SOL carry OOS validation (TRA-695 found BTC-USD +
  // SOL-USD OOS-survivable through the 2025-26 deep-bear drawdowns), and the
  // 25% fallback stop that engages when ATR is unavailable (thin/young listings)
  // is a tail a microcap can gap straight through. This preset is the
  // majors-pinned target `LIVE_STRATEGY_PRESET` must point at BEFORE any real
  // order fires — it keeps DCA-only, hard-restricts emission to the three
  // majors via BOTH the preset-wide `symbolFilter` and the per-strategy
  // `strategyUniverse` whitelist (defense in depth), and never widens. Demo
  // keeps its broad `crypto_core`. First live window: majors only, no cap
  // increases, ≥30 days of live fills, then a fresh sign-off before any
  // expansion. See [TRA-1304].
  crypto_core_live_majors: {
    id: 'crypto_core_live_majors',
    displayName: 'Crypto Core (Live) — DCA on BTC/ETH/SOL majors only',
    description:
      'TRA-1304 live-money DCA preset. Dollar-cost-averaging accumulation (long-only, EMA-200 trend-gated, cadence-paced, hold-to-catastrophe-stop) pinned to the OOS-validated liquid majors BTC-USD / ETH-USD / SOL-USD. This is the ONLY preset LIVE_STRATEGY_PRESET may point at when routing real Coinbase orders — QuantTrader’s sign-off is NO-GO on the full ~395-pair crypto_core universe. Guardrails unchanged: 10% per-symbol notional cap, EMA-200 daily gate, 6×ATR(14) catastrophe stop as the only auto-exit under hold-mode. Both symbolFilter and the dca strategyUniverse pin to the same three majors (defense in depth).',
    enabledStrategies: ['dca'] as const,
    symbolFilter: ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const,
    strategyUniverse: {
      dca: ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const,
    },
  },
};

/**
 * TRA-697 — the resolver default is now `no_trade`. Previously `legacy_5`, but
 * that preset (and the whole OOS-failed legacy roster) was retired. `no_trade`
 * is the safe fallback: a stored/garbage/legacy preset id that no longer
 * resolves degrades to "open no new entries" rather than silently re-enabling
 * a benched, negative-edge roster. On the LIVE engine this is defense-in-depth
 * behind the TRA-532 promotion gate; on demo the engine resolves its own
 * `crypto_core` default and never falls through to this id.
 */
export const DEFAULT_STRATEGY_PRESET_ID: StrategyPresetId = 'no_trade';

/**
 * Resolve a preset id (possibly undefined or invalid from a stored settings
 * snapshot) to its definition. Falls back to `no_trade` (see
 * {@link DEFAULT_STRATEGY_PRESET_ID}) so an unknown id — including the retired
 * legacy ids `legacy_5` / `bb_fade_sol_doge` / `tra405_validated` and TRA-324's
 * legacy env value `'bb_fade_sol_doge_only'` — degrades to the no-entry
 * stand-down instead of resurrecting a retired roster.
 */
export function resolveStrategyPreset(id: string | undefined | null): StrategyPreset {
  if (!id) return STRATEGY_PRESETS[DEFAULT_STRATEGY_PRESET_ID];
  return STRATEGY_PRESETS[id as StrategyPresetId] ?? STRATEGY_PRESETS[DEFAULT_STRATEGY_PRESET_ID];
}

/**
 * TRA-421 — does `preset` permit `strategy` to emit a signal for `symbol`?
 *
 * Combines the two preset-level symbol gates: the preset-wide
 * {@link StrategyPreset.symbolFilter} and the per-strategy
 * {@link StrategyPreset.strategyUniverse} whitelist. Both must pass — a
 * strategy validated only on a subset of symbols (e.g. `bb_fade` on
 * {BTC-USD, SOL-USD} per the TRA-405 §8 OOS findings) appears in
 * `strategyUniverse`; a strategy absent from that map is gated by the
 * preset-wide filter alone. `enabledStrategies` is a separate, prior gate and
 * is intentionally not re-checked here.
 */
export function presetAllowsStrategySymbol(
  preset: StrategyPreset,
  strategy: CryptoStrategyType,
  symbol: string,
): boolean {
  if (preset.symbolFilter !== null && !preset.symbolFilter.includes(symbol)) return false;
  const universe = preset.strategyUniverse?.[strategy];
  if (universe !== undefined && !universe.includes(symbol)) return false;
  return true;
}

// ── Account Modes ─────────────────────────────────────────────────────────────

export type AccountMode = 'demo' | 'live';
export type BrokerageType = 'webull' | 'coinbase' | 'tradier';
export type LiveTradeMode = 'ai_in_brokerage' | 'transfer_to_platform';
/**
 * TRA-249-C / TRA-249-E — how the live crypto account routes strategy signals.
 *   - `'hybrid'`    (default) sends SELL signals to Coinbase INTX perpetuals
 *     when a perp is listed for the spot symbol AND the strategy universe gate
 *     passes; falls back to the spot-only skip otherwise. BUY signals always
 *     route to spot.
 *   - `'spot_only'` forces every SELL through the spot-only skip path even
 *     when perps would otherwise route — the safety hatch for users that
 *     haven't enabled INTX or want to keep live trading directional-long.
 *   - `'perp_only'` (TRA-249-E) routes both legs through the INTX perp
 *     catalog. Surfaced in the Settings UI; the engine treats unknown values
 *     as `'hybrid'` until the routing fork explicitly handles `'perp_only'`.
 */
export type LiveTradeRoutingCrypto = 'hybrid' | 'spot_only' | 'perp_only';
/**
 * Tradier exposes two parallel API hosts (TRA-221). `sandbox` is the paper
 * environment with simulated fills and free real-time options data; `production`
 * is the live brokerage where orders execute against real money. Stored on
 * AccountSettings so users can flip between them without re-entering creds.
 */
export type TradierEnv = 'sandbox' | 'production';

/**
 * TRA-336 — which Tradier Live markets the engine routes signals into.
 *   • `'options'` — only options trades fire (TRA-220 default; preserves the
 *     options-only behaviour that shipped before the equity path was wired).
 *   • `'equity'` — only equity (stock-share) trades fire. Wiring lives in
 *     TRA-335; until that lands, this disables the options mirror without
 *     yet enabling equity orders.
 *   • `'both'` — options + equity trades both fire.
 *
 * The setting only applies when `mode === 'live'` and Tradier credentials are
 * configured. Demo mode and crypto are unaffected.
 */
export type LiveTradierMarkets = 'options' | 'equity' | 'both';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-563 (TRA-410 A1) — Notification / alert preferences.
//
// Per-user alert configuration consumed by the server-side notification
// dispatcher (`packages/server/src/notifications/dispatcher.ts`). The channel
// adapters (email / Telegram / Discord) are built in A2 and the Settings →
// Notifications UI in A3; this schema is the contract all three share.
//
// Every field is OPTIONAL on AccountSettings for back-compat with snapshots
// saved before TRA-563. Always read through {@link resolveAlertPreferences},
// which deep-merges the persisted value over {@link DEFAULT_ALERT_PREFERENCES}
// so a partial save (or a future field) still yields a fully-populated object.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delivery channels an alert can be routed to. SMS is intentionally excluded
 * (TRA-410 §1.6 — it is the only channel that carries a per-message cost).
 */
export type AlertChannel = 'email' | 'telegram' | 'discord';

export const ALERT_CHANNELS: readonly AlertChannel[] = ['email', 'telegram', 'discord'];

/**
 * The event classes the dispatcher fans out (TRA-410 §1.1).
 *
 * TRA-849 — `briefing` is the scheduled once-per-trading-day pre-market morning
 * brief (macro gate + watchlist setups + open positions + overnight news). It is
 * low-frequency and high-value, so it routes to every channel by default (like
 * `risk_halt`) rather than the quietest defaults the high-frequency `signal`
 * class uses.
 */
export type AlertEventClass = 'fill' | 'exit' | 'signal' | 'risk_halt' | 'briefing' | 'routine';

export const ALERT_EVENT_CLASSES: readonly AlertEventClass[] = [
  'fill',
  'exit',
  'signal',
  'risk_halt',
  'briefing',
  // TRA-851 — output of a user-defined natural-language routine (a scheduled
  // brief/scan/status/positions push at a user-chosen time).
  'routine',
];

/** Batching mode for the high-frequency `signal` class (TRA-410 §1.3 "Digest"). */
export type AlertDigestMode = 'immediate' | '15min' | 'hourly';

/** Per-channel enable toggle + connection config. */
export interface AlertChannelConfig {
  /** Master enable for the channel. When false the channel never receives any event. */
  enabled: boolean;
  /**
   * Email destination. When blank the dispatcher falls back to the account's
   * login email (resolved server-side in A2), so a fresh user needs no setup.
   */
  emailAddress?: string;
  /** Telegram chat id captured via the A2 `/start <token>` link flow. Inert until linked. */
  telegramChatId?: string;
  /** Discord incoming-webhook URL (outbound alerts). Inert until set. */
  discordWebhookUrl?: string;
  /**
   * Discord user id captured via the TRA-852 `/link <token>` interaction flow.
   * The reverse of `discordWebhookUrl`: it identifies the inbound Discord user
   * whose slash commands resolve back to this app user. Inert until linked.
   */
  discordUserId?: string;
}

/**
 * Per-event-class × per-channel routing matrix — the "ALERT ME WHEN…" grid in
 * the §1.3 mockup. A channel fires for an event only when BOTH the matrix cell
 * and the channel's own `enabled` toggle are true (and the channel is
 * configured). risk_halt additionally bypasses quiet hours + digest batching.
 */
export type AlertEventMatrix = Record<AlertEventClass, Record<AlertChannel, boolean>>;

/**
 * Quiet-hours window. Suppresses non-critical alerts (fill / exit / signal)
 * while active; risk_halt always bypasses it (the safety-critical alert, §1.3).
 * The window wraps past midnight when `end` is earlier than `start`.
 */
export interface AlertQuietHours {
  enabled: boolean;
  /** "HH:MM" 24h, evaluated in `timezone`. Inclusive start. */
  start: string;
  /** "HH:MM" 24h, evaluated in `timezone`. Exclusive end. */
  end: string;
  /** IANA timezone the window is evaluated in (e.g. "America/New_York"). */
  timezone: string;
}

export interface AlertPreferences {
  channels: Record<AlertChannel, AlertChannelConfig>;
  /** Which channels fire for each event class. */
  events: AlertEventMatrix;
  quietHours: AlertQuietHours;
  /** Batching for `signal` alerts — the only high-frequency class. */
  signalDigest: AlertDigestMode;
}

/**
 * Default alert preferences (TRA-410 §1.3 mockup):
 *   • risk_halt → every channel (safety-critical, on by default).
 *   • fill / exit → email + Discord.
 *   • signal → Discord only (high-frequency; quietest default).
 *   • Email enabled by default (the account already has an address); Telegram
 *     and Discord disabled until the user links / pastes a webhook.
 *   • Quiet hours off; signal digest immediate.
 */
export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  channels: {
    email: { enabled: true },
    telegram: { enabled: false },
    discord: { enabled: false },
  },
  events: {
    fill: { email: true, telegram: false, discord: true },
    exit: { email: true, telegram: false, discord: true },
    signal: { email: false, telegram: false, discord: true },
    risk_halt: { email: true, telegram: true, discord: true },
    // TRA-849 — once-daily pre-market brief; on for every channel so a linked
    // Telegram/Discord receives it without a matrix edit.
    briefing: { email: true, telegram: true, discord: true },
    // TRA-851 — user-defined routine pushes. Default to the chat surfaces the
    // user manages them from (Telegram/Discord); email off so a frequent custom
    // scan doesn't fill the inbox. The user can flip email on per the matrix.
    routine: { email: false, telegram: true, discord: true },
  },
  quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'America/New_York' },
  signalDigest: 'immediate',
};

/**
 * Resolve a fully-populated {@link AlertPreferences} from a (possibly partial,
 * possibly absent) persisted value. Deep-merges the saved prefs over
 * {@link DEFAULT_ALERT_PREFERENCES} so:
 *   • a snapshot saved before TRA-563 (no `alertPreferences`) → defaults;
 *   • a save that only set one channel still gets every other field defaulted;
 *   • a future-added event class / channel is back-filled from the default.
 * Pure + side-effect-free so it is safe to call on every dispatch.
 */
export function resolveAlertPreferences(
  settings?: Pick<AccountSettings, 'alertPreferences'> | null,
): AlertPreferences {
  const saved = settings?.alertPreferences;
  const base = DEFAULT_ALERT_PREFERENCES;
  if (!saved || typeof saved !== 'object') {
    // Return a deep clone so callers can't mutate the shared default.
    return cloneAlertPreferences(base);
  }
  const channels = {} as Record<AlertChannel, AlertChannelConfig>;
  for (const ch of ALERT_CHANNELS) {
    channels[ch] = { ...base.channels[ch], ...(saved.channels?.[ch] ?? {}) };
  }
  const events = {} as AlertEventMatrix;
  for (const ev of ALERT_EVENT_CLASSES) {
    events[ev] = { ...base.events[ev], ...(saved.events?.[ev] ?? {}) };
  }
  return {
    channels,
    events,
    quietHours: { ...base.quietHours, ...(saved.quietHours ?? {}) },
    signalDigest: saved.signalDigest ?? base.signalDigest,
  };
}

function cloneAlertPreferences(prefs: AlertPreferences): AlertPreferences {
  const channels = {} as Record<AlertChannel, AlertChannelConfig>;
  for (const ch of ALERT_CHANNELS) channels[ch] = { ...prefs.channels[ch] };
  const events = {} as AlertEventMatrix;
  for (const ev of ALERT_EVENT_CLASSES) events[ev] = { ...prefs.events[ev] };
  return {
    channels,
    events,
    quietHours: { ...prefs.quietHours },
    signalDigest: prefs.signalDigest,
  };
}

export interface AccountSettings {
  mode: AccountMode;
  // Demo mode settings
  demoEquity: number;
  demoEquityStocks: number;
  demoEquityCrypto: number;
  dailyTradesLimit: number;
  /**
   * Max options trades per day — applies across ATM, OTM, and RV scanners
   * combined (TRA-195). Replaces the previously hardcoded per-source caps so
   * users can tune the unified cap from the Settings page. Stored separately
   * from `dailyTradesLimit` (stocks) so the two markets don't share a slot
   * pool.
   */
  optionsDailyTradesLimit: number;
  /**
   * TRA-327 — live-mode counterparts of `dailyTradesLimit` and
   * `optionsDailyTradesLimit`. Editing the demo cap left the live cap pinned
   * to the same number, so users tuning their paper limits inadvertently
   * widened or tightened live trading too. The live engine now reads these
   * fields when `settings.mode === 'live'`, falling back to the un-suffixed
   * demo fields for back-compat with saved settings written before TRA-327.
   * Both live limits are surfaced in the "Live Trading Risk" block of the
   * Settings page; the demo section continues to bind the un-suffixed
   * fields so the two modes stay independent.
   */
  dailyTradesLimitLive?: number;
  optionsDailyTradesLimitLive?: number;
  /**
   * @deprecated TRA-346 — kept only as a read-time fallback for users who
   * saved before settings were scoped per (mode × market). New writes land on
   * `managedAccountRatio{Demo,Live}{Stocks,Crypto}`; resolve via
   * {@link resolveManagedAccountRatio}.
   */
  managedAccountRatio: number;
  /**
   * @deprecated TRA-346 — see `managedAccountRatio`. Resolve via
   * {@link resolveRiskPerTrade}.
   */
  riskPerTrade: number;
  // TRA-346 — Managed Account Ratio + Risk Per Trade are stored per
  // (account mode × dashboard) so changes in Demo never bleed into Live and
  // changes in Crypto never bleed into Stocks. Optional: undefined ↔ "fall
  // back to the legacy un-suffixed field" so existing saved settings keep
  // working until the user touches each bucket.
  managedAccountRatioDemoStocks?: number;
  managedAccountRatioLiveStocks?: number;
  managedAccountRatioDemoCrypto?: number;
  managedAccountRatioLiveCrypto?: number;
  riskPerTradeDemoStocks?: number;
  riskPerTradeLiveStocks?: number;
  riskPerTradeDemoCrypto?: number;
  riskPerTradeLiveCrypto?: number;
  // Auto-trading persistence — survives server restarts. Split per dashboard
  // (stocks vs crypto) AND per account mode (demo vs live) so a user can stop
  // demo trading while leaving live trading running, or vice versa (TRA-229).
  // Legacy un-suffixed fields remain as a read-time fallback during migration;
  // new writes always land on the per-mode fields below.
  stocksAutoTradingEnabledDemo: boolean;
  stocksAutoTradingEnabledLive: boolean;
  cryptoAutoTradingEnabledDemo: boolean;
  cryptoAutoTradingEnabledLive: boolean;
  /** @deprecated TRA-229 — superseded by stocksAutoTradingEnabled{Demo,Live}. */
  stocksAutoTradingEnabled?: boolean;
  /** @deprecated TRA-229 — superseded by cryptoAutoTradingEnabled{Demo,Live}. */
  cryptoAutoTradingEnabled?: boolean;
  /**
   * TRA-587 — one-shot marker that the server's legacy `cryptoAutoTradingEnabledLive`
   * default migration has already run for this account. Pre-TRA-575 installs persisted
   * `cryptoAutoTradingEnabledLive: true` (the old default), which keeps overriding the
   * new `false` default on load and re-arms the crypto promotion gate on every
   * live-switch. The server flips that stale `true` to `false` ONCE and stamps this
   * marker so a user who later deliberately re-enables live crypto is never re-flipped.
   * Absent on legacy files (triggers the migration); `true` on every new/migrated file.
   */
  cryptoLiveDefaultMigratedTra587?: boolean;
  // Live mode settings — legacy un-suffixed fields. Kept as a read-time
  // fallback so existing saved settings still surface in the UI; new writes
  // land on the per-market fields below so Coinbase (crypto) and Webull
  // (stocks) credentials never bleed across dashboards (TRA-165).
  liveBrokerageType?: BrokerageType;
  liveTradeMode?: LiveTradeMode;
  liveApiKey?: string;
  /**
   * API secret paired with `liveApiKey` (e.g. Coinbase Advanced Trade HMAC secret).
   * Stored per-user; if blank, the server falls back to env vars
   * (COINBASE_API_KEY / COINBASE_API_SECRET) when initialising the live broker.
   */
  liveApiSecret?: string;
  liveAccountId?: string;
  // Live mode settings — Crypto (Coinbase). API Secret holds the HMAC secret
  // or full PEM private key; Coinbase has no concept of an Account ID here.
  liveBrokerageTypeCrypto?: BrokerageType;
  liveTradeModeCrypto?: LiveTradeMode;
  liveApiKeyCrypto?: string;
  liveApiSecretCrypto?: string;
  /**
   * TRA-249-C — routing fork for crypto strategy signals. `'hybrid'` (default)
   * routes SELL shorts to a listed Coinbase perp when the strategy universe
   * gate passes; `'spot_only'` forces the spot-only skip even when a perp
   * exists; `'perp_only'` (TRA-249-E) routes both legs through the INTX perp
   * catalog. Optional so saved settings pre-TRA-249 still type-check; absent
   * ↔ `'hybrid'` per {@link DEFAULT_ACCOUNT_SETTINGS}.
   */
  liveTradeRoutingCrypto?: LiveTradeRoutingCrypto;
  /**
   * TRA-249-E — operator-facing leverage cap for crypto perp positions
   * (1 → 5, integer). Phase-1 the live engine hard-caps leverage at 1×, but
   * surfacing the field now means raising the cap later doesn't require a
   * settings migration. The value the engine actually applies is
   * `min(liveMaxLeverageCrypto, ENGINE_HARD_CAP)`.
   */
  liveMaxLeverageCrypto?: number;
  /**
   * TRA-341 — operator-tunable override for the §6 single-symbol short cap on
   * the LIVE crypto preset, expressed as a fraction of strategy equity (0–1).
   * Default 0.15 (PERP_SHORT_SINGLE_SYMBOL_CAP in @trading-app/engine) per spec; the
   * Live test board ($180 managed) saturates that cap below MIN_NOTIONAL_USD
   * on most pairs and every short signal trips `SKIP_SINGLE_SYMBOL_CAP` before
   * the order ever reaches Coinbase. Raising this knob loosens the per-strategy
   * single-symbol budget without touching the cross-strategy (20%) or total
   * (30%) ceilings, which still enforce whole-book risk.
   *
   * Engine-side resolver (`resolveSingleSymbolShortCap`) clamps the value to
   * (0, 1] and falls back to the spec default for unset / non-finite / ≤ 0
   * inputs, so a fat-finger save can't accidentally disable the gate.
   *
   * Optional for back-compat with snapshots persisted before TRA-341 — absent
   * ↔ spec default.
   */
  liveSingleSymbolShortCap?: number;
  // Live mode settings — Stocks (Webull). Webull uses Account ID for routing
  // and (today) does not require a separate API secret.
  liveBrokerageTypeStocks?: BrokerageType;
  liveTradeModeStocks?: LiveTradeMode;
  liveApiKeyStocks?: string;
  liveAccountIdStocks?: string;
  // Live mode settings — Options (Tradier, TRA-221). Options auto-trading runs
  // through Tradier's REST API (`/markets/options/*` + `/accounts/{id}/orders`).
  // Stored separately from Webull stocks creds so users can opt into options-
  // only auto-trading without configuring an equity broker.
  liveBrokerageTypeOptions?: BrokerageType;
  // Legacy un-suffixed Tradier creds. Kept as a read-time fallback for users
  // who saved before TRA-226 split sandbox/production storage. Treated as
  // sandbox creds on read since `liveTradierEnvOptions` defaulted to sandbox.
  liveApiKeyOptions?: string;
  liveAccountIdOptions?: string;
  // TRA-226 — sandbox vs production credentials are persisted on separate
  // fields so flipping `liveTradierEnvOptions` no longer overwrites the other
  // env's API token / Account ID. The UI shows the pair matching the selected
  // environment; the server resolves credentials by env at use time.
  liveApiKeyOptionsSandbox?: string;
  liveAccountIdOptionsSandbox?: string;
  liveApiKeyOptionsProduction?: string;
  liveAccountIdOptionsProduction?: string;
  /** Sandbox (default) or production. Sandbox uses simulated fills + real chains. */
  liveTradierEnvOptions?: TradierEnv;
  /**
   * TRA-336 — which Tradier markets the engine trades when running live.
   * Defaults to `'options'` to preserve the TRA-220 options-only behaviour
   * for deployments that haven't opted into equity routing. Read via
   * {@link isLiveTradierOptionsEnabled} / {@link isLiveTradierEquityEnabled}
   * so engine + UI stay in sync.
   */
  liveTradierMarkets?: LiveTradierMarkets;
  /**
   * TRA-335 — opt-in toggle that flips Tradier Live equity (stock-share)
   * trading on. When `true` AND `mode === 'live'` AND Tradier credentials
   * are saved, the engine mirrors BB-fade / ORB / Ichimoku entries as
   * Tradier OTOCO bracket orders against the same Tradier account that
   * powers options trading. Default `false` preserves the TRA-220
   * options-only live behaviour for deployments that haven't opted in.
   */
  liveTradeEquitiesTradier?: boolean;
  /**
   * TRA-1305 — opt-in for the LIVE Tradier equity conviction-DCA ADD-order path
   * (50/30/20 tranche scale-ins on the ATR pullback ladder, max 2 adds, earnings
   * blackout; averages SIZE, never the STOP). Independent of
   * {@link liveTradeEquitiesTradier} (which governs live ENTRIES): a user can run
   * live equity entries with add-orders still shadow-logged. Ships `false` — the
   * live add path is INERT until QuantTrader's TRA-1305 pre-flip checklist is
   * GREEN and an operator explicitly arms it. The OPTIONS add path stays
   * shadow-only regardless (TRA-1305 NO-GO); there is no live-options equivalent.
   */
  liveEquityDcaAddsTradier?: boolean;
  /**
   * TRA-361 — when `true`, Tradier-imported option positions (synced via
   * TRA-323 or the TRA-356 periodic reconcile) flow through the same engine
   * SL / TP1-partial / trailing-stop pipeline as engine-opened positions.
   * Imported exits are mirrored to Tradier as `sell_to_close` orders and
   * the paper cash bucket is NOT mutated (proceeds live on the broker).
   * When `false`, imports keep the legacy TRA-323 "user-closed only"
   * behaviour with sentinel SL/TP thresholds. Default `true` so the user's
   * stated bug ("no options are being closed automatically") is fixed by
   * default; users can opt out from the Settings page.
   *
   * Absent ↔ default true.
   */
  autoManageImportedTradierOptions?: boolean;
  /**
   * TRA-325 — active crypto-strategy preset id (see {@link STRATEGY_PRESETS}).
   * The engine reads this on every tick so a switch takes effect on the next
   * evaluation; no restart required. Optional for back-compat with snapshots
   * persisted before TRA-325 — absent ↔ {@link DEFAULT_STRATEGY_PRESET_ID}
   * (`'no_trade'` since TRA-697 retired `legacy_5`), the safe no-entry fallback.
   *
   * Render's `LIVE_STRATEGY_PRESET` env var, when set, acts as a process-wide
   * forced override that wins over this field, so the live $180 test config
   * stays pinned regardless of per-user saves until ops drops the env var.
   */
  activeStrategyPreset?: StrategyPresetId;
  /**
   * TRA-373 — RV scanner expiration window (days-to-expiry) and target.
   * Per-call overrides for the relative-value scanner's `pickExpiration`; the
   * scanner picks the listed expiration whose DTE is closest to
   * `rvDteTarget` within `[rvDteMin, rvDteMax]`. Absent fields fall back to
   * the spec defaults (21 / 60 / 35) — see {@link resolveRvDtePrefs}.
   *
   * Widened from the pre-373 hardcoded 14–35d window because RV signals
   * collapsed to month-end past mid-month and the 14–21 DTE fit is noisier
   * (gamma/jump-dominated). 21–60d gives smoother IV-skew fits and signal
   * frequency that is not phase-locked to the calendar.
   */
  rvDteMin?: number;
  rvDteMax?: number;
  rvDteTarget?: number;
  /**
   * TRA-374 — demo-only execution cost model. Adds a fractional slippage
   * haircut and a per-contract fee to demo option opens and closes so the
   * demo book doesn't systematically overstate P&L vs. live (Tradier pays
   * the real spread end-to-end). Defaults are `0.0` / `0.0` so the model
   * is opt-in until QA flips it on — soft-launch per the issue spec.
   * Live mode never applies these (real broker slippage and fees flow
   * through the Tradier `buy_to_open` / `sell_to_close` paths).
   */
  demoSlippagePct?: number;
  demoFeePerContract?: number;
  /**
   * TRA-389 — feature flag for the market-review gate consumption path.
   * When `true`, the signal engine reads the latest premarket
   * {@link MarketReview} each tick and suppresses / re-sizes equity signals
   * per its {@link MarketReviewGates}. Default `false` — soft-launch behind a
   * setting (same pattern as TRA-374's `demoSlippagePct`): the engine ignores
   * the regime review entirely until QA / the user opts in from the Settings
   * page. Absent ↔ off; resolve via {@link resolveMarketReviewGatesEnabled}.
   */
  marketReviewGatesEnabled?: boolean;
  /**
   * TRA-483 — hold live options opened today overnight so the round trip
   * doesn't count as a day trade (PDT). When `true`, `checkExits` skips
   * TP1 partial / SL / trailing exits for any live position whose
   * `openedAt` date matches the current trading day; auto-exits resume on
   * the next session. Manual closes (user-initiated) are unaffected.
   * Default `true` per the issue's wake comment ("we have to be able to
   * hold trade for a day, so we don't trigger Day Trading pattern").
   * Absent ↔ on. Resolve via {@link resolveHoldLiveOptionsOvernight}.
   */
  holdLiveOptionsOvernightForPdt?: boolean;
  /**
   * TRA-1136 — swing-hold for the user's options book. When `true`, `checkExits`
   * suppresses same-session engine exits (structural thesis-break, hard SL, TP1
   * partial, trailing) for RV positions in BOTH demo and live, holding them to
   * the next trading session so the user can swing-trade and let the trailing
   * stop run instead of getting booked out the same day. The existing live-only
   * TRA-495 gate is a subset of this; flipping it on extends that swing behaviour
   * to the demo book too. Defaults `false` so the demo exit-mechanic test suite
   * and every user who hasn't opted in keep the legacy same-day behaviour.
   * Resolve via {@link resolveSwingHoldOptions}.
   */
  swingHoldOptions?: boolean;
  /**
   * TRA-526 — global kill switch (deterministic risk layer master override).
   * When `true`, the engine engages {@link DailyRiskGovernor}'s kill switch on
   * load and every new-entry path is halted regardless of auto-trading flags or
   * daily counters. Persisted so the halt SURVIVES a server restart — a safety
   * stop that silently lifts on restart is worse than no stop at all. Absent ↔
   * disengaged. The operator toggles it via `/api/trading/kill-switch`.
   */
  globalKillSwitchEngaged?: boolean;
  /** TRA-526 — optional operator note shown as the halt reason while engaged. */
  globalKillSwitchReason?: string;
  /**
   * TRA-544 (TRA-529 P1) — runtime master switch for the advisory multi-agent
   * analyst layer ("Trading Agents"). `false` (default) → the deterministic
   * strategy/router/risk stack drives trading exactly as today. `true` → the
   * multi-agent pipeline becomes the active decision-maker and deterministic
   * auto-routing is SUSPENDED so the two systems never decide at once
   * (TRA-529 §2B). It is a runtime flag flippable live from the banner, NOT a
   * build-time config; persisted under DATA_DIR like every other account
   * setting so the choice survives a restart, and broadcast on the WS `state`
   * so the button always reflects true server state. Even when ON, every agent
   * order still passes through the deterministic RiskManager hard caps and the
   * TRA-526 kill switch overrides everything. Absent ↔ off; resolve via
   * {@link resolveTradingAgentsEnabled}.
   */
  tradingAgentsEnabled?: boolean;
  /**
   * TRA-796 (TRA-529 P4) — gating mode. When `true` AND the agent layer is the
   * active decision-maker ({@link tradingAgentsEnabled}), an APPROVE
   * recommendation's `proposedSignal` is actually routed as an order through the
   * SAME deterministic order path as the strategy scan — so it inherits the
   * RiskManager hard caps, the daily-trades cap, the bracket guard, dedup, halts
   * and the TRA-526 kill switch. `false` (default) keeps the layer advisor-only.
   * Demo-first: gating routes in demo mode regardless of this pair; LIVE routing
   * additionally requires {@link tradingAgentsLiveGatingEnabled}. Absent ↔ off.
   */
  tradingAgentsGatingEnabled?: boolean;
  /**
   * TRA-796 (TRA-529 P4) — the separate, board+CTO-gated live-routing flag.
   * `false` (default) means agent gating NEVER places live orders even when
   * {@link tradingAgentsGatingEnabled} is on — demo routes, live is suppressed
   * with a skip reason. Only flipped on once the go-live gate is cleared. Absent
   * ↔ off.
   */
  tradingAgentsLiveGatingEnabled?: boolean;
  /**
   * TRA-563 (TRA-410 A1) — per-user notification/alert preferences. Optional
   * for back-compat with snapshots saved before TRA-563; absent ↔
   * {@link DEFAULT_ALERT_PREFERENCES}. Always resolve via
   * {@link resolveAlertPreferences} so partial saves are filled from defaults.
   */
  alertPreferences?: AlertPreferences;
  /**
   * TRA-565 (TRA-410 C1) — first-run onboarding state. `onboardingCompletedAt`
   * is the ISO timestamp the user finished (or skipped) the welcome wizard;
   * absent ↔ the wizard has never been completed, which is the first-run
   * signal the desktop app uses to show {@link WizardModal}. `onboardingVersion`
   * records which wizard revision they saw so a future "what's new" pass can
   * re-trigger by bumping {@link CURRENT_ONBOARDING_VERSION} without resetting
   * the completion flag. Both are intentionally absent from
   * {@link DEFAULT_ACCOUNT_SETTINGS} so every user (new or pre-existing) starts
   * unset and is shown the wizard exactly once. Resolve via
   * {@link isOnboardingComplete}.
   */
  onboardingCompletedAt?: string;
  onboardingVersion?: number;
}

/**
 * TRA-565 — current first-run wizard revision. Bump this when the onboarding
 * flow changes materially enough to re-show it to users who already finished an
 * older version (a "what's new" pass). {@link isOnboardingComplete} treats a
 * saved `onboardingVersion` below this number as "not complete".
 */
export const CURRENT_ONBOARDING_VERSION = 1;

/**
 * TRA-565 — true when the user has completed a wizard run at least as recent as
 * {@link CURRENT_ONBOARDING_VERSION}. Used by the desktop app to decide whether
 * to show the first-run wizard. Unset completion, or a completion recorded
 * against an older wizard version, both count as "not complete" → show wizard.
 */
export function isOnboardingComplete(
  s: Pick<AccountSettings, 'onboardingCompletedAt' | 'onboardingVersion'> | null | undefined,
): boolean {
  if (!s || !s.onboardingCompletedAt) return false;
  return (s.onboardingVersion ?? 0) >= CURRENT_ONBOARDING_VERSION;
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  mode: 'demo',
  demoEquity: 25_000,
  demoEquityStocks: 25_000,
  demoEquityCrypto: 25_000,
  dailyTradesLimit: 10,
  optionsDailyTradesLimit: 10,
  dailyTradesLimitLive: 10,
  optionsDailyTradesLimitLive: 10,
  managedAccountRatio: 0.5,
  riskPerTrade: 0.01,
  stocksAutoTradingEnabledDemo: true,
  stocksAutoTradingEnabledLive: true,
  cryptoAutoTradingEnabledDemo: true,
  // TRA-575 — defaults to FALSE. Live crypto auto-trading places real capital on
  // the strategy roster and is the trigger for the TRA-532 promotion gate
  // (`liveCryptoOn` = mode==='live' && cryptoAutoTradingEnabledLive===true). With
  // the old `true` default, ANY account flipping the single global `mode` to live
  // — including a stocks-only Tradier user with zero crypto intent — tripped the
  // crypto promotion gate and got a 422. Defaulting OFF makes live crypto strictly
  // opt-in: a fresh account can go live on stocks, while live crypto stays gated
  // until the user explicitly enables it (which re-arms the gate). Never auto-trade
  // real crypto capital by default.
  cryptoAutoTradingEnabledLive: false,
  // TRA-587 — new accounts are born already-migrated so the legacy crypto-live
  // default migration never touches them; only files written before this field
  // existed (no marker) get the one-shot true→false flip. See the server-side
  // `migrateLegacyCryptoLiveDefault`.
  cryptoLiveDefaultMigratedTra587: true,
  liveBrokerageType: 'webull',
  liveTradeMode: 'ai_in_brokerage',
  liveApiKey: '',
  liveApiSecret: '',
  liveAccountId: '',
  liveBrokerageTypeCrypto: 'coinbase',
  liveTradeModeCrypto: 'ai_in_brokerage',
  liveApiKeyCrypto: '',
  liveApiSecretCrypto: '',
  liveTradeRoutingCrypto: 'hybrid',
  liveMaxLeverageCrypto: 1,
  // TRA-499 — board directive on TRA-494: stock signals should also be
  // Tradier production. The live equity entry path in `signal-engine.ts`
  // already routes through Tradier OTOCO when `liveTradeEquitiesTradier`
  // is on (default `true`, set below); the Webull live-equity SDK was
  // never integrated (see `signal-engine.ts:945-952` and the TRA-225 note
  // in `SettingsPage.tsx`). Flipping this default aligns the recorded
  // brokerage with what actually executes the live orders. Existing
  // saves stay on their persisted value — no auto-migration.
  liveBrokerageTypeStocks: 'tradier',
  liveTradeModeStocks: 'ai_in_brokerage',
  liveApiKeyStocks: '',
  liveAccountIdStocks: '',
  liveBrokerageTypeOptions: 'tradier',
  liveApiKeyOptions: '',
  liveAccountIdOptions: '',
  liveApiKeyOptionsSandbox: '',
  liveAccountIdOptionsSandbox: '',
  liveApiKeyOptionsProduction: '',
  liveAccountIdOptionsProduction: '',
  liveTradierEnvOptions: 'sandbox',
  // TRA-370 — Live (production) now mirrors Demo by default: both equity and
  // options signals fire, and both are routed to Tradier when creds are
  // configured. Users who want to narrow to a single market can still pick
  // 'options' or 'equity' in Settings.
  liveTradierMarkets: 'both',
  liveTradeEquitiesTradier: true,
  liveEquityDcaAddsTradier: false, // TRA-1305 — live equity add-order path OFF by default (shadow-log only)
  autoManageImportedTradierOptions: true,
  activeStrategyPreset: DEFAULT_STRATEGY_PRESET_ID,
  // TRA-373 — RV scanner DTE window. 21–60d (target 35d) replaces the
  // pre-373 14–35d window so signals are not phase-locked to month-end and
  // the IV-skew fit is computed on smoother far-dated chains.
  rvDteMin: 21,
  rvDteMax: 60,
  rvDteTarget: 35,
  // TRA-374 — demo cost model defaults off until QA flips it on.
  demoSlippagePct: 0,
  demoFeePerContract: 0,
  // TRA-389 — market-review gate consumption defaults off (soft-launch).
  marketReviewGatesEnabled: false,
  // TRA-483 — PDT-aware overnight hold defaults ON for live positions.
  holdLiveOptionsOvernightForPdt: true,
  // TRA-1136 — swing-hold the options book defaults OFF; opt-in per user so the
  // demo same-day exit behaviour (and its test suite) is unchanged by default.
  swingHoldOptions: false,
  // TRA-544 — multi-agent layer defaults OFF; deterministic stack drives until
  // the operator opts in from the banner (advisory takeover, still risk-gated).
  tradingAgentsEnabled: false,
  // TRA-796 — gating mode defaults OFF (advisor-only). Demo routing turns on with
  // tradingAgentsGatingEnabled; live routing stays additionally gated on the
  // board+CTO go-live flag below, which defaults OFF.
  tradingAgentsGatingEnabled: false,
  tradingAgentsLiveGatingEnabled: false,
  // TRA-563 — alert preferences default per the §1.3 mockup (risk_halt on every
  // channel; fills/exits on email+discord; signals on discord; quiet hours off).
  alertPreferences: DEFAULT_ALERT_PREFERENCES,
};

/**
 * Resolve the Tradier API token + account id for the env currently selected on
 * AccountSettings (TRA-226). Sandbox and production credentials live on
 * separate fields so flipping the environment does not clobber the other env's
 * token / account number. The legacy un-suffixed fields fall back as sandbox
 * creds — that was the only env stored before TRA-226.
 *
 * Returns trimmed values (or empty strings if nothing is saved). Callers layer
 * env-var fallbacks on top when the saved fields are empty.
 */
export function resolveTradierOptionsCreds(s: AccountSettings): {
  env: TradierEnv;
  apiToken: string;
  accountId: string;
} {
  const env: TradierEnv = s.liveTradierEnvOptions ?? 'sandbox';
  const apiToken = (env === 'production'
    ? (s.liveApiKeyOptionsProduction ?? '')
    : (s.liveApiKeyOptionsSandbox ?? s.liveApiKeyOptions ?? '')
  ).trim();
  const accountId = (env === 'production'
    ? (s.liveAccountIdOptionsProduction ?? '')
    : (s.liveAccountIdOptionsSandbox ?? s.liveAccountIdOptions ?? '')
  ).trim();
  return { env, apiToken, accountId };
}

/**
 * TRA-336 / TRA-370 — resolve which Tradier markets the engine should route
 * into when running live. Defaults to `'both'` (TRA-370) so a Live account
 * mirrors Demo's signal flow — equity and options strategies both fire.
 * Users who want to narrow the routing can still pick `'options'` or
 * `'equity'` explicitly in Settings; absent (legacy snapshots) → both.
 */
export function resolveLiveTradierMarkets(s: AccountSettings): LiveTradierMarkets {
  return s.liveTradierMarkets ?? 'both';
}

/** TRA-336 — true when Tradier Live should route options signals. */
export function isLiveTradierOptionsEnabled(s: AccountSettings): boolean {
  const markets = resolveLiveTradierMarkets(s);
  return markets === 'options' || markets === 'both';
}

/** TRA-336 — true when Tradier Live should route equity (share) signals. */
export function isLiveTradierEquityEnabled(s: AccountSettings): boolean {
  const markets = resolveLiveTradierMarkets(s);
  return markets === 'equity' || markets === 'both';
}

/**
 * TRA-370 — resolve the Tradier Live equity (share) toggle. Absent ↔ true so
 * a Live account opens equity brackets out of the box, matching Demo's signal
 * flow. Users can still opt out by explicitly saving `false` in Settings.
 */
export function resolveLiveTradeEquitiesTradier(s: AccountSettings): boolean {
  return s.liveTradeEquitiesTradier !== false;
}

/**
 * TRA-1305 — resolve the LIVE equity conviction-DCA add-order opt-in. Unlike
 * {@link resolveLiveTradeEquitiesTradier} (absent ↔ true), this is a STRICT
 * opt-in: only an explicit `true` arms the live add path; `undefined`/`false`
 * both keep adds shadow-logged. The live flip additionally requires
 * `mode === 'live'`, a bound equity client, the conviction-watchlist pin, and
 * the per-symbol notional cap — this flag is just the master arm switch, and it
 * is the arming surface for the TRA-1305 pre-flip checklist.
 */
export function resolveLiveEquityDcaAddsTradier(s: AccountSettings): boolean {
  return s.liveEquityDcaAddsTradier === true;
}

/**
 * TRA-361 — resolve whether Tradier-imported option positions should flow
 * through the engine SL/TP1/trailing pipeline. Defaults to `true` so the
 * "imported positions sit unmanaged" bug is fixed by default; users can opt
 * out from the Settings page (auto-management off ↔ legacy TRA-323
 * user-closed-only behaviour with sentinel thresholds).
 */
export function resolveAutoManageImportedTradierOptions(s: AccountSettings): boolean {
  return s.autoManageImportedTradierOptions !== false;
}

export interface DemoCostModel {
  /** Fractional slippage haircut applied to demo option open + close prices (≥ 0). */
  slippagePct: number;
  /** Per-contract fee debited from demo cash on each open and close (≥ 0). */
  feePerContract: number;
}

/**
 * TRA-374 — resolve the demo cost-model knobs. Defaults to 0 / 0 (haircut off)
 * so the soft-launch behaviour is the legacy book-at-mid path until QA / the
 * user opts in via Settings. Negative or non-finite saves are coerced to 0
 * so a fat-finger entry can never credit P&L instead of debiting it.
 */
export function resolveDemoCostModel(s: AccountSettings): DemoCostModel {
  const slippagePct =
    typeof s.demoSlippagePct === 'number' && Number.isFinite(s.demoSlippagePct) && s.demoSlippagePct >= 0
      ? s.demoSlippagePct
      : 0;
  const feePerContract =
    typeof s.demoFeePerContract === 'number'
    && Number.isFinite(s.demoFeePerContract)
    && s.demoFeePerContract >= 0
      ? s.demoFeePerContract
      : 0;
  return { slippagePct, feePerContract };
}

/**
 * TRA-389 — resolve the market-review gate consumption flag. Defaults to
 * `false` so the regime gates stay dormant until QA flips them on (soft-
 * launch, mirroring {@link resolveDemoCostModel}). Only an explicit `true`
 * enables the path — `undefined` (legacy snapshots) and `false` both keep the
 * engine on its pre-TRA-389 behaviour.
 */
export function resolveMarketReviewGatesEnabled(s: AccountSettings): boolean {
  return s.marketReviewGatesEnabled === true;
}

/**
 * TRA-483 — resolve the live-options overnight-hold flag. Defaults to `true`:
 * the issue wake comment makes it the required default so the engine doesn't
 * round-trip a position the same day and burn DTBP. Only an explicit `false`
 * disables the gate; `undefined` (legacy snapshots) keeps the new behaviour.
 */
export function resolveHoldLiveOptionsOvernight(s: AccountSettings): boolean {
  return s.holdLiveOptionsOvernightForPdt !== false;
}

/**
 * TRA-1136 — resolve the swing-hold-options opt-in. Defaults `false`: only an
 * explicit `true` extends the same-session exit suppression to the demo RV book
 * (live RV is already swing-gated by TRA-495). Keeps legacy same-day demo exits
 * for every user who hasn't turned this on.
 */
export function resolveSwingHoldOptions(s: AccountSettings): boolean {
  return s.swingHoldOptions === true;
}

/**
 * TRA-506 — credential fields the `validateLiveCredentials` and
 * `validateProductionTradierKeys` checks may surface as missing. The string
 * literals match the `AccountSettings` field names so the desktop banner can
 * deep-link to the matching Settings input.
 */
export type LiveCredentialField =
  | 'liveApiKeyOptionsProduction'
  | 'liveAccountIdOptionsProduction'
  | 'liveApiKeyOptionsSandbox'
  | 'liveAccountIdOptionsSandbox'
  | 'liveApiKeyCrypto'
  | 'liveApiSecretCrypto';

export interface LiveCredentialsCheck {
  ok: boolean;
  missing: LiveCredentialField[];
}

function isBlankCred(v: string | undefined): boolean {
  return (v ?? '').trim() === '';
}

/**
 * TRA-506 — return the set of required-but-empty live credential fields for
 * the markets enabled on `s`. Shared between the server-side PUT guardrail
 * and the dashboard banner so both surfaces agree on what counts as
 * "missing" for a given Settings snapshot.
 *
 * Gating per the issue spec:
 *   - Tradier pair (per `liveTradierEnvOptions`) is required when
 *     `liveTradeEquitiesTradier && liveBrokerageTypeStocks === 'tradier'`
 *     (stocks) OR `liveTradierMarkets in ('options','both')` (options).
 *   - Coinbase pair is required when `liveBrokerageTypeCrypto === 'coinbase'`.
 *
 * Defaults match `DEFAULT_ACCOUNT_SETTINGS` so a fresh user with no overrides
 * still triggers the check: stocks (Tradier), options (both), crypto
 * (Coinbase) are all on out of the box.
 */
export function findMissingLiveCredentials(s: AccountSettings): LiveCredentialField[] {
  const missing = new Set<LiveCredentialField>();
  const env: TradierEnv = s.liveTradierEnvOptions ?? 'sandbox';
  const stocksOnTradier =
    resolveLiveTradeEquitiesTradier(s) && (s.liveBrokerageTypeStocks ?? 'tradier') === 'tradier';
  const optionsOnTradier = isLiveTradierOptionsEnabled(s);
  if (stocksOnTradier || optionsOnTradier) {
    if (env === 'production') {
      if (isBlankCred(s.liveApiKeyOptionsProduction)) missing.add('liveApiKeyOptionsProduction');
      if (isBlankCred(s.liveAccountIdOptionsProduction)) missing.add('liveAccountIdOptionsProduction');
    } else {
      const sandboxKey = s.liveApiKeyOptionsSandbox ?? s.liveApiKeyOptions ?? '';
      const sandboxAcct = s.liveAccountIdOptionsSandbox ?? s.liveAccountIdOptions ?? '';
      if (isBlankCred(sandboxKey)) missing.add('liveApiKeyOptionsSandbox');
      if (isBlankCred(sandboxAcct)) missing.add('liveAccountIdOptionsSandbox');
    }
  }
  if ((s.liveBrokerageTypeCrypto ?? 'coinbase') === 'coinbase') {
    if (isBlankCred(s.liveApiKeyCrypto)) missing.add('liveApiKeyCrypto');
    if (isBlankCred(s.liveApiSecretCrypto)) missing.add('liveApiSecretCrypto');
  }
  return Array.from(missing);
}

/**
 * TRA-506 — guardrail for the PUT /api/account/settings route. Returns
 * `{ ok: false, missing }` only when `mode === 'live'` AND at least one
 * required cred is blank. Demo mode short-circuits to `ok: true` so a user
 * tweaking demo settings doesn't get blocked by missing live creds — the
 * issue is "user silently runs live with no creds," not "user is forbidden
 * from saving anything until they configure every broker."
 */
export function validateLiveCredentials(s: AccountSettings): LiveCredentialsCheck {
  if (s.mode !== 'live') return { ok: true, missing: [] };
  const missing = findMissingLiveCredentials(s);
  return { ok: missing.length === 0, missing };
}

/**
 * TRA-506 — paired guardrail that fires independent of `mode`: saving
 * `liveTradierEnvOptions = 'production'` with either production key blank is
 * always rejected. This prevents the "half-configured production" state
 * where a user flips the env to production in demo, leaves the keys empty,
 * then later flips to live and discovers there's nothing actually wired up.
 */
export function validateProductionTradierKeys(s: AccountSettings): LiveCredentialsCheck {
  if ((s.liveTradierEnvOptions ?? 'sandbox') !== 'production') return { ok: true, missing: [] };
  const missing: LiveCredentialField[] = [];
  if (isBlankCred(s.liveApiKeyOptionsProduction)) missing.push('liveApiKeyOptionsProduction');
  if (isBlankCred(s.liveAccountIdOptionsProduction)) missing.push('liveAccountIdOptionsProduction');
  return { ok: missing.length === 0, missing };
}

/** TRA-373 — spec defaults for the RV scanner DTE window. */
export const DEFAULT_RV_DTE_MIN = 21;
export const DEFAULT_RV_DTE_MAX = 60;
export const DEFAULT_RV_DTE_TARGET = 35;

export interface RvDtePrefs {
  min: number;
  max: number;
  target: number;
}

/**
 * TRA-373 — resolve the RV scanner DTE window with the spec defaults
 * (21 / 60 / 35). Coerces non-finite, non-positive, or inverted ranges back to
 * the defaults so a fat-finger save can't silently disable the scanner; the
 * target is clamped into the resolved [min, max] range. Read this on every
 * scan tick so a saved edit takes effect on the next scan without restarting.
 */
export function resolveRvDtePrefs(s: AccountSettings): RvDtePrefs {
  const rawMin = s.rvDteMin;
  const rawMax = s.rvDteMax;
  const rawTarget = s.rvDteTarget;
  let min = Number.isFinite(rawMin) && (rawMin as number) > 0 ? (rawMin as number) : DEFAULT_RV_DTE_MIN;
  let max = Number.isFinite(rawMax) && (rawMax as number) > 0 ? (rawMax as number) : DEFAULT_RV_DTE_MAX;
  if (max < min) {
    min = DEFAULT_RV_DTE_MIN;
    max = DEFAULT_RV_DTE_MAX;
  }
  let target = Number.isFinite(rawTarget) && (rawTarget as number) > 0 ? (rawTarget as number) : DEFAULT_RV_DTE_TARGET;
  if (target < min) target = min;
  if (target > max) target = max;
  return { min, max, target };
}

/**
 * TRA-346 — pick the Managed Account Ratio scoped to the dashboard the caller
 * cares about (Crypto vs Stocks) and the user's current account mode (Demo vs
 * Live). Falls back to the legacy un-suffixed `managedAccountRatio` when the
 * scoped field is undefined so existing saved settings keep sizing positions
 * the same way until the user touches each bucket.
 *
 * Use everywhere the engine sizes positions or surfaces the value to the UI;
 * never read `s.managedAccountRatio` directly.
 */
export function resolveManagedAccountRatio(
  s: AccountSettings,
  market: 'crypto' | 'stocks',
  mode: AccountMode,
): number {
  const scoped = market === 'crypto'
    ? (mode === 'live' ? s.managedAccountRatioLiveCrypto : s.managedAccountRatioDemoCrypto)
    : (mode === 'live' ? s.managedAccountRatioLiveStocks : s.managedAccountRatioDemoStocks);
  return scoped ?? s.managedAccountRatio;
}

/**
 * TRA-346 — paired resolver for Risk Per Trade. See
 * {@link resolveManagedAccountRatio} for the scoping rationale.
 */
export function resolveRiskPerTrade(
  s: AccountSettings,
  market: 'crypto' | 'stocks',
  mode: AccountMode,
): number {
  const scoped = market === 'crypto'
    ? (mode === 'live' ? s.riskPerTradeLiveCrypto : s.riskPerTradeDemoCrypto)
    : (mode === 'live' ? s.riskPerTradeLiveStocks : s.riskPerTradeDemoStocks);
  const resolved = scoped ?? s.riskPerTrade;
  // TRA-526 — deterministic hard cap. Whatever the operator (or a strategy/LLM
  // proposal that lands in this knob) asks for, the math caps it at
  // HARD_MAX_RISK_PER_TRADE of managed equity. A non-finite / non-positive value
  // (corrupt save) falls back to the default rather than disabling sizing.
  if (!Number.isFinite(resolved) || resolved <= 0) return DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;
  return Math.min(resolved, HARD_MAX_RISK_PER_TRADE);
}

/**
 * TRA-346 — return the AccountSettings field name that stores Managed Account
 * Ratio for the given (market, mode). Used by the Settings UI to write to the
 * scoped field directly so saving on the Crypto dashboard never overwrites the
 * Stocks bucket.
 */
export function managedAccountRatioField(
  market: 'crypto' | 'stocks',
  mode: AccountMode,
):
  | 'managedAccountRatioDemoStocks'
  | 'managedAccountRatioLiveStocks'
  | 'managedAccountRatioDemoCrypto'
  | 'managedAccountRatioLiveCrypto' {
  if (market === 'crypto') {
    return mode === 'live' ? 'managedAccountRatioLiveCrypto' : 'managedAccountRatioDemoCrypto';
  }
  return mode === 'live' ? 'managedAccountRatioLiveStocks' : 'managedAccountRatioDemoStocks';
}

/**
 * TRA-346 — paired field-name resolver for Risk Per Trade.
 */
export function riskPerTradeField(
  market: 'crypto' | 'stocks',
  mode: AccountMode,
):
  | 'riskPerTradeDemoStocks'
  | 'riskPerTradeLiveStocks'
  | 'riskPerTradeDemoCrypto'
  | 'riskPerTradeLiveCrypto' {
  if (market === 'crypto') {
    return mode === 'live' ? 'riskPerTradeLiveCrypto' : 'riskPerTradeDemoCrypto';
  }
  return mode === 'live' ? 'riskPerTradeLiveStocks' : 'riskPerTradeDemoStocks';
}

export const WATCHLIST_SIZE = 25;
export const OPTIONS_BUDGET_RATIO = 0.05;   // 5% of managed equity per options trade
export const OPTIONS_TP1_PCT = 0.25;         // take partial profit (50%) at +25% premium gain
export const OPTIONS_TP2_PCT = 0.50;         // final TP target at +50% gain on remaining half
export const OPTIONS_SL_PCT = 0.25;          // stop loss at 25% loss (improved R:R vs previous 35%)
export const OPTIONS_ATM_PREMIUM_RATIO = 0.02; // estimated ATM premium ≈ 2% of underlying
export const OPTIONS_DAILY_LIMIT = 4;        // max 4 high-quality trades per day (was 10)
export const OPTIONS_TRAIL_ACTIVATE_PCT = 0.20; // activate trailing stop once position is up 20%
export const OPTIONS_TRAIL_OFFSET_PCT = 0.12; // trail 12% below peak (tighter than previous 15%)
export const OPTIONS_PARTIAL_EXIT_RATIO = 0.5; // exit 50% of contracts at TP1; trail the rest

// ── Small-account options sizing guards (TRA-378 / TRA-495) ─────────────────
//
// The board runs live options on a small DCA account ($550 → ~$6k). The
// per-strategy budget ratios above (5% / 2.5% / 3%) make a sub-$2k account
// effectively non-tradeable — `floor(budget / costPerContract)` rounds to 0
// and the engine silently skips ~half its RV signals. These knobs (plus the
// riskPerTrade wiring in `options-account.ts`) make small books tradeable
// without letting one ticket dominate the book.
//
//   • OPTIONS_POSITION_CAP_RATIO — hard cap on a single options position's
//     notional cost as a fraction of equity. Applied as `min(budget, cap)`
//     before `floor()`, and also gates the forced 1-contract floor so a
//     single rich contract can never blow past it. Scales with the account.
//   • OPTIONS_PER_TICKET_DOLLAR_FLOOR (TRA-495 / TRA-497) — minimum per-ticket
//     budget in dollars. Bumps the pct-budget up to $150 when the percent math
//     rounds to less than $150 (e.g. $550 * 0.5 * 0.10 = $27.50), so a
//     $0.40-mark RV candidate can size to ≥1 contract on a $550 live book.
//     Also raises the per-position cap floor (`max($150, 15% × equity)`)
//     so the same $150 ticket budget can clear the cap on a sub-$1k book.
//     Board raised this from $100 to $150 on TRA-497 (2026-05-28) — a $1.50
//     contract should now clear the cap on the $550 book, not just $0.95.
//   • OPTIONS_PER_POSITION_PCT_CAP — alias for OPTIONS_POSITION_CAP_RATIO
//     spelled out for callers that prefer the "PCT_CAP" form.
//   • OPTIONS_OTM_MIN_EQUITY — live-equity floor below which the OTM
//     mispricing scanner is skipped (RV-only). OTM is a tail strategy
//     (~40% win rate) that needs many tickets for the right tail to pay
//     off — wrong for a small book.
export const OPTIONS_POSITION_CAP_RATIO = 0.15; // cap a single options position at 15% of equity
export const OPTIONS_PER_POSITION_PCT_CAP = OPTIONS_POSITION_CAP_RATIO;
export const OPTIONS_PER_TICKET_DOLLAR_FLOOR = 150; // $150 per-ticket floor while equity is small (TRA-497)
export const OPTIONS_OTM_MIN_EQUITY = 5_000;    // skip the OTM scanner below this live equity

/**
 * TRA-499 — per-position notional cap shared by the options and equity sizing
 * paths. Hoisted out of `options-account.ts` so the live-equity sizing path
 * (`signal-engine.ts > sizeLiveEquityFromStop`) can reuse the same floor as
 * the options ticket-budget cap without re-deriving it. The dollar floor
 * mirrors the options ticket floor: when 15% of equity falls below the floor
 * on a small live book the cap stays anchored at the floor so a single ticket
 * that fits the floor's budget can still clear the cap.
 */
export function perPositionCap(equity: number): number {
  return Math.max(OPTIONS_PER_TICKET_DOLLAR_FLOOR, equity * OPTIONS_POSITION_CAP_RATIO);
}

// ── OTM long-premium risk overrides (TRA-160) ───────────────────────────────
//
// Far-OTM long premium has a fundamentally different payoff distribution from
// the ATM directional plays the OPTIONS_* constants above are tuned for:
//
//   • most contracts expire worthless → faster theta decay, especially short-DTE
//   • winners are right-tail-heavy (2x–5x is common, 10x is not unheard of)
//   • gamma is higher per dollar of premium → bigger %-moves on same spot move
//
// The risk profile we want is therefore "small budget per ticket, cut losers
// fast, let winners run further". The values below were chosen by sweeping
// SL ∈ {0.18, 0.20, 0.25}, TP1 ∈ {0.40, 0.50, 0.60}, budget ∈ {0.02, 0.025,
// 0.03} on the Geometric-Brownian-Motion premium-path simulator in
// `@trading-app/backtest` (`run-otm-sweep.ts`) and picking the combo with the
// best aggregate P&L ÷ max-drawdown across the trending and choppy regimes.
//
// Daily limit is split out so OTM tickets don't crowd out ATM directional
// signals when both fire on the same day — the engine compares the daily
// count for each kind against its own cap.
export const OTM_OPTIONS_BUDGET_RATIO = 0.025;       // 2.5% of managed equity per OTM ticket
export const OTM_OPTIONS_SL_PCT = 0.20;              // tighter SL — OTM theta bites quickly
export const OTM_OPTIONS_TP1_PCT = 0.50;             // wider TP1 — capture the asymmetric upside
export const OTM_OPTIONS_TP2_PCT = 1.00;             // wider TP2 (informational; trailing handles tail)
export const OTM_OPTIONS_TRAIL_ACTIVATE_PCT = 0.30;  // wait for +30% before engaging trailing
export const OTM_OPTIONS_TRAIL_OFFSET_PCT = 0.20;    // wider trail — OTM marks are noisier
export const OTM_OPTIONS_PARTIAL_EXIT_RATIO = 0.4;   // exit only 40% at TP1; trail more for the right tail
export const OTM_OPTIONS_DAILY_LIMIT = 2;            // separate cap so OTM ≠ competing for ATM slots

/** Risk-parameter bundle handed to the options account for OTM tickets. */
export interface OtmRiskParams {
  budgetRatio: number;
  slPct: number;
  tp1Pct: number;
  trailActivatePct: number;
  trailOffsetPct: number;
  partialExitRatio: number;
  dailyLimit: number;
}

export const OTM_RISK_PARAMS: OtmRiskParams = {
  budgetRatio: OTM_OPTIONS_BUDGET_RATIO,
  slPct: OTM_OPTIONS_SL_PCT,
  tp1Pct: OTM_OPTIONS_TP1_PCT,
  trailActivatePct: OTM_OPTIONS_TRAIL_ACTIVATE_PCT,
  trailOffsetPct: OTM_OPTIONS_TRAIL_OFFSET_PCT,
  partialExitRatio: OTM_OPTIONS_PARTIAL_EXIT_RATIO,
  dailyLimit: OTM_OPTIONS_DAILY_LIMIT,
};

// ── Relative-value scanner risk overrides (TRA-191) ─────────────────────────
//
// Long-only RV entries: pay a cheap mid premium against the fitted skew, exit
// when the residual collapses (target) or runs further away (stop). Cheap-vs-
// curve trades have a different distribution from far-OTM lottery tickets:
//   • most candidates land at moderate moneyness, not deep-OTM tails
//   • theo edge ≈ |(mark − fair)| dollars per share is the expected payoff
//   • winners tend to be 30–80% gains, not 10x lottery wins
//
// We size smaller than ATM directional plays (richer alpha density per ticket)
// and run a tighter stop than OTM far-tail tickets. Daily limit is split out
// so RV doesn't compete with ATM directional or OTM tail slots.
export const RV_OPTIONS_BUDGET_RATIO = 0.02;        // 2% of managed equity per RV ticket — reconciled with the recommended 2% live risk-per-trade (TRA-461)
export const RV_OPTIONS_SL_PCT = 0.25;              // tighter than OTM, looser than ATM
export const RV_OPTIONS_TP1_PCT = 0.40;             // partial-take when residual half-collapses
export const RV_OPTIONS_TRAIL_ACTIVATE_PCT = 0.25;  // engage trailing at +25%
export const RV_OPTIONS_TRAIL_OFFSET_PCT = 0.15;
export const RV_OPTIONS_PARTIAL_EXIT_RATIO = 0.5;
export const RV_OPTIONS_DAILY_LIMIT = 4;

// ── RV selection / sub-tick guards (TRA-461 recalibration) ──────────────────
//
// `tra461-rv-recalibration.md` confirmed every penny-option ($0.05–$0.10) RV
// ticket is mathematically unable to win: at that premium one $0.01 tick is a
// ~20% move and a 25% percentage stop is sub-tick, so positions are booked out
// by quote microstructure, not by an adverse thesis. The sweep showed
// expectancy/ticket only crosses solidly positive at a $0.40 mark.
//
//   • RV_MIN_MARK_FLOOR — the scanner's `minMark` selection floor. Also gates
//     auto-management of imported (Tradier) positions: a contract below the
//     floor cannot be risk-managed (its stop would be sub-tick) so it is left
//     for the user instead.
//   • RV_OPTIONS_SL_DOLLAR_FLOOR — minimum stop *distance* in dollars. The RV
//     stop distance is `max(premium·slPct, slDollarFloor)` so a stop is never
//     sub-tick. At `minMark 0.40` it is essentially non-binding (0.40·0.25 =
//     0.10) — pure insurance for imports / edge cases below the floor.
export const RV_MIN_MARK_FLOOR = 0.40;
export const RV_OPTIONS_SL_DOLLAR_FLOOR = 0.10;

export interface RvRiskParams {
  budgetRatio: number;
  slPct: number;
  /**
   * Minimum stop *distance* in dollars of premium (TRA-461). The RV stop is
   * placed at `premium − max(premium·slPct, slDollarFloor)` so a percentage
   * stop can never collapse to sub-tick on a low-premium contract.
   */
  slDollarFloor: number;
  tp1Pct: number;
  trailActivatePct: number;
  trailOffsetPct: number;
  partialExitRatio: number;
  dailyLimit: number;
}

export const RV_RISK_PARAMS: RvRiskParams = {
  budgetRatio: RV_OPTIONS_BUDGET_RATIO,
  slPct: RV_OPTIONS_SL_PCT,
  slDollarFloor: RV_OPTIONS_SL_DOLLAR_FLOOR,
  tp1Pct: RV_OPTIONS_TP1_PCT,
  trailActivatePct: RV_OPTIONS_TRAIL_ACTIVATE_PCT,
  trailOffsetPct: RV_OPTIONS_TRAIL_OFFSET_PCT,
  partialExitRatio: RV_OPTIONS_PARTIAL_EXIT_RATIO,
  dailyLimit: RV_OPTIONS_DAILY_LIMIT,
};

// Market regime thresholds (ADX-based)
export const ADX_TRENDING_THRESHOLD = 25;   // ADX > 25 → trending → favor ORB/MACD/Ichimoku
export const ADX_RANGING_THRESHOLD = 20;    // ADX < 20 → ranging → favor reversal; avoid ORB

// Daily risk circuit-breakers
export const MAX_CONSECUTIVE_LOSSES = 3;     // halt new entries after 3 consecutive losses
export const DAILY_DRAWDOWN_HALT_PCT = 0.08; // halt if daily P&L < −8% of managed equity

/**
 * TRA-1250 — exit-side loss-control rule parameters (board-approved via
 * TRA-1249 analysis, request_confirmation `d7175f7e`, 2026-07-02).
 *
 * Phase-1 is EXIT-side only: an ATR chandelier trail + a per-trade profit-lock
 * (give-back cap) + a book-level daily give-back cap. These are the numeric
 * thresholds; the pure decision logic lives in `@trading-app/engine`
 * (`exit-rules.ts`) and is wired into the exit/entry paths behind a flag so it
 * can ship dark and be tuned/reverted. Backtest justification (41 large-caps,
 * ~2020–2026): rules 1+2 cut give-back trades 15.9% → 4.6%; rule 3 floors the
 * "+$1,599 → +$483" tail near +$960.
 */
// Rule 1 — ATR chandelier trailing stop
export const EXIT_CHANDELIER_ATR_MULT = 3.0;          // default trail width = 3.0 × ATR14 from the running extreme
export const EXIT_CHANDELIER_ATR_MULT_HIGHBETA = 3.5; // widen for high-beta names to avoid noise stop-outs
export const EXIT_CHANDELIER_HIGHBETA_ATRPCT = 0.05;  // ATR/price above ~5% ⇒ treat as high-beta
// Rule 2 — trade-level profit-lock (give-back cap per position)
export const PROFIT_LOCK_ARM_R = 1.0;                 // arm once peak favorable excursion ≥ 1.0R
export const PROFIT_LOCK_GIVEBACK_R = 1.0;            // exit if open R retraces 1.0R from peak
export const PROFIT_LOCK_TIGHTEN_PEAK_R = 2.0;        // once peakR ≥ 2.0R …
export const PROFIT_LOCK_TIGHTEN_GIVEBACK_R = 0.5;    // … tighten the give-back to 0.5R (lock more of a big winner)
// Rule 3 — book-level daily give-back cap (the board's headline ask)
export const BOOK_GIVEBACK_CAP_PCT = 0.40;            // flatten + halt after surrendering >40% of the day's peak open gain
export const BOOK_SESSION_STOP_R = 0.5;               // hard session stop if net-negative after being up > +0.5R of book equity

// TRA-1294 — take-profit-early: the symmetric PROFIT-side mirror of the give-back
// cap. Bank the win once a position has captured this fraction of its available
// profit (long) / max credit (short). Board range 50–70%; default to the
// midpoint. Ships DARK behind TAKE_PROFIT_EARLY_ENABLED (itself under the
// EXIT_RISK_RULES_ENABLED master switch).
export const TAKE_PROFIT_EARLY_CAPTURE_PCT = 0.60;    // auto-close at 60% of available profit / max credit

// Rule 5 (TRA-1295) — the "7%" leg of the board's 3-5-7 governor: a correlated-
// exposure cap. The sum of OPEN per-trade dollar risk within any one correlated
// group (the candidate's underlying, its sector, and its asset-class — evaluated
// at all three grains, most-binding wins) may not exceed this fraction of managed
// book equity. Complements the per-trade breaker (loss-streak / drawdown, the
// "3") and the book give-back cap (Rule 3, the "5"). A new entry that would push
// a group over the cap is SCALED DOWN to the exact headroom, or rejected below
// the min-trade-risk floor. Ships DARK behind CORRELATED_EXPOSURE_CAP_ENABLED.
export const CORRELATED_EXPOSURE_CAP_PCT = 0.07;      // max Σ open risk in one correlated group = 7% of managed equity
export const CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT = 0.0025; // reject rather than scale a candidate below 0.25% of equity

// TRA-1293 — PoP / delta entry gate + Delta/Theta ratio floor. Operationalizes
// the board's Greeks guidance on the option entry side: (a) a HARD short-strike
// |delta| band so we only sell/buy strikes with a sane probability-of-profit
// (0.30–0.40 |Δ| ≈ ~60–70% PoP on the short side), and (b) a |delta|/|theta|
// ratio floor so a name only enters when its directional sensitivity is large
// enough relative to its daily time-decay — i.e. so decay "works for us" instead
// of bleeding a low-delta position. Theta is expressed in per-DAY premium terms
// (BS per-year theta ÷ 365) so the floor reads intuitively as "units of |delta|
// per dollar/day of decay". Ships DARK behind ENTRY_GREEKS_GATE_ENABLED (itself
// under the EXIT_RISK_RULES_ENABLED master switch); the exact ratio floor is a
// QuantTrader/board tuning input pending a forward-sample, so the default below
// is a conservative starting value, not a ratified threshold.
export const ENTRY_SHORT_DELTA_MIN = 0.30;            // hard lower bound of the admissible short-strike |delta| band
export const ENTRY_SHORT_DELTA_MAX = 0.40;            // hard upper bound of the admissible short-strike |delta| band
export const ENTRY_DELTA_THETA_RATIO_FLOOR = 6.0;     // min |delta| / |theta_per_day|; provisional, tune before enabling

// TRA-1269 (TRA-1250 Rule 1, live-equity path) — the live equity chandelier
// trails a *broker-resting* OCO stop leg by cancel/replace, which costs a
// Tradier order-modify round-trip and risks throttling. So we only spend a
// modify when the ratcheted stop has tightened by a meaningful amount, and we
// rate-limit modifies per position. These knobs gate that (never loosen — the
// tighten-only direction is enforced in `stopModifyDecision`, not here).
export const LIVE_EQUITY_STOP_MODIFY_MIN_TICK_PCT = 0.0015; // min favorable stop move to justify a modify = 0.15% of price
export const LIVE_EQUITY_STOP_MODIFY_MIN_TICK_ABS = 0.02;   // …but never smaller than 2¢ (sub-penny moves aren't worth a round-trip)
export const LIVE_EQUITY_STOP_MODIFY_COOLDOWN_MS = 60_000;  // ≥60s between modifies on the same position (Tradier throttle guard)

// TRA-1300 (parent TRA-1290, board confirmation `38a50f39`) — the observe-only
// scale-out (take-profit) ladder. The board REJECTED the finfluencer add-down /
// averaging-down ladder (TRA-1291 verdict: NO-GO — it blows the account up) and
// GREENLIT only this scale-out side: trim an EXISTING position on moves ABOVE the
// average entry. There is deliberately NO add-down rung here. Sell % is of the
// ORIGINAL (base) position size — the same reference the TRA-1291 fee-aware harness
// fixed. The downside is NOT governed here at all: it hands off to the shipped
// chandelier trail + give-back cap (TRA-1267/1268). Ships DARK behind the
// standalone observe-only flag `ENABLE_SCALEOUT_LADDER` (a scanner-style flag, not
// under the EXIT_RISK_RULES master — it places no orders, so it is not an exit-risk
// mutation). `remainder` sells whatever base fraction is left (full exit).
export interface ScaleOutLadderRung {
  /** Favorable move from average entry that arms this rung (0.25 = +25%). */
  up: number;
  /** Base-size fraction to trim, or `'remainder'` to exit the rest. */
  sellPctBase: number | 'remainder';
}
export const SCALE_OUT_LADDER_RUNGS: readonly ScaleOutLadderRung[] = [
  { up: 0.25, sellPctBase: 0.10 }, // +25% → sell 10% of base
  { up: 0.35, sellPctBase: 0.20 }, // +35% → sell 20% of base
  { up: 0.45, sellPctBase: 0.30 }, // +45% → sell 30% of base
  { up: 0.60, sellPctBase: 0.40 }, // +60% → sell 40% of base
  { up: 1.00, sellPctBase: 'remainder' }, // +100% → exit remainder
];
// Per-side TAKER fee rates (the live engine submits market orders), matching the
// TRA-1291 harness cost model so the observe-only net proceeds are apples-to-apples.
export const SCALE_OUT_TAKER_FEE_EQUITY = (2 + 3) / 10_000; // 5 bps
export const SCALE_OUT_TAKER_FEE_CRYPTO = (60 + 3) / 10_000; // 63 bps

/**
 * TRA-526 — deterministic per-trade risk ceiling ("the math disposes" layer).
 *
 * The per-(mode×market) `riskPerTrade` knobs are operator-tunable and the route
 * clamp (`index.ts`, `account-settings.ts`) admits anything in `[0.001, 0.5]`,
 * i.e. up to 50% of managed equity risked on a single ticket. That is fine as a
 * *soft* preference but is not a hard cap: a fat-fingered save (or an over-eager
 * strategy/LLM proposal that flows into the sizing knob) could risk half the book
 * on one trade. This constant is the deterministic upper bound that
 * {@link resolveRiskPerTrade} enforces *after* the operator value is resolved, so
 * no configured value can ever size a trade above {@link HARD_MAX_RISK_PER_TRADE}
 * of managed equity. The issue spec calls for a 1–2% hard cap; 2% is the ceiling,
 * the default (`DEFAULT_ACCOUNT_SETTINGS.riskPerTrade = 0.01`) sits at 1%.
 *
 * This is intentionally a compile-time constant, not a setting: the whole point
 * of the deterministic risk layer is that it cannot be widened from the UI.
 */
export const HARD_MAX_RISK_PER_TRADE = 0.02; // never risk more than 2% of managed equity on one trade

/**
 * TRA-510 — smart-watchlist micro-cap price floor (USD). Newcomers fed in by
 * the TRA-368 generator are dropped when their last-known quote is below this
 * floor; symbols already on the base {@link WATCHLIST} are exempt. Drives the
 * filter applied between {@link scoreSymbols} and the MAX_NEW_SYMBOLS cap in
 * `premarket-watchlist.ts::generateSmartWatchlist`.
 *
 * Why: the TRA-508 post-mortem traced 5 of 5 demo stop-outs on 2026-05-28 to
 * `eod_mover` sub-$5 names (e.g. QTEX at $2.7472 with a 24% stop distance) —
 * micro-caps trade on a price scale where the engine's R-multiple stops are
 * structurally wider than the strategy can absorb. The floor gates the
 * micro-cap subset out of the watchlist without changing the `eod_mover`
 * weight (a $60 NVDA on a +15% gap is still a high-value follow-through).
 */
export const WATCHLIST_MIN_PRICE = 5.00;

// Valid ET trading windows stored as [startMinuteOfDay, endMinuteOfDay]
export const TRADING_WINDOWS: readonly [number, number][] = [
  [9 * 60 + 35,  11 * 60 + 30],  // 9:35–11:30 AM ET (morning session)
  [13 * 60 + 30, 15 * 60 + 30],  // 1:30–3:30 PM ET (afternoon session)
] as const;

/**
 * Returns the US Eastern Time UTC offset in hours for a given UTC timestamp.
 * EDT (UTC-4) from second Sunday in March through first Sunday in November;
 * EST (UTC-5) the rest of the year.
 */
export function getEasternUtcOffset(utcMs: number): -4 | -5 {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();

  // Second Sunday in March (DST starts at 2 AM local, approximated as UTC midnight)
  const march1Day = new Date(Date.UTC(year, 2, 1)).getUTCDay(); // 0=Sun
  const dstStart = new Date(Date.UTC(year, 2, 1 + ((7 - march1Day) % 7) + 7));

  // First Sunday in November (DST ends)
  const nov1Day = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - nov1Day) % 7)));

  return utcMs >= dstStart.getTime() && utcMs < dstEnd.getTime() ? -4 : -5;
}

/** Returns true when the UTC timestamp falls inside a valid ET trading window. */
export function isValidTradingWindow(utcMs: number): boolean {
  const offsetHours = getEasternUtcOffset(utcMs);
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  const etMinutes = Math.floor(etMs / 60_000) % (24 * 60);
  return TRADING_WINDOWS.some(([start, end]) => etMinutes >= start && etMinutes <= end);
}

/**
 * Returns true when US stock markets are currently open (weekdays 9:30 AM–4:00 PM ET,
 * excluding weekends). Does not account for market holidays.
 */
export function isStockMarketOpen(utcMs: number = Date.now()): boolean {
  const offsetHours = getEasternUtcOffset(utcMs);
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  const etDate = new Date(etMs);
  const dayOfWeek = etDate.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const etMinutes = etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
  return etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60;
}

/**
 * Minutes remaining until the 4:00 PM ET regular-session close. Returns 0 on
 * weekends, before 9:30 AM ET, and at/after the close. DST-aware via
 * {@link getEasternUtcOffset}. Used by the conviction-DCA session gate (TRA-954)
 * — no add inside the last `noAddLastMinutes` of the session.
 */
export function minutesToSessionClose(utcMs: number = Date.now()): number {
  const offsetHours = getEasternUtcOffset(utcMs);
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  const etDate = new Date(etMs);
  const dayOfWeek = etDate.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return 0;
  const etMinutes = etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
  const closeEt = 16 * 60;
  if (etMinutes < 9 * 60 + 30 || etMinutes >= closeEt) return 0;
  return closeEt - etMinutes;
}

/**
 * TRA-1157 — agent activity window. Returns true only when the regular US equity
 * session is open AND we are `bufferMinutes` past the open and `bufferMinutes`
 * before the close (default 15: 9:45 AM–3:45 PM ET, Mon–Fri). This narrows the
 * window in which the multi-agent advisory layer is allowed to fire its Anthropic
 * calls so the API bill is not spent overnight, on the open/close auction churn,
 * or on weekends. Weekends and the 9:30/16:00 edges return false. Holidays are
 * not modelled here (same limitation as {@link isStockMarketOpen}) — a holiday
 * still reads as "closed enough" because the deeper signal feeds are also dark.
 */
export function isAgentTradingWindowOpen(
  utcMs: number = Date.now(),
  bufferMinutes = 15,
): boolean {
  const offsetHours = getEasternUtcOffset(utcMs);
  const etMs = utcMs + offsetHours * 60 * 60 * 1000;
  const etDate = new Date(etMs);
  const dayOfWeek = etDate.getUTCDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const etMinutes = etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
  const openEt = 9 * 60 + 30 + bufferMinutes;
  const closeEt = 16 * 60 - bufferMinutes;
  return etMinutes >= openEt && etMinutes < closeEt;
}

// Crypto trading windows (UTC minutes) — skip dead zone 04:00–07:59
// Based on academic analysis: peak volume/volatility 12:00–17:00, secondary peaks at 00:00 and 08:00.
export const CRYPTO_TRADING_WINDOWS: readonly [number, number][] = [
  [0 * 60,   4 * 60],   // 00:00–04:00 UTC (Asian session open)
  [8 * 60,  12 * 60],   // 08:00–12:00 UTC (London session open)
  [12 * 60, 17 * 60],   // 12:00–17:00 UTC (London/NY overlap — peak volatility)
  [21 * 60, 24 * 60],   // 21:00–24:00 UTC (pre-Asian accumulation)
] as const;

/** Returns true when the UTC timestamp falls inside an active crypto trading window. */
export function isValidCryptoTradingWindow(utcMs: number): boolean {
  const utcMinutes = Math.floor(utcMs / 60_000) % (24 * 60);
  return CRYPTO_TRADING_WINDOWS.some(([start, end]) => utcMinutes >= start && utcMinutes < end);
}

// Backward-compat alias
export const OPTIONS_TP_PCT = OPTIONS_TP1_PCT;

/**
 * TRA-354 — in-flight Tradier `sell_to_close` LIMIT order an engine-fired
 * exit has staged on the live broker. The paper book transitions the
 * position into this state instead of closing immediately; the next tick
 * polls the Tradier order id and finalises (or clears) based on whether
 * the broker filled or rejected. `kind` distinguishes the partial TP1
 * exit (sells half, leaves the rest open) from the full SL/trail exit
 * (sells whatever remains and retires the position).
 *
 * TRA-358 — `manual` extends this state machine to user-initiated closes
 * from the TradeAI UI (engine-opened live positions). Same poller / cancel
 * semantics as the engine-fired kinds; `qty` may be < contractsRemaining
 * for a partial close, in which case finalize leaves the remainder open
 * without engaging trailing (unlike `tp1`, which is the engine's own
 * partial-take rule).
 */
export type OptionPendingExitKind = 'tp1' | 'sl' | 'trail' | 'manual';

/**
 * TRA-358 — Tradier order duration for the staged `sell_to_close` LIMIT.
 * Mirrors the duration dropdown the user sees on Tradier's web close panel;
 * UI defaults to `day`. Stored on the pendingExit so the UI can echo back
 * what was submitted while the order is working.
 */
export type TradierOrderDuration = 'day' | 'gtc' | 'pre' | 'post';

export interface OptionPendingExit {
  /** Tradier order id returned by `sell_to_close` submit. */
  tradierOrderId: string | number;
  /** Contracts being sold on this exit leg. */
  qty: number;
  /** Per-share limit price submitted to Tradier (matches engine trigger). */
  limitPrice: number;
  /** ms epoch when the order was submitted. */
  submittedAt: number;
  /** Which engine trigger staged this exit — drives partial vs full finalise. */
  kind: OptionPendingExitKind;
  /**
   * TRA-361 — order type the engine should submit to Tradier. Defaults to
   * `'limit'` (TRA-354 wait-and-hold behaviour). Set to `'market'` for the
   * deep-underwater imported-position escalation so an unfillable limit
   * doesn't leave the position stuck open after SL trips.
   */
  pricing?: 'limit' | 'market';
  /**
   * TRA-358 — Tradier order duration submitted with the LIMIT. Optional for
   * back-compat with TRA-354 records that pre-date the field; absent ↔ `day`
   * (Tradier's default and the engine's previous hardcoded value).
   */
  duration?: TradierOrderDuration;
}

/**
 * TRA-613 (TRA-595 C5) — one leg of a defined-risk multi-leg options spread.
 * Mirrors the C5 panel's idea-leg contract so a paper combo position can carry
 * the exact structure that was surfaced and entered (bull put spread, iron
 * condor, debit spread, …).
 */
export interface OptionLeg {
  action: 'buy' | 'sell';
  optionType: OptionType;
  strike: number;
  expiration: string;
}

export interface OptionPosition {
  id: string;
  symbol: string;
  optionSymbol?: string;      // OCC format, e.g. AAPL240419C00150000
  optionType: OptionType;
  strike?: number;
  expiration?: string;
  contracts: number;
  contractsRemaining: number; // after partial exit at TP1; starts equal to contracts
  premiumPaid: number;        // per-share premium at entry
  currentPremium: number;     // current mark (updated on each tick)
  tp1Premium: number;         // partial exit trigger at +25%
  tp1Hit: boolean;            // true once 50% has been exited at TP1
  stopLossPremium: number;    // hard stop loss at -25% (improved from -35%)
  peakPremium: number;        // highest mark seen (used for trailing stop)
  trailingActive: boolean;    // true once price is up 20% and trailing mode engaged
  trailingStopPremium: number; // current trailing stop level (peak * (1 - 0.12))
  underlyingEntryPrice: number;
  openedAt: number;
  closedAt?: number;
  pnl?: number;
  signalId: string;
  signalType: SignalType;
  /**
   * TRA-233 — Tradier environment the position was opened against. Set when
   * the engine routed the open to Tradier so the dashboard / Open Positions
   * view can segregate sandbox vs production state when the user flips
   * `liveTradierEnvOptions`. Optional for backwards compat with snapshots
   * persisted before this field existed; absent ↔ legacy sandbox bucket.
   */
  tradierEnv?: TradierEnv;
  /**
   * TRA-231 — account mode the option was opened under. Sandbox + production
   * already split persistence into per-env buckets, but a single env bucket
   * could still accumulate both demo and live opens (e.g. a demo paper open
   * pre-TRA-220 sitting in the sandbox bucket while live mode also targets
   * sandbox). Filtering Open / Recent Closed Options by `mode` keeps each
   * mode's history independent. Optional for back-compat with snapshots
   * persisted before this field existed; absent positions are routed to demo
   * since pre-TRA-220 only the demo path opened paper options.
   */
  mode?: AccountMode;
  /**
   * TRA-323 — true when this position was imported from Tradier rather than
   * opened by the local engine. Imported positions are surfaced in the same
   * Open Options view so the user can close them from TradeAI; closing one
   * routes a real `sell_to_close` order to Tradier instead of touching the
   * paper cash bucket. Absent ↔ legacy or engine-opened position.
   */
  importedFromTradier?: boolean;
  /**
   * TRA-348 — Tradier order id for an in-flight `sell_to_close` against an
   * imported position. Set when the close order was accepted but did not
   * reach a terminal `filled` state inside the wait window (after-hours,
   * illiquid contract). The dashboard renders this row with a disabled
   * "Pending #N" button instead of the Close button so the user doesn't
   * fire a duplicate close. Cleared once the next reconcile sees Tradier
   * drop the position from `/positions` (broker confirms flat) or once the
   * engine learns the order terminated.
   */
  pendingCloseOrderId?: number | string;
  /**
   * TRA-392 — wall-clock ms when {@link pendingCloseOrderId} was last
   * (re)stamped, either by the initial smart-close submit or by a fill-chaser
   * reprice. The engine's per-tick close reconciler uses this to decide when a
   * still-pending `sell_to_close` has gone stale and should be cancelled +
   * resubmitted one step lower toward the bid. Absent on snapshots persisted
   * before this field existed; absent ↔ "stale immediately" so a leftover
   * pending order from a previous session gets repriced on the next tick.
   */
  pendingCloseSubmittedAt?: number;
  /**
   * TRA-392 — how many times the fill-chaser has cancelled + repriced the
   * pending `sell_to_close` down toward the bid. Bounds the walk: once it
   * reaches the configured max-steps the reconciler stops repricing and just
   * polls the (most-aggressive, at-the-bid) order. Reset to 0 each time a
   * fresh close order is stamped via the normal close path.
   */
  pendingCloseRepriceSteps?: number;
  /**
   * TRA-416 — Tradier order id of the most recent `sell_to_close` whose
   * PARTIAL fill slice has already been realised into local P&L. When a close
   * order fills part-way and then goes terminal (expired / cancelled), the
   * per-tick close reconciler books the filled slice, reduces the position to
   * the remainder, and re-submits a fresh order for what's left. Stamping the
   * terminal order id here is the idempotency guard: if the same terminal
   * order is reconciled again on a later sweep (e.g. the re-submit failed and
   * the marker wasn't replaced), the slice is recognised as already booked and
   * is not realised twice. Absent ↔ no partial fill seen / legacy snapshot.
   */
  partialCloseBookedOrderId?: number | string;
  /**
   * TRA-354 — engine-fired exit (TP1 partial / SL / trailing) has submitted
   * a Tradier `sell_to_close` LIMIT order and is waiting for the broker to
   * confirm. While this is set, the paper book holds the position open;
   * `checkExits` no longer re-fires triggers and the engine's poll path is
   * responsible for finalising (on fill) or clearing (on reject/cancel).
   * Distinct from {@link pendingCloseOrderId}: that one tracks USER-initiated
   * closes against imported positions; this one tracks ENGINE-fired exits
   * against engine-opened positions.
   */
  pendingExit?: OptionPendingExit;
  /**
   * TRA-354 — last reason a pendingExit was cleared without filling
   * (Tradier rejected / canceled / expired the order, or the HTTP call
   * threw). Surfaced on the dashboard's Open Options view so the user
   * knows their exit didn't go through and the position is still live.
   * Cleared once a fresh pendingExit is submitted on a later tick.
   */
  exitErrorReason?: string;
  /**
   * TRA-450 — consecutive rejected auto-close (`sell_to_close`) attempts the
   * engine has made for this position. Bumped by `clearPendingExit` each time
   * the broker rejects / cancels / expires a staged exit (or the submit
   * throws); reset to absent on a fill (`finalizePendingExit`) or a user
   * re-stage (`stageManualPendingExit`). Once it reaches the engine's
   * `MAX_CONSECUTIVE_CLOSE_REJECTS` threshold, `checkExits` stops re-staging
   * the exit so the engine can't spray the broker with hundreds of doomed
   * orders — the row keeps `exitErrorReason` so the user can close manually.
   * Absent ↔ no rejected close attempt outstanding / legacy snapshot.
   */
  closeRejectCount?: number;
  /**
   * TRA-384 — sign-adjusted Black-Scholes delta captured from the OTM / RV
   * scanner at entry. Used by `checkExits` as the extrapolation slope when the
   * live mark feed has stalled, so the stop-loss backstop tracks an OTM strike
   * honestly instead of assuming an ATM 0.50 delta. Absent on ATM opens and on
   * snapshots persisted before this field existed.
   */
  entryDelta?: number;
  /**
   * TRA-384 — consecutive `checkExits` ticks this OTM / RV position has gone
   * without a fresh live mark. Reset to 0 the moment a mark lands. Once it
   * reaches `STALE_MARK_BACKSTOP_TICKS`, `checkExits` stops skipping the
   * position and evaluates SL / trailing off the underlying-delta backstop so
   * a stalled mark feed can't silently disable the stop loss. Absent ↔ never
   * missed a mark / legacy snapshot.
   */
  staleMarkTicks?: number;
  /**
   * TRA-613 (TRA-595 C5) — defined-risk MULTI-LEG spread combo. When present
   * (length ≥ 2) this position represents an AI-Options-Ideas defined-risk
   * structure (bull put spread, iron condor, debit spread, …) entered through
   * the paper options account as a SINGLE combo, not a single long contract.
   * The combo's capital-at-risk is the capped {@link maxLossUsd}: the entry
   * debits `maxLossUsd × contracts` from paper cash (uniform across debit and
   * credit structures — for a credit spread this is the broker buying-power
   * hold `width − credit`, for a debit spread it is the debit) and
   * `premiumPaid = maxLossUsd ÷ 100 ÷ contracts` carries that per-share basis so
   * the existing P&L-on-close math treats the reserved capital as the cost
   * basis. {@link netUsd} / {@link maxProfitUsd} / {@link breakevens} carry the
   * entry credit/debit, capped upside, and payoff turn points for display.
   * Combo positions are SKIPPED by the per-leg SL/TP/trailing engine
   * ({@link checkExits}) — they are defined-risk and held to the user's manual
   * close / expiry, so there is no single-contract mark to manage. Absent ↔
   * single-leg position (the only structure pre-TRA-613).
   */
  legs?: OptionLeg[];
  /** TRA-613 — defined-risk strategy id of the combo (e.g. 'bull_put_spread'). */
  spreadStrategy?: string;
  /** TRA-613 — net premium at entry, + credit / − debit, USD across all `contracts`. */
  netUsd?: number;
  /** TRA-613 — capped max loss (capital at risk), USD across all `contracts`. */
  maxLossUsd?: number;
  /** TRA-613 — capped max profit, USD across all `contracts`. */
  maxProfitUsd?: number;
  /** TRA-613 — payoff breakeven underlying price(s). */
  breakevens?: number[];
  /**
   * TRA-1268 (TRA-1250 Rule 1) — favorable extreme of the UNDERLYING since
   * entry, used to drive the ATR chandelier trailing stop on the underlying
   * (a call trails the highest high; a put trails the lowest low). Seeded from
   * {@link underlyingEntryPrice} on first evaluation and ratcheted each tick.
   * Only maintained when the exit-risk rules are enabled; absent ↔ legacy /
   * rules-off snapshot.
   */
  peakUnderlying?: number;
  /**
   * TRA-1268 (TRA-1250 Rule 1) — last computed chandelier trail-stop level in
   * UNDERLYING price space. Persisted as the `prevTrailStop` so the trail only
   * ratchets in the favorable direction (never loosens) across ticks/restarts.
   * Absent ↔ chandelier not yet armed / rules-off snapshot.
   */
  chandelierStop?: number;
}

/**
 * TRA-844 — one row of the portfolio allocation rollup (by underlying name or
 * by sector). `notional` is the market value of open option premium attributed
 * to the bucket (current mark × contracts × 100, falling back to premium paid
 * when no live mark is available); `pctOfBook` is that as a fraction of the
 * total valued premium in [0,1]. Buckets are returned sorted by `notional`
 * descending so the dashboard panel and EOD markdown can render the
 * concentration story top-down.
 */
export interface AllocationBucket {
  /** Underlying ticker or sector name this bucket aggregates. */
  key: string;
  /** Market value of open option premium in this bucket, USD. */
  notional: number;
  /** `notional` as a fraction of the whole book's valued premium, [0,1]. */
  pctOfBook: number;
  /** How many open option positions rolled into this bucket. */
  positions: number;
}

/**
 * TRA-844 — portfolio-level aggregate Greeks, daily theta-$ bleed, and
 * allocation-by-name/sector for the open options book. Closes the issue's
 * "biggest risk blind spot": before this, the dashboard showed per-position
 * marks but never the netted directional/convexity/vol exposure or how
 * concentrated the book was.
 *
 * Greek aggregates are expressed in book dollar/share terms (already scaled by
 * contracts × 100):
 *   • `netDelta`  — equivalent shares of underlying exposure (Σ delta × qty × 100).
 *   • `netGamma`  — Δdelta (shares) per $1 underlying move (Σ gamma × qty × 100).
 *   • `netVega`   — $ P&L per +1 IV vol-point across the book.
 *   • `thetaDollarsPerDay` — $ the book bleeds per calendar day from time decay
 *     (negative for a net-long-premium book — the common case here).
 *
 * `positionsValued` / `positionsTotal` expose how many open positions had a
 * usable spot+IV solve and contributed Greeks; the gap is combos / positions
 * with no current mark or no resolvable spot, which still contribute notional
 * to the allocation buckets but contribute zero Greeks (honest under-count
 * rather than a fabricated number). Optional throughout for back-compat with
 * persisted state / reports that predate the rollup.
 */
export interface PortfolioGreeks {
  netDelta: number;
  netGamma: number;
  netVega: number;
  /** Net daily time-decay in dollars (negative = the book bleeds theta). */
  thetaDollarsPerDay: number;
  /** Total market value of open option premium across the book, USD. */
  netNotional: number;
  /** Open positions that contributed Greeks (had a spot + IV solve). */
  positionsValued: number;
  /** Total open positions considered (valued + Greek-less notional-only). */
  positionsTotal: number;
  /** Allocation by underlying name, sorted by notional descending. */
  byName: AllocationBucket[];
  /** Allocation by sector bucket, sorted by notional descending. */
  bySector: AllocationBucket[];
  /**
   * TRA-931 — diagnostic breakdown of WHY each notional-bearing position that
   * did NOT contribute Greeks was skipped. Keyed by reason; values count
   * positions. Lets the dashboard / a health probe distinguish a benign
   * multi-leg-combo gap (expected: combos never solve a single-contract IV)
   * from a real blind spot (`no_spot` / `no_iv_solve`) where the risk gate is
   * flying blind on a tradeable single-leg position. Sums to
   * `positionsTotal − positionsValued`. Optional/back-compat: absent on
   * persisted state predating the field and when every position was valued.
   */
  greeksUnvaluedReasons?: Partial<Record<GreeksUnvaluedReason, number>>;
  /** Unix ms the rollup was computed. */
  asOf: number;
}

/**
 * TRA-931 — why a single open option position contributed premium notional but
 * no Greeks to the {@link PortfolioGreeks} rollup.
 *   • `multi_leg_combo` — defined-risk combo; no single-contract mark to solve
 *     an IV against (expected, benign).
 *   • `no_spot`         — the underlying spot didn't resolve (not on the quote
 *     tape and no entry-price fallback). The real blind spot this ticket fixes.
 *   • `bad_strike`      — missing / non-positive strike (malformed position).
 *   • `expired`         — time-to-expiry ≤ 0 (position past expiration).
 *   • `no_iv_solve`     — spot + mark were present but the BS IV solve failed
 *     (mark below intrinsic / outside the solver's bracket).
 */
export type GreeksUnvaluedReason =
  | 'multi_leg_combo'
  | 'no_spot'
  | 'bad_strike'
  | 'expired'
  | 'no_iv_solve';

export interface OptionsAccountState {
  openOptions: OptionPosition[];
  closedOptions: OptionPosition[];
  optionsPnl: number;
  /**
   * TRA-475 — today's options P&L for the requested mode: realized delta
   * since the most recent ET-midnight rollover (`optionsPnl − opening`) plus
   * the live mark-to-market on currently-open positions for that mode. Mirrors
   * the equity `AccountState.dailyPnl` semantics so the dashboard "Daily Opts
   * P&L" pill can reset at the same boundary instead of accumulating yesterday's
   * realized P&L. Optional for back-compat with older persisted state files.
   */
  dailyOptionsPnl?: number;
  /**
   * TRA-1228 — today's *realized* options P&L for the mode, summed directly
   * from the contracts that closed today (row-sum), NOT the opening-baseline
   * delta {@link dailyOptionsPnl} uses. This is the figure that matches the P&L
   * Calendar's per-day cell and the "Closed Today" table, so the dashboard can
   * show a realized number that reconciles across surfaces even after a
   * mid-session restart re-seeds the opening baseline. Optional for back-compat.
   */
  dailyRealizedOptionsPnl?: number;
  /**
   * TRA-1228 — current unrealized mark-to-market on the mode's OPEN contracts
   * ((mark − entry) × contractsRemaining × 100). Surfaced separately from the
   * realized figure so the dashboard can distinguish "banked today" from
   * "open-book paper gains" instead of conflating them in one pill. Optional
   * for back-compat.
   */
  openOptionsUnrealizedPnl?: number;
  optionsCash: number;
  dailyOptionsCount: number;  // number of options opened today (resets at market open)
  /**
   * TRA-374 — running cumulative cost of the demo slippage haircut applied
   * by the demo cost model. Always 0 in `getStateForMode('live')` (live pays
   * real Tradier slippage; modelling it locally would double-count).
   * Optional for back-compat — older persisted state files don't carry it.
   */
  demoSlippageCost?: number;
  /**
   * TRA-374 — running cumulative cost of the demo per-contract fee debit
   * applied by the demo cost model. Same back-compat caveat as
   * {@link demoSlippageCost}.
   */
  demoFeeCost?: number;
  /**
   * TRA-844 — portfolio-level Greeks + theta-$ bleed + allocation rollup over
   * `openOptions`. Computed by the engine (which has live underlying spots) and
   * attached to the per-mode options state; absent when the engine couldn't
   * resolve spots or on persisted state files that predate the rollup, so the
   * dashboard panel must treat it as optional.
   */
  portfolioGreeks?: PortfolioGreeks;
}

export const WATCHLIST: readonly string[] = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN',
  'META',  'TSLA', 'AMD',  'NFLX',  'ORCL',
  'INTC',  'QCOM', 'AVGO', 'CRM',   'ADBE',
  // Block Inc. renamed `SQ` → `XYZ` on 2025-01-13; the old ticker is delisted
  // and Stooq / Tradier 404 on it. Users with `SQ` in a persisted watchlist
  // are migrated by `aliasWatchlistSymbol` at read time.
  'PYPL',  'XYZ',  'SHOP', 'COIN',  'MSTR',
  'SPY',   'QQQ',  'IWM',  'DIA',   'XLF',
] as const;

// TRA-201: explicit alias so callers that need the equities-only set don't have
// to know that `WATCHLIST` is historically equities. Existing imports of
// `WATCHLIST` keep working — additive only.
export const EQUITIES_WATCHLIST = WATCHLIST;

/**
 * TRA-952 — curated LIQUID swing-trade universe for the equity engine.
 *
 * Live evidence (2026-06-18) showed the demo equity engine day-trading thin
 * small-caps (RKLB, RDW, UMAC, MNTS, SPCE, …) where intraday slippage eats the
 * swing edge. The swing conversion restricts equity *entries* to liquid
 * large-caps + the liquid crypto-proxy names so a 2–10 trading-day hold isn't
 * bled out by spread/slippage. This is the curatable allow-list: QuantTrader
 * owns the exact membership and can override it at runtime via the
 * `EQUITY_SWING_UNIVERSE` env (comma/space-separated tickers) without a
 * redeploy — see {@link resolveEquitySwingUniverse}.
 *
 * Deliberately a SUBSET of {@link WATCHLIST}: the thinnest single-stock names
 * are dropped; deep-book mega-caps and broad-market ETFs stay. `*-USD` crypto
 * majors are handled by {@link CRYPTO_WATCHLIST} on the crypto engine and are
 * always swing-eligible (see {@link isLiquidSwingSymbol}).
 */
export const EQUITY_SWING_UNIVERSE: readonly string[] = [
  // Mega-cap tech / deep single-stock books
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
  'NFLX', 'ORCL', 'AVGO', 'CRM', 'ADBE', 'QCOM',
  // Liquid crypto-proxy large-caps
  'COIN', 'MSTR',
  // Broad-market index ETFs (deepest books on the tape)
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLF',
] as const;

/**
 * TRA-952 — resolve the active equity swing universe. Honors the
 * `EQUITY_SWING_UNIVERSE` env override (comma/space-separated tickers) so
 * QuantTrader can curate the allow-list at runtime; falls back to the shipped
 * {@link EQUITY_SWING_UNIVERSE} default. Tickers are upper-cased and aliased.
 */
export function resolveEquitySwingUniverse(): readonly string[] {
  const raw = (typeof process !== 'undefined' ? process.env?.EQUITY_SWING_UNIVERSE : undefined) ?? '';
  const parsed = raw.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const list = parsed.length > 0 ? parsed : EQUITY_SWING_UNIVERSE;
  return list.map(s => aliasWatchlistSymbol(s).toUpperCase());
}

/**
 * TRA-952 — true when `symbol` is eligible for a swing-trade equity entry:
 * either an explicit member of the curated liquid universe, or a `*-USD`
 * crypto major (those route through the crypto engine's own Coinbase-strict
 * universe and are always swing-eligible here). Aliases legacy tickers first.
 */
export function isLiquidSwingSymbol(
  symbol: string,
  universe: readonly string[] = resolveEquitySwingUniverse(),
): boolean {
  const upper = (symbol ?? '').toUpperCase();
  if (/-USD$/i.test(upper)) return true;
  return universe.includes(aliasWatchlistSymbol(upper).toUpperCase());
}

/**
 * TRA-952 — resolve the EFFECTIVE equity swing-mode master switch. ON (the
 * default) restricts equity entries to the curated liquid universe, disables the
 * intraday churners (ORB + 1h BbFade), and enforces the swing holding-period
 * floor on discretionary closes. It is an opt-OUT kill switch: only an explicit
 * `EQUITY_SWING_MODE=off` (or `0`/`false`/`no`) reverts to the legacy intraday
 * day-trading behavior. Single source of truth so the router (signal-engine
 * `equitySwingModeEnabled`) and the `/api/health/equity-swing` readout resolve
 * the flag through the exact same path — the health probe therefore reflects the
 * EFFECTIVE runtime switch, not just what the IaC declares (TRA-1306).
 */
export function resolveEquitySwingModeEnabled(
  env: { EQUITY_SWING_MODE?: string } = typeof process !== 'undefined' ? process.env : {},
): boolean {
  const v = (env.EQUITY_SWING_MODE ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/**
 * TRA-844 — coarse GICS-style sector buckets for the equity/options universe,
 * used by the portfolio Greeks + allocation rollup to group exposure by sector
 * (the "biggest risk blind spot" the issue closes — e.g. seeing that 70% of
 * option premium sits in mega-cap Tech). Keyed by the underlying ticker an
 * option is written on. Broad-market index ETFs (SPY/QQQ/…) bucket to `Index`
 * and `*-USD` tickers to `Crypto`; anything unmapped falls through to `Other`
 * via {@link sectorOf} so a newly-added symbol degrades gracefully rather than
 * throwing. Deliberately hand-maintained (no live GICS feed) — it only needs to
 * cover the {@link WATCHLIST} names the options scanners actually trade.
 */
export const SECTOR_BY_SYMBOL: Readonly<Record<string, string>> = {
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', AMD: 'Technology',
  AVGO: 'Technology', INTC: 'Technology', QCOM: 'Technology', ORCL: 'Technology',
  CRM: 'Technology', ADBE: 'Technology',
  GOOGL: 'Communication Services', META: 'Communication Services', NFLX: 'Communication Services',
  AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary', SHOP: 'Consumer Discretionary',
  PYPL: 'Financials', XYZ: 'Financials', COIN: 'Financials', MSTR: 'Financials', XLF: 'Financials',
  SPY: 'Index', QQQ: 'Index', IWM: 'Index', DIA: 'Index',
};

/**
 * TRA-844 — resolve a symbol's sector bucket for the portfolio rollup. Applies
 * the {@link aliasWatchlistSymbol} rename map first (so a legacy `SQ` position
 * resolves to `XYZ`'s Financials bucket), then `*-USD` → `Crypto`, the explicit
 * {@link SECTOR_BY_SYMBOL} map, and finally `Other` for anything unmapped.
 */
export function sectorOf(symbol: string): string {
  const upper = (symbol ?? '').toUpperCase();
  if (/-USD$/i.test(upper)) return 'Crypto';
  const aliased = aliasWatchlistSymbol(upper).toUpperCase();
  return SECTOR_BY_SYMBOL[aliased] ?? 'Other';
}

/**
 * Map known stale tickers to their renamed equivalents at read time so users
 * with the old symbol persisted in their watchlist see live data without
 * having to manually edit the list.
 */
const STOCK_TICKER_ALIASES: Readonly<Record<string, string>> = {
  SQ: 'XYZ', // Block Inc. ticker change effective 2025-01-13.
};

export function aliasWatchlistSymbol(symbol: string): string {
  return STOCK_TICKER_ALIASES[symbol.toUpperCase()] ?? symbol;
}

// TRA-521 — Coinbase-only watchlist. The board's directive is explicit:
// "Only get quotes from Coinbase watchlist, don't add other coins. Clear the
// unavailable quotes if they are not tradeable on Coinbase." This supersedes
// the TRA-445 rationale that kept Yahoo-backstopped, non-Coinbase assets in
// the list. Six symbols Coinbase does not list — BNB-USD, TRX-USD, THETA-USD,
// VET-USD, RUNE-USD, EGLD-USD (Binance/Cosmos-only assets that only ever
// resolved via the Yahoo/CMC fallback and 404/400 on both Coinbase hosts) —
// are removed so the dashboard shows only tradeable Coinbase products and no
// permanently-"unavailable" rows. The engine's Coinbase-strict entry gate
// (TRA-338) already refused to trade them; this stops quoting them too.
//
// TRA-445 token migrations are unchanged: MATIC→POL and FTM→S (the old
// Coinbase products are delisted, the list tracks the new tickers, and legacy
// positions resolve via `aliasCryptoSymbol`). TRA-344 RNDR→RENDER likewise.
export const CRYPTO_WATCHLIST: readonly string[] = [
  'BTC-USD',   'ETH-USD',   'SOL-USD',   'ADA-USD',   'DOT-USD',
  'AVAX-USD',  'LINK-USD',  'POL-USD',   'XRP-USD',   'LTC-USD',
  'BCH-USD',   'ATOM-USD',  'DOGE-USD',  'SHIB-USD',  'NEAR-USD',
  'S-USD',     'SAND-USD',  'MANA-USD',  'AXS-USD',   'UNI-USD',
  'AAVE-USD',  'MKR-USD',   'CRV-USD',   'ALGO-USD',  'XLM-USD',
  'ETC-USD',   'FIL-USD',   'HBAR-USD',  'ICP-USD',   'FLOW-USD',
  'GRT-USD',   'ARB-USD',   'OP-USD',    'APT-USD',   'SUI-USD',
  'INJ-USD',   'RENDER-USD','IMX-USD',   'LDO-USD',   'SNX-USD',
  'APE-USD',   'COMP-USD',  'CHZ-USD',   'ZEC-USD',
] as const;

/**
 * Map known stale crypto tickers to their renamed equivalents at read time so
 * positions/watchlists persisted under the old symbol still resolve a price
 * upstream without manual migration. Mirrors {@link STOCK_TICKER_ALIASES}.
 *
 * TRA-344 — RNDR-USD → RENDER-USD (Coinbase rebrand 2024-04-23).
 * TRA-445 — MATIC-USD → POL-USD (Polygon token migration, Sept 2024).
 * TRA-445 — FTM-USD → S-USD (Fantom → Sonic token migration, 2025).
 */
const CRYPTO_TICKER_ALIASES: Readonly<Record<string, string>> = {
  'RNDR-USD': 'RENDER-USD',
  'MATIC-USD': 'POL-USD',
  'FTM-USD': 'S-USD',
};

export function aliasCryptoSymbol(symbol: string): string {
  return CRYPTO_TICKER_ALIASES[symbol.toUpperCase()] ?? symbol;
}

/**
 * Symbols that must never be watched, signalled, or traded — regardless of
 * what a user has saved in their per-user watchlist or what the market
 * scanner surfaces. Compared case-insensitively.
 *
 * TRA-283: TERMINUS-USD and RUNE-USD blacklisted — operator decision.
 */
export const CRYPTO_DENYLIST: readonly string[] = [
  'TERMINUS-USD',
  'RUNE-USD',
] as const;

const CRYPTO_DENYLIST_SET: ReadonlySet<string> = new Set(
  CRYPTO_DENYLIST.map(s => s.toUpperCase()),
);

export function isCryptoSymbolBlocked(symbol: string): boolean {
  return CRYPTO_DENYLIST_SET.has(symbol.toUpperCase());
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary?: string;
  /**
   * TRA-227 — set on items that originate from the research store (currently
   * QuantTrader pre/post-market reviews). The UI uses this to render a
   * "Research" badge and expand the inline markdown body instead of opening
   * the link in a new tab.
   */
  id?: string;
  kind?: ResearchReportKind;
  bodyMarkdown?: string;
  /**
   * TRA-534 — optional per-article sentiment, attached by the signal-engine's
   * 5-min news refresh via {@link scoreNewsSentiment}. Optional so raw feeds
   * (and historical cached items) remain valid without it. `method` tags the
   * scorer (`lexicon-v1` today) so a FinBERT scorer can replace it later
   * without a schema change.
   */
  sentiment?: NewsSentiment;
}

export interface NewsSentiment {
  /** Polarity in [-1,+1]; positive = bullish tone. */
  score: number;
  label: 'positive' | 'neutral' | 'negative';
  /** [0,1] — scales with the number of lexicon tokens matched. */
  confidence: number;
  /** Scorer identifier, e.g. `lexicon-v1`. */
  method: string;
}

/**
 * TRA-534 — per-symbol recency-weighted news-sentiment aggregate handed to the
 * TRA-529 news analyst and surfaced in `GET /api/analysis/breadth/:symbol`.
 */
export interface SymbolSentiment {
  symbol: string;
  asOf: string; // ISO
  window: '24h';
  /** Recency-weighted mean of article scores (half-life 6h), clamped [-1,+1]. */
  netScore: number;
  articleCount: number;
  /** Age of the newest mapped article, in minutes. */
  freshnessMinutes: number;
  /**
   * Gated directional read on `netScore`: bullish ≥ +0.25, bearish ≤ -0.25.
   * Forced `neutral` when `articleCount < 2` or `freshnessMinutes > 720` (stale).
   */
  tilt: 'bullish' | 'bearish' | 'neutral';
  topHeadlines: SymbolSentimentHeadline[];
}

export interface SymbolSentimentHeadline {
  title: string;
  source: string;
  score: number;
  publishedAt: string; // ISO
}

/**
 * TRA-602 — one normalized StockTwits message. Only the fields the social
 * aggregate needs are kept (the raw stream carries far more). `sentiment` is the
 * poster's self-reported tag (`entities.sentiment.basic`), `null` when untagged.
 */
export interface StockTwitsMessage {
  id: number;
  createdAt: string; // ISO
  sentiment: 'Bullish' | 'Bearish' | null;
  /**
   * TRA-603 — uppercased ticker symbols this message references (parsed from the
   * raw `symbols` entity). Populated for curated user-stream messages so they can
   * be folded onto every symbol they mention; omitted for symbol-stream messages,
   * which are already scoped to a single symbol.
   */
  symbols?: string[];
  /**
   * TRA-603 — true when sourced from a curated followed account. Curated messages
   * are weighted above anonymous crowd messages in `aggregateStockTwitsSentiment`.
   */
  curated?: boolean;
}

/**
 * TRA-602 — per-symbol recency-weighted StockTwits social-sentiment aggregate.
 * Surfaced in `GET /api/analysis/breadth/:symbol` as the `social` half alongside
 * the news `sentiment` and `technical` reads, giving the scanners/engine a crowd
 * read to complement the headline read.
 */
export interface SocialSentiment {
  symbol: string;
  asOf: string; // ISO
  window: '24h';
  /** Provider tag — `stocktwits` today; lets a second social feed fold in later. */
  source: 'stocktwits';
  /** Recency-weighted mean of per-message polarity (+1 bull / −1 bear), [-1,+1]. */
  netScore: number;
  bullishCount: number;
  bearishCount: number;
  /** bullishCount + bearishCount — messages carrying a directional tag. */
  taggedCount: number;
  /**
   * TRA-603/TRA-745 — count of curated (followed-account) tagged messages that
   * contributed to the score. `> 0` means the higher-weight analyst lane moved
   * `netScore`, so a consumer can surface a "curated" marker rather than reading
   * the number as pure anonymous crowd. Subset of `taggedCount`.
   */
  curatedCount: number;
  /** Total messages seen, tagged or not — a raw social-buzz/volume proxy. */
  messageCount: number;
  /** Age of the newest tagged message, in minutes. */
  freshnessMinutes: number;
  /**
   * Gated directional read on `netScore`: bullish ≥ +0.25, bearish ≤ -0.25.
   * Forced `neutral` when `taggedCount < 5` or `freshnessMinutes > 720` (stale).
   */
  tilt: 'bullish' | 'bearish' | 'neutral';
}

/**
 * TRA-533 (TRA-530 Part A) — multi-timeframe technical signal snapshot handed
 * to the TRA-529 technical analyst and surfaced in
 * `GET /api/analysis/breadth/:symbol`. Computed by the deterministic engine
 * compose function {@link composeTechnicalSnapshot} (see
 * `packages/engine/src/indicators/mtf.ts`) over per-timeframe candle arrays.
 */
export type TechnicalTimeframe = '15m' | '1h' | '1d';

/**
 * Directional read on `mtfScore`, bucketed per the TRA-530 spec at ±0.2 / ±0.5.
 */
export type MtfBias = 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';

/** Raw indicator reads for one timeframe; `null` when data was insufficient. */
export interface TechnicalIndicatorReads {
  /** Wilder RSI(14) on closes. */
  rsi: number | null;
  /** ADX(14) trend strength. */
  adx: number | null;
  /** MACD(12,26,9) histogram (macd − signal). */
  macdHist: number | null;
  /** EMA(20). */
  emaFast: number | null;
  /** EMA(50). */
  emaSlow: number | null;
  /** ATR(14) as a fraction of the latest close. */
  atrPct: number | null;
  /** Bollinger %B — (price − lower) / (upper − lower); ~0..1, can over/undershoot. */
  bbPercentB: number | null;
  /** Intraday only: signed distance of price from VWAP, as a fraction of price. */
  vwapDist?: number | null;
}

/** Per-timeframe directional decomposition. Each sub-score is in [-1,+1]. */
export interface TimeframeSignal {
  /** EMA stack / SMA200 position / slope vote, de-weighted ×0.5 when ADX<15. */
  trend: number;
  /** RSI band + MACD histogram sign vote. */
  momentum: number;
  /** Bollinger %B (+ VWAP side on intraday TFs). */
  location: number;
  /** 0.45·trend + 0.35·momentum + 0.20·location, clamped [-1,+1]. */
  tfScore: number;
  indicators: TechnicalIndicatorReads;
}

export interface TechnicalSignalSnapshot {
  symbol: string;
  asOf: string; // ISO
  /** Present timeframes only; a TF is omitted when it had no candles at all. */
  timeframes: Partial<Record<TechnicalTimeframe, TimeframeSignal>>;
  /** 0.50·tf(1d) + 0.30·tf(1h) + 0.20·tf(15m), renormalized over present TFs. */
  mtfScore: number;
  mtfBias: MtfBias;
  /** Fraction of present TFs whose tfScore sign matches sign(mtfScore). */
  mtfAlignment: number;
}

export type ResearchReportKind = 'premarket' | 'postmarket' | 'weekly_review';

/**
 * TRA-227 — editorial / research content surfaced in the Stocks News tab
 * alongside Yahoo Finance headlines. Posted by the QuantTrader routine via
 * `POST /api/research/reports`.
 */
export interface ResearchReport {
  id: string;
  kind: ResearchReportKind;
  title: string;
  bodyMarkdown: string;
  publishedAt: string; // ISO
  source: 'QuantTrader';
  tickers?: string[];
  /**
   * TRA-950 — optional structured read attached to a desk review. When a
   * QuantTrader review carries one, the deterministic boot path seeds its
   * `leaders` into the watchlist and the Trading Agents path injects the whole
   * block into the analysts' context. Additive: existing reports + the News-tab
   * UI ignore it.
   */
  reviewBlock?: ReviewBlock;
}

/**
 * TRA-386 — automated pre-/post-market review.
 *
 * Replaces the QuantTrader agent's daily TRA-385 prep comment with a
 * deterministic, server-side regime snapshot. Generated by the scheduler's
 * pre-market (9 AM ET) and archive (9 PM ET) hooks, persisted to
 * `data/market-review.json`, and surfaced both as a `ResearchReport` on the
 * Stocks News tab and via `GET /api/market-review/latest` so the signal
 * engine and watchlist builder can pull regime context without an agent run.
 */
export type MarketRegimeLabel = 'green' | 'yellow' | 'red';

/** One index reading (S&P 500, VIX, 10Y yield) inside a {@link MarketReview}. */
export interface MarketReviewIndexReading {
  /** Yahoo symbol the reading was pulled from (`^GSPC`, `^VIX`, `^TNX`). */
  symbol: string;
  /** Human label rendered in the review (`S&P 500`, `VIX`, `10Y Yield`). */
  label: string;
  /** Latest value, or `null` when the feed could not be reached. */
  value: number | null;
  /**
   * Trend moving average — only computed for the S&P 500 trend gate. The
   * period is `MA_PERIOD` in `market-review.ts` (TRA-472: 50-day SMA).
   * Period-agnostic name — renamed from `ma20` so a future period bump does
   * not leave the field lying about its window.
   */
  trendMa: number | null;
  /** One-line interpretation of this reading. */
  note: string;
}

/**
 * Deterministic strategy gates derived from the regime. The signal engine
 * (follow-up integration) and the watchlist builder read these instead of
 * waiting on a hand-written QuantTrader review.
 */
export interface MarketReviewGates {
  /** Opening-range-breakout longs enabled (S&P 500 in an uptrend per the trend MA). */
  orbLongs: boolean;
  /** ORB shorts enabled (S&P 500 in a downtrend per the trend MA). */
  orbShorts: boolean;
  /** Mean-reversion tilt — VIX in the 16–22 band. */
  meanReversionTilt: boolean;
  /** Breakout strategies enabled — disabled when VIX > 22. */
  breakoutsEnabled: boolean;
  /** Position-size scalar in (0,1]; trimmed in elevated-vol / high-rate tape. */
  sizingMultiplier: number;
  /**
   * TRA-469 — direction of the S&P 500 trend filter the gates were derived
   * from: `'up'` / `'down'` relative to the trend MA (TRA-472: 50-day SMA
   * with a ±1% hysteresis band), or `'unknown'` when the trend feed (`^GSPC`,
   * with the `SPY` fallback) could not be reached.
   *
   * `orbLongs` goes false for two distinct reasons — a genuine downtrend *or*
   * an unreadable trend feed — so the consumer needs this to attribute the
   * suppression to the real cause instead of always reporting a downtrend
   * (the gate-reason contradiction TRA-468 surfaced). Optional so reviews
   * persisted before TRA-469 still deserialise.
   */
  trendState?: 'up' | 'down' | 'unknown';
}

export interface MarketReview {
  /** Idempotency key — `${kind}-${date}`; same-day re-runs upsert in place. */
  id: string;
  kind: 'premarket' | 'postmarket';
  /** Trading date the review targets, `YYYY-MM-DD` in ET. */
  date: string;
  /** ISO timestamp the review was generated. */
  generatedAt: string;
  regime: MarketRegimeLabel;
  /** Human rationale explaining why the regime resolved as it did. */
  regimeRationale: string;
  indexes: MarketReviewIndexReading[];
  gates: MarketReviewGates;
  /** Always `auto` — distinguishes from a hand-written QuantTrader review. */
  source: 'auto';
  /**
   * TRA-950 — structured review block persisted alongside the regime. The auto
   * review fills `regimeLabel` (reused from `regime`, never recomputed) and a
   * deterministic `gapRisk`; `leaders`/`invalidationLevels` stay empty here (the
   * auto review can't curate a leader list — those come from a QuantTrader
   * review published via `/api/research/reports`). Optional so reviews persisted
   * before TRA-950 still deserialise.
   */
  reviewBlock?: ReviewBlock;
}

/** TRA-389 — one strategy the regime gates suppress, plus the reason why. */
export interface GatedStrategyNote {
  /** Strategy label, e.g. `ORB longs`, `ORB shorts`, `Breakouts (ORB)`. */
  strategy: string;
  /** Human reason the regime gate suppressed it. */
  reason: string;
}

/**
 * TRA-389 — market-review regime context surfaced in the signal engine's
 * state envelope (`EngineState.marketReview`) so the dashboard can render
 * "Regime: 🟡 YELLOW" and explain why a strategy stopped firing.
 *
 * `enabled` is `false` — and the remaining fields null / empty — whenever the
 * TRA-389 consumption flag ({@link AccountSettings.marketReviewGatesEnabled})
 * is off or no premarket review has been generated yet, so the dashboard can
 * branch on a single boolean.
 */
export interface EngineMarketReviewState {
  /** True when the consumption path is flagged on AND a review is cached. */
  enabled: boolean;
  /** ET date (`YYYY-MM-DD`) of the premarket review the gates were read from. */
  reviewDate: string | null;
  regime: MarketRegimeLabel | null;
  /** Human rationale for the regime, copied from the cached review. */
  regimeRationale: string | null;
  gates: MarketReviewGates | null;
  /** Strategies the regime gates currently suppress, with a human reason. */
  gatedStrategies: GatedStrategyNote[];
}

export interface CryptoSymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  /**
   * Why this symbol's quote is missing/stale. The watchlist UI uses this to render
   * a useful state ("Quote unavailable — provider rate-limited") instead of a
   * permanent "Loading…" spinner when upstream providers are down.
   *
   * TRA-418 — `'stale'` marks a symbol whose quote or backing candles aged past
   * the freshness threshold (feed down). A stale symbol is excluded from
   * strategy evaluation so a dead feed can never produce a new entry signal.
   */
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable' | 'stale';
}

export interface CryptoEngineState {
  symbols: CryptoSymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: Position[];
  news: NewsItem[];
  lastTick: number;
  autoTradingEnabled: boolean;
  /** Always true — crypto trades 24/7 */
  marketOpen: true;
  /**
   * TRA-249-B — recent live-broker skip events (most recent 50, newest last).
   * Aggregate channel separate from per-`signal.liveSkipReason`: that one
   * stamps the originating signal so the Signals panel can render an inline
   * "not opened" tag, but a Coinbase outage / repeated cash-cap miss leaves
   * no trace once those signals roll off the recent list. The aggregate
   * preserves a structured timeline (symbol, side, reason, at) that survives
   * signal turnover and gives operators a single place to diagnose silent
   * skips. Populated only on the live branch — undefined on demo, where the
   * paper account never skips for liquidity reasons.
   *
   * TODO(TRA-249-E): wire a dashboard surface for this aggregate. Until E
   * lands the field flows through the API but is not yet rendered; the
   * existing per-signal `liveSkipReason` channel keeps the user informed.
   */
  liveSkips?: LiveSkip[];
  /**
   * TRA-345 — the strategy preset the engine is currently gating signal
   * emission on. Surfaced in engine state so the active config can be
   * verified from `/api/crypto/state` without Render dashboard or server-log
   * access. `id` is the resolved preset; `envValue` is the raw
   * `LIVE_STRATEGY_PRESET` process-env string (empty when unset) so a typo
   * that falls back to `no_trade` (TRA-697) is directly visible to operators.
   */
  activePreset: {
    id: StrategyPresetId;
    envValue: string;
    enabledStrategies: readonly CryptoStrategyType[];
    symbolFilter: readonly string[] | null;
    /**
     * TRA-421 — the resolved preset's per-strategy universe whitelist
     * ({@link StrategyPreset.strategyUniverse}), surfaced so operators can
     * confirm the validated-symbol gate is live without log access. Omitted
     * when the preset declares no per-strategy universe.
     */
    strategyUniverse?: Readonly<Partial<Record<CryptoStrategyType, readonly string[]>>>;
  };
}

/**
 * TRA-249-B — structured live-broker skip event. Recorded each time
 * `CryptoLiveAccount.openPosition` declines to submit an order (qty too
 * small, managed equity too small, cost > cash, spot-only SELL, etc.) so
 * the dashboard can surface a timeline of why signals didn't translate to
 * fills. This is the aggregate counterpart to `TradeSignal.liveSkipReason`,
 * which annotates the originating signal in place. Pre-perp (TRA-249-C)
 * the spot-only SELL branch is the entire SELL path; once C lands it
 * becomes the fallback for symbols not in the perp catalog.
 */
export interface LiveSkip {
  symbol: string;
  side: Side;
  reason: string;
  at: number;
}

export interface MarketBar {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  vwap: number;
  timeframe: '1Min' | '5Min';
}

export interface MarketTrade {
  symbol: string;
  timestamp: number;
  price: number;
  size: number;
  conditions: string[];
  exchange: string;
}

export interface MarketQuote {
  symbol: string;
  timestamp: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

// ── EOD Report Types ─────────────────────────────────────────────────────────

export interface EodTradeEntry {
  id: string;
  symbol: string;
  strategy:
    | 'ORB'
    | 'Reversal'
    | 'MACD'
    | 'MACD Trend'   // TRA-170 split
    | 'BB Fade'      // TRA-170 split
    | 'Momentum'     // TRA-205
    | 'Mean Reversion' // TRA-206
    | 'Breakout'     // TRA-207
    | 'Ichimoku'
    | 'Scalping'
    | 'Swing'
    | 'DCA'          // TRA-693 — dollar-cost-averaging accumulation
    | 'OTM'
    | 'RV'           // TRA-191 — relative-value scanner
    | 'Tradier'      // TRA-323 — imported from Tradier (never actually written to disk: imports don't trade through the EOD exporter)
    | 'Options'      // TRA-365 follow-up — option closes that arrived without a more specific signal mapping
    | 'SMA-200'      // TRA-451 — SMA-200 pullback/reclaim signals (display-only; never opens a position, so never reaches the EOD exporter)
    | 'Supertrend'   // TRA-728 — Supertrend confluence (options, router-gated off in Phase 1; never reaches the EOD exporter, mapped for exhaustiveness)
    | 'TSMOM';       // TRA-821 — tsmom_majors crypto candidate (display-only until the TRA-817 OOS gate passes; label reserved for the post-PASS crypto exporter)
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  /** Achieved R:R — how many R units the trade made/lost */
  rr: number;
  openedAt: number;
  closedAt: number;
  /**
   * TRA-365 follow-up — kind of instrument this row represents. Optional for
   * back-compat with reports persisted before options were enumerated; absent
   * is treated as 'equity' by every reader.
   */
  kind?: 'equity' | 'option';
  /**
   * TRA-365 follow-up — percent P&L on this single trade. For equities this is
   * (exit−entry)/entry signed by side; for options the entry/exit prices are
   * per-contract premiums so (exit−entry)/entry is always long-equivalent.
   * Optional for back-compat with reports persisted before pnlPct existed.
   */
  pnlPct?: number;
  /** Options only — call/put, strike, expiration, full OCC contract symbol. */
  optionType?: 'call' | 'put';
  strike?: number;
  expiration?: string;
  optionSymbol?: string;
}

export interface EodMover {
  symbol: string;
  price: number;
  changePct: number;
}

export interface EodSignalAccuracy {
  totalSignals: number;
  /** Signals that closed with profit (TP hit) */
  winningSignals: number;
  winRate: number;
  avgRR: number;
}

export interface EodReport {
  date: string;          // YYYY-MM-DD
  generatedAt: number;   // Unix ms

  // P&L
  /** Realized P&L from equity/crypto positions that *closed* on `date`. */
  realizedPnl: number;
  /** Open-position MTM at report time. Informational only — see `combinedPnl`. */
  unrealizedPnl: number;
  totalPnl: number;
  /**
   * TRA-594 — realized P&L from options that *closed* on `date`, NOT the
   * mode's all-time cumulative options total. The old code booked the
   * cumulative figure into every day, corrupting the whole calendar.
   */
  optionsPnl: number;
  /**
   * The Calendar tab's per-day figure: `realizedPnl + optionsPnl` — the day's
   * *realized* total. TRA-594: `unrealizedPnl` is deliberately excluded so a
   * position held open across days doesn't re-book its drifting mark into
   * every cell (which made monthly Net P&L multi-count). In live stock mode
   * this is overridden with the Tradier broker-truth daily balance delta
   * (TRA-359).
   */
  combinedPnl: number;
  /**
   * TRA-365 follow-up — realized / options / combined P&L expressed as a
   * fraction of session-open equity (managed account). Optional for back-compat
   * with reports persisted before the percent fields were added; readers that
   * encounter an older report on disk should treat absent values as null and
   * render `--` rather than 0.0% so they're distinguishable from a flat day.
   */
  realizedPnlPct?: number;
  optionsPnlPct?: number;
  combinedPnlPct?: number;

  // Account
  totalEquity: number;
  managedEquity: number;  // 50% allocation
  availableCash: number;

  // Trades
  trades: EodTradeEntry[];
  openPositionCount: number;

  // Performance
  winRate: number;         // % of closed trades that were winners
  avgRR: number;           // average risk-reward achieved
  totalTrades: number;
  winners: number;
  losers: number;
  /**
   * TRA-208: average per-trade R multiple across today's closed trades. R is
   * `(exitPrice − entryPrice) / |entry − stop|` signed by side, so >0 means
   * the average trade collected more than zero stop-distances of profit.
   * Mirrors `BacktestResult.expectancy` so live perf and backtest expectancy
   * are computed the same way. Industry rule of thumb: > 0.2R after costs is
   * the floor for a deployable system.
   */
  expectancy: number;
  /**
   * TRA-208: peak-to-trough drawdown of the cumulative-PnL equity curve
   * through today's closed trades, expressed as a fraction in [0,1] of the
   * peak. Computed against `realizedPnl` only — open positions don't move
   * this metric, matching `BacktestResult.maxDrawdown`'s realized-equity
   * intent for daily reporting.
   */
  maxDrawdown: number;
  /**
   * TRA-208: trade-R Sharpe = mean(R) / stdev(R). NOT annualized — the
   * sample is one trading session, so an annualization factor would be
   * misleading. Mirrors the `BacktestResult.sharpeRatio` per-trade fallback
   * path (the backtest annualizes from per-bar MTM when bars are available;
   * for live EOD we only have per-trade Rs).
   */
  sharpeRatio: number;

  // Market
  top5Movers: EodMover[];

  // Signal accuracy
  signalAccuracy: EodSignalAccuracy;

  /**
   * TRA-844 — portfolio-level Greeks + theta-$ bleed + allocation-by-name/sector
   * over the open options book at report time. Optional for back-compat with
   * reports persisted before the rollup landed (readers render "—" when absent).
   */
  portfolioGreeks?: PortfolioGreeks;

  /**
   * TRA-1192 — provenance of the calendar `combinedPnl` figure so the
   * historical backfill never clobbers a real snapshot and the UI/server can
   * tell an intraday live estimate from a settled EOD value:
   *   - `engine`           — engine-computed realized + options (demo, or live
   *                          before a broker-balance anchor exists);
   *   - `tradier-balance`  — broker-truth daily balance delta (TRA-359 live EOD);
   *   - `realized-backfill`— FIFO realized-options P&L reconstructed from broker
   *                          fills for a pre-snapshot historical day (TRA-244);
   *   - `live-intraday`    — today's running broker-balance delta computed on the
   *                          fly (not yet settled by the 9 PM EOD snapshot).
   * Optional for back-compat with reports persisted before the field existed.
   */
  pnlSource?: 'engine' | 'tradier-balance' | 'realized-backfill' | 'live-intraday';

  // Markdown report body
  markdown: string;
}

// ===========================================================================
// TRA-544 (TRA-529 P1) — Multi-agent analyst layer contracts
// ---------------------------------------------------------------------------
// Strict, schema-validated I/O for the advisory "Trading Agents" pipeline
// (analysts → bull/bear debate → trader synthesis → risk panel/manager →
// AgentRecommendation). Every agent returns bounded JSON so the graph is
// deterministic and auditable — no free-text-only handoffs (TRA-529 §3).
// These are the wire contracts only; the orchestration graph and the (P1
// stubbed) agents live in @trading-app/agents. Numeric conventions:
//   stance  ∈ [-1, +1]  (directional: −1 max-bearish … +1 max-bullish)
//   confidence / sizeMultiplier / conviction ∈ [0, 1]
// ===========================================================================

/** Directional verb a trader/recommendation can emit (TRA-529 §3.3). */
export type AgentAction = 'BUY' | 'SELL' | 'HOLD';

/**
 * The analyst tier. P1 (TRA-529 §3.1) shipped the first three; TRA-813 (P4) adds
 * `social_sentiment`, which consumes the per-symbol StockTwits aggregate.
 */
export type AnalystKind = 'technical' | 'fundamental' | 'news_sentiment' | 'social_sentiment';

/** Risk-manager verdict over a proposed TraderDecision (TRA-529 §3.4). */
export type RiskVerdictKind = 'APPROVE' | 'REVISE' | 'VETO';

/** Risk-panel persona (TRA-529 §3.4). */
export type RiskPersona = 'aggressive' | 'neutral' | 'conservative';

/** Side of a debate round (TRA-529 §3.2). */
export type DebateSide = 'bull' | 'bear';

/**
 * One analyst's structured read on a symbol (TRA-529 §3.1). The three analysts
 * all return this shape; `drivers` cite the specific evidence (indicator,
 * fundamental metric, or timestamped headline) that moved the stance so the
 * recommendation is auditable. Thin/stale evidence MUST yield low `confidence`
 * (we down-weight, never fabricate conviction).
 */
export interface AnalystReport {
  kind: AnalystKind;
  /** Directional read, −1 (max bearish) … +1 (max bullish). */
  stance: number;
  /** Earned confidence in `stance`, 0 … 1. */
  confidence: number;
  /** Intended holding horizon for the thesis, in days. */
  horizonDays: number;
  /** Key technical levels the analyst is watching. */
  keyLevels: { support: number; resistance: number };
  /** Human-readable evidence bullets that justify the stance. */
  drivers: string[];
  /** Free-text note (≤ a few sentences). */
  notes: string;
}

/** One bull-vs-bear exchange in the research debate (TRA-529 §3.2). */
export interface DebateRound {
  round: number;
  side: DebateSide;
  claims: string[];
  rebuttals: string[];
  strongestPoint: string;
  /** The arguer's confidence in its own side this round, 0 … 1. */
  confidence: number;
}

/**
 * The full N-round bull/bear debate plus the judged surviving thesis
 * (TRA-529 §3.2). Persisted for audit.
 */
export interface DebateTranscript {
  rounds: DebateRound[];
  /** The thesis that survived the debate, extracted by the judge. */
  survivingThesis: string;
  /** Net directional lean of the debate, −1 … +1 (bear … bull). */
  netLean: number;
}

/**
 * The trader's proposed trade synthesised from the analyst reports + debate
 * (TRA-529 §3.3). `dissent` is mandatory by design: it forces the trader to
 * name the strongest opposing point it chose to override — the single biggest
 * guard against LLM over-confidence.
 */
export interface TraderDecision {
  action: AgentAction;
  /** Conviction 0 … 1; drives the size suggestion, capped by the risk panel. */
  conviction: number;
  proposedEntry: number;
  proposedStop: number;
  proposedTarget: number;
  /** Must clear the engine minimum or the trader auto-HOLDs. */
  riskRewardRatio: number;
  /** 2–3 sentence rationale citing the drivers. */
  thesis: string;
  /** The strongest opposing point the trader chose to override (mandatory). */
  dissent: string;
}

/** One risk persona's view on the proposed trade (TRA-529 §3.4). */
export interface RiskPersonaView {
  persona: RiskPersona;
  /** This persona's preferred fraction of full size, 0 … 1. */
  sizeMultiplier: number;
  reasons: string[];
}

/**
 * The risk manager's final verdict over a TraderDecision, after arbitrating
 * the three persona views (TRA-529 §3.4). The verdict is then handed to the
 * deterministic RiskManager (engine/src/risk.ts), whose hard limits always win.
 */
export interface RiskVerdict {
  verdict: RiskVerdictKind;
  /** Final size fraction the manager allows, 0 … 1 (0 on VETO). */
  sizeMultiplier: number;
  panel: RiskPersonaView[];
  reasons: string[];
}

/**
 * The multi-agent layer's single externally-consumed object (TRA-529 §4).
 * In advisor mode it is logged + broadcast on the WS state and rendered on the
 * dashboard; in gating mode `proposedSignal` (if APPROVE) feeds the existing
 * router/risk path. Every recommendation carries its own cost + latency so the
 * §6 daily-$ budget can be enforced and reported (P1 stub: costUsd = 0).
 */
export interface AgentRecommendation {
  symbol: string;
  /** Decision-bar timestamp (epoch ms); analysts see only data at/before it. */
  asOf: number;
  action: AgentAction;
  conviction: number;
  sizeMultiplier: number;
  /** The trade to route on APPROVE; null on HOLD/VETO. */
  proposedSignal: TradeSignal | null;
  verdict: RiskVerdictKind;
  analystReports: AnalystReport[];
  debateTranscript: DebateTranscript;
  traderDecision: TraderDecision;
  riskVerdict: RiskVerdict;
  /** USD billed for this recommendation's LLM calls. 0 for the P1 stub. */
  costUsd: number;
  /** Wall-clock latency of the graph run, in ms. */
  latencyMs: number;
}

/**
 * TRA-544 — resolve the runtime "Trading Agents" master switch. Absent ↔ off,
 * so a settings snapshot written before TRA-544 (or a partial PUT) keeps the
 * deterministic stack in charge. {@link AccountSettings.tradingAgentsEnabled}.
 */
export function resolveTradingAgentsEnabled(s: AccountSettings): boolean {
  return s.tradingAgentsEnabled === true;
}

// ── TRA-941 (TRA-813 P2/3) — trade-proposal queue + execution wiring ─────────
//
// Pieces 2 + 3 of the board-approved TRA-813 plan. An APPROVE AgentRecommendation
// no longer routes straight to capital (the old TRA-796 demo-first auto-route):
// it becomes a *pending proposal* that an operator confirms (or that the demo
// auto-confirm rule clears), and ONLY a confirmed proposal reaches the broker.
// The threshold/cap numbers below are QuantTrader's ratified TRA-939 values.

/** Lifecycle of one queued trade proposal. */
export type ProposalStatus =
  | 'pending' // awaiting confirmation (manual, or demo auto-confirm)
  | 'approved' // confirmed; an order placement was attempted
  | 'executed' // confirmed AND the broker/paper book accepted the order
  | 'rejected' // operator rejected with a reason (audit trail)
  | 'expired'; // aged past the store TTL before anyone acted

/**
 * TRA-1140 — discriminates an equity-share proposal from a defined-risk options
 * proposal. Absent on a {@link TradeProposal} ↔ legacy `'equity'` (the only kind
 * before TRA-1140), so every persisted/in-flight proposal stays backward-compatible.
 */
export type ProposalKind = 'equity' | 'options';

/**
 * TRA-1140 — the options-specific payload carried by a `kind:'options'`
 * {@link TradeProposal}. Snapshots an accepted AI-idea's defined-risk structure
 * (legs + POP + reward/risk + capped max loss) plus the anchor contract fields
 * the paper-options open path needs, so an options proposal flows through the
 * SAME pending-queue + approve/reject + caps/kill-switch rail Proposals use.
 * Paper-only by construction (no live-capital path).
 */
export interface OptionProposalDetail {
  /** Source AI-idea feed id (idempotency key + traceability back to the feed). */
  ideaId: string;
  /** Underlying symbol (== TradeProposal.symbol). */
  ticker: string;
  /** Display strategy, e.g. "Bull Put Spread". */
  strategy: string;
  /** Full modeled structure (≥ 2 legs ⇒ defined-risk spread combo). */
  legs: OptionLeg[];
  /** Probability of profit on [0,1] (== OptionsIdeaView.pop). */
  pop: number;
  /** Reward/risk ratio (maxProfit ÷ maxLoss), snapshotted for the card. */
  riskReward: number;
  /** Capped capital at risk, USD per 1-lot. */
  maxLossUsd: number;
  /** Capped max profit, USD per 1-lot. */
  maxProfitUsd: number;
  /** Net premium at entry, + credit / − debit, USD per 1-lot. */
  netUsd: number;
  /** Payoff breakeven underlying price(s). */
  breakevens: number[];
  /** Anchor (scanner-surfaced) contract — drives the single-leg long open path. */
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  /** Per-share mark used as the single-leg entry premium. */
  mark: number;
  /** Sign-adjusted Black-Scholes delta from the scanner. */
  delta: number;
  /** Underlying spot at build time. */
  spot: number;
}

/**
 * A pending trade proposal derived from an APPROVE {@link AgentRecommendation}
 * with a routable `proposedSignal`. This is the unit the desktop pending-
 * proposals panel (TRA-940) renders and the operator confirms/rejects. `size`
 * (share count) and `notional` (size × reference price, USD) are snapshotted at
 * creation from the engine's risk sizing so the auto-confirm + daily-cap gates
 * have a stable number to test against.
 */
export interface TradeProposal {
  id: string;
  /** Stable id of the source recommendation's proposedSignal (`agent-<sym>-<asOf>`). */
  recommendationId: string;
  symbol: string;
  side: Side;
  /** Planned share quantity at creation time. */
  size: number;
  /** size × reference price in USD at creation time. */
  notional: number;
  mode: AccountMode;
  /** Source recommendation conviction on [0,1] (== AgentRecommendation.conviction). */
  conviction: number;
  verdict: RiskVerdictKind;
  /** Short analyst note surfaced on the proposal card. */
  note?: string;
  createdAt: number;
  status: ProposalStatus;
  /** Operator's required reason when status === 'rejected' (TRA-940 §6). */
  rejectionReason?: string;
  /** When the proposal left `pending` (approved/rejected/executed/expired). */
  resolvedAt?: number;
  /**
   * TRA-1140 — proposal variant. Absent ↔ legacy `'equity'` share proposal (the
   * only kind before TRA-1140). `'options'` carries {@link option} with the
   * defined-risk structure and routes through the paper-options open path on
   * confirm. For an options proposal the base fields are snapshotted as:
   * `symbol`=underlying ticker, `side`='buy', `size`=1 (lot), `notional`=capped
   * single-lot max loss (the capital-at-risk number the daily caps test against),
   * `conviction`=POP, `mode`='demo' (paper-only).
   */
  kind?: ProposalKind;
  /** Present iff `kind === 'options'` — the defined-risk options payload. */
  option?: OptionProposalDetail;
}

/**
 * Immutable audit record for one agent-placed order (TRA-941 Piece 3). Emitted
 * the moment a confirmed proposal's order is accepted, so every real-money (and
 * paper) agent order is traceable back to its recommendation + proposal.
 */
export interface AgentOrderAudit {
  agentId: string;
  recommendationId: string;
  proposalId: string;
  symbol: string;
  side: Side;
  size: number;
  notional: number;
  mode: AccountMode;
  /** Broker order id when live (Tradier/Coinbase); null for paper opens. */
  orderId?: string | number | null;
  timestamp: number;
}

// ── Ratified TRA-939 thresholds & caps (final v1 values) ─────────────────────

/** Auto-confirm gate: minimum conviction (inclusive). */
export const AUTO_CONFIRM_MIN_CONVICTION = 0.70;
/** Auto-confirm gate: maximum per-order notional, USD (inclusive). */
export const AUTO_CONFIRM_MAX_NOTIONAL_USD = 250;
/** Daily execution cap — max LIVE agent orders per user per ET day. */
export const LIVE_MAX_ORDERS_PER_DAY = 5;
/** Daily execution cap — max LIVE agent notional per user per ET day, USD. */
export const LIVE_MAX_NOTIONAL_PER_DAY_USD = 1_000;
/** Per-order LIVE notional ceiling, USD (TRA-939 §B, NEW). */
export const LIVE_MAX_NOTIONAL_PER_ORDER_USD = 250;
/** Demo runaway ops-guard: soft cap on demo agent orders per user per ET day. */
export const DEMO_RUNAWAY_SOFT_CAP_PER_DAY = 50;

// ── TRA-1142 options auto-confirm gates (demo/paper only) ────────────────────
// Options proposals ride the SAME pending-queue + kill-switch + per-mode toggle
// + daily-cap rail equity proposals use, but the conviction/notional gates are
// replaced by options-appropriate ones: defined-risk only, a probability-of-
// profit floor, and a single-lot max-loss cap. Live options auto-confirm stays a
// hard NO (same invariant as live equity proposals — enforced first in the fn).

/** Options auto-confirm gate: minimum probability-of-profit (inclusive). */
export const AUTO_CONFIRM_OPTIONS_MIN_POP = 0.55;
/** Options auto-confirm gate: maximum single-lot max loss, USD (inclusive). */
export const AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD = 250;

/**
 * TRA-1142 — options-specific auto-confirm criteria, present iff the proposal is
 * a `kind:'options'` proposal. Carries the POP + single-lot max-loss the gate
 * tests against and whether the structure is defined-risk (bounded max loss).
 */
export interface AutoConfirmOptionInput {
  /** Probability of profit on [0,1] (== OptionProposalDetail.pop). */
  pop: number;
  /** Capped single-lot max loss in USD (the capital-at-risk number). */
  maxLossUsd: number;
  /** True iff the structure has a bounded (defined) max loss — naked/undefined ⇒ false. */
  definedRisk: boolean;
}

/** Inputs to the pure auto-confirm decision (all runtime state passed in). */
export interface AutoConfirmInput {
  mode: AccountMode;
  /** AgentRecommendation.conviction on [0,1]. */
  conviction: number;
  /** Snapshotted proposal notional in USD. */
  notional: number;
  /** Per-mode auto-trade toggle is ON (setAutoTrading for that mode). */
  autoTradeEnabled: boolean;
  /** Kill switch is CLEAR: banner toggle not disabled AND env kill not set. */
  killSwitchClear: boolean;
  /**
   * TRA-1142 — present iff this is an OPTIONS proposal. When set, the
   * options-appropriate gates (defined-risk only, POP floor, single-lot
   * max-loss cap) REPLACE the equity conviction/notional gates. Absent ⇒ legacy
   * equity proposal. Live still returns NO before this is ever read.
   */
  option?: AutoConfirmOptionInput;
}

export interface AutoConfirmDecision {
  autoConfirm: boolean;
  /** Human-readable reason the proposal did / did not auto-confirm. */
  reason: string;
}

/**
 * TRA-939 Section A — decide whether a proposal auto-confirms. Pure + total so
 * the threshold boundaries are unit-testable in isolation.
 *
 * EQUITY proposals auto-confirm ONLY when ALL hold: demo mode (live NEVER
 * auto-confirms in v1), conviction >= 0.70, notional <= $250, the per-mode
 * auto-trade toggle is ON, and the kill switch is clear.
 *
 * TRA-1142 — OPTIONS proposals (`input.option` present) share the demo/live,
 * kill-switch and per-mode-toggle gates, but swap the equity conviction/notional
 * gates for options-appropriate ones: defined-risk only, POP >= 0.55, and a
 * single-lot max-loss <= $250. Live options auto-confirm is a hard NO (the live
 * branch returns first, before `option` is read).
 *
 * Otherwise the proposal stays pending for manual confirmation (never silently
 * dropped).
 */
export function shouldAutoConfirm(input: AutoConfirmInput): AutoConfirmDecision {
  if (input.mode === 'live') {
    return { autoConfirm: false, reason: 'live never auto-confirms in v1 (manual board-confirm only)' };
  }
  if (!input.killSwitchClear) {
    return { autoConfirm: false, reason: 'kill switch engaged — execution gated to zero' };
  }
  if (!input.autoTradeEnabled) {
    return { autoConfirm: false, reason: 'per-mode auto-trade toggle is OFF' };
  }
  // TRA-1142 — options proposals: defined-risk only, POP floor, single-lot
  // max-loss cap. Demo/paper only (live already returned above).
  if (input.option) {
    const { pop, maxLossUsd, definedRisk } = input.option;
    if (!definedRisk) {
      return { autoConfirm: false, reason: 'undefined-risk options structure — manual approval only' };
    }
    if (!(maxLossUsd > 0)) {
      return { autoConfirm: false, reason: 'options max-loss not priced (<= $0) — queued for manual approval' };
    }
    if (!(pop >= AUTO_CONFIRM_OPTIONS_MIN_POP)) {
      return {
        autoConfirm: false,
        reason: `POP ${pop.toFixed(2)} < ${AUTO_CONFIRM_OPTIONS_MIN_POP} — queued for manual approval`,
      };
    }
    if (!(maxLossUsd <= AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD)) {
      return {
        autoConfirm: false,
        reason: `max loss $${maxLossUsd.toFixed(2)} > $${AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD} — queued for manual approval`,
      };
    }
    return { autoConfirm: true, reason: 'auto-confirmed: demo options, defined-risk, POP & max-loss within gate' };
  }
  if (!(input.conviction >= AUTO_CONFIRM_MIN_CONVICTION)) {
    return {
      autoConfirm: false,
      reason: `conviction ${input.conviction.toFixed(2)} < ${AUTO_CONFIRM_MIN_CONVICTION} — queued for manual approval`,
    };
  }
  if (!(input.notional <= AUTO_CONFIRM_MAX_NOTIONAL_USD)) {
    return {
      autoConfirm: false,
      reason: `notional $${input.notional.toFixed(2)} > $${AUTO_CONFIRM_MAX_NOTIONAL_USD} — queued for manual approval`,
    };
  }
  return { autoConfirm: true, reason: 'auto-confirmed: demo, conviction & notional within ratified gate' };
}

// --- Runtime schema validators (TRA-529 §3: "schema-validated, retried on
// malformed output"). Hand-written guards — the repo carries no zod. Each
// returns the field-paths that failed so the LLM-client retry loop can feed a
// precise "your JSON was wrong here" message back to the model. An empty array
// means valid. Bounds are enforced, not coerced: an out-of-range stance is a
// validation failure, not silently clamped, so a misbehaving model is retried
// rather than trusted. ---

function inRange(v: unknown, lo: number, hi: number): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(x => typeof x === 'string');
}

export function validateAnalystReport(value: unknown): string[] {
  const errors: string[] = [];
  const r = value as Partial<AnalystReport> | null | undefined;
  if (r == null || typeof r !== 'object') return ['report: not an object'];
  if (
    r.kind !== 'technical'
    && r.kind !== 'fundamental'
    && r.kind !== 'news_sentiment'
    && r.kind !== 'social_sentiment'
  ) {
    errors.push('kind: must be technical|fundamental|news_sentiment|social_sentiment');
  }
  if (!inRange(r.stance, -1, 1)) errors.push('stance: must be a number in [-1, 1]');
  if (!inRange(r.confidence, 0, 1)) errors.push('confidence: must be a number in [0, 1]');
  if (typeof r.horizonDays !== 'number' || !Number.isFinite(r.horizonDays) || r.horizonDays < 0) {
    errors.push('horizonDays: must be a non-negative number');
  }
  if (
    r.keyLevels == null
    || typeof r.keyLevels !== 'object'
    || typeof r.keyLevels.support !== 'number'
    || typeof r.keyLevels.resistance !== 'number'
  ) {
    errors.push('keyLevels: must be { support:number, resistance:number }');
  }
  if (!isStringArray(r.drivers)) errors.push('drivers: must be string[]');
  if (typeof r.notes !== 'string') errors.push('notes: must be a string');
  return errors;
}

export function validateTraderDecision(value: unknown): string[] {
  const errors: string[] = [];
  const d = value as Partial<TraderDecision> | null | undefined;
  if (d == null || typeof d !== 'object') return ['decision: not an object'];
  if (d.action !== 'BUY' && d.action !== 'SELL' && d.action !== 'HOLD') {
    errors.push('action: must be BUY|SELL|HOLD');
  }
  if (!inRange(d.conviction, 0, 1)) errors.push('conviction: must be a number in [0, 1]');
  for (const f of ['proposedEntry', 'proposedStop', 'proposedTarget', 'riskRewardRatio'] as const) {
    if (typeof d[f] !== 'number' || !Number.isFinite(d[f])) errors.push(`${f}: must be a finite number`);
  }
  if (typeof d.thesis !== 'string') errors.push('thesis: must be a string');
  if (typeof d.dissent !== 'string' || d.dissent.trim() === '') {
    errors.push('dissent: must be a non-empty string (mandatory opposing point)');
  }
  return errors;
}

export function validateRiskVerdict(value: unknown): string[] {
  const errors: string[] = [];
  const v = value as Partial<RiskVerdict> | null | undefined;
  if (v == null || typeof v !== 'object') return ['verdict: not an object'];
  if (v.verdict !== 'APPROVE' && v.verdict !== 'REVISE' && v.verdict !== 'VETO') {
    errors.push('verdict: must be APPROVE|REVISE|VETO');
  }
  if (!inRange(v.sizeMultiplier, 0, 1)) errors.push('sizeMultiplier: must be a number in [0, 1]');
  if (!Array.isArray(v.panel)) {
    errors.push('panel: must be an array of RiskPersonaView');
  } else {
    v.panel.forEach((p, i) => {
      if (p == null || typeof p !== 'object') { errors.push(`panel[${i}]: not an object`); return; }
      if (p.persona !== 'aggressive' && p.persona !== 'neutral' && p.persona !== 'conservative') {
        errors.push(`panel[${i}].persona: must be aggressive|neutral|conservative`);
      }
      if (!inRange(p.sizeMultiplier, 0, 1)) errors.push(`panel[${i}].sizeMultiplier: must be a number in [0, 1]`);
      if (!isStringArray(p.reasons)) errors.push(`panel[${i}].reasons: must be string[]`);
    });
  }
  if (!isStringArray(v.reasons)) errors.push('reasons: must be string[]');
  return errors;
}

// --- TRA-1043 — Anthropic structured-outputs schemas. These mirror the
// hand-written validators above so an agent payload comes back schema-valid on
// the FIRST shot (the model is constrained to the schema by `output_config.format`),
// removing the JSON-extract-and-retry round-trips on the happy path. The
// validators stay the source of truth and the defence-in-depth fallback:
// structured outputs guarantee SHAPE (the required keys, their types, no extras),
// but NOT value bounds — e.g. `stance ∈ [-1,1]`, a non-empty `dissent`, or the
// per-call analyst `kind` pin are still enforced by the validator + `completeJson`
// retry. The structured-outputs JSON-schema dialect is restrictive: every object
// MUST set `additionalProperties:false` and list every property in `required`,
// and numeric/length bounds (`minimum`/`maxLength`/…) are unsupported — so the
// bounds live only in the validators, by design. ---

/** A JSON Schema object passed to Anthropic `output_config.format`. */
export type JsonSchema = Record<string, unknown>;

/**
 * Structured-output schema for {@link AnalystReport}, matching
 * {@link validateAnalystReport}. `kind` is the full enum here; the per-call
 * "must be exactly this kind" pin is applied by the caller (it narrows `kind`
 * to a `const`) and, failing that, by the validator.
 */
export const ANALYST_REPORT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'stance', 'confidence', 'horizonDays', 'keyLevels', 'drivers', 'notes'],
  properties: {
    kind: { type: 'string', enum: ['technical', 'fundamental', 'news_sentiment', 'social_sentiment'] },
    stance: { type: 'number' },
    confidence: { type: 'number' },
    horizonDays: { type: 'number' },
    keyLevels: {
      type: 'object',
      additionalProperties: false,
      required: ['support', 'resistance'],
      properties: {
        support: { type: 'number' },
        resistance: { type: 'number' },
      },
    },
    drivers: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

/**
 * Structured-output schema for {@link TraderDecision}, matching
 * {@link validateTraderDecision}. The mandatory non-empty `dissent` and the
 * numeric bounds on `conviction` remain validator-enforced (the schema dialect
 * can't express "non-empty string" or "[0,1]").
 */
export const TRADER_DECISION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'action',
    'conviction',
    'proposedEntry',
    'proposedStop',
    'proposedTarget',
    'riskRewardRatio',
    'thesis',
    'dissent',
  ],
  properties: {
    action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
    conviction: { type: 'number' },
    proposedEntry: { type: 'number' },
    proposedStop: { type: 'number' },
    proposedTarget: { type: 'number' },
    riskRewardRatio: { type: 'number' },
    thesis: { type: 'string' },
    dissent: { type: 'string' },
  },
};

/**
 * Structured-output schema for {@link RiskVerdict}, matching
 * {@link validateRiskVerdict}, including the nested {@link RiskPersonaView} panel.
 */
export const RISK_VERDICT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'sizeMultiplier', 'panel', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REVISE', 'VETO'] },
    sizeMultiplier: { type: 'number' },
    panel: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['persona', 'sizeMultiplier', 'reasons'],
        properties: {
          persona: { type: 'string', enum: ['aggressive', 'neutral', 'conservative'] },
          sizeMultiplier: { type: 'number' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    reasons: { type: 'array', items: { type: 'string' } },
  },
};

export function validateAgentRecommendation(value: unknown): string[] {
  const errors: string[] = [];
  const r = value as Partial<AgentRecommendation> | null | undefined;
  if (r == null || typeof r !== 'object') return ['recommendation: not an object'];
  if (typeof r.symbol !== 'string' || r.symbol === '') errors.push('symbol: must be a non-empty string');
  if (typeof r.asOf !== 'number' || !Number.isFinite(r.asOf)) errors.push('asOf: must be an epoch-ms number');
  if (r.action !== 'BUY' && r.action !== 'SELL' && r.action !== 'HOLD') errors.push('action: must be BUY|SELL|HOLD');
  if (!inRange(r.conviction, 0, 1)) errors.push('conviction: must be a number in [0, 1]');
  if (!inRange(r.sizeMultiplier, 0, 1)) errors.push('sizeMultiplier: must be a number in [0, 1]');
  if (r.verdict !== 'APPROVE' && r.verdict !== 'REVISE' && r.verdict !== 'VETO') errors.push('verdict: must be APPROVE|REVISE|VETO');
  // APPROVE must carry a routable signal; HOLD/VETO must not (TRA-529 §4).
  if (r.verdict === 'APPROVE' && r.action !== 'HOLD') {
    if (r.proposedSignal == null) errors.push('proposedSignal: must be present on APPROVE');
  } else if (r.proposedSignal != null) {
    errors.push('proposedSignal: must be null on HOLD/VETO');
  }
  if (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd) || r.costUsd < 0) {
    errors.push('costUsd: must be a non-negative number');
  }
  if (typeof r.latencyMs !== 'number' || !Number.isFinite(r.latencyMs) || r.latencyMs < 0) {
    errors.push('latencyMs: must be a non-negative number');
  }
  return errors;
}
