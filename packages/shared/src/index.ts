// Shared types and utilities across all packages

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
  | 'otm_mispricing'
  | 'relative_value' // TRA-191: options chain relative-value scanner (IV skew + monotonic + no-arb)
  | 'sma200_pullback' // TRA-451: pullback-to-200 bounce (continuation long), daily bars
  | 'sma200_reclaim'  // TRA-451: 200-SMA reclaim reversal (trend-change swing), daily bars
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

/**
 * Why a closed position exited. Surfaced in `Position.exitReason` so backtest
 * trade logs can break PnL down by lifecycle path:
 *   - `stop`         hard stop hit at `stopLoss`
 *   - `target`       initial take-profit hit at `takeProfit`
 *   - `time_stop`    per-strategy bar-count cap reached without stop/target
 *   - `trailing`     trailing-stop ratchet exited (incl. break-even after +Nx ATR)
 *   - `rsi_alt_exit` mean-reversion alternate exit (RSI re-crossed 50 from
 *                    the entry-side extreme, beating the BB-middle target)
 */
export type ExitReason =
  | 'stop'
  | 'target'
  | 'time_stop'
  | 'trailing'
  | 'rsi_alt_exit';

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
}

/**
 * TRA-338 — provenance label for the entry price written onto a Position.
 * Mirrors the providers in `crypto-feed.ts`'s cascade plus a `'manual'` slot
 * for human-driven opens (admin tooling, reconciliation imports) and an
 * `'unknown'` back-fill for pre-TRA-338 snapshots.
 */
export type PositionQuoteSource = 'coinbase' | 'yahoo' | 'cmc' | 'manual' | 'unknown';

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

/** Canonical preset identifiers — the literal union doubles as runtime validation. */
export type StrategyPresetId = 'legacy_5' | 'bb_fade_sol_doge' | 'tra405_validated' | 'no_trade';

/** Crypto-strategy SignalTypes routable by the engine. Subset of {@link SignalType}. */
export type CryptoStrategyType =
  | 'bb_fade'
  | 'swing_trade'
  | 'momentum'
  | 'mean_reversion'
  | 'breakout_vol';

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
 * Read-only preset library:
 *   • `legacy_5`         — pre-TRA-325 status quo: all 5 crypto strategies on
 *                          all 51 long symbols, perp shorts on PERP_SHORTS_UNIVERSE.
 *   • `bb_fade_sol_doge` — bb_fade only, scoped to SOL-USD + DOGE-USD. This
 *                          captures the live test config that shipped via
 *                          TRA-324's env-var hardcoding.
 *   • `tra405_validated` — TRA-421: the TRA-405 §8 out-of-sample go/no-go
 *                          roster. bb_fade only, gated to {BTC-USD, SOL-USD}
 *                          via {@link StrategyPreset.strategyUniverse}.
 *                          Superseded by `no_trade` as the live pin — see
 *                          TRA-434 below — but kept in the library for the
 *                          Settings UI and as the revert target once a
 *                          strategy clears the lower-CI-bound gate.
 *   • `no_trade`         — TRA-434 risk stand-down preset: zero enabled
 *                          strategies and an empty symbol whitelist, so every
 *                          per-tick `strategyEnabled()` / `symbolAllowed()`
 *                          check returns false and the engine opens NO new
 *                          entries. Exit/position-management logic is not
 *                          gated by the preset, so positions already open
 *                          continue to close on their own stop/target rules.
 *                          Used by the `LIVE_STRATEGY_PRESET` env var to pause
 *                          the live crypto pilot after the TRA-432 NO-GO,
 *                          which superseded TRA-405's dirty-cache "go".
 *                          TRA-456: `LIVE_STRATEGY_PRESET` is scoped to the
 *                          LIVE engine only — the demo engine ignores it and
 *                          runs `DEMO_STRATEGY_PRESET` (default
 *                          `tra405_validated`), so this stand-down freezes
 *                          live-capital trading without blanking the
 *                          paper-money demo dashboard.
 *
 * Future presets are added here without code changes elsewhere — the engine
 * resolves by id, the UI lists `Object.values(STRATEGY_PRESETS)`.
 */
