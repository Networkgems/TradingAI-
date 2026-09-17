import {
  Candle,
  ExitReason,
  Position,
  TradeSignal,
  MANAGED_ACCOUNT_RATIO,
} from '@trading-app/shared';
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
  timeStopBarsFor,
  momentumTrailPeriodFor,
  breakoutTrailOptionsFor,
} from '@trading-app/engine';
import {
  BacktestConfig,
  CorrelationCapOpts,
  PortfolioOpts,
  SignalEdge,
  SignalEdgeOpts,
  VolKellySizerOpts,
} from './types.js';
import { admitsUnderPortfolioCap, defaultSectorOf } from './runner.js';

/**
 * TRA-429 — Multi-symbol portfolio backtest runner.
 *
 * `BacktestRunner` (runner.ts) is single-symbol: it replays one candle series
 * against one strategy stack. The TRA-423 §8 validation could therefore only
 * exercise the *intra-symbol* correlation cluster (`macd_trend` + `bb_fade` on
 * one symbol, ρ=1.0 with itself). The *cross-symbol* cluster — e.g. BTC-USD +
 * SOL-USD, the core motivation of the TRA-411 correlation cap — had no
 * historical regression coverage at all.
 *
 * {@link PortfolioBacktestRunner} closes that gap. It ticks several symbols
 * forward on a single shared timeline against **one shared portfolio / risk
 * state**:
 *
 *   - one open-positions book (every symbol's positions in the same list),
 *   - one running equity / drawdown series,
 *   - one {@link CorrelationMatrix} + cluster-cap config,
 *
 * so the TRA-423 correlation-cap admission rule (`admitUnderClusterCap`) is
 * enforced bar-by-bar over history against the *real* multi-symbol open book.
 * Each symbol keeps its own strategy instances (strategies — and the regime
 * detector — are stateful per tape), but the admission, sizing and accounting
 * all run through the shared state.
 *
 * This is regression infrastructure: it does not change live behaviour. The
 * live engine already shares portfolio state across symbols; this runner gives
 * that path historical-data coverage.
 */

const DEFAULT_LOOKAHEAD_BARS = 24;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1_000;

/** Per-symbol strategy + cost + risk opts shared across the portfolio basket. */
export interface PortfolioBacktestConfig {
  /** Symbols ticked together against the shared portfolio. */
  symbols: string[];
  startDate: number;
  endDate: number;
  /** TRA-420 §3 warmup boundary — see {@link BacktestConfig.warmupStartDate}. */
  warmupStartDate?: number;
  initialEquity: number;
  /** Strategy stack applied to *every* symbol (each gets its own instances). */
  strategyType: BacktestConfig['strategyType'];
  reversalOpts?: BacktestConfig['reversalOpts'];
  macdBollingerOpts?: BacktestConfig['macdBollingerOpts'];
  ichimokuOpts?: BacktestConfig['ichimokuOpts'];
  momentumOpts?: BacktestConfig['momentumOpts'];
  breakoutVolOpts?: BacktestConfig['breakoutVolOpts'];
  regimeOpts?: BacktestConfig['regimeOpts'];
  orbOpts?: BacktestConfig['orbOpts'];
  scalpingOpts?: BacktestConfig['scalpingOpts'];
  swingOpts?: BacktestConfig['swingOpts'];
  /** Shared concentration caps (count / sector) — apply across the basket. */
  portfolioOpts?: PortfolioOpts;
  /**
   * TRA-423 correlation / concentration cap. With several symbols open this is
   * the path the *cross-symbol* cluster cap runs through — supply
   * `dailyCandlesBySymbol` for every traded symbol so the §3 correlation
   * estimate is real rather than the fully-correlated fallback.
   */
  correlationCapOpts?: CorrelationCapOpts;
  /** TRA-430 vol-/Kelly-scaled per-trade risk sizing. */
  volKellySizerOpts?: VolKellySizerOpts;
  signalEdgeOpts?: SignalEdgeOpts;
  commissionBps?: number;
  slippageBps?: number;
  costModel?: BacktestConfig['costModel'];
  fractionalQuantity?: boolean;
  feeBps?: BacktestConfig['feeBps'];
  executionMode?: BacktestConfig['executionMode'];
}

