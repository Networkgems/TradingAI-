import { ReversalStrategy, MacdBollingerStrategy, ScalpingStrategy, SwingStrategy } from '@trading-app/engine';
import { CRYPTO_WATCHLIST } from '@trading-app/shared';
import type { TradeSignal, Candle, AccountState, Position, CryptoEngineState, NewsItem, AccountSettings } from '@trading-app/shared';
import { fetchCryptoMinuteBars, fetchCryptoDailyBars, fetchCryptoQuotes, fetchCryptoNews } from './crypto-feed.js';
import { CryptoPaperAccount } from './crypto-account.js';

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
  private initialEquity: number;

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
  private handlers: CryptoEngineEventHandler[] = [];
  private autoTradingEnabled = true;

  constructor(settings?: AccountSettings) {
    const equity = settings?.mode === 'demo' ? (settings.demoEquityCrypto ?? settings.demoEquity ?? 25_000) : 0;
    this.initialEquity = equity;
    this.account = new CryptoPaperAccount(equity);
  }

  applySettings(settings: AccountSettings): void {
    const equity = settings.mode === 'demo' ? (settings.demoEquityCrypto ?? settings.demoEquity) : 0;
    this.initialEquity = equity;
    this.account.reset(equity);
    this.recentSignals = [];
    this.allClosedPositions = [];
  }

  onTick(handler: CryptoEngineEventHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
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
    this.tick().catch(() => {});
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

  private async tick(): Promise<void> {
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
      });
    }

    const closed = this.account.checkExits(prices);
    if (closed.length > 0) {
      this.allClosedPositions.push(...closed);
    }

    for (const sym of activeSymbols) {
      await this.refreshCandles(sym);
      await this.refreshDailyCandles(sym);
    }

    if (this.autoTradingEnabled) for (const sym of activeSymbols) {
      const candles = this.candleCache.get(sym) ?? [];
      const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

      if (candles.length < 35) continue; // MacdBollinger needs 35 bars minimum

      const reversalSignal = this.reversal.evaluate(sym, candles);
      const macdSignal = this.macdBollinger.evaluate(sym, candles);
      const scalpingSignal = this.scalping.evaluate(sym, candles);
      const swingSignal = dailyCandles.length >= 205 ? this.swing.evaluate(sym, dailyCandles) : null;

      for (const signal of [reversalSignal, macdSignal, scalpingSignal, swingSignal]) {
        if (!signal) continue;
        if (this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000,
        );
        if (recent) continue;

        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        const price = prices.get(sym);
        if (price) this.account.openPosition(signal, price);
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
    const accountBase = this.account.getState();
    const account: AccountState = {
      ...accountBase,
      weeklyPnl: 0,
      monthlyPnl: 0,
      yearlyPnl: 0,
      allTimePnl: accountBase.totalEquity - this.initialEquity,
    };

    return {
      symbols: Array.from(this.symbolState.values()).filter(s => !this.hiddenSymbols.has(s.symbol)),
      signals: [...this.recentSignals],
      account,
      closedPositions: [...this.allClosedPositions].slice(-20),
      news: [...this.newsCache],
      lastTick: Date.now(),
      autoTradingEnabled: this.autoTradingEnabled,
    };
  }

  setAutoTrading(enabled: boolean): void {
    this.autoTradingEnabled = enabled;
  }

  manualClosePosition(positionId: string, currentPrice: number): Position | null {
    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) this.allClosedPositions.push(closed);
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
}