export const STRATEGY_PRESETS: Readonly<Record<StrategyPresetId, StrategyPreset>> = {
  legacy_5: {
    id: 'legacy_5',
    displayName: 'Legacy 5-strategy roster',
    description:
      'All five crypto strategies (bb_fade, mean_reversion, momentum, breakout_vol, swing_trade) firing across the full 51-symbol watchlist. Perp shorts respect PERP_SHORTS_UNIVERSE.',
    enabledStrategies: ['bb_fade', 'swing_trade', 'momentum', 'mean_reversion', 'breakout_vol'] as const,
    symbolFilter: null,
  },
  bb_fade_sol_doge: {
    id: 'bb_fade_sol_doge',
    displayName: 'bb_fade only — SOL + DOGE',
    description:
      'bb_fade scoped to SOL-USD and DOGE-USD. Captures the TRA-324 live-test config: only bb_fade fires, only on the two symbols.',
    enabledStrategies: ['bb_fade'] as const,
    symbolFilter: ['SOL-USD', 'DOGE-USD'] as const,
  },
  // TRA-421 — the TRA-405 §8 out-of-sample go/no-go roster.
  //
  // TRA-405 re-ran the strategy roster on 3.05 years of real Coinbase 4H bars
  // (IS vs OOS split, tiered cost model, block-bootstrap confidence). Of five
  // strategies × six symbols, exactly two cells survived costs out-of-sample:
  // `macd_bollinger` on BTC-USD and on SOL-USD. `momentum` and `breakout_vol`
  // were OOS-negative on every symbol tested; `mean_reversion` was inert.
  //
  // Strategy-name mapping: TRA-405's backtest `macd_bollinger` strategy runs
  // the engine's macd-trend + bb-fade strategies together, and the report
  // (§4.1) attributes its entire OOS edge to "the bb_fade pattern". macd-trend
  // was dropped from the live engine in TRA-313, so the live carrier of the
  // validated macd_bollinger edge is `bb_fade`. This preset therefore enables
  // `bb_fade` only and gates it — via `strategyUniverse` — to {BTC-USD,
  // SOL-USD}. momentum / breakout_vol are simply not in `enabledStrategies`,
  // which is how a strategy is disabled on the generic universe.
  //
  // TRA-432/TRA-434 NOTE: this preset is no longer the live pin. QuantTrader's
  // clean-cache OOS re-validation (TRA-432) found bb_fade fails the
  // CTO-adopted lower-CI-bound robustness gate, so `LIVE_STRATEGY_PRESET` is
  // pinned to `no_trade`. The preset stays in the library for the Settings UI
  // and as the revert target once a strategy clears the gate.
  tra405_validated: {
    id: 'tra405_validated',
    displayName: 'TRA-405 validated — macd_bollinger (bb_fade) on BTC + SOL',
    description:
      'TRA-405 §8 out-of-sample go/no-go roster: only the macd_bollinger / bb_fade mean-reversion edge survives costs, and only on BTC-USD and SOL-USD. momentum and breakout_vol are OOS-negative on every symbol tested and are disabled. Superseded as the live pin by no_trade after the TRA-432 clean-cache re-validation NO-GO.',
    enabledStrategies: ['bb_fade'] as const,
    symbolFilter: null,
    strategyUniverse: { bb_fade: ['BTC-USD', 'SOL-USD'] as const },
  },
  no_trade: {
    id: 'no_trade',
    displayName: 'No-trade — engine paused',
    description:
      'Risk stand-down (TRA-434): no strategies enabled and an empty symbol whitelist, so the engine opens no new entries on any symbol. Open positions still close on their existing exit logic. Used to pause the live crypto pilot after the TRA-432 NO-GO verdict.',
    enabledStrategies: [] as const,
    symbolFilter: [] as const,
  },
};

export const DEFAULT_STRATEGY_PRESET_ID: StrategyPresetId = 'legacy_5';

/**
 * Resolve a preset id (possibly undefined or invalid from a stored settings
 * snapshot) to its definition. Falls back to `legacy_5` so a settings file
 * predating TRA-325 keeps the byte-identical pre-325 behaviour.
 *
 * Also accepts the legacy env-var value `'bb_fade_sol_doge_only'` from
 * TRA-324's `LIVE_STRATEGY_PRESET` for back-compat — the urgent-ticket
 * deployment shipped that value in render.yaml and should keep resolving
 * even if a render.yaml update lands after this commit.
 */
