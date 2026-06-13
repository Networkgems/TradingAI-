import { Candle, ExitReason, Position, TradeSignal, MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';
import {
  CorrelationMatrix,
  admitUnderClusterCap,
  resolveCorrelationCapConfig,
  effectiveRiskPct,
  resolveVolKellySizerConfig,
  trailingRealisedVol,
  OrbStrategy,
  ReversalStrategy,
  MacdTrendStrategy,
  BbFadeStrategy,
  MomentumStrategy,
  BreakoutVolStrategy,
  MeanReversionCryptoStrategy,
  TsmomMajorsStrategy,
  resolveTsmomMajorsParams,
  tsmomExitToFlat,
  TSMOM_BARS_PER_YEAR,
  IchimokuStrategy,
  ScalpingStrategy,
  SwingStrategy,
  RegimeDetector,
  RiskManager,
  PositionManager,
  initLifecycleState,
  advanceExtreme,
  momentumTrailStop,
  breakoutTrailStop,
  meanReversionRsiAltExitTriggered,
  timeStopBarsFor,
  momentumTrailPeriodFor,
  breakoutTrailOptionsFor,
} from '@trading-app/engine';
import { BacktestConfig, BacktestResult, PortfolioOpts, SignalEdge } from './types.js';

const DEFAULT_MAX_OPEN = 3;
const DEFAULT_MAX_SECTOR = 3;
const DEFAULT_LOOKAHEAD_BARS = 24;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1_000;

/**
 * TRA-211: spec §3 mean-reversion sizes at 0.75% of equity, smaller than the
 * 1% default that momentum / breakout share. Falls back to the global default
 * if `meanReversionRiskPct` is not provided on the config.
 */
const DEFAULT_MEAN_REVERSION_RISK_PCT = 0.0075;

/**
 * TRA-203: normalize the {@link BacktestConfig.feeBps} field into per-fill
 * maker/taker rates. Returns `null` when `feeBps` isn't set so the runner can
 * fall through to the legacy `commissionBps` path. A scalar applies to both
 * sides — `executionMode` is the only thing that splits maker vs. taker.
 */
function resolveFeeRates(
  config: BacktestConfig,
): { maker: number; taker: number } | null {
  if (config.feeBps === undefined) return null;
  if (typeof config.feeBps === 'number') {
    const r = config.feeBps / 10_000;
    return { maker: r, taker: r };
  }
  return {
    maker: config.feeBps.maker / 10_000,
    taker: config.feeBps.taker / 10_000,
  };
}

/**
 * TRA-203: estimate the candle bar interval (ms) by taking the modal gap
 * between consecutive timestamps. Modal — not mean — because daylight-saving
 * jumps and weekend halts in equity series would skew an average. Returns
 * `null` for fewer than two candles.
 */
function inferBarIntervalMs(candles: ReadonlyArray<Candle>): number | null {
  if (candles.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i].timestamp - candles[i - 1].timestamp;
    if (dt > 0) counts.set(dt, (counts.get(dt) ?? 0) + 1);
  }
  let bestDt = 0;
  let bestCount = 0;
  for (const [dt, c] of counts) {
    if (c > bestCount) { bestCount = c; bestDt = dt; }
  }
  return bestDt > 0 ? bestDt : null;
}

/**
 * TRA-203: per-trade R multiple, signed by side. R = 1 means the trade
 * collected one stop-distance of profit; R = -1 means it lost the stop.
 */
function tradeR(
  side: 'buy' | 'sell',
  entryPrice: number,
  exitPrice: number,
  stopLoss: number,
): number {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) return 0;
  const dir = side === 'buy' ? 1 : -1;
  return ((exitPrice - entryPrice) * dir) / stopDistance;
}

/**
 * Default sector resolver — `*-USD` tickers fall into the `crypto` bucket so
 * five highly correlated coins can't all open simultaneously and call
 * themselves "diversified". Everything else is treated as `equity`.
 */
export function defaultSectorOf(symbol: string): string {
  return /-USD$/i.test(symbol) ? 'crypto' : 'equity';
}

/**
 * Runs the portfolio-cap admission check for a candidate signal.
 *
 * Returns the reason for rejection if the cap would be breached, or `null`
 * when the trade is allowed. Exposed for unit tests so the policy can be
 * validated independently of the rest of the backtest pipeline.
 */
export function admitsUnderPortfolioCap(
  candidate: TradeSignal,
  open: ReadonlyArray<{ symbol: string; signalType: string }>,
  opts: PortfolioOpts = {},
): null | { reason: 'max_open' | 'max_sector'; sector?: string } {
  const maxOpen = opts.maxOpenPositions ?? DEFAULT_MAX_OPEN;
  const maxSector = opts.maxSectorExposure ?? DEFAULT_MAX_SECTOR;
  const sectorOf = opts.sectorOf ?? defaultSectorOf;

  if (open.length >= maxOpen) return { reason: 'max_open' };

  const candidateSector = sectorOf(candidate.symbol);
  const sectorCount = open.filter(p => sectorOf(p.symbol) === candidateSector).length;
  if (sectorCount >= maxSector) return { reason: 'max_sector', sector: candidateSector };

  return null;
}

