import {
  BbFadeStrategy,
  SwingStrategy,
  CoinbaseOrderClient,
  RegimeDetector,
  MomentumStrategy,
  MeanReversionCryptoStrategy,
  BreakoutVolStrategy,
  StrategyRouter,
  CorrelationMatrix,
  admitUnderClusterCap,
  resolveCorrelationCapConfig,
  evaluateShortFilters,
  evaluateShortBookCaps,
  symbolShortCooldownActive,
  isPerpShortSymbol,
  SKIP_NOT_IN_UNIVERSE,
  type ShortFilterContext,
  type ClosedShortTrade,
  type RouterUniverse,
  type CorrelationCapConfig,
} from '@trading-app/engine';
import { CRYPTO_WATCHLIST, isCryptoSymbolBlocked, aliasCryptoSymbol, resolveManagedAccountRatio, resolveRiskPerTrade, resolveStrategyPreset, presetAllowsStrategySymbol } from '@trading-app/shared';
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
  StrategyPresetId,
} from '@trading-app/shared';
import {
  fetchCryptoMinuteBars,
  fetchCryptoDailyBars,
  fetchCrypto4hBars,
  fetchCryptoQuotes,
  fetchCoinbaseAdvancedTradeQuotes,
  fetchCryptoNews,
  refreshCoinbaseProductCatalog,
  isCoinbaseListed,
} from './crypto-feed.js';
import { isYahooBreakerOpen } from './yahoo-feed.js';
import { evaluateFeedFreshness } from './feed-freshness.js';
import { CryptoPaperAccount } from './crypto-account.js';
import { CryptoLiveAccount } from './crypto-live-account.js';
import { FundingRateTracker } from './funding-rate-tracker.js';
import type { PnlTracker } from './pnl-tracker.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'crypto-engine' });

