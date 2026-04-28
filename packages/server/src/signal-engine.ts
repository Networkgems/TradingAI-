import { OrbStrategy, ReversalStrategy, MacdBollingerStrategy, IchimokuStrategy } from '@trading-app/engine';
import { WATCHLIST, MANAGED_ACCOUNT_RATIO, MAX_CONSECUTIVE_LOSSES, DAILY_DRAWDOWN_HALT_PCT, isStockMarketOpen } from '@trading-app/shared';
import type { TradeSignal, Candle, OptionsAccountState, SignalType, Position, AccountSettings, AccountState, NewsItem } from '@trading-app/shared';
import { fetchMinuteBars, fetchQuotes, fetchStocksNews, isYahooBreakerOpen } from './yahoo-feed.js';
import { PaperAccount } from './paper-account.js';
import { PaperOptionsAccount } from './options-account.js';
import type { DailySignalRecord } from './reports/eod-report.js';
import type { PnlTracker } from './pnl-tracker.js';

export interface SymbolState {
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
   */
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
}

export interface EngineState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: ReturnType<PaperAccount['checkExits']>;
  options: OptionsAccountState;
  lastTick: number;
  /** True when the daily risk circuit-breaker has halted new entries. */
  tradingHalted: boolean;
  haltReason: string | null;
  autoTradingEnabled: boolean;
  /** True when US stock market is currently open (weekdays 9:30 AM–4 PM ET). */
  marketOpen: boolean;
}

export type EngineEventHandler = (state: EngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;

/**
 * Tracks daily consecutive losses and cumulative P&L to enforce circuit-breakers:
 *   • Halt after MAX_CONSECUTIVE_LOSSES (3) consecutive losing trades
 *   • Halt if daily drawdown exceeds DAILY_DRAWDOWN_HALT_PCT (8%) of managed equity
 */
class DailyRiskGovernor {
  private consecutiveLosses = 0;
  private dailyPnl = 0;
  private currentDay = new Date().toISOString().slice(0, 10);
  private halted = false;
  private haltReason: string | null = null;

  private resetIfNewDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.consecutiveLosses = 0;
      this.dailyPnl = 0;
      this.halted = false;
      this.haltReason = null;
      this.currentDay = today;
    }
  }

  recordTrade(pnl: number, managedEquity: number): void {
    this.resetIfNewDay();
    this.dailyPnl += pnl;

    if (pnl < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0; // reset streak on a win
    }

    if (!this.halted && this.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      this.halted = true;
      this.haltReason = `${MAX_CONSECUTIVE_LOSSES} consecutive losses — no new entries for the day`;
    }

    const drawdownPct = managedEquity > 0 ? Math.abs(this.dailyPnl) / managedEquity : 0;
    if (!this.halted && this.dailyPnl < 0 && drawdownPct >= DAILY_DRAWDOWN_HALT_PCT) {
      this.halted = true;
      this.haltReason = `Daily drawdown −${(drawdownPct * 100).toFixed(1)}% exceeded ${DAILY_DRAWDOWN_HALT_PCT * 100}% limit`;
    }
  }

  isHalted(): boolean {
    this.resetIfNewDay();
    return this.halted;
  }

  getHaltReason(): string | null {
    return this.haltReason;
  }
}

export class SignalEngine {
  private readonly orb = new OrbStrategy({ rangeMinutes: 30, minVolume: 5_000 });
  private readonly reversal = new ReversalStrategy();
  private readonly macdBollinger = new MacdBollingerStrategy();
  private readonly ichimoku = new IchimokuStrategy();
  private account: PaperAccount;
  private optionsAccount: PaperOptionsAccount;
  private readonly riskGovernor = new DailyRiskGovernor();
  private readonly tracker: PnlTracker | undefined;

  private symbolState: Map<string, SymbolState> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  private allClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;

  private dailySignals: DailySignalRecord[] = [];
  private positionSignalType: Map<string, SignalType> = new Map();

  private dynamicSymbols: Set<string> = new Set();
  private hiddenSymbols: Set<string> = new Set();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private handlers: EngineEventHandler[] = [];
  private autoTradingEnabled = true;
  private mode: 'demo' | 'live' = 'demo';

