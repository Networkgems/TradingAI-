import { ReversalStrategy, MacdBollingerStrategy, ScalpingStrategy, SwingStrategy, CoinbaseOrderClient } from '@trading-app/engine';
import { CRYPTO_WATCHLIST } from '@trading-app/shared';
import type { TradeSignal, Candle, AccountState, Position, CryptoEngineState, NewsItem, AccountSettings } from '@trading-app/shared';
import { fetchCryptoMinuteBars, fetchCryptoDailyBars, fetchCryptoQuotes, fetchCryptoNews } from './crypto-feed.js';
import { isYahooBreakerOpen } from './yahoo-feed.js';
import { CryptoPaperAccount } from './crypto-account.js';
import { CryptoLiveAccount } from './crypto-live-account.js';
import type { PnlTracker } from './pnl-tracker.js';

export type CryptoEngineEventHandler = (state: CryptoEngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;

export class CryptoSignalEngine {
  // TRA-52: ORB disabled (24/7 incompatible, -55% avg return around the clock).
  // TRA-70: Re-enabled with session-aware filter — reverted by TRA-106 (no true open range for crypto).
  // TRA-75: enforceTimeFilter: false on Reversal/MACD-Bollinger — crypto trades 24/7.
  // MACD-Bollinger: crypto-tuned params (41.7% win rate, +1.73% avg return).
  // Reversal: stock RSI 70/30 thresholds (outperforms 60/40 for crypto).
  // TRA-107: Scalping (1-min, 9/21 EMA + VWAP + RSI(9) + volume) and Swing (daily, 50/200 EMA + RSI(14) + MACD).
  private readonly reversal = new ReversalStrategy({ enforceTimeFilter: false });
  private readonly macdBollinger = new MacdBollingerStrategy({ bbPeriod: 14, bbMultiplier: 2.5, volumeMultiplier: 1.2, enforceTimeFilter: false });
  private readonly scalping = new ScalpingStrategy({ enforceTimeFilter: false });
  private readonly swing = new SwingStrategy();
  private readonly account: CryptoPaperAccount;
  private readonly tracker: PnlTracker | undefined;

  private symbolState: Map<string, CryptoEngineState['symbols'][number]> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private dailyCandleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  private allClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;

  private dynamicSymbols: Set<string> = new Set();
  private hiddenSymbols: Set<string> = new Set();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private handlers: CryptoEngineEventHandler[] = [];
  private autoTradingEnabled = true;
  private mode: 'demo' | 'live' = 'demo';
  /** Live broker (Coinbase) — initialised when live mode is active and creds are configured. */
  private liveAccount: CryptoLiveAccount | null = null;
  /** Last settings snapshot — kept so applySettings can re-evaluate live broker creds. */
  private currentSettings: AccountSettings | undefined;

  constructor(tracker?: PnlTracker, settings?: AccountSettings) {
    this.tracker = tracker;
    this.currentSettings = settings;
    this.mode = settings?.mode === 'live' ? 'live' : 'demo';
    // Demo state is always loaded internally so a live → demo switch can
    // restore equity, positions, and dailyPnl without rebasing to the default
    // starting balance. Live mode masks this state via getState().
    const hasSaved = tracker?.hasSavedState() ?? false;
    const cryptoStart = settings ? (settings.demoEquityCrypto ?? settings.demoEquity ?? 25_000) : 25_000;
    const initialEquity = cryptoStart;
    const currentEquity = hasSaved ? tracker!.getSavedEquity() : initialEquity;
    const openingEquityToday = hasSaved ? tracker!.getOpeningEquity() : currentEquity;
    this.account = new CryptoPaperAccount(currentEquity, openingEquityToday);
    // Set the canonical initialEquity baseline so allTimePnl reflects the user's setting.
    this.account.applyEquity(initialEquity);
    if (this.mode === 'live') this.tryInitLiveBroker();
  }

  /**
   * Build a CryptoLiveAccount from settings/env credentials. Returns null if
   * Coinbase isn't selected or credentials are missing — callers should fall
   * back to the (frozen) demo account view.
   *
   * Credential precedence: per-user settings > env vars. Env vars exist so
   * operators can configure a single shared broker (single-user installs) or
   * inject secrets without persisting them in settings.json.
   */
  private buildLiveBroker(): CryptoLiveAccount | null {
    const s = this.currentSettings;
    if (s && s.liveBrokerageType && s.liveBrokerageType !== 'coinbase') return null;
    const apiKey = (s?.liveApiKey?.trim() || process.env.COINBASE_API_KEY || '').trim();
    const apiSecret = (s?.liveApiSecret?.trim() || process.env.COINBASE_API_SECRET || '').trim();
    if (!apiKey || !apiSecret) return null;
    try {
      const client = new CoinbaseOrderClient({ apiKey, apiSecret });
      return new CryptoLiveAccount(client);
    } catch (err: unknown) {
      console.warn('[crypto-engine] Coinbase init failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private tryInitLiveBroker(): void {
    if (this.liveAccount) return;
    const broker = this.buildLiveBroker();
    if (broker) {
      this.liveAccount = broker;
      console.log('[crypto-engine] Coinbase live broker initialised — live trading active.');
      // Kick off an initial balance refresh so the first tick has cash data.
      void broker.refreshBalance();
    } else {
      console.warn('[crypto-engine] live mode active but Coinbase credentials not configured — orders will not be sent.');
    }
  }

  /**
   * Apply settings WITHOUT wiping today's trades or positions.
   * Demo equity changes rebase by the delta. Switching to live mode preserves
   * the demo state internally and masks it to zero via getState() — so a later
   * switch back to demo restores equity, positions, and dailyPnl untouched.
   * The new equity is persisted via the tracker so it survives a server restart.
   */
  applySettings(settings: AccountSettings): void {
    this.currentSettings = settings;
    this.mode = settings.mode === 'live' ? 'live' : 'demo';
    if (this.mode === 'live') {
      // Live mode: leave the demo account/tracker untouched so the demo state
      // is preserved for a later switch back. Re-initialise the live broker so
      // newly entered Coinbase credentials take effect without a server restart.
      this.liveAccount = null;
      this.tryInitLiveBroker();
      return;
    }
    // Switching back to demo — drop the live broker so we don't keep refreshing
    // Coinbase balances in the background.
    this.liveAccount = null;
    const targetEquity = settings.demoEquityCrypto ?? settings.demoEquity;
    this.account.applyEquity(targetEquity);
    if (this.tracker) {
      this.tracker.setInitialEquity(targetEquity);
      const accountState = this.account.getState();
      this.tracker.saveEquity(accountState.totalEquity, 0);
      // Realign persisted openingEquity so a server restart doesn't synthesize
      // phantom dailyPnl from the equity rebase (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(accountState.totalEquity, accountState.dailyPnl);
    }
  }

  /**
   * Full reset — clears positions, signals, and resets equity to the configured
   * starting balance (NOT the persisted equity). Used by "Reset Demo Account".
   */
  forceReset(initialEquity?: number): void {
    const equity = initialEquity ?? this.account.getInitialEquity();
    this.account.reset(equity);
    this.recentSignals = [];
    this.allClosedPositions = [];
    if (this.tracker) {
      this.tracker.setInitialEquity(equity);
      this.tracker.saveEquity(equity, 0);
      // Hard-reset openingEquity to the new starting balance so a post-reset
      // restart reports dailyPnl = 0 (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(equity, 0);
    }
  }

  onTick(handler: CryptoEngineEventHandler): void {
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
    this.tickTimer = setInterval(() => this.tick(), 60_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  refresh(): void {
    this.tick().catch((err: unknown) => {
      console.error('[crypto-engine] refresh tick error:', err instanceof Error ? err.message : String(err));
    });
  }

  getActiveSymbols(): string[] {
    const base = (CRYPTO_WATCHLIST as readonly string[]).filter(s => !this.hiddenSymbols.has(s));
    return [...base, ...Array.from(this.dynamicSymbols).filter(s => !base.includes(s))];
  }

  addSymbol(symbol: string): void {
    this.hiddenSymbols.delete(symbol);
    if (!(CRYPTO_WATCHLIST as readonly string[]).includes(symbol)) {
      this.dynamicSymbols.add(symbol);
    }
  }

  removeSymbol(symbol: string): void {
    if ((CRYPTO_WATCHLIST as readonly string[]).includes(symbol)) {
      this.hiddenSymbols.add(symbol);
    } else {
      this.dynamicSymbols.delete(symbol);
    }
    this.symbolState.delete(symbol);
  }

  // Minimum bars each strategy needs (used to gate evaluation per-symbol).
  private static readonly MIN_BARS_REVERSAL = 20;   // rsiPeriod(14) + lookback(5) + 1
  private static readonly MIN_BARS_MACD = 35;       // slowPeriod(26) + signalPeriod(9)
  private static readonly MIN_BARS_SCALPING = 23;   // max(slowEma(21)+2, volumeLookback(10)+1, rsiPeriod(9)+2)

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.doTick();
    } catch (err: unknown) {
      console.error('[crypto-engine] tick error:', err instanceof Error ? err.message : String(err));
    } finally {
      this.tickRunning = false;
    }
  }

  private async doTick(): Promise<void> {
    const activeSymbols = this.getActiveSymbols();
    const quotes = await fetchCryptoQuotes(activeSymbols);

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
    // Symbols we attempted but couldn't quote → mark unavailable so the UI shows
    // "Quote unavailable" instead of a permanent "Loading…" spinner.
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
      const earlyState = this.buildState();
      for (const h of this.handlers) h(earlyState);
    }

    // Live mode: keep market data flowing so the UI shows live quotes. If a
    // Coinbase live broker is configured, route signals/exits through it. If
    // not, freeze in place — the demo state the user left is exactly what they
    // see when they switch back.
    if (this.mode === 'live') {
      if (this.liveAccount) {
        await this.runLiveTick(prices, activeSymbols);
      }
      for (const h of this.handlers) h(this.buildState());
      return;
    }

    const closed = this.account.checkExits(prices);
    if (closed.length > 0) {
      this.allClosedPositions.push(...closed);
      this.tracker?.saveEquity(this.account.getEquity(), 0);
    }

    // Fetch candles in parallel batches to avoid 60-100s sequential delay for 50 symbols
    const CANDLE_BATCH = 5;
    for (let i = 0; i < activeSymbols.length; i += CANDLE_BATCH) {
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshCandles(sym)),
      );
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshDailyCandles(sym)),
      );
    }

    if (this.autoTradingEnabled) {
      let symbolsEvaluated = 0;
      let symbolsSkipped = 0;
      for (const sym of activeSymbols) {
        const candles = this.candleCache.get(sym) ?? [];
        const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

        // Evaluate each strategy independently with its own minimum bar requirement.
        // Previously a blanket 35-bar gate blocked Reversal (needs 20) and Scalping (needs 23).
        const reversalSignal = candles.length >= CryptoSignalEngine.MIN_BARS_REVERSAL
          ? this.reversal.evaluate(sym, candles) : null;
        const macdSignal = candles.length >= CryptoSignalEngine.MIN_BARS_MACD
          ? this.macdBollinger.evaluate(sym, candles) : null;
        const scalpingSignal = candles.length >= CryptoSignalEngine.MIN_BARS_SCALPING
          ? this.scalping.evaluate(sym, candles) : null;
        const swingSignal = dailyCandles.length >= 205
          ? this.swing.evaluate(sym, dailyCandles) : null;

        if (candles.length === 0) {
          symbolsSkipped++;
        } else {
          symbolsEvaluated++;
        }

        for (const signal of [reversalSignal, macdSignal, scalpingSignal, swingSignal]) {
          if (!signal) continue;
          if (this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
          const recent = this.recentSignals.find(
            s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000,
          );
          if (recent) continue;

          // TRA-134: Defer dedup until we know a quote is available so a missing
          // quote doesn't block the signal from retrying for 5 minutes.
          const price = prices.get(sym);
          if (!price) {
            console.warn(`[crypto-engine] ${sym} ${signal.type}: no quote in cache — skipping (will retry next tick)`);
            continue;
          }

          this.recentSignals.unshift(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

          this.account.openPosition(signal, price);
        }
      }
      if (symbolsSkipped > 0) {
        console.warn(`[crypto-engine] tick: ${symbolsEvaluated} symbols evaluated, ${symbolsSkipped} skipped (no candle data)`);
      }
    }

    if (Date.now() - this.lastNewsRefresh > NEWS_REFRESH_MS) {
      const news = await fetchCryptoNews();
      if (news.length > 0) this.newsCache = news;
      this.lastNewsRefresh = Date.now();
    }

    const state = this.buildState();
    for (const h of this.handlers) h(state);
  }

  /**
   * Live-mode tick: refresh Coinbase balance if stale, exit positions whose
   * TP/SL was hit, then evaluate strategies and open new positions on
   * Coinbase. Mirrors the demo-mode flow but every order hits the broker.
   */
  private async runLiveTick(prices: Map<string, number>, activeSymbols: string[]): Promise<void> {
    const live = this.liveAccount;
    if (!live) return;

    if (live.isStale()) {
      await live.refreshBalance();
    }

    try {
      const closed = await live.checkExits(prices);
      if (closed.length > 0) {
        this.allClosedPositions.push(...closed);
      }
    } catch (err: unknown) {
      console.warn('[crypto-engine] live exits error:', err instanceof Error ? err.message : String(err));
    }

    if (!this.autoTradingEnabled) return;

    // Refresh candle caches so live mode evaluates strategies on fresh bars.
    const CANDLE_BATCH = 5;
    for (let i = 0; i < activeSymbols.length; i += CANDLE_BATCH) {
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshCandles(sym)),
      );
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshDailyCandles(sym)),
      );
    }

    for (const sym of activeSymbols) {
      const candles = this.candleCache.get(sym) ?? [];
      const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

      const reversalSignal = candles.length >= CryptoSignalEngine.MIN_BARS_REVERSAL
        ? this.reversal.evaluate(sym, candles) : null;
      const macdSignal = candles.length >= CryptoSignalEngine.MIN_BARS_MACD
        ? this.macdBollinger.evaluate(sym, candles) : null;
      const scalpingSignal = candles.length >= CryptoSignalEngine.MIN_BARS_SCALPING
        ? this.scalping.evaluate(sym, candles) : null;
      const swingSignal = dailyCandles.length >= 205
        ? this.swing.evaluate(sym, dailyCandles) : null;

      for (const signal of [reversalSignal, macdSignal, scalpingSignal, swingSignal]) {
        if (!signal) continue;
        if (live.hasOpenPositionForSignalType(sym, signal.type)) continue;
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000,
        );
        if (recent) continue;

        const price = prices.get(sym);
        if (!price) continue;

        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        try {
          await live.openPosition(signal, price);
        } catch (err: unknown) {
          console.warn(`[crypto-engine] live open failed for ${sym}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchCryptoMinuteBars(symbol, 80);
    if (bars.length > 0) this.candleCache.set(symbol, bars);
  }

  private async refreshDailyCandles(symbol: string): Promise<void> {
    // Only refresh once per hour to avoid redundant API calls — daily bars change once per day
    const cached = this.dailyCandleCache.get(symbol);
    if (cached && cached.length > 0) {
      const lastBar = cached[cached.length - 1];
      const hourMs = 60 * 60 * 1000;
      if (Date.now() - lastBar.timestamp < hourMs) return;
    }
    const bars = await fetchCryptoDailyBars(symbol, 260);
    if (bars.length > 0) this.dailyCandleCache.set(symbol, bars);
  }

  private buildState(): CryptoEngineState {
    const symbols = Array.from(this.symbolState.values()).filter(s => !this.hiddenSymbols.has(s.symbol));
    if (this.mode === 'live') {
      // Live mode: if a Coinbase broker is configured, surface its USD-equivalent
      // cash plus the positions we've opened in this session. Otherwise show a
      // zero/empty account; the internal demo state stays preserved.
      if (this.liveAccount) {
        const ls = this.liveAccount.getState();
        const account: AccountState = {
          totalEquity: ls.totalEquity,
          availableCash: ls.availableCash,
          openPositions: ls.openPositions,
          dailyPnl: ls.dailyPnl,
          weeklyPnl: 0,
          monthlyPnl: 0,
          yearlyPnl: 0,
          allTimePnl: 0,
        };
        return {
          symbols,
          signals: [...this.recentSignals],
          account,
          closedPositions: [...this.allClosedPositions].slice(-20),
          news: [...this.newsCache],
          lastTick: Date.now(),
          autoTradingEnabled: this.autoTradingEnabled,
          marketOpen: true as const,
        };
      }
      const account: AccountState = {
        totalEquity: 0,
        availableCash: 0,
        openPositions: [],
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        yearlyPnl: 0,
        allTimePnl: 0,
      };
      return {
        symbols,
        signals: [...this.recentSignals],
        account,
        closedPositions: [],
        news: [...this.newsCache],
        lastTick: Date.now(),
        autoTradingEnabled: this.autoTradingEnabled,
        marketOpen: true as const,
      };
    }
    const accountBase = this.account.getState();
    const stats = this.tracker?.getCumulativeStats(accountBase.totalEquity);
    const account: AccountState = {
      ...accountBase,
      weeklyPnl: stats?.weeklyPnl ?? 0,
      monthlyPnl: stats?.monthlyPnl ?? 0,
      yearlyPnl: stats?.yearlyPnl ?? 0,
      allTimePnl: stats?.allTimePnl ?? (accountBase.totalEquity - this.account.getInitialEquity()),
    };

    return {
      symbols,
      signals: [...this.recentSignals],
      account,
      closedPositions: [...this.allClosedPositions].slice(-20),
      news: [...this.newsCache],
      lastTick: Date.now(),
      autoTradingEnabled: this.autoTradingEnabled,
      marketOpen: true as const,
    };
  }

  setAutoTrading(enabled: boolean): void {
    this.autoTradingEnabled = enabled;
  }

  manualClosePosition(positionId: string, currentPrice: number): Position | null {
    if (this.mode === 'live' && this.liveAccount) {
      // Route the close through Coinbase. We resolve synchronously from the
      // existing API contract, but the actual order is fired-and-forgotten;
      // failures are surfaced via console + persist into the next tick view.
      const live = this.liveAccount;
      void live.closePosition(positionId, currentPrice).then(closed => {
        if (closed) this.allClosedPositions.push(closed);
      }).catch(err => {
        console.warn(`[crypto-engine] manualClose live failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Synchronous response: optimistic close — the live broker will reconcile.
      const snapshot = live.getState().openPositions.find(p => p.id === positionId) ?? null;
      return snapshot ? { ...snapshot, exitPrice: currentPrice, closedAt: Date.now() } : null;
    }
    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      this.allClosedPositions.push(closed);
      this.tracker?.saveEquity(this.account.getEquity(), 0);
    }
    return closed;
  }

  getState(): CryptoEngineState {
    return this.buildState();
  }

  getNews(): NewsItem[] {
    return [...this.newsCache];
  }

  getReportSnapshot() {
    return {
      allClosedPositions: [...this.allClosedPositions],
      accountState: this.account.getState(),
      symbols: Array.from(this.symbolState.values()),
    };
  }

  /** Snapshot trade history + account for durable storage (TRA-140). */
  exportTradeSnapshot(): {
    closedPositions: Position[];
    recentSignals: TradeSignal[];
    account: ReturnType<CryptoPaperAccount['exportSnapshot']>;
  } {
    return {
      closedPositions: [...this.allClosedPositions],
      recentSignals: [...this.recentSignals],
      account: this.account.exportSnapshot(),
    };
  }

  /** Restore trade history + account from durable storage (TRA-140). */
  importTradeSnapshot(snap: ReturnType<CryptoSignalEngine['exportTradeSnapshot']>): void {
    this.allClosedPositions = [...snap.closedPositions];
    this.recentSignals = [...snap.recentSignals];
    this.account.importSnapshot(snap.account);
  }
}