export type CryptoEngineEventHandler = (state: CryptoEngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;

/**
 * TRA-325 — forced strategy preset override for the LIVE engine. When set in
 * the environment (Render dashboard, ops shell, etc.) the live engine pins to
 * this preset regardless of the user's saved `activeStrategyPreset`. This
 * subsumes TRA-324's `LIVE_STRATEGY_PRESET=bb_fade_sol_doge_only` env-flag
 * behaviour and keeps it as an ops-level kill-switch for the live $180 test:
 * dropping the env var on Render frees per-user settings to drive the live
 * engine without a code change. The legacy value `'bb_fade_sol_doge_only'` is
 * still accepted (mapped via {@link resolveStrategyPreset}) so a render.yaml
 * that predates this commit keeps working.
 *
 * TRA-456 — this override is LIVE-ONLY. The demo engine ignores it and runs
 * {@link DEMO_PRESET_ENV} instead. The live `no_trade` stand-down (TRA-434) is
 * a capital-allocation control; freezing the paper-money demo engine bought no
 * risk reduction and only blanked the board's dashboard. See {@link resolvePreset}.
 */
const FORCED_PRESET_ENV = (process.env.LIVE_STRATEGY_PRESET ?? '').trim();

/**
 * TRA-456 — strategy preset for the DEMO engine. The demo engine runs paper
 * money with zero real-capital exposure, so it is deliberately NOT subject to
 * the live `LIVE_STRATEGY_PRESET` stand-down. It resolves this env var instead,
 * defaulting to {@link DEMO_PRESET_DEFAULT} (`tra405_validated` — bb_fade on
 * BTC-USD + SOL-USD, the documented live candidate roster) so the board always
 * watches one consistent roster. The demo engine never falls through to
 * per-user `activeStrategyPreset`; see {@link resolvePreset}.
 */
const DEMO_PRESET_ENV = (process.env.DEMO_STRATEGY_PRESET ?? '').trim();
const DEMO_PRESET_DEFAULT: StrategyPresetId = 'tra405_validated';

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
   * TRA-423 — portfolio correlation / concentration cap (TRA-411 spec §6).
   * Enforced on long (BUY) entries before `openPosition` in both the demo and
   * live paths. Short entries route through the perp machinery, which carries
   * its own TRA-261 notional caps. The five spec §5 keys take the recommended
   * defaults; {@link correlationMatrix} is rebuilt at most once per UTC day
   * from `dailyCandleCache` (spec §3 — major-coin correlation is slow-moving).
   */
  private readonly correlationCapEnabled = true;
  private readonly correlationCapConfig: CorrelationCapConfig = resolveCorrelationCapConfig();
  private correlationMatrix: CorrelationMatrix | null = null;
  private correlationMatrixUtcDay = -1;
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
  /**
   * TRA-407 (C5) — the in-progress tick's promise (resolved when idle).
   * `drain()` awaits this so a graceful shutdown finishes the current tick.
   */
  private activeTick: Promise<void> = Promise.resolve();
  private handlers: CryptoEngineEventHandler[] = [];
  // TRA-229 — per-mode auto-trading flags. The active flag (consulted on each
  // tick and surfaced in getState()) is whichever one matches `this.mode`.
  private autoTradingEnabledDemo = true;
  private autoTradingEnabledLive = true;
  private mode: 'demo' | 'live' = 'demo';
  /** Live broker (Coinbase) — initialised when live mode is active and creds are configured. */
  private liveAccount: CryptoLiveAccount | null = null;
  /**
   * TRA-408 — re-entry guard for {@link tryInitLiveBroker}. Since TRA-408
   * defers the `this.liveAccount` assignment until boot reconcile completes,
   * the `if (this.liveAccount)` guard no longer blocks a second concurrent
   * init (constructor background init racing an `applySettings` call). This
   * flag closes that window so we never build two brokers / fire two boot
   * reconciles.
   */
  private liveBrokerInitInFlight = false;
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
    // TRA-346 — pull from the (mode, 'crypto') bucket so a Live edit on the
    // Crypto dashboard never mutates Demo crypto sizing (and a Stocks edit
    // never mutates Crypto at all).
    if (settings) {
      this.account.updateRiskConfig({
        managedAccountRatio: resolveManagedAccountRatio(settings, 'crypto', settings.mode),
        riskPerTrade: resolveRiskPerTrade(settings, 'crypto', settings.mode),
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
      log.info('Coinbase client built', { auth: client.getAuthScheme() });
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
      // TRA-346 — read from the (live, 'crypto') bucket explicitly: the
      // broker is by definition the live account, regardless of where the
      // user happens to be in `s.mode` mid-save.
      if (s) {
        live.updateRiskConfig({
          managedAccountRatio: resolveManagedAccountRatio(s, 'crypto', 'live'),
          riskPerTrade: resolveRiskPerTrade(s, 'crypto', 'live'),
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
      log.warn('Coinbase init failed', { reason: err instanceof Error ? err.message : String(err) });
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
    if (this.liveAccount || this.liveBrokerInitInFlight) return;
    const broker = this.buildLiveBroker();
    if (!broker) {
      log.warn('live mode active but Coinbase credentials not configured — orders will not be sent');
      return;
    }
    this.liveBrokerInitInFlight = true;
    try {
      await this.bootInitLiveBroker(broker);
    } finally {
      this.liveBrokerInitInFlight = false;
    }
  }

  /**
   * TRA-408 — boot-time reconcile + catalog warm-up for a freshly built live
   * broker. Extracted from {@link tryInitLiveBroker} so the re-entry guard /
   * `finally` cleanup stays readable. Publishes `this.liveAccount` only on the
   * last line, after broker truth has been reconciled.
   */
  private async bootInitLiveBroker(broker: CryptoLiveAccount): Promise<void> {
    log.info('Coinbase live broker initialised — reconciling broker state before first live tick');
    // TRA-408 — reconcile broker truth (balances + open spot/perp positions)
    // BEFORE publishing `broker` to `this.liveAccount`. While `liveAccount` is
    // null `runLiveTick` no-ops, so deferring the assignment guarantees the
    // first live tick that actually evaluates signals sees a fully reconciled
    // account. A perp position opened directly on the Coinbase UI is therefore
    // surfaced on boot and can never be shadowed by a duplicate engine entry
    // during the startup window. `refreshBalance` runs `reconcilePerpPositions`
    // on its first call (lastPerpReconcileAt = 0), so the boot reconcile is
    // implicit in the call below; the periodic 5-min reconcile then takes over.
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
    // TRA-408 — publish the broker only now that boot reconcile + catalogs
    // have landed. `runLiveTick` keys "is live trading ready?" off this field.
    this.liveAccount = broker;
    // TRA-249-D — bind the funding tracker to the live broker so the next
    // hourly scheduler tick accrues against the freshly-initialised account
    // (including any positions reconciled from Coinbase above).
    this.fundingTracker = new FundingRateTracker(broker, broker.getCoinbaseClient());
    log.info('Coinbase live broker ready — live trading active');
  }

  /**
   * TRA-325 / TRA-456 / TRA-480 — resolve the strategy preset that drives a
   * tick, scoped by the requested branch mode (NOT `this.mode`):
   *
   *   • live — `LIVE_STRATEGY_PRESET` ({@link FORCED_PRESET_ENV}), when set,
   *     wins over per-user settings so Render can pin the live engine
   *     (currently `no_trade`, the TRA-434 risk stand-down). With the env var
   *     unset the live engine honours the user's saved `activeStrategyPreset`,
   *     defaulting to `legacy_5` for snapshots persisted before that field
   *     existed.
   *
   *   • demo — paper money, zero real-capital exposure. The live stand-down is
   *     a capital-allocation control, not a demo-visibility control, so the
   *     demo engine is NOT frozen by `LIVE_STRATEGY_PRESET`. It resolves
   *     `DEMO_STRATEGY_PRESET` ({@link DEMO_PRESET_ENV}), defaulting to
   *     `tra405_validated`, and deliberately does NOT fall through to per-user
   *     `activeStrategyPreset` — the board needs one deterministic candidate
   *     roster on the demo dashboard (TRA-456 CTO decision).
   *
   * TRA-480 — `mode` defaults to `this.mode` so legacy callers (boot logger,
   * `buildState`) keep their original semantics. The parallel demo+live tick
   * paths pass an explicit mode so each branch resolves its own preset, even
   * when the engine is bound to a different user-selected mode.
   */
  private resolvePreset(mode: 'demo' | 'live' = this.mode): StrategyPreset {
    if (mode === 'live') {
      if (FORCED_PRESET_ENV) return resolveStrategyPreset(FORCED_PRESET_ENV);
      return resolveStrategyPreset(this.currentSettings?.activeStrategyPreset);
    }
    return resolveStrategyPreset(DEMO_PRESET_ENV || DEMO_PRESET_DEFAULT);
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
    // TRA-346 — the demo paper account always sizes off the (demo, crypto)
    // bucket regardless of `settings.mode`; live sizing flows through the
    // live broker which reads its own (live, crypto) bucket. This keeps Demo
    // crypto isolated from Live crypto edits.
    this.account.updateRiskConfig({
      managedAccountRatio: resolveManagedAccountRatio(settings, 'crypto', 'demo'),
      riskPerTrade: resolveRiskPerTrade(settings, 'crypto', 'demo'),
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
    // TRA-480 — log BOTH branches' resolved presets at boot so future triage
    // doesn't have to guess which roster is actually running on each side.
    // TRA-479's root-cause investigation took an extra half-day because the
    // boot line only showed `id: legacy_5` and didn't distinguish whether the
    // engine was in demo or live mode (or what env values were in effect).
    const liveStartupPreset = this.resolvePreset('live');
    const demoStartupPreset = this.resolvePreset('demo');
    const filterStr = (p: StrategyPreset) =>
      p.symbolFilter ? `[${p.symbolFilter.join(',')}]` : '(no filter — all watchlist symbols)';
    log.info('startup preset', {
      // TRA-479 / TRA-480 — engine mode + both preset env vars so future
      // "demo dashboard idle" triage can read the boot log directly instead
      // of guessing. `liveEnv` is `LIVE_STRATEGY_PRESET`; `demoEnv` is
      // `DEMO_STRATEGY_PRESET` (empty → default `tra405_validated`).
      mode: this.mode,
      liveEnv: FORCED_PRESET_ENV,
      demoEnv: DEMO_PRESET_ENV,
      // Back-compat: preserve the `id` / `env` / `strategies` / `symbolFilter`
      // / `strategyUniverse` fields that pre-TRA-480 dashboards / log parsers
      // may rely on. These continue to reflect the engine's current-mode
      // resolution (live when mode='live', demo when mode='demo').
      id: (this.mode === 'live' ? liveStartupPreset : demoStartupPreset).id,
      env: FORCED_PRESET_ENV,
      strategies: (this.mode === 'live' ? liveStartupPreset : demoStartupPreset).enabledStrategies,
      symbolFilter: filterStr(this.mode === 'live' ? liveStartupPreset : demoStartupPreset),
      // TRA-421 — surface the per-strategy universe gate at boot so the
      // validated-symbol restriction is visible alongside the preset id.
      strategyUniverse: (this.mode === 'live' ? liveStartupPreset : demoStartupPreset).strategyUniverse ?? '(none)',
      // TRA-480 — explicit per-branch summary. Both branches tick every minute
      // post-TRA-480, so both rosters are observable from a single boot line.
      live: {
        id: liveStartupPreset.id,
        strategies: liveStartupPreset.enabledStrategies,
        symbolFilter: filterStr(liveStartupPreset),
      },
      demo: {
        id: demoStartupPreset.id,
        strategies: demoStartupPreset.enabledStrategies,
        symbolFilter: filterStr(demoStartupPreset),
      },
    });
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

  /**
   * TRA-407 (C5) — resolve once any in-progress tick has finished. Awaited by
   * the graceful-shutdown hook (after `stop()`) so the process drains the
   * current tick. Resolves immediately when idle and never rejects.
   */
  async drain(): Promise<void> {
    await this.activeTick.catch(() => {});
  }

  refresh(): void {
    this.tick().catch((err: unknown) => {
      log.error('refresh tick error', { reason: err instanceof Error ? err.message : String(err) });
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
   * TRA-423 — pairwise daily-return correlation matrix for the watchlist,
   * rebuilt at most once per UTC day from `dailyCandleCache` (spec §3). The
   * matrix's own insufficient-history fallback covers symbols whose daily
   * series hasn't loaded yet, so this is always safe to call.
   */
  private getCorrelationMatrix(): CorrelationMatrix {
    const utcDay = Math.floor(Date.now() / 86_400_000);
    if (!this.correlationMatrix || this.correlationMatrixUtcDay !== utcDay) {
      this.correlationMatrix = new CorrelationMatrix(this.dailyCandleCache);
      this.correlationMatrixUtcDay = utcDay;
    }
    return this.correlationMatrix;
  }

  /**
   * TRA-423 — run the correlation / concentration cap admission rule (spec §6)
   * for a long entry. Returns the position-size multiplier to apply to the
   * broker sizing (`1` = full size, `<1` = scaled down to the binding
   * headroom), or `null` when the entry is rejected — in which case
   * `signal.signalSkipReason` is stamped so the dashboard surfaces why.
   *
   * `sizedQty` is the broker-sized quantity; the candidate's dollar risk and
   * notional are derived from it. The position-count cap is a hard reject; the
   * cluster / portfolio risk and cluster-notional caps scale the candidate
   * down. This is an *additional* gate — the per-symbol dedup and the existing
   * cash / managed-equity caps still apply.
   */
  private clusterCapMultiplier(
    signal: TradeSignal,
    sizedQty: number,
    price: number,
    managedEquity: number,
    openPositions: ReadonlyArray<Position>,
  ): number | null {
    if (!this.correlationCapEnabled) return 1;
    if (!(sizedQty > 0)) return 1;
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const open = openPositions.map(p => ({
      symbol: p.symbol,
      risk: Math.abs(p.entryPrice - p.stopLoss) * p.quantity,
      notional: p.entryPrice * p.quantity,
    }));
    const decision = admitUnderClusterCap(
      { symbol: signal.symbol, risk: stopDistance * sizedQty, notional: price * sizedQty },
      open,
      managedEquity,
      this.getCorrelationMatrix().correlation,
      this.correlationCapConfig,
    );
    if (!decision.admitted) {
      const cluster = decision.clusterSymbols.join(', ');
      signal.signalSkipReason = decision.reason === 'max_positions_per_cluster'
        ? `correlation cap — cluster {${cluster}} already holds ${this.correlationCapConfig.maxPositionsPerCluster} positions`
        : `correlation cap — would scale below the ${(this.correlationCapConfig.minTradeRiskPct * 100).toFixed(2)}% min-trade-risk floor (cluster {${cluster}})`;
      return null;
    }
    return decision.scale;
  }

  /**
   * Lazily build a per-symbol regime-aware router (TRA-208). One router per
   * symbol keeps each ticker's RegimeDetector hysteresis state isolated from
   * the others. Strategies inside the router are also per-router because
   * MomentumStrategy carries `lastFireTs` state that would otherwise be
   * shared across symbols and rate-limit cross-asset signals incorrectly.
   *
   * TRA-421 — the caller passes the active preset's per-strategy universe so
   * the (cached) router gates momentum / breakout_vol / mean_reversion to
   * their validated symbol sets. It is re-applied every call rather than baked
   * in at construction because the active preset can change at runtime while
   * the per-symbol regime state must survive that change.
   */
  private getRouter(symbol: string, universe: RouterUniverse): StrategyRouter {
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
    // TRA-421 — re-point the (possibly cached) router at the current preset's
    // per-strategy universe before it evaluates this tick.
    r.setUniverse(universe);
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
  private applyShortGates(signal: TradeSignal, mode: 'demo' | 'live' = this.mode): void {
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

    // TRA-261 / TRA-255 §3.1 + §6 — book-wide pre-route caps. Counted against
    // the branch (demo or live) that produced the signal so a demo-paper short
    // cap doesn't bleed into the live broker's cooldown ledger.
    const bookReason = evaluateShortBookCaps(signal, {
      openShortCount: this.countOpenShorts(mode),
      symbolCooldownActive: symbolShortCooldownActive(
        signal.symbol,
        this.recentClosedShorts(mode),
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
   *
   * TRA-480 — `mode` defaults to `this.mode` so legacy callers stay scoped to
   * the engine's active mode; parallel-tick paths pass an explicit mode so
   * each branch counts against its own account book.
   */
  private countOpenShorts(mode: 'demo' | 'live' = this.mode): number {
    const positions = mode === 'live' && this.liveAccount
      ? this.liveAccount.getState().openPositions
      : this.account.getState().openPositions;
    let n = 0;
    for (const p of positions) if (p.side === 'sell') n++;
    return n;
  }

  /**
   * Closed-shorts feed for the §3.1 cooldown helper. Reads the closed-position
   * list scoped to the requested branch mode (the same lists the dashboard
   * reads), so a Demo session that just took 3 SOL losses doesn't suppress
   * Live shorts on the same ticker — and vice versa. Pre-TRA-242 snapshots
   * without a `closedAt` are filtered out (we can't bound them to the
   * cooldown window). TRA-480 — mode defaults to `this.mode`.
   */
  private recentClosedShorts(mode: 'demo' | 'live' = this.mode): ClosedShortTrade[] {
    const list = mode === 'live' ? this.liveClosedPositions : this.demoClosedPositions;
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

  private tick(): Promise<void> {
    if (this.tickRunning) return this.activeTick;
    this.tickRunning = true;
    this.activeTick = this.runTickGuarded();
    return this.activeTick;
  }

  private async runTickGuarded(): Promise<void> {
    try {
      await this.doTick();
    } catch (err: unknown) {
      log.error('tick error', { reason: err instanceof Error ? err.message : String(err) });
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

    // TRA-344 / TRA-437 — Coinbase Advanced Trade fallback for symbols the
    // primary cascade didn't carry, plus any open-position symbol outside the
    // watchlist (an imported holding must still render a real Current price).
    // PLUME-USD, for example, is only listed on Coinbase Advanced Trade;
    // previously its price column showed $0.00 (-100% P&L).
    //
    // TRA-437 — this fallback was gated behind `if (this.liveAccount)` and
    // routed through the *authenticated* `getProductPrices` on the live
    // broker's client. Demo crypto engines have no live broker, so they never
    // reached it: with Yahoo's breaker open and no CMC key, every watchlist
    // symbol was left without a quote and rendered "Quote unavailable —
    // provider rate-limited". It now runs for every engine (demo or live) via
    // the *keyless* public Advanced Trade market endpoint. RNDR-USD
    // post-rebrand still won't resolve here (Coinbase product is now
    // RENDER-USD) — that case is handled by the symbol alias map below.
    {
      const positionSymbols = new Set<string>();
      for (const p of this.account.getState().openPositions) positionSymbols.add(p.symbol);
      if (this.liveAccount) {
        for (const p of this.liveAccount.getState().openPositions) positionSymbols.add(p.symbol);
      }
      const fallbackTargets = new Set<string>();
      for (const sym of activeSymbols) {
        if (!quotes.has(sym)) fallbackTargets.add(sym);
      }
      for (const sym of positionSymbols) {
        if (!quotes.has(sym)) fallbackTargets.add(sym);
      }
      if (fallbackTargets.size > 0) {
        try {
          const cbQuotes = await fetchCoinbaseAdvancedTradeQuotes(Array.from(fallbackTargets));
          for (const [sym, q] of cbQuotes) {
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
        } catch (err: unknown) {
          log.warn('Coinbase fallback price lookup failed', {
            reason: err instanceof Error ? err.message : String(err),
          });
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

    // TRA-480 — candle refresh + freshness gate are shared between branches.
    // Done once per tick before either branch evaluates so the demo and live
    // paths read identical bar caches and feed-stale verdicts. Pre-TRA-480
    // each branch ran its own refresh in isolation; now that both branches
    // can run on the same tick we share the work to keep our Coinbase API
    // budget unchanged when a user is in live mode.
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

    // TRA-418 — data-feed freshness gate. Run after the candle refresh above so
    // a symbol whose feed is down is detected from the (now-attempted) cache
    // age, marked `quoteStatus: 'stale'`, and excluded from signal evaluation.
    const staleSymbols = this.markStaleSymbols(activeSymbols);

    // TRA-480 — demo branch ALWAYS runs, regardless of `this.mode`. The board
    // expects the demo dashboard to track `tra405_validated` deterministically
    // (TRA-456) so a user in live mode who flips back to demo lands on a fresh
    // candidate roster instead of the frozen snapshot from the last demo
    // session. Pre-TRA-480 this branch lived inside `if (this.mode !== 'live')`
    // and only ran in demo mode, which is what produced TRA-479's "Crypto Demo
    // idle" report — once the engine flipped to live the demo state froze
    // until the user switched back, and the candidate-strategy showcase the
    // board cares about under TRA-434's live stand-down went dark.
    await this.runDemoTick(prices, activeSymbols, quoteSources, staleSymbols);

    // TRA-480 — live branch is still mode-gated. Live trading is a
    // capital-allocation operation; it must NEVER run when the user is on
    // demo. The live broker also stays unbuilt in demo mode (see
    // `applySettings`), so this is belt-and-suspenders.
    if (this.mode === 'live' && this.liveAccount) {
      await this.runLiveTick(prices, activeSymbols, quoteSources, staleSymbols);
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
   * TRA-480 — the demo paper-account branch, extracted from `doTick`. Always
   * runs, regardless of `this.mode`. Resolves the DEMO_STRATEGY_PRESET so the
   * board's demo dashboard tracks a deterministic candidate roster even while
   * the live engine is on a different preset. Caller is responsible for
   * candle refresh and stale-feed detection (shared with the live branch in
   * `doTick`).
   */
  private async runDemoTick(
    prices: Map<string, number>,
    activeSymbols: string[],
    quoteSources: Map<string, PositionQuoteSource>,
    staleSymbols: Set<string>,
  ): Promise<void> {
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

    if (!this.isAutoTradingEnabled('demo')) return;

    // TRA-480 — explicit `mode='demo'` so the preset/short-gate helpers
    // resolve against the demo branch's contract even when `this.mode='live'`.
    const preset = this.resolvePreset('demo');
    const symbolAllowed = (sym: string) =>
      preset.symbolFilter === null || preset.symbolFilter.includes(sym);
    const strategyEnabled = (s: CryptoStrategyType) => preset.enabledStrategies.includes(s);
    let symbolsEvaluated = 0;
    let symbolsSkipped = 0;
    for (const sym of activeSymbols) {
      // TRA-418 — a stale feed must never produce a new entry signal. Skip
      // strategy evaluation entirely so no signal is even generated.
      if (staleSymbols.has(sym)) {
        symbolsSkipped++;
        continue;
      }
      const candles = this.candleCache.get(sym) ?? [];
      const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

      // Evaluate each strategy independently with its own minimum bar
      // requirement. TRA-421 — `presetAllowsStrategySymbol` combines the
      // preset-wide `symbolFilter` with the per-strategy `strategyUniverse`
      // whitelist, so bb_fade only fires on its validated symbols.
      const bbFadeSignal = candles.length >= CryptoSignalEngine.MIN_BARS_BB_FADE
        && strategyEnabled('bb_fade') && presetAllowsStrategySymbol(preset, 'bb_fade', sym)
        ? this.bbFade.evaluate(sym, candles) : null;
      const swingSignal = strategyEnabled('swing_trade')
        && presetAllowsStrategySymbol(preset, 'swing_trade', sym)
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
        ? this.getRouter(sym, preset.strategyUniverse ?? {}).evaluate(sym, candles) : null;
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
        this.applyShortGates(signal, 'demo');
        if (this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
        // TRA-480 — dedup against the demo branch only. Pre-TRA-480 the engine
        // ran one branch at a time so a single `recentSignals` window served
        // both modes; now that both branches can tick on the same minute, a
        // demo signal must not suppress a live signal (or vice versa) just
        // because it landed first.
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type
            && (s.mode ?? 'demo') === 'demo'
            && Date.now() - s.timestamp < 5 * 60_000,
        );
        if (recent) continue;

        // TRA-134: Defer dedup until we know a quote is available so a missing
        // quote doesn't block the signal from retrying for 5 minutes.
        const price = prices.get(sym);
        if (!price) {
          log.warn('no quote in cache — skipping (will retry next tick)', { sym, signalType: signal.type });
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
        // TRA-337 a frozen $4.05 entry), we don't open.
        const cbListed = isCoinbaseListed(sym);
        if (cbListed === false) {
          signal.signalSkipReason = `${sym} not listed on Coinbase Exchange — skipping entry (we only trade what Coinbase trades)`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        const source = quoteSources.get(sym);
        if (cbListed === true && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} listed on Coinbase but no Coinbase quote this tick (got ${source ?? 'no quote'}) — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        if (cbListed === null && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} no Coinbase quote and Coinbase product catalog unavailable — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }

        // TRA-423 — correlation / concentration cap (spec §6) on long entries.
        let clusterCapMultiplier = 1;
        if (signal.side === 'buy') {
          const sizedQty = this.account.sizeFromStop(signal.entryPrice, signal.stopLoss);
          const mult = this.clusterCapMultiplier(
            signal,
            sizedQty,
            price,
            this.account.managedEquity(),
            this.account.getState().openPositions,
          );
          if (mult === null) {
            log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
            continue;
          }
          clusterCapMultiplier = mult;
        }

        const opened = this.account.openPosition(signal, price, source, clusterCapMultiplier);
        if (opened) opened.mode = 'demo';
      }
    }
    if (symbolsSkipped > 0) {
      log.warn('tick: symbols skipped (no candle data)', { symbolsEvaluated, symbolsSkipped });
    }
  }

  /**
   * Live-mode tick: refresh Coinbase balance if stale, exit positions whose
   * TP/SL was hit, then evaluate strategies and open new positions on
   * Coinbase. Mirrors the demo-mode flow but every order hits the broker.
   *
   * TRA-480 — candle refresh + freshness verdict are computed once in
   * `doTick` and passed in. Pre-TRA-480 this method re-ran both on its own,
   * which doubled the Coinbase API budget once the demo branch also started
   * ticking on the same minute.
   */
  private async runLiveTick(
    prices: Map<string, number>,
    activeSymbols: string[],
    quoteSources: Map<string, PositionQuoteSource>,
    staleSymbols: Set<string>,
  ): Promise<void> {
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
    // they re-enable auto-trading. TRA-480 — explicit `'live'` so the gate
    // can't be flipped by an accidental this.mode toggle while this branch
    // is mid-flight (defensive; this.mode is checked before we get here).
    if (!this.isAutoTradingEnabled('live')) {
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
      log.warn('live exits error', { reason: err instanceof Error ? err.message : String(err) });
    }

    // TRA-480 — candle refresh + freshness verdict come from `doTick`. The
    // duplicate-refresh code that previously lived here is gone; the demo
    // branch primed the same caches we read below.

    // TRA-325 / TRA-480 — explicit `'live'` so the live branch always
    // resolves the live preset (LIVE_STRATEGY_PRESET or the user's saved
    // preset), even when called from a hypothetical future caller with
    // this.mode still on demo.
    const preset = this.resolvePreset('live');
    const symbolAllowed = (sym: string) =>
      preset.symbolFilter === null || preset.symbolFilter.includes(sym);
    const strategyEnabled = (s: CryptoStrategyType) => preset.enabledStrategies.includes(s);

    for (const sym of activeSymbols) {
      // TRA-418 — skip stale-feed symbols before any strategy runs.
      if (staleSymbols.has(sym)) continue;
      const candles = this.candleCache.get(sym) ?? [];
      const dailyCandles = this.dailyCandleCache.get(sym) ?? [];

      // TRA-421 — per-strategy universe gate (preset-wide filter + the
      // strategy's `strategyUniverse` whitelist). Mirrors the demo path.
      const bbFadeSignal = candles.length >= CryptoSignalEngine.MIN_BARS_BB_FADE
        && strategyEnabled('bb_fade') && presetAllowsStrategySymbol(preset, 'bb_fade', sym)
        ? this.bbFade.evaluate(sym, candles) : null;
      const swingSignal = strategyEnabled('swing_trade')
        && presetAllowsStrategySymbol(preset, 'swing_trade', sym)
        && dailyCandles.length >= 205
        ? this.swing.evaluate(sym, dailyCandles) : null;
      // TRA-208: same router pipeline as the demo path so live and paper
      // produce identical regime-aware entries from the same regime state.
      // TRA-421 — getRouter applies the per-strategy universe gate.
      const routerEnabled = strategyEnabled('momentum')
        || strategyEnabled('mean_reversion')
        || strategyEnabled('breakout_vol');
      const rawRouterSignal = routerEnabled && symbolAllowed(sym)
        && candles.length >= CryptoSignalEngine.MIN_BARS_ROUTER
        ? this.getRouter(sym, preset.strategyUniverse ?? {}).evaluate(sym, candles) : null;
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
        this.applyShortGates(signal, 'live');
        if (live.hasOpenPositionForSignalType(sym, signal.type)) continue;
        // TRA-480 — dedup against live-mode signals only; the demo branch
        // maintains its own recent-signal window in the same buffer.
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type
            && (s.mode ?? 'demo') === 'live'
            && Date.now() - s.timestamp < 5 * 60_000,
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
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        const source = quoteSources.get(sym);
        if (cbListed === true && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} listed on Coinbase but no Coinbase quote this tick (got ${source ?? 'no quote'}) — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        if (cbListed === null && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} no Coinbase quote and Coinbase product catalog unavailable — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }

        // TRA-423 — correlation / concentration cap (spec §6) on long entries.
        // Short entries route to Coinbase INTX perps via `openPerpShort`,
        // which is governed by the TRA-261 short notional caps instead.
        let clusterCapMultiplier = 1;
        if (signal.side === 'buy') {
          const sizedQty = live.sizeFromStop(signal.entryPrice, signal.stopLoss);
          const mult = this.clusterCapMultiplier(
            signal,
            sizedQty,
            price,
            live.managedEquity(),
            live.getState().openPositions,
          );
          if (mult === null) {
            log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
            continue;
          }
          clusterCapMultiplier = mult;
        }

        try {
          await live.openPosition(signal, price, source, clusterCapMultiplier);
        } catch (err: unknown) {
          log.warn('live open failed', { sym, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchCryptoMinuteBars(symbol, 80);
    if (bars.length > 0) this.candleCache.set(symbol, bars);
  }

  /**
   * TRA-418 — data-feed freshness gate.
   *
   * For each symbol, evaluate the age of its last quote (`symbolState
   * .lastUpdated`) and its backing minute-candle series against the staleness
   * thresholds. A symbol whose feed has gone stale is marked
   * `quoteStatus: 'stale'` (so the watchlist UI surfaces the degraded feed)
   * and returned in the result set; callers exclude those symbols from signal
   * evaluation entirely. This is the guard that stops the engine evaluating a
   * strategy — and firing a brand-new entry signal — off a cache that a dead
   * feed left behind (TRA-408 review §5).
   *
   * Runs after the per-tick candle refresh so the cache age reflects this
   * tick's fetch attempt: a feed that succeeded this tick reads fresh, a feed
   * that failed leaves the prior (now-older) bars in place.
   */
  private markStaleSymbols(symbols: readonly string[]): Set<string> {
    const stale = new Set<string>();
    const now = Date.now();
    for (const sym of symbols) {
      const state = this.symbolState.get(sym);
      const verdict = evaluateFeedFreshness(
        { quoteLastUpdated: state?.lastUpdated, candles: this.candleCache.get(sym) },
        now,
      );
      if (!verdict.stale) continue;
      stale.add(sym);
      // Reuse/extend the existing quoteStatus field (TRA-418). Preserve the
      // last known price/volume so the row still renders a number under the
      // "stale" badge instead of collapsing to a Loading… spinner.
      if (state) this.symbolState.set(sym, { ...state, quoteStatus: 'stale' });
      log.warn('feed stale; skipping signal evaluation', { sym, reason: verdict.reason });
    }
    return stale;
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
    // TRA-345 — surface the resolved preset so the active gating config can be
    // verified from /api/crypto/state without Render dashboard / log access.
    const resolvedPreset = this.resolvePreset();
    const activePreset: CryptoEngineState['activePreset'] = {
      id: resolvedPreset.id,
      envValue: FORCED_PRESET_ENV,
      enabledStrategies: resolvedPreset.enabledStrategies,
      symbolFilter: resolvedPreset.symbolFilter,
      // TRA-421 — per-strategy universe gate, omitted when the preset has none.
      ...(resolvedPreset.strategyUniverse
        ? { strategyUniverse: resolvedPreset.strategyUniverse }
        : {}),
    };
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
          activePreset,
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
        activePreset,
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
      activePreset,
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

  /**
   * TRA-480 — `mode` defaults to `this.mode` so the public API and
   * `buildState` keep their pre-fix semantics (surface only the active
   * mode's auto-trading flag). The parallel-tick paths pass an explicit
   * mode so the demo branch can gate on `autoTradingEnabledDemo` even when
   * the engine is in live mode.
   */
  isAutoTradingEnabled(mode: 'demo' | 'live' = this.mode): boolean {
    return mode === 'live' ? this.autoTradingEnabledLive : this.autoTradingEnabledDemo;
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
      log.warn('funding hourly tick failed', { reason: err instanceof Error ? err.message : String(err) });
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
