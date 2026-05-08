import {
  BbFadeStrategy,
  SwingStrategy,
  CoinbaseOrderClient,
  RegimeDetector,
  MomentumStrategy,
  MeanReversionCryptoStrategy,
  BreakoutVolStrategy,
  StrategyRouter,
  evaluateShortFilters,
  evaluateShortBookCaps,
  symbolShortCooldownActive,
  isPerpShortSymbol,
  SKIP_NOT_IN_UNIVERSE,
  type ShortFilterContext,
  type ClosedShortTrade,
} from '@trading-app/engine';
import { CRYPTO_WATCHLIST, isCryptoSymbolBlocked, aliasCryptoSymbol, resolveStrategyPreset } from '@trading-app/shared';
import type {
  TradeSignal,
  Candle,
  AccountState,
  Position,
  PositionQuoteSource,
  CryptoEngineState,
  NewsItem,
  AccountSettings,
  CryptoStrategyType,
  StrategyPreset,
} from '@trading-app/shared';
import {
  fetchCryptoMinuteBars,
  fetchCryptoDailyBars,
  fetchCrypto4hBars,
  fetchCryptoQuotes,
  fetchCryptoNews,
  refreshCoinbaseProductCatalog,
  isCoinbaseListed,
} from './crypto-feed.js';
import { isYahooBreakerOpen } from './yahoo-feed.js';
import { CryptoPaperAccount } from './crypto-account.js';
import { CryptoLiveAccount } from './crypto-live-account.js';
import { FundingRateTracker } from './funding-rate-tracker.js';
import type { PnlTracker } from './pnl-tracker.js';