/** Per-symbol slice of the aggregate {@link PortfolioBacktestResult}. */
export interface PortfolioSymbolResult {
  totalTrades: number;
  totalPnl: number;
  winners: number;
  losers: number;
}

/**
 * Aggregate result of a portfolio backtest. Headline metrics roll up every
 * symbol; {@link bySymbol} keeps the per-symbol breakdown. {@link correlationCap}
 * counts the cross-symbol admission activity — the TRA-429 acceptance check is
 * `rejected + scaledDown > 0` on a correlated basket.
 */
export interface PortfolioBacktestResult {
  config: PortfolioBacktestConfig;
  /** Closed trades across all symbols, PnL net of costs. */
  trades: Position[];
  totalPnl: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalTrades: number;
  winners: number;
  losers: number;
  profitFactor: number;
  /** Entries skipped by the shared `maxOpen` / `maxSector` portfolio cap. */
  skippedConcentration: number;
  /**
   * TRA-423 cluster-cap activity over the *shared* book. Present only when the
   * cap was enabled. `rejected` + `scaledDown` > 0 proves the cross-symbol
   * correlation cluster cap bound on historical data (TRA-429 acceptance).
   */
  correlationCap?: { enabled: boolean; rejected: number; scaledDown: number };
  /** TRA-430 vol-/Kelly-sizer activity, present only when the sizer was on. */
  volKellySizer?: {
    enabled: boolean;
    applied: number;
    zeroEdgeSkipped: number;
    avgEffRiskPct: number;
  };
  signalEdge: SignalEdge;
  ambiguousTrades: number;
  worstCaseTotalPnl: number;
  tradeRs: number[];
  expectancy: number;
  /** Bar interval (ms) inferred from the merged timeline; `null` if < 2 bars. */
  barIntervalMs: number | null;
  bySymbol: Record<string, PortfolioSymbolResult>;
}

/** Mirrors runner.ts `resolveFeeRates` — kept local so runner.ts is untouched. */
function resolveFeeRates(
  feeBps: BacktestConfig['feeBps'],
): { maker: number; taker: number } | null {
  if (feeBps === undefined) return null;
  if (typeof feeBps === 'number') {
    const r = feeBps / 10_000;
    return { maker: r, taker: r };
  }
  return { maker: feeBps.maker / 10_000, taker: feeBps.taker / 10_000 };
}

/** Mirrors runner.ts `inferBarIntervalMs` — modal gap between timestamps. */
function inferBarIntervalMs(timestamps: ReadonlyArray<number>): number | null {
  if (timestamps.length < 2) return null;
  const counts = new Map<number, number>();
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i] - timestamps[i - 1];
    if (dt > 0) counts.set(dt, (counts.get(dt) ?? 0) + 1);
  }
  let bestDt = 0;
  let bestCount = 0;
  for (const [dt, c] of counts) {
    if (c > bestCount) { bestCount = c; bestDt = dt; }
  }
  return bestDt > 0 ? bestDt : null;
}

/** Mirrors runner.ts `tradeR` — per-trade R multiple, signed by side. */
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

