import { OrbStrategy, ReversalStrategy, MacdBollingerStrategy, IchimokuStrategy } from '@trading-app/engine';
import { WATCHLIST } from '@trading-app/shared';
import type { TradeSignal, Candle, OptionsAccountState, SignalType, Position, AccountSettings } from '@trading-app/shared';
import { fetchMinuteBars, fetchQuotes } from './yahoo-feed.js';
import { PaperAccount } from './paper-account.js';
import { PaperOptionsAccount } from './options-account.js';
import type { DailySignalRecord } from './reports/eod-report.js';

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
  options: OptionsAccountState;
  lastTick: number;
}

export type EngineEventHandler = (state: EngineState) => void;

const MAX_SIGNALS = 50;

export class SignalEngine {
  private readonly orb = new OrbStrategy({ rangeMinutes: 30, minVolume: 5_000 });
  private readonly reversal = new ReversalStrategy();
  private readonly macdBollinger = new MacdBollingerStrategy();
  private readonly ichimoku = new IchimokuStrategy();
  private account: PaperAccount;
  private optionsAccount: PaperOptionsAccount;

  private symbolState: Map<string, SymbolState> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  private allClosedPositions: Position[] = [];

  private dailySignals: DailySignalRecord[] = [];
  private positionSignalType: Map<string, SignalType> = new Map();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: EngineEventHandler[] = [];

  constructor(settings?: AccountSettings) {
    const config = settings
      ? {
          initialEquity: settings.demoEquity,
          managedAccountRatio: settings.managedAccountRatio,
          riskPerTrade: settings.riskPerTrade,
        }
      : {};
    this.account = new PaperAccount(config);
    this.optionsAccount = new PaperOptionsAccount({
      initialEquity: settings?.demoEquity,
      managedAccountRatio: settings?.managedAccountRatio,
      dailyTradesLimit: settings?.dailyTradesLimit,
    });
  }

  /** Apply new demo account settings and reset both accounts. */
  applySettings(settings: AccountSettings): void {
    this.account.reset({
      initialEquity: settings.demoEquity,
      managedAccountRatio: settings.managedAccountRatio,
      riskPerTrade: settings.riskPerTrade,
    });
    this.optionsAccount.reset({
      initialEquity: settings.demoEquity,
      managedAccountRatio: settings.managedAccountRatio,
      dailyTradesLimit: settings.dailyTradesLimit,
    });
    this.allClosedPositions = [];
    this.recentSignals = [];
    this.dailySignals = [];
    this.positionSignalType.clear();
  }

  onTick(handler: EngineEventHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private async tick(): Promise<void> {
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

    const closed = this.account.checkExits(prices);
    if (closed.length > 0) {
      this.allClosedPositions.push(...closed);
      for (const pos of closed) {
        const sigType = this.positionSignalType.get(pos.id);
        const rec = this.dailySignals.find(s => s.symbol === pos.symbol && s.type === sigType);
        if (rec && rec.outcome == null) {
          rec.outcome = (pos.pnl ?? 0) > 0 ? 'win' : 'loss';
          const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
          rec.rr = risk > 0 ? Math.abs(pos.pnl ?? 0) / risk : 0;
        }
      }
    }
    this.optionsAccount.checkExits(prices);

    for (const sym of WATCHLIST) {
      await this.refreshCandles(sym);
    }

    for (const sym of WATCHLIST) {
      const candles = this.candleCache.get(sym) ?? [];
      if (candles.length < 15) continue;

      const orbSignal = this.orb.evaluate(sym, candles);
      const reversalSignal = this.reversal.evaluate(sym, candles);
      const macdSignal = this.macdBollinger.evaluate(sym, candles);
      const ichimokuSignal = this.ichimoku.evaluate(sym, candles);

      for (const signal of [orbSignal, reversalSignal, macdSignal, ichimokuSignal]) {
        if (!signal) continue;
        if (this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000
        );
        if (recent) continue;

        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        const price = prices.get(sym);
        if (price) {
          const pos = this.account.openPosition(signal, price);
          if (pos) this.positionSignalType.set(pos.id, signal.type);
          this.optionsAccount.openOption(signal, price);
        }

        this.dailySignals.push({
          id: signal.id,
          symbol: signal.symbol,
          type: signal.type,
          firedAt: signal.timestamp,
        });
      }
    }

    const state: EngineState = {
      symbols: Array.from(this.symbolState.values()),
      signals: [...this.recentSignals],
      account: this.account.getState(),
      closedPositions: [...this.allClosedPositions].slice(-20),
      options: this.optionsAccount.getState(),
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
      options: this.optionsAccount.getState(),
      lastTick: Date.now(),
    };
  }

  getReportSnapshot() {
    return {
      state: this.getState(),
      allClosedPositions: [...this.allClosedPositions],
      dailySignals: [...this.dailySignals],
      signalTypeMap: new Map(this.positionSignalType),
    };
  }
}