export function resolveStrategyPreset(id: string | undefined | null): StrategyPreset {
  if (!id) return STRATEGY_PRESETS[DEFAULT_STRATEGY_PRESET_ID];
  if (id === 'bb_fade_sol_doge_only') return STRATEGY_PRESETS.bb_fade_sol_doge;
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
   * (`'legacy_5'`), the pre-325 5-strategy roster.
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
  cryptoAutoTradingEnabledLive: true,
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
  liveBrokerageTypeStocks: 'webull',
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
  return scoped ?? s.riskPerTrade;
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
//   • OPTIONS_PER_TICKET_DOLLAR_FLOOR (TRA-495) — minimum per-ticket budget
//     in dollars. Bumps the pct-budget up to $100 when the percent math
//     rounds to less than $100 (e.g. $550 * 0.5 * 0.10 = $27.50), so a
//     $0.40-mark RV candidate can size to ≥1 contract on a $550 live book.
//     Also raises the per-position cap floor (`max($100, 15% × equity)`)
//     so the same $100 ticket budget can clear the cap on a sub-$667 book.
//   • OPTIONS_PER_POSITION_PCT_CAP — alias for OPTIONS_POSITION_CAP_RATIO
//     spelled out for callers that prefer the "PCT_CAP" form.
//   • OPTIONS_OTM_MIN_EQUITY — live-equity floor below which the OTM
//     mispricing scanner is skipped (RV-only). OTM is a tail strategy
//     (~40% win rate) that needs many tickets for the right tail to pay
//     off — wrong for a small book.
export const OPTIONS_POSITION_CAP_RATIO = 0.15; // cap a single options position at 15% of equity
export const OPTIONS_PER_POSITION_PCT_CAP = OPTIONS_POSITION_CAP_RATIO;
export const OPTIONS_PER_TICKET_DOLLAR_FLOOR = 100; // $100 per-ticket floor while equity is small
export const OPTIONS_OTM_MIN_EQUITY = 5_000;    // skip the OTM scanner below this live equity

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
}

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

export const CRYPTO_WATCHLIST: readonly string[] = [
  'BTC-USD',   'ETH-USD',   'BNB-USD',   'SOL-USD',   'ADA-USD',
  // TRA-445 — MATIC rebranded to POL (Polygon token migration, Sept 2024).
  // The old MATIC-USD product is delisted on Coinbase (Exchange 400 /
  // Advanced Trade 404); the watchlist tracks POL-USD now. Legacy positions
  // still keyed by MATIC-USD are aliased through `aliasCryptoSymbol` so
  // quotes still resolve. Mirrors the TRA-344 RNDR→RENDER pattern below.
  'DOT-USD',   'AVAX-USD',  'LINK-USD',  'POL-USD',   'XRP-USD',
  'LTC-USD',   'BCH-USD',   'ATOM-USD',  'DOGE-USD',  'SHIB-USD',
  // TRA-445 — FTM rebranded to Sonic (S) (FTM→S token migration completed
  // 2025). Coinbase delisted FTM-USD and lists S-USD; same alias treatment
  // as MATIC→POL above.
  'NEAR-USD',  'S-USD',     'SAND-USD',  'MANA-USD',  'AXS-USD',
  'UNI-USD',   'AAVE-USD',  'MKR-USD',   'CRV-USD',   'ALGO-USD',
  // TRA-445 — TRX-USD and THETA-USD are NOT delisted: Coinbase simply never
  // listed them, so the Coinbase Exchange / Advanced Trade paths 404 and the
  // engine's Coinbase-strict entry gate (TRA-338) will never open a position
  // in them. They are kept because they are valid, actively-traded assets
  // that Yahoo Finance still serves — the cascade falls through to Yahoo for
  // quotes and daily/minute candles (no 4H Yahoo fallback). Removing them
  // would drop a real asset, not a dead ticker.
  'XLM-USD',   'ETC-USD',   'TRX-USD',   'FIL-USD',   'VET-USD',
  'THETA-USD', 'HBAR-USD',  'ICP-USD',   'FLOW-USD',  'GRT-USD',
  'ARB-USD',   'OP-USD',    'APT-USD',   'SUI-USD',   'INJ-USD',
  // TRA-344 — RNDR rebranded to RENDER on Coinbase (2024-04-23). The old
  // RNDR-USD product is delisted; Yahoo/CMC also dropped the legacy ticker,
  // so the watchlist tracks RENDER-USD now. Legacy positions still keyed by
  // RNDR-USD are aliased through `aliasCryptoSymbol` so quotes still resolve.
  // SNX-USD (Synthetix) is retained — TRA-443 flagged a stale feed, but
  // Coinbase still lists SNX-USD live (Exchange + Advanced Trade 200), so the
  // stale read was transient, not a delisting.
  'RUNE-USD',  'RENDER-USD','IMX-USD',   'EGLD-USD',  'LDO-USD',
  'SNX-USD',   'APE-USD',   'COMP-USD',  'CHZ-USD',   'ZEC-USD',
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
   * that silently falls back to `legacy_5` is directly visible to operators.
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
    | 'OTM'
    | 'RV'           // TRA-191 — relative-value scanner
    | 'Tradier'      // TRA-323 — imported from Tradier (never actually written to disk: imports don't trade through the EOD exporter)
    | 'Options'      // TRA-365 follow-up — option closes that arrived without a more specific signal mapping
    | 'SMA-200';     // TRA-451 — SMA-200 pullback/reclaim signals (display-only; never opens a position, so never reaches the EOD exporter)
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
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  optionsPnl: number;
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

  // Markdown report body
  markdown: string;
}