/**
 * Determines whether price reached the 1R target within the lookahead window.
 *
 * 1R is one risk-unit (= |entry − stop|). For longs we look for `high >= entry + R`;
 * for shorts, `low <= entry - R`. Used by the signal-edge metric to measure raw
 * signal quality independently of bracket-order plumbing.
 */
export function reachedOneR(
  signal: TradeSignal,
  futureCandles: ReadonlyArray<Candle>,
): boolean {
  const r = Math.abs(signal.entryPrice - signal.stopLoss);
  if (r === 0 || futureCandles.length === 0) return false;
  const target = signal.side === 'buy'
    ? signal.entryPrice + r
    : signal.entryPrice - r;
  for (const c of futureCandles) {
    if (signal.side === 'buy' ? c.high >= target : c.low <= target) return true;
  }
  return false;
}

export class BacktestRunner {
  async run(config: BacktestConfig, candles: Candle[]): Promise<BacktestResult> {
    const account = {
      totalEquity: config.initialEquity,
      availableCash: config.initialEquity,
      openPositions: [],
      dailyPnl: 0,
    };

    // TRA-186: crypto symbols default to fractional-quantity sizing — without
    // it BTC trades silently never size at typical 1% risk budgets because
    // sizeFromStop floors a 0.31-BTC budget to 0.
    const fractionalQuantity = config.fractionalQuantity
      ?? (defaultSectorOf(config.symbol) === 'crypto');
    const risk = new RiskManager(account, { fractionalQuantity });
    const positions = new PositionManager();
    const orb = new OrbStrategy(config.orbOpts);
    const reversal = new ReversalStrategy(config.reversalOpts);
    // TRA-170 refactored MACD-Bollinger into a trend half + a mean-reversion
    // half. The legacy `'macd' | 'macd_bollinger'` strategyType triggers both
    // so callers upgrading from the old single class get equivalent coverage.
    const macdTrend = new MacdTrendStrategy(config.macdBollingerOpts);
    const bbFade = new BbFadeStrategy({
      bbPeriod: config.macdBollingerOpts?.bbPeriod,
      bbMultiplier: config.macdBollingerOpts?.bbMultiplier,
      enforceTimeFilter: config.macdBollingerOpts?.enforceTimeFilter,
      volatilityFloorPct: config.macdBollingerOpts?.volatilityFloorPct,
    });
    const ichimoku = new IchimokuStrategy(config.ichimokuOpts);
    const scalping = new ScalpingStrategy(config.scalpingOpts);
    const swing = new SwingStrategy(config.swingOpts);
    // TRA-205: momentum is regime-gated; the detector is owned by the runner
    // and re-fed each bar so its hysteresis state matches what the strategy
    // sees during live trading.
    const regimeDetector = new RegimeDetector(config.regimeOpts);
    const momentum = new MomentumStrategy(regimeDetector, config.momentumOpts);
    // TRA-207: breakout strategy classifies its own regime when called without
    // a label. The runner could share `regimeDetector` here but that would
    // double-tick the hysteresis state per bar; passing `regimeOpts` through
    // the strategy's `regimeOptions` keeps both classifications using the
    // same configuration without coupling state.
    const breakoutVol = new BreakoutVolStrategy({
      ...config.breakoutVolOpts,
      regimeOptions: config.breakoutVolOpts?.regimeOptions ?? config.regimeOpts,
    });
    // TRA-206: mean-reversion is regime-gated to `range` only. Same wiring
    // shape as breakoutVol — pass `regimeOpts` through so the strategy's
    // self-classification uses the same hysteresis/threshold config as the
    // rest of the runner. The router (TRA-208) will eventually drive a shared
    // detector; until then this keeps configuration consistent.
    const meanReversion = new MeanReversionCryptoStrategy({
      ...config.meanReversionOpts,
      regimeOptions: config.meanReversionOpts?.regimeOptions ?? config.regimeOpts,
    });
    // TRA-821 — time-series-momentum on the crypto majors. Long-or-flat, band
    // exit; sizing is the VolKellySizer's job (wired below). Stateless wrapper.
    const tsmomParams = resolveTsmomMajorsParams(config.tsmomOpts);
    const tsmom = new TsmomMajorsStrategy(config.tsmomOpts);
    const isTsmom = config.strategyType === 'tsmom_majors';

    // TRA-169 / TRA-185 / TRA-203: per-fill cost model. Commission charged on
    // entry+exit notional, slippage applied adversely to fill prices. The
    // resolution order is `costModel` > `feeBps` (with maker/taker split if
    // executionMode = 'limit') > legacy flat `commissionBps`. Each
    // `BacktestConfig` runs against a single symbol so we resolve once.
    const executionMode = config.executionMode ?? 'market';
    const feeRates = resolveFeeRates(config);
    const fill = config.costModel
      ? config.costModel.resolve(config.symbol)
      : {
          // Per-side commission falls back to legacy flat `commissionBps` when
          // `feeBps` isn't set, otherwise leaves it 0 here and lets
          // `commissionRateFor` pick maker/taker per fill.
          commissionBps: feeRates ? 0 : (config.commissionBps ?? 0),
          slippageBps: config.slippageBps ?? 0,
        };
    const slipRate = fill.slippageBps / 10_000;
    const fallbackCommissionRate = fill.commissionBps / 10_000;
    /**
     * Per-fill commission rate. With `feeBps`, entries are maker-priced when
     * `executionMode = 'limit'` and taker-priced otherwise; exits are always
     * taker-priced because stop-loss / take-profit fire as market hits.
     */
    const commissionRateFor = (leg: 'entry' | 'exit'): number => {
      if (!feeRates) return fallbackCommissionRate;
      if (leg === 'exit') return feeRates.taker;
      return executionMode === 'limit' ? feeRates.maker : feeRates.taker;
    };
    // TRA-420 §4: entries fill at the *next* bar's open, not the signal
    // bar's close, so the caller supplies the raw fill price per fill.
    // Slippage is still applied adversely (buys up, sells down).
    const applyEntryFill = (side: 'buy' | 'sell', rawEntry: number): number =>
      side === 'buy' ? rawEntry * (1 + slipRate) : rawEntry * (1 - slipRate);
    const applyExitSlippage = (side: 'buy' | 'sell', rawExit: number): number =>
      side === 'buy' ? rawExit * (1 - slipRate) : rawExit * (1 + slipRate);
    const computePnl = (
      side: 'buy' | 'sell',
      entryFill: number,
      exitFill: number,
      qty: number,
    ): number => {
      const dir = side === 'buy' ? 1 : -1;
      const gross = (exitFill - entryFill) * qty * dir;
      const commission =
        entryFill * qty * commissionRateFor('entry') +
        exitFill * qty * commissionRateFor('exit');
      return gross - commission;
    };

    // TRA-420 §3: when `warmupStartDate` precedes `startDate`, pull the
    // earlier bars into `filtered` so the strategies — and the stateful
    // regime detector — warm up on real history. `evalStart` is the boundary
    // past which positions are opened and metrics recorded; warmup bars only
    // advance indicator state. Defaults to a cold start (warmup = startDate).
    const evalStart = config.startDate;
    const warmupStart = Math.min(config.warmupStartDate ?? evalStart, evalStart);
    const filtered = candles.filter(
      c => c.timestamp >= warmupStart && c.timestamp <= config.endDate,
    );

    const closedTrades: Position[] = [];
    const tradeRs: number[] = [];
    // TRA-818 (fix for TRA-815): fee-aware per-trade R, run in parallel to the
    // gross `tradeRs`. `optimisticPnl` already nets commission + slippage, so
    // dividing by the same stop-distance denominator the gross R uses yields a
    // net-of-cost R. Kept separate so live vol/Kelly sizing and validations that
    // consume the gross `expectancy`/`tradeRs` are untouched.
    const tradeRsNet: number[] = [];
    let ambiguousTrades = 0;
    let worstCaseTotalPnl = 0;
    /** Slippage-adjusted entry fill price keyed by position id. */
    const entryFills = new Map<string, number>();

    let peakEquity = config.initialEquity;
    let runningEquity = config.initialEquity;
    let maxDrawdown = 0;
    // TRA-203: per-bar mark-to-market equity series. Drives the annualized
    // Sharpe (per-bar returns are more stable than per-trade returns when the
    // sample is small) and lets `maxDrawdown` capture intra-trade drawdowns
    // — the realized-only series would miss a 30% paper loss that recovered
    // before the position closed.
    const barReturns: number[] = [];
    let prevMtmEquity = config.initialEquity;

    let skippedConcentration = 0;

    // TRA-423 — portfolio correlation / concentration cap (TRA-411 spec §6).
    // An *additional* gate on top of `admitsUnderPortfolioCap`: clusters the
    // open book by daily-return correlation, then hard-rejects a candidate in
    // a full cluster or scales it down to the binding risk/notional headroom.
    // `dailyCandlesBySymbol` feeds the real correlation estimate; with none
    // supplied the §3 fallback applies — fine for a single-symbol backtest
    // where every open position is the same symbol (ρ=1.0 with itself), so
    // they collapse into one cluster and the risk/count caps still bind.
    const corrCapEnabled = config.correlationCapOpts?.enabled === true;
    const corrCapConfig = resolveCorrelationCapConfig(config.correlationCapOpts?.config);
    const corrMatrix = new CorrelationMatrix(
      config.correlationCapOpts?.dailyCandlesBySymbol ?? {},
    );
    let correlationCapRejected = 0;
    let correlationCapScaledDown = 0;

    // TRA-430 — volatility-/Kelly-scaled per-trade risk sizing (TRA-428 spec).
    // Runs *ahead* of the TRA-423 cluster cap: it sets the candidate's
    // per-trade risk fraction (vol-targeted, Kelly-capped) before sizing, then
    // the cluster cap admits/scales the sized qty unchanged. Master `enabled`
    // flag defaults false → the sizer ships dark. `resolveVolKellySizerConfig`
    // asserts `riskPctFloor >= minTradeRiskPct` against the resolved cluster
    // cap floor (§5 floor coherence).
    // TRA-821 — the sizer is intrinsic to `tsmom_majors` ("enabled for THIS
    // strategy only"), so force it on and derive its config from the frozen 4
    // params: `volTargetAnnualPct` is the annual vol anchor, risk is the 1%
    // base clamped to [0.5%, 1.75%], and daily crypto bars annualise on √365.
    // An explicit `volKellySizerOpts.config` (e.g. a sweep) still overrides.
    // Omitting `expectancyByCell` leaves the Kelly cap inactive (vol-only) —
    // the only honest choice in a backtest, since feeding OOS expectancy back
    // into the same OOS trades would be look-ahead; live trading supplies the
    // validated OOS net expectancy per the spec.
    const tsmomVolKellyConfig = isTsmom
      ? {
          baseRiskPct: 0.01,
          riskPctFloor: 0.005,
          riskPctCeil: 0.0175,
          volRefAnnual: tsmomParams.volTargetAnnualPct / 100,
          barsPerYear: TSMOM_BARS_PER_YEAR,
          volWindowBars: 30,
        }
      : undefined;
    const volKellyEnabled = config.volKellySizerOpts?.enabled === true || isTsmom;
    const volKellyConfig = resolveVolKellySizerConfig(
      isTsmom
        ? { ...tsmomVolKellyConfig, ...(config.volKellySizerOpts?.config ?? {}) }
        : config.volKellySizerOpts?.config,
      corrCapConfig.minTradeRiskPct,
    );
    const volKellyExpectancy = config.volKellySizerOpts?.expectancyByCell ?? {};
    let volKellyApplied = 0;
    let volKellyZeroEdgeSkipped = 0;
    let volKellyEffRiskPctSum = 0;

    const lookahead = config.signalEdgeOpts?.lookaheadBars ?? DEFAULT_LOOKAHEAD_BARS;
    const signalLog: Array<{ signal: TradeSignal; barIndex: number }> = [];
    const seenSignalIds = new Set<string>();
    // TRA-420 §4: signals computed on bar k's close, parked here until bar
    // k+1 so they fill at the next bar's open. Only ever holds one bar's
    // worth — drained at the top of every iteration.
    let pendingSignals: TradeSignal[] = [];

    for (let i = 1; i <= filtered.length; i++) {
      const window = filtered.slice(0, i);
      const latest = filtered[i - 1];
      // TRA-420 §3: bars before `evalStart` only warm indicator/regime state.
      const inEvalWindow = latest.timestamp >= evalStart;

      // ── (A) Fill signals queued on the *previous* bar at this bar's open.
      // TRA-420 §4: a signal computed from bar k's close cannot fill before
      // bar k+1's open — checking it against bar k's own high/low is
      // look-ahead bias. `pendingSignals` carries exactly one bar's worth.
      for (const signal of pendingSignals) {
        const alreadyOpen = positions.getOpen().some(p => p.signalType === signal.type);
        if (alreadyOpen) continue;

        const admit = admitsUnderPortfolioCap(
          signal,
          positions.getOpen().map(p => ({ symbol: p.symbol, signalType: p.signalType })),
          config.portfolioOpts,
        );
        if (admit) {
          skippedConcentration += 1;
          continue;
        }

        // TRA-211 spec §3: mean reversion sizes at 0.75% of equity (vs. the
        // 1% default that momentum/breakout share). The override applies only
        // to `mean_reversion` signals — other types use whatever
        // `RiskManager` defaults to.
        let riskPct = signal.type === 'mean_reversion'
          ? (config.meanReversionRiskPct ?? DEFAULT_MEAN_REVERSION_RISK_PCT)
          : undefined;

        // TRA-430 — vol-/Kelly-scaled per-trade risk (TRA-428 spec §3). When
        // enabled, the effective risk fraction replaces the flat budget for
        // every signal type. `σ_sym` is the trailing realised vol of the
        // strategy-timeframe closes that are fully closed at fill time —
        // `window` ends on `latest`, the bar whose open is the fill price, so
        // its close is excluded (`slice(0, -1)`) to avoid look-ahead (§3.2).
        let volKellyEffRiskPct: number | null = null;
        if (volKellyEnabled) {
          const closedCloses = window.slice(0, -1).map(c => c.close);
          const sigmaSym = trailingRealisedVol(
            closedCloses,
            volKellyConfig.volWindowBars,
            volKellyConfig.barsPerYear,
          );
          // §3.1 cell key — try `${signalType}|${symbol}`, then bare symbol.
          const expectancy =
            volKellyExpectancy[`${signal.type}|${signal.symbol}`] ??
            volKellyExpectancy[signal.symbol];
          volKellyEffRiskPct = effectiveRiskPct(volKellyConfig, sigmaSym, expectancy);
          volKellyApplied += 1;
          volKellyEffRiskPctSum += volKellyEffRiskPct;
          riskPct = volKellyEffRiskPct;
        }

        // §3.4/§3.5 — a non-positive-edge cell yields `effRiskPct = 0`; size to
        // zero so the trade is dropped (belt-and-suspenders to TRA-421).
        const qty = volKellyEffRiskPct === 0
          ? 0
          : risk.sizeFromStop(signal.entryPrice, signal.stopLoss, { riskPct });
        if (volKellyEffRiskPct === 0) volKellyZeroEdgeSkipped += 1;

        // TRA-423 — correlation / concentration cap admission (spec §6). Runs
        // after sizing because the cap reasons about the candidate's dollar
        // risk and notional. A hard reject drops the entry; a scale-down
        // shrinks the quantity to the binding headroom. Risk and notional
        // scale together for a fixed stop, so trimming qty is sufficient.
        let finalQty = qty;
        if (corrCapEnabled && qty > 0) {
          const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
          const open = positions.getOpen().map(p => ({
            symbol: p.symbol,
            risk: Math.abs(p.entryPrice - p.stopLoss) * p.quantity,
            notional: p.entryPrice * p.quantity,
          }));
          const decision = admitUnderClusterCap(
            {
              symbol: signal.symbol,
              risk: stopDistance * qty,
              notional: signal.entryPrice * qty,
            },
            open,
            runningEquity * MANAGED_ACCOUNT_RATIO,
            corrMatrix.correlation,
            corrCapConfig,
          );
          if (!decision.admitted) {
            correlationCapRejected += 1;
            continue;
          }
          if (decision.scale < 1) {
            correlationCapScaledDown += 1;
            finalQty = fractionalQuantity
              ? Math.floor(qty * decision.scale * 1e8) / 1e8
              : Math.floor(qty * decision.scale);
          }
        }

        if (finalQty > 0) {
          const opened = positions.open(signal, finalQty);
          // TRA-420 §4: entry fills at THIS bar's open — the first price
          // obtainable after the prior bar's close-derived signal.
          entryFills.set(opened.id, applyEntryFill(signal.side, latest.open));
          // TRA-211: seed the per-position lifecycle state at entry so the
          // RSI-50 alt-exit can compare against the entry-bar RSI and the
          // breakout BE trigger uses the entry-bar ATR (immune to subsequent
          // ATR collapse from the breakout bar's wide range distorting the
          // smoothed value).
          positions.setLifecycle(opened.id, initLifecycleState(opened, window));
        }
      }
      pendingSignals = [];

      // ── Per-bar lifecycle: time stops, trailing-stop ratchets, RSI alt
      // exit (TRA-211). Runs BEFORE the hard-stop / take-profit check so a
      // tightened trail can fire on the same bar it was raised, and
      // time-stop / RSI-alt exits beat a slower bracket exit when both
      // would resolve on the same bar.
      for (const pos of positions.getOpen()) {
        const ls = positions.getLifecycle(pos.id);
        if (!ls) continue;
        ls.barsHeld += 1;
        advanceExtreme(ls, pos, latest);

        // ── Trailing-stop update (mutates pos.stopLoss in place via the
        // PositionManager helper). Runs before the SL/TP hit check so a new
        // tighter level can trigger on the bar that raised it.
        if (pos.signalType === 'momentum') {
          // TRA-261 / TRA-255 §4.1 — Momentum-shorts trail at Donchian_high(10),
          // Momentum-longs at Donchian_low(20). The per-side period map is the
          // single source of truth; backtest config can still override the
          // long-side period explicitly for sweeps.
          const donchianPeriod = pos.side === 'sell'
            ? momentumTrailPeriodFor('sell')
            : config.momentumOpts?.donchianPeriod ?? momentumTrailPeriodFor('buy');
          const newStop = momentumTrailStop(pos, window, donchianPeriod);
          if (newStop !== null) {
            positions.updateStop(pos.id, newStop);
            ls.trailed = true;
          }
        } else if (pos.signalType === 'breakout_vol') {
          // TRA-261 / TRA-255 §4.2 — Breakout-shorts engage BE at +1.5×ATR
          // and trail at 1.25×ATR; longs keep the spec §4 default 2×ATR/2×ATR.
          // Long-side honours the backtest-config override (legacy sweep
          // surface); shorts always use the spec values from the per-side map.
          const sideOpts = breakoutTrailOptionsFor(pos.side);
          // NOTE: prior code accidentally used `atrStopMultiplier` for both
          // beTriggerMultiplier AND trailMultiplier — that's a long-side bug
          // (those should be independent BE-trigger and trail-width knobs).
          // Preserving the legacy behaviour to keep this commit "byte-identical
          // long path" per the TRA-261 contract; a follow-up ticket can split
          // them.
          const beTriggerMultiplier = pos.side === 'sell'
            ? sideOpts.beTriggerMultiplier
            : config.breakoutVolOpts?.atrStopMultiplier ?? sideOpts.beTriggerMultiplier;
          const trailMultiplier = pos.side === 'sell'
            ? sideOpts.trailMultiplier
            : config.breakoutVolOpts?.atrStopMultiplier ?? sideOpts.trailMultiplier;
          const atrPeriod = config.breakoutVolOpts?.atrPeriod ?? sideOpts.atrPeriod ?? 14;
          const newStop = breakoutTrailStop(pos, window, ls, {
            beTriggerMultiplier,
            trailMultiplier,
            atrPeriod,
          });
          if (newStop !== null) {
            positions.updateStop(pos.id, newStop);
            ls.trailed = true;
          }
        }
      }

      const exitsThisBar: Array<{
        pos: Position;
        rawExit: number;
        reason: ExitReason;
        ambiguous: boolean;
        pessimisticRawExit?: number;
      }> = [];

      for (const pos of positions.getOpen()) {
        const ls = positions.getLifecycle(pos.id);

        // TRA-821 — tsmom_majors is long-or-flat with a band exit, NOT a bracket
        // strategy. Its on-signal stop is a sizing-only 1R unit (one daily
        // vol-target σ) that would fire near-daily on crypto if armed, so we skip
        // the hard stop / take-profit / time-stop entirely and exit only when the
        // trailing L-day return crosses below -exitBandPct. Exit at this bar's
        // close, mirroring the mean_reversion RSI alt-exit convention.
        if (pos.signalType === 'tsmom_majors') {
          if (tsmomExitToFlat(window, tsmomParams)) {
            exitsThisBar.push({
              pos,
              rawExit: latest.close,
              reason: 'tsmom_band_exit',
              ambiguous: false,
            });
          }
          continue;
        }

        const hitsStop = pos.side === 'buy'
          ? latest.low <= pos.stopLoss
          : latest.high >= pos.stopLoss;
        const hitsTarget = pos.side === 'buy'
          ? latest.high >= pos.takeProfit
          : latest.low <= pos.takeProfit;

        // 1) Mean-reversion alt exit (RSI re-cross 50). Spec §3 says it
        //    competes with the BB-middle target — first to fire wins. We
        //    prefer the alt exit when it's the only thing firing AND it has
        //    triggered; if a hard stop also hits this bar, the stop wins.
        if (
          ls
          && pos.signalType === 'mean_reversion'
          && !hitsStop
          && !hitsTarget
          && meanReversionRsiAltExitTriggered(
            pos,
            window,
            config.meanReversionOpts?.rsiPeriod ?? 14,
            ls,
          )
        ) {
          exitsThisBar.push({
            pos,
            rawExit: latest.close,
            reason: 'rsi_alt_exit',
            ambiguous: false,
          });
          continue;
        }

        // 2) Hard stop / take-profit bracket. Same OHLC ambiguity handling
        //    as before, plus exit-reason classification: a stop hit after a
        //    trailing ratchet records as `trailing` instead of `stop`.
        if (hitsStop || hitsTarget) {
          const ambiguous = hitsStop && hitsTarget;
          const optimisticExitRaw = hitsTarget ? pos.takeProfit : pos.stopLoss;
          const pessimisticExitRaw = hitsStop ? pos.stopLoss : pos.takeProfit;
          let reason: ExitReason;
          if (hitsTarget && !ambiguous) reason = 'target';
          else if (ls?.trailed && hitsStop && !ambiguous) reason = 'trailing';
          else reason = hitsStop ? 'stop' : 'target';
          exitsThisBar.push({
            pos,
            rawExit: optimisticExitRaw,
            reason,
            ambiguous,
            pessimisticRawExit: pessimisticExitRaw,
          });
          continue;
        }

        // 3) Time stop. Per spec §3/§4 the position closes "at market" once
        //    the bar cap is reached; we use the bar's close. Only fires when
        //    neither the bracket nor the alt-exit closed the trade. TRA-261 —
        //    pass `pos.side` so Momentum-shorts get the §4.1 20-bar cap and
        //    Breakout-shorts get the §4.2 10-bar cap (vs. 15 long).
        const cap = timeStopBarsFor(pos.signalType, pos.side);
        if (ls && cap !== null && ls.barsHeld >= cap) {
          exitsThisBar.push({
            pos,
            rawExit: latest.close,
            reason: 'time_stop',
            ambiguous: false,
          });
        }
      }

      for (const ex of exitsThisBar) {
        const { pos, rawExit, reason, ambiguous, pessimisticRawExit } = ex;
        const entryFill = entryFills.get(pos.id) ?? pos.entryPrice;
        // TRA-211: R-multiple uses the entry-bar stop, not the (possibly
        // trailed) live stop, so a trailing ratchet doesn't shrink the
        // denominator and inflate reported R.
        const stopForR = positions.getLifecycle(pos.id)?.initialStopLoss ?? pos.stopLoss;
        const optimisticFill = applyExitSlippage(pos.side, rawExit);
        const optimisticPnl = computePnl(pos.side, entryFill, optimisticFill, pos.quantity);

        const closed = positions.close(pos.id, rawExit, reason);
        // Overwrite the manager's naive PnL with the cost-adjusted version and
        // persist the slippage-adjusted entry/exit so downstream consumers see
        // realistic fill economics on every trade.
        closed.entryPrice = entryFill;
        closed.exitPrice = optimisticFill;
        closed.pnl = optimisticPnl;
        entryFills.delete(pos.id);
        closedTrades.push(closed);
        tradeRs.push(tradeR(pos.side, entryFill, optimisticFill, stopForR));
        // TRA-818: net R uses the cost-inclusive `optimisticPnl` over the same
        // stop-distance denominator the gross R uses (stopDistance * qty). With
        // fee=0 this is byte-identical to the gross R above, since
        // grossPnl/(stopDistance*qty) === (exitFill-entryFill)*dir/stopDistance.
        const stopDistanceForR = Math.abs(entryFill - stopForR);
        const denomNet = stopDistanceForR * pos.quantity;
        tradeRsNet.push(denomNet > 0 ? optimisticPnl / denomNet : 0);

        if (ambiguous && pessimisticRawExit !== undefined) {
          ambiguousTrades += 1;
          const pessimisticFill = applyExitSlippage(pos.side, pessimisticRawExit);
          worstCaseTotalPnl += computePnl(pos.side, entryFill, pessimisticFill, pos.quantity);
        } else {
          worstCaseTotalPnl += optimisticPnl;
        }

        runningEquity += optimisticPnl;
      }

      // TRA-203: bar-level mark-to-market. After processing entries and
      // exits, value remaining open positions at this bar's close so peak
      // equity / drawdown / per-bar returns capture unrealized PnL too.
      // TRA-420 §3: skipped during warmup — no positions are open there, and
      // recording flat warmup bars would dilute the annualized Sharpe.
      if (inEvalWindow) {
        const closePx = latest.close;
        let unrealized = 0;
        for (const pos of positions.getOpen()) {
          const entryFill = entryFills.get(pos.id) ?? pos.entryPrice;
          const dir = pos.side === 'buy' ? 1 : -1;
          unrealized += (closePx - entryFill) * pos.quantity * dir;
        }
        const mtmEquity = runningEquity + unrealized;
        peakEquity = Math.max(peakEquity, mtmEquity);
        if (peakEquity > 0) {
          const drawdown = (peakEquity - mtmEquity) / peakEquity;
          if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
        if (prevMtmEquity > 0) {
          barReturns.push((mtmEquity - prevMtmEquity) / prevMtmEquity);
        } else {
          barReturns.push(0);
        }
        prevMtmEquity = mtmEquity;
      }

      // ── (E) Evaluate strategies on the window ending at this bar. Run even
      // during warmup so the stateful regime detector's hysteresis is warm by
      // the first eval bar; only eval-window signals are recorded for the
      // signal-edge metric and queued to fill at the next bar's open.
      const signals = [];
      if (config.strategyType === 'orb' || config.strategyType === 'combined') {
        const s = orb.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'reversal' || config.strategyType === 'combined') {
        const s = reversal.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'macd' || config.strategyType === 'macd_trend' || config.strategyType === 'macd_bollinger' || config.strategyType === 'combined') {
        const t = macdTrend.evaluate(config.symbol, window);
        if (t) signals.push(t);
      }
      if (config.strategyType === 'bb_fade' || config.strategyType === 'macd_bollinger' || config.strategyType === 'combined') {
        const f = bbFade.evaluate(config.symbol, window);
        if (f) signals.push(f);
      }
      if (config.strategyType === 'momentum' || config.strategyType === 'combined') {
        const m = momentum.evaluate(config.symbol, window);
        if (m) signals.push(m);
      }
      if (config.strategyType === 'breakout_vol' || config.strategyType === 'combined') {
        const b = breakoutVol.evaluate(config.symbol, window);
        if (b) signals.push(b);
      }
      if (config.strategyType === 'mean_reversion' || config.strategyType === 'combined') {
        const m = meanReversion.evaluate(config.symbol, window);
        if (m) signals.push(m);
      }
      // TRA-821 — standalone crypto candidate; not part of the legacy `combined`
      // equity bundle. The runner's `alreadyOpen` guard keeps it long-or-flat.
      if (config.strategyType === 'tsmom_majors') {
        const s = tsmom.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'ichimoku' || config.strategyType === 'combined') {
        const s = ichimoku.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'scalping' || config.strategyType === 'combined') {
        const s = scalping.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }
      if (config.strategyType === 'swing' || config.strategyType === 'combined') {
        const s = swing.evaluate(config.symbol, window);
        if (s) signals.push(s);
      }

      if (inEvalWindow) {
        for (const signal of signals) {
          // Track every distinct signal exactly once for the signal-edge
          // metric, independent of whether the trade is ultimately taken.
          if (!seenSignalIds.has(signal.id)) {
            seenSignalIds.add(signal.id);
            signalLog.push({ signal, barIndex: i - 1 });
          }
          // Queue for a next-bar-open fill (TRA-420 §4).
          pendingSignals.push(signal);
        }
      }
    }

    const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losers = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? winners.length / closedTrades.length : 0;

    const grossProfit = winners.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // TRA-203: annualized Sharpe from per-bar mark-to-market returns. Falls
    // back to per-trade R returns when the bar series is too short (e.g.
    // pure trade-list replay without candles) — both are zero-rf-rate Sharpes
    // for cleanliness; subtract a risk-free term here if/when one matters.
    const barIntervalMs = inferBarIntervalMs(filtered);
    const barsPerYear = barIntervalMs ? MS_PER_YEAR / barIntervalMs : 252;
    let sharpeRatio = 0;
    if (barReturns.length > 1) {
      const meanRet = barReturns.reduce((s, r) => s + r, 0) / barReturns.length;
      const variance = barReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (barReturns.length - 1);
      const stdRet = Math.sqrt(variance);
      sharpeRatio = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(barsPerYear) : 0;
    } else if (tradeRs.length > 1) {
      const meanR = tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length;
      const varR = tradeRs.reduce((s, r) => s + (r - meanR) ** 2, 0) / (tradeRs.length - 1);
      const stdR = Math.sqrt(varR);
      sharpeRatio = stdR > 0 ? meanR / stdR : 0;
    }

    // TRA-203: expectancy = average R per trade. Industry rule of thumb is
    // > 0.2R per trade after costs is the floor for a deployable system.
    const expectancy = tradeRs.length > 0
      ? tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length
      : 0;
    // TRA-818: net-of-cost expectancy (commission + slippage). Strictly <=
    // gross `expectancy`, and monotonically worse as fees rise. NOT wired into
    // live sizing — pooled by TRA-523 for the per-arm cost-sensitivity table.
    const expectancyNet = tradeRsNet.length > 0
      ? tradeRsNet.reduce((s, r) => s + r, 0) / tradeRsNet.length
      : 0;

    const avgRiskReward = closedTrades.length > 0
      ? closedTrades.reduce((s, t) => {
          const risk = Math.abs(t.entryPrice - t.stopLoss) * t.quantity;
          return s + (risk > 0 ? (t.pnl ?? 0) / risk : 0);
        }, 0) / closedTrades.length
      : 0;

    let reachedCount = 0;
    for (const { signal, barIndex } of signalLog) {
      const future = filtered.slice(barIndex + 1, barIndex + 1 + lookahead);
      if (reachedOneR(signal, future)) reachedCount += 1;
    }
    const signalEdge: SignalEdge = {
      reachedOneR: reachedCount,
      totalSignals: signalLog.length,
      hitRatePct: signalLog.length > 0 ? (reachedCount / signalLog.length) * 100 : 0,
      lookaheadBars: lookahead,
    };

    return {
      config,
      trades: closedTrades,
      totalPnl,
      winRate,
      avgRiskReward,
      maxDrawdown,
      sharpeRatio,
      totalTrades: closedTrades.length,
      winners: winners.length,
      losers: losers.length,
      profitFactor,
      skippedConcentration,
      correlationCap: corrCapEnabled
        ? { enabled: true, rejected: correlationCapRejected, scaledDown: correlationCapScaledDown }
        : undefined,
      volKellySizer: volKellyEnabled
        ? {
            enabled: true,
            applied: volKellyApplied,
            zeroEdgeSkipped: volKellyZeroEdgeSkipped,
            avgEffRiskPct: volKellyApplied > 0 ? volKellyEffRiskPctSum / volKellyApplied : 0,
          }
        : undefined,
      signalEdge,
      ambiguousTrades,
      worstCaseTotalPnl,
      tradeRs,
      expectancy,
      tradeRsNet,
      expectancyNet,
      barIntervalMs,
    };
  }
}