  constructor(settings?: AccountSettings, tracker?: PnlTracker) {
    this.tracker = tracker;
    this.mode = settings?.mode === 'live' ? 'live' : 'demo';
    // Demo state is always loaded internally so a live → demo switch can
    // restore positions, equity, and dailyPnl without rebasing to the default
    // starting balance. Live mode masks this state via getState().
    const hasSaved = tracker?.hasSavedState() ?? false;
    const stocksEquity = settings ? (settings.demoEquityStocks ?? settings.demoEquity) : undefined;
    const initialEquity = stocksEquity ?? 25_000;
    const currentEquity = hasSaved ? tracker!.getSavedEquity() : initialEquity;
    const dailyPnl = hasSaved ? currentEquity - tracker!.getOpeningEquity() : 0;
    this.account = new PaperAccount({
      initialEquity,
      currentEquity,
      dailyPnl,
      managedAccountRatio: settings?.managedAccountRatio,
      riskPerTrade: settings?.riskPerTrade,
    });
    this.optionsAccount = new PaperOptionsAccount({
      initialEquity: currentEquity,
      managedAccountRatio: settings?.managedAccountRatio,
      dailyTradesLimit: settings?.dailyTradesLimit,
    });
  }

  /**
   * Apply settings WITHOUT wiping today's trades, signals, or P&L.
   *
   * - Demo equity changes rebase cash/equity by the delta so the new starting
   *   balance takes effect immediately while preserving open positions and
   *   dailyPnl. The new equity is persisted via the tracker so it survives
   *   a server restart.
   * - Switching to live mode preserves the demo state internally and masks it
   *   to zero via getState() (no broker connected). Switching back to demo
   *   restores positions, equity, and dailyPnl untouched.
   * - Risk parameters (managedAccountRatio, riskPerTrade, dailyTradesLimit)
   *   update live without touching positions.
   *
   * Use {@link forceReset} for the explicit "Reset Demo Account" hard reset.
   */
  applySettings(settings: AccountSettings): void {
    this.mode = settings.mode === 'live' ? 'live' : 'demo';
    this.account.updateConfig({
      managedAccountRatio: settings.managedAccountRatio,
      riskPerTrade: settings.riskPerTrade,
    });
    this.optionsAccount.updateConfig({
      managedAccountRatio: settings.managedAccountRatio,
      dailyTradesLimit: settings.dailyTradesLimit,
    });
    if (this.mode === 'live') {
      // Live mode: leave account/options/tracker untouched so the demo state
      // (equity, positions, dailyPnl) is preserved for a later switch back.
      return;
    }
    const targetEquity = settings.demoEquityStocks ?? settings.demoEquity;
    this.account.applyEquity(targetEquity);
    this.optionsAccount.applyEquity(targetEquity);
    if (this.tracker) {
      this.tracker.setInitialEquity(targetEquity);
      const accountState = this.account.getState();
      this.tracker.saveEquity(
        accountState.totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
      // Realign persisted openingEquity so a server restart doesn't synthesize
      // phantom dailyPnl from the equity rebase (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(accountState.totalEquity, accountState.dailyPnl);
    }
  }

  /**
   * Explicit full reset — clears positions, signals, and dailyPnl, and resets
   * equity to the configured starting balance (NOT the persisted equity).
   * This is what "Reset Demo Account" should do: wipe everything and start fresh.
   */
  forceReset(settings: AccountSettings): void {
    const equity = settings.mode === 'live' ? 0 : (settings.demoEquityStocks ?? settings.demoEquity);
    this.account.reset({
      initialEquity: equity,
      managedAccountRatio: settings.managedAccountRatio,
      riskPerTrade: settings.riskPerTrade,
    });
    this.optionsAccount.reset({
      initialEquity: equity,
      managedAccountRatio: settings.managedAccountRatio,
      dailyTradesLimit: settings.dailyTradesLimit,
    });
    this.allClosedPositions = [];
    this.recentSignals = [];
    this.dailySignals = [];
    this.positionSignalType.clear();
    if (this.tracker) {
      this.tracker.setInitialEquity(equity);
      this.tracker.saveEquity(equity, this.optionsAccount.getState().optionsPnl);
      // Hard-reset openingEquity to the new starting balance so a post-reset
      // restart reports dailyPnl = 0 (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(equity, 0);
    }
  }

  onTick(handler: EngineEventHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    // Pre-seed symbolState so clients that connect before the first tick see all expected symbols.
    // Entries with lastUpdated=0 signal "loading" to the UI.
    for (const sym of this.getActiveSymbols()) {
      if (!this.symbolState.has(sym)) {
        this.symbolState.set(sym, { symbol: sym, price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 });
      }
    }
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  refresh(): void {
    this.tick().catch((err: unknown) => {
      console.error('[signal-engine] refresh tick error:', err instanceof Error ? err.message : String(err));
    });
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.doTick();
    } catch (err: unknown) {
      console.error('[signal-engine] tick error:', err instanceof Error ? err.message : String(err));
    } finally {
      this.tickRunning = false;
    }
  }

  private async doTick(): Promise<void> {
    if (Date.now() - this.lastNewsRefresh > NEWS_REFRESH_MS) {
      const news = await fetchStocksNews();
      if (news.length > 0) this.newsCache = news;
      this.lastNewsRefresh = Date.now();
    }

    const activeSymbols = this.getActiveSymbols();
    const quotes = await fetchQuotes(activeSymbols);

    const prices = new Map<string, number>();
    for (const [sym, q] of quotes) {
      prices.set(sym, q.price);
      this.symbolState.set(sym, {
        symbol: sym,
        price: q.price,
        volume: q.volume,
        change: q.change,
        changePct: q.changePct,
        lastUpdated: Date.now(),
        quoteStatus: 'ok',
      });
    }
    // For symbols we attempted but couldn't quote, surface a status so the watchlist
    // UI can show "Quote unavailable" instead of a permanent "Loading…" spinner.
    const breakerOpen = isYahooBreakerOpen();
    for (const sym of activeSymbols) {
      if (quotes.has(sym)) continue;
      const prev = this.symbolState.get(sym);
      this.symbolState.set(sym, {
        symbol: sym,
        price: prev?.price ?? 0,
        volume: prev?.volume ?? 0,
        change: prev?.change ?? 0,
        changePct: prev?.changePct ?? 0,
        lastUpdated: prev?.lastUpdated ?? 0,
        quoteStatus: breakerOpen ? 'rate_limited' : 'unavailable',
      });
    }

    // Broadcast watchlist state early so the UI populates without waiting for candles
    if (this.symbolState.size > 0) {
      const earlyState = this.getState();
      for (const h of this.handlers) h(earlyState);
    }

    // Live mode: keep market data flowing so the UI shows live quotes, but
    // freeze the demo account — no new positions, no exits. This way the demo
    // state the user left is exactly what they see when they switch back.
    if (this.mode === 'live') {
      for (const h of this.handlers) h(this.getState());
      return;
    }

    const closed = this.account.checkExits(prices);
    if (closed.length > 0) {
      this.allClosedPositions.push(...closed);
      const accountState = this.account.getState();
      const managedEquity = accountState.totalEquity * MANAGED_ACCOUNT_RATIO;
      // Annotate daily signal records with outcomes and feed risk governor
      for (const pos of closed) {
        const sigType = this.positionSignalType.get(pos.id);
        const rec = this.dailySignals.find(s => s.symbol === pos.symbol && s.type === sigType);
        if (rec && rec.outcome == null) {
          rec.outcome = (pos.pnl ?? 0) > 0 ? 'win' : 'loss';
          const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
          rec.rr = risk > 0 ? Math.abs(pos.pnl ?? 0) / risk : 0;
        }
        // Feed daily risk governor with the closed trade's P&L
        this.riskGovernor.recordTrade(pos.pnl ?? 0, managedEquity);
      }
      // Persist equity after equity positions close
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }
    const optsClosed = this.optionsAccount.checkExits(prices);
    if (optsClosed.length > 0) {
      // Persist equity after options positions close
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }

    // Fetch candles in parallel batches to avoid 25+ second sequential delay for 25 symbols
    const CANDLE_BATCH = 5;
    for (let i = 0; i < activeSymbols.length; i += CANDLE_BATCH) {
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshCandles(sym)),
      );
    }