/** Mirrors runner.ts `reachedOneR` for the per-symbol signal-edge metric. */
function reachedOneR(
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

/**
 * The strategy stack for one symbol. Strategies — and the regime detector that
 * gates momentum / breakout / mean-reversion — are stateful per tape, so every
 * symbol gets its own bundle even though they share the portfolio state.
 */
class StrategyBundle {
  private readonly orb: OrbStrategy;
  private readonly reversal: ReversalStrategy;
  private readonly macdTrend: MacdTrendStrategy;
  private readonly bbFade: BbFadeStrategy;
  private readonly ichimoku: IchimokuStrategy;
  private readonly scalping: ScalpingStrategy;
  private readonly swing: SwingStrategy;
  private readonly momentum: MomentumStrategy;
  private readonly breakoutVol: BreakoutVolStrategy;
  private readonly strategyType: BacktestConfig['strategyType'];

  constructor(config: PortfolioBacktestConfig) {
    this.strategyType = config.strategyType;
    this.orb = new OrbStrategy(config.orbOpts);
    this.reversal = new ReversalStrategy(config.reversalOpts);
    // TRA-170: `macd_bollinger` fans out to a trend half + a mean-reversion
    // half, whose positions carry distinct signalTypes.
    this.macdTrend = new MacdTrendStrategy(config.macdBollingerOpts);
    this.bbFade = new BbFadeStrategy({
      bbPeriod: config.macdBollingerOpts?.bbPeriod,
      bbMultiplier: config.macdBollingerOpts?.bbMultiplier,
      enforceTimeFilter: config.macdBollingerOpts?.enforceTimeFilter,
      volatilityFloorPct: config.macdBollingerOpts?.volatilityFloorPct,
    });
    this.ichimoku = new IchimokuStrategy(config.ichimokuOpts);
    this.scalping = new ScalpingStrategy(config.scalpingOpts);
    this.swing = new SwingStrategy(config.swingOpts);
    // TRA-205: one detector per symbol — re-fed each bar so its hysteresis
    // state tracks that symbol's tape.
    const regimeDetector = new RegimeDetector(config.regimeOpts);
    this.momentum = new MomentumStrategy(regimeDetector, config.momentumOpts);
    this.breakoutVol = new BreakoutVolStrategy({
      ...config.breakoutVolOpts,
      regimeOptions: config.breakoutVolOpts?.regimeOptions ?? config.regimeOpts,
    });
  }

  /** Evaluate the enabled strategies on the window ending at the latest bar. */
  evaluate(symbol: string, window: Candle[]): TradeSignal[] {
    const t = this.strategyType;
    const signals: TradeSignal[] = [];
    const push = (s: TradeSignal | null | undefined): void => { if (s) signals.push(s); };
    if (t === 'orb' || t === 'combined') push(this.orb.evaluate(symbol, window));
    if (t === 'reversal' || t === 'combined') push(this.reversal.evaluate(symbol, window));
    if (t === 'macd' || t === 'macd_trend' || t === 'macd_bollinger' || t === 'combined') {
      push(this.macdTrend.evaluate(symbol, window));
    }
    if (t === 'bb_fade' || t === 'macd_bollinger' || t === 'combined') {
      push(this.bbFade.evaluate(symbol, window));
    }
    if (t === 'momentum' || t === 'combined') push(this.momentum.evaluate(symbol, window));
    if (t === 'breakout_vol' || t === 'combined') push(this.breakoutVol.evaluate(symbol, window));
    if (t === 'ichimoku' || t === 'combined') push(this.ichimoku.evaluate(symbol, window));
    if (t === 'scalping' || t === 'combined') push(this.scalping.evaluate(symbol, window));
    if (t === 'swing' || t === 'combined') push(this.swing.evaluate(symbol, window));
    return signals;
  }
}

/** Mutable per-symbol state threaded through the shared timeline loop. */
interface SymbolState {
  symbol: string;
  /** Candles in `[warmupStart, endDate]`, sorted ascending. */
  filtered: Candle[];
  /** Index of the next `filtered` bar to process. */
  cursor: number;
  /** Bars processed so far — the strategy-evaluation window. */
  window: Candle[];
  bundle: StrategyBundle;
  risk: RiskManager;
  /** Signals computed on the previous bar, awaiting a next-bar-open fill. */
  pendingSignals: TradeSignal[];
  fractionalQuantity: boolean;
  /** Per-fill cost economics for this symbol. */
  slipRate: number;
  fallbackCommissionRate: number;
  feeRates: { maker: number; taker: number } | null;
  /** Latest close seen — feeds the portfolio mark-to-market. */
  lastClose: number | null;
}

/**
 * Multi-symbol portfolio backtest runner. See the file header for the design.
 *
 * Usage:
 *   const result = await new PortfolioBacktestRunner().run(config, {
 *     'BTC-USD': btcCandles,
 *     'SOL-USD': solCandles,
 *   });
 */
export class PortfolioBacktestRunner {
  async run(
    config: PortfolioBacktestConfig,
    candlesBySymbol: Record<string, Candle[]>,
  ): Promise<PortfolioBacktestResult> {
    const symbols = [...config.symbols];
    if (symbols.length === 0) {
      throw new Error('PortfolioBacktestRunner.run: config.symbols is empty');
    }

    // ── Shared portfolio / risk state. One account, one position book, one
    // running-equity series — every symbol's entries and exits flow through
    // these so the concentration and cluster caps see the whole basket.
    const account = {
      totalEquity: config.initialEquity,
      availableCash: config.initialEquity,
      openPositions: [],
      dailyPnl: 0,
    };
    const positions = new PositionManager();

    const evalStart = config.startDate;
    const warmupStart = Math.min(config.warmupStartDate ?? evalStart, evalStart);
    const executionMode = config.executionMode ?? 'market';
    const feeRates = resolveFeeRates(config.feeBps);

    // ── TRA-423 shared correlation matrix + cluster cap. The matrix is built
    // from the caller-supplied daily-candle map; with several real symbols
    // open it produces the genuine cross-symbol correlation rather than the
    // single-symbol ρ=1.0 self-correlation the §8 validation was limited to.
    const corrCapEnabled = config.correlationCapOpts?.enabled === true;
    const corrCapConfig = resolveCorrelationCapConfig(config.correlationCapOpts?.config);
    const corrMatrix = new CorrelationMatrix(
      config.correlationCapOpts?.dailyCandlesBySymbol ?? {},
    );
    let correlationCapRejected = 0;
    let correlationCapScaledDown = 0;

    // ── TRA-430 vol-/Kelly sizer (shared config; expectancy keyed per cell).
    const volKellyEnabled = config.volKellySizerOpts?.enabled === true;
    const volKellyConfig = resolveVolKellySizerConfig(
      config.volKellySizerOpts?.config,
      corrCapConfig.minTradeRiskPct,
    );
    const volKellyExpectancy = config.volKellySizerOpts?.expectancyByCell ?? {};
    let volKellyApplied = 0;
    let volKellyZeroEdgeSkipped = 0;
    let volKellyEffRiskPctSum = 0;

    // ── Per-symbol state. Each symbol keeps its own strategy stack and
    // RiskManager (sharing the one `account` by reference so equity is
    // common), but a per-symbol `fractionalQuantity` so a mixed fractional/
    // whole-unit basket sizes each leg correctly.
    const stateBySymbol = new Map<string, SymbolState>();
    for (const symbol of symbols) {
      const raw = candlesBySymbol[symbol] ?? [];
      const filtered = raw
        .filter(c => c.timestamp >= warmupStart && c.timestamp <= config.endDate)
        .sort((a, b) => a.timestamp - b.timestamp);
      const fractionalQuantity = config.fractionalQuantity
        ?? (defaultSectorOf(symbol) === 'usd_pair');
      const fill = config.costModel
        ? config.costModel.resolve(symbol)
        : {
            commissionBps: feeRates ? 0 : (config.commissionBps ?? 0),
            slippageBps: config.slippageBps ?? 0,
          };
      stateBySymbol.set(symbol, {
        symbol,
        filtered,
        cursor: 0,
        window: [],
        bundle: new StrategyBundle(config),
        risk: new RiskManager(account, { fractionalQuantity }),
        pendingSignals: [],
        fractionalQuantity,
        slipRate: fill.slippageBps / 10_000,
        fallbackCommissionRate: fill.commissionBps / 10_000,
        feeRates,
        lastClose: null,
      });
    }

    // ── Merged timeline: the sorted union of every symbol's bar timestamps.
    // Symbols on an aligned grid (e.g. a shared 4H grid) share each tick; a symbol
    // missing a timestamp simply does not advance on that tick.
    const tsSet = new Set<number>();
    for (const s of stateBySymbol.values()) {
      for (const c of s.filtered) tsSet.add(c.timestamp);
    }
    const timeline = [...tsSet].sort((a, b) => a - b);
    const barIntervalMs = inferBarIntervalMs(timeline);

    const closedTrades: Position[] = [];
    const tradeRs: number[] = [];
    let ambiguousTrades = 0;
    let worstCaseTotalPnl = 0;
    let skippedConcentration = 0;
    /** Slippage-adjusted entry fill price keyed by position id. */
    const entryFills = new Map<string, number>();

    let runningEquity = config.initialEquity;
    let peakEquity = config.initialEquity;
    let maxDrawdown = 0;
    const barReturns: number[] = [];
    let prevMtmEquity = config.initialEquity;

    // Signal-edge log — `barIndex` is into that symbol's `filtered` array.
    const signalLog: Array<{ signal: TradeSignal; symbol: string; barIndex: number }> = [];
    const seenSignalIds = new Set<string>();

    /** Per-fill commission rate for a leg (mirrors runner.ts). */
    const commissionRateFor = (s: SymbolState, leg: 'entry' | 'exit'): number => {
      if (!s.feeRates) return s.fallbackCommissionRate;
      if (leg === 'exit') return s.feeRates.taker;
      return executionMode === 'limit' ? s.feeRates.maker : s.feeRates.taker;
    };
    const applyEntryFill = (s: SymbolState, side: 'buy' | 'sell', rawEntry: number): number =>
      side === 'buy' ? rawEntry * (1 + s.slipRate) : rawEntry * (1 - s.slipRate);
    const applyExitSlippage = (s: SymbolState, side: 'buy' | 'sell', rawExit: number): number =>
      side === 'buy' ? rawExit * (1 - s.slipRate) : rawExit * (1 + s.slipRate);
    const computePnl = (
      s: SymbolState,
      side: 'buy' | 'sell',
      entryFill: number,
      exitFill: number,
      qty: number,
    ): number => {
      const dir = side === 'buy' ? 1 : -1;
      const gross = (exitFill - entryFill) * qty * dir;
      const commission =
        entryFill * qty * commissionRateFor(s, 'entry') +
        exitFill * qty * commissionRateFor(s, 'exit');
      return gross - commission;
    };

    /**
     * Advance one symbol by exactly one bar. Drains its pending signals into
     * the *shared* book (portfolio cap + cluster cap), runs that symbol's
     * lifecycle / exits, then evaluates its strategies and queues next-bar
     * signals. All accounting mutates the shared closures above.
     */
    const processBar = (s: SymbolState): void => {
      const latest = s.filtered[s.cursor];
      s.cursor += 1;
      s.window.push(latest);
      s.lastClose = latest.close;
      const window = s.window;
      const inEvalWindow = latest.timestamp >= evalStart;

      // ── (A) Fill signals queued on this symbol's previous bar at this
      // bar's open (TRA-420 §4 next-bar-open fill).
      for (const signal of s.pendingSignals) {
        const alreadyOpen = positions.getOpen().some(
          p => p.symbol === signal.symbol && p.signalType === signal.type,
        );
        if (alreadyOpen) continue;

        // Shared count / sector concentration cap over the whole basket.
        const admit = admitsUnderPortfolioCap(
          signal,
          positions.getOpen().map(p => ({ symbol: p.symbol, signalType: p.signalType })),
          config.portfolioOpts,
        );
        if (admit) {
          skippedConcentration += 1;
          continue;
        }

        let riskPct: number | undefined;

        // TRA-430 vol-/Kelly-scaled per-trade risk (TRA-428 §3). σ_sym is the
        // trailing realised vol of fully-closed strategy-timeframe closes —
        // `window` ends on the fill bar, whose close is excluded (§3.2).
        let volKellyEffRiskPct: number | null = null;
        if (volKellyEnabled) {
          const closedCloses = window.slice(0, -1).map(c => c.close);
          const sigmaSym = trailingRealisedVol(
            closedCloses,
            volKellyConfig.volWindowBars,
            volKellyConfig.barsPerYear,
          );
          const expectancy =
            volKellyExpectancy[`${signal.type}|${signal.symbol}`] ??
            volKellyExpectancy[signal.symbol];
          volKellyEffRiskPct = effectiveRiskPct(volKellyConfig, sigmaSym, expectancy);
          volKellyApplied += 1;
          volKellyEffRiskPctSum += volKellyEffRiskPct;
          riskPct = volKellyEffRiskPct;
        }

        const qty = volKellyEffRiskPct === 0
          ? 0
          : s.risk.sizeFromStop(signal.entryPrice, signal.stopLoss, { riskPct });
        if (volKellyEffRiskPct === 0) volKellyZeroEdgeSkipped += 1;

        // ── TRA-423 cluster-cap admission over the SHARED book. The open
        // snapshot spans every symbol, so a candidate in a correlated cluster
        // (e.g. SOL-USD entering while BTC-USD positions are open) is sized
        // against the cross-symbol cluster risk / notional headroom.
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
            finalQty = s.fractionalQuantity
              ? Math.floor(qty * decision.scale * 1e8) / 1e8
              : Math.floor(qty * decision.scale);
          }
        }

        if (finalQty > 0) {
          const opened = positions.open(signal, finalQty);
          entryFills.set(opened.id, applyEntryFill(s, signal.side, latest.open));
          positions.setLifecycle(opened.id, initLifecycleState(opened, window));
        }
      }
      s.pendingSignals = [];

      // ── Per-bar lifecycle for THIS symbol's open positions: trailing-stop
      // ratchets ahead of the SL/TP check (mirrors runner.ts).
      const ownOpen = (): Position[] =>
        positions.getOpen().filter(p => p.symbol === s.symbol);
      for (const pos of ownOpen()) {
        const ls = positions.getLifecycle(pos.id);
        if (!ls) continue;
        ls.barsHeld += 1;
        advanceExtreme(ls, pos, latest);

        if (pos.signalType === 'momentum') {
          const donchianPeriod = pos.side === 'sell'
            ? momentumTrailPeriodFor('sell')
            : config.momentumOpts?.donchianPeriod ?? momentumTrailPeriodFor('buy');
          const newStop = momentumTrailStop(pos, window, donchianPeriod);
          if (newStop !== null) {
            positions.updateStop(pos.id, newStop);
            ls.trailed = true;
          }
        } else if (pos.signalType === 'breakout_vol') {
          const sideOpts = breakoutTrailOptionsFor(pos.side);
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

      for (const pos of ownOpen()) {
        const ls = positions.getLifecycle(pos.id);
        const hitsStop = pos.side === 'buy'
          ? latest.low <= pos.stopLoss
          : latest.high >= pos.stopLoss;
        const hitsTarget = pos.side === 'buy'
          ? latest.high >= pos.takeProfit
          : latest.low <= pos.takeProfit;

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

        const cap = timeStopBarsFor(pos.signalType, pos.side);
        if (ls && cap !== null && ls.barsHeld >= cap) {
          exitsThisBar.push({ pos, rawExit: latest.close, reason: 'time_stop', ambiguous: false });
        }
      }

      for (const ex of exitsThisBar) {
        const { pos, rawExit, reason, ambiguous, pessimisticRawExit } = ex;
        const entryFill = entryFills.get(pos.id) ?? pos.entryPrice;
        const stopForR = positions.getLifecycle(pos.id)?.initialStopLoss ?? pos.stopLoss;
        const optimisticFill = applyExitSlippage(s, pos.side, rawExit);
        const optimisticPnl = computePnl(s, pos.side, entryFill, optimisticFill, pos.quantity);

        const closed = positions.close(pos.id, rawExit, reason);
        closed.entryPrice = entryFill;
        closed.exitPrice = optimisticFill;
        closed.pnl = optimisticPnl;
        entryFills.delete(pos.id);
        closedTrades.push(closed);
        tradeRs.push(tradeR(pos.side, entryFill, optimisticFill, stopForR));

        if (ambiguous && pessimisticRawExit !== undefined) {
          ambiguousTrades += 1;
          const pessimisticFill = applyExitSlippage(s, pos.side, pessimisticRawExit);
          worstCaseTotalPnl += computePnl(s, pos.side, entryFill, pessimisticFill, pos.quantity);
        } else {
          worstCaseTotalPnl += optimisticPnl;
        }
        runningEquity += optimisticPnl;
      }

      // ── (E) Evaluate this symbol's strategies and queue next-bar signals.
      const signals = s.bundle.evaluate(s.symbol, window);
      if (inEvalWindow) {
        for (const signal of signals) {
          if (!seenSignalIds.has(signal.id)) {
            seenSignalIds.add(signal.id);
            signalLog.push({ signal, symbol: s.symbol, barIndex: s.cursor - 1 });
          }
          s.pendingSignals.push(signal);
        }
      }
    };

    // ── Drive the merged timeline. At each tick, every symbol with a bar at
    // that timestamp advances once (fixed symbol order for determinism); then
    // the portfolio is marked to market off each symbol's latest close.
    for (const ts of timeline) {
      for (const symbol of symbols) {
        const s = stateBySymbol.get(symbol)!;
        if (s.cursor < s.filtered.length && s.filtered[s.cursor].timestamp === ts) {
          processBar(s);
        }
      }

      // Portfolio mark-to-market — sum unrealized PnL across every open
      // position using its symbol's most recent close. Recorded only inside
      // the eval window so warmup bars do not dilute the Sharpe series.
      if (ts >= evalStart) {
        let unrealized = 0;
        for (const pos of positions.getOpen()) {
          const close = stateBySymbol.get(pos.symbol)?.lastClose;
          if (close === null || close === undefined) continue;
          const entryFill = entryFills.get(pos.id) ?? pos.entryPrice;
          const dir = pos.side === 'buy' ? 1 : -1;
          unrealized += (close - entryFill) * pos.quantity * dir;
        }
        const mtmEquity = runningEquity + unrealized;
        peakEquity = Math.max(peakEquity, mtmEquity);
        if (peakEquity > 0) {
          const drawdown = (peakEquity - mtmEquity) / peakEquity;
          if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
        barReturns.push(prevMtmEquity > 0 ? (mtmEquity - prevMtmEquity) / prevMtmEquity : 0);
        prevMtmEquity = mtmEquity;
      }
    }

    // ── Aggregate metrics.
    const winners = closedTrades.filter(t => (t.pnl ?? 0) > 0);
    const losers = closedTrades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closedTrades.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? winners.length / closedTrades.length : 0;
    const grossProfit = winners.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losers.reduce((acc, t) => acc + (t.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0 ? Infinity : 0;

    const barsPerYear = barIntervalMs ? MS_PER_YEAR / barIntervalMs : 252;
    let sharpeRatio = 0;
    if (barReturns.length > 1) {
      const meanRet = barReturns.reduce((acc, r) => acc + r, 0) / barReturns.length;
      const variance = barReturns.reduce((acc, r) => acc + (r - meanRet) ** 2, 0) / (barReturns.length - 1);
      const stdRet = Math.sqrt(variance);
      sharpeRatio = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(barsPerYear) : 0;
    } else if (tradeRs.length > 1) {
      const meanR = tradeRs.reduce((acc, r) => acc + r, 0) / tradeRs.length;
      const varR = tradeRs.reduce((acc, r) => acc + (r - meanR) ** 2, 0) / (tradeRs.length - 1);
      const stdR = Math.sqrt(varR);
      sharpeRatio = stdR > 0 ? meanR / stdR : 0;
    }

    const expectancy = tradeRs.length > 0
      ? tradeRs.reduce((acc, r) => acc + r, 0) / tradeRs.length
      : 0;

    const lookahead = config.signalEdgeOpts?.lookaheadBars ?? DEFAULT_LOOKAHEAD_BARS;
    let reachedCount = 0;
    for (const { signal, symbol, barIndex } of signalLog) {
      const filtered = stateBySymbol.get(symbol)?.filtered ?? [];
      const future = filtered.slice(barIndex + 1, barIndex + 1 + lookahead);
      if (reachedOneR(signal, future)) reachedCount += 1;
    }
    const signalEdge: SignalEdge = {
      reachedOneR: reachedCount,
      totalSignals: signalLog.length,
      hitRatePct: signalLog.length > 0 ? (reachedCount / signalLog.length) * 100 : 0,
      lookaheadBars: lookahead,
    };

    const bySymbol: Record<string, PortfolioSymbolResult> = {};
    for (const symbol of symbols) {
      const symTrades = closedTrades.filter(t => t.symbol === symbol);
      const symWinners = symTrades.filter(t => (t.pnl ?? 0) > 0);
      bySymbol[symbol] = {
        totalTrades: symTrades.length,
        totalPnl: symTrades.reduce((acc, t) => acc + (t.pnl ?? 0), 0),
        winners: symWinners.length,
        losers: symTrades.length - symWinners.length,
      };
    }

    return {
      config,
      trades: closedTrades,
      totalPnl,
      winRate,
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
      barIntervalMs,
      bySymbol,
    };
  }
}
