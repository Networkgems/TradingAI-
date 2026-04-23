import { OrbStrategy, ReversalStrategy } from '@trading-app/engine';
import { WATCHLIST } from '@trading-app/shared';
import type { TradeSignal, Candle } from '@trading-app/shared';
import { fetchMinuteBars, fetchQuotes } from './yahoo-feed.js';
import { PaperAccount } from './paper-account.js';

export interface SymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
}

export interface EngineState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: ReturnType<PaperAccount['getState']>;
  closedPositions: ReturnType<PaperAccount['checkExits']>;
  lastTick: number;
}

export type EngineEventHandler = (state: EngineState) => void;

const MAX_SIGNALS = 50;

export class SignalEngine {
  private readonly orb = new OrbStrategy({ rangeMinutes: 30, minVolume: 5_000 });
  private readonly reversal = new ReversalStrategy();
  private readonly account = new PaperAccount();

  private symbolState: Map<string, SymbolState> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  private allClosedPositions: ReturnType<PaperAccount['checkExits']> = [];

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: EngineEventHandler[] = [];

  onTick(handler: EngineEventHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    this.tick();
    // Refresh quotes every 30 seconds, candles every 2 minutes
    this.tickTimer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private async tick(): Promise<void> {
    // Fetch latest quotes for all symbols
    const quotes = await fetchQuotes(WATCHLIST);

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

    // Check TP/SL exits against latest prices
    const closed = this.account.checkExits(prices);
    if (closed.length > 0) this.allClosedPositions.push(...closed);

    // Fetch candles for strategy evaluation (fan-out with concurrency limit)
    const candlePromises = WATCHLIST.map(sym => this.refreshCandles(sym));
    await Promise.all(candlePromises);

    // Run strategies and collect new signals
    for (const sym of WATCHLIST) {
      if (this.account.hasOpenPosition(sym)) continue;
      const candles = this.candleCache.get(sym) ?? [];
      if (candles.length < 15) continue;

      const orbSignal = this.orb.evaluate(sym, candles);
      const reversalSignal = this.reversal.evaluate(sym, candles);

      for (const signal of [orbSignal, reversalSignal]) {
        if (!signal) continue;
        // Deduplicate: skip if same symbol+type signal emitted in last 5 minutes
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000
        );
        if (recent) continue;

        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        // Auto-open paper position
        const price = prices.get(sym);
        if (price) this.account.openPosition(signal, price);
      }
    }

    const state: EngineState = {
      symbols: Array.from(this.symbolState.values()),
      signals: [...this.recentSignals],
      account: this.account.getState(),
      closedPositions: [...this.allClosedPositions].slice(-20),
      lastTick: Date.now(),
    };

    for (const h of this.handlers) h(state);
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchMinuteBars(symbol, 80);
    if (bars.length > 0) this.candleCache.set(symbol, bars);
  }

  getState(): EngineState {
    return {
      symbols: Array.from(this.symbolState.values()),
      signals: [...this.recentSignals],
      account: this.account.getState(),
      closedPositions: [...this.allClosedPositions].slice(-20),
      lastTick: Date.now(),
    };
  }
}