    // If auto trading is disabled or daily risk circuit-breaker is active, skip new entries
    if (this.autoTradingEnabled && !this.riskGovernor.isHalted()) {
      let symbolsWithData = 0;
      // Run strategies and collect new signals
      for (const sym of activeSymbols) {
        const candles = this.candleCache.get(sym) ?? [];
        if (candles.length < 15) continue;
        symbolsWithData++;

        const orbSignal = this.orb.evaluate(sym, candles);
        const reversalSignal = this.reversal.evaluate(sym, candles);
        const macdSignal = this.macdBollinger.evaluate(sym, candles);
        const ichimokuSignal = this.ichimoku.evaluate(sym, candles);

        for (const signal of [orbSignal, reversalSignal, macdSignal, ichimokuSignal]) {
          if (!signal) continue;
          // Skip if an equity position for this symbol+strategy type is already open
          if (this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
          // Deduplicate: skip if same symbol+type signal emitted in last 5 minutes
          const recent = this.recentSignals.find(
            s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000
          );
          if (recent) continue;

          // TRA-134: Don't dedup the signal until we know whether a quote was available.
          // Without a quote we can't open a position; previously the signal was added to
          // `recentSignals` anyway, then the 5-minute dedup blocked any retry, so the user
          // saw the same signal fire every 5 minutes for hours with zero positions opened.
          const price = prices.get(sym);
          if (!price) {
            console.warn(`[signal-engine] ${sym} ${signal.type}: no quote in cache — skipping (will retry next tick)`);
            continue;
          }

          this.recentSignals.unshift(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

          // Auto-open equity paper position
          const pos = this.account.openPosition(signal, price);
          if (pos) this.positionSignalType.set(pos.id, signal.type);
          // Auto-open options paper position (call for buy, put for sell)
          this.optionsAccount.openOption(signal, price);

          // Record signal for daily accuracy tracking
          this.dailySignals.push({
            id: signal.id,
            symbol: signal.symbol,
            type: signal.type,
            firedAt: signal.timestamp,
          });
        }
      }
      if (symbolsWithData === 0 && activeSymbols.length > 0) {
        console.warn('[signal-engine] tick: no symbols had sufficient candle data (market closed or data unavailable)');
      }
    }

    for (const h of this.handlers) h(this.getState());
  }

  /** Build account state augmented with cumulative P&L pulled from the tracker. */
  private buildAccountState(): AccountState {
    const base = this.account.getState();
    if (!this.tracker) return base;
    const stats = this.tracker.getCumulativeStats(base.totalEquity);
    return {
      ...base,
      weeklyPnl: stats.weeklyPnl,
      monthlyPnl: stats.monthlyPnl,
      yearlyPnl: stats.yearlyPnl,
      allTimePnl: stats.allTimePnl,
    };
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchMinuteBars(symbol, 80);
    if (bars.length > 0) this.candleCache.set(symbol, bars);
  }

  getActiveSymbols(): string[] {
    const base = (WATCHLIST as readonly string[]).filter(s => !this.hiddenSymbols.has(s));
    return [...base, ...Array.from(this.dynamicSymbols).filter(s => !base.includes(s))];
  }

  addSymbol(symbol: string): void {
    this.hiddenSymbols.delete(symbol);
    if (!(WATCHLIST as readonly string[]).includes(symbol)) {
      this.dynamicSymbols.add(symbol);
    }
  }

  removeSymbol(symbol: string): void {
    if ((WATCHLIST as readonly string[]).includes(symbol)) {
      this.hiddenSymbols.add(symbol);
    } else {
      this.dynamicSymbols.delete(symbol);
    }
    this.symbolState.delete(symbol);
  }

  setAutoTrading(enabled: boolean): void {
    this.autoTradingEnabled = enabled;
  }

  manualClosePosition(positionId: string, currentPrice: number): Position | null {
    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      this.allClosedPositions.push(closed);
      this.riskGovernor.recordTrade(closed.pnl ?? 0, this.account.managedEquity());
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }
    return closed;
  }

