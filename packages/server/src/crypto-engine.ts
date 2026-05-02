import {
  ReversalStrategy,
  MacdTrendStrategy,
  BbFadeStrategy,
  ScalpingStrategy,
  SwingStrategy,
  CoinbaseOrderClient,
  RegimeDetector,
  MomentumStrategy,
  MeanReversionCryptoStrategy,
  BreakoutVolStrategy,
  StrategyRouter,
} from '@trading-app/engine';
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
/**
 * TRA-230 — drop signals from the displayed list once they're no longer
 * actionable. A signal becomes invalid when it ages past this window or when
 * the current quote crosses its stop or take-profit. 30 minutes is short
 * enough to keep the panel relevant on the 1m/5m bars crypto strategies trade.
 */
const SIGNAL_VALID_MS = 30 * 60_000;

export class CryptoSignalEngine {
  // TRA-52: ORB disabled (24/7 incompatible, -55% avg return around the clock).
  // TRA-70: Re-enabled with session-aware filter — reverted by TRA-106 (no true open range for crypto).
  // TRA-75: enforceTimeFilter: false on Reversal/MACD strategies — crypto trades 24/7.
  // TRA-107: Scalping (1-min, 9/21 EMA + VWAP + RSI(9) + volume) and Swing (daily, 50/200 EMA + RSI(14) + MACD).
  // TRA-170: split MACD-Bollinger into MacdTrend (continuation) + BbFade (mean-reversion);
  //         Reversal RSI thresholds widened to 65/35 for crypto (1h bars rarely sustain 70/30).
  private readonly reversal = new ReversalStrategy({
    enforceTimeFilter: false,
    rsiOverbought: 65,
    rsiOversold: 35,
  });
  private readonly macdTrend = new MacdTrendStrategy({ enforceTimeFilter: false });
  private readonly bbFade = new BbFadeStrategy({ enforceTimeFilter: false });
  private readonly scalping = new ScalpingStrategy({ enforceTimeFilter: false });
  private readonly swing = new SwingStrategy();
  /**
   * TRA-208: per-symbol regime-aware routers for the new strategy roster
   * (momentum / mean-reversion / breakout). Each router owns its own
   * RegimeDetector — sharing across symbols would pollute the hysteresis
   * label across uncorrelated tapes (BTC trending up while ETH ranges).
   * Lazily created on first sight of each symbol so adding a coin to the
   * watchlist mid-session doesn't require a restart.
   */
  private readonly routers = new Map<string, StrategyRouter>();
  private readonly account: CryptoPaperAccount;
  private readonly tracker: PnlTracker | undefined;

  private symbolState: Map<string, CryptoEngineState['symbols'][number]> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private dailyCandleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  // TRA-242 — split closed-positions history by account mode so the Live
  // dashboard never surfaces Demo trades and vice versa. Before this fix the
  // single shared list mixed both accounts' trade activity in `buildState`.
  private demoClosedPositions: Position[] = [];
  private liveClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;

