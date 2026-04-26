import { OrbStrategy, ReversalStrategy, MacdBollingerStrategy, IchimokuStrategy } from '@trading-app/engine';
import { WATCHLIST, MANAGED_ACCOUNT_RATIO, MAX_CONSECUTIVE_LOSSES, DAILY_DRAWDOWN_HALT_PCT } from '@trading-app/shared';
import type { TradeSignal, Candle, OptionsAccountState, SignalType, Position, AccountSettings, NewsItem } from '@trading-app/shared';
import { fetchMinuteBars, fetchQuotes, fetchStocksNews } from './yahoo-feed.js';
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
}

export interface EngineState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: ReturnType<PaperAccount['getState']>;
  closedPositions: ReturnType<PaperAccount['checkExits']>;
  options: OptionsAccountState;
  lastTick: number;
  /** True when the daily risk circuit-breaker has halted new entries. */
  tradingHalted: boolean;
  haltReason: string | null;
  autoTradingEnabled: boolean;
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

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: EngineEventHandler[] = [];
  private autoTradingEnabled = true;

  constructor(settings?: AccountSettings, tracker?: PnlTracker) {
    this.tracker = tracker;
    const savedEquity = tracker?.getSavedEquity();
    const config = settings
      ? {
          initialEquity: savedEquity ?? settings.demoEquity,
          managedAccountRatio: settings.managedAccountRatio,
          riskPerTrade: settings.riskPerTrade,
        }
      : { initialEquity: savedEquity };
    this.account = new PaperAccount(config);
    this.optionsAccount = new PaperOptionsAccount({
      initialEquity: savedEquity ?? settings?.demoEquity,
      managedAccountRatio: settings?.managedAccountRatio,
      dailyTradesLimit: settings?.dailyTradesLimit,
    });
  }

  /** Apply account settings and reset both accounts. Uses 0 equity for live mode (no connected brokerage). */
  applySettings(settings: AccountSettings): void {
    const equity = settings.mode === 'live' ? 0 : settings.demoEquity;
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
    if (Date.now() - this.lastNewsRefresh > NEWS_REFRESH_MS) {
      const news = await fetchStocksNews();
      if (news.length > 0) this.newsCache = news;
      this.lastNewsRefresh = Date.now();
    }

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

    for (const sym of WATCHLIST) {
      await this.refreshCandles(sym);
    }

    // If auto trading is disabled or daily risk circuit-breaker is active, skip new entries
    if (this.autoTradingEnabled && !this.riskGovernor.isHalted()) {
      // Run strategies and collect new signals
      for (const sym of WATCHLIST) {
        const candles = this.candleCache.get(sym) ?? [];
        if (candles.length < 15) continue;

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

          this.recentSignals.unshift(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

          const price = prices.get(sym);
          if (price) {
            // Auto-open equity paper position
            const pos = this.account.openPosition(signal, price);
            if (pos) this.positionSignalType.set(pos.id, signal.type);
            // Auto-open options paper position (call for buy, put for sell)
            this.optionsAccount.openOption(signal, price);
          }

          // Record signal for daily accuracy tracking
          this.dailySignals.push({
            id: signal.id,
            symbol: signal.symbol,
            type: signal.type,
            firedAt: signal.timestamp,
          });
        }
      }
    }

    const state: EngineState = {
      symbols: Array.from(this.symbolState.values()),
      signals: [...this.recentSignals],
      account: this.account.getState(),
      closedPositions: [...this.allClosedPositions].slice(-20),
      options: this.optionsAccount.getState(),
      lastTick: Date.now(),
      tradingHalted: this.riskGovernor.isHalted(),
      haltReason: this.riskGovernor.getHaltReason(),
      autoTradingEnabled: this.autoTradingEnabled,
    };

    for (const h of this.handlers) h(state);
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchMinuteBars(symbol, 80);
    if (bars.length > 0) this.candleCache.set(symbol, bars);
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
    return {
      symbols: Array.from(this.symbolState.values()),
      signals: [...this.recentSignals],
      account: this.account.getState(),
      closedPositions: [...this.allClosedPositions].slice(-20),
      options: this.optionsAccount.getState(),
      lastTick: Date.now(),
      tradingHalted: this.riskGovernor.isHalted(),
      haltReason: this.riskGovernor.getHaltReason(),
      autoTradingEnabled: this.autoTradingEnabled,
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