  manualCloseOption(optionId: string): import('@trading-app/shared').OptionPosition | null {
    const closed = this.optionsAccount.closeOption(optionId);
    if (closed) {
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }
    return closed;
  }

  getState(): EngineState {
    const symbols = Array.from(this.symbolState.values()).filter(s => !this.hiddenSymbols.has(s.symbol));
    if (this.mode === 'live') {
      // Live mode: no broker is connected, so account, positions, and options
      // display as zero/empty. The internal demo state stays preserved for a
      // later switch back to demo.
      return {
        symbols,
        signals: [...this.recentSignals],
        account: { totalEquity: 0, availableCash: 0, openPositions: [], dailyPnl: 0 },
        closedPositions: [],
        options: { openOptions: [], closedOptions: [], optionsPnl: 0, optionsCash: 0, dailyOptionsCount: 0 },
        lastTick: Date.now(),
        tradingHalted: false,
        haltReason: null,
        autoTradingEnabled: this.autoTradingEnabled,
        marketOpen: isStockMarketOpen(),
      };
    }
    return {
      symbols,
      signals: [...this.recentSignals],
      account: this.buildAccountState(),
      closedPositions: [...this.allClosedPositions].slice(-20),
      options: this.optionsAccount.getState(),
      lastTick: Date.now(),
      tradingHalted: this.riskGovernor.isHalted(),
      haltReason: this.riskGovernor.getHaltReason(),
      autoTradingEnabled: this.autoTradingEnabled,
      marketOpen: isStockMarketOpen(),
    };
  }

  getNews(): NewsItem[] {
    return [...this.newsCache];
  }

  getReportSnapshot() {
    return {
      state: this.getState(),
      allClosedPositions: [...this.allClosedPositions],
      dailySignals: [...this.dailySignals],
      signalTypeMap: new Map(this.positionSignalType),
    };
  }

  getEquitySnapshot() {
    return {
      equity: this.account.getState().totalEquity,
      optionsPnl: this.optionsAccount.getState().optionsPnl,
    };
  }
}