  private dynamicSymbols: Set<string> = new Set();
  private hiddenSymbols: Set<string> = new Set();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private handlers: CryptoEngineEventHandler[] = [];
  // TRA-229 — per-mode auto-trading flags. The active flag (consulted on each
  // tick and surfaced in getState()) is whichever one matches `this.mode`.
  private autoTradingEnabledDemo = true;
  private autoTradingEnabledLive = true;
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
    // TRA-232 — push the user's risk knobs into the demo account so position
    // sizing matches the Settings page values instead of falling back to the
    // shared defaults.
    if (settings) {
      this.account.updateRiskConfig({
        managedAccountRatio: settings.managedAccountRatio,
        riskPerTrade: settings.riskPerTrade,
      });
    }
    // Constructor can't await — kick off broker init + balance refresh in the
    // background. The first tick will broadcast equity once it lands.
    if (this.mode === 'live') void this.tryInitLiveBroker();
  }

  /**
   * Build a CryptoLiveAccount from settings/env credentials. Returns null
   * when credentials are absent — callers fall back to the frozen demo view.
   *
   * Coinbase is the only crypto broker this engine knows how to drive, so we
   * intentionally do NOT gate on `settings.liveBrokerageType` here — that
   * field is shared with the stocks engine (where it carries 'webull') and
   * defaulted to 'webull' for legacy users (DEFAULT_ACCOUNT_SETTINGS), which
   * would silently disable live crypto trading even with valid creds. The
   * presence of Coinbase creds is the actual go-live signal.
   *
   * Credential precedence: per-user settings > env vars. Env vars exist so
   * operators can configure a single shared broker (single-user installs) or
   * inject secrets without persisting them in settings.json.
   */
  private buildLiveBroker(): CryptoLiveAccount | null {
    const s = this.currentSettings;
    // Prefer the per-market crypto credentials (TRA-165) so a Webull key
    // entered on the Stocks dashboard never accidentally drives Coinbase.
    // Fall back to the legacy un-suffixed fields for users that saved before
    // the crypto/stocks split, then to env vars for single-user installs.
    const apiKey = (
      s?.liveApiKeyCrypto?.trim()
      || s?.liveApiKey?.trim()
      || process.env.COINBASE_API_KEY
      || ''
    ).trim();
    const apiSecret = (
      s?.liveApiSecretCrypto?.trim()
      || s?.liveApiSecret?.trim()
      || process.env.COINBASE_API_SECRET
      || ''
    ).trim();
    if (!apiKey || !apiSecret) return null;
    try {
      const client = new CoinbaseOrderClient({ apiKey, apiSecret });
      // Surface the auth scheme so an operator pasting a PEM private key into
      // the API Secret field can confirm it parsed as CDP (rather than silently
      // falling back to HMAC and 401-ing on every order).
      console.log(`[crypto-engine] Coinbase client built (auth=${client.getAuthScheme()}).`);
      const live = new CryptoLiveAccount(client);
      // TRA-232 — sync the live account to the user's risk knobs immediately
      // so the first order placed after a live-mode flip uses the right
      // managedAccountRatio / riskPerTrade.
      if (s) {
        live.updateRiskConfig({
          managedAccountRatio: s.managedAccountRatio,
          riskPerTrade: s.riskPerTrade,
        });
      }
      return live;
    } catch (err: unknown) {
      console.warn('[crypto-engine] Coinbase init failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Build the live broker (if creds are configured) and AWAIT the first
   * Coinbase balance refresh so callers that broadcast immediately after this
   * resolves carry the real equity instead of a transient $0 (TRA-224).
   *
   * Returns even when creds are missing or refresh fails — equity stays at 0
   * and the next tick will retry. Exceptions never propagate; refreshBalance
   * already swallows network/auth errors and just logs.
   */
  private async tryInitLiveBroker(): Promise<void> {
    if (this.liveAccount) return;
    const broker = this.buildLiveBroker();
    if (!broker) {
      console.warn('[crypto-engine] live mode active but Coinbase credentials not configured — orders will not be sent.');
      return;
    }
    this.liveAccount = broker;
    console.log('[crypto-engine] Coinbase live broker initialised — live trading active.');
    await broker.refreshBalance();
  }

  /**
   * Apply settings WITHOUT wiping today's trades or positions.
   * Demo equity changes rebase by the delta. Switching to live mode preserves
   * the demo state internally and masks it to zero via getState() — so a later
   * switch back to demo restores equity, positions, and dailyPnl untouched.
   * The new equity is persisted via the tracker so it survives a server restart.
   *
   * Async because the live-mode branch awaits the initial Coinbase balance
   * refresh — the PUT /api/account/settings handler broadcasts state right
   * after this resolves, and that broadcast must carry real equity instead of
   * a transient $0 that lingers until the 60s tick (TRA-224).
   */
  async applySettings(settings: AccountSettings): Promise<void> {
    this.currentSettings = settings;
    this.mode = settings.mode === 'live' ? 'live' : 'demo';
    // Re-read both per-mode flags so a settings PUT (which may include the
    // start/stop UI state for either mode) keeps the engine in sync.
    this.autoTradingEnabledDemo = settings.cryptoAutoTradingEnabledDemo ?? true;
    this.autoTradingEnabledLive = settings.cryptoAutoTradingEnabledLive ?? true;
    // TRA-232 — push fresh risk knobs into the demo account on every settings
    // save. The live account is rebuilt below (or via tryInitLiveBroker) and
    // picks up the same values when buildLiveBroker reads currentSettings.
    this.account.updateRiskConfig({
      managedAccountRatio: settings.managedAccountRatio,
      riskPerTrade: settings.riskPerTrade,
    });
    if (this.mode === 'live') {
      // Live mode: leave the demo account/tracker untouched so the demo state
      // is preserved for a later switch back. Re-initialise the live broker so
      // newly entered Coinbase credentials take effect without a server restart.
      this.liveAccount = null;
      await this.tryInitLiveBroker();
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
    // TRA-242 — "Reset Demo Account" only clears the Demo trade history; the
    // Live broker mirror is independent and gets its history from Coinbase.
    this.demoClosedPositions = [];
    if (this.tracker) {
      this.tracker.setInitialEquity(equity);
      this.tracker.saveEquity(equity, 0);
      // Hard-reset openingEquity to the new starting balance so a post-reset
      // restart reports dailyPnl = 0 (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(equity, 0);
    }
  }

  /**
   * Clear the displayed signal list without touching positions or equity.
   * Wired to the "Reset Signals" button (TRA-230).
   */
  clearSignals(): void {
    this.recentSignals = [];
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
  private static readonly MIN_BARS_MACD_TREND = 35; // slowPeriod(26) + signalPeriod(9)
  private static readonly MIN_BARS_BB_FADE = 28;    // bbPeriod(20) + adx warm-up
  private static readonly MIN_BARS_SCALPING = 23;   // max(slowEma(21)+2, volumeLookback(10)+1, rsiPeriod(9)+2)
  // TRA-208 router floor: momentum needs slowMaPeriod(50)+1, breakout needs
  // 50 bars to seed the regime classifier's MA, mean-reversion gates on a
  // 50-bar EMA. 50 covers all three.
  private static readonly MIN_BARS_ROUTER = 50;

  /**
   * Lazily build a per-symbol regime-aware router (TRA-208). One router per
   * symbol keeps each ticker's RegimeDetector hysteresis state isolated from
   * the others. Strategies inside the router are also per-router because
   * MomentumStrategy carries `lastFireTs` state that would otherwise be
   * shared across symbols and rate-limit cross-asset signals incorrectly.
   */
  private getRouter(symbol: string): StrategyRouter {
    let r = this.routers.get(symbol);
    if (!r) {
      const regime = new RegimeDetector();
      r = new StrategyRouter({
        regime,
        momentum: new MomentumStrategy(regime),
        meanReversion: new MeanReversionCryptoStrategy(),
        breakout: new BreakoutVolStrategy(),
      });
      this.routers.set(symbol, r);
    }
    return r;
  }

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

    // TRA-230: drop stale or stop/target-crossed signals so the Signals tab
    // only shows entries that are still actionable.
    this.pruneInvalidSignals(prices);

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
      this.demoClosedPositions.push(...closed);
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

    if (this.isAutoTradingEnabled()) {
      let symbolsEvaluated = 0;
      let symbolsSkipped = 0;
      for (const sym of activeSymbols) {
        const candles = this.candleCache.get(sym) ?? [];
        const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

        // Evaluate each strategy independently with its own minimum bar requirement.
        // Previously a blanket 35-bar gate blocked Reversal (needs 20) and Scalping (needs 23).
        const reversalSignal = candles.length >= CryptoSignalEngine.MIN_BARS_REVERSAL
          ? this.reversal.evaluate(sym, candles) : null;
        const macdTrendSignal = candles.length >= CryptoSignalEngine.MIN_BARS_MACD_TREND
          ? this.macdTrend.evaluate(sym, candles) : null;
        const bbFadeSignal = candles.length >= CryptoSignalEngine.MIN_BARS_BB_FADE
          ? this.bbFade.evaluate(sym, candles) : null;
        const scalpingSignal = candles.length >= CryptoSignalEngine.MIN_BARS_SCALPING
          ? this.scalping.evaluate(sym, candles) : null;
        const swingSignal = dailyCandles.length >= 205
          ? this.swing.evaluate(sym, dailyCandles) : null;
        // TRA-208: regime-aware router emits at most one momentum / breakout
        // / mean-reversion signal per tick. Routed alongside the legacy roster
        // above; the dedup-by-recent-signal logic below handles cross-strategy
        // overlap (e.g. router momentum + legacy macdTrend on the same bar).
        const routerSignal = candles.length >= CryptoSignalEngine.MIN_BARS_ROUTER
          ? this.getRouter(sym).evaluate(sym, candles) : null;

        if (candles.length === 0) {
          symbolsSkipped++;
        } else {
          symbolsEvaluated++;
        }

        for (const signal of [reversalSignal, macdTrendSignal, bbFadeSignal, scalpingSignal, swingSignal, routerSignal]) {
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
      const news = await fetchCryptoNews(this.getActiveSymbols());
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
        // TRA-242 — Live exits go on the Live history list so the Live
        // dashboard surfaces only Coinbase fills, not Demo paper trades.
        this.liveClosedPositions.push(...closed);
      }
    } catch (err: unknown) {
      console.warn('[crypto-engine] live exits error:', err instanceof Error ? err.message : String(err));
    }

    if (!this.isAutoTradingEnabled()) return;

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
      const macdTrendSignal = candles.length >= CryptoSignalEngine.MIN_BARS_MACD_TREND
        ? this.macdTrend.evaluate(sym, candles) : null;
      const bbFadeSignal = candles.length >= CryptoSignalEngine.MIN_BARS_BB_FADE
        ? this.bbFade.evaluate(sym, candles) : null;
      const scalpingSignal = candles.length >= CryptoSignalEngine.MIN_BARS_SCALPING
        ? this.scalping.evaluate(sym, candles) : null;
      const swingSignal = dailyCandles.length >= 205
        ? this.swing.evaluate(sym, dailyCandles) : null;
      // TRA-208: same router pipeline as the demo path so live and paper
      // produce identical regime-aware entries from the same regime state.
      const routerSignal = candles.length >= CryptoSignalEngine.MIN_BARS_ROUTER
        ? this.getRouter(sym).evaluate(sym, candles) : null;

      for (const signal of [reversalSignal, macdTrendSignal, bbFadeSignal, scalpingSignal, swingSignal, routerSignal]) {
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

  /**
   * Drop signals that are no longer actionable (TRA-230). Crypto signals are
   * always tied to the spot pair, so we can always check stop/target against
   * the current quote (no options-style premium edge case here).
   */
  private pruneInvalidSignals(prices: Map<string, number>): void {
    const cutoff = Date.now() - SIGNAL_VALID_MS;
    this.recentSignals = this.recentSignals.filter(sig => {
      if (sig.timestamp < cutoff) return false;
      const price = prices.get(sig.symbol);
      if (!price) return true;
      if (sig.side === 'buy') {
        if (price <= sig.stopLoss) return false;
        if (price >= sig.takeProfit) return false;
      } else {
        if (price >= sig.stopLoss) return false;
        if (price <= sig.takeProfit) return false;
      }
      return true;
    });
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
          // TRA-242 — Live dashboard reads only Live closed positions; the
          // Demo history stays in `demoClosedPositions` for a later switch back.
          closedPositions: [...this.liveClosedPositions].slice(-20),
          news: [...this.newsCache],
          lastTick: Date.now(),
          autoTradingEnabled: this.isAutoTradingEnabled(),
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
        autoTradingEnabled: this.isAutoTradingEnabled(),
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
      // TRA-242 — Demo dashboard reads only Demo closed positions.
      closedPositions: [...this.demoClosedPositions].slice(-20),
      news: [...this.newsCache],
      lastTick: Date.now(),
      autoTradingEnabled: this.isAutoTradingEnabled(),
      marketOpen: true as const,
    };
  }

  /**
   * Toggle auto-trading. When `mode` is omitted the engine's current mode is
   * updated; pass an explicit mode to update the inactive-mode preference
   * (e.g. so the live-trading flag persists while the user is on demo).
   */
  setAutoTrading(enabled: boolean, mode?: 'demo' | 'live'): void {
    const target = mode ?? this.mode;
    if (target === 'live') this.autoTradingEnabledLive = enabled;
    else this.autoTradingEnabledDemo = enabled;
  }

  isAutoTradingEnabled(): boolean {
    return this.mode === 'live' ? this.autoTradingEnabledLive : this.autoTradingEnabledDemo;
  }

  manualClosePosition(positionId: string, currentPrice: number): Position | null {
    if (this.mode === 'live' && this.liveAccount) {
      // Route the close through Coinbase. We resolve synchronously from the
      // existing API contract, but the actual order is fired-and-forgotten;
      // failures are surfaced via console + persist into the next tick view.
      const live = this.liveAccount;
      void live.closePosition(positionId, currentPrice).then(closed => {
        // TRA-242 — manual closes from Live route to the Live history list.
        if (closed) this.liveClosedPositions.push(closed);
      }).catch(err => {
        console.warn(`[crypto-engine] manualClose live failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Synchronous response: optimistic close — the live broker will reconcile.
      const snapshot = live.getState().openPositions.find(p => p.id === positionId) ?? null;
      return snapshot ? { ...snapshot, exitPrice: currentPrice, closedAt: Date.now() } : null;
    }
    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      // TRA-242 — manual closes from Demo route to the Demo history list.
      this.demoClosedPositions.push(closed);
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
    // TRA-242 — EOD reports run against the Demo book (Live history is
    // owned by Coinbase, not by this engine). Pre-split this returned the
    // merged list, which mixed Live trades into the EOD report on days the
    // user toggled to live and back.
    return {
      allClosedPositions: [...this.demoClosedPositions],
      accountState: this.account.getState(),
      symbols: Array.from(this.symbolState.values()),
    };
  }

  /**
   * Snapshot trade history + account for durable storage (TRA-140).
   * TRA-242 — persists Demo and Live closed-position lists separately so
   * the dashboard separation survives a server restart. The legacy
   * `closedPositions` field stays on the type for callers that haven't
   * moved yet (and for snapshot rotation backups), but it always equals
   * the Demo list — Live history is broker-owned.
   */
  exportTradeSnapshot(): {
    closedPositions: Position[];
    demoClosedPositions: Position[];
    liveClosedPositions: Position[];
    recentSignals: TradeSignal[];
    account: ReturnType<CryptoPaperAccount['exportSnapshot']>;
  } {
    return {
      closedPositions: [...this.demoClosedPositions],
      demoClosedPositions: [...this.demoClosedPositions],
      liveClosedPositions: [...this.liveClosedPositions],
      recentSignals: [...this.recentSignals],
      account: this.account.exportSnapshot(),
    };
  }

  /**
   * Restore trade history + account from durable storage (TRA-140).
   * TRA-242 — accepts both the new split lists and pre-split snapshots;
   * the latter are treated as Demo-only since Live history is broker-owned.
   */
  importTradeSnapshot(snap: {
    closedPositions?: Position[];
    demoClosedPositions?: Position[];
    liveClosedPositions?: Position[];
    recentSignals: TradeSignal[];
    account: ReturnType<CryptoPaperAccount['exportSnapshot']>;
  }): void {
    this.demoClosedPositions = [
      ...(snap.demoClosedPositions ?? snap.closedPositions ?? []),
    ];
    this.liveClosedPositions = [...(snap.liveClosedPositions ?? [])];
    this.recentSignals = [...snap.recentSignals];
    this.account.importSnapshot(snap.account);
  }

  /**
   * TRA-219 — daily 9 PM ET archive of the in-memory closed trade history.
   * Mirror of `SignalEngine.archiveClosedTrades` for the crypto dashboard.
   * EOD reports under `crypto-reports/<date>.json` still preserve each day's
   * closed trades for the Calendar tab.
   */
  archiveClosedTrades(): number {
    // TRA-242 — clear both Demo and Live so neither dashboard carries
    // yesterday's trades into the new session.
    const dropped = this.demoClosedPositions.length + this.liveClosedPositions.length;
    this.demoClosedPositions = [];
    this.liveClosedPositions = [];
    return dropped;
  }

  /**
   * TRA-241 — re-anchor the daily-P&L baseline at the 9 PM ET daily close so
   * the dashboard shows 0 for the new trading day. Both the demo paper account
   * and the Coinbase live account roll their own baseline, and the persisted
   * tracker openingEquity is realigned in lock-step so a server restart after
   * the reset doesn't synthesize phantom dailyPnl.
   */
  resetDailyPnl(): void {
    this.account.resetDay();
    this.liveAccount?.rolloverDay();
    if (this.tracker) {
      this.tracker.syncOpeningEquity(this.account.getState().totalEquity, 0);
    }
  }
}