export type CryptoEngineEventHandler = (state: CryptoEngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;

/**
 * TRA-325 — process-wide forced strategy preset override. When set in the
 * environment (Render dashboard, ops shell, etc.) every engine instance pins
 * to this preset regardless of the user's saved `activeStrategyPreset`. This
 * subsumes TRA-324's `LIVE_STRATEGY_PRESET=bb_fade_sol_doge_only` env-flag
 * behaviour and keeps it as an ops-level kill-switch for the live $180 test:
 * dropping the env var on Render frees per-user settings to drive the engine
 * without a code change. The legacy value `'bb_fade_sol_doge_only'` is still
 * accepted (mapped via {@link resolveStrategyPreset}) so a render.yaml that
 * predates this commit keeps working.
 */
const FORCED_PRESET_ENV = (process.env.LIVE_STRATEGY_PRESET ?? '').trim();

/**
 * TRA-341 — process-wide override for the §6 single-symbol short cap on the
 * live preset, mirroring the per-user `AccountSettings.liveSingleSymbolShortCap`
 * knob but without requiring a settings save. Resolved as a fraction of
 * strategy equity (e.g. `0.5` ↔ 50%). Per-user wins; this env value only fills
 * in when the user setting is absent. Engine-side `resolveSingleSymbolShortCap`
 * still clamps the final value to (0, 1] and falls back to the spec default
 * for non-finite / ≤ 0 inputs, so a malformed env value can't disable the gate.
 *
 * Exported as a pure helper so unit tests can exercise the precedence ladder
 * without mucking with `process.env`.
 */
export function resolveLiveSingleSymbolShortCap(
  userValue: number | undefined,
  envValue: string | undefined,
): number | null {
  if (userValue !== undefined && Number.isFinite(userValue) && userValue > 0) {
    return userValue;
  }
  if (envValue !== undefined) {
    const parsed = Number.parseFloat(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}
/**
 * TRA-230 — drop signals from the displayed list once they're no longer
 * actionable. A signal becomes invalid when it ages past this window or when
 * the current quote crosses its stop or take-profit. 30 minutes is short
 * enough to keep the panel relevant on the 1m/5m bars crypto strategies trade.
 */
const SIGNAL_VALID_MS = 30 * 60_000;

export class CryptoSignalEngine {
  // TRA-313: dropped reversal / macdTrend / scalping per board pick on TRA-305.
  //          BbFade and Swing remain as direct (non-router) strategies; the
  //          router below owns momentum / breakout_vol / mean_reversion.
  private readonly bbFade = new BbFadeStrategy({ enforceTimeFilter: false });
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
  /**
   * TRA-267 — 4H candle cache for the Phase-1 perp-shorts universe (BTC, ETH,
   * SOL, XRP, DOGE). Populated alongside `dailyCandleCache` by
   * {@link refresh4hCandles}; consumed by TRA-261's short-side strategy
   * layer once that ticket lands the consumer wiring. The long-side router
   * never reads this map — the long path stays byte-identical to pre-267.
   */
  private _4hCandleCache: Map<string, Candle[]> = new Map();
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
  /**
   * TRA-249-D — hourly funding-rate accrual for open Coinbase INTX perp
   * positions. Constructed alongside the live broker; rebuilt on every
   * `tryInitLiveBroker` so a re-init after a settings save (new Coinbase
   * creds) carries a fresh tracker bound to the new client. Null when
   * live mode is inactive or creds are missing — in that case the hourly
   * scheduler tick is a no-op for this engine.
   */
  private fundingTracker: FundingRateTracker | null = null;
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
      // TRA-249-C — seed routing mode from settings so the very first tick
      // respects spot_only when the user opted out. Default 'hybrid' matches
      // DEFAULT_ACCOUNT_SETTINGS for users that pre-date TRA-249-E.
      const live = new CryptoLiveAccount(client, {
        routingMode: s?.liveTradeRoutingCrypto ?? 'hybrid',
      });
      // TRA-232 — sync the live account to the user's risk knobs immediately
      // so the first order placed after a live-mode flip uses the right
      // managedAccountRatio / riskPerTrade.
      // TRA-341 — also seed the operator-tunable single-symbol short cap so
      // the very first short candidate after a live flip honours the saved
      // override. Precedence: per-user `liveSingleSymbolShortCap` > env var
      // `LIVE_SINGLE_SYMBOL_SHORT_CAP` > engine default (0.15). Resolver
      // returns `null` when neither knob is set, which clears any previously
      // applied cap and falls through to the engine default downstream.
      if (s) {
        live.updateRiskConfig({
          managedAccountRatio: s.managedAccountRatio,
          riskPerTrade: s.riskPerTrade,
          singleSymbolShortCap: resolveLiveSingleSymbolShortCap(
            s.liveSingleSymbolShortCap,
            process.env.LIVE_SINGLE_SYMBOL_SHORT_CAP,
          ),
        });
      } else {
        // No saved settings yet (first-boot, fresh install). The env var still
        // applies as a process-wide default so an operator can pin the cap
        // before any user has visited Settings.
        const envCap = resolveLiveSingleSymbolShortCap(undefined, process.env.LIVE_SINGLE_SYMBOL_SHORT_CAP);
        if (envCap !== null) {
          live.updateRiskConfig({ singleSymbolShortCap: envCap });
        }
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
    // TRA-249-D — bind the funding tracker to the new live broker so the
    // next hourly scheduler tick accrues against the freshly-initialised
    // account (including any positions reconciled from Coinbase below).
    this.fundingTracker = new FundingRateTracker(broker, broker.getCoinbaseClient());
    console.log('[crypto-engine] Coinbase live broker initialised — live trading active.');
    await broker.refreshBalance();
    // TRA-243 — pre-load the set of Coinbase-tradable product_ids for the
    // active watchlist so the very first live tick can skip delisted/renamed
    // tickers (e.g. MATIC after the POL rename) with a clear reason instead
    // of eating a 400 INVALID_ARGUMENT on the order endpoint.
    await broker.refreshTradableProducts(this.getActiveSymbols());
    // TRA-249-C / TRA-262 — pre-load the spot↔perp catalog AND the per-perp
    // funding/OI cache so the first tick that routes a SELL signal can
    // resolve `BTC-USD` → `BTC-PERP-INTX` AND evaluate the §5 funding/OI
    // gates against real Coinbase telemetry. The two concerns share one
    // `/products?product_type=FUTURE` round-trip.
    await broker.refreshPerpCatalog(this.getActiveSymbols());
    // TRA-262 — pre-load order-book spreads for the perp universe so the
    // first short signal evaluated post-init reads a real (ask - bid) / mid
    // fraction instead of skipping the §5 spread gate. Best-effort: a
    // failure here is logged per-product and the per-tick refresh in
    // `runLiveTick` retries on the next iteration.
    await broker.refreshPerpOrderBookSpreads(this.getActiveSymbols());
  }

  /**
   * TRA-325 — resolve the strategy preset that should drive this tick. The
   * `LIVE_STRATEGY_PRESET` env var, when set, wins over per-user settings so
   * Render can pin every engine to one preset (the live-test override path
   * inherited from TRA-324). Otherwise we honour the user's saved
   * `activeStrategyPreset`, defaulting to `legacy_5` for snapshots persisted
   * before this field existed.
   */
  private resolvePreset(): StrategyPreset {
    if (FORCED_PRESET_ENV) return resolveStrategyPreset(FORCED_PRESET_ENV);
    return resolveStrategyPreset(this.currentSettings?.activeStrategyPreset);
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
      // TRA-249-D — drop the funding tracker too; tryInitLiveBroker rebuilds
      // it bound to the new live account so funding accrues against the
      // refreshed credentials, not the old ones.
      this.fundingTracker = null;
      await this.tryInitLiveBroker();
      return;
    }
    // Switching back to demo — drop the live broker so we don't keep refreshing
    // Coinbase balances in the background.
    this.liveAccount = null;
    // TRA-249-D — funding accrual only applies to live perps; clear the
    // tracker so the hourly scheduler tick stays a no-op in demo.
    this.fundingTracker = null;
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
   * TRA-330 — resolve the configured demo crypto starting equity, falling back
   * to the legacy combined `demoEquity` and finally to the hardcoded $25k
   * (matches the precedence in the constructor). Used by the runtime invariant
   * to choose a rebase target without re-deriving it inline at every callsite.
   */
  private demoEquityTarget(): number {
    const s = this.currentSettings;
    return s ? (s.demoEquityCrypto ?? s.demoEquity ?? 25_000) : 25_000;
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
    // TRA-345 — one-shot startup observability for the pinned strategy preset.
    // Prints the resolved preset id, enabled strategies, symbol filter, and the
    // raw `LIVE_STRATEGY_PRESET` env value the process actually saw. This is
    // the deploy gate: if the env var is unset on Render or has a typo,
    // `resolveStrategyPreset` silently falls back to `legacy_5` and the live
    // engine runs the unrestricted roster — exactly the regression that
    // produced the 13 wrong-symbol/strategy trades on 2026-05-05→05-07. Logging
    // this once at boot means the next time someone questions whether the
    // preset is active, the server logs answer it directly.
    const startupPreset = this.resolvePreset();
    const filterStr = startupPreset.symbolFilter
      ? `[${startupPreset.symbolFilter.join(',')}]`
      : '(no filter — all watchlist symbols)';
    console.log(
      `[crypto-engine] startup preset: id=${startupPreset.id} env="${FORCED_PRESET_ENV}" strategies=[${startupPreset.enabledStrategies.join(',')}] symbolFilter=${filterStr}`,
    );
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
    // TRA-283: filter denylisted symbols so they never receive quotes, signals,
    // or new positions even if a stale client added them previously.
    const base = (CRYPTO_WATCHLIST as readonly string[])
      .filter(s => !this.hiddenSymbols.has(s) && !isCryptoSymbolBlocked(s));
    const dyn = Array.from(this.dynamicSymbols)
      .filter(s => !base.includes(s) && !isCryptoSymbolBlocked(s));
    return [...base, ...dyn];
  }

  addSymbol(symbol: string): void {
    if (isCryptoSymbolBlocked(symbol)) return;
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
  private static readonly MIN_BARS_BB_FADE = 28;    // bbPeriod(20) + adx warm-up
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
        // TRA-261 — short overrides come straight from TRA-255 §4.1 / §4.2.
        // Long-side fields are deliberately omitted so the long path stays
        // byte-identical to the TRA-200 / TRA-207 spec values.
        momentum: new MomentumStrategy(regime, {
          paramsByDirection: {
            short: {
              // §4.1 — entry + 2.0 × ATR(14). Defensive lock in case the
              // long-side default drifts later (TRA-200 says long should be
              // 2.5 — separate ticket).
              atrStopMultiplier: 2.0,
              // §4.1 — 8-bar rearm overrides the donchianPeriod-derived default
              // so short re-entry stays slower than long during clustered
              // down moves.
              rearmBars: 8,
              // §4.1 — EMA(200) slope must be negative over the last 10 bars
              // for a short. Long-side leaves this undefined (no slope check),
              // preserving byte-identical long behaviour. On 4H bars the
              // cascade-leg trigger below replaces the §4.1 short stack
              // outright, so this gate only ever applies to non-4H short paths.
              slowMaSlopeBars: 10,
              // §4.1 — breakout-bar volume ≥ 1.25 × SMA(volume, 20). Mirrors
              // BreakoutVolStrategy's volume guard but only applies to shorts.
              volumeMultiplier: 1.25,
              volumeSmaPeriod: 20,
              // TRA-275 / TRA-255 §4.4 r6 — cascade-leg short trigger for 4H
              // bars (Layer 3 structural rewrite). Activates only when the
              // strategy detects 4H bar intervals; non-4H short paths fall
              // through to the §4.1 stack above. Empty config = spec defaults
              // (drop-bar 1.5× ATR, close-in-lower 33%, vol 1.5×, recent-high
              // anchor 95% over 20-bar lookback).
              byTimeframe: { '4h': {} },
              // TRA-284 / TRA-255 §4.4 v2 — BTC RSI-extreme bracket trigger.
              // Routes BTC-USD shorts through the bracket (RSI(14) ≥ 70 +
              // 0.98 × max(high, 20) anchor + bearish-rejection close in
              // lower-half range + softened daily-regime gate) instead of
              // the cascade-leg trigger. Alts (ETH / SOL / XRP / DOGE) keep
              // the cascade-leg trigger byte-unchanged. Bracket numerics
              // resolve to the spec defaults; override knobs live on
              // `btcRsiBracket` if needed in a future retune.
              lowCascadeDensitySymbols: ['BTC-USD'],
            },
          },
        }),
        meanReversion: new MeanReversionCryptoStrategy(),
        breakout: new BreakoutVolStrategy({
          paramsByDirection: {
            short: {
              // §4.2 — ≥ 2.5 × SMA(volume, 20) volume confirmation. Phase-1.1
              // 4H Breakout-short relaxes this to 1.50 × per the §4.4 r6
              // knob-relaxation patch (matches the cascade-volume floor).
              // The router can't dispatch on bar interval, so we run the 4H
              // numbers across the live engine — the cascade-leg pre-route
              // park (§4.4 r6) suppresses any non-4H Breakout short emission
              // that would otherwise fire under the relaxed 1.50× gate.
              volumeMultiplier: 1.5,
              // §4.4 r6 — 4H-native consolidation window (10 bars × 4h ≈ 1.7
              // days) replacing the 1D-derived 20-bar default. Same
              // motivation as the volume relaxation: the long-side default
              // is calibrated to daily bars and oversaturates on 4H.
              consolidationBars: 10,
              // §4.2 — entry + 1.75 × ATR(14) hard stop.
              atrStopMultiplier: 1.75,
              // §4.2 — entry − 3.0 × ATR(14) take profit (R:R ≈ 1.7:1).
              atrTpMultiplier: 3.0,
            },
          },
        }),
      });
      this.routers.set(symbol, r);
    }
    return r;
  }

  /**
   * TRA-261 — apply the perp shorts universe constraint and the §5
   * multiplicative short filters in priority order. Mutates the signal in
   * place by stamping `signalSkipReason` when a gate fails and returns the
   * resulting reason string (or null on a clean pass). Long signals are a
   * no-op — the function only inspects `side === 'sell'`.
   *
   * Funding rate, BTC regime, spread, and OI inputs are sourced opportunistically:
   *   - BTC regime: read live from the per-symbol router's RegimeDetector for
   *     `BTC-USD`. Lazily creates the BTC router on first call so we don't
   *     have to wait for BTC's own tick to ingest the gate.
   *   - Funding rate / OI: hourly perp catalog refresh on the live broker
   *     (TRA-262). One `/products?product_type=FUTURE` round-trip populates
   *     the catalog AND the metrics cache, so adding the inputs costs zero
   *     extra Coinbase API budget vs the pre-TRA-262 path.
   *   - Spread: live order-book snapshot refreshed once per live tick across
   *     the perp universe (TRA-262). A per-signal fetch would multiply the
   *     API budget on a tick that emits multiple short candidates.
   *
   * Demo-mode short signals: the live broker may be uninitialised, in which
   * case funding/OI/spread are left undefined and the corresponding gates
   * skip per the strategy layer's best-effort contract. Universe and BTC
   * regime gates always apply regardless of mode.
   */
  private applyShortGates(signal: TradeSignal): void {
    if (signal.side !== 'sell') return;

    if (!isPerpShortSymbol(signal.symbol)) {
      signal.signalSkipReason = SKIP_NOT_IN_UNIVERSE;
      return;
    }

    // BTC regime overlay (filter 2 — alts only). The per-symbol router for
    // BTC-USD owns BTC's regime detector; querying its current label gives
    // us the post-hysteresis regime without re-ticking the detector.
    const btcRouter = this.routers.get('BTC-USD');
    const liveCtx = this.liveAccount?.getPerpShortFilterContext(signal.symbol) ?? {};
    const ctx: ShortFilterContext = {
      ...liveCtx,
      btcRegime: btcRouter ? btcRouter.currentRegime() : undefined,
    };

    const reason = evaluateShortFilters(signal, ctx);
    if (reason) {
      signal.signalSkipReason = reason;
      return;
    }

    // TRA-261 / TRA-255 §3.1 + §6 — book-wide pre-route caps. Counted across
    // both the demo paper account and the live broker (only one is active per
    // tick, but the helper accepts whichever is the source of truth) so the
    // signal carries the right cap reason regardless of mode. The cooldown
    // input pulls from the closed-positions list scoped to the active mode.
    const bookReason = evaluateShortBookCaps(signal, {
      openShortCount: this.countOpenShorts(),
      symbolCooldownActive: symbolShortCooldownActive(
        signal.symbol,
        this.recentClosedShorts(),
        Date.now(),
      ),
    });
    if (bookReason) signal.signalSkipReason = bookReason;
  }

  /**
   * Count open short positions across the active book. In demo we walk the
   * paper account; in live we walk the broker mirror. Held shorts on a
   * fall-through (live broker not yet initialised) count as zero — the
   * routing path bails on the live mode early in that case so this is a
   * defensive default rather than an observable code path.
   */
  private countOpenShorts(): number {
    const positions = this.mode === 'live' && this.liveAccount
      ? this.liveAccount.getState().openPositions
      : this.account.getState().openPositions;
    let n = 0;
    for (const p of positions) if (p.side === 'sell') n++;
    return n;
  }

  /**
   * Closed-shorts feed for the §3.1 cooldown helper. Reads the closed-position
   * list scoped to the active mode (the same lists the dashboard reads), so
   * a Demo session that just took 3 SOL losses doesn't suppress Live shorts
   * on the same ticker — and vice versa. Pre-TRA-242 snapshots without a
   * `closedAt` are filtered out (we can't bound them to the cooldown window).
   */
  private recentClosedShorts(): ClosedShortTrade[] {
    const list = this.mode === 'live' ? this.liveClosedPositions : this.demoClosedPositions;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d window covers the 48h cooldown plus headroom for streak-walking
    const out: ClosedShortTrade[] = [];
    for (const p of list) {
      if (p.side !== 'sell') continue;
      if (typeof p.closedAt !== 'number') continue;
      if (p.closedAt < cutoff) continue;
      out.push({
        symbol: p.symbol,
        pnlUsd: p.pnl ?? 0,
        closedAt: p.closedAt,
        side: p.side,
      });
    }
    return out;
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
    // TRA-338 — keep the Coinbase product allowlist warm. Cheap (one /products
    // call gated by a 1h TTL) and idempotent across per-user engines because
    // the catalog is venue-wide. Done before quote fan-out so the engine
    // already knows which symbols are tradable on Coinbase before the entry
    // gate runs below.
    await refreshCoinbaseProductCatalog();
    const quotes = await fetchCryptoQuotes(activeSymbols);

    const prices = new Map<string, number>();
    // TRA-338 — parallel map keyed by symbol of which provider supplied the
    // quote we're about to feed `openPosition` with. Threaded straight through
    // to the paper account so `Position.quoteSource` reflects reality on every
    // entry instead of the prior "trust the cascade" behaviour that produced
    // TRA-337's MEGA-USD ghost.
    const quoteSources = new Map<string, PositionQuoteSource>();
    for (const [sym, q] of quotes) {
      prices.set(sym, q.price);
      quoteSources.set(sym, q.source);
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

    // TRA-344 — Coinbase fallback for symbols Yahoo+CMC don't carry. PLUME-USD
    // is only listed on Coinbase Advanced Trade; previously its price column
    // showed $0.00 (-100% P&L) because the watchlist feeders had no source.
    // We also patch in any open-position symbols outside the watchlist so an
    // imported holding always renders a real Current price. RNDR-USD post-rebrand
    // still won't resolve here (Coinbase product is now RENDER-USD) — that case
    // is handled by the symbol alias map elsewhere.
    if (this.liveAccount) {
      const positionSymbols = new Set<string>();
      for (const p of this.liveAccount.getState().openPositions) positionSymbols.add(p.symbol);
      for (const p of this.account.getState().openPositions) positionSymbols.add(p.symbol);
      const fallbackTargets = new Set<string>();
      for (const sym of activeSymbols) {
        if (!quotes.has(sym)) fallbackTargets.add(sym);
      }
      for (const sym of positionSymbols) {
        if (!quotes.has(sym)) fallbackTargets.add(sym);
      }
      if (fallbackTargets.size > 0) {
        try {
          const cbPrices = await this.liveAccount
            .getCoinbaseClient()
            .getProductPrices(Array.from(fallbackTargets));
          for (const [sym, price] of cbPrices) {
            if (!Number.isFinite(price) || price <= 0) continue;
            prices.set(sym, price);
            const prev = this.symbolState.get(sym);
            this.symbolState.set(sym, {
              symbol: sym,
              price,
              volume: prev?.volume ?? 0,
              change: prev?.change ?? 0,
              changePct: prev?.changePct ?? 0,
              lastUpdated: Date.now(),
              quoteStatus: 'ok',
            });
          }
        } catch (err: unknown) {
          console.warn(
            '[crypto-engine] Coinbase fallback price lookup failed:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // TRA-344 — mirror the canonical quote into legacy alias keys so positions
    // persisted under a renamed ticker (e.g. RNDR-USD post-rebrand → RENDER-USD)
    // still resolve a price without a destructive on-disk migration.
    const aliasMirrorTargets = new Set<string>();
    for (const p of this.account.getState().openPositions) aliasMirrorTargets.add(p.symbol);
    if (this.liveAccount) {
      for (const p of this.liveAccount.getState().openPositions) aliasMirrorTargets.add(p.symbol);
    }
    for (const legacySym of aliasMirrorTargets) {
      const canonical = aliasCryptoSymbol(legacySym);
      if (canonical === legacySym) continue;
      const canonicalState = this.symbolState.get(canonical);
      if (!canonicalState || canonicalState.quoteStatus !== 'ok') continue;
      prices.set(legacySym, canonicalState.price);
      this.symbolState.set(legacySym, { ...canonicalState, symbol: legacySym });
    }

    // Symbols we attempted but couldn't quote → mark unavailable so the UI shows
    // "Quote unavailable" instead of a permanent "Loading…" spinner.
    const breakerOpen = isYahooBreakerOpen();
    for (const sym of activeSymbols) {
      if (this.symbolState.get(sym)?.quoteStatus === 'ok') continue;
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
        await this.runLiveTick(prices, activeSymbols, quoteSources);
      }
      for (const h of this.handlers) h(this.buildState());
      return;
    }

    // TRA-330 — runtime tripwire. Runs before checkExits so a corrupt account
    // can't keep emitting skipped signals or absurd PnL on the same tick that
    // detects the breach. On rebase we also realign the persisted tracker so
    // a restart doesn't read back the corrupted equity-state.json.
    if (this.account.enforceEquityInvariant(this.demoEquityTarget())) {
      if (this.tracker) {
        const equity = this.account.getEquity();
        this.tracker.setInitialEquity(equity);
        this.tracker.saveEquity(equity, 0);
        this.tracker.syncOpeningEquity(equity, 0);
      }
    }

    const closed = this.account.checkExits(prices);
    if (closed.length > 0) {
      // TRA-231 — stamp `mode` for downstream UI metadata; the dashboard's
      // closed-positions visibility is enforced by TRA-242's per-mode
      // history lists so this stamp is informational only.
      for (const pos of closed) pos.mode = 'demo';
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
      // TRA-267 — 4H refresh runs alongside daily but `refresh4hCandles`
      // early-exits on non-perp-short symbols, so only the 5-symbol Phase-1
      // shorts universe actually hits Coinbase. No long-side consumer reads
      // from `_4hCandleCache`, so the long path stays byte-identical.
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refresh4hCandles(sym)),
      );
    }

    if (this.isAutoTradingEnabled()) {
      // TRA-325 — resolve the active preset once per tick. Strategies outside
      // the preset short-circuit to null without running indicators; symbols
      // outside the preset's whitelist (when set) skip every strategy.
      const preset = this.resolvePreset();
      const symbolAllowed = (sym: string) =>
        preset.symbolFilter === null || preset.symbolFilter.includes(sym);
      const strategyEnabled = (s: CryptoStrategyType) => preset.enabledStrategies.includes(s);
      let symbolsEvaluated = 0;
      let symbolsSkipped = 0;
      for (const sym of activeSymbols) {
        const candles = this.candleCache.get(sym) ?? [];
        const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

        // Evaluate each strategy independently with its own minimum bar requirement.
        const bbFadeSignal = candles.length >= CryptoSignalEngine.MIN_BARS_BB_FADE
          && strategyEnabled('bb_fade') && symbolAllowed(sym)
          ? this.bbFade.evaluate(sym, candles) : null;
        const swingSignal = strategyEnabled('swing_trade') && symbolAllowed(sym)
          && dailyCandles.length >= 205
          ? this.swing.evaluate(sym, dailyCandles) : null;
        // TRA-208: regime-aware router emits at most one momentum / breakout
        // / mean-reversion signal per tick. The router runs whenever any of
        // its three strategies are enabled by the preset; the post-router
        // filter below drops emissions for strategies outside the preset.
        const routerEnabled = strategyEnabled('momentum')
          || strategyEnabled('mean_reversion')
          || strategyEnabled('breakout_vol');
        const rawRouterSignal = routerEnabled && symbolAllowed(sym)
          && candles.length >= CryptoSignalEngine.MIN_BARS_ROUTER
          ? this.getRouter(sym).evaluate(sym, candles) : null;
        const routerSignal = rawRouterSignal
          && (rawRouterSignal.type === 'momentum'
            || rawRouterSignal.type === 'mean_reversion'
            || rawRouterSignal.type === 'breakout_vol')
          && strategyEnabled(rawRouterSignal.type)
          ? rawRouterSignal
          : null;

        if (candles.length === 0) {
          symbolsSkipped++;
        } else {
          symbolsEvaluated++;
        }

        for (const signal of [bbFadeSignal, swingSignal, routerSignal]) {
          if (!signal) continue;
          // TRA-261 — apply the perp shorts gates BEFORE the open-position /
          // recent-signal dedup. A suppressed signal still surfaces on the
          // dashboard with `signalSkipReason`, so the user knows the strategy
          // fired and was deliberately blocked.
          this.applyShortGates(signal);
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

          // TRA-231 — stamp the active mode so the dashboard scopes Signals
          // and Open Positions per-mode. Stamping the in-flight signal record
          // also propagates to the position the demo account opens off it
          // (`account.openPosition` does not copy `mode`, so we stamp the
          // returned position too).
          signal.mode = 'demo';
          this.recentSignals.unshift(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

          // TRA-261 — suppressed signals still display on the dashboard but
          // do not open a position. Pre-routing skip strings are set by
          // `applyShortGates` (universe gate + multiplicative §5 filters) and
          // by `MeanReversionCryptoStrategy` (off-strategy MR shorts).
          if (signal.signalSkipReason) continue;

          // TRA-338 — Coinbase-strict entry gate. We trade what Coinbase
          // trades; if the symbol isn't listed there (e.g. Yahoo's MEGA-USD
          // pointing at a 2022-delisted "MegaCryptoPolis" token, which gave
          // TRA-337 a frozen $4.05 entry), we don't open. And even when the
          // product *is* listed, the entry price MUST come from Coinbase —
          // otherwise we'd mark the entry off a YF/CMC ghost and watch the
          // P&L diverge against Coinbase's actual current price the moment
          // the next refresh lands.
          const cbListed = isCoinbaseListed(sym);
          if (cbListed === false) {
            signal.signalSkipReason = `${sym} not listed on Coinbase Exchange — skipping entry (we only trade what Coinbase trades)`;
            console.warn(`[crypto-engine] ${sym} ${signal.type}: ${signal.signalSkipReason}`);
            continue;
          }
          const source = quoteSources.get(sym);
          if (cbListed === true && source !== 'coinbase') {
            signal.signalSkipReason = `${sym} listed on Coinbase but no Coinbase quote this tick (got ${source ?? 'no quote'}) — refusing fallback-priced entry`;
            console.warn(`[crypto-engine] ${sym} ${signal.type}: ${signal.signalSkipReason}`);
            continue;
          }
          // cbListed === null → catalog never refreshed successfully. Fall
          // through to the existing source-based gate; we still refuse non-
          // Coinbase prices for entries because the cascade may have routed
          // through Yahoo's ghost ticker. This is the fail-closed branch.
          if (cbListed === null && source !== 'coinbase') {
            signal.signalSkipReason = `${sym} no Coinbase quote and Coinbase product catalog unavailable — refusing fallback-priced entry`;
            console.warn(`[crypto-engine] ${sym} ${signal.type}: ${signal.signalSkipReason}`);
            continue;
          }

          const opened = this.account.openPosition(signal, price, source);
          if (opened) opened.mode = 'demo';
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
  private async runLiveTick(prices: Map<string, number>, activeSymbols: string[], quoteSources: Map<string, PositionQuoteSource>): Promise<void> {
    const live = this.liveAccount;
    if (!live) return;

    if (live.isStale()) {
      await live.refreshBalance();
    }
    // TRA-243 — periodic refresh (default 6h) so a Coinbase delisting or
    // ticker rename that happens mid-session doesn't keep us firing rejected
    // orders on the stale symbol.
    if (live.isTradableProductsStale()) {
      await live.refreshTradableProducts(activeSymbols);
    }
    // TRA-249-C / TRA-262 — perp catalog runs on a tighter (1h) cadence so a
    // newly-listed INTX perp becomes routable mid-session without waiting
    // on a server restart. The same call also refreshes the per-perp
    // funding-rate + OI cache (TRA-262) so the §5 short filters never read
    // stale telemetry past the published ~8h Coinbase funding window.
    if (live.isPerpCatalogStale()) {
      await live.refreshPerpCatalog(activeSymbols);
    }
    // TRA-318 — when Stop Trading is engaged in live mode the bot must NOT send
    // any further orders to Coinbase. We still refresh balances + reconcile
    // wallet holdings above so the dashboard stays accurate, but exit + open
    // order placement are both gated. The user takes manual ownership of any
    // open positions (close via the dashboard or directly on Coinbase) until
    // they re-enable auto-trading.
    if (!this.isAutoTradingEnabled()) {
      return;
    }

    // TRA-262 — pull a fresh order-book spread snapshot per perp universe
    // symbol once per tick. Done before signal evaluation so `applyShortGates`
    // reads near-real-time spread fractions without a per-signal Coinbase
    // round-trip. Best-effort: a per-product failure clears that one entry
    // (the gate degrades to "skipped" for that symbol) without blocking
    // the rest of the universe.
    await live.refreshPerpOrderBookSpreads(activeSymbols);

    try {
      const closed = await live.checkExits(prices);
      if (closed.length > 0) {
        // TRA-242 — Live exits go on the Live history list so the Live
        // dashboard surfaces only Coinbase fills, not Demo paper trades.
        // TRA-231 — informational mode stamp on each record.
        for (const pos of closed) pos.mode = 'live';
        this.liveClosedPositions.push(...closed);
      }
    } catch (err: unknown) {
      console.warn('[crypto-engine] live exits error:', err instanceof Error ? err.message : String(err));
    }

    // Refresh candle caches so live mode evaluates strategies on fresh bars.
    const CANDLE_BATCH = 5;
    for (let i = 0; i < activeSymbols.length; i += CANDLE_BATCH) {
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshCandles(sym)),
      );
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshDailyCandles(sym)),
      );
      // TRA-267 — see demo-path equivalent above.
      await Promise.all(
        activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refresh4hCandles(sym)),
      );
    }

    // TRA-325 — resolve the active preset once per live tick. Same semantics
    // as the demo path so verification on demo before flipping to live is
    // meaningful.
    const preset = this.resolvePreset();
    const symbolAllowed = (sym: string) =>
      preset.symbolFilter === null || preset.symbolFilter.includes(sym);
    const strategyEnabled = (s: CryptoStrategyType) => preset.enabledStrategies.includes(s);

    for (const sym of activeSymbols) {
      const candles = this.candleCache.get(sym) ?? [];
      const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

      const bbFadeSignal = candles.length >= CryptoSignalEngine.MIN_BARS_BB_FADE
        && strategyEnabled('bb_fade') && symbolAllowed(sym)
        ? this.bbFade.evaluate(sym, candles) : null;
      const swingSignal = strategyEnabled('swing_trade') && symbolAllowed(sym)
        && dailyCandles.length >= 205
        ? this.swing.evaluate(sym, dailyCandles) : null;
      // TRA-208: same router pipeline as the demo path so live and paper
      // produce identical regime-aware entries from the same regime state.
      const routerEnabled = strategyEnabled('momentum')
        || strategyEnabled('mean_reversion')
        || strategyEnabled('breakout_vol');
      const rawRouterSignal = routerEnabled && symbolAllowed(sym)
        && candles.length >= CryptoSignalEngine.MIN_BARS_ROUTER
        ? this.getRouter(sym).evaluate(sym, candles) : null;
      const routerSignal = rawRouterSignal
        && (rawRouterSignal.type === 'momentum'
          || rawRouterSignal.type === 'mean_reversion'
          || rawRouterSignal.type === 'breakout_vol')
        && strategyEnabled(rawRouterSignal.type)
        ? rawRouterSignal
        : null;

      for (const signal of [bbFadeSignal, swingSignal, routerSignal]) {
        if (!signal) continue;
        // TRA-261 — apply the perp shorts gates BEFORE dedup so suppressed
        // signals still flow to the dashboard's Signals panel with the
        // pre-route reason instead of being silently dropped.
        this.applyShortGates(signal);
        if (live.hasOpenPositionForSignalType(sym, signal.type)) continue;
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000,
        );
        if (recent) continue;

        const price = prices.get(sym);
        if (!price) continue;

        // TRA-231 — stamp live so the Signals panel scopes correctly on a
        // mode flip back to demo. The live broker's openPosition adds the
        // resulting position to its own state which we don't surface in demo.
        signal.mode = 'live';
        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        // TRA-261 — pre-route skip means the strategy/filter layer rejected
        // the signal; do not submit anything to Coinbase. The signal is
        // already on the recent-signals list with the reason stamped.
        if (signal.signalSkipReason) continue;

        // TRA-338 — Coinbase-strict entry gate. Live mode already had a
        // tradable-product check inside `CryptoLiveAccount.openPosition`
        // (TRA-243), but it ran AFTER quote-derived sizing — meaning a
        // YF/CMC-priced signal could still be sized off a phantom price
        // before being rejected at the broker. Apply the same gate the demo
        // path uses so quote provenance is checked alongside listing.
        const cbListed = isCoinbaseListed(sym);
        if (cbListed === false) {
          signal.signalSkipReason = `${sym} not listed on Coinbase Exchange — skipping entry (we only trade what Coinbase trades)`;
          console.warn(`[crypto-engine] ${sym} ${signal.type}: ${signal.signalSkipReason}`);
          continue;
        }
        const source = quoteSources.get(sym);
        if (cbListed === true && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} listed on Coinbase but no Coinbase quote this tick (got ${source ?? 'no quote'}) — refusing fallback-priced entry`;
          console.warn(`[crypto-engine] ${sym} ${signal.type}: ${signal.signalSkipReason}`);
          continue;
        }
        if (cbListed === null && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} no Coinbase quote and Coinbase product catalog unavailable — refusing fallback-priced entry`;
          console.warn(`[crypto-engine] ${sym} ${signal.type}: ${signal.signalSkipReason}`);
          continue;
        }

        try {
          await live.openPosition(signal, price, source);
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

  /**
   * TRA-267 — refresh the 4H bar cache for `symbol`. Scoped to the perp
   * shorts universe (`isPerpShortSymbol`); other symbols early-exit so we
   * don't hit Coinbase Exchange for symbols that won't ever route a short
   * signal off the 4H layer. Hourly cadence matches the daily refresh — 4H
   * bars only roll every 4h so an hourly check is generous.
   */
  private async refresh4hCandles(symbol: string): Promise<void> {
    if (!isPerpShortSymbol(symbol)) return;
    const cached = this._4hCandleCache.get(symbol);
    if (cached && cached.length > 0) {
      const lastBar = cached[cached.length - 1];
      const hourMs = 60 * 60 * 1000;
      if (Date.now() - lastBar.timestamp < hourMs) return;
    }
    const bars = await fetchCrypto4hBars(symbol, 260);
    if (bars.length > 0) this._4hCandleCache.set(symbol, bars);
  }

  private buildState(): CryptoEngineState {
    const symbols = Array.from(this.symbolState.values()).filter(s => !this.hiddenSymbols.has(s.symbol));
    // TRA-231 — scope signals to the active mode so the dashboard's Demo view
    // doesn't surface live signals (and vice versa). Closed-positions split is
    // handled by TRA-242's `demoClosedPositions` / `liveClosedPositions` lists
    // which the per-branch returns below read from directly. Legacy persisted
    // signal records have no `mode` stamp; route them to 'demo' since pre-field
    // paths only ran in demo (live broker integration came later).
    const isMode = (m: 'demo' | 'live' | undefined): boolean => (m ?? 'demo') === this.mode;
    const scopedSignals = this.recentSignals.filter(s => isMode(s.mode));
    if (this.mode === 'live') {
      // Live mode: if a Coinbase broker is configured, surface its USD-equivalent
      // cash plus the positions we've opened in this session. Otherwise show a
      // zero/empty account; the internal demo state stays preserved.
      if (this.liveAccount) {
        const ls = this.liveAccount.getState();
        // TRA-231 — stamp the rendered openPositions so the UI can attribute
        // them to the live mode. Mutating the underlying records is safe: the
        // CryptoLiveAccount returns its own array each call, and re-stamping
        // the same value is idempotent.
        for (const p of ls.openPositions) p.mode = 'live';
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
          signals: scopedSignals,
          account,
          // TRA-242 — Live dashboard reads only Live closed positions; the
          // Demo history stays in `demoClosedPositions` for a later switch back.
          closedPositions: [...this.liveClosedPositions].slice(-20),
          news: [...this.newsCache],
          lastTick: Date.now(),
          autoTradingEnabled: this.isAutoTradingEnabled(),
          marketOpen: true as const,
          // TRA-249-B — surface the live broker's recent-skips ring buffer.
          // `getRecentSkips` returns a defensive copy so consumers can't
          // mutate the underlying buffer.
          liveSkips: ls.recentSkips,
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
        signals: scopedSignals,
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
    // TRA-231 — same idempotent stamp as the live branch above so demo open
    // positions carry an explicit mode tag through to the UI.
    for (const p of accountBase.openPositions) p.mode = 'demo';
    const account: AccountState = {
      ...accountBase,
      weeklyPnl: stats?.weeklyPnl ?? 0,
      monthlyPnl: stats?.monthlyPnl ?? 0,
      yearlyPnl: stats?.yearlyPnl ?? 0,
      allTimePnl: stats?.allTimePnl ?? (accountBase.totalEquity - this.account.getInitialEquity()),
    };

    return {
      symbols,
      signals: scopedSignals,
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

  /**
   * TRA-249-D — top-of-hour funding accrual hook. Wired into the global
   * MarketScheduler `onHourly` callback so every active live engine gets
   * exactly one accrual pass per ET hour. No-ops in demo mode and when
   * the live broker has not been initialised (no creds, etc.) — the
   * tracker itself further short-circuits when zero perp positions are
   * open, so a pure-spot live operator pays no overhead.
   */
  async tickFundingHourly(): Promise<void> {
    const tracker = this.fundingTracker;
    if (!tracker || this.mode !== 'live') return;
    try {
      await tracker.tick();
    } catch (err: unknown) {
      console.warn('[crypto-engine] funding hourly tick failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * TRA-320 — await the broker close in live mode and let errors propagate so
   * the route can surface a 502 + reason to the dashboard. Pre-fix this fired
   * `liveAccount.closePosition` and immediately returned an optimistic snapshot
   * with `closedAt` stamped; on a Coinbase reject (auth, INSUFFICIENT_FUND,
   * product not tradable) the user saw the position vanish and reappear on the
   * next broadcast with no signal that anything failed. Now the route can stay
   * synchronous with the broker — on success we record the live close, on
   * failure the position stays open in the broker mirror and the dashboard
   * receives a structured error.
   */
  async manualClosePosition(positionId: string, currentPrice: number): Promise<Position | null> {
    if (this.mode === 'live' && this.liveAccount) {
      const closed = await this.liveAccount.closePosition(positionId, currentPrice);
      if (closed) {
        // TRA-242 — manual closes from Live route to the Live history list.
        // TRA-231 — informational mode stamp.
        closed.mode = 'live';
        this.liveClosedPositions.push(closed);
      }
      return closed;
    }
    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      // TRA-242 — manual closes from Demo route to the Demo history list.
      // TRA-231 — informational mode stamp.
      closed.mode = 'demo';
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

  getReportSnapshot(mode: 'demo' | 'live' = 'demo') {
    // TRA-245 — return the per-mode book so EOD reports written under
    // crypto-reports/{mode}/ contain the matching account's data. Pre-fix
    // this always returned the Demo book even when the caller wrote into
    // crypto-reports/live/, so the Live folder + calendar surfaced demo
    // paper-account state for users running with mode='live'.
    const symbols = Array.from(this.symbolState.values());
    if (mode === 'live') {
      if (this.liveAccount) {
        const ls = this.liveAccount.getState();
        return {
          allClosedPositions: [...this.liveClosedPositions],
          accountState: {
            totalEquity: ls.totalEquity,
            availableCash: ls.availableCash,
            openPositions: ls.openPositions,
            dailyPnl: ls.dailyPnl,
          },
          symbols,
        };
      }
      // Live mode without configured Coinbase creds — emit an empty
      // snapshot so the Live calendar row exists but doesn't borrow from
      // the demo book.
      return {
        allClosedPositions: [],
        accountState: { totalEquity: 0, availableCash: 0, openPositions: [], dailyPnl: 0 },
        symbols,
      };
    }
    return {
      allClosedPositions: [...this.demoClosedPositions],
      accountState: this.account.getState(),
      symbols,
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
    // TRA-338 — backfill `quoteSource: 'unknown'` on closed positions written
    // before the field existed so the API surface answers a stable value.
    // The paper account does the same backfill on `importSnapshot` for open
    // positions; closed history is final-form so we do it inline here.
    const backfill = (p: Position): Position => (p.quoteSource ? p : { ...p, quoteSource: 'unknown' });
    this.demoClosedPositions = (snap.demoClosedPositions ?? snap.closedPositions ?? []).map(backfill);
    this.liveClosedPositions = (snap.liveClosedPositions ?? []).map(backfill);
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
