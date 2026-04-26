import { ReversalStrategy, MacdBollingerStrategy, OrbStrategy } from '@trading-app/engine';
import { CRYPTO_WATCHLIST, isValidCryptoTradingWindow } from '@trading-app/shared';
import type { TradeSignal, Candle, AccountState, Position, CryptoEngineState, NewsItem, AccountSettings } from '@trading-app/shared';
import { fetchCryptoMinuteBars, fetchCryptoQuotes, fetchCryptoNews } from './crypto-feed.js';
import { CryptoPaperAccount } from './crypto-account.js';

export type CryptoEngineEventHandler = (state: CryptoEngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;

export class CryptoSignalEngine {
  // TRA-52: ORB disabled (24/7 incompatible, -55% avg return around the clock).
  // TRA-70: Re-enabled with session-aware filter (Asian/London/NY windows only).
  //   Range window 60 min matches crypto session structure; avoids 04:00–08:00 UTC dead zone.
  // TRA-75: enforceTimeFilter: false on Reversal/MACD-Bollinger — crypto trades 24/7.
  // MACD-Bollinger: crypto-tuned params (41.7% win rate, +1.73% avg return).
  // Reversal: stock RSI 70/30 thresholds (outperforms 60/40 for crypto).
  private readonly orb = new OrbStrategy({
    rangeMinutes: 60,
    minVolume: 1,
    volumeSpikeMultiplier: 1.5,
    timeFilter: isValidCryptoTradingWindow,
  });
  private readonly reversal = new ReversalStrategy({ enforceTimeFilter: false });
  private readonly macdBollinger = new MacdBollingerStrategy({ bbPeriod: 14, bbMultiplier: 2.5, volumeMultiplier: 1.2, enforceTimeFilter: false });
  private readonly account: CryptoPaperAccount;
  private initialEquity: number;

  private symbolState: Map<string, CryptoEngineState['symbols'][number]> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  private allClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: CryptoEngineEventHandler[] = [];
  private autoTradingEnabled = true;

  constructor(settings?: AccountSettings) {
    const equity = settings?.mode === 'demo' ? (settings.demoEquity ?? 25_000) : 0;
    this.initialEquity = equity;
    this.account = new CryptoPaperAccount(equity);
  }

  applySettings(settings: AccountSettings): void {
    const equity = settings.mode === 'demo' ? settings.demoEquity : 0;
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

  private async tick(): Promise<void> {
    const quotes = await fetchCryptoQuotes(CRYPTO_WATCHLIST);

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

    for (const sym of CRYPTO_WATCHLIST) {
      await this.refreshCandles(sym);
    }

    if (this.autoTradingEnabled) for (const sym of CRYPTO_WATCHLIST) {
      const candles = this.candleCache.get(sym) ?? [];
      if (candles.length < 35) continue; // MacdBollinger needs 35 bars minimum

      const orbSignal = this.orb.evaluate(sym, candles);
      const reversalSignal = this.reversal.evaluate(sym, candles);
      const macdSignal = this.macdBollinger.evaluate(sym, candles);

      for (const signal of [orbSignal, reversalSignal, macdSignal]) {
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
      symbols: Array.from(this.symbolState.values()),
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
