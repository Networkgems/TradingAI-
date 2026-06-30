import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { writeFile, readFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MarketScheduler, isMarketDay, isMarketDayIso, missedTradingDays, etDateString, isMarketOpen } from './scheduler.js';
import { generateEodReport } from './reports/eod-report.js';
import { generateCryptoEodReport } from './reports/crypto-eod-report.js';
import {
  listOptionTradeJournal,
  summarizeOptionTradeJournal,
  isOptionTradeJournalEnabled,
} from './option-trade-journal.js';
import { computeOptionLearnedWeights } from './learned-option-weights.js';
// TRA-1046 (TRA-1041c L2) — synchronous on-demand hypothesis backtest behind
// POST /api/backtest, reusing the audited apply→backtest→G0-grade pipeline.
import {
  runOnDemandBacktest,
  validateBacktestRequest,
  OnDemandBacktestBadRequest,
  type OnDemandBacktestRequest,
} from './backtest-on-demand.js';
import { makeBacktestExecutor, RV_CRYPTO_MAJORS_BASE_CONFIG } from './backtest-executor.js';
// TRA-1000 — external-intel source-quality scorer: per-source advisory weights
// folded from the attribution log × hypothesis-queue gate outcomes.
import { isExternalIntelEnabled } from './external-intel.js';
import { loadSourceQualityWeights } from './source-quality-scorer.js';
import { buildHypothesisQueueHealth } from './ratification-bridge.js';
// TRA-1003 — the scheduled trigger that actually FEEDS the external-intel queue.
// No-op tick while ENABLE_EXTERNAL_INTEL is off (deps aren't even built), so it
// is safe to arm at boot regardless of the flag.
import { startExternalIntelSchedule } from './external-intel-scheduler.js';
import {
  startAutonomousDemoSchedule,
  getAutonomousDemoStatus,
  isAutonomousDemoLoopEnabled,
  buildAutonomousDemoLoopReport,
  type DemoBookEngine,
  type AutonomousDemoLoopDeps,
} from './autonomous-demo-loop.js';
// TRA-1008 — file-backed override for non-secret DEMO flags. Lets a non-admin
// operator/agent flip ENABLE_AUTONOMOUS_DEMO_LOOP via <DATA_DIR>/demo-flags.json
// on a host where the SYSTEM-owned PM2 daemon is unreachable (no dotenv loader,
// env lives only in the saved process env). Secrets are never read from it.
import { resolveDemoFlagEnv } from './demo-flags.js';
// TRA-1006 — automated pre/post-market analyst agent. Tick fns are flag-checked
// before any deps are built (zero cost while ENABLE_ANALYST_AGENT is off) and are
// hooked onto the existing onPremarket / onArchive market-scheduler ticks.
import {
  isAnalystAgentEnabled,
  analystEtDate,
  readAnalystPlan,
  readAnalystReview,
} from './analyst-agent.js';
import {
  runAnalystPremarketTick,
  runAnalystPostmarketTick,
} from './analyst-scheduler.js';
// TRA-995 — self-awareness introspection (per-strategy attribution + edge-decay)
// folded from the same closed-trade journal that feeds the learned weights.
import {
  computeStrategyIntrospection,
  optionJournalToStrategyRows,
} from './strategy-introspection.js';
import {
  computeOptionsAlerts,
  scanTargetStop,
  diffChain,
  toAlertEvents,
} from './reports/options-alert-engine.js';
import {
  aggregateCashFlowByDate,
  aggregateRealizedOptionsPnl,
  computeBalanceDailyPnl,
  findPreviousBalanceSnapshot,
  realizedOptionsPnlByCloseDate,
} from './reports/tradier-reconcile.js';
import { createToken, verifyToken, generateResetToken, consumeResetToken, initResetTokenStore } from './auth.js';
import { initStateDb, getStateDb } from './sqlite.js'; // TRA-1052 — durable hot-state SQLite store
import { checkThrottle, recordFailure, recordSuccess } from './auth-throttle.js';
import { getSettings, loadSettings, mergeScopedRiskSettings, saveSettings } from './account-settings.js';
import {
  initNotificationDispatcher,
  emitAlert,
  registerChannelAdapters,
  buildSampleAlertEvent,
  issueLinkToken,
  consumeLinkToken,
  parseStartCommand,
  isValidDiscordWebhook,
  parseCommand,
  executeCommand,
  verifyDiscordRequest,
  extractInteraction,
  parseDiscordLinkToken,
  DISCORD_INTERACTION_TYPE,
  DISCORD_RESPONSE_TYPE,
  DISCORD_EPHEMERAL_FLAG,
  renderAlert,
  type CommandContext,
  type ChannelAdapter,
  type RoutineSummary,
} from './notifications/index.js';
import { LLM_KILL_ENV_VAR } from './trading-agents-advisory.js';
import {
  initWatchlistStore,
  getCryptoWatchlistData,
  getStocksWatchlistData,
  addCryptoSymbol,
  removeCryptoSymbol,
  addStocksSymbol,
  removeStocksSymbol,
  seedReviewLeaders,
} from './watchlist-store.js';
import { scanStocksMarket, scanCryptoMarket } from './market-scanner.js';
import { runPremarketForAllUsers } from './premarket-watchlist.js';
import { runMorningBriefForAllUsers, buildBriefForUser, buildMacroSection } from './morning-brief.js';
// TRA-851 — user-configurable natural-language routines.
import {
  loadRoutineStore,
  listRoutinesSync,
  usersWithRoutinesSync,
  addRoutine as addRoutineToStore,
  removeRoutine as removeRoutineFromStore,
  setRoutineEnabled as setRoutineEnabledInStore,
  type StoredRoutine,
} from './routines/routine-store.js';
import { parseRoutine, filterLabel, formatScan } from './routines/routine-spec.js';
import { RoutineRunner, type RoutineRendered } from './routines/routine-runner.js';
import { recordOptionChains } from './options-chain-recorder.js';
import { recordSentimentSnapshot } from './sentiment-snapshot-recorder.js';
import {
  fetchStockTwitsStream,
  fetchStockTwitsUserStream,
  getCuratedStockTwitsAccounts,
} from './stocktwits-feed.js';
// TRA-779 — replay smoke endpoint proves the captured chains are consumable by
// the run-options-replay pipe. Server already depends on @trading-app/backtest.
import {
  loadChainDays,
  runOptionsReplay,
  DEFAULT_REPLAY_CONFIG,
  estimateSpotFromChain,
} from '@trading-app/backtest';
import { buildIdeasFeed, getEntryIntent } from './options-ideas-service.js';
import { isOptionsProposalRailEnabled, isOptionDemoAutoConfirmEnabled } from './option-exec-flag.js';
import {
  getUserAnthropicApiKey,
  setUserAnthropicApiKey,
  clearUserAnthropicApiKey,
  describeUserAnthropicApiKey,
} from './anthropic-cred-store.js';
import { optionsSpendStatus } from './options-spend-store.js';
import { agentSpendAggregate } from './agent-spend-store.js';
import { executionCapStatus } from './agent-execution-caps-store.js';
import { proposalTtlMs } from './proposal-store.js';
import { initIvRankStore, recordDailyIv, ivRankSync, atmIvFromRows } from './iv-rank-store.js';
import { initIdeaJournal, listJournalEntries } from './options-idea-journal.js';
import { initShadowLedger, listShadowSignals } from './shadow-signal-ledger.js';
import { initOptionShadowLedger, listOptionShadowSignals, isOptionShadowEnabled, OPTION_SHADOW_EMERGENCY_OFF } from './option-shadow-ledger.js';
import {
  initReversalShadowLedger,
  listReversalShadowSignals,
  isReversalShadowEnabled,
  reversalHitRateByScore,
} from './reversal-shadow-ledger.js';
import { computeLearnedWeights } from './learned-signal-weights.js';
import { isLearnedShrinkageEnabled } from './learned-shrinkage-flag.js';
import {
  loadUserMemoryStore,
  getUserMemory,
  setUserMemory,
  getInteractionStats,
} from './user-trading-memory-store.js';
import {
  forwardTestIdeas,
  buildForwardTestReport,
  defaultChainsDir,
} from './options-forward-test.js';
import { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } from './live-capital-gate.js';
import {
  loadProposalsScorecard,
  buildAiIdeasScorecard,
  buildEngineScorecard,
} from './engine-scorecard.js';
import { resolveBuildInfo } from './observability/build-info.js';
import {
  generateMarketReview,
  getLatestMarketReview,
  getFreshMarketReview,
  isReviewStale,
  defaultReviewKind,
  listMarketReviews,
  peekMarketRegime,
} from './market-review.js';
import {
  loadUsers,
  validateUserCredentials,
  changeUserPassword,
  getUserByEmail,
  getUser,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  isUserLocked,
  setUserLocked,
} from './users.js';
import { sendPasswordResetEmail } from './email.js';
import { startEventLoopWatchdog, type WatchdogHandle } from './event-loop-watchdog.js';
import {
  logger,
  flushLogs,
  traceMiddleware,
  runWithTrace,
  setTraceUser,
  captureException,
  installGlobalErrorHandlers,
  errorMiddleware,
  TradeAuditTracker,
  getTradeOpenCount,
  getRecentAlerts,
  getErrorCountSince,
  runHealthCheck,
  checkDiskSpace,
  recordBootAndCheckRestarts,
  checkTradeVolume,
  checkErrorSpike,
  registerLiveHealthRoutes,
  runStaleStateCheck,
} from './observability/index.js';
import {
  rotateBackups,
  checkDataDirHealth,
  loadStocksTradeSnapshot,
  loadCryptoTradeSnapshot,
  type StocksTradeSnapshot,
  type CryptoTradeSnapshot,
} from './trade-store.js';
import {
  buildExport,
  toCsv,
  type ExportFilters,
  type ExportFormat,
  type ExportMarket,
} from './export.js';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import {
  CoinbaseOrderClient,
  tradierBaseUrl,
  TradierOptionsClient,
} from '@trading-app/engine';
import { submitSmartSellToClose } from './tradier-smart-close.js';
import type { TradierEnv } from '@trading-app/shared';
import { fetchQuotes } from './yahoo-feed.js';
import {
  runFirstBootMigration,
  runTra237OptionsReset,
  runTra241CalendarReset,
  runTra301DemoFreshStart,
  runTra330CryptoEquityReset,
  runTra338MegaUsdCleanup,
  initAllUserContexts,
  initUserContext,
  ensureUserContext,
  destroyUserContext,
  getAllUserContexts,
  tryGetUserContext,
  persistStocksNow,
  persistCryptoNow,
  setRvScanner,
  stockModeKey,
  cryptoModeKey,
  stockReportsDirFor,
  cryptoReportsDirFor,
  type StockModeKey,
  type CryptoModeKey,
  type UserContext,
} from './user-context.js';
import {
  resolveTradierOptionsCreds,
  STRATEGY_PRESETS,
  DEFAULT_STRATEGY_PRESET_ID,
  WATCHLIST,
  aliasWatchlistSymbol,
  aggregateStockTwitsSentiment,
  dedupeStockTwitsMessages,
  mapCuratedMessagesBySymbol,
  type StockTwitsMessage,
  validateLiveCredentials,
  validateProductionTradierKeys,
  type AccountSettings,
  type NewsItem,
  type ResearchReport,
  type StrategyPresetId,
  type Position,
  type OptionPosition,
  type AccountMode,
  ALERT_CHANNELS,
  resolveAlertPreferences,
  type AlertChannel,
  type AlertPreferences,
} from '@trading-app/shared';
import {
  saveResearchReport,
  listResearchReports,
  getResearchReport,
  getLatestReviewBlock,
  seedSampleResearchReportIfEmpty,
  ResearchValidationError,
} from './research-store.js';
// TRA-596 (TRA-595 C1) — upcoming-earnings calendar feed/store + refresh job.
import {
  initEarningsStore,
  refreshEarningsCalendar,
  makeEarningsClientFromEnv,
} from './earnings-store.js';
// TRA-597 (TRA-595 C2) — macro / Fed economic-event calendar feed/store + refresh.
import {
  initMacroStore,
  refreshMacroCalendar,
  makeMacroClientFromEnv,
} from './macro-store.js';
// TRA-532 — Live-Trading Promotion Gate enforcement + audit store/service.
import {
  registerBacktestReport,
  registerOptimizationVerdict,
  recordSignoff,
  listStrategyRecords,
  getEffectiveThresholds,
  ensureStrategyRegistered,
  PromotionValidationError,
} from './promotion-store.js';
import {
  buildPromotionStatus,
  buildPublicPromotionProbe,
  snapshotPaperMetrics,
  evaluateLiveTransitionGate,
} from './promotion-service.js';

const log = logger.child({ module: 'index' });

const PORT = Number(process.env.PORT ?? 4242);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');

// TRA-1008 — effective env for demo-loop flags: process.env with the
// allowlisted <DATA_DIR>/demo-flags.json values layered on top. Re-read on each
// call so an operator's file flip is picked up on the next tick / probe.
const demoFlagEnv = (): NodeJS.ProcessEnv => resolveDemoFlagEnv(DATA_DIR);

// TRA-140 — log DATA_DIR and warn loudly if it's ephemeral.
await checkDataDirHealth();

// Load users and reset tokens from persistent storage.
await loadUsers();
initResetTokenStore(DATA_DIR);

// TRA-1052 (TRA-1045 R1) — open the durable hot-state SQLite store on the Render
// disk (DATA_DIR) BEFORE any per-user context boots, so the agent-spend committed
// ledger rehydrates and account-settings reads hit the db. Fail-soft: if the
// native binary is unavailable this disables durable hot-state and logs, but the
// server still boots (stores fall back to in-memory/JSON).
initStateDb(DATA_DIR);

// TRA-801 — ensure SupertrendConfluence has a promotion record so its Stage-2
// paper accrual surfaces on the `GET /api/promotion/status` overview list (which
// iterates registered strategies). Creates an EMPTY record only — backtest stays
// `missing` (Stage 1 blocked on TRA-382) and sign-off `absent`, so the gate keeps
// `canGoLive=false`. Idempotent; never clobbers an existing record.
await ensureStrategyRegistered('supertrend_confluence').catch(err =>
  log.warn('TRA-801 ensureStrategyRegistered(supertrend_confluence) failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-191 — server-side relative-value scanner. The only options strategy
// active for stock options in this iteration; OTM mispricing and per-equity
// ATM auto-open are disabled. Wired into user-context BEFORE any contexts
// are constructed so every per-user SignalEngine sees the same scanner
// instance and shares the 60s chain cache + 1h breaker. Uses Yahoo's
// existing quote pipeline as the spot source so we don't pay for Tradier
// quotes too.
//
// Credentials resolution by `TRADIER_ENV`:
//   • `production` → TRADIER_API_TOKEN + TRADIER_ACCOUNT_ID
//   • `sandbox` (default) → TRADIER_SANDBOX_API_TOKEN + TRADIER_SANDBOX_ACCOUNT_ID,
//     falling back to the unprefixed pair when the sandbox-specific ones
//     are missing (so legacy single-pair setups still work).
// Reports `no_credentials` when the resolved pair is empty — the engine
// then simply skips options scanning, equity trading is unaffected.
const tradierEnv = (process.env['TRADIER_ENV'] as 'sandbox' | 'production') ?? 'sandbox';
const tradierApiToken = tradierEnv === 'production'
  ? process.env['TRADIER_API_TOKEN']
  : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']);
const tradierAccountId = tradierEnv === 'production'
  ? process.env['TRADIER_ACCOUNT_ID']
  : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']);

const relativeValueScannerService = new TradierRelativeValueScannerService({
  tradierApiToken,
  tradierAccountId,
  tradierEnv,
  fetchSpot: async (symbol) => {
    // TRA-552 — the RV scanner only needs an underlying spot for options
    // mispricing math, which tolerates a few seconds of staleness. Reuse a
    // recent watchlist/engine quote (up to 15s old) from the shared quote cache
    // instead of firing a fresh per-symbol Tradier call — Tradier is now the
    // sole stock-quote source and these per-symbol spot fetches were a large
    // slice of the daily request counter.
    const quotes = await fetchQuotes([symbol], { maxStaleMs: 15_000 });
    const q = quotes.get(symbol);
    return q && q.price > 0 ? q.price : null;
  },
});
setRvScanner(
  relativeValueScannerService.diagnostics().configured ? relativeValueScannerService : undefined,
);
log.info('rv-scanner initialized', {
  env: tradierEnv,
  configured: relativeValueScannerService.diagnostics().configured,
});

// TRA-563 (TRA-410 A1) — install the notification dispatcher. Preferences are
// resolved from the cache-first per-user settings (warm once a user's context
// is created).
// TRA-566 (TRA-410 A2) — register the email / Telegram / Discord channel
// adapters. Each is inert until configured (SMTP creds / a linked Telegram chat
// / a pasted Discord webhook), so an unconfigured channel is skipped cleanly.
const notificationDispatcher = initNotificationDispatcher({
  loadSettings: (username) => getSettings(username),
});
const channelAdapters = registerChannelAdapters(notificationDispatcher);
log.info('notification dispatcher initialized', {
  channels: ALERT_CHANNELS,
});

// TRA-142 — migrate legacy global files into the admin namespace exactly once,
// then bootstrap per-user contexts (engines, trackers, persistence timers) for
// every known user. New signups get their context created on demand.
await runFirstBootMigration('admin');
// TRA-237 — one-shot cleanup of options buckets corrupted by the pre-fix
// importTradeSnapshot() routing. Runs before context bootstrap so engines
// load from the cleared snapshot. Idempotent via marker file.
await runTra237OptionsReset();
// TRA-241 — paired with the 9 PM dailyPnl reset fix: the board asked for a
// fresh P&L calendar across every account so the historical view starts
// clean. Wipes per-user EOD reports + daily-snapshots before PnlTracker
// reads them on first construction. Idempotent via marker file.
await runTra241CalendarReset();
// TRA-301 — full demo fresh-start: with the new strategy generation rolling
// out for both Stocks and Crypto, the board asked to wipe every user's
// persisted demo P&L, equity baselines, trade history, and calendar reports
// so the dashboards open clean on the new strategies. Runs before context
// bootstrap so engines load empty. Idempotent via marker file.
await runTra301DemoFreshStart();
// TRA-330 — one-shot crypto equity reset: prod demo crypto accounts drifted
// into the billions because of a short cash-flow accounting bug. The bug
// itself is fixed in crypto-account.ts; this migration clears the persisted
// snapshots that already loaded the bad state. Crypto-only, idempotent.
await runTra330CryptoEquityReset();
// TRA-338 — surgical removal of the phantom MEGA-USD paper position opened
// off Yahoo's frozen $4.05 ghost ticker (root cause in TRA-337). Refunds the
// recorded cost basis to cash and drops the position before the engine boots
// off the cleaned snapshot. Runs after TRA-330 so the equity reset (which
// may itself wipe trades-crypto.json) doesn't undo the cleanup mid-flight.
// Idempotent via marker file.
await runTra338MegaUsdCleanup();
await initAllUserContexts();

// TRA-227 — drop a placeholder QuantTrader research report so the Stocks
// News tab has visible "Research" content the first time the server boots.
// No-op once the store has at least one report, so real reports posted via
// `/api/research/reports` aren't shadowed.
await seedSampleResearchReportIfEmpty();

// TRA-386 / TRA-589 — warm the market-review feed on boot so the dashboard
// banner and News tab reflect the *current* regime before the first scheduled
// fire. Regenerates when there is no review yet OR the latest is stale —
// predates the current ET session or came from a dark trend feed — so a deploy
// that repairs the feed (e.g. the TRA-586 Tradier fallback) reflects
// immediately instead of serving the last persisted YELLOW review until the
// next scheduled job. Fired non-blocking: a cold/slow feed must not delay
// startup.
void getLatestMarketReview().then(existing => {
  if (!isReviewStale(existing)) return;
  void generateMarketReview(existing?.kind ?? defaultReviewKind()).catch(err =>
    log.error('market-review boot-time generation failed', {
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
});

// TRA-950 (Part B) — auto-seed the active watchlist from the latest desk review
// block's leaders, for every user, at boot. De-duped + capped + tagged
// review-sourced inside `seedReviewLeaders` (advisory invalidation levels are
// recorded as metadata; no new order behavior). Non-blocking: a missing/empty
// block is a no-op, and a slow disk read must not delay startup.
void getLatestReviewBlock()
  .then(async block => {
    if (!block || block.leaders.length === 0) return;
    let seededUsers = 0;
    for (const ctx of getAllUserContexts()) {
      try {
        const { reviewSourced } = await seedReviewLeaders(ctx.username, block);
        if (reviewSourced.length) seededUsers += 1;
      } catch (err) {
        log.warn('review-leader watchlist seed failed', {
          username: ctx.username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log.info('seeded review leaders into watchlists', {
      leaders: block.leaders.length,
      seededUsers,
    });
  })
  .catch(err =>
    log.error('review-leader boot seed failed', {
      reason: err instanceof Error ? err.message : String(err),
    }),
  );

// TRA-596 (TRA-595 C1) — warm the earnings-calendar cache from disk so the
// synchronous accessor (`earningsInDaysSync`) the engine reads each tick has
// data immediately, then kick a non-blocking refresh of the active stock
// universe. A slow/absent provider must never delay server startup.
await initEarningsStore();
void runEarningsRefresh();

// TRA-597 (TRA-595 C2) — warm the macro/Fed economic-calendar cache from disk
// (the curated FOMC schedule is available even before the first fetch), then
// kick a non-blocking refresh. A slow/absent provider must never delay startup.
await initMacroStore();
void runMacroRefresh();

// TRA-604 (TRA-595 C4b) — warm the trailing-IV store from disk so the
// synchronous `ivRankSync` read used by the AI Options Ideas fusion has data
// available right after boot. The store is appended to as chains are pulled.
await initIvRankStore();

// TRA-601 (TRA-595 C6) — warm the forward-test idea journal so the report read
// has the surfaced-idea history available right after boot. The journal is
// appended to (deduped) every time the live ideas feed is built.
await initIdeaJournal();

// TRA-791 — warm the SupertrendConfluence shadow signal->outcome ledger so the
// research read endpoint has the labelled history available right after boot.
// The engine appends OPEN rows on each new shadow signal and RESOLVED rows as
// the forward horizon labels them.
await initShadowLedger();

// TRA-911 (TRA-908 Phase A) — warm the flag-gated SHADOW option-trade signal
// ledger so the read endpoint has history right after boot. The selector that
// appends to it is observe-only and OFF unless ENABLE_OPTION_SHADOW_SELECTOR is
// set; nothing here routes an order.
await initOptionShadowLedger();

// TRA-921 (TRA-920 B) — warm the OBSERVE-ONLY reversal-checklist shadow ledger so
// the read endpoint has history right after boot. The signal-engine tick appends
// rows when ENABLE_REVERSAL_SHADOW is set; nothing here routes an order.
await initReversalShadowLedger();

// TRA-850 — warm the persistent per-user trading-memory store from disk so the
// synchronous `getUserMemorySync` read the advisory tick uses has each user's
// preferences immediately. Appended to as users state preferences or as
// approve/reject interactions accrue.
await loadUserMemoryStore();

// TRA-851 — warm the per-user routine store so the synchronous reads the
// scheduler's routine tick does (`listRoutinesSync`/`usersWithRoutinesSync`)
// have each user's defined routines immediately, and they survive a restart.
await loadRoutineStore();

const app = express();
// TRA-404 — behind Render's proxy the socket address is the proxy, not the
// client. Trust the X-Forwarded-For chain so `req.ip` is the real caller IP
// (used to key the auth-endpoint brute-force throttle).
app.set('trust proxy', true);

// ── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  // TRA-413 — allow the desktop client to send `X-Trace-Id` (not a CORS-
  // safelisted header) so its requests correlate with the traces they produce,
  // and expose the response header so a client can read the id the server
  // filed under. `Max-Age` lets the browser cache the preflight so a polling
  // client does not re-preflight every request.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// TRA-406 — open a trace for every request so logs, captured errors and the
// `X-Trace-Id` response header all correlate to the same request.
app.use(traceMiddleware);

// TRA-852 — stash the exact raw request bytes on the request during JSON
// parsing. The Discord Interactions endpoint must verify the Ed25519 signature
// against the byte-for-byte body Discord signed; re-serializing the parsed
// object would not round-trip (key order, whitespace), so we capture the buffer
// here. It is just a reference to the buffer express.json already holds — no
// extra copy — and is read by exactly one route.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

// ── Auth middleware ───────────────────────────────────────────────────────────

function firstHeader(val: string | string[] | undefined): string | undefined {
  return Array.isArray(val) ? val[0] : val;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = firstHeader(req.headers.authorization);
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const user = verifyToken(header.slice(7));
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  res.locals['authUser'] = user;
  // TRA-406 — stamp the authenticated user onto the request trace so every
  // subsequent log line and captured error carries it.
  setTraceUser(user);
  next();
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const username = res.locals['authUser'] as string;
  const user = getUser(username);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Resolve the per-user context for the authenticated user. Falls back to
 * lazily creating one if it isn't present (defensive — initAllUserContexts
 * should have built it at boot, and signup builds it on creation). When a
 * brand-new context is built here, also attach WS broadcast handlers so the
 * user's clients receive engine ticks.
 */
async function userCtx(res: express.Response): Promise<UserContext> {
  const username = res.locals['authUser'] as string;
  const wasNew = !tryGetUserContext(username);
  const ctx = await ensureUserContext(username);
  if (wasNew) attachBroadcastHandlers(ctx);
  return ctx;
}

// ── EOD Report generation ────────────────────────────────────────────────────

/**
 * Generate and persist the stocks EOD report.
 *
 * `opts.asOfDate` (TRA-388) — when set, this is a *backfill* run for a past
 * trading day whose 21:00 ET archive tick was missed (server offline). A
 * backfill:
 *   - stamps the report with `asOfDate` and selects that day's closed trades
 *     (still retained in engine state — archiving never ran);
 *   - skips the Tradier reconcile + broker-truth `combinedPnl` override: that
 *     path keys off *today's* Tradier balance and would mis-stamp a past
 *     cell. Per-day broker-truth reconstruction of missed days is a separate
 *     follow-up;
 *   - does not touch `latest.json` / the equity tracker / WS broadcast, so
 *     filling an old gap can't clobber the genuine latest report or rebase
 *     the live dashboard's opening equity.
 */
async function generateAndSaveReport(
  ctx: UserContext,
  opts: { asOfDate?: string } = {},
): Promise<void> {
  const backfill = opts.asOfDate != null;
  // TRA-244 — write under the active stocks bucket (demo / live / sandbox)
  // so the per-account calendar shows only the rows that belong to it.
  const settings = getSettings(ctx.username);
  const mode = stockModeKey(settings);
  const targetDir = stockReportsDirFor(ctx, mode);

  // TRA-348 — when the user is in live mode, pull recent Tradier history
  // and merge any closes the engine didn't process (manual closes on the
  // broker UI, or `sell_to_close` orders that resolved after the 5s
  // wait window) into the per-day reports for the active env. Failures
  // here must not block the local report from being written.
  if (settings.mode === 'live' && !backfill) {
    try {
      await reconcileTradierOptionsHistory(ctx, settings, mode);
    } catch (err) {
      log.warn('tradier-reconcile failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Re-pull the snapshot AFTER reconcile so the report's `optionsPnl`
  // reflects any Tradier-side closes we just merged (the dashboard pill
  // reads the same aggregate).
  const finalSnapshot = ctx.engine.getReportSnapshot();
  // TRA-991 — fold the demo option-trade journal (TRA-990) into the report so
  // the EOD markdown carries the journal P&L + learned-weights section. The
  // journal is demo-only and observe-only; gate the read on the flag so a
  // disabled journal adds no section and no I/O surprise.
  if (isOptionTradeJournalEnabled()) {
    try {
      await ctx.engine.flushOptionTradeJournal?.();
      const journalRows = await listOptionTradeJournal({ mode: 'demo' });
      finalSnapshot.optionJournal = summarizeOptionTradeJournal(journalRows);
      finalSnapshot.optionLearnedWeights = computeOptionLearnedWeights(journalRows);
      // TRA-995 — the self-awareness readout off the same journal: per-strategy
      // attribution + the edge-decay flag the autopilot throttles on.
      finalSnapshot.introspection = computeStrategyIntrospection(
        optionJournalToStrategyRows(journalRows),
      );
    } catch (err) {
      log.warn('option-trade-journal EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1000 — fold the external-intel source-quality scorer into the report so
  // the EOD markdown carries per-source advisory weights. Gate the read on
  // ENABLE_EXTERNAL_INTEL so a firm not running intel adds no section/I/O. The
  // weights are advisory only — they never size capital or gate promotion.
  if (isExternalIntelEnabled()) {
    try {
      finalSnapshot.sourceQualityWeights = await loadSourceQualityWeights();
    } catch (err) {
      log.warn('source-quality EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-1004 — fold the autonomous demo-loop status into the report so the EOD
  // markdown shows the loop's activity (ticks, books driven, autopilot halts /
  // throttles) for the demo book. Gated on ENABLE_AUTONOMOUS_DEMO_LOOP so a firm
  // not running the loop adds no section. Status is firm-wide (the conductor
  // drives every demo book), surfaced on each demo book's report for visibility.
  if (isAutonomousDemoLoopEnabled(demoFlagEnv()) && settings.mode === 'demo') {
    finalSnapshot.autonomousDemoLoop = buildAutonomousDemoLoopReport(demoFlagEnv());
  }
  // TRA-1006 — fold the analyst agent's pre-market plan + post-market review into
  // the EOD markdown (demo book only). Gated on ENABLE_ANALYST_AGENT; reads the
  // persisted artifacts for the day (absent ↔ no section). Advisory surfacing only
  // — emitted hypotheses still clear G0 + board ratification before any effect.
  if (isAnalystAgentEnabled() && settings.mode === 'demo') {
    try {
      const analystDate = opts.asOfDate ?? analystEtDate(Date.now());
      const analystPlan = await readAnalystPlan(analystDate);
      if (analystPlan) finalSnapshot.analystPlan = analystPlan;
      const analystReview = await readAnalystReview(analystDate);
      if (analystReview) finalSnapshot.analystReview = analystReview;
    } catch (err) {
      log.warn('analyst EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // TRA-998 — fold the live cross-producer hypothesis ratification queue + the
  // ratified demo overrides into the EOD markdown (demo book only) so the board
  // sees what is staged for confirmation and what has landed behind a flag. The
  // queue read is cheap (empty map when no producer has ever enqueued) and the
  // section self-suppresses when nothing is staged AND nothing ratified.
  if (settings.mode === 'demo') {
    try {
      finalSnapshot.hypothesisQueue = await buildHypothesisQueueHealth();
    } catch (err) {
      log.warn('hypothesis-queue EOD fold failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let finalReport = generateEodReport(finalSnapshot, opts.asOfDate);

  // TRA-359 — in live mode, override the report's `combinedPnl` with the
  // Tradier-truth daily delta (today.balance − prev.balance − netCashFlow)
  // so the Live calendar mirrors what the user sees on the broker. The
  // engine view of realized / unrealized / options is left intact for
  // diagnostic context — a markdown header documents the override.
  if (settings.mode === 'live' && !backfill) {
    try {
      const todayBalance = finalSnapshot.state.account.totalEquity;
      const override = await reconcileTradierLiveCalendar(
        ctx,
        settings,
        mode,
        todayBalance,
        finalReport.date,
      );
      if (override) {
        finalReport = applyTradierBalanceOverride(finalReport, override, todayBalance);
      }
    } catch (err) {
      log.warn('tradier-live-calendar override failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const datePath = join(targetDir, `${finalReport.date}.json`);
  const mdPath = join(targetDir, `${finalReport.date}.md`);

  const writes: Promise<void>[] = [
    writeFile(datePath, JSON.stringify(finalReport, null, 2), 'utf-8'),
    writeFile(mdPath, finalReport.markdown, 'utf-8'),
  ];
  // A backfill is for an old date — never let it become "latest".
  if (!backfill) {
    writes.push(
      writeFile(join(targetDir, 'latest.json'), JSON.stringify(finalReport, null, 2), 'utf-8'),
      writeFile(join(targetDir, 'latest.md'), finalReport.markdown, 'utf-8'),
    );
  }
  await Promise.all(writes);

  // Persist daily equity snapshot for cumulative tracking. Skipped on a
  // backfill: `saveSnapshot` rebases the dashboard's opening equity to the
  // snapshot's closing equity, so writing a stale past row would corrupt the
  // live daily-P&L baseline.
  if (!backfill) {
    const equitySnap = ctx.engine.getEquitySnapshot();
    ctx.tracker.saveSnapshot({
      date: finalReport.date,
      openingEquity: ctx.tracker.getOpeningEquity(),
      closingEquity: equitySnap.equity,
      dailyPnl: equitySnap.equity - ctx.tracker.getOpeningEquity(),
      optionsPnl: equitySnap.optionsPnl,
      combinedPnl: (equitySnap.equity - ctx.tracker.getOpeningEquity()) + equitySnap.optionsPnl,
      trades: finalSnapshot.allClosedPositions.length,
    });
  }

  log.info(`EOD report ${backfill ? 'backfilled' : 'saved'}`, {
    username: ctx.username,
    datePath,
  });

  if (!backfill) {
    broadcastToUser(ctx.username, JSON.stringify({ type: 'eod_report', payload: finalReport }));
  }
}

/**
 * TRA-388 — backfill EOD reports for trading days the 21:00 ET archive tick
 * missed because the server was offline during its fire window (the desktop
 * server is routinely closed overnight; a Render redeploy or crash has the
 * same effect). Without this, a missed day was silently lost forever and the
 * Calendar showed a permanent gap — the recurring "Calendar issue".
 *
 * Runs at startup and again at the top of `runDailyCloseForAllUsers`, so a
 * gap is healed at the earliest opportunity — crucially before the archive
 * step clears `allClosedPositions`, while the missed day's closed trades are
 * still retained in engine state and can be selected by `closedAt` date.
 *
 * Safe to call repeatedly: `missedTradingDays` only returns days with no
 * report file, so an already-backfilled day is skipped.
 */
async function catchUpMissedEodReports(): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const ctx of getAllUserContexts()) {
    try {
      const mode = stockModeKey(getSettings(ctx.username));
      const dir = stockReportsDirFor(ctx, mode);
      let existing: string[] = [];
      try {
        existing = (await readdir(dir))
          .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .map(f => f.slice(0, 10));
      } catch {
        existing = [];
      }
      const missed = missedTradingDays(existing, today);
      if (missed.length === 0) continue;
      log.info('reports catch-up: backfilling missed EOD reports', {
        username: ctx.username,
        missedCount: missed.length,
        missed: missed.join(', '),
      });
      for (const date of missed) {
        try {
          await generateAndSaveReport(ctx, { asOfDate: date });
        } catch (err) {
          log.error('reports catch-up failed', {
            username: ctx.username,
            date,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.error('reports catch-up scan failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── TRA-348: Tradier history reconcile ───────────────────────────────────────

const TRADIER_RECONCILE_LOOKBACK_DAYS = 7;

/**
 * TRA-348 — pull Tradier history for the active live env over the last
 * `LOOKBACK_DAYS` and merge realized options closes into the local
 * per-day reports + the engine's live-mode `optionsPnl` counter.
 *
 * Dedup is enforced via a per-user / per-env cursor file under
 * `<dataDir>/tradier-history-cursor.<env>.json` so a re-fetch over the
 * same window doesn't double-count. The cursor stores the set of seen
 * Tradier event ids; a future ticket can prune it once Tradier's own
 * retention drops out of the lookback window.
 */
async function reconcileTradierOptionsHistory(
  ctx: UserContext,
  settings: AccountSettings,
  mode: StockModeKey,
): Promise<void> {
  if (mode === 'demo') return;
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) return;

  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const startMs = today.getTime() - TRADIER_RECONCILE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const start = new Date(startMs).toISOString().slice(0, 10);

  let fills;
  try {
    fills = await client.listAccountHistory({ start, end, type: 'trade', limit: 1000 });
  } catch (err) {
    log.warn('tradier-reconcile history fetch failed', {
      username: ctx.username,
      env,
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (fills.length === 0) return;

  const cursor = await loadTradierHistoryCursor(ctx, env);
  const knownIds = new Set(cursor.seenIds);
  const totals = aggregateRealizedOptionsPnl(fills, knownIds);

  if (totals.seenTransactionIds.size === 0) return;

  // TRA-367 — `recordImportedFill` / `finalizePendingExit` for imports
  // attribute realised P&L to `optionsPnlByMode.live` in realtime so the
  // dashboard pill updates the moment a sell_to_close fills. Those fills
  // ALSO show up in Tradier's account history, so the broker-side total
  // below would double-count them. Drain the per-date realtime tally
  // here and subtract it from the broker total before bumping the pill.
  // The per-day sidecar (used by the calendar) still gets the full
  // broker-side total since it's the canonical "this is what Tradier
  // settled today" record.
  const realtimeByDate = ctx.engine.consumeRealtimeImportedPnl(env);
  let realtimeOffset = 0;
  for (const v of realtimeByDate.values()) realtimeOffset += v;

  // Bump the engine's live-mode P&L bucket by the sum of newly reconciled
  // realized P&L across all dates in the window so the dashboard pill
  // updates on the next state broadcast. Subtract the realtime offset so
  // closes we already attributed via {@link applyRealtimeImportedPnl}
  // aren't counted again.
  let added = 0;
  for (const realized of totals.realizedByDate.values()) added += realized;
  const netAdded = added - realtimeOffset;
  if (netAdded !== 0) ctx.engine.addReconciledTradierOptionsPnl(env, netAdded);

  // Persist per-day totals onto a sidecar so `mergeReconciledDailyTotalsIntoReport`
  // can sum across runs (the cursor file is the dedup source of truth;
  // the daily totals sidecar is the merge target).
  const dailyTotals = await loadTradierDailyTotals(ctx, env);
  for (const [date, realized] of totals.realizedByDate) {
    dailyTotals[date] = (dailyTotals[date] ?? 0) + realized;
  }
  await saveTradierDailyTotals(ctx, env, dailyTotals);

  // Update cursor so subsequent runs skip these ids.
  for (const id of totals.seenTransactionIds) cursor.seenIds.push(id);
  await saveTradierHistoryCursor(ctx, env, cursor);

  log.info('tradier-reconcile merged new fills', {
    username: ctx.username,
    env,
    newFills: totals.seenTransactionIds.size,
    realizedAdded: Number(added.toFixed(2)),
    realtimeOffset: Number(realtimeOffset.toFixed(2)),
    netAddedToPill: Number(netAdded.toFixed(2)),
    days: totals.realizedByDate.size,
  });
}

interface TradierHistoryCursor {
  seenIds: string[];
}

function tradierCursorPath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-history-cursor.${env}.json`);
}

function tradierDailyTotalsPath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-options-pnl.${env}.json`);
}

async function loadTradierHistoryCursor(
  ctx: UserContext,
  env: TradierEnv,
): Promise<TradierHistoryCursor> {
  const path = tradierCursorPath(ctx, env);
  if (!existsSync(path)) return { seenIds: [] };
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TradierHistoryCursor>;
    return { seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter(s => typeof s === 'string') : [] };
  } catch {
    return { seenIds: [] };
  }
}

async function saveTradierHistoryCursor(
  ctx: UserContext,
  env: TradierEnv,
  cursor: TradierHistoryCursor,
): Promise<void> {
  await writeFile(tradierCursorPath(ctx, env), JSON.stringify(cursor, null, 2), 'utf-8');
}

async function loadTradierDailyTotals(
  ctx: UserContext,
  env: TradierEnv,
): Promise<Record<string, number>> {
  const path = tradierDailyTotalsPath(ctx, env);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveTradierDailyTotals(
  ctx: UserContext,
  env: TradierEnv,
  totals: Record<string, number>,
): Promise<void> {
  await writeFile(tradierDailyTotalsPath(ctx, env), JSON.stringify(totals, null, 2), 'utf-8');
}

// ── TRA-359: Live calendar broker-truth reconcile ────────────────────────────
//
// The Live P&L calendar was historically computed from local engine state:
// engine-tracked closed positions, paper-options P&L bucket, and reconciled
// Tradier closes via `aggregateRealizedOptionsPnl`. For accounts with
// imported positions whose opens lived outside the reconcile lookback
// window, every Sell-to-Close booked gross proceeds as P&L (the open-cost
// fallback in `aggregateRealizedOptionsPnl` is structurally wrong for that
// case). The result: a Live calendar showing $200+ in green days while the
// real Tradier balance was deep in the red.
//
// The reconcile path below sources daily P&L from the broker truth instead:
//
//   1. Snapshot Tradier `totalEquity` per env at EOD into
//      `tradier-eod-balance.{env}.json`.
//   2. Capture non-trade events (ACH / wire / journal / deposit /
//      withdrawal / dividend / interest / fee / adjustment) from
//      `/accounts/{id}/history` per day into `tradier-cash-flow.{env}.json`
//      so deposits aren't booked as P&L.
//   3. In `generateAndSaveReport` for live mode, override `combinedPnl
//      = today.totalEquity − prev.totalEquity − today.netCashFlow`.
//
// Demo / sandbox paths continue to use the engine-computed P&L.

const TRADIER_CASH_FLOW_LOOKBACK_DAYS = 14;

interface TradierCashFlowState {
  /** Per-day signed net cash flow (deposits − withdrawals + dividends − fees). */
  netByDate: Record<string, number>;
  /** Dedup cursor — Tradier transaction ids already merged into `netByDate`. */
  seenIds: string[];
}

function tradierBalancePath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-eod-balance.${env}.json`);
}

function tradierCashFlowPath(ctx: UserContext, env: TradierEnv): string {
  return join(ctx.dataDir, `tradier-cash-flow.${env}.json`);
}

async function loadTradierBalanceSnapshots(
  ctx: UserContext,
  env: TradierEnv,
): Promise<Record<string, number>> {
  const path = tradierBalancePath(ctx, env);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveTradierBalanceSnapshots(
  ctx: UserContext,
  env: TradierEnv,
  snapshots: Record<string, number>,
): Promise<void> {
  await writeFile(tradierBalancePath(ctx, env), JSON.stringify(snapshots, null, 2), 'utf-8');
}

async function loadTradierCashFlow(
  ctx: UserContext,
  env: TradierEnv,
): Promise<TradierCashFlowState> {
  const path = tradierCashFlowPath(ctx, env);
  if (!existsSync(path)) return { netByDate: {}, seenIds: [] };
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TradierCashFlowState>;
    const netByDate: Record<string, number> = {};
    if (parsed.netByDate && typeof parsed.netByDate === 'object') {
      for (const [k, v] of Object.entries(parsed.netByDate as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) netByDate[k] = v;
      }
    }
    const seenIds = Array.isArray(parsed.seenIds)
      ? parsed.seenIds.filter((s): s is string => typeof s === 'string')
      : [];
    return { netByDate, seenIds };
  } catch {
    return { netByDate: {}, seenIds: [] };
  }
}

async function saveTradierCashFlow(
  ctx: UserContext,
  env: TradierEnv,
  state: TradierCashFlowState,
): Promise<void> {
  await writeFile(tradierCashFlowPath(ctx, env), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * TRA-359 — patch a generated `EodReport` so its `combinedPnl` reflects
 * the Tradier-truth daily delta instead of the engine-imagined value.
 * Adds a markdown header that documents the override so the report
 * detail view doesn't surprise a reader who sees `combinedPnl` not
 * matching the per-component breakdown.
 *
 * The engine-side breakdown fields (`realizedPnl`, `unrealizedPnl`,
 * `optionsPnl`, `totalPnl`) are kept as-is — they're still useful for
 * diagnostic context (was the day's miss driven by stock MTM or option
 * closes?). The calendar UI reads only `combinedPnl`, so overriding
 * that single field is enough to fix the bug.
 */
function applyTradierBalanceOverride(
  report: ReturnType<typeof generateEodReport>,
  override: { combinedPnl: number; prevDate: string; prevBalance: number; netCashFlow: number },
  todayBalance: number,
): ReturnType<typeof generateEodReport> {
  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const header = `> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for ${report.date} = today's Tradier equity (${usd(todayBalance)}) − prev snapshot ${override.prevDate} (${usd(override.prevBalance)}) − net cash flow (${sign(override.netCashFlow)}) = **${sign(override.combinedPnl)}**. Engine-side realized / unrealized / options breakdown below is informational; the calendar uses the broker-truth value.`;
  return {
    ...report,
    combinedPnl: override.combinedPnl,
    totalEquity: todayBalance,
    markdown: `${header}\n\n${report.markdown}`,
  };
}

/**
 * TRA-359 — pull recent Tradier cash events into the per-user / per-env
 * cash flow cursor + persist today's `totalEquity` snapshot. Returns
 * the override `combinedPnl` (broker-truth daily P&L) and metadata for
 * the report markdown, or `null` when we don't have enough data yet to
 * compute a meaningful daily delta (no Tradier creds, no prior balance
 * snapshot, etc.). On error the caller should fall back to the
 * engine-computed P&L rather than block the report write.
 */
async function reconcileTradierLiveCalendar(
  ctx: UserContext,
  settings: AccountSettings,
  mode: StockModeKey,
  todayBalance: number | null,
  reportDate: string,
): Promise<{
  combinedPnl: number;
  prevDate: string;
  prevBalance: number;
  netCashFlow: number;
} | null> {
  if (mode === 'demo') return null;
  if (typeof todayBalance !== 'number' || !Number.isFinite(todayBalance) || todayBalance <= 0) {
    return null;
  }
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);

  // Merge any new non-trade events into the cash-flow cursor. Failure here
  // is non-fatal — we just won't subtract today's deposit and the user
  // sees a one-day blip, which is still less wrong than the old behaviour.
  const cashFlowState = await loadTradierCashFlow(ctx, env);
  if (client) {
    try {
      const today = new Date();
      const end = today.toISOString().slice(0, 10);
      const startMs = today.getTime() - TRADIER_CASH_FLOW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      const start = new Date(startMs).toISOString().slice(0, 10);
      const cashEvents = await client.listAccountCashEvents({ start, end, limit: 1000 });
      const knownIds = new Set(cashFlowState.seenIds);
      const totals = aggregateCashFlowByDate(cashEvents, knownIds);
      for (const [date, net] of totals.netByDate) {
        cashFlowState.netByDate[date] = (cashFlowState.netByDate[date] ?? 0) + net;
      }
      for (const id of totals.seenTransactionIds) cashFlowState.seenIds.push(id);
      await saveTradierCashFlow(ctx, env, cashFlowState);
    } catch (err) {
      log.warn('tradier-live-calendar cash event fetch failed', {
        username: ctx.username,
        env,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Snapshot today's balance before we read prev, so a missing prior day
  // still seeds the file for tomorrow's run.
  const snapshots = await loadTradierBalanceSnapshots(ctx, env);
  snapshots[reportDate] = todayBalance;
  await saveTradierBalanceSnapshots(ctx, env, snapshots);

  // Without a prior anchor we can't compute a daily delta. The file is
  // seeded — the next EOD report run will have a valid prev to compare
  // against.
  const prev = findPreviousBalanceSnapshot(
    // Exclude today from the prev lookup; we just wrote it above.
    Object.fromEntries(Object.entries(snapshots).filter(([d]) => d !== reportDate)),
    reportDate,
  );
  if (!prev) {
    log.info('tradier-live-calendar seeded balance (no prior anchor — overriding skipped this run)', {
      username: ctx.username,
      env,
      reportDate,
      balance: Number(todayBalance.toFixed(2)),
    });
    return null;
  }

  const netCashFlow = cashFlowState.netByDate[reportDate] ?? 0;
  const pnl = computeBalanceDailyPnl(todayBalance, prev.balance, netCashFlow);
  if (pnl === null) return null;

  log.info('tradier-live-calendar computed daily pnl', {
    username: ctx.username,
    env,
    reportDate,
    balance: Number(todayBalance.toFixed(2)),
    prevDate: prev.date,
    prevBalance: Number(prev.balance.toFixed(2)),
    netCashFlow: Number(netCashFlow.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
  });
  return { combinedPnl: pnl, prevDate: prev.date, prevBalance: prev.balance, netCashFlow };
}

// ── TRA-244: one-shot historical Live-calendar backfill from broker fills ─────
//
// The Live calendar's June rows pre-date the 9 PM EOD snapshot this ticket
// added, so they were computed by the old engine path that booked a closing
// fill's *gross proceeds* as P&L (an imported / out-of-window open had no cost
// basis to net against). The board reconciled the rows against their Tradier
// brokerage confirmations and chose "backfill from fills (realized P&L)".
//
// This pass pulls the broker trade history for the live/sandbox env and, for
// the bounded historical June window below, rewrites each day's `combinedPnl`
// to the FIFO-matched realized options P&L for trades that *closed* that day
// (broker truth; un-reconstructable closes left flat — never gross proceeds).
// Days on/after the cutoff are owned by the going-forward 9 PM snapshot path
// and are left untouched, so this is stable under repeated (daily) runs.
const LIVE_REALIZED_BACKFILL_FETCH_START = '2026-05-15'; // wide enough to capture the opens
const LIVE_REALIZED_BACKFILL_WRITE_START = '2026-06-01'; // first artifact day (inclusive)
const LIVE_REALIZED_BACKFILL_WRITE_END = '2026-06-10';   // cutoff (exclusive) — 9 PM snapshot owns this day on

/**
 * Build (or patch) an `EodReport` whose calendar figure is the broker-truth
 * realized options P&L for `date`. Equity realized / unrealized are zeroed so
 * the detail view stays internally consistent (`combinedPnl = realizedPnl +
 * optionsPnl`). A prior backfill header is stripped first so re-runs don't
 * stack headers. When `existing` is null a minimal report is synthesised so
 * the day still appears as a calendar cell.
 */
function makeRealizedBackfillReport(
  date: string,
  dayRealized: number,
  closeCount: number,
  existing: ReturnType<typeof generateEodReport> | null,
): ReturnType<typeof generateEodReport> {
  const sign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const header = `> **Live calendar backfill (TRA-244).** ${date} P&L = Tradier broker-truth realized options P&L for contracts that *closed* this day = **$${sign(dayRealized)}**. Reconstructed from the Tradier account trade history by FIFO-matching each close to its open by OCC symbol; these rows pre-date the 9 PM EOD snapshot that records this going forward. Un-reconstructable closes (open outside the fetch window) are left flat rather than booked at gross proceeds.`;
  const base: ReturnType<typeof generateEodReport> =
    existing ?? {
      date,
      generatedAt: Date.now(),
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      optionsPnl: 0,
      combinedPnl: 0,
      realizedPnlPct: undefined,
      optionsPnlPct: undefined,
      combinedPnlPct: undefined,
      totalEquity: 0,
      managedEquity: 0,
      availableCash: 0,
      trades: [],
      openPositionCount: 0,
      winRate: 0,
      avgRR: 0,
      totalTrades: closeCount,
      winners: 0,
      losers: 0,
      expectancy: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      top5Movers: [],
      signalAccuracy: { totalSignals: 0, winningSignals: 0, winRate: 0, avgRR: 0 },
      markdown: '',
    };
  const priorBody = base.markdown.replace(
    /^> \*\*Live calendar backfill \(TRA-244\)\.\*\*[\s\S]*?\n\n/,
    '',
  );
  return {
    ...base,
    date,
    realizedPnl: 0,
    unrealizedPnl: 0,
    optionsPnl: dayRealized,
    totalPnl: dayRealized,
    combinedPnl: dayRealized,
    markdown: `${header}\n\n${priorBody}`,
  };
}

/**
 * TRA-244 — rewrite a single live/sandbox user's historical June calendar
 * cells from broker-truth realized options P&L. Idempotent: recomputes from
 * the Tradier history each run and only touches the bounded historical window
 * (never `latest.json`, the equity tracker, or the balance-snapshot series).
 * Returns the per-date map that was written, or `null` when the user isn't on
 * a Tradier-backed mode / has no client.
 */
async function backfillLiveRealizedCalendar(
  ctx: UserContext,
): Promise<Record<string, number> | null> {
  const settings = getSettings(ctx.username);
  const mode = stockModeKey(settings);
  if (mode === 'demo') return null;
  const env: TradierEnv = mode === 'live' ? 'production' : 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) return null;

  const end = new Date(Date.now()).toISOString().slice(0, 10);
  let fills;
  try {
    fills = await client.listAccountHistory({
      start: LIVE_REALIZED_BACKFILL_FETCH_START,
      end,
      type: 'trade',
      limit: 2000,
    });
  } catch (err) {
    log.warn('live realized backfill: history fetch failed', {
      username: ctx.username,
      env,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const { realizedByDate, closeCountByDate } = realizedOptionsPnlByCloseDate(fills);
  const dir = stockReportsDirFor(ctx, mode);

  // Candidate days = existing report files in the bucket ∪ realized-close
  // days, bounded to the historical write window. Existing artifact rows with
  // no real close that day are zeroed; real-close days are set to broker truth.
  const candidates = new Set<string>();
  let existingDates: string[] = [];
  try {
    existingDates = (await readdir(dir))
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.slice(0, 10));
  } catch {
    existingDates = [];
  }
  const inWindow = (d: string) =>
    d >= LIVE_REALIZED_BACKFILL_WRITE_START && d < LIVE_REALIZED_BACKFILL_WRITE_END;
  for (const d of existingDates) if (inWindow(d)) candidates.add(d);
  for (const d of realizedByDate.keys()) if (inWindow(d)) candidates.add(d);
  if (candidates.size === 0) return {};

  const written: Record<string, number> = {};
  for (const date of [...candidates].sort()) {
    const dayRealized = Number((realizedByDate.get(date) ?? 0).toFixed(2));
    const filePath = join(dir, `${date}.json`);
    let existing: ReturnType<typeof generateEodReport> | null = null;
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(await readFile(filePath, 'utf-8')) as ReturnType<
          typeof generateEodReport
        >;
      } catch {
        existing = null;
      }
    }
    const report = makeRealizedBackfillReport(
      date,
      dayRealized,
      closeCountByDate.get(date) ?? 0,
      existing,
    );
    await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    await writeFile(join(dir, `${date}.md`), report.markdown, 'utf-8');
    written[date] = dayRealized;
  }
  log.info('live realized calendar backfill complete', {
    username: ctx.username,
    env,
    written,
  });
  return written;
}

/** TRA-244 — run the historical Live-calendar backfill for every user. */
async function runLiveRealizedCalendarBackfill(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await backfillLiveRealizedCalendar(ctx);
    } catch (err) {
      log.error('live realized calendar backfill failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}


async function generateAndSaveCryptoReport(ctx: UserContext): Promise<void> {
  // TRA-244 — same per-mode bucketing as the stocks generator above; crypto
  // only has demo vs live (no sandbox) since Coinbase has no paper sandbox.
  // TRA-245 — pass the mode into getReportSnapshot so the Live folder gets
  // Live (Coinbase) data and the Demo folder gets Demo paper-account data;
  // pre-fix the snapshot was always Demo even when written under live/.
  const mode = cryptoModeKey(getSettings(ctx.username));
  const snapshot = ctx.cryptoEngine.getReportSnapshot(mode);
  const report = generateCryptoEodReport(snapshot);
  const targetDir = cryptoReportsDirFor(ctx, mode);
  const datePath = join(targetDir, `${report.date}.json`);
  const mdPath = join(targetDir, `${report.date}.md`);
  const latestJsonPath = join(targetDir, 'latest.json');
  const latestMdPath = join(targetDir, 'latest.md');

  await Promise.all([
    writeFile(datePath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(mdPath, report.markdown, 'utf-8'),
    writeFile(latestJsonPath, JSON.stringify(report, null, 2), 'utf-8'),
    writeFile(latestMdPath, report.markdown, 'utf-8'),
  ]);

  // TRA-193 — persist the day's equity snapshot so the crypto P&L calendar and
  // cumulative stats see this row, mirroring the stocks flow above.
  // TRA-245 — only write to cryptoTracker in demo mode. The tracker is shared
  // across both crypto modes, and saveSnapshot rebases the demo dashboard's
  // openingEquity to the snapshot's closingEquity. Writing a live-equity row
  // here would corrupt that baseline (e.g. a $0 live equity from missing
  // Coinbase creds would make the demo dashboard report a phantom -$25k
  // dailyPnl after a restart). Live equity history lives in the per-mode
  // crypto-reports/live/ files and longer-term in Coinbase's account history.
  if (mode === 'demo') {
    const closingEquity = snapshot.accountState.totalEquity;
    const openingEquity = ctx.cryptoTracker.getOpeningEquity();
    ctx.cryptoTracker.saveSnapshot({
      date: report.date,
      openingEquity,
      closingEquity,
      dailyPnl: closingEquity - openingEquity,
      optionsPnl: 0,
      combinedPnl: closingEquity - openingEquity,
      trades: snapshot.allClosedPositions.length,
    });
  }

  log.info('crypto EOD report saved', { username: ctx.username, datePath });

  const msg = JSON.stringify({ type: 'crypto_eod_report', payload: report });
  broadcastToUser(ctx.username, msg);
}

// TRA-244 — Single 9 PM ET close-out for every user. Order is load-bearing:
//   1. Generate today's EOD reports + persist the equity snapshot for the
//      Calendar. We do this BEFORE resetting dailyPnl so the report's combined
//      P&L still reflects the day. Stocks only on market days; crypto every
//      day (24/7).
//   2. Reset the in-memory `dailyPnl` baseline on both engines so the next
//      tick broadcasts a fresh 0 for the new trading day. The persisted
//      tracker.openingEquity is realigned in lock-step.
//   3. Archive the rolling "Recent Closed" lists so the Positions/Options
//      tabs start the next session blank.
//   4. Persist + broadcast so connected clients see the reset immediately.
// TRA-249-D — top-of-hour fan-out: every active user's crypto engine gets
// one funding-accrual pass per ET hour. Demo and uninitialised-broker
// engines short-circuit inside `tickFundingHourly`, so this is essentially
// free unless the user is running live perps. Failures per-user are
// isolated so one user's outage can't starve the rest of the fleet.
async function runHourlyFundingForAllUsers(): Promise<void> {
  for (const ctx of getAllUserContexts()) {
    try {
      await ctx.cryptoEngine.tickFundingHourly();
    } catch (err) {
      log.error('funding hourly tick failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runDailyCloseForAllUsers(): Promise<void> {
  const stocksMarketDay = isMarketDay();
  // TRA-388 — heal any calendar gap from a missed 21:00 ET archive tick
  // BEFORE the archive step below clears `allClosedPositions`. A missed day's
  // closed trades are still retained until that point, so a pre-archive
  // catch-up can reconstruct the day's report accurately.
  await catchUpMissedEodReports();
  for (const ctx of getAllUserContexts()) {
    try {
      // 1a. Stocks EOD — only on trading days (Mon–Fri, non-holiday).
      if (stocksMarketDay) {
        try {
          await generateAndSaveReport(ctx);
        } catch (err) {
          log.error('EOD report failed', {
            username: ctx.username,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // 1b. Crypto EOD — every calendar day (24/7 market).
      try {
        await generateAndSaveCryptoReport(ctx);
      } catch (err) {
        log.error('crypto EOD report failed', {
          username: ctx.username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // 2. Reset dashboard daily-P&L baselines for the new trading day.
      ctx.engine.resetDailyPnl();
      ctx.cryptoEngine.resetDailyPnl();

      // 2b. TRA-1053 (TRA-1045 R3) — release per-day in-memory ledgers so they
      // do not accumulate across trading days. Runs AFTER step 1 (the EOD report
      // reads dailySignals). Stocks-only: CryptoSignalEngine has no dailySignals
      // / conviction-DCA maps.
      ctx.engine.clearDailySessionState();

      // 3. Archive closed trades.
      const stocks = ctx.engine.archiveClosedTrades();
      const crypto = ctx.cryptoEngine.archiveClosedTrades();

      // 4. Persist + broadcast.
      await Promise.all([persistStocksNow(ctx), persistCryptoNow(ctx)]);
      broadcastEngineState(ctx);
      broadcastCryptoState(ctx);
      log.info('archive: reset dailyPnl and archived closed trades', {
        username: ctx.username,
        closedPositions: stocks.positions,
        closedOptions: stocks.options,
        closedCryptoPositions: crypto,
      });
    } catch (err) {
      log.error('archive failed', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// TRA-380 — option-chain recorder hook (parent TRA-379, step 1). Fires from
// the MarketScheduler at 3:55 PM ET on trading days and runs the TRA-376
// recorder against the live Tradier production API, writing one date
// partition under `<DATA_DIR>/option-chains/<YYYY-MM-DD>/`.
//
// Why DATA_DIR and not the CLI's `./data/option-chains`: on Render the
// container filesystem is ephemeral and only the persistent disk (mounted at
// DATA_DIR, see render.yaml `disk.mountPath`) survives restarts/redeploys.
// The replay harness needs ~30 daily partitions accumulated over ~6 weeks,
// so the partitions must land on the disk. `CHAINS_OUT_DIR` can override.
//
// DTE window is 14–60 days — NOT the CLI's 35-day default. Per the TRA-379
// sweep spec the RV scanner's live window is 21–60d (TRA-373); a 35-day cap
// would starve RV's upper half in the replay. 14–60 is the union the OTM +
// RV scanners both need.
//
// Production creds come from the server env (TRADIER_API_TOKEN). A missing
// token logs a warning and no-ops rather than throwing — equity/crypto
// trading is unaffected. Per-symbol errors are isolated inside
// `recordOptionChains` and logged, never fatal.
const CHAIN_RECORD_OUT_DIR = process.env['CHAINS_OUT_DIR'] ?? join(DATA_DIR, 'option-chains');

async function runChainRecord(): Promise<void> {
  const apiToken = (process.env['TRADIER_API_TOKEN'] ?? '').trim();
  if (!apiToken) {
    log.warn('chain-recorder TRADIER_API_TOKEN unset — skipping option-chain snapshot');
    return;
  }
  const accountId = (process.env['TRADIER_ACCOUNT_ID'] ?? '').trim() || 'recorder-readonly';
  const client = new TradierOptionsClient(apiToken, accountId, 'production');

  // TRA-779 — the capture universe defaults to the full equities WATCHLIST
  // (a superset of the Phase-2 baseline names AAPL/MSFT/NVDA/AMD/AVGO/GOOGL/
  // AMZN/META), but `CHAINS_WATCHLIST` can pin an explicit comma-separated list
  // (e.g. the confirmed Phase-2 12-name universe) without a code deploy.
  const rawUniverse = (process.env['CHAINS_WATCHLIST'] ?? '').trim();
  const symbols = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  // TRA-779 — DTE floor lowered 14 → 7 so the nearest weeklies are captured for
  // short-dated call-debit-spread legs; the 21–35 DTE 0.25-delta puts and the
  // 60-day ceiling (OTM+RV replay union) stay covered. Widening is additive for
  // the existing replay scanners. `CHAINS_MIN_DTE` / `CHAINS_MAX_DTE` override.
  const minDteDays = Number((process.env['CHAINS_MIN_DTE'] ?? '7').trim()) || 7;
  const maxDteDays = Number((process.env['CHAINS_MAX_DTE'] ?? '60').trim()) || 60;

  log.info('chain-recorder starting', {
    symbols: symbols.length,
    universeSource: rawUniverse ? 'CHAINS_WATCHLIST' : 'WATCHLIST',
    dte: `[${minDteDays},${maxDteDays}]`,
    outDir: CHAIN_RECORD_OUT_DIR,
  });
  const result = await recordOptionChains({
    symbols,
    client,
    outDir: CHAIN_RECORD_OUT_DIR,
    minDteDays,
    maxDteDays,
  });
  const written = result.symbols.filter((s) => s.outcome === 'written').length;
  const errored = result.symbols.filter((s) => s.outcome === 'error');
  log.info('chain-recorder complete', {
    date: result.date,
    written,
    total: result.symbols.length,
    dir: result.outDir,
  });
  for (const s of errored) {
    log.warn('chain-recorder symbol error', {
      symbol: s.symbol,
      errorMessage: s.errorMessage,
    });
  }

  // TRA-1049 — enrich the freshly-written partition with a stamped `spot` and
  // `ivRank` so the recorded dataset is non-degenerate for TRA-1047's IVR-floor
  // sweep (the synthetic TRA-731 set carried ivRank=null, which is exactly the
  // variable the long-IVR gate reads). The recorder itself is a pure Tradier
  // data layer with no quote feed or IV store, so we do the enrichment here in
  // the server where both are available, as a best-effort post-pass:
  //   spot   — backed out of the chain via put-call parity (estimateSpotFromChain).
  //   ivRank — atmIvFromRows → recordDailyIv (warms the trailing-year store over
  //            the recorder's full universe, a superset of the ideas-service feed)
  //            → ivRankSync against that store. Honest-null until the store has
  //            >= MIN_IV_SAMPLES, so a cold store never fabricates a rank.
  // The replay loader reads these top-level file fields (loadChainDays /
  // options-replay-phasea `readIvRank`). Per-symbol failures are isolated and
  // never abort the capture.
  await enrichChainPartition(result.date);
}

// TRA-1049 — post-pass that stamps `spot` + `ivRank` onto each per-symbol file
// of the given date partition. Idempotent: re-reads the file the recorder just
// wrote, adds the two fields, rewrites. Pure best-effort — any error per symbol
// is logged and skipped.
async function enrichChainPartition(date: string): Promise<void> {
  const dir = join(CHAIN_RECORD_OUT_DIR, date);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== '_meta.json');
  } catch {
    return;
  }
  const recordedAt = Date.parse(`${date}T20:00:00Z`); // ~3:55 PM ET capture instant for ranking asOf.
  let stamped = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const snap = JSON.parse(await readFile(path, 'utf-8')) as {
        symbol: string;
        spot: number | null;
        recordedAt?: number;
        rows: import('@trading-app/engine').OptionChainRow[];
        ivRank?: number | null;
      };
      if (!snap || !Array.isArray(snap.rows) || typeof snap.symbol !== 'string') continue;
      // Idempotent: a file already carrying `ivRank` was enriched on a prior
      // run (today's post-pass or the boot backfill) — leave its as-of rank.
      if (snap.ivRank !== undefined) continue;
      const spot =
        snap.spot != null && Number.isFinite(snap.spot) && snap.spot > 0
          ? snap.spot
          : estimateSpotFromChain(snap.rows);
      const asOf = typeof snap.recordedAt === 'number' ? snap.recordedAt : recordedAt;
      const atmIv = spot != null ? atmIvFromRows(snap.rows, spot) : null;
      if (atmIv != null) {
        // Warm the trailing-year IV store with this capture, then rank against it.
        await recordDailyIv(snap.symbol, atmIv, asOf);
      }
      const ivRank = atmIv != null ? ivRankSync(snap.symbol, atmIv, asOf) : null;
      snap.spot = spot ?? null;
      snap.ivRank = ivRank;
      await writeFile(path, JSON.stringify(snap), 'utf-8');
      stamped += 1;
    } catch (err) {
      log.warn('chain-recorder enrich failed', {
        file: f,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info('chain-recorder enriched partition', { date, stamped, total: files.length });
}

// TRA-1049 — one-shot backfill so the ~26 partitions captured before this change
// shipped become IVR-bearing without waiting a month for forward captures. Walks
// every date partition ascending; `enrichChainPartition` warms `recordDailyIv`
// as it goes and skips already-stamped files, so the IV store accrues history
// and the earliest days honestly stay `ivRank: null` until the trailing window
// reaches MIN_IV_SAMPLES, then later days rank against it. Idempotent and
// best-effort — runs once at boot, a no-op on every boot thereafter.
async function backfillChainEnrichment(): Promise<void> {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  let dates: string[];
  try {
    dates = (await readdir(CHAIN_RECORD_OUT_DIR)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    return;
  }
  if (dates.length === 0) return;
  log.info('chain-recorder backfill enrich starting', { partitions: dates.length });
  for (const date of dates) {
    await enrichChainPartition(date);
  }
  log.info('chain-recorder backfill enrich complete', { partitions: dates.length });
}
// Fire-and-forget at boot — never blocks startup; the IV store was warmed above.
void backfillChainEnrichment();

// TRA-845 — Layer-4 alert push. Runs right after the daily chain capture so it
// diffs the freshly-written partition against yesterday's. Chain-diff + IV-move
// alerts are global (same chain for everyone) and pushed to every user; the
// target/stop scan is per-user over that user's active-mode open book. Each
// alert is mapped onto an options `signal` event and handed to `emitAlert`,
// which fans it through the existing dispatcher — so per-user channel/quiet-hour
// prefs (and the dedup window) decide who actually gets pinged. Kill switch:
// `OPTIONS_ALERT_PUSH=off`. Fully isolated: a failure here never affects the
// capture (the caller wraps it) and a single user's error never aborts the loop.
async function runOptionsAlertPush(): Promise<void> {
  if ((process.env['OPTIONS_ALERT_PUSH'] ?? '').trim().toLowerCase() === 'off') {
    log.info('options-alert push disabled (OPTIONS_ALERT_PUSH=off)');
    return;
  }
  const days = await loadChainDays(CHAIN_RECORD_OUT_DIR);
  if (days.length < 2) {
    log.info('options-alert push skipped — need 2 chain partitions', { have: days.length });
    return;
  }
  const prevDay = days[days.length - 2];
  const todayDay = days[days.length - 1];

  // Global chain-diff + IV-move alerts: computed once, shared across users.
  const chainAlerts = [...todayDay.bySymbol.entries()]
    .sort()
    .flatMap(([symbol, today]) => {
      const prev = prevDay.bySymbol.get(symbol);
      return prev ? diffChain(prev, today) : [];
    });

  let pushed = 0;
  for (const ctx of getAllUserContexts()) {
    try {
      const openOptions = ctx.engine.getState().options.openOptions ?? [];
      const positionAlerts = scanTargetStop(openOptions);
      const events = toAlertEvents([...positionAlerts, ...chainAlerts], ctx.username);
      for (const ev of events) emitAlert(ev);
      pushed += events.length;
    } catch (err) {
      log.warn('options-alert push failed for user', {
        username: ctx.username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info('options-alert push complete', {
    chainAlerts: chainAlerts.length,
    eventsEmitted: pushed,
    dates: [prevDay.date, todayDay.date],
  });
}

// TRA-822 (TRA-820 Step 1) — daily StockTwits sentiment-snapshot logger. Runs on
// the SAME 3:55 PM ET hook as the chain recorder so the two snapshots
// co-accumulate on the persistent disk (the IC/flow study joins them per
// symbol-day). StockTwits sentiment is otherwise held only in-memory
// (`SignalEngine.socialCache`), so without this logger there is no persisted
// history to measure. Mirrors the engine read path: crowd stream + curated
// followed-account lane, deduped by message id, reduced by
// `aggregateStockTwitsSentiment`. The StockTwits endpoint is key-less, so this
// needs no creds — a rate-limited/cold fetch records `no_data` for that
// symbol-day rather than throwing. Universe is the equities WATCHLIST (the
// TRA-820 §2 25-name study universe); `SENTIMENT_WATCHLIST` overrides.
const SENTIMENT_RECORD_OUT_DIR =
  process.env['SENTIMENT_OUT_DIR'] ?? join(DATA_DIR, 'sentiment-snapshots');

async function runSentimentSnapshot(): Promise<void> {
  const rawUniverse = (process.env['SENTIMENT_WATCHLIST'] ?? '').trim();
  const symbols = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  // Build the curated (followed-account) lane once for the whole sweep, mirroring
  // SignalEngine.refreshCuratedSocialSentiment: pull each curated user stream,
  // map messages onto every symbol they mention. Best-effort — a fully throttled
  // pull just yields an empty curated map (crowd-only reads still record).
  const curatedCollected: StockTwitsMessage[] = [];
  for (const user of getCuratedStockTwitsAccounts()) {
    try {
      const messages = await fetchStockTwitsUserStream(user);
      if (messages !== null) curatedCollected.push(...messages);
    } catch (err) {
      log.warn('sentiment-recorder curated fetch failed', {
        account: user,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const curatedBySymbol = mapCuratedMessagesBySymbol(curatedCollected);

  log.info('sentiment-recorder starting', {
    symbols: symbols.length,
    universeSource: rawUniverse ? 'SENTIMENT_WATCHLIST' : 'WATCHLIST',
    curatedSymbols: curatedBySymbol.size,
    outDir: SENTIMENT_RECORD_OUT_DIR,
  });

  const result = await recordSentimentSnapshot({
    symbols,
    outDir: SENTIMENT_RECORD_OUT_DIR,
    fetchSentiment: async (symbol) => {
      const crowd = await fetchStockTwitsStream(symbol);
      // Null = rate-limited / cold: no read for this symbol-day. An empty array
      // is a genuine "no messages" read and still aggregates to a neutral row.
      if (crowd === null) return null;
      const curated = curatedBySymbol.get(symbol.toUpperCase()) ?? [];
      const messages = dedupeStockTwitsMessages([...curated, ...crowd]);
      return aggregateStockTwitsSentiment({ symbol, messages, now: Date.now() });
    },
  });

  const recorded = result.symbols.filter((s) => s.outcome === 'recorded').length;
  log.info('sentiment-recorder complete', {
    date: result.date,
    recorded,
    total: result.symbols.length,
    dir: result.outDir,
  });
}

// TRA-596 (TRA-595 C1) — refresh the upcoming-earnings calendar for the active
// stock universe. Runs on boot and on the 9 AM ET pre-market hook. Skips (with
// a warning) when FINNHUB_API_TOKEN is unset, and isolates provider failures so
// a bad/rate-limited fetch can never fault the boot path or a scheduled tick.
async function runEarningsRefresh(): Promise<void> {
  const client = makeEarningsClientFromEnv();
  if (!client) {
    log.warn('earnings-refresh FINNHUB_API_TOKEN unset — skipping earnings-calendar refresh');
    return;
  }
  const symbols = [...WATCHLIST];
  try {
    const { covered, uncovered } = await refreshEarningsCalendar(client, symbols);
    log.info('earnings-refresh complete', { requested: symbols.length, covered, uncovered });
  } catch (err) {
    log.error('earnings-refresh failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// TRA-597 (TRA-595 C2) — refresh the macro/Fed economic calendar (FOMC + CPI /
// NFP / PCE). Runs on boot and on the 9 AM ET pre-market hook. Skips the FRED
// fetch (with a warning) when FRED_API_KEY is unset, and isolates provider
// failures so a bad/rate-limited fetch can never fault boot or a scheduled tick.
async function runMacroRefresh(): Promise<void> {
  const client = makeMacroClientFromEnv();
  if (!client) {
    log.warn('macro-refresh FRED_API_KEY unset — skipping economic-calendar refresh');
    return;
  }
  try {
    const { stored, fomc } = await refreshMacroCalendar(client);
    log.info('macro-refresh complete', { stored, fomc });
  } catch (err) {
    log.error('macro-refresh failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// TRA-528 — live reliability + observability surface:
//   GET /api/health/version  → deploy-version pinning (commit/build/uptime).
//   GET /api/health/live     → consolidated GREEN/YELLOW/RED Live verdict
//                              (mode, broker auth, feed freshness, halt, build).
// Handlers + the monitor's stale-state probe live in observability/health-routes
// so this file only injects the request-scoped deps it owns.
// TRA-580 — also expose the redacted, unauthenticated live-equity acceptance
// probe. `liveEquityAcceptance` enumerates every engine via the existing
// `getAllUserContexts()` and maps each to its redacted snapshot (booleans /
// counts / timestamps only — no trade specifics), so the first organic
// production Tradier OTOCO fill can be verified against the live deployment
// without shipping credentials into an agent env.
// TRA-901 — also grant the unattended TRA-898 daily-watch routine token-gated
// access to the (otherwise user-JWT-only) demo-book surface. `internalToken`
// is the shared secret from env (rotation-tracking, empty disables internal
// access); `demoBooks` enumerates the fleet's demo-mode engines so the routine
// can read the $25k paper book without authenticating as that account.
registerLiveHealthRoutes(app, {
  requireAuth,
  userCtx,
  getSettings,
  liveEquityAcceptance: () => getAllUserContexts().map(ctx => ctx.engine.getLiveEquityAcceptance()),
  internalToken: () => (process.env['DEMO_BOOK_INTERNAL_TOKEN'] ?? '').trim() || undefined,
  demoBooks: () =>
    getAllUserContexts()
      .map(ctx => ({ username: ctx.username, state: ctx.engine.getState(), mode: getSettings(ctx.username).mode }))
      .filter(b => b.mode === 'demo'),
  // TRA-895 — unauth options-signal pipeline probe. Enumerates demo-mode engines
  // + the shared RV scanner status so "no option signals" is diagnosable without
  // a login or the internal demo-book token. Secrets-free (booleans/counts only).
  optionsPipeline: () => {
    const diag = relativeValueScannerService.diagnostics();
    return {
      rvScannerConfigured: diag.configured,
      rvBreakerOpen: diag.breakerOpen,
      engines: getAllUserContexts()
        .map(ctx => ({ state: ctx.engine.getState(), mode: getSettings(ctx.username).mode }))
        .filter(e => e.mode === 'demo'),
    };
  },
});

// TRA-1004 — autonomous demo-loop status. Unauthenticated by design (parity with
// the other `/api/health/*` probes): the snapshot carries only the flag state,
// cadence, tick counters, and per-book decision summaries (booleans / counts /
// usernames / halt reasons) — no trade specifics, prices, or credentials. Lets
// QA / ops confirm the demo book is self-driving (and see autopilot halts /
// throttles) without a login. Flag off ⇒ `enabled:false` and zero recent ticks.
app.get('/api/health/autonomous-demo', (_req, res) => {
  res.json(getAutonomousDemoStatus(demoFlagEnv()));
});

// TRA-406 — observability surface. Returns the recent in-memory alerts and the
// 15-minute captured-error count so QA / ops can see incident state without
// shelling into the box. Gated by auth — alert detail can carry path/host info.
app.get('/api/health/alerts', requireAuth, (_req, res) => {
  res.json({
    alerts: getRecentAlerts(),
    errorCount15m: getErrorCountSince(),
    time: new Date().toISOString(),
  });
});

// TRA-398 — client-side error sink. The desktop/mobile React error boundary
// posts uncaught render-time exceptions here so QA/ops have visibility into
// white-screen-class failures instead of them being lost in the browser.
// Intentionally unauthenticated and best-effort: a crash can happen before
// login or after the token expires, and the boundary uses navigator.sendBeacon
// (which cannot attach auth headers). Oversized fields are clamped to bound
// volume.
//
// TRA-400 — the boundary sends the report as a text/plain Blob so the beacon
// stays CORS-safelisted (an application/json Content-Type forces a preflight
// that silently drops cross-origin beacons — see ErrorBoundary.tsx). The
// global express.json() above does not parse text/plain, so this route gets
// an express.text() parser and JSON.parses the raw body itself. Same-origin
// callers that still send application/json (already parsed into an object by
// express.json()) keep working via the object branch below.
//
// TRA-413 — the report is now filed through `captureException`, the same path
// server-side errors take, so a desktop error lands in the queryable
// destination (`errors.jsonl` / `ERROR_WEBHOOK_URL`). The desktop client mints
// its own trace id per error and sends it in the body (a custom header cannot
// ride a CORS-safelisted sendBeacon); we file the error under that exact id so
// the desktop "something went wrong" screen and this server record share one
// reference.
app.post('/api/client-error', express.text({ type: 'text/plain', limit: '64kb' }), (req, res) => {
  try {
    let b: Record<string, unknown> = {};
    if (typeof req.body === 'string') {
      try {
        const parsed: unknown = JSON.parse(req.body);
        if (parsed && typeof parsed === 'object') b = parsed as Record<string, unknown>;
      } catch {
        /* malformed report body — captured below as best we can */
      }
    } else if (req.body && typeof req.body === 'object') {
      b = req.body as Record<string, unknown>;
    }
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

    // Reconstruct an Error so captureException records a normal name/message/
    // stack. The browser stack is the client's, not this process's.
    const message = str(b['message'], 2000) ?? 'unknown client error';
    const err = new Error(message);
    err.name = str(b['name'], 200) ?? 'ClientError';
    const stack = str(b['stack'], 8000);
    if (stack) err.stack = stack;

    const label = str(b['label'], 200) ?? 'unknown';
    const context: Record<string, unknown> = {
      label,
      source: str(b['source'], 60) ?? 'renderer',
      url: str(b['url'], 500),
      userAgent: str(b['userAgent'], 300),
      sessionTraceId: str(b['sessionTraceId'], 64),
      componentStack: str(b['componentStack'], 8000),
      clientTime: str(b['time'], 40),
    };

    // File under the client-supplied trace id when present (length-bounded to
    // match traceMiddleware) so the id the user sees is the id ops query.
    const rawTraceId = str(b['traceId'], 64);
    const clientTraceId = rawTraceId && rawTraceId.length >= 8 ? rawTraceId : undefined;
    const file = (): void => {
      captureException(err, `desktop.${label}`, context);
    };
    if (clientTraceId) runWithTrace({ traceId: clientTraceId }, file);
    else file();
  } catch (err) {
    log.error('client-error failed to handle report', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // Always 204 — the client treats this as fire-and-forget.
  res.status(204).end();
});

// TRA-191 — surface live relative-value scan output. Read-only, gated by auth.
// Returns up to `limit` ranked candidates and the diagnostics block so QA can
// see whether the breaker is open / cache is warm without needing server logs.
app.get('/api/options/relative-value', requireAuth, async (req, res) => {
  const symbol = typeof req.query['symbol'] === 'string' ? req.query['symbol'] : '';
  if (!symbol) {
    res.status(400).json({ error: 'symbol query parameter is required' });
    return;
  }
  const limit = Math.max(1, Math.min(50, Number(req.query['limit'] ?? 10)));
  const zRaw = req.query['minZ'];
  const minZ = typeof zRaw === 'string' && zRaw.length > 0 ? Number(zRaw) : undefined;

  const result = await relativeValueScannerService.scan(symbol, {
    zScoreThreshold: Number.isFinite(minZ) ? Number(minZ) : undefined,
  });
  res.json({
    ...result,
    candidates: result.candidates.slice(0, limit),
    diagnostics: relativeValueScannerService.diagnostics(),
  });
});

app.get('/api/health/options-mispricing', (_req, res) => {
  res.json(relativeValueScannerService.diagnostics());
});

// TRA-604 (TRA-595 C4b) — live "AI Options Ideas" feed. Resolves the user's
// watchlist, pulls Tradier chains, fuses the C1/C2/sentiment/IV-rank context,
// runs the Head-of-Options-Research LLM pass behind the C3 guardrail, and maps
// the result to the C5 panel's `OptionsIdeasFeed`. Returns a clearly-labelled
// non-live response (HTTP 200, `source: 'non_live'`) when no Anthropic key or
// Tradier creds are configured, so the panel always renders coherently.
app.get('/api/options/ideas', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const settings = getSettings(ctx.username);
  const env = settings.liveTradierEnvOptions ?? 'sandbox';
  const client = buildTradierOptionsClientForEnv(settings, env);
  const symbols = getStocksWatchlistData(ctx.username).all;
  // TRA-714 — a user's app-installed console API key (if any) overrides the
  // server env credential, so a Claude Max user can make the feed live without
  // any Render access.
  const anthropicApiKey = getUserAnthropicApiKey(ctx.username);
  // TRA-1121 — thread the paper-options book equity so the feed pre-flights each
  // idea's single-lot max loss through the same TRA-912 gate the paper-enter
  // path uses, flagging un-enterable ideas (`enterable:false` + reason) instead
  // of surfacing a `Paper entry` button that always 409s.
  const accountEquityUsd = ctx.engine.getOptionsAccountEquity();
  const feed = await buildIdeasFeed({ client, symbols, anthropicApiKey, accountEquityUsd });
  // TRA-1142 — demo auto-confirm for AI Ideas options. OFF by default (requires
  // BOTH the shared-rail flag and this sub-flag). When ON, every surfaced,
  // enterable idea is run through the engine's options-aware `shouldAutoConfirm`
  // gate (demo/paper only, defined-risk, POP floor, single-lot max-loss cap,
  // kill-switch clear, demo auto-trade ON) and — only if it passes — entered via
  // the SAME shared proposal queue the manual click uses, so the paper book
  // accrues real auto-trade evidence for the scorecard (TRA-1141). The surfaced
  // ideas are already journaled by `buildIdeasFeed`, so the scorecard's AI-Ideas
  // forward-test side picks these entries up with no extra write. Per-idea
  // failures (gate-blocked or open-refused) leave the idea for manual approval
  // and never break the feed read. Idempotent across the 60s poll: the proposal
  // store dedupes a pending options proposal per (user, ideaId) and the paper
  // book rejects a duplicate open for an already-open contract.
  if (isOptionDemoAutoConfirmEnabled()) {
    let entered = 0;
    for (const idea of feed.ideas) {
      if (idea.enterable === false) continue;
      const intent = getEntryIntent(idea.id);
      if (!intent) continue;
      try {
        const r = await ctx.engine.autoConfirmOptionsIdea({ ...intent, ideaId: idea.id });
        if (r.autoConfirmed) entered += 1;
      } catch (err) {
        log.warn('options auto-confirm failed for idea', {
          ideaId: idea.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (entered > 0) broadcastEngineState(ctx);
  }
  res.json(feed);
});

// TRA-845 — Layer-4 options alert engine. Diffs the last two recorded chain
// partitions (new strikes/expiries + big IV moves) and scans the authed user's
// OPEN options book for target/stop hits. Read-only: it never mutates account
// state and never pushes — the daily chain-record hook owns the optional push.
// Returns `{ alerts, counts, symbolsDiffed, chainDates }`; degrades to an empty
// alert set (never 500s) when fewer than two chain days are on disk.
app.get('/api/options/alerts', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  try {
    const days = await loadChainDays(CHAIN_RECORD_OUT_DIR);
    const openOptions = ctx.engine.getState().options.openOptions ?? [];
    if (days.length < 2) {
      const positionAlerts = scanTargetStop(openOptions);
      res.json({
        issue: 'TRA-845',
        chainDates: days.map((d) => d.date),
        symbolsDiffed: [],
        counts: { new_expiry: 0, new_strike: 0, iv_move: 0, target_hit: positionAlerts.filter((a) => a.kind === 'target_hit').length, stop_hit: positionAlerts.filter((a) => a.kind === 'stop_hit').length },
        alerts: positionAlerts,
        note: 'fewer than 2 chain partitions on disk — chain-diff skipped, target/stop only',
      });
      return;
    }
    const prevDay = days[days.length - 2];
    const todayDay = days[days.length - 1];
    const result = computeOptionsAlerts({
      prevBySymbol: prevDay.bySymbol,
      todayBySymbol: todayDay.bySymbol,
      openOptions,
    });
    res.json({ issue: 'TRA-845', chainDates: [prevDay.date, todayDay.date], ...result });
  } catch (err) {
    log.error('options-alerts probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'options-alerts probe failed' });
  }
});

// TRA-714 — per-user Anthropic console API-key management for the AI Ideas feed.
// This is the "another way" for users with no env access (e.g. a Claude Max
// plan): paste a pay-as-you-go console key (`sk-ant-api03…`) once and it is
// stored with your account on the persistent disk. Each user manages only their
// own key (requireAuth, scoped to the authed user) — never another user's.
app.get('/api/options/anthropic-key', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(describeUserAnthropicApiKey(ctx.username));
});

app.put('/api/options/anthropic-key', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'] : '';
  try {
    setUserAnthropicApiKey(ctx.username, apiKey);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid API key.' });
    return;
  }
  res.json({ ok: true, ...describeUserAnthropicApiKey(ctx.username) });
});

app.delete('/api/options/anthropic-key', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  clearUserAnthropicApiKey(ctx.username);
  res.json({ ok: true, ...describeUserAnthropicApiKey(ctx.username) });
});

// TRA-604 (TRA-595 C4b) — route an accepted idea to the PAPER options account.
// Paper-only by construction (no live-capital path — that stays gated behind
// C6). The idea's anchor contract is opened as a single long leg; the C3
// order-time DTE guard runs inside the account open path.
app.post('/api/options/ideas/:id/paper-enter', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const intent = getEntryIntent(id);
  if (!intent) {
    res.status(404).json({
      error: 'Idea not found or expired — refresh the AI Options Ideas feed and try again.',
    });
    return;
  }
  // TRA-1140 — when the shared-rail flag is ON, route the accepted idea through
  // the unified pending-proposal queue (typed `options` proposal) + shared
  // approve/execution gate instead of the bespoke direct open. OFF by default,
  // so the direct path below stays byte-for-byte unchanged when unset. Both are
  // paper-only.
  if (isOptionsProposalRailEnabled()) {
    const result = await ctx.engine.enterOptionsIdeaViaProposal({ ...intent, ideaId: id });
    if (!result.ok || !result.position) {
      res.status(409).json({
        error: `Could not place the paper order — ${result.reason}.`,
        proposalId: result.proposalId,
      });
      return;
    }
    broadcastEngineState(ctx);
    res.json({
      ok: true,
      proposalId: result.proposalId,
      positionId: result.position.id,
      optionSymbol: result.position.optionSymbol,
      contracts: result.position.contracts,
      premiumPaid: result.position.premiumPaid,
    });
    return;
  }
  const opened = ctx.engine.enterPaperOptionsIdea(intent);
  if (!opened) {
    // TRA-1117 — surface the SPECIFIC reason the open path bailed instead of a
    // generic catch-all. The most common real cause (seen on a $25k demo book)
    // is a defined-risk spread whose single-lot max loss busts the 1%-of-equity
    // per-trade cap — previously indistinguishable from "market closed".
    const reason = ctx.engine.takeLastIdeaEntryRejection();
    res.status(409).json({
      error: reason
        ? `Could not place the paper order — ${reason}.`
        : 'Could not place the paper order — the market may be closed, the daily options cap reached, a position for this contract already open, or the idea fell below the no-day-trading DTE floor.',
    });
    return;
  }
  broadcastEngineState(ctx);
  res.json({
    ok: true,
    positionId: opened.id,
    optionSymbol: opened.optionSymbol,
    contracts: opened.contracts,
    premiumPaid: opened.premiumPaid,
  });
});

// TRA-658 — CFO spend diagnostic: the running monthly Anthropic spend for the
// live AI Options Ideas feed vs the board-approved cap. No PII or secrets — only
// the aggregate dollar total, the cap, and whether the auto-degrade tripwire is
// active — so the CFO can review spend from the Render URL without log access.
app.get('/api/health/options-spend', (_req, res) => {
  res.json(optionsSpendStatus());
});

// TRA-747 (TRA-529 P2 §6.5) — the advisory multi-agent layer's DAILY AGGREGATE
// spend readout (CFO acceptance #4). Returns the absolute $/day total across ALL
// users plus the per-user breakdown, the enforced $2/user/day cap, and the
// re-review level. Read-only and unauthenticated by design (parity with
// /api/health/options-spend) — it exposes only spend totals + usernames, no trade
// detail. Wires NO capital; the layer is advisor-only in P2.
app.get('/api/health/agent-spend', (_req, res) => {
  // TRA-1052 — `durable:true` confirms the SQLite committed-ledger mirror is live
  // (the daily cap survives a redeploy). `false` means the fail-soft fallback is
  // active (native binary unavailable) and the ledger is in-memory only — the one
  // read-only signal an operator/probe has that durability is actually engaged on
  // Render, since no agent can read the boot log directly.
  res.json({ ...agentSpendAggregate(), durable: getStateDb() !== null });
});

// TRA-601 (TRA-595 C6) — the forward-test report. Re-prices every surfaced idea
// the journal captured against the option chains the recorder wrote AFTER it was
// surfaced (no look-ahead) and rolls the result into a weekly hit-rate /
// expectancy / max-loss-adherence / POP-calibration report. Read-only; wires no
// capital. Any authenticated user can read so the desk can review methodology.
app.get('/api/options/forward-test/report', requireAuth, async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    res.json(report);
  } catch (err) {
    log.error('forward-test report failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the forward-test report.' });
  }
});

// TRA-601 (TRA-595 C6) — the AI-Options-Ideas LIVE-CAPITAL GATE, as a redacted
// read-only acceptance probe (parity with the TRA-580/586 health probes).
// Unauthenticated by design: it exposes ONLY the pass/fail verdict and the
// per-criterion booleans + thresholds — no idea text, no per-symbol P&L, no PII
// — so QA can verify "the gate is wired and currently HOLDs" against the live
// deployment without shipping admin credentials. Evaluating the gate wires NO
// capital; a pass is permission to PROPOSE live wiring, nothing more.
app.get('/api/health/live-capital-gate', async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const report = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    const gate = evaluateLiveCapitalGate(report);
    res.json({
      passed: gate.passed,
      asOfDate: gate.asOfDate,
      summary: gate.summary,
      note: gate.note,
      thresholds: LIVE_CAPITAL_GATE,
      criteria: gate.criteria.map((c) => ({
        name: c.name,
        description: c.description,
        required: c.required,
        actual: c.actual,
        pass: c.pass,
      })),
      evidence: {
        surfaced: report.totals.surfaced,
        resolved: report.totals.resolved,
        open: report.totals.open,
        // TRA-678 — ideas dropped from the gate metrics (fallback/stale/no-denom).
        excluded: report.totals.excluded,
        weeksWithResolved: report.totals.weeksWithResolved,
        weeksPositiveExpectancy: report.totals.weeksPositiveExpectancy,
        // TRA-678 (F1) — the cost-NET figures the gate actually evaluates.
        weeksPositiveExpectancyNet: report.totals.weeksPositiveExpectancyNet,
        expectancyR: report.totals.expectancyR,
        expectancyNetR: report.totals.expectancyNetR,
      },
    });
  } catch (err) {
    log.error('live-capital-gate probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to evaluate the live-capital gate.' });
  }
});

// TRA-1141 (TRA-1139) — combined accuracy scorecard: both idea engines side by
// side on out-of-sample data, so the board can compare them honestly instead of
// guessing "which is more accurate". Read-only; wires no capital. Unauthenticated
// and secrets-free (parity with the other /api/health/* probes): the AI Ideas
// side is the global TRA-601 forward-test (no per-user P&L/PII) and the Proposals
// side is the offline TRA-797 A/B OOS study (win-rate / avg-R / agent-vs-baseline
// — no idea text, no balances). Each side carries an explicit sample-size verdict;
// small/insufficient samples are labelled and NO winner is implied before the data
// clears. This route only RE-SHAPES the two existing computations — it does not
// change how either ledger is computed (out of scope).
app.get('/api/health/engine-scorecard', async (_req, res) => {
  try {
    const entries = await listJournalEntries();
    const outcomes = await forwardTestIdeas(entries);
    const ideasReport = buildForwardTestReport(outcomes, { chainsDir: defaultChainsDir() });
    const aiIdeas = buildAiIdeasScorecard(ideasReport);
    const proposals = await loadProposalsScorecard();
    const scorecard = buildEngineScorecard(proposals, aiIdeas);
    res.json({
      ok: true,
      time: new Date().toISOString(),
      build: resolveBuildInfo(),
      ...scorecard,
    });
  } catch (err) {
    log.error('engine-scorecard probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to build the engine scorecard.' });
  }
});

// TRA-141 — storage diagnostic so QA can verify from outside the box that the
// Render persistent disk is actually mounted and that user/settings/trade files
// are surviving redeploys. No PII is exposed (only paths, sizes, mtimes, count).
app.get('/api/health/storage', async (_req, res) => {
  async function statFile(p: string): Promise<{ exists: boolean; size?: number; mtime?: string }> {
    try {
      const s = await stat(p);
      return { exists: true, size: s.size, mtime: s.mtime.toISOString() };
    } catch {
      return { exists: false };
    }
  }
  const usersFile = join(DATA_DIR, 'users.json');
  const backupsDir = join(DATA_DIR, 'backups');
  // TRA-142 — per-user files now live under DATA_DIR/users/<username>/. The
  // legacy DATA_DIR/account-settings.json etc. are migrated into the admin
  // namespace on first boot, so we report admin's path so QA sees the
  // post-migration location while the legacy fields show migration ran.
  const legacySettingsFile = join(DATA_DIR, 'account-settings.json');
  const legacyTradesStocksFile = join(DATA_DIR, 'trades-stocks.json');
  const legacyTradesCryptoFile = join(DATA_DIR, 'trades-crypto.json');
  const adminDir = join(DATA_DIR, 'users', 'admin');
  const adminSettingsFile = join(adminDir, 'account-settings.json');
  const adminTradesStocksFile = join(adminDir, 'trades-stocks.json');
  const adminTradesCryptoFile = join(adminDir, 'trades-crypto.json');
  const migrationMarker = join(DATA_DIR, '.tra-142-migrated');
  let backupsCount = 0;
  try {
    backupsCount = (await readdir(backupsDir)).length;
  } catch {
    backupsCount = 0;
  }
  res.json({
    dataDir: DATA_DIR,
    dataDirEnv: process.env['DATA_DIR'] ?? null,
    dataDir_exists: existsSync(DATA_DIR),
    usersFile: await statFile(usersFile),
    settingsFile: await statFile(legacySettingsFile),
    tradesStocksFile: await statFile(legacyTradesStocksFile),
    tradesCryptoFile: await statFile(legacyTradesCryptoFile),
    adminSettingsFile: await statFile(adminSettingsFile),
    adminTradesStocksFile: await statFile(adminTradesStocksFile),
    adminTradesCryptoFile: await statFile(adminTradesCryptoFile),
    tra142Migrated: existsSync(migrationMarker),
    backupsDir_exists: existsSync(backupsDir),
    backupsCount,
    userCount: getAllUsers().length,
    userContextCount: getAllUserContexts().length,
    processStart: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
});

// TRA-779 — option-chain capture liveness. Open (no auth, like the other
// health probes) so the Phase-2 owner can verify capture on any deploy without
// a session: confirms the Tradier token is configured, counts the accumulated
// daily partitions toward the 30-trading-day clock, and reports the latest
// partition's universe coverage. Reads only the cheap per-date `_meta.json` +
// the partition file list — it never loads full chains.
app.get('/api/health/chain-capture', async (_req, res) => {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  const PHASE2_BASELINE = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'AVGO', 'GOOGL', 'AMZN', 'META'];
  const outDir = CHAIN_RECORD_OUT_DIR;
  const tokenConfigured = (process.env['TRADIER_API_TOKEN'] ?? '').trim().length > 0;
  const rawUniverse = (process.env['CHAINS_WATCHLIST'] ?? '').trim();
  const configuredUniverse = rawUniverse
    ? rawUniverse.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [...WATCHLIST];

  let dates: string[] = [];
  try {
    dates = (await readdir(outDir)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }

  let latest:
    | { date: string; written: number | null; symbolsWritten: string[]; recordedAt: number | null; dteWindow: [number | null, number | null] }
    | null = null;
  if (dates.length > 0) {
    const last = dates[dates.length - 1];
    const dir = join(outDir, last);
    let symbolsWritten: string[] = [];
    try {
      symbolsWritten = (await readdir(dir))
        .filter((f) => f.endsWith('.json') && f !== '_meta.json')
        .map((f) => f.replace(/\.json$/i, '').toUpperCase())
        .sort();
    } catch {
      symbolsWritten = [];
    }
    let written: number | null = symbolsWritten.length;
    let recordedAt: number | null = null;
    let dteWindow: [number | null, number | null] = [null, null];
    try {
      const meta = JSON.parse(await readFile(join(dir, '_meta.json'), 'utf-8')) as {
        written?: number;
        recordedAt?: number;
        minDteDays?: number;
        maxDteDays?: number;
      };
      if (typeof meta.written === 'number') written = meta.written;
      if (typeof meta.recordedAt === 'number') recordedAt = meta.recordedAt;
      dteWindow = [meta.minDteDays ?? null, meta.maxDteDays ?? null];
    } catch {
      // _meta.json absent/corrupt — fall back to the file-list count above.
    }
    latest = { date: last, written, symbolsWritten, recordedAt, dteWindow };
  }

  const baselineCovered = latest
    ? PHASE2_BASELINE.filter((s) => latest!.symbolsWritten.includes(s))
    : [];

  res.json({
    issue: 'TRA-779',
    outDir,
    tokenConfigured,
    capturing: tokenConfigured && dates.length > 0,
    tradingDaysCaptured: dates.length,
    progressToThirtyDays: { captured: dates.length, target: 30 },
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    universeSource: rawUniverse ? 'CHAINS_WATCHLIST' : 'WATCHLIST',
    configuredUniverse,
    latest,
    phase2BaselineCoverage: {
      required: PHASE2_BASELINE,
      covered: baselineCovered,
      missing: PHASE2_BASELINE.filter((s) => !baselineCovered.includes(s)),
    },
  });
});

// TRA-1049 — recorded-partition export. The chains live only on the Render
// persistent disk (`/data/option-chains`); QuantTrader's backtest box has no
// shell/disk access to it, so the recorder dataset cannot be consumed off-box
// without a transport. This bounded read-only endpoint streams one date
// partition's per-symbol snapshots (the same JSON `loadChainDays` reads) so the
// backtest box can mirror the dataset locally and run the TRA-1047 T2/T3 sweeps.
// `scripts/pull-recorded-chains.mjs` walks `chain-capture`'s date list and pulls
// each partition through here. One date per request keeps the payload bounded;
// the `:date` param is regex-validated to block path traversal.
app.get('/api/health/chain-capture/partition/:date', async (req, res) => {
  const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;
  const date = String(req.params.date ?? '');
  if (!DATE_PARTITION.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const dir = join(CHAIN_RECORD_OUT_DIR, date);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    res.status(404).json({ error: 'partition not found', date });
    return;
  }
  const symbols: unknown[] = [];
  let meta: unknown = null;
  for (const f of files) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, f), 'utf-8'));
      if (f === '_meta.json') meta = parsed;
      else symbols.push(parsed);
    } catch {
      // Skip a corrupt file rather than failing the whole partition.
    }
  }
  res.json({
    issue: 'TRA-1049',
    date,
    outDir: CHAIN_RECORD_OUT_DIR,
    symbolCount: symbols.length,
    meta,
    symbols,
  });
});

// TRA-779 — replay smoke proof. Runs the real `run-options-replay` pure pipe
// (`loadChainDays` → `runOptionsReplay`) against the on-disk captured chains and
// returns the summarized buckets, proving the persisted partitions are
// replay-consumable end-to-end on the box that actually holds the data — the
// "smoke run on a few days of data proves the pipe" acceptance bullet, runnable
// remotely without exec/filesystem access to the Render disk. Open like the
// other health probes; bounded work (loads partitions once, pure replay). The
// scanners it drives are the legacy OTM/RV ones — this proves the loader→replay
// plumbing, not the Phase-2 strategy logic (that lands in TRA-781).
app.get('/api/health/options-replay-smoke', async (_req, res) => {
  try {
    const days = await loadChainDays(CHAIN_RECORD_OUT_DIR);
    if (days.length === 0) {
      res.json({
        issue: 'TRA-779',
        ok: false,
        reason: 'no_chain_partitions',
        outDir: CHAIN_RECORD_OUT_DIR,
      });
      return;
    }
    const symbolsCount = new Set(days.flatMap((d) => Array.from(d.bySymbol.keys()))).size;
    const buckets = runOptionsReplay(days, DEFAULT_REPLAY_CONFIG);
    res.json({
      issue: 'TRA-779',
      ok: true,
      outDir: CHAIN_RECORD_OUT_DIR,
      daysReplayed: days.length,
      symbolsCount,
      firstDate: days[0].date,
      lastDate: days[days.length - 1].date,
      buckets: buckets.map((b) => ({
        startingEquity: b.startingEquity,
        trades: b.trades,
        winRate: b.winRate,
        totalPnl: b.totalPnl,
        pnlPct: b.pnlPct,
        maxDrawdown: b.maxDrawdown,
        skippedZeroSize: b.skippedZeroSize,
      })),
    });
  } catch (err) {
    res.status(500).json({
      issue: 'TRA-779',
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Auth endpoints ────────────────────────────────────────────────────────────

// TRA-404 / C2 — brute-force throttle for the auth endpoints. `clientKey`
// buckets attempts by the real caller IP (see `trust proxy` above); login also
// buckets per-username so a distributed attack on one account is still caught.
function clientKey(req: express.Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

// If any of `keys` is currently throttled, write a 429 (with Retry-After) and
// return true so the caller can bail out before doing the expensive auth work.
function rejectIfThrottled(res: express.Response, keys: string[]): boolean {
  let worst = 0;
  for (const key of keys) {
    const d = checkThrottle(key);
    if (d.blocked) worst = Math.max(worst, d.retryAfterSec);
  }
  if (worst > 0) {
    res.setHeader('Retry-After', String(worst));
    res.status(429).json({
      error: `Too many attempts. Try again in ${worst}s.`,
      retryAfterSec: worst,
    });
    return true;
  }
  return false;
}

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  const ipKey = `login:ip:${clientKey(req)}`;
  const userKey = `login:user:${username.toLowerCase()}`;
  if (rejectIfThrottled(res, [ipKey, userKey])) return;

  if (!(await validateUserCredentials(username, password))) {
    recordFailure(ipKey);
    recordFailure(userKey);
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  // TRA-217 — locked accounts cannot log in even with correct credentials.
  // Check after credential validation so we don't leak which usernames exist.
  if (isUserLocked(username)) {
    res.status(423).json({ error: 'Account is locked. Contact an administrator.' });
    return;
  }
  // Valid credentials → wipe the brute-force counters for this caller/account.
  recordSuccess(ipKey);
  recordSuccess(userKey);
  res.json({ token: createToken(username) });
});

app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body as { username?: string; email?: string; password?: string };
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const result = await createUser(username.trim(), email.trim(), password);
  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  // TRA-142 — spin up the new user's per-user context (fresh equity, empty
  // trade history, default settings) so their engine starts ticking right away.
  await provisionUser(username.trim());
  res.json({ token: createToken(username.trim()) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.includes('@')) {
    res.status(400).json({ error: 'A valid email address is required' });
    return;
  }
  // TRA-404 / C2 — throttle by IP to stop reset-email flooding. Every request
  // counts toward the limit (the endpoint always returns ok, so there is no
  // "success" to clear); honest users only ever call it once or twice.
  const forgotKey = `forgot:ip:${clientKey(req)}`;
  if (rejectIfThrottled(res, [forgotKey])) return;
  recordFailure(forgotKey);
  const user = getUserByEmail(email);
  if (user) {
    const code = generateResetToken(user.username);
    try {
      await sendPasswordResetEmail(email, user.username, code);
    } catch (err) {
      log.error('auth: failed to send reset email', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  res.json({ ok: true, message: 'If an account with that email exists, a reset code has been sent.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { code, newPassword } = req.body as { code?: string; newPassword?: string };
  if (typeof code !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'code and newPassword are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  // TRA-404 / C2 — the reset code is an 8-digit number; throttle by IP so it
  // cannot be brute-forced.
  const resetKey = `reset:ip:${clientKey(req)}`;
  if (rejectIfThrottled(res, [resetKey])) return;

  const username = consumeResetToken(code);
  if (!username) {
    recordFailure(resetKey);
    res.status(400).json({ error: 'Invalid or expired reset code' });
    return;
  }
  recordSuccess(resetKey);
  await changeUserPassword(username, newPassword);
  res.json({ ok: true, message: 'Password has been reset. You can now log in.' });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'currentPassword and newPassword are required' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }
  if (!(await validateUserCredentials(username, currentPassword))) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true, message: 'Password changed successfully' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  const user = getUser(username);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  const { passwordHash: _ph, ...safe } = user;
  res.json(safe);
});

app.patch('/api/auth/me', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string') { res.status(400).json({ error: 'email is required' }); return; }
  const result = await updateUser(username, { email });
  if (!result.ok) { res.status(404).json({ error: result.error }); return; }
  res.json({ ok: true });
});

// ── Admin: user management ────────────────────────────────────────────────────

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({ users: getAllUsers() });
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, email, password, role } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    role?: 'admin' | 'user';
  };
  if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'username, email, and password are required' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const result = await createUser(username, email, password, role ?? 'user');
  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  // TRA-142 — admin-created users also get an isolated context.
  await provisionUser(username);
  res.status(201).json({ ok: true, user: result.user });
});

app.patch('/api/admin/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { email, newUsername } = req.body as { email?: string; newUsername?: string };
  const result = await updateUser(username, { email, username: newUsername });
  if (!result.ok) {
    res.status(result.error === 'User not found' ? 404 : 409).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const authUser = res.locals['authUser'] as string;
  if (username === authUser) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }
  const deleted = await deleteUser(username);
  if (!deleted) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  // TRA-142 — stop the deleted user's engines and forget their caches. Their
  // on-disk state is left intact under DATA_DIR/users/<username>/ so an admin
  // can restore them if needed.
  destroyUserContext(username);
  res.json({ ok: true });
});

// TRA-217 — admin sets a user's password directly (no current-password check).
app.post('/api/admin/users/:username/password', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { newPassword } = req.body as { newPassword?: string };
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    res.status(400).json({ error: 'newPassword must be at least 6 characters' });
    return;
  }
  if (!getUser(username)) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await changeUserPassword(username, newPassword);
  res.json({ ok: true });
});

// TRA-217 — admin locks/unlocks a user. Locked accounts cannot log in.
app.post('/api/admin/users/:username/lock', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const { locked } = req.body as { locked?: boolean };
  if (typeof locked !== 'boolean') {
    res.status(400).json({ error: 'locked (boolean) is required' });
    return;
  }
  const authUser = res.locals['authUser'] as string;
  // Prevent admins from locking themselves out of the system.
  if (locked && username === authUser) {
    res.status(400).json({ error: 'Cannot lock your own account' });
    return;
  }
  const ok = await setUserLocked(username, locked);
  if (!ok) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ ok: true, locked });
});

// TRA-217 — admin triggers a password-reset email for any user. Reuses the
// same generator + email template the public forgot-password flow uses, so
// the user resets their own password by entering the PIN.
app.post('/api/admin/users/:username/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params as Record<string, string>;
  const user = getUser(username);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (!user.email) {
    res.status(400).json({ error: 'User has no email address on file' });
    return;
  }
  const code = generateResetToken(user.username);
  try {
    await sendPasswordResetEmail(user.email, user.username, code);
  } catch (err) {
    log.error('admin: failed to send reset email', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ error: 'Failed to send reset email' });
    return;
  }
  res.json({ ok: true, message: `Reset code emailed to ${user.email}` });
});

// ── Admin: self-restart (TRA-793) ─────────────────────────────────────────────
//
// The agent fleet runs as the non-elevated user PRIMEROGA\eetienne, but the PM2
// daemon + `trading-server` are launched at boot by the `PM2 Resurrect`
// scheduled task as LOCAL_SYSTEM (ops/install-pm2-autostart.ps1, TRA-605). So a
// fleet agent CANNOT `pm2 restart trading-server` (EPERM on the SYSTEM daemon
// control pipe) to adopt a freshly built `dist` after a redeploy — that needs a
// human/SYSTEM action (this is why TRA-792 stalled on an operator restart).
//
// This route makes redeploys self-serve: an authenticated admin POSTs here and
// we run the EXACT same graceful shutdown SIGTERM triggers (stop the scheduler +
// every engine, drain in-flight ticks bounded by SHUTDOWN_DRAIN_TIMEOUT_MS,
// flush trade history + structured logs, then process.exit(0)). PM2
// (autorestart:true, restart_delay 3s — ecosystem.config.cjs) then relaunches
// the worker onto the current build with no elevated action required.
//
// It is a control surface on the live trading server, so it is admin-only
// (requireAuth + requireAdmin) and every call is audit-logged with the
// requesting user + reason before the process goes down.
app.post('/api/admin/restart', requireAuth, requireAdmin, (req, res) => {
  // `shuttingDown` (declared with the graceful-shutdown machinery below) is
  // already true if a SIGTERM or a prior restart call is mid-flight; don't
  // stack a second exit on top of it.
  if (shuttingDown) {
    res.status(409).json({ error: 'Server is already shutting down' });
    return;
  }
  const authUser = res.locals['authUser'] as string;
  const rawReason = (req.body as { reason?: unknown } | undefined)?.reason;
  const reason =
    typeof rawReason === 'string' && rawReason.trim()
      ? rawReason.trim().slice(0, 500)
      : 'unspecified';
  // Audit BEFORE we go down — this line is flushed by gracefulShutdown's
  // flushLogs() so it survives the exit.
  log.warn('TRA-793 admin-restart requested — exiting for PM2 relaunch', {
    user: authUser,
    reason,
  });
  // Acknowledge first so the caller gets a clean 202 before the socket closes
  // mid-shutdown; it should then poll GET /api/health until it returns 200.
  res.status(202).json({
    ok: true,
    restarting: true,
    restartDelayMs: 3000,
    message: 'Server is restarting; poll GET /api/health until it returns 200.',
  });
  // Defer one tick so the response fully flushes to the client before the
  // process begins draining and exits.
  setTimeout(() => {
    void gracefulShutdown('admin-restart');
  }, 250).unref?.();
});

// ── News + research merge (TRA-227) ──────────────────────────────────────────
//
// Maps a research report into a NewsItem for the News tab and merges with the
// Yahoo headline list. Reports newer than 24h are pinned to the top in
// publishedAt order; older reports interleave with Yahoo by time. The
// front-end recognises research items by `kind`/`bodyMarkdown` and renders an
// expandable card with a "Research" badge.

const RESEARCH_PIN_WINDOW_MS = 24 * 60 * 60 * 1000;

function researchToNewsItem(r: ResearchReport): NewsItem {
  return {
    id: r.id,
    title: r.title,
    url: `/research/${r.id}`,
    source: r.source,
    publishedAt: r.publishedAt,
    kind: r.kind,
    bodyMarkdown: r.bodyMarkdown,
  };
}

async function mergeResearchAndNews(yahoo: NewsItem[]): Promise<NewsItem[]> {
  const reports = await listResearchReports();
  if (reports.length === 0) return yahoo;
  const now = Date.now();
  const pinned: NewsItem[] = [];
  const rest: NewsItem[] = [...yahoo];
  for (const r of reports) {
    const item = researchToNewsItem(r);
    const ts = Date.parse(r.publishedAt);
    if (Number.isFinite(ts) && now - ts <= RESEARCH_PIN_WINDOW_MS) {
      pinned.push(item);
    } else {
      rest.push(item);
    }
  }
  pinned.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  rest.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return [...pinned, ...rest];
}

// ── Trade history export (TRA-564, parent TRA-410 §2.4 / B1) ─────────────────

/** Parse a comma-separated, lower-cased, de-duped query list. */
function parseCsvParam(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/**
 * Parse a `from`/`to` boundary as epoch-ms. Accepts an epoch-ms number, an ISO
 * timestamp, or a bare `YYYY-MM-DD` date. A date-only `to` is widened to the
 * end of that UTC day so the upper bound is inclusive of trades closed any time
 * that day. Returns undefined on an unparseable / blank value.
 */
function parseExportBoundary(raw: unknown, isEnd: boolean): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  // Date-only end boundary → end of the UTC day (inclusive).
  if (isEnd && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return ms + 86_400_000 - 1;
  }
  return ms;
}

const VALID_MARKETS: ExportMarket[] = ['stocks', 'crypto', 'options'];
const VALID_MODES: AccountMode[] = ['demo', 'live'];

/** Union the per-env closed-options buckets from a stocks snapshot, de-duped by id. */
function collectClosedOptions(snap: StocksTradeSnapshot | null): OptionPosition[] {
  if (!snap) return [];
  const byId = new Map<string, OptionPosition>();
  const buckets = snap.optionsByEnv
    ? Object.values(snap.optionsByEnv)
    : snap.options
      ? [snap.options]
      : [];
  for (const bucket of buckets) {
    for (const opt of bucket?.closedOptions ?? []) byId.set(opt.id, opt);
  }
  return Array.from(byId.values());
}

/**
 * Collect crypto closed positions, preferring the TRA-242 mode-split lists
 * (stamping mode so legacy rows without it land in the right bucket) and
 * falling back to the merged list. De-duped by id.
 */
function collectClosedCrypto(snap: CryptoTradeSnapshot | null): Position[] {
  if (!snap) return [];
  const byId = new Map<string, Position>();
  const hasSplit = snap.demoClosedPositions || snap.liveClosedPositions;
  if (hasSplit) {
    for (const p of snap.demoClosedPositions ?? []) byId.set(p.id, { ...p, mode: p.mode ?? 'demo' });
    for (const p of snap.liveClosedPositions ?? []) byId.set(p.id, { ...p, mode: p.mode ?? 'live' });
  } else {
    for (const p of snap.closedPositions ?? []) byId.set(p.id, p);
  }
  return Array.from(byId.values());
}

app.get('/api/trades/export', requireAuth, async (req, res, next) => {
  try {
    const username = res.locals['authUser'] as string;
    const query = req.query as Record<string, unknown>;

    const format: ExportFormat = String(query['format'] ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    if (query['format'] && format !== String(query['format']).toLowerCase()) {
      res.status(400).json({ error: "format must be 'csv' or 'json'" });
      return;
    }

    const markets = parseCsvParam(query['markets']).filter((m): m is ExportMarket =>
      (VALID_MARKETS as string[]).includes(m),
    );
    const modes = parseCsvParam(query['modes']).filter((m): m is AccountMode =>
      (VALID_MODES as string[]).includes(m),
    );
    const filters: ExportFilters = {
      markets,
      modes,
      from: parseExportBoundary(query['from'], false),
      to: parseExportBoundary(query['to'], true),
    };

    const [stocksSnap, cryptoSnap] = await Promise.all([
      loadStocksTradeSnapshot(username),
      loadCryptoTradeSnapshot(username),
    ]);

    const { rows, summary } = buildExport(
      {
        stocksClosed: stocksSnap?.closedPositions ?? [],
        cryptoClosed: collectClosedCrypto(cryptoSnap),
        optionsClosed: collectClosedOptions(stocksSnap),
      },
      filters,
    );

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trades-export-${stamp}.json"`);
      res.send(JSON.stringify({ summary, trades: rows }, null, 2));
    } else {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trades-export-${stamp}.csv"`);
      res.send(toCsv(rows));
    }
  } catch (err) {
    next(err);
  }
});

// ── State ─────────────────────────────────────────────────────────────────────

app.get('/api/state', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.engine.getState());
});

app.get('/api/crypto/state', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.cryptoEngine.getState());
});

app.get('/api/crypto/news', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.cryptoEngine.getNews());
});

app.get('/api/news', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const yahoo = ctx.engine.getNews();
  const merged = await mergeResearchAndNews(yahoo);
  res.json(merged);
});

// TRA-530 — per-symbol analysis breadth bundle for the TRA-529 analyst agents.
// Returns `{ technical, sentiment }`. This issue (TRA-534/Part B) creates the
// route and fills the `sentiment` half; the `technical` half is filled by
// TRA-533/Part A (multi-timeframe snapshot) when it lands. Each feed degrades
// to `null` with a reason rather than 500ing (acceptance #4).
app.get('/api/analysis/breadth/:symbol', requireAuth, async (req, res) => {
  const raw = (req.params as Record<string, string>)['symbol'] ?? '';
  const symbol = aliasWatchlistSymbol(raw).toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol required' });
    return;
  }
  const ctx = await userCtx(res);
  const notes: { technical?: string; sentiment?: string; social?: string } = {};

  let sentiment = null;
  try {
    sentiment = ctx.engine.getSymbolSentiment(symbol);
  } catch (err) {
    notes.sentiment = err instanceof Error ? err.message : 'sentiment unavailable';
  }

  // TRA-602 — StockTwits social-sentiment half. Degrades to a null feed with a
  // reason (cold cache / feed throttled) rather than 500ing, mirroring the news
  // and technical halves.
  let social = null;
  try {
    social = ctx.engine.getSocialSentiment(symbol);
  } catch (err) {
    notes.social = err instanceof Error ? err.message : 'social sentiment unavailable';
  }

  // TRA-533 — multi-timeframe technical snapshot. Cached-or-on-demand; degrades
  // to a null feed with a reason (no candles yet / feed cold) rather than 500ing.
  let technical = null;
  try {
    technical = await ctx.engine.getOrComputeTechnicalSnapshot(symbol);
    if (!technical) notes.technical = 'no technical data available for symbol';
  } catch (err) {
    notes.technical = err instanceof Error ? err.message : 'technical snapshot unavailable';
  }

  res.json({
    symbol,
    asOf: new Date().toISOString(),
    technical,
    sentiment,
    social,
    notes,
  });
});

// TRA-227 — research-report ingestion + listing.
//
// `POST /api/research/reports` is admin-only: the QuantTrader routine runs
// internally and uses an admin token. The endpoint is idempotent on `id` —
// repeating with the same id updates the saved record rather than duplicating.
app.post('/api/research/reports', requireAuth, requireAdmin, async (req, res) => {
  try {
    const saved = await saveResearchReport(req.body);
    res.status(201).json(saved);
  } catch (err) {
    if (err instanceof ResearchValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('research save failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to save research report' });
  }
});

app.get('/api/research/reports', requireAuth, async (_req, res) => {
  res.json(await listResearchReports());
});

// TRA-791 — labelled SupertrendConfluence shadow signal->outcome ledger. This
// is the dataset TRA-789 (QuantTrader) validates: hit rate / R:R / false-signal
// rate are computed against these rows. Admin-only, same pattern as the other
// research routes. `?from=` / `?to=` are ms-epoch inclusive bounds on signal ts.
// Read-only; supertrend stays router-gated OFF pending TRA-734.
app.get('/api/research/shadow-signals', requireAuth, requireAdmin, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  const signals = await listShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
  res.json({ signals });
});

// TRA-799 — public, read-only acceptance probe for the TRA-791 shadow ledger
// (parity with the TRA-586 `/api/health/market-review` and TRA-580
// `/api/health/live-equity` probes). Unauthenticated by design: the rows are
// pure strategy telemetry (symbol, side, indicator booleans, the entry/stop/
// target prices, and the realized outcome) — no PII, no user identity, no
// account balances, and no real positions, the same non-sensitive class as the
// other open health probes. It exists so QuantTrader can pull the live-tape
// shadow signal->outcome dataset to drive the TRA-734 go/no-go *without*
// shipping Render-specific admin credentials into the validator's harness env,
// which Render's separate user store made impossible. Supertrend stays
// router-gated OFF pending TRA-734; this only observes and labels. Same
// `?from=`/`?to=` ms-epoch inclusive window as the admin research route, which
// is left untouched for the authenticated desk UI.
app.get('/api/health/shadow-signals', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const signals = await listShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({ issue: 'TRA-799', count: signals.length, signals });
  } catch (err) {
    log.error('shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read shadow ledger' });
  }
});

// TRA-911 (TRA-908 Phase A) — read-only probe over the shadow OPTION-trade
// ledger. Open like the Supertrend shadow probe so QuantTrader (TRA-914) can
// validate the gate matrix output without Render admin creds. Reports whether
// the selector flag is enabled so a viewer can tell an empty ledger ("flag off")
// from a live-but-silent one.
app.get('/api/health/option-shadow-signals', async (_req, res) => {
  try {
    const signals = await listOptionShadowSignals();
    res.json({
      issue: 'TRA-911',
      flagEnabled: isOptionShadowEnabled() && !OPTION_SHADOW_EMERGENCY_OFF,
      // TRA-937 — emergency OOM mitigation: the per-tick pass is hard-off even if
      // ENABLE_OPTION_SHADOW_SELECTOR is set, so a silent ledger here is expected.
      emergencyDisabled: OPTION_SHADOW_EMERGENCY_OFF,
      count: signals.length,
      signals,
    });
  } catch (err) {
    log.error('option-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read option shadow ledger' });
  }
});

// TRA-921 (TRA-920 B) — read-only probe over the OBSERVE-ONLY reversal-checklist
// shadow ledger, open like the Supertrend/option shadow probes so the daily
// learning loop (TRA-920 A) can pull the live-tape setup->outcome dataset
// without Render admin creds. Returns the recent rows plus the N-of-4 hit-rate
// breakdown (how often 4-of-4 vs 3-of-4 setups actually hit target) and whether
// the capture flag is enabled, so an empty ledger ("flag off") is distinguishable
// from a live-but-silent one. `?from=`/`?to=` are ms-epoch inclusive bounds on
// the setup ts. No capital path — observe-only.
app.get('/api/health/reversal-shadow-signals', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const signals = await listReversalShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({
      issue: 'TRA-921',
      flagEnabled: isReversalShadowEnabled(),
      count: signals.length,
      hitRateByScore: reversalHitRateByScore(signals),
      signals,
    });
  } catch (err) {
    log.error('reversal-shadow-signals health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to read reversal shadow ledger' });
  }
});

// TRA-925 (TRA-920 A) — the daily learning loop, exposed as a read-time digest.
// Folds the durable reversal shadow ledger into learned, min-sample-guarded
// scoring multipliers (by checklist score, reversal pattern, and symbol) so the
// agents "get better each day" as outcomes accrue. Computed live from the ledger
// on every call, so the weights can never drift from the source of truth and no
// separate persisted snapshot is needed. Scoring-only, no capital path; the same
// `?from=`/`?to=` ms-epoch inclusive window as the other shadow probes.
app.get('/api/health/learned-weights', async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const parseTs = (v: unknown): number | undefined => {
    const n = Number(v);
    return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : undefined;
  };
  try {
    const signals = await listReversalShadowSignals({ from: parseTs(q['from']), to: parseTs(q['to']) });
    res.json({
      issue: 'TRA-925',
      flagEnabled: isReversalShadowEnabled(),
      // TRA-1056 — the A/B switch state. Each stat carries multiplierHardGate +
      // multiplierShrunk so QuantTrader can diff them; this says which one the live
      // `reversalSignalMultiplier` currently reads (default: hard-gate).
      shrinkageFlagEnabled: isLearnedShrinkageEnabled(),
      count: signals.length,
      weights: computeLearnedWeights(signals),
    });
  } catch (err) {
    log.error('learned-weights health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to compute learned weights' });
  }
});

// TRA-1046 (TRA-1041c L2) — on-demand hypothesis backtest. Validates a single
// param-change hypothesis SYNCHRONOUSLY through the same apply→backtest→G0-grade
// pipeline the analyst's EOD reflect routine uses, returning the graded result in
// one round-trip so a param can be checked without overnight latency. Read-only:
// it never enqueues a ratification item or touches demo/live config — the only
// path that lands a change stays the board-ratified queue, and live promotion is
// gated on TRA-382. Auth-gated because a backtest is non-trivial compute.
const onDemandBacktestExecutor = makeBacktestExecutor();
app.post('/api/backtest', requireAuth, async (req, res) => {
  const problem = validateBacktestRequest(req.body);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  try {
    const result = await runOnDemandBacktest(req.body as OnDemandBacktestRequest, {
      baseConfig: RV_CRYPTO_MAJORS_BASE_CONFIG,
      runBacktest: onDemandBacktestExecutor,
    });
    res.json({ issue: 'TRA-1046', ...result });
  } catch (err) {
    if (err instanceof OnDemandBacktestBadRequest) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('on-demand backtest failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

app.get('/api/research/reports/:id', requireAuth, async (req, res) => {
  const id = (req.params as Record<string, string>)['id'];
  const report = await getResearchReport(id);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(report);
});

// TRA-386 — automated market-review feed. The scheduler regenerates this at
// 9 AM ET (pre-market) and 9 PM ET (post-market); the signal engine and
// watchlist builder pull the latest regime gates from here instead of waiting
// on a hand-written QuantTrader review.
//
// `GET /api/market-review/latest` — most recent review; `?kind=premarket` or
// `?kind=postmarket` scopes it. TRA-589: recomputes live when the persisted
// review is stale/dark. Returns 404 only when no review exists and a live
// recompute could not produce one.
app.get('/api/market-review/latest', requireAuth, async (req, res) => {
  const rawKind = (req.query as Record<string, unknown>)['kind'];
  const kind =
    rawKind === 'premarket' || rawKind === 'postmarket' ? rawKind : undefined;
  // TRA-589 — recompute live before serving when the persisted review is stale
  // (predates the current ET session or came from a dark feed), so the banner
  // reflects a feed repaired by a deploy without waiting for the next job.
  const review = await getFreshMarketReview(kind);
  if (!review) {
    res.status(404).json({ error: 'No market review available yet' });
    return;
  }
  res.json(review);
});

app.get('/api/market-review', requireAuth, async (_req, res) => {
  res.json(await listMarketReviews());
});

// TRA-586 — redacted, read-only acceptance probe (parity with the TRA-580
// `/api/health/live-equity` probe). Unauthenticated by design: it computes a
// FRESH regime from the live index feeds without persisting or publishing, and
// returns only public market data (index levels, the regime label, and which
// provider served the S&P 500 trend MA). This proves the non-Yahoo (Tradier)
// trend fallback engages when Yahoo's breaker is open — verifiable against the
// live deployment without shipping admin credentials into an agent env.
app.get('/api/health/market-review', async (_req, res) => {
  try {
    const peek = await peekMarketRegime();
    res.json(peek);
  } catch (err) {
    log.error('market-review health probe failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to compute market regime' });
  }
});

// Admin-only on-demand regeneration — lets QA / the desk refresh the review
// without waiting for the next scheduler fire.
app.post('/api/market-review/run', requireAuth, requireAdmin, async (req, res) => {
  const rawKind = (req.body as Record<string, unknown> | undefined)?.['kind'];
  const kind = rawKind === 'postmarket' ? 'postmarket' : 'premarket';
  try {
    const review = await generateMarketReview(kind);
    res.status(201).json(review);
  } catch (err) {
    log.error('market-review on-demand run failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to generate market review' });
  }
});

// ── Live-Trading Promotion Gate (TRA-532) ────────────────────────────────────
//
// The gate refuses a live transition unless a strategy has passed backtest +
// paper and carries a sign-off (enforced in PUT /api/account/settings above).
// These routes surface the per-stage status with metrics computed from data,
// register a Stage-1 backtest report, and record the Stage-3 sign-off audit.

// TRA-803 — PUBLIC, tokenless read-only probe for a strategy's promotion-gate
// summary, extending the TRA-799 shadow-ledger pattern to the Stage-2 paper
// gate. Unauthenticated by design and the same non-sensitive class as the other
// open `/api/health/*` probes: it returns ONLY the promotion-gate telemetry —
// per-stage state, the computed backtest/paper metrics, `canGoLive`, and the
// blocked-reason strings — with no order/account internals, no PII, and no
// secrets. It exists so QuantTrader can read `supertrend_confluence`
// `paper.tradeCount` plus the gate metrics to drive the TRA-802 Stage-2 go/no-go
// WITHOUT Render-specific admin creds (login + pre-minted token both 401 on
// Render's separate user store). The paper ledger is aggregated across all users
// so the count reflects the TOTAL monitored paper trades accrued. The gate logic
// is untouched, so the `canGoLive` safety invariant it reports is identical to
// the authenticated `/api/promotion/status/:strategyId` route — for the gated
// supertrend strategy it stays `false` until Stage 1/2/3 all pass.
app.get('/api/health/promotion-gate/:strategyId', async (req, res) => {
  const strategyId = (req.params as Record<string, string>)['strategyId'] as string;
  try {
    const status = await buildPublicPromotionProbe(strategyId);
    res.json({
      issue: 'TRA-803',
      strategyId,
      canGoLive: status.canGoLive,
      status,
      // TRA-936 — the Stage-2 paper count is now a DURABLE cumulative ledger
      // (`supertrendPaperClosed`) that survives the nightly TRA-219 archive and a
      // Render redeploy, so a post-deploy reading is NO LONGER expected to reset
      // to 0. A genuine 0 means no forward-test trades have ever resolved (e.g. a
      // brand-new deploy onto a fresh data disk), not a lost book — do not open a
      // duplicate verify task on a 0 alone; confirm against the shadow-signals
      // ledger (`/api/health/shadow-signals`) first.
      paperLedger: 'durable-cumulative (TRA-936)',
    });
  } catch (err) {
    log.error('promotion-gate health probe failed', {
      strategyId,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to compute promotion-gate status' });
  }
});

// Per-strategy promotion status (per-stage state + computed metrics + verdict).
// Scoped to the caller's paper ledger; backtest/sign-off are global. Any
// authenticated user can read so the dashboard can render the gate UI.
app.get('/api/promotion/status/:strategyId', requireAuth, async (req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const status = await buildPromotionStatus(username, req.params['strategyId'] as string);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// All registered strategies' records + the caller's live status for each, plus
// the effective thresholds — drives the gate overview panel.
app.get('/api/promotion/status', requireAuth, async (_req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const records = await listStrategyRecords();
    const statuses = await Promise.all(
      records.map(async r => ({
        record: r,
        status: await buildPromotionStatus(username, r.strategyId),
        thresholds: await getEffectiveThresholds(r.strategyId),
      })),
    );
    res.json({ strategies: statuses });
  } catch (err) {
    next(err);
  }
});

// Stage 1 — register a backtest report for a strategy. Admin-only. The body
// carries the FULL computed `BacktestResult`; the server picks the gate metrics
// off it (deriveBacktestGateMetrics) so the registered numbers always reflect a
// real run — a reviewer cannot hand-type metrics to clear the gate (TRA-527 §3).
app.post('/api/promotion/backtest', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as { strategyId?: string; reportId?: string; report?: unknown };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    if (!body.report || typeof body.report !== 'object') {
      res.status(400).json({ error: 'report (a computed BacktestResult) is required' });
      return;
    }
    const rec = await registerBacktestReport({
      strategyId: body.strategyId,
      report: body.report as Parameters<typeof registerBacktestReport>[0]['report'],
      reportId: typeof body.reportId === 'string' ? body.reportId : 'unspecified',
      registeredBy: username,
    });
    res.status(201).json(rec);
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-532 register backtest failed', { reason: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Failed to register backtest report' });
  }
});

// Stage 1 (TRA-541) — register the backtest leg from a TRA-540 optimization
// `verdict` block. Admin-only. The body carries the machine-generated `verdict`
// from `optimization-report.json`; the server ingests its `backtestMetrics` 1:1
// AND stores the six-guard `pass` flag, which then GATES the leg: a strategy
// whose verdict.pass === false cannot clear Stage 1 even with strong headline
// metrics (the six-guard battery is the gate, not the raw numbers). The blessed
// parameter set is recorded for audit.
app.post('/api/promotion/optimization', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as { strategyId?: string; reportId?: string; verdict?: unknown };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    if (!body.verdict || typeof body.verdict !== 'object') {
      res.status(400).json({ error: 'verdict (the TRA-540 optimization verdict block) is required' });
      return;
    }
    const rec = await registerOptimizationVerdict({
      strategyId: body.strategyId,
      verdict: body.verdict as Parameters<typeof registerOptimizationVerdict>[0]['verdict'],
      reportId: typeof body.reportId === 'string' ? body.reportId : 'unspecified',
      registeredBy: username,
    });
    res.status(201).json(rec);
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-541 register optimization verdict failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to register optimization verdict' });
  }
});

// Stage 3 — record a sign-off (`promotion_decision`). Admin-only (QuantTrader
// is an admin reviewer). Refuses to sign off a strategy that is not actually
// passing both gates UNLESS the reviewer supplies a threshold override + a
// written rationale (loosen-only audit per TRA-527 §3/§Enforcement).
app.post('/api/promotion/signoff', requireAuth, requireAdmin, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const body = req.body as {
      strategyId?: string;
      thresholdOverrides?: unknown;
      rationale?: string;
    };
    if (!body?.strategyId || typeof body.strategyId !== 'string') {
      res.status(400).json({ error: 'strategyId is required' });
      return;
    }
    const overrides = body.thresholdOverrides as Parameters<typeof recordSignoff>[0]['thresholdOverrides'];
    // Evaluate current state (with any proposed overrides not yet stored, the
    // base status must already pass both data gates; overrides only loosen and
    // are recorded for audit). Block sign-off if a data gate fails and no
    // override+rationale justifies it.
    const status = await buildPromotionStatus(username, body.strategyId);
    const dataGatesPass = status.backtest.state === 'pass' && status.paper.state === 'pass';
    if (!dataGatesPass && !overrides) {
      res.status(422).json({
        ok: false,
        code: 'signoff_blocked',
        error:
          'Cannot sign off: the strategy does not pass both data gates. '
          + 'Supply thresholdOverrides + rationale to loosen (audited), or fix the underlying metrics. '
          + status.blockedReasons.join(' | '),
        status,
      });
      return;
    }
    const paperMetrics = await snapshotPaperMetrics(username, body.strategyId);
    const decision = await recordSignoff({
      strategyId: body.strategyId,
      reviewer: username,
      backtestMetrics: status.backtest.metrics,
      paperMetrics,
      thresholdOverrides: overrides,
      rationale: typeof body.rationale === 'string' ? body.rationale : undefined,
    });
    res.status(201).json({ ok: true, decision, status: await buildPromotionStatus(username, body.strategyId) });
  } catch (err) {
    if (err instanceof PromotionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.error('TRA-532 sign-off failed', { reason: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Failed to record sign-off' });
  }
});

// TRA-244 — `?mode=` lets the client pick which calendar bucket to read.
// Defaults follow the user's saved settings so callers without the query
// (legacy clients, scripts) keep their current behavior.
function resolveStockReportMode(req: express.Request, username: string): StockModeKey {
  const q = (req.query['mode'] as string | undefined)?.trim();
  if (q === 'demo' || q === 'live' || q === 'sandbox') return q;
  return stockModeKey(getSettings(username));
}

function resolveCryptoReportMode(req: express.Request, username: string): CryptoModeKey {
  const q = (req.query['mode'] as string | undefined)?.trim();
  if (q === 'demo' || q === 'live') return q;
  return cryptoModeKey(getSettings(username));
}

app.get('/api/reports/latest', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveStockReportMode(req, ctx.username);
  const latestPath = join(stockReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(latestPath)) {
    res.status(404).json({ error: 'No report generated yet' });
    return;
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

app.get('/api/reports', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveStockReportMode(req, ctx.username);
  try {
    const files = await readdir(stockReportsDirFor(ctx, mode));
    const dates = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
    res.json({ dates });
  } catch {
    res.json({ dates: [] });
  }
});

app.get('/api/reports/:date', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const mode = resolveStockReportMode(req, ctx.username);
  const filePath = join(stockReportsDirFor(ctx, mode), `${date}.json`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No report for ${date}` });
    return;
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read report' });
  }
});

app.post('/api/reports/generate', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    await generateAndSaveReport(ctx);
    res.json({ ok: true, message: 'EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// TRA-244 — manually re-run the historical Live-calendar realized-P&L backfill
// for the current user (also runs automatically at startup). Returns the
// per-date map that was rewritten so the board can confirm the broker-truth
// values without restarting the server.
app.post('/api/reports/backfill-realized', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    const written = await backfillLiveRealizedCalendar(ctx);
    if (written === null) {
      res.status(400).json({
        error: 'Backfill only applies to a Tradier-backed live/sandbox account.',
      });
      return;
    }
    res.json({ ok: true, written });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Crypto Reports ────────────────────────────────────────────────────────────

app.get('/api/crypto/reports/latest', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveCryptoReportMode(req, ctx.username);
  const latestPath = join(cryptoReportsDirFor(ctx, mode), 'latest.json');
  if (!existsSync(latestPath)) {
    res.status(404).json({ error: 'No crypto report generated yet' });
    return;
  }
  try {
    const raw = await readFile(latestPath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read crypto report' });
  }
});

app.get('/api/crypto/reports', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const mode = resolveCryptoReportMode(req, ctx.username);
  try {
    const files = await readdir(cryptoReportsDirFor(ctx, mode));
    const dates = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
    res.json({ dates });
  } catch {
    res.json({ dates: [] });
  }
});

app.get('/api/crypto/reports/:date', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { date } = req.params as Record<string, string>;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }
  const mode = resolveCryptoReportMode(req, ctx.username);
  const filePath = join(cryptoReportsDirFor(ctx, mode), `${date}.json`);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No crypto report for ${date}` });
    return;
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(500).json({ error: 'Failed to read crypto report' });
  }
});

app.post('/api/crypto/reports/generate', requireAuth, async (_req, res) => {
  try {
    const ctx = await userCtx(res);
    await generateAndSaveCryptoReport(ctx);
    res.json({ ok: true, message: 'Crypto EOD report generated successfully' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/snapshots', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  res.json(ctx.tracker.getSnapshots());
});

// ── Account Settings ─────────────────────────────────────────────────────────

// TRA-485 — `loadSettings` (not the cache-only `getSettings`) so a user who
// missed boot-time `initAllUserContexts` warmup (signed up after boot, or
// warmup threw for their row) still gets their persisted settings instead of
// silently seeing `DEFAULT_ACCOUNT_SETTINGS`. `loadSettings` is cache-first so
// the warm path stays O(1); only a cold lookup hits disk. Errors propagate to
// the Express error handler instead of being swallowed into a 200-of-defaults.
app.get('/api/account/settings', requireAuth, async (_req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const settings = await loadSettings(username);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// TRA-850 — the authenticated user's persistent advisory trading memory
// (preferences the agent graph reads into its context + the learned interaction
// tally). Read-back for the settings UI; preferences only — nothing here changes
// a strategy or the promotion gate.
app.get('/api/account/trading-memory', requireAuth, async (_req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const [memory, interactionStats] = await Promise.all([
      getUserMemory(username),
      getInteractionStats(username),
    ]);
    res.json({ memory, interactionStats });
  } catch (err) {
    next(err);
  }
});

// TRA-850 — set the authenticated user's advisory preferences (risk tolerance,
// preferred/avoided strategies, a de-risk sizing default, per-symbol watchlist
// rationale, notes). The store sanitizes the patch (clamps sizing to [0,1],
// drops invalid fields, merges watchlist rationale by symbol).
app.put('/api/account/trading-memory', requireAuth, async (req, res, next) => {
  const username = res.locals['authUser'] as string;
  try {
    const memory = await setUserMemory(username, (req.body ?? {}) as Parameters<typeof setUserMemory>[1]);
    res.json({ memory });
  } catch (err) {
    next(err);
  }
});

app.put('/api/account/settings', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const body = req.body as Partial<AccountSettings>;
  // TRA-485 — paired with the GET-handler change: read the saved snapshot
  // through `loadSettings` so a cache-cold PUT (partial body like
  // AccountModeSwitcher's `{ mode: 'live' }`) merges against the user's
  // real persisted settings rather than DEFAULT_ACCOUNT_SETTINGS — which
  // would otherwise quietly wipe every untouched field on disk.
  const current = await loadSettings(username);
  const clampEquity = (v: number) => Math.max(1_000, Math.min(10_000_000, Number(v)));
  const updated: AccountSettings = {
    ...current,
    ...body,
    demoEquity: clampEquity(body.demoEquity ?? current.demoEquity),
    demoEquityStocks: clampEquity(body.demoEquityStocks ?? current.demoEquityStocks ?? current.demoEquity),
    demoEquityCrypto: clampEquity(body.demoEquityCrypto ?? current.demoEquityCrypto ?? current.demoEquity),
    dailyTradesLimit: Math.max(1, Math.min(100, Number(body.dailyTradesLimit ?? current.dailyTradesLimit))),
    optionsDailyTradesLimit: Math.max(1, Math.min(100, Number(body.optionsDailyTradesLimit ?? current.optionsDailyTradesLimit))),
    // TRA-327 — clamp the live-only counterparts independently so a Demo edit
    // never pulls the Live cap with it. Falls back to the un-suffixed demo
    // value for back-compat with saved settings written before TRA-327.
    dailyTradesLimitLive: Math.max(
      1,
      Math.min(
        100,
        Number(body.dailyTradesLimitLive ?? current.dailyTradesLimitLive ?? current.dailyTradesLimit),
      ),
    ),
    optionsDailyTradesLimitLive: Math.max(
      1,
      Math.min(
        100,
        Number(
          body.optionsDailyTradesLimitLive
            ?? current.optionsDailyTradesLimitLive
            ?? current.optionsDailyTradesLimit,
        ),
      ),
    ),
    managedAccountRatio: Math.max(0.01, Math.min(1, Number(body.managedAccountRatio ?? current.managedAccountRatio))),
    riskPerTrade: Math.max(0.001, Math.min(0.5, Number(body.riskPerTrade ?? current.riskPerTrade))),
    // TRA-346 — scoped Managed Account Ratio + Risk Per Trade. Each of the
    // eight (mode × dashboard) buckets is clamped independently and preserved
    // as `undefined` when neither the request body nor the saved snapshot
    // holds a value, so untouched buckets keep falling back to the legacy
    // un-suffixed field via `resolveManagedAccountRatio` /
    // `resolveRiskPerTrade`. Pinning every bucket to a default the moment any
    // other setting is saved would silently break that fallback for users who
    // saved before TRA-346. Helper extracted to `account-settings.ts` so
    // TRA-349 regression tests can lock the contract without spinning up the
    // route.
    ...mergeScopedRiskSettings(current, body),
    // TRA-249-E — clamp the operator-facing leverage cap to [1, 5] integer.
    // The live engine still hard-caps at 1× (PERP_SHORT_LEVERAGE) so a
    // misconfigured value can't bypass the §6 caps; clamping here keeps the
    // stored payload sane regardless of what the UI sends.
    liveMaxLeverageCrypto: Math.max(
      1,
      Math.min(5, Math.round(Number(body.liveMaxLeverageCrypto ?? current.liveMaxLeverageCrypto ?? 1))),
    ),
    // TRA-325 — clamp to a known preset id so a malformed request can't park
    // the engine on an unknown preset (which would degrade-fall to no_trade
    // anyway via resolveStrategyPreset since TRA-697, but persisting a junk id would
    // surface as a confusing UI selection on next load).
    activeStrategyPreset: ((): StrategyPresetId => {
      const requested = body.activeStrategyPreset ?? current.activeStrategyPreset;
      if (requested && requested in STRATEGY_PRESETS) return requested as StrategyPresetId;
      return DEFAULT_STRATEGY_PRESET_ID;
    })(),
  };
  // TRA-515 — the TRA-506 guardrail used to 422-reject this PUT whenever any
  // required live cred was blank. But the PUT is atomic: rejecting it
  // discarded the user's *valid* Tradier production keys the moment an
  // unrelated market was unconfigured — e.g. a Tradier-only stocks+options
  // user in live mode who never set up Coinbase. `findMissingLiveCredentials`
  // demands the Coinbase pair in live mode (default `liveBrokerageTypeCrypto`
  // is 'coinbase'), so their save 422'd, the Tradier keys never reached disk,
  // and GET /api/account/settings kept returning empty
  // `liveApiKeyOptionsProduction` / `liveAccountIdOptionsProduction` — live
  // Tradier trading could never start.
  //
  // The warning the user actually needs is already rendered client-side by
  // LiveCredentialsBanner, which derives the missing set from the loaded
  // settings via `findMissingLiveCredentials` — it never depended on this
  // 422. And the engine builds a null broker client for any market whose
  // creds are blank (`buildTradierLiveClient` / `buildTradierLiveEquityClient`
  // / crypto `buildLiveBroker` all return null), so persisting a partially
  // configured snapshot can never place orders on an unconfigured market.
  //
  // So: persist unconditionally and surface the missing set as a
  // non-blocking `missingLiveCredentials` warning on the 200 response. A
  // market with its creds filled (Tradier) goes live; markets still missing
  // creds stay dormant and keep nagging through the banner.
  const missingLiveCredentials = Array.from(new Set([
    ...validateLiveCredentials(updated).missing,
    ...validateProductionTradierKeys(updated).missing,
  ]));
  // TRA-532 — Live-Trading Promotion Gate. Before persisting a settings change
  // whose *result* runs live crypto auto-trading, every strategy the active
  // preset would trade live must be fully promoted
  // (backtest=pass AND paper=pass AND signoff=present). An unpromoted strategy
  // blocks the save with the exact failing gate so the UI can surface it. The
  // gate only fires on results that turn/keep live ON — turning live OFF or
  // editing settings in Demo is never blocked (see evaluateLiveTransitionGate).
  try {
    const gate = await evaluateLiveTransitionGate(username, updated);
    if (!gate.allowed) {
      log.warn('TRA-532 refused live transition', { username, blocked: gate.blocked.map(b => b.strategyId) });
      res.status(422).json({
        ok: false,
        code: 'promotion_gate_blocked',
        error:
          'Live trading is blocked by the promotion gate: '
          + gate.blocked
            .map(b => `${b.strategyId} — ${b.reasons.join(' | ')}`)
            .join(' ;; '),
        blocked: gate.blocked,
      });
      return;
    }
  } catch (err: unknown) {
    // Fail CLOSED: if the gate cannot be evaluated we must not silently let a
    // live flip through. Surface a 500 the dashboard can retry.
    log.error('TRA-532 promotion gate evaluation failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      ok: false,
      code: 'promotion_gate_error',
      error: 'Could not verify the live-trading promotion gate. Live transition refused; please retry.',
    });
    return;
  }
  // TRA-511 — wrap the persistence call so a `writeFile` failure (disk full,
  // EACCES, EROFS, etc.) surfaces to the UI as a red "save failed" toast
  // instead of silently appearing to succeed. Before this, an EBUSY on the
  // user's account-settings.json could bubble out as a generic 500 with no
  // structured code for the dashboard to discriminate on, leaving the
  // Settings page in a "looks-saved" state while disk still held stale data.
  try {
    await saveSettings(username, updated);
  } catch (err: unknown) {
    log.error('TRA-511 saveSettings: persistence failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      ok: false,
      code: 'settings_persist_failed',
      error: 'Failed to persist account settings. Please retry; if the problem persists, contact support.',
    });
    return;
  }
  // Await the stocks engine: TRA-226 makes applySettings async so a flip into
  // live mode can refresh the Tradier balance once before the broadcast,
  // matching the Coinbase pattern from TRA-224 — without this the dashboard
  // would show $0 equity for up to 30s until the next tick.
  await ctx.engine.applySettings(updated);
  broadcastEngineState(ctx);
  // Await the crypto engine: switching into live mode does an initial Coinbase
  // balance fetch, and the broadcast that follows must reflect that equity
  // instead of a transient $0 the user sees until the next 60s tick (TRA-224).
  await ctx.cryptoEngine.applySettings(updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, settings: updated, missingLiveCredentials });
});

// ── TRA-566 (TRA-410 A2) — alert notifications ───────────────────────────────
//
// Channel adapters + shared renderer live in `notifications/`; these routes are
// the user-facing surface: edit prefs, fire a test send, and link a Telegram
// chat. The dispatcher itself fans out engine events (A1) through the same
// registered adapters.

/**
 * Validate + deep-merge a partial AlertPreferences patch over the user's
 * current (fully-resolved) prefs. Returns the sanitized result, or an error
 * string for a 400. Never lets a malformed field corrupt the stored snapshot.
 */
function sanitizeNotificationPrefs(
  base: AlertPreferences,
  patch: Partial<AlertPreferences> | undefined,
): { prefs: AlertPreferences; error?: string } {
  const next: AlertPreferences = resolveAlertPreferences({ alertPreferences: base });
  if (!patch || typeof patch !== 'object') return { prefs: next };

  // Channels
  if (patch.channels && typeof patch.channels === 'object') {
    for (const ch of ALERT_CHANNELS) {
      const inc = patch.channels[ch];
      if (!inc || typeof inc !== 'object') continue;
      const cur = next.channels[ch];
      if (typeof inc.enabled === 'boolean') cur.enabled = inc.enabled;
      if (typeof inc.emailAddress === 'string') {
        const v = inc.emailAddress.trim();
        if (v && !v.includes('@')) return { prefs: next, error: 'invalid email address' };
        cur.emailAddress = v || undefined;
      }
      if (typeof inc.telegramChatId === 'string') {
        cur.telegramChatId = inc.telegramChatId.trim() || undefined;
      }
      if (typeof inc.discordWebhookUrl === 'string') {
        const v = inc.discordWebhookUrl.trim();
        if (v && !isValidDiscordWebhook(v)) {
          return { prefs: next, error: 'invalid Discord webhook URL' };
        }
        cur.discordWebhookUrl = v || undefined;
      }
    }
  }

  // Event routing matrix
  if (patch.events && typeof patch.events === 'object') {
    for (const klass of Object.keys(next.events) as (keyof AlertPreferences['events'])[]) {
      const incRow = patch.events[klass];
      if (!incRow || typeof incRow !== 'object') continue;
      for (const ch of ALERT_CHANNELS) {
        if (typeof incRow[ch] === 'boolean') next.events[klass][ch] = incRow[ch];
      }
    }
  }

  // Quiet hours
  if (patch.quietHours && typeof patch.quietHours === 'object') {
    const q = patch.quietHours;
    if (typeof q.enabled === 'boolean') next.quietHours.enabled = q.enabled;
    const hm = /^([01]?\d|2[0-3]):[0-5]\d$/;
    if (typeof q.start === 'string') {
      if (!hm.test(q.start.trim())) return { prefs: next, error: 'invalid quiet-hours start (HH:MM)' };
      next.quietHours.start = q.start.trim();
    }
    if (typeof q.end === 'string') {
      if (!hm.test(q.end.trim())) return { prefs: next, error: 'invalid quiet-hours end (HH:MM)' };
      next.quietHours.end = q.end.trim();
    }
    if (typeof q.timezone === 'string' && q.timezone.trim()) {
      const tz = q.timezone.trim();
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        return { prefs: next, error: 'invalid timezone' };
      }
      next.quietHours.timezone = tz;
    }
  }

  // Signal digest
  if (patch.signalDigest !== undefined) {
    if (!['immediate', '15min', 'hourly'].includes(patch.signalDigest)) {
      return { prefs: next, error: 'invalid signalDigest' };
    }
    next.signalDigest = patch.signalDigest;
  }

  return { prefs: next };
}

// Edit alert preferences. Partial patches are deep-merged over the user's
// current prefs and validated; a bad field 400s without touching disk.
app.put('/api/account/notifications', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  try {
    const current = await loadSettings(username);
    const base = resolveAlertPreferences(current);
    const { prefs, error } = sanitizeNotificationPrefs(base, req.body as Partial<AlertPreferences>);
    if (error) {
      res.status(400).json({ ok: false, error });
      return;
    }
    await saveSettings(username, { ...current, alertPreferences: prefs });
    res.json({ ok: true, alertPreferences: prefs });
  } catch (err) {
    log.error('PUT /api/account/notifications failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ ok: false, error: 'Failed to save notification preferences.' });
  }
});

// Fire a test alert through ONE channel, bypassing routing/quiet-hours/digest
// so the user can confirm a channel is wired. The channel must be configured
// (SMTP creds / linked Telegram chat / valid Discord webhook) or this 409s.
app.post('/api/notifications/test', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const channel = (req.body as { channel?: string } | undefined)?.channel;
  if (!channel || !ALERT_CHANNELS.includes(channel as AlertChannel)) {
    res.status(400).json({ ok: false, error: `channel must be one of ${ALERT_CHANNELS.join(', ')}` });
    return;
  }
  const adapter: ChannelAdapter | undefined =
    channelAdapters[channel as keyof typeof channelAdapters];
  if (!adapter) {
    res.status(500).json({ ok: false, error: 'channel adapter not registered' });
    return;
  }
  try {
    const settings = await loadSettings(username);
    const prefs = resolveAlertPreferences(settings);
    if (!adapter.isConfigured(prefs)) {
      res.status(409).json({
        ok: false,
        code: 'channel_not_configured',
        error: `The ${channel} channel is not configured yet.`,
      });
      return;
    }
    await adapter.send(buildSampleAlertEvent(username), prefs);
    res.json({ ok: true, channel });
  } catch (err) {
    log.warn('test notification failed', {
      username,
      channel,
      reason: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({
      ok: false,
      code: 'send_failed',
      error: `Test send failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// Issue a single-use Telegram link token + deep link. The user taps the link,
// Telegram delivers `/start <token>` to the bot, and the webhook below records
// their chat_id. Requires a deployment bot token to be useful.
app.post('/api/notifications/telegram/link', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  const botUsername = process.env['TELEGRAM_BOT_USERNAME'];
  if (!process.env['TELEGRAM_BOT_TOKEN']) {
    res.status(503).json({
      ok: false,
      code: 'telegram_not_configured',
      error: 'Telegram is not enabled on this deployment (no TELEGRAM_BOT_TOKEN).',
    });
    return;
  }
  const token = issueLinkToken(username);
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=${token}` : undefined;
  res.json({ ok: true, token, deepLink, botUsername: botUsername ?? null });
});

// TRA-852 — issue a single-use Discord link token. Discord has no payload deep
// link for slash commands, so the user runs `/link <token>` in any channel the
// bot can see; the interactions endpoint below consumes the token and records
// their Discord user id. Reuses the channel-neutral link-token store. Requires a
// configured public key so an unusable (verification-less) flow can't be linked.
app.post('/api/notifications/discord/link', requireAuth, (req, res) => {
  const username = res.locals['authUser'] as string;
  if (!process.env['DISCORD_PUBLIC_KEY']) {
    res.status(503).json({
      ok: false,
      code: 'discord_not_configured',
      error: 'Discord is not enabled on this deployment (no DISCORD_PUBLIC_KEY).',
    });
    return;
  }
  const token = issueLinkToken(username);
  res.json({ ok: true, token, command: `/link ${token}` });
});

// TRA-848 — true when the agent-layer kill switch (TRADING_AGENTS_LLM_DISABLED)
// is engaged. Mirrors the truthy set used by the advisory layer; gates the
// capital-affecting inbound verbs (approve/reject) without disabling reads.
function isAgentKillSwitchEngaged(): boolean {
  const raw = process.env[LLM_KILL_ENV_VAR];
  if (raw == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// TRA-848 — reverse of account-linking: map an inbound Telegram chat id back to
// the linked app user. The chat id is the auth token here — it was bound only
// via the single-use `/start <token>` flow, so a known chat id IS an
// authenticated user (the link-token auth boundary the issue calls for). Returns
// undefined for any chat we have not linked, so an unsolicited message is
// silently ignored rather than acted on.
function resolveUsernameByTelegramChat(chatId: string): string | undefined {
  for (const ctx of getAllUserContexts()) {
    const prefs = resolveAlertPreferences(getSettings(ctx.username));
    if (prefs.channels.telegram.telegramChatId === chatId) return ctx.username;
  }
  return undefined;
}

// TRA-852 — Discord mirror of resolveUsernameByTelegramChat. A Discord user id
// is the auth subject here: it is bound only via the single-use `/link <token>`
// interaction flow, so a known id IS an authenticated user. Returns undefined
// for any id we have not linked, so an unsolicited interaction is ignored.
function resolveUsernameByDiscordUser(userId: string): string | undefined {
  for (const ctx of getAllUserContexts()) {
    const prefs = resolveAlertPreferences(getSettings(ctx.username));
    if (prefs.channels.discord.discordUserId === userId) return ctx.username;
  }
  return undefined;
}

// TRA-848 — send one plain-text reply on the inbound Telegram chat. Fire-and-
// forget: a failed reply must never 500 the webhook (Telegram expects a fast
// 200 and retries on non-2xx).
async function sendTelegramReply(chatId: string, text: string): Promise<void> {
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    log.warn('telegram reply failed', { reason: err instanceof Error ? err.message : String(err) });
  }
}

// TRA-848 / TRA-852 — assemble the injectable CommandContext the router runs
// against, reading from this user's live engine state. Channel-neutral: the
// Telegram webhook and the Discord interactions endpoint share it (the
// channel-specific bit is only how the reply text is delivered). Read renderers
// are deliberately plain text (chat-friendly); approve/reject delegate to the
// engine's human-in-the-loop methods, which keep every risk + live-gate control.
function buildCommandContext(username: string): CommandContext {
  const ctx = tryGetUserContext(username);
  const engine = ctx?.engine;
  const fmt = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(2);
  const priceFor = (symbol: string): number | undefined => {
    const s = engine?.getState().symbols.find(x => x.symbol.toUpperCase() === symbol.toUpperCase());
    return s?.price;
  };
  return {
    killSwitchEngaged: isAgentKillSwitchEngaged(),
    status: () => {
      if (!engine) return 'No active session.';
      const st = engine.getState();
      const a = st.account;
      return [
        `Equity $${a.totalEquity.toFixed(2)}  Cash $${a.availableCash.toFixed(2)}`,
        `Day P&L ${fmt(a.dailyPnl)}  Open ${a.openPositions.length}`,
        `Market ${st.marketOpen ? 'OPEN' : 'closed'}  Auto ${st.autoTradingEnabled ? 'on' : 'off'}` +
          `  Agents ${st.tradingAgentsEnabled ? 'on' : 'off'}` +
          (st.tradingHalted ? `  HALTED (${st.haltReason ?? 'risk'})` : ''),
      ].join('\n');
    },
    scan: () => {
      if (!engine) return 'No active session.';
      const sigs = engine.getState().signals.slice(-5);
      if (sigs.length === 0) return 'Scan: no recent signals.';
      return ['Recent signals:', ...sigs.map(s => `  ${s.symbol} ${s.side} ${s.type} @ ${s.entryPrice.toFixed(2)}`)].join('\n');
    },
    positions: () => {
      if (!engine) return 'No active session.';
      const pos = engine.getState().account.openPositions;
      if (pos.length === 0) return 'No open positions.';
      return ['Open positions:', ...pos.map(p => `  ${p.symbol} ${p.side} x${p.quantity} @ ${p.entryPrice.toFixed(2)}`)].join('\n');
    },
    pendingRecommendations: () =>
      (engine?.getAgentRecommendations() ?? []).map(r => ({
        id: r.proposedSignal?.id ?? `agent-${r.symbol}-${r.asOf}`,
        symbol: r.symbol,
        verdict: r.verdict,
        action: r.action,
        conviction: r.conviction,
      })),
    approve: async target => {
      if (!engine) return { ok: false, message: 'No active session.' };
      const r = await engine.approveRecommendationById(target, priceFor(target.toUpperCase()) ?? priceFor(target));
      return { ok: r.ok, message: r.ok ? `APPROVED — ${r.reason}` : `Cannot approve: ${r.reason}` };
    },
    reject: target => {
      if (!engine) return { ok: false, message: 'No active session.' };
      const r = engine.rejectRecommendationById(target);
      return { ok: r.ok, message: r.ok ? `REJECTED — ${r.reason}` : `Cannot reject: ${r.reason}` };
    },
    // TRA-851 — natural-language routine management. Read is synchronous (cache);
    // mutations parse + persist through the routine store.
    listRoutines: () => listRoutinesSync(username).map(toRoutineSummary),
    addRoutine: async spec => {
      const parsed = parseRoutine(spec);
      if (!parsed.ok) return { ok: false, message: parsed.error };
      const res = await addRoutineToStore(username, parsed.routine, spec);
      if (!res.ok) return { ok: false, message: res.error };
      return { ok: true, message: `Scheduled ${res.routine.id}: ${describeRoutine(res.routine)}` };
    },
    removeRoutine: async id => {
      const removed = await removeRoutineFromStore(username, id);
      return removed
        ? { ok: true, message: `Removed routine ${id}.` }
        : { ok: false, message: `No routine "${id}".` };
    },
    setRoutineEnabled: async (id, enabled) => {
      const updated = await setRoutineEnabledInStore(username, id, enabled);
      return updated
        ? { ok: true, message: `Routine ${id} ${enabled ? 'enabled' : 'disabled'}.` }
        : { ok: false, message: `No routine "${id}".` };
    },
  };
}

// TRA-851 — flatten a stored routine for chat display.
function toRoutineSummary(r: StoredRoutine): RoutineSummary {
  return {
    id: r.id,
    action: r.action,
    timeEt: r.timeEt,
    filter: filterLabel(r.filter),
    enabled: r.enabled,
    marketDaysOnly: r.marketDaysOnly,
  };
}

// TRA-851 — one-line confirmation of an added routine, e.g.
// "scan semis @ 09:30 ET (market days)".
function describeRoutine(r: StoredRoutine): string {
  const scope = filterLabel(r.filter);
  const scopeBit = scope !== 'all' ? ` ${scope}` : '';
  const days = r.marketDaysOnly ? 'market days' : 'every day';
  return `${r.action}${scopeBit} @ ${r.timeEt} ET (${days})`;
}

// TRA-851 — run one due routine for a user and produce the message to push.
// Reuses the same read paths the chat commands use: status/positions go through
// the command context, scan filters the engine's live signals, and brief reuses
// the TRA-849 morning-brief builder + renderer. Returns null when there is no
// active session for the user (nothing to send).
async function executeRoutineForUser(
  username: string,
  routine: StoredRoutine,
): Promise<RoutineRendered | null> {
  const ctx = tryGetUserContext(username);
  if (!ctx) return null;
  const scope = filterLabel(routine.filter);
  const scopeBit = scope !== 'all' ? ` (${scope})` : '';

  switch (routine.action) {
    case 'status':
      return { title: 'Routine: status', body: buildCommandContext(username).status() };
    case 'positions':
      return { title: 'Routine: positions', body: buildCommandContext(username).positions() };
    case 'scan': {
      const signals = ctx.engine.getState().signals;
      return { title: `Routine: scan${scopeBit}`, body: formatScan(signals, routine.filter) };
    }
    case 'brief': {
      // Build a full morning brief for this user on demand and reuse the shared
      // renderer's plain-text body so the routine push matches the 8:30 brief.
      const macro = await buildMacroSection();
      const now = new Date();
      const event = buildBriefForUser(ctx, macro, etDateString(now), now.getTime());
      const rendered = renderAlert(event, now.getTime());
      return { title: 'Routine: morning brief', body: rendered.text };
    }
    default:
      return null;
  }
}

// Telegram webhook receiver — records the chat_id for a `/start <token>` deep
// link (account linking, TRA-566) AND, post-link, handles inbound conversational
// control commands (TRA-848). Unauthenticated at the transport (Telegram calls
// it) but gated by the secret token configured via setWebhook
// (`TELEGRAM_WEBHOOK_SECRET`); without it the route is closed. Command handling
// is further gated by chat-id↔user resolution (the link-token auth boundary).
app.post('/api/notifications/telegram/webhook', async (req, res) => {
  const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];
  if (!secret || req.header('x-telegram-bot-api-secret-token') !== secret) {
    res.status(403).json({ ok: false });
    return;
  }
  // Telegram always expects a 200 quickly; we never surface internal errors to it.
  try {
    const update = req.body as {
      message?: { text?: string; chat?: { id?: number | string } };
    };
    const text = update?.message?.text;
    const chatId = update?.message?.chat?.id;
    const token = parseStartCommand(text);
    if (token && chatId != null) {
      // ── Account linking (TRA-566) ──
      const username = consumeLinkToken(token);
      if (username) {
        const current = await loadSettings(username);
        const prefs = resolveAlertPreferences(current);
        prefs.channels.telegram.telegramChatId = String(chatId);
        prefs.channels.telegram.enabled = true;
        await saveSettings(username, { ...current, alertPreferences: prefs });
        log.info('telegram chat linked', { username });
        await sendTelegramReply(String(chatId), 'Linked. Send "help" for commands.');
      } else {
        log.debug('telegram link token unknown/expired');
      }
    } else if (text && chatId != null) {
      // ── Inbound conversational control (TRA-848) ──
      const cmd = parseCommand(text);
      if (cmd) {
        const username = resolveUsernameByTelegramChat(String(chatId));
        if (!username) {
          // Unlinked chat — do not act; nudge the user to link first.
          await sendTelegramReply(String(chatId), 'This chat is not linked. Use Settings → Notifications → Link to connect.');
        } else {
          const reply = await executeCommand(cmd, buildCommandContext(username));
          await sendTelegramReply(String(chatId), reply);
        }
      }
    }
  } catch (err) {
    log.warn('telegram webhook handling failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  res.json({ ok: true });
});

// TRA-852 — Discord Interactions endpoint. The Discord transport for the inbound
// conversational control shipped in TRA-848. Unauthenticated at the transport
// (Discord calls it) but every request is verified by Ed25519 signature against
// DISCORD_PUBLIC_KEY — an unsigned/forged request gets a 401 and never reaches
// the command path. Like Telegram, command handling is further gated by
// Discord-user↔app-user resolution (the link-token auth boundary) and the
// TRADING_AGENTS_LLM_DISABLED kill switch (inside the shared router).
//
// Discord expects an INTERACTION RESPONSE in the HTTP reply itself (not a
// follow-up call), so we answer synchronously: PONG to the PING handshake, and
// an ephemeral CHANNEL_MESSAGE_WITH_SOURCE carrying the reply text otherwise.
app.post('/api/notifications/discord/interactions', async (req, res) => {
  const publicKey = process.env['DISCORD_PUBLIC_KEY'];
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const ok = verifyDiscordRequest({
    publicKey,
    signature: req.header('x-signature-ed25519'),
    timestamp: req.header('x-signature-timestamp'),
    rawBody,
  });
  if (!ok) {
    res.status(401).json({ error: 'invalid request signature' });
    return;
  }

  const interaction = (req.body ?? {}) as { type?: number };
  // PING handshake — Discord probes this on URL setup and on a schedule.
  if (interaction.type === DISCORD_INTERACTION_TYPE.PING) {
    res.json({ type: DISCORD_RESPONSE_TYPE.PONG });
    return;
  }

  const reply = (text: string): void => {
    res.json({
      type: DISCORD_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: text, flags: DISCORD_EPHEMERAL_FLAG },
    });
  };

  try {
    const extracted = extractInteraction(interaction);
    if (!extracted || !extracted.userId) {
      reply('Could not read that interaction.');
      return;
    }
    const { text, userId } = extracted;

    // ── Account linking (mirror of Telegram's `/start <token>`) ──
    const token = parseDiscordLinkToken(text);
    if (token) {
      const username = consumeLinkToken(token);
      if (username) {
        const current = await loadSettings(username);
        const prefs = resolveAlertPreferences(current);
        prefs.channels.discord.discordUserId = userId;
        prefs.channels.discord.enabled = true;
        await saveSettings(username, { ...current, alertPreferences: prefs });
        log.info('discord user linked', { username });
        reply('Linked. Use /status, /scan, /positions, /brief, /approve, /reject, or /help.');
      } else {
        log.debug('discord link token unknown/expired');
        reply('That link code is invalid or expired. Generate a new one in Settings → Notifications.');
      }
      return;
    }

    // ── Inbound conversational control (TRA-848 command core) ──
    const cmd = parseCommand(text);
    if (!cmd) {
      reply('Unrecognized command. Try /help.');
      return;
    }
    const username = resolveUsernameByDiscordUser(userId);
    if (!username) {
      reply('This Discord account is not linked. Use Settings → Notifications → Link, then run /link <code>.');
      return;
    }
    const replyText = await executeCommand(cmd, buildCommandContext(username));
    reply(replyText);
  } catch (err) {
    log.warn('discord interaction handling failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    // A signed request that blew up still gets a clean ephemeral reply.
    reply('Something went wrong handling that command.');
  }
});

// Per-market scope (TRA-192): Stockdashboard and Cryptodashboard each have
// their own "Reset Demo Account" button, and resetting one must not wipe the
// other. The optional `market` body field selects which engine to reset.
// Omitting it preserves the legacy "reset both" behavior used by the global
// settings page where no market context is active.
app.post('/api/account/reset-demo', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const market = (req.body as { market?: string } | undefined)?.market;
  if (market !== undefined && market !== 'stocks' && market !== 'crypto') {
    res.status(400).json({ error: "market must be 'stocks', 'crypto', or omitted" });
    return;
  }
  if (market === undefined || market === 'stocks') {
    ctx.engine.forceReset(settings);
    broadcastEngineState(ctx);
  }
  if (market === undefined || market === 'crypto') {
    const cryptoEquity = settings.demoEquityCrypto ?? settings.demoEquity;
    ctx.cryptoEngine.forceReset(cryptoEquity);
    broadcastCryptoState(ctx);
  }
  res.json({ ok: true, market: market ?? 'both' });
});

// ── Trading controls ──────────────────────────────────────────────────────────

/**
 * TRA-323 — build a Tradier options client targeting a specific env regardless
 * of the user's current `liveTradierEnvOptions` selection. Used by the
 * "Sync Tradier positions" flow so a user can pull sandbox state in even
 * while the engine is configured for production (or vice versa). Returns
 * `null` when neither saved per-options creds nor env-var fallbacks are
 * present for the requested env; the caller should respond with a clear
 * 409 rather than silently no-op.
 */
function buildTradierOptionsClientForEnv(
  settings: AccountSettings,
  env: TradierEnv,
): TradierOptionsClient | null {
  // TRA-714: `||` (not `??`) so a BLANK saved cred ('' — the default when
  // Tradier is configured only via env vars, e.g. the AI Ideas / options-ideas
  // feed) falls through to the env-var fallback. With `??`, an empty-string
  // field short-circuits and the env fallback never runs, leaving the feed stuck
  // on "no Tradier options credentials" even when TRADIER_* env vars are set.
  // (This is the copy the /api/options/ideas route actually calls; a sibling in
  // signal-engine.ts was fixed in the same way.)
  const apiToken = (
    (env === 'production'
      ? settings.liveApiKeyOptionsProduction
      : (settings.liveApiKeyOptionsSandbox || settings.liveApiKeyOptions))
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] || process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    (env === 'production'
      ? settings.liveAccountIdOptionsProduction
      : (settings.liveAccountIdOptionsSandbox || settings.liveAccountIdOptions))
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] || process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) return null;
  return new TradierOptionsClient(apiToken, accountId, env);
}

// TRA-229 — start/stop are scoped to the dashboard's current account mode
// (demo or live) so a user can run live trading while leaving demo paused, or
// vice versa. The mode is taken from saved settings; clients can also pass an
// explicit `{ "mode": "demo" | "live" }` body to set the inactive-mode flag
// without switching modes.
function resolveTradingMode(
  body: unknown,
  current: 'demo' | 'live',
): 'demo' | 'live' {
  const requested = (body as { mode?: unknown } | undefined)?.mode;
  if (requested === 'demo' || requested === 'live') return requested;
  return current;
}

app.post('/api/trading/start', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.engine.setAutoTrading(true, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { stocksAutoTradingEnabledLive: true }
      : { stocksAutoTradingEnabledDemo: true }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: true });
});

app.post('/api/trading/stop', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.engine.setAutoTrading(false, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { stocksAutoTradingEnabledLive: false }
      : { stocksAutoTradingEnabledDemo: false }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: false });
});

// TRA-526 — global kill switch (deterministic risk-layer master override).
// Engages/releases the manual master halt across BOTH the equities/options
// engine (via DailyRiskGovernor) and the crypto engine, and persists the state
// to settings so the halt survives a server restart. While engaged, every
// new-entry path is blocked regardless of the per-mode auto-trading flags or
// daily circuit-breakers — "the AI proposes, the math disposes."
app.post('/api/trading/kill-switch', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const body = req.body as { engaged?: unknown; reason?: unknown } | undefined;
  const engaged = body?.engaged === true || body?.engaged === 'true';
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 280) : undefined;

  if (engaged) ctx.engine.engageKillSwitch(reason);
  else ctx.engine.releaseKillSwitch();
  ctx.cryptoEngine.setKillSwitch(engaged);

  const updated: AccountSettings = {
    ...settings,
    globalKillSwitchEngaged: engaged,
    ...(engaged && reason ? { globalKillSwitchReason: reason } : { globalKillSwitchReason: undefined }),
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  broadcastCryptoState(ctx);
  res.json({
    ok: true,
    killSwitchEngaged: ctx.engine.isKillSwitchEngaged(),
    haltReason: engaged ? (reason ?? null) : null,
  });
});

// TRA-895 — operator reset of the daily circuit-breaker (consecutive-loss / drawdown halt).
// Clears the intraday halt so Trading Agents can open new entries again without waiting for
// the ET midnight day-roll. Does NOT touch the kill switch. Demo-safe: no settings are mutated.
app.post('/api/trading/reset-halt', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.engine.resetDailyCircuitBreaker();
  broadcastEngineState(ctx);
  res.json({ ok: true, tradingHalted: false });
});

// TRA-544 (TRA-529 §2B) — flip the runtime "Trading Agents" master switch from
// the banner toggle. ON hands trade decisions to the advisory multi-agent layer
// and SUSPENDS the deterministic auto-router; OFF restores the deterministic
// stack. The takeover never bypasses risk: agent orders still clear the
// deterministic RiskManager hard caps and the TRA-526 kill switch overrides
// everything. Persisted to settings so the choice survives a restart, and the
// state push confirms the new value to every client (per docs/architecture.md
// §2: REST flips, the WS state confirms). P1 is advisor-only (stub, no LLM
// spend); gating mode is P4.
app.post('/api/trading/trading-agents', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const body = req.body as { enabled?: unknown } | undefined;
  const enabled = body?.enabled === true || body?.enabled === 'true';

  ctx.engine.setTradingAgents(enabled);

  const updated: AccountSettings = { ...settings, tradingAgentsEnabled: enabled };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, tradingAgentsEnabled: enabled });
});

// TRA-796 (TRA-529 P4) — flip gating mode. `enabled` lets an APPROVE
// recommendation's proposedSignal actually route as a risk-checked order
// (demo-first). `liveEnabled` is the SEPARATE board+CTO go-live flag that permits
// routing in LIVE mode; it defaults to false and stays off unless this request
// explicitly sets it, so demo gating can be turned on without ever arming live.
// Routing never bypasses risk — every agent order still clears the deterministic
// RiskManager hard caps and the TRA-526 kill switch overrides everything.
// Persisted to settings so the choice survives a restart; the state push confirms
// the new values to every client.
app.post('/api/trading/trading-agents/gating', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const body = req.body as { enabled?: unknown; liveEnabled?: unknown } | undefined;
  const enabled = body?.enabled === true || body?.enabled === 'true';
  const liveEnabled = body?.liveEnabled === true || body?.liveEnabled === 'true';

  ctx.engine.setTradingAgentsGating(enabled, liveEnabled);

  const updated: AccountSettings = {
    ...settings,
    tradingAgentsGatingEnabled: enabled,
    tradingAgentsLiveGatingEnabled: liveEnabled,
  };
  await saveSettings(username, updated);
  broadcastEngineState(ctx);
  res.json({ ok: true, tradingAgentsGatingEnabled: enabled, tradingAgentsLiveGatingEnabled: liveEnabled });
});

// TRA-941 (TRA-813 P2) — pending-proposals queue. The desktop panel (TRA-940)
// reads the queue + the live daily-cap usage from here, and confirms/rejects per
// proposal. Only a confirmed proposal routes to capital (Piece 3); rejection
// captures a required reason for the audit trail.
app.get('/api/proposals', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  res.json({
    proposals: ctx.engine.getPendingProposals(),
    caps: executionCapStatus(username),
    killSwitchEngaged: ctx.engine.isKillSwitchEngaged(),
    tradingAgentsEnabled: ctx.engine.isTradingAgentsEnabled(),
    // TRA-945 §2 — the store TTL (env-overridable) so the panel can grey out a
    // proposal nearing expiry instead of having it silently vanish at the TTL.
    proposalTtlMs: proposalTtlMs(),
  });
});

app.post('/api/proposals/:id/approve', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const proposal = ctx.engine.getPendingProposals().find(p => p.id === id);
  // Resolve the current quote for the proposal's symbol so routing sizes/fills
  // against a real price (mirrors the position-close route's price lookup).
  let price: number | undefined;
  if (proposal) {
    const sym = ctx.engine.getState().symbols.find(s => s.symbol === proposal.symbol);
    price = sym?.price;
  }
  const result = await ctx.engine.confirmProposalById(id, price);
  broadcastEngineState(ctx);
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/proposals/:id/reject', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const body = req.body as { reason?: unknown } | undefined;
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  const result = ctx.engine.rejectProposalById(id, reason);
  broadcastEngineState(ctx);
  res.status(result.ok ? 200 : 400).json(result);
});

// TRA-230: clear the displayed signal list without resetting positions or equity.
app.post('/api/signals/reset', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.engine.clearSignals();
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/positions/:id/close', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const state = ctx.engine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  ctx.engine.manualClosePosition(id, price);
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/options/:id/close', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;

  // TRA-323 / TRA-348 / TRA-352 — close path. There are three sub-paths,
  // each routed by the position's origin:
  //
  //  1. Tradier-imported (TRA-323). The local row only exists for display;
  //     the position lives on Tradier's books, not on the paper cash
  //     bucket. Closing routes a real `sell_to_close` to Tradier; on fill
  //     we record a closed-options row WITHOUT crediting paper cash. On
  //     reject we leave the row and 502. On pending we tag
  //     `pendingCloseOrderId` and 202.
  //
  //  2. Engine-opened live (TRA-221 + TRA-352). The engine opened a paper
  //     row AND fired a real `buy_to_open` on Tradier (signal-engine.ts
  //     ~line 1017). Before TRA-352, the close path here was paper-only —
  //     the Tradier long leaked. Now we mirror the close to Tradier and
  //     close the local row at the broker's actual avg fill price (so
  //     paper cash + realized P&L match the broker reality, not the local
  //     mark which can be stale on wide-spread OCCs).
  //
  //  3. Engine-opened demo (or live without Tradier creds). Pure paper —
  //     no broker call, close at the local mark like before.
  //
  // Sub-paths 1 and 2 share the smart-pricing layer in
  // `submitSmartSellToClose`: pull a fresh quote, submit limit at mid,
  // walk a quarter-step toward the bid if the first attempt doesn't fill
  // within 5s. This is the TRA-352 fix for "market sell fills at the
  // bid on wide-spread contracts" — previously a 0.05/0.17 contract
  // filled at 0.05 instead of ~0.11.
  const imported = ctx.engine.findImportedOption(id);
  if (imported) {
    // TRA-407 (C4) — pending-close double-submit guard. The desktop UI
    // already swaps the Close button for a disabled "Pending #N" badge once
    // `pendingCloseOrderId` is set, but a stale client or a double-click
    // landing before that state broadcasts round-trips can still POST a
    // second close. Refuse server-side so a single contract can never have
    // two live `sell_to_close` orders working at the broker at once.
    if (imported.position.pendingCloseOrderId !== undefined) {
      res.status(409).json({
        error: 'A close order is already in flight for this position — wait for it to fill or be reconciled before closing again.',
        pendingCloseOrderId: imported.position.pendingCloseOrderId,
      });
      return;
    }
    const settings = getSettings(username);
    const client = buildTradierOptionsClientForEnv(settings, imported.env);
    if (!client) {
      res.status(409).json({
        error: `No Tradier credentials saved for ${imported.env} — set them in Settings before closing imported positions.`,
      });
      return;
    }
    const optionSymbol = imported.position.optionSymbol;
    const contracts = imported.position.contractsRemaining;
    if (!optionSymbol || contracts <= 0) {
      res.status(409).json({ error: 'Imported position is missing OCC symbol or contracts' });
      return;
    }
    const outcome = await submitSmartSellToClose(client, optionSymbol, contracts);
    if (outcome.status === 'no_quote') {
      log.warn('tradier-import sell_to_close aborted', {
        optionSymbol,
        env: imported.env,
        reason: outcome.reason,
      });
      res.status(409).json({ error: outcome.reason });
      return;
    }
    if (outcome.status === 'rejected') {
      log.warn('tradier-import sell_to_close rejected', {
        optionSymbol,
        env: imported.env,
        reason: outcome.reason,
      });
      res.status(502).json({ error: `Tradier rejected the close: ${outcome.reason}` });
      return;
    }
    if (outcome.status === 'filled') {
      log.info('tradier-import sell_to_close filled', {
        optionSymbol,
        qty: contracts,
        env: imported.env,
        order: outcome.orderId,
        fillPrice: Number(outcome.avgFillPrice.toFixed(2)),
        limitPrice: Number(outcome.limitPrice.toFixed(2)),
      });
      ctx.engine.recordImportedOptionFill(id, outcome.avgFillPrice);
      broadcastEngineState(ctx);
      res.json({
        ok: true,
        imported: true,
        status: 'filled',
        orderId: outcome.orderId,
        fillPrice: outcome.avgFillPrice,
      });
      return;
    }
    // outcome.status === 'pending'
    log.info('tradier-import sell_to_close pending', {
      optionSymbol,
      qty: contracts,
      env: imported.env,
      order: outcome.orderId,
      limitPrice: Number(outcome.limitPrice.toFixed(2)),
    });
    ctx.engine.setPendingCloseOrderId(id, outcome.orderId);
    broadcastEngineState(ctx);
    res.status(202).json({ ok: true, imported: true, status: 'pending', orderId: outcome.orderId });
    return;
  }

  // Engine-opened path. Look up the position so we can decide whether to
  // mirror the close to Tradier (live + has creds) or stay paper-only
  // (demo, or live without creds — a rare race after the user revoked
  // their Tradier token mid-session).
  const engineOpened = ctx.engine.findEngineOpenedOption(id);
  if (!engineOpened) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  // TRA-598 (C3) — no-day-trading guardrail: refuse a voluntary same-session
  // round trip on an AI/engine-opened position. Risk-driven auto-exits don't go
  // through this route, so a losing position still auto-exits at its stop; this
  // only blocks the user from manually closing a position they opened today.
  const dayTradeGuard = ctx.engine.checkOptionDayTradingClose(id);
  if (!dayTradeGuard.allowed) {
    log.info('option close blocked by no-day-trading guardrail', {
      optionId: id,
      reason: dayTradeGuard.reason,
    });
    res.status(409).json({ error: dayTradeGuard.reason });
    return;
  }
  const liveMirror = engineOpened.position.mode === 'live';
  if (liveMirror) {
    // TRA-358 — user-driven LIMIT close on engine-opened live positions.
    // The body carries the price + qty + duration the user picked in the
    // Close drawer (mirrors Tradier's web close panel). The smart-walk
    // path (TRA-352) is intentionally retired for engine-opened live
    // closes: the user is choosing the price themselves, and we don't
    // want to overwrite that with a midpoint walk. Demo and imported
    // paths are unaffected.
    if (engineOpened.position.pendingExit) {
      res.status(409).json({
        error: 'A close order is already in flight for this position. Cancel it first if you want to re-stage.',
      });
      return;
    }
    const body = (req.body ?? {}) as {
      limitPrice?: unknown;
      qty?: unknown;
      duration?: unknown;
    };
    const limitPrice = Number(body.limitPrice);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      res.status(400).json({
        error: 'limitPrice (per-share, > 0) is required for a live engine-opened close.',
      });
      return;
    }
    const requestedQty = body.qty === undefined ? engineOpened.position.contractsRemaining : Number(body.qty);
    if (!Number.isFinite(requestedQty) || requestedQty <= 0 || requestedQty > engineOpened.position.contractsRemaining) {
      res.status(400).json({
        error: `qty must be between 1 and ${engineOpened.position.contractsRemaining}.`,
      });
      return;
    }
    const durationCandidate = typeof body.duration === 'string' ? body.duration : 'day';
    const duration = (durationCandidate === 'day' || durationCandidate === 'gtc' || durationCandidate === 'pre' || durationCandidate === 'post')
      ? durationCandidate
      : 'day';

    const outcome = await ctx.engine.submitManualOptionClose(id, requestedQty, limitPrice, duration);
    if (outcome.status === 'no_client') {
      // No Tradier creds for this env, but the position was opened in live
      // mode (so a real long likely exists on Tradier). Refuse rather
      // than close paper-only and leave the broker leg leaking — that's
      // the exact failure mode TRA-352 was filed to prevent.
      res.status(409).json({
        error: `No Tradier credentials saved for ${outcome.env} — set them in Settings before closing live option positions.`,
      });
      return;
    }
    if (outcome.status === 'not_found') {
      res.status(409).json({ error: outcome.reason });
      return;
    }
    if (outcome.status === 'rejected') {
      res.status(502).json({ error: `Tradier rejected the close: ${outcome.reason}`, ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}) });
      broadcastEngineState(ctx);
      return;
    }
    if (outcome.status === 'filled') {
      broadcastEngineState(ctx);
      res.json({
        ok: true,
        status: 'filled',
        orderId: outcome.orderId,
        fillPrice: outcome.fillPrice,
      });
      return;
    }
    // outcome.status === 'pending' — Tradier accepted the limit but didn't
    // fill within the wait window. Leave the local row so the user sees
    // the position still open with the pendingExit badge; the engine's
    // per-tick `resolvePendingOptionExits` poller will finalise / clear
    // when Tradier moves.
    broadcastEngineState(ctx);
    res.status(202).json({ ok: true, status: 'pending', orderId: outcome.orderId });
    return;
  }

  // Demo (or live-without-creds, which we already refused above for safety).
  // Pure paper close — credit the paper bucket at the local mark.
  const closed = ctx.engine.manualCloseOption(id);
  if (!closed) {
    res.status(404).json({ error: 'Option position not found' });
    return;
  }
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

/**
 * TRA-358 — cancel an in-flight user-staged Tradier `sell_to_close` LIMIT.
 * Hits Tradier's `cancelOrder` for the staged order id, then clears the
 * paper book's `pendingExit` so the row re-renders the Close drawer. Only
 * applies to engine-opened positions whose `pendingExit.kind === 'manual'`
 * (or any pendingExit, since the user already sees a "Pending" badge for
 * engine-fired exits and may want to cancel those too).
 */
app.post('/api/options/:id/cancel-pending-exit', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const outcome = await ctx.engine.cancelManualPendingExit(id);
  if (outcome.status === 'cancelled') {
    broadcastEngineState(ctx);
    res.json({ ok: true, ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}) });
    return;
  }
  if (outcome.status === 'not_pending') {
    res.status(409).json({ error: 'No pending close to cancel for this position.' });
    return;
  }
  if (outcome.status === 'not_found') {
    res.status(404).json({ error: 'Option position not found.' });
    return;
  }
  if (outcome.status === 'no_client') {
    res.status(409).json({
      error: `No Tradier credentials saved for ${outcome.env} — set them in Settings before cancelling.`,
    });
    return;
  }
  res.status(502).json({ error: `Tradier cancel failed: ${outcome.reason}`, ...(outcome.orderId !== undefined ? { orderId: outcome.orderId } : {}) });
});

/**
 * TRA-323 — sync open option positions from Tradier into the local options
 * store so the user can manage them from TradeAI's Open Options view. Used
 * primarily for Sandbox (where the user opens positions on Tradier's web UI
 * and wants to close them through TradeAI), but the same flow works in
 * production. The env defaults to whichever the user has selected for
 * options live mode (`liveTradierEnvOptions`); a `?env=...` query param
 * lets the UI override it explicitly.
 *
 * Returns a count summary so the caller can render "synced N positions"
 * feedback. Failures pre-empt with a clear error rather than silently
 * leaving an empty list — the UI distinguishes "no creds" from "broker
 * returned no positions" from "we hit a network error".
 */
app.post('/api/tradier/positions/sync', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const envParam = typeof req.query['env'] === 'string' ? req.query['env'] : undefined;
  const env: TradierEnv =
    envParam === 'production' || envParam === 'sandbox'
      ? envParam
      : (settings.liveTradierEnvOptions ?? 'sandbox');

  const client = buildTradierOptionsClientForEnv(settings, env);
  if (!client) {
    res.status(409).json({
      error: `No Tradier credentials saved for ${env} — set them in Settings before syncing.`,
    });
    return;
  }

  let positions;
  try {
    positions = await client.listOpenOptionPositions();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('tradier-import list positions failed', { env, reason: message });
    res.status(502).json({ error: `Tradier list-positions failed: ${message}` });
    return;
  }

  // TRA-323 — imported rows are stamped with the position's mode so the
  // dashboard's mode-scoped views can find them. We attribute them to
  // 'live' since that's where Tradier-mirrored activity belongs; the demo
  // dashboard never owns Tradier positions.
  const summary = ctx.engine.reconcileTradierPositions(env, positions, 'live');
  broadcastEngineState(ctx);
  res.json({ ok: true, env, ...summary });
});

/**
 * TRA-503 — manual Tradier equity-position sync, matching the option sync
 * above. The signal engine already runs `reconcileLiveEquityPortfolio` on a
 * cadence (TRA-415); this endpoint forces an immediate sweep so the user can
 * pull out-of-band equity opens into the Positions tab on demand. Uses the
 * engine's already-configured live equity client (driven by saved Tradier
 * settings), so no env override is needed.
 *
 * Returns the same `{ added, updated, removed, total }` shape as the option
 * sync so the UI feedback line can be written once. `skipped` is folded into
 * an HTTP error for the no-creds / wrong-mode cases.
 */
app.post('/api/tradier/equity-positions/sync', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  const result = await ctx.engine.reconcileLiveEquityPortfolio({ force: true });
  if (result.skipped === 'mode') {
    res.status(409).json({ error: 'Equity sync requires Live mode.' });
    return;
  }
  if (result.skipped === 'no-client') {
    res.status(409).json({
      error: 'No Tradier credentials saved — set them in Settings before syncing equity positions.',
    });
    return;
  }
  broadcastEngineState(ctx);
  res.json({
    ok: true,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    total: result.total,
  });
});

/**
 * Smoke-test Coinbase live credentials without placing any orders.
 *
 * Pulls the user's saved API key/secret (env-var fallback identical to
 * crypto-engine.buildLiveBroker), instantiates a CoinbaseOrderClient, then
 * issues a single authenticated GET against /api/v3/brokerage/accounts.
 *
 * The response always returns 200 with an `ok` flag; the UI only needs to
 * inspect the body. `authScheme` lets the user confirm a PEM secret was
 * recognised as CDP rather than silently treated as HMAC.
 */
app.post('/api/crypto/coinbase/test-connection', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  // Same precedence as crypto-engine.buildLiveBroker: per-market crypto
  // credentials (TRA-165) → legacy un-suffixed fields → env vars.
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || process.env['COINBASE_API_KEY']
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || process.env['COINBASE_API_SECRET']
    || ''
  ).trim();
  if (!apiKey || !apiSecret) {
    res.json({ ok: false, error: 'Coinbase API key and secret are not configured. Save them in Settings before testing.' });
    return;
  }
  let client: CoinbaseOrderClient;
  try {
    client = new CoinbaseOrderClient({ apiKey, apiSecret });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const authScheme = client.getAuthScheme();
  try {
    const accounts = await client.listAccounts();
    const currencies = Array.from(new Set(accounts.map(a => a.currency))).sort();
    res.json({ ok: true, authScheme, accountCount: accounts.length, currencies });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, authScheme, error: message });
  }
});

/**
 * Place a deliberately tiny market BUY against Coinbase Advanced Trade so the
 * user can verify their funded live account end-to-end (TRA-222) before
 * flipping auto-trading on. Reuses the same credential precedence as
 * /test-connection. The order is NOT registered with the engine — it's a
 * one-shot smoke test, the resulting crypto sits in the user's Coinbase
 * wallet exactly like a manual buy.
 *
 * Hard caps: $5 USD max quote size and BUY only. We refuse to do this in demo
 * mode so a misclick can't waste real money on a user who hasn't switched
 * over yet.
 */
app.post('/api/crypto/coinbase/place-test-order', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  if (settings.mode !== 'live') {
    res.json({ ok: false, error: 'Account is in demo mode. Switch to Live before placing a test order.' });
    return;
  }
  const body = (req.body ?? {}) as { productId?: string; quoteSize?: number };
  const productId = (body.productId ?? 'BTC-USD').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}-USD[CT]?$/.test(productId)) {
    res.json({ ok: false, error: `Invalid productId "${productId}". Expected e.g. BTC-USD.` });
    return;
  }
  const quoteSize = Number(body.quoteSize ?? 1);
  if (!Number.isFinite(quoteSize) || quoteSize <= 0) {
    res.json({ ok: false, error: 'quoteSize must be a positive number (USD).' });
    return;
  }
  if (quoteSize > 5) {
    res.json({ ok: false, error: 'Test order capped at $5 USD. Reduce quoteSize.' });
    return;
  }
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || process.env['COINBASE_API_KEY']
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || process.env['COINBASE_API_SECRET']
    || ''
  ).trim();
  if (!apiKey || !apiSecret) {
    res.json({ ok: false, error: 'Coinbase API key and secret are not configured. Save them in Settings before testing.' });
    return;
  }
  let client: CoinbaseOrderClient;
  try {
    client = new CoinbaseOrderClient({ apiKey, apiSecret });
  } catch (err: unknown) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const authScheme = client.getAuthScheme();
  let orderId: string;
  try {
    const placed = await client.placeMarketOrder({ productId, side: 'buy', quoteSize });
    orderId = placed.order_id;
  } catch (err: unknown) {
    res.json({ ok: false, authScheme, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Best-effort fill reconciliation — same backoff schedule as
  // CryptoLiveAccount.awaitFill so a typical fill returns rich detail without
  // dragging the request out indefinitely.
  const delays = [200, 400, 800, 1500, 2000];
  let fillPrice: number | undefined;
  let fillSize: number | undefined;
  let status = 'unknown';
  for (const d of delays) {
    await new Promise(r => setTimeout(r, d));
    try {
      const order = await client.getOrder(orderId);
      status = (order.status ?? 'unknown').toUpperCase();
      if (status === 'FILLED') {
        const p = parseFloat(order.average_filled_price);
        const s = parseFloat(order.filled_size);
        if (Number.isFinite(p) && p > 0) fillPrice = p;
        if (Number.isFinite(s) && s > 0) fillSize = s;
        break;
      }
      if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'FAILED') break;
    } catch {
      // Order was already accepted by Coinbase — keep polling.
    }
  }
  res.json({
    ok: true,
    authScheme,
    orderId,
    productId,
    quoteSize,
    status,
    fillPrice,
    fillSize,
  });
});

/**
 * Smoke-test Tradier live credentials without placing any orders (TRA-221).
 *
 * Reads the user's saved options API token, account ID, and environment from
 * AccountSettings and issues an authenticated GET against
 * `/v1/user/profile`. Tradier returns the account list scoped to the token,
 * so we can confirm the supplied accountId is reachable. Falls back to env
 * vars only if the user explicitly left the per-options fields blank — a hint
 * that the saved RV-scanner creds should also work for live trading.
 */
app.post('/api/options/tradier/test-connection', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const settings = getSettings(username);
  // TRA-506 — caller can pin the env explicitly via body / query so the
  // Settings page can render two buttons ("Test sandbox", "Test production")
  // that probe the saved pair for that env regardless of the currently
  // selected `liveTradierEnvOptions`. Falls back to the saved env when the
  // caller omits the parameter so the pre-506 single-button flow still works.
  const requestedEnv = ((): TradierEnv | null => {
    const fromBody = (req.body as { env?: unknown } | undefined)?.env;
    const fromQuery = req.query['env'];
    const raw = (typeof fromBody === 'string' ? fromBody : typeof fromQuery === 'string' ? fromQuery : '').trim();
    if (raw === 'production' || raw === 'sandbox') return raw;
    return null;
  })();
  // TRA-226 — sandbox/production credentials are stored on separate fields so
  // the resolver only returns the pair matching the currently selected env.
  // Env-var fallback is layered on top here so a deployment that bootstrapped
  // creds via env (TRADIER_*) still works without forcing every user to retype
  // them in Settings.
  const resolved = resolveTradierOptionsCreds(settings);
  const env: TradierEnv = requestedEnv ?? resolved.env;
  // TRA-506 — when the caller pinned an env different from the saved one, the
  // resolver's apiToken/accountId belong to the OTHER env. Read the env-pinned
  // fields directly off settings instead so "Test production" probes the
  // production pair even while the saved env is sandbox (and vice versa).
  const credsForEnv = ((): { apiToken: string; accountId: string } => {
    if (env === resolved.env) {
      return { apiToken: resolved.apiToken, accountId: resolved.accountId };
    }
    if (env === 'production') {
      return {
        apiToken: (settings.liveApiKeyOptionsProduction ?? '').trim(),
        accountId: (settings.liveAccountIdOptionsProduction ?? '').trim(),
      };
    }
    return {
      apiToken: (settings.liveApiKeyOptionsSandbox ?? settings.liveApiKeyOptions ?? '').trim(),
      accountId: (settings.liveAccountIdOptionsSandbox ?? settings.liveAccountIdOptions ?? '').trim(),
    };
  })();
  const apiToken = (
    credsForEnv.apiToken
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    credsForEnv.accountId
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) {
    res.json({
      ok: false,
      env,
      error: `Tradier ${env} API token and Account ID are not configured. Save them in Settings before testing.`,
    });
    return;
  }
  try {
    const profileResp = await fetch(`${tradierBaseUrl(env)}/user/profile`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
    });
    if (!profileResp.ok) {
      const text = await profileResp.text().catch(() => '');
      res.json({ ok: false, env, error: `Tradier ${profileResp.status} — ${text || profileResp.statusText}` });
      return;
    }
    const data = (await profileResp.json()) as {
      profile?: {
        account?:
          | { account_number?: string; status?: string; classification?: string; type?: string }
          | { account_number?: string; status?: string; classification?: string; type?: string }[];
      };
    };
    const accountsRaw = data.profile?.account;
    const accounts = Array.isArray(accountsRaw) ? accountsRaw : accountsRaw ? [accountsRaw] : [];
    const matched = accounts.find(a => a.account_number === accountId);
    if (!matched) {
      const known = accounts.map(a => a.account_number).filter(Boolean).join(', ') || 'none';
      res.json({
        ok: false,
        env,
        error: `Token authenticated but Account ID ${accountId} not found on this Tradier profile (known: ${known}).`,
      });
      return;
    }
    // TRA-506 — surface buying power so the user sees a concrete signal that
    // the production credentials actually map to the funded account they
    // think they're trading against (e.g. "Production OK, $550.00"). Fetched
    // best-effort: a failed `/balances` call does not flip the connection
    // probe to `ok: false` because the profile lookup already proved the
    // creds work.
    let buyingPower: number | null = null;
    try {
      const client = new TradierOptionsClient(apiToken, accountId, env);
      const balance = await client.getAccountBalance();
      if (balance) {
        buyingPower =
          balance.optionBuyingPower
          ?? balance.stockBuyingPower
          ?? (Number.isFinite(balance.totalCash) ? balance.totalCash : null);
      }
    } catch (err: unknown) {
      log.warn('TRA-506 tradier test-connection: balance fetch failed', {
        env,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    res.json({
      ok: true,
      env,
      accountNumber: matched.account_number,
      status: matched.status,
      classification: matched.classification,
      buyingPower,
    });
  } catch (err: unknown) {
    res.json({ ok: false, env, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/crypto/trading/start', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { cryptoAutoTradingEnabledLive: true }
      : { cryptoAutoTradingEnabledDemo: true }),
  };
  // TRA-575 — enabling LIVE crypto auto-trading is the real trigger for the
  // TRA-532 promotion gate. Now that `cryptoAutoTradingEnabledLive` defaults OFF,
  // this endpoint (not the global mode flip) is the path a user takes to turn it
  // on — so it must enforce the same gate as PUT /api/account/settings, otherwise
  // it would be an ungated bypass. Demo starts are never gated; only a result that
  // runs live crypto auto-trading. Fail CLOSED if the gate can't be evaluated.
  if (mode === 'live') {
    try {
      const gate = await evaluateLiveTransitionGate(username, updated);
      if (!gate.allowed) {
        log.warn('TRA-575 refused live crypto start — promotion gate', {
          username,
          blocked: gate.blocked.map(b => b.strategyId),
        });
        res.status(422).json({
          ok: false,
          code: 'promotion_gate_blocked',
          error:
            'Live crypto auto-trading is blocked by the promotion gate: '
            + gate.blocked.map(b => `${b.strategyId} — ${b.reasons.join(' | ')}`).join(' ;; '),
          blocked: gate.blocked,
        });
        return;
      }
    } catch (err: unknown) {
      log.error('TRA-575 crypto-start promotion gate evaluation failed', {
        username,
        reason: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        ok: false,
        code: 'promotion_gate_error',
        error: 'Could not verify the live-trading promotion gate. Live crypto start refused; please retry.',
      });
      return;
    }
  }
  ctx.cryptoEngine.setAutoTrading(true, mode);
  await saveSettings(username, updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: true });
});

app.post('/api/crypto/trading/stop', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const settings = getSettings(username);
  const mode = resolveTradingMode(req.body, settings.mode);
  ctx.cryptoEngine.setAutoTrading(false, mode);
  const updated: AccountSettings = {
    ...settings,
    ...(mode === 'live'
      ? { cryptoAutoTradingEnabledLive: false }
      : { cryptoAutoTradingEnabledDemo: false }),
  };
  await saveSettings(username, updated);
  broadcastCryptoState(ctx);
  res.json({ ok: true, mode, autoTradingEnabled: false });
});

// ── Watchlist management ──────────────────────────────────────────────────────

app.get('/api/watchlist/crypto', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  await initWatchlistStore(username);
  res.json(getCryptoWatchlistData(username));
});

app.post('/api/watchlist/crypto', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z]{2,10}-USD$/.test(sym)) {
    res.status(400).json({ error: 'Invalid symbol format. Expected XXX-USD (e.g. ETH-USD)' });
    return;
  }
  await addCryptoSymbol(username, sym);
  ctx.cryptoEngine.addSymbol(sym);
  ctx.cryptoEngine.refresh();
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/crypto/:symbol', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeCryptoSymbol(username, sym);
  ctx.cryptoEngine.removeSymbol(sym);
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

app.post('/api/watchlist/crypto/scan', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  try {
    const results = await scanCryptoMarket();
    for (const r of results) {
      await addCryptoSymbol(username, r.symbol);
      ctx.cryptoEngine.addSymbol(r.symbol);
    }
    ctx.cryptoEngine.refresh();
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/watchlist/stocks', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  await initWatchlistStore(username);
  res.json(getStocksWatchlistData(username));
});

app.post('/api/watchlist/stocks', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const { symbol } = req.body as { symbol?: string };
  if (typeof symbol !== 'string' || !symbol.trim()) {
    res.status(400).json({ error: 'symbol is required' });
    return;
  }
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) {
    res.status(400).json({ error: 'Invalid symbol format. Expected 1–5 letters (e.g. NVDA)' });
    return;
  }
  await addStocksSymbol(username, sym);
  ctx.engine.addSymbol(sym);
  ctx.engine.refresh();
  res.json({ ok: true, symbol: sym });
});

app.delete('/api/watchlist/stocks/:symbol', requireAuth, async (req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  const raw = req.params['symbol'];
  const sym = (Array.isArray(raw) ? raw[0] : raw ?? '').toUpperCase();
  if (!sym) { res.status(400).json({ error: 'symbol is required' }); return; }
  await removeStocksSymbol(username, sym);
  ctx.engine.removeSymbol(sym);
  broadcastEngineState(ctx);
  res.json({ ok: true });
});

app.post('/api/watchlist/stocks/scan', requireAuth, async (_req, res) => {
  const username = res.locals['authUser'] as string;
  const ctx = await userCtx(res);
  try {
    const results = await scanStocksMarket();
    for (const r of results) {
      await addStocksSymbol(username, r.symbol);
      ctx.engine.addSymbol(r.symbol);
    }
    ctx.engine.refresh();
    res.json({ ok: true, added: results.map(r => r.symbol) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// TRA-230: clear the displayed crypto signal list without resetting positions or equity.
app.post('/api/crypto/signals/reset', requireAuth, async (_req, res) => {
  const ctx = await userCtx(res);
  ctx.cryptoEngine.clearSignals();
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

app.post('/api/crypto/positions/:id/close', requireAuth, async (req, res) => {
  const ctx = await userCtx(res);
  const { id } = req.params as Record<string, string>;
  const state = ctx.cryptoEngine.getState();
  const pos = state.account.openPositions.find(p => p.id === id);
  if (!pos) {
    res.status(404).json({ error: 'Position not found' });
    return;
  }
  const sym = state.symbols.find(s => s.symbol === pos.symbol);
  const price = sym?.price ?? pos.entryPrice;
  // TRA-320 — await the broker close so a Coinbase reject (auth,
  // INSUFFICIENT_FUND, product not tradable) surfaces back to the dashboard
  // instead of being swallowed by a fire-and-forget. On failure the position
  // stays open in the broker mirror and the dashboard's next state tick will
  // continue to show it; we just need to tell the user *why* the close did
  // not go through.
  try {
    await ctx.cryptoEngine.manualClosePosition(id, price);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn('crypto-engine manualClose live failed', { reason });
    broadcastCryptoState(ctx);
    res.status(502).json({ error: 'Coinbase rejected close', reason });
    return;
  }
  broadcastCryptoState(ctx);
  res.json({ ok: true });
});

// ── Data-source health check ─────────────────────────────────────────────────

// TRA-708 — `/api/health/quotes` was a self-inflicted production DoS. It runs
// eight network probes (incl. the Coinbase Exchange leg that Render's egress IP
// is blocked from, which hangs to its full timeout, plus the heavy minute-bar
// and daily-bar candle cascades). Each call could tie the work up for 30-60s,
// and nothing de-duplicated concurrent calls. Under RTH sampling (TRA-707) the
// heavy builds piled up on the single web process, which then flapped 502s on
// EVERY route and got restarted — the ~14:00Z 2026-06-08 "service outage". Fix:
//   • single-flight  → N concurrent samplers share ONE in-flight build, so the
//     work can never pile up no matter how often the endpoint is hit;
//   • short TTL cache → repeated samples reuse the last snapshot for free;
//   • overall build timeout → a slow build returns the last good (stale)
//     snapshot instead of holding the request open, and the lone in-flight
//     build keeps running in the background until it settles (still capped to
//     one at a time by single-flight).
const QUOTES_HEALTH_TTL_MS = 20_000;
const QUOTES_HEALTH_BUILD_TIMEOUT_MS = 9_000;
let quotesHealthCache: { ts: number; payload: Record<string, unknown> } | null = null;
let quotesHealthInFlight: Promise<Record<string, unknown>> | null = null;

// TRA-708 — hard per-probe timeout. Without it the build's slowest legs (the
// IP-blocked Coinbase Exchange host, the minute-bar/daily-bar candle cascades)
// keep the single in-flight build running for 30-60s; even one such build is
// enough to briefly load the web process and 502 other routes. Capping each
// probe means the whole (parallel) build settles in a few seconds. The losing
// race branch is swallowed so a late rejection from the orphaned upstream call
// can't surface as an unhandled rejection after the timeout already won.
const QUOTES_PROBE_TIMEOUT_MS = 4_500;
async function runQuotesProbe(fn: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.resolve()
    .then(fn)
    .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
  try {
    return await Promise.race<unknown>([
      guarded,
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve({ error: `timeout after ${QUOTES_PROBE_TIMEOUT_MS}ms` }), QUOTES_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app.get('/api/health/quotes', async (_req, res) => {
  const now = Date.now();
  if (quotesHealthCache && now - quotesHealthCache.ts < QUOTES_HEALTH_TTL_MS) {
    const p = quotesHealthCache.payload;
    // TRA-783 — a diagnostics endpoint that produced a payload returns HTTP 200;
    // per-component health (ok/stocksOk/cryptoOk) lives in the body. A crypto-egress
    // timeout (Coinbase IP-blocked on Render) must not page stock-only monitors.
    res.status(200).json({ ...p, cached: true });
    return;
  }
  if (!quotesHealthInFlight) {
    quotesHealthInFlight = buildQuotesHealthPayload()
      .then((payload) => {
        quotesHealthCache = { ts: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        quotesHealthInFlight = null;
      });
  }
  try {
    const payload = await Promise.race<Record<string, unknown> | null>([
      quotesHealthInFlight,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), QUOTES_HEALTH_BUILD_TIMEOUT_MS)),
    ]);
    if (payload) {
      // TRA-783 — payload built successfully: HTTP 200, component flags in the body.
      res.status(200).json(payload);
      return;
    }
    // Build is taking too long — serve the last good snapshot rather than hold
    // the request (and the proxy) open. The in-flight build still completes and
    // refreshes the cache for the next caller.
    if (quotesHealthCache) {
      const p = quotesHealthCache.payload;
      // TRA-783 — stale snapshot is still a produced payload: HTTP 200.
      res.status(200).json({ ...p, stale: true, note: 'probe build in progress' });
      return;
    }
    // No payload at all yet — could not assess. Keep 503 for the "still building" case.
    res.status(503).json({ ok: false, building: true, ts: new Date().toISOString() });
  } catch (err: unknown) {
    if (quotesHealthCache) {
      const p = quotesHealthCache.payload;
      // TRA-783 — we still have a produced payload to serve: HTTP 200, error in body.
      res.status(200).json({ ...p, stale: true, buildError: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Hard build error with no payload at all — could not assess: keep 502.
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err), ts: new Date().toISOString() });
  }
});

async function buildQuotesHealthPayload(): Promise<Record<string, unknown>> {
  const {
    testYahooFinance,
    testYahooChartQuote,
    testTradier,
    testTwelveData,
    isYahooBreakerOpen,
    isTradierBreakerOpen,
    isTradierStocksConfigured,
    fetchMinuteBarsWithSource,
    getFallbackRequestCounts,
    getTwelveDataQuotaState,
    getTradierQuoteRateState,
    getTradierBarPullRateState,
  } = await import('./yahoo-feed.js');
  const {
    testCoinMarketCap,
    testCoinbase,
    testCoinbaseAdvancedTrade,
    testCoinGecko,
    isCoinbaseBreakerOpen,
    getCoinbaseBarPullRateState,
    fetchCryptoDailyBars,
  } = await import('./crypto-feed.js');
  const results: Record<string, unknown> = {};

  // TRA-708 — run every probe in PARALLEL, each under `runQuotesProbe`'s hard
  // timeout, so the whole build settles in a few seconds instead of the sum of
  // eight serial network calls. Probe semantics are unchanged:
  //   • tradier / twelveData / coinMarketCap keep their "skipped" fallback when
  //     unconfigured (null result);
  //   • coinbase (TRA-331 Exchange) + coinbaseAdvancedTrade (TRA-705 the real
  //     Render-resolvable primary) + yahooFinance are probed as-is;
  //   • chartFallback (TRA-191 minute-bar path) and cryptoDailyBars (TRA-705
  //     daily OHLC candle cascade) preserve their full diagnostic shapes.
  const [
    tradier, coinbase, coinbaseAdvancedTrade, coinGecko, yahooFinance, yahooChartQuote, twelveData,
    coinMarketCap, chartFallback, cryptoDailyBars,
  ] = await Promise.all([
    runQuotesProbe(async () => (await testTradier()) ?? { skipped: 'TRADIER_*_API_TOKEN not set' }),
    runQuotesProbe(() => testCoinbase()),
    runQuotesProbe(() => testCoinbaseAdvancedTrade()),
    runQuotesProbe(() => testCoinGecko()),
    runQuotesProbe(() => testYahooFinance()),
    runQuotesProbe(() => testYahooChartQuote()),
    runQuotesProbe(async () => (await testTwelveData()) ?? { skipped: 'TWELVE_DATA_API_KEY not set' }),
    runQuotesProbe(async () => (await testCoinMarketCap()) ?? { skipped: 'CMC_API_KEY not set' }),
    runQuotesProbe(async () => {
      const probe = await fetchMinuteBarsWithSource('AAPL', 60);
      return {
        symbol: 'AAPL',
        bars: probe.bars.length,
        source: probe.source,
        yahooSkipped: probe.yahooSkipped,
        cached: probe.cached ?? false,
        tradierDiag: probe.tradierDiag ?? null,
        twelveDataDiag: probe.twelveDataDiag ?? null,
      };
    }),
    runQuotesProbe(async () => {
      const dailyBars = await fetchCryptoDailyBars('BTC-USD', 60);
      return {
        symbol: 'BTC-USD',
        bars: dailyBars.length,
        lastClose: dailyBars.at(-1)?.close ?? null,
      };
    }),
  ]);
  results['tradier'] = tradier;
  results['coinbase'] = coinbase;
  results['coinbaseAdvancedTrade'] = coinbaseAdvancedTrade;
  results['coinGecko'] = coinGecko;
  results['yahooFinance'] = yahooFinance;
  results['yahooChartQuote'] = yahooChartQuote;
  results['twelveData'] = twelveData;
  results['coinMarketCap'] = coinMarketCap;
  results['chartFallback'] = chartFallback;
  results['cryptoDailyBars'] = cryptoDailyBars;

  // Daily request counters per provider. Resets at UTC midnight.
  try { results['fallbackRequestsToday'] = getFallbackRequestCounts(); }
  catch (err) { results['fallbackRequestsToday'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-552 — rolling Tradier quote requests/min + quote-cache state. Tradier is
  // the sole stock-quote source, so this is the headroom gauge against its
  // production rolling-window quota: a high `requestsLastMin` with few
  // `cachedSymbols` means coalescing isn't engaging and quotes are at risk of
  // re-breaking.
  try { results['tradierQuoteRate'] = getTradierQuoteRateState(); }
  catch (err) { results['tradierQuoteRate'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-739 — restart-resilient rolling Tradier bar-pull req/min (minute + daily
  // timesales), the companion to `tradierQuoteRate`. Tradier's quota is
  // account-wide, so total load is this plus the quote rate; this is the gauge the
  // TRA-554 sampler should sum, since `fallbackRequestsToday` (cumulative, resets
  // on restart) can't be differenced for a rate.
  try { results['tradierBarPullRate'] = getTradierBarPullRateState(); }
  catch (err) { results['tradierBarPullRate'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-1059 — rolling Coinbase request rate (req/min, 60s window) per host. The
  // crypto candle cascade (cold-start daily warmer + steady-state tick loop) hits
  // the Exchange host first and falls back to keyless Advanced Trade, so the load
  // spans both pacers; `requestsLastMin` is the combined total that must stay
  // under the ~200/min per-IP ceiling. Companion to the coarse `coinbaseBreakerOpen`
  // bool below — makes the cold-start-prefetch soak's criterion-2 directly
  // measurable instead of Render-log-only.
  try { results['coinbaseBarPullRate'] = getCoinbaseBarPullRateState(); }
  catch (err) { results['coinbaseBarPullRate'] = { error: err instanceof Error ? err.message : String(err) }; }

  // TRA-439 — Twelve Data quota guard: how much of the daily budget is spent
  // and whether the credit/rate-limit breaker is open. Lets QA confirm a
  // single provider can no longer blow its free-tier cap.
  try { results['twelveDataQuota'] = getTwelveDataQuotaState(); }
  catch (err) { results['twelveDataQuota'] = { error: err instanceof Error ? err.message : String(err) }; }

  const ok = (key: string) => {
    const v = results[key];
    return v && typeof v === 'object' && !('error' in (v as object)) && !('skipped' in (v as object));
  };
  // TRA-705 — a `cryptoDailyBars` result with bars > 0 means the OHLC candle
  // pipeline is operational: the engine can evaluate strategies and generate
  // signals. Quote probes (`coinbase`, `coinbaseAdvancedTrade`, `yahooFinance`,
  // `coinMarketCap`) are for watchlist display; the strategy layer runs on
  // candles, not spot quotes. So `cryptoOk` is true if either the spot-quote
  // path OR the candle path is live. On Render the AT candle endpoint
  // (`market/products/{id}/candles`) resolves while the AT quote endpoint
  // (`market/products`) does not — this gate ensures the gauge reports the
  // truth (engine can trade) rather than a false outage (quote endpoint down).
  const dailyBarsResult = results['cryptoDailyBars'] as { bars?: number } | undefined;
  const dailyBarsOk = typeof dailyBarsResult?.bars === 'number' && dailyBarsResult.bars > 0;
  // TRA-1035 — `yahooChartQuote` is the keyless chart-endpoint quote path. It
  // counts toward `stocksOk` because the equity engine prices the universe
  // through the same `fetchQuote`/`fetchQuotes` cascade (tradier → yahoo quote →
  // yahoo chart → stooq): when only the Yahoo *quote* endpoint is crumb-broken,
  // the chart path still serves live prices, so the gauge must report stocks as
  // up rather than a false outage.
  const stocksOk = ok('tradier') || ok('yahooFinance') || ok('yahooChartQuote');
  // TRA-331 / TRA-705 — Coinbase is primary for crypto; YF/CMC are fallbacks
  // only. `coinbaseAdvancedTrade` (keyless `api.coinbase.com`) is the engine's
  // real primary and the one source that resolves from the Render egress IP, so
  // it must count toward `cryptoOk` — otherwise the gauge reports a crypto
  // outage while the engine is happily pricing the universe through it.
  const cryptoOk =
    dailyBarsOk ||
    ok('coinbaseAdvancedTrade') || ok('coinbase') || ok('coinGecko') ||
    ok('yahooFinance') || ok('coinMarketCap');
  const allOk = stocksOk && cryptoOk;
  // TRA-572 diagnostic: report which boot-time env vars the process sees (boolean
  // presence only — no secret values). Lets ops confirm whether Render is actually
  // injecting the credentials before each new process starts.
  const bootEnv = {
    TRADIER_ENV: process.env['TRADIER_ENV'] ?? '(unset — defaults to sandbox)',
    TRADIER_API_TOKEN_set: !!process.env['TRADIER_API_TOKEN'],
    TRADIER_SANDBOX_API_TOKEN_set: !!process.env['TRADIER_SANDBOX_API_TOKEN'],
    TRADIER_ACCOUNT_ID_set: !!process.env['TRADIER_ACCOUNT_ID'],
    TRADIER_SANDBOX_ACCOUNT_ID_set: !!process.env['TRADIER_SANDBOX_ACCOUNT_ID'],
  };
  return {
    ok: allOk,
    stocksOk,
    cryptoOk,
    tradierConfigured: isTradierStocksConfigured(),
    tradierBreakerOpen: isTradierBreakerOpen(),
    yahooBreakerOpen: isYahooBreakerOpen(),
    coinbaseBreakerOpen: isCoinbaseBreakerOpen(),
    bootEnv,
    results,
    ts: new Date().toISOString(),
  };
}

// ── WebSocket ────────────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// TRA-142 — every WS client is tagged with the authenticated username so
// state and EOD broadcasts only go to that user's clients.
type AuthedSocket = WebSocket & { username?: string };

function broadcastToUser(username: string, msg: string): void {
  for (const client of wss.clients) {
    const c = client as AuthedSocket;
    if (c.readyState === WebSocket.OPEN && c.username === username) c.send(msg);
  }
}

function broadcastEngineState(ctx: UserContext): void {
  broadcastToUser(ctx.username, JSON.stringify({ type: 'state', payload: ctx.engine.getState() }));
}

function broadcastCryptoState(ctx: UserContext): void {
  broadcastToUser(ctx.username, JSON.stringify({ type: 'crypto_state', payload: ctx.cryptoEngine.getState() }));
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${firstHeader(req.headers.host) ?? 'localhost'}`);
  const token = url.searchParams.get('token') ?? '';
  const username = verifyToken(token);
  if (!username) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    (ws as AuthedSocket).username = username;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', async (ws) => {
  const c = ws as AuthedSocket;
  const username = c.username;
  if (!username) { ws.close(); return; }
  const ctx = await ensureUserContext(username);

  ws.send(JSON.stringify({ type: 'state', payload: ctx.engine.getState() }));
  ws.send(JSON.stringify({ type: 'crypto_state', payload: ctx.cryptoEngine.getState() }));

  // TRA-244 — read latest.json from the active stocks bucket so the WS
  // handshake matches whatever the Calendar tab is showing for this account.
  const stocksMode = stockModeKey(getSettings(ctx.username));
  const latestPath = join(stockReportsDirFor(ctx, stocksMode), 'latest.json');
  if (existsSync(latestPath)) {
    try {
      const raw = await readFile(latestPath, 'utf-8');
      ws.send(JSON.stringify({ type: 'eod_report', payload: JSON.parse(raw) }));
    } catch { /* ignore */ }
  }
});

// Wire up per-user engine onTick → user-scoped WS broadcasts.
//
// TRA-406 — the same onTick stream feeds a TradeAuditTracker per engine. The
// tracker diffs successive states so every position open/close (auto or
// manual, demo or live) lands in `trade-audit.jsonl` without touching the
// engine internals.
function attachBroadcastHandlers(ctx: UserContext): void {
  const equityAudit = new TradeAuditTracker(ctx.username, 'equity');
  const cryptoAudit = new TradeAuditTracker(ctx.username, 'crypto');
  ctx.engine.onTick((state) => {
    try { equityAudit.observe(state as unknown as Parameters<typeof equityAudit.observe>[0]); } catch { /* audit must never break broadcast */ }
    broadcastToUser(ctx.username, JSON.stringify({ type: 'state', payload: state }));
  });
  ctx.cryptoEngine.onTick((state) => {
    try { cryptoAudit.observe(state as unknown as Parameters<typeof cryptoAudit.observe>[0]); } catch { /* audit must never break broadcast */ }
    broadcastToUser(ctx.username, JSON.stringify({ type: 'crypto_state', payload: state }));
  });
}

for (const ctx of getAllUserContexts()) {
  attachBroadcastHandlers(ctx);
}

// TRA-388 — on startup, backfill any EOD report whose 21:00 ET archive tick
// was missed while the server was offline (overnight close, redeploy, crash).
// This is what fills the calendar gap the next time the app is opened, rather
// than waiting for — and depending on — that night's archive tick.
void catchUpMissedEodReports().catch(err =>
  log.warn('reports startup catch-up failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

// TRA-244 — on startup, rewrite the historical June Live-calendar cells from
// broker-truth realized P&L (board chose "backfill from fills"). Idempotent
// and bounded to the historical window, so it's safe to run every boot.
void runLiveRealizedCalendarBackfill().catch(err =>
  log.warn('live realized calendar backfill (startup) failed', {
    reason: err instanceof Error ? err.message : String(err),
  }),
);

/**
 * Provision a brand-new user: build their context and wire WS broadcast
 * handlers. Used by signup and admin-create. Failures are logged but do not
 * break the calling request — the user is created and their context can be
 * lazily rebuilt on first auth.
 */
async function provisionUser(username: string): Promise<void> {
  try {
    const ctx = await initUserContext(username);
    attachBroadcastHandlers(ctx);
  } catch (err: unknown) {
    log.warn('provisionUser failed', {
      username,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// Periodic backup snapshots (TRA-140) — every 30 minutes the persisted JSON
// files are copied into a timestamped folder under DATA_DIR/backups/. Old
// folders are pruned (last 24 kept = ~12 hours). On startup, missing/corrupt
// primary files auto-restore from the latest backup.
void rotateBackups().catch(err => log.warn('trade-store initial backup failed', { reason: err instanceof Error ? err.message : String(err) }));
const BACKUP_INTERVAL_MS = 30 * 60_000;
const backupTimer = setInterval(() => {
  void rotateBackups().catch(err => log.warn('trade-store backup failed', { reason: err instanceof Error ? err.message : String(err) }));
}, BACKUP_INTERVAL_MS);
backupTimer.unref?.();

// ── Static frontend (production web) ────────────────────────────────────────
const DIST_DIR = join(__dirname, '..', '..', '..', 'apps', 'desktop', 'dist');
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(DIST_DIR, 'index.html'));
  });
}

// TRA-406 — error-handling middleware. Mounted last so it catches anything a
// route handler threw; captures it against the request trace id and returns a
// 500 carrying that id. Express recognises this as an error handler by its
// 4-argument shape.
app.use(errorMiddleware);

// ── Observability monitor ────────────────────────────────────────────────────
//
// TRA-406 — run every 60s scheduler tick (see `onMonitor` below). Probes
// `/api/health`, checks disk space, watches captured-error volume, and — on
// market days past noon ET — alerts if no trades have been placed. Each alert
// key throttles itself, so a sustained outage produces one alert per window.

async function probeHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function runObservabilityMonitor(): Promise<void> {
  await runHealthCheck(probeHealth);
  await checkDiskSpace(DATA_DIR);
  checkErrorSpike(getErrorCountSince());

  // Trade-volume-zero — only meaningful on a stock-market trading day.
  const now = new Date();
  const etHour = Number(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }),
  );
  checkTradeVolume({
    tradeCountToday: getTradeOpenCount(),
    etHour: Number.isFinite(etHour) ? etHour : 0,
    isMarketDay: isMarketDay(now),
  });

  // TRA-528 — stale-state probe. Walk live user engines and raise the
  // `stale-state` alert if the market is open but no fresh quotes are landing —
  // the direct detector for "nothing works in Live" (engine up, feed dead).
  runStaleStateCheck(getAllUserContexts(), getSettings, now.getTime());
}

// ── Start ────────────────────────────────────────────────────────────────────

// TRA-406 — capture errors that escape every try/catch, and record this boot
// so a crash-loop toward PM2's max_restarts raises a `restart-storm` alert.
installGlobalErrorHandlers();
void recordBootAndCheckRestarts().catch(err =>
  logger.warn('boot-history check failed', { reason: err instanceof Error ? err.message : String(err) }),
);

// TRA-851 — owns the per-ET-day dedup for user routines across scheduler ticks.
const routineRunner = new RoutineRunner();

// TRA-1003 — arm the external-intel trigger. Cheap no-op tick until an operator
// sets ENABLE_EXTERNAL_INTEL (the activation gate is a separate board decision).
const externalIntelSchedule = startExternalIntelSchedule();

// TRA-1004 — arm the autonomous demo-trading loop. Cheap no-op tick until an
// operator sets ENABLE_AUTONOMOUS_DEMO_LOOP (a demo-sandbox decision — no board
// gate, no live-capital path). When on, each tick drives the existing brain
// unattended on every DEMO-mode book: it enables demo auto-trading and forces a
// decision cycle (analysts→trader→risk + strategy selector across
// stocks/options/crypto), with the TRA-995 autopilot kept in-loop as the guard.
// A halted book is skipped, so an autopilot halt demonstrably stops the loop.
//
// The driver below only ever touches the *demo* book (`setAutoTrading(true,
// 'demo')`); the `listBooks` enumerator filters to `mode === 'demo'` first, so a
// user in live mode is never enrolled — there is no live-trade path here.
function makeDemoBookEngine(ctx: UserContext): DemoBookEngine {
  return {
    username: ctx.username,
    isHalted: () =>
      ctx.engine.getState().tradingHalted || ctx.cryptoEngine.isKillSwitchEngaged(),
    // TRA-1072 — the crypto leg ignores the equity feed-stale gate (an equity
    // feed gap must not freeze crypto); it still honours the crypto kill switch
    // and the equity latched breakers (loss-streak / drawdown / equity kill).
    isCryptoHalted: () =>
      ctx.engine.isHaltedExcludingFeedStale() || ctx.cryptoEngine.isKillSwitchEngaged(),
    haltReason: () =>
      ctx.engine.getState().haltReason ??
      (ctx.cryptoEngine.isKillSwitchEngaged() ? 'Crypto kill switch engaged' : null),
    riskThrottle: () => ctx.engine.getRiskThrottle(),
    regime: () => ctx.engine.getState().marketReview.regime,
    recentAutopilotActions: () => ctx.engine.getAutopilotActions(),
    openStocks: () => ctx.engine.getState().account.openPositions.length,
    openCrypto: () => ctx.cryptoEngine.getReportSnapshot('demo').accountState.openPositions.length,
    driveStocks: () => {
      ctx.engine.setAutoTrading(true, 'demo');
      ctx.engine.refresh();
    },
    driveCrypto: () => {
      ctx.cryptoEngine.setAutoTrading(true, 'demo');
      ctx.cryptoEngine.refresh();
    },
  };
}
const autonomousDemoLoopDeps: AutonomousDemoLoopDeps = {
  listBooks: () =>
    getAllUserContexts()
      .filter(ctx => getSettings(ctx.username).mode === 'demo')
      .map(makeDemoBookEngine),
  isStocksMarketOpen: () => isMarketOpen(),
};
const autonomousDemoSchedule = startAutonomousDemoSchedule({
  deps: autonomousDemoLoopDeps,
  // TRA-1008 — re-resolve env per tick so a file-backed flag flip is honored.
  resolveEnv: demoFlagEnv,
});

const scheduler = new MarketScheduler();
scheduler.start({
  // TRA-244 — collapsed onto the 9 PM ET archive hook so the Calendar row
  // appears AFTER the dashboard's dailyPnl reset (the previous 4:05 PM hooks
  // ran before the reset, leaving the row visible at 4:05 but the dashboard
  // still showing the stale total until 9). Stocks generation is gated on
  // market days inside the callback; crypto fires every day (24/7).
  //
  // TRA-386 — the post-market regime review runs on the same hook, after the
  // daily close so the EOD reports are already on disk.
  onArchive: async () => {
    await runDailyCloseForAllUsers();
    await generateMarketReview('postmarket').catch(err =>
      log.error('market-review post-market generation failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-1006 — automated post-market analyst review: fold the day's demo
    // journal + enqueue ≥1 hypothesis into the TRA-994 pipeline. No-op + zero
    // cost while ENABLE_ANALYST_AGENT is off (flag checked before any deps).
    await runAnalystPostmarketTick(Date.now()).catch(err =>
      log.error('analyst post-market tick failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  },
  // TRA-249-D — hourly funding accrual on open Coinbase INTX perps. Fires
  // at minute=0 every ET hour; per-user trackers no-op when no perps are
  // open or the user is in demo mode.
  onHourly: runHourlyFundingForAllUsers,
  // TRA-849 — 8:30 AM ET pre-market morning brief. Renders the macro gate +
  // each user's watchlist setups, open book, and overnight news, then pushes
  // it through the notification dispatcher. Runs ahead of the 9:00 watchlist
  // build; market days only (gated in the scheduler).
  onMorningBrief: async () => {
    await runMorningBriefForAllUsers();
  },
  // TRA-368 — 9:00 AM ET pre-market routine. Replays prior session's EOD
  // review + a fresh pre-market scan into each user's smart watchlist so
  // the SignalEngine starts the new session with curated symbols. Stocks
  // only — crypto's 24/7 market has no pre-market boundary.
  //
  // TRA-386 — the pre-market regime review runs first so its GREEN/YELLOW/RED
  // gates are persisted before the watchlist builder (and any engine reader)
  // looks them up.
  onPremarket: async () => {
    await generateMarketReview('premarket').catch(err =>
      log.error('market-review pre-market generation failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    await runPremarketForAllUsers();
    // TRA-596 — refresh the upcoming-earnings calendar once per trading day,
    // pre-bell, so the engine's event-proximity read is current for the session.
    await runEarningsRefresh();
    // TRA-597 — refresh the macro/Fed economic calendar (FOMC + CPI/NFP/PCE)
    // pre-bell so daysToNextFOMC()/eventsNearDate() are current for the session.
    await runMacroRefresh();
    // TRA-1006 — automated pre-market analyst plan: rank the watchlist (S/R +
    // reversal + trend) and publish a ReviewBlock the demo loop consumes. No-op +
    // zero cost while ENABLE_ANALYST_AGENT is off (flag checked before any deps).
    await runAnalystPremarketTick(Date.now()).catch(err =>
      log.error('analyst pre-market tick failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  },
  // TRA-380 — 3:55 PM ET option-chain recorder. Captures one Tradier chain
  // snapshot per trading day into the persistent disk for the TRA-379
  // replay backtest harness. Market days only; see `runChainRecord`.
  //
  // TRA-822 — the StockTwits sentiment-snapshot logger rides the same hook so
  // the sentiment + chain partitions co-accumulate per symbol-day for the
  // TRA-820 IC/flow study. Isolated so a StockTwits failure can't drop the
  // chain capture (or vice-versa).
  onChainRecord: async () => {
    await runChainRecord();
    await runSentimentSnapshot().catch((err) =>
      log.error('sentiment-recorder failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    // TRA-845 — diff the just-captured chain vs yesterday and push Layer-4 alerts.
    // Isolated so a push failure can't drop the capture above (or vice-versa).
    await runOptionsAlertPush().catch((err) =>
      log.error('options-alert push failed', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  },
  // TRA-406 — observability monitor on every 60s tick.
  onMonitor: runObservabilityMonitor,
  // TRA-851 — user-routine tick on every 60s tick. The runner matches each
  // user's defined routines to the current ET minute, runs the action, and
  // pushes the result as a `routine` alert through the dispatcher (respecting
  // the user's channel prefs + quiet hours). Per-ET-day dedup lives in the
  // runner; the dispatcher dedups again by the same day key.
  onRoutineTick: (et) =>
    routineRunner.tick({
      nowEt: et,
      isMarketDay: (date) => isMarketDayIso(date),
      users: () => usersWithRoutinesSync(),
      listRoutines: (user) => listRoutinesSync(user),
      execute: (user, routine) => executeRoutineForUser(user, routine),
      emit: (user, routine, rendered) =>
        emitAlert({
          kind: 'routine',
          username: user,
          routineId: routine.id,
          date: et.date,
          title: rendered.title,
          body: rendered.body,
        }),
    }),
});

httpServer.listen(PORT, () => {
  // Intentional: console, not the structured logger — this is the genuine
  // startup banner an operator expects on stdout when the process comes up.
  console.log(`Trading server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

// TRA-1080 — event-loop/heap starvation watchdog. Detects the bqb1 "HTTP
// listener dead while worker timers live" state from inside the process and
// exits(1) for a clean Render restart, instead of hanging indefinitely in 502
// limbo. Monitoring is cheap and on by default; restart action is on by default
// (env-disableable). Started AFTER listen so a slow boot never trips it.
const eventLoopWatchdog: WatchdogHandle | null = startEventLoopWatchdog();

/**
 * TRA-407 (C5) — upper bound on how long shutdown waits for in-progress ticks
 * to drain. A tick that ignores the timer (e.g. a wedged socket) must not
 * block the process from exiting within Render's SIGTERM grace window.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

/** TRA-407 (C5) — guard so a doubled SIGTERM/SIGINT can't re-enter shutdown. */
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown received — draining ticks, recording in-flight orders, flushing trade history', { signal });
  scheduler.stop();
  externalIntelSchedule.stop();
  autonomousDemoSchedule.stop();
  eventLoopWatchdog?.stop();
  const all = getAllUserContexts();
  // Clear each engine's tick timer first so no new tick starts; the in-flight
  // tick (if any) keeps running and is drained next.
  for (const ctx of all) {
    ctx.engine.stop();
    ctx.cryptoEngine.stop();
    if (ctx.stocksPersistTimer) clearTimeout(ctx.stocksPersistTimer);
    if (ctx.cryptoPersistTimer) clearTimeout(ctx.cryptoPersistTimer);
  }
  // TRA-407 (C5) — finish the current tick so we exit on a tick boundary, not
  // mid-tick. Bounded by SHUTDOWN_DRAIN_TIMEOUT_MS so a wedged tick can't hold
  // the process past the redeploy grace window.
  const drainAll = Promise.all(all.flatMap(ctx => [ctx.engine.drain(), ctx.cryptoEngine.drain()]));
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drainAll.then(() => undefined),
    new Promise<void>(resolve => {
      drainTimer = setTimeout(() => {
        log.warn('shutdown tick drain exceeded timeout — exiting anyway', {
          timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
        });
        resolve();
      }, SHUTDOWN_DRAIN_TIMEOUT_MS);
      drainTimer.unref?.();
    }),
  ]);
  if (drainTimer) clearTimeout(drainTimer);
  // TRA-407 (C5) — record in-flight Tradier order ids so a redeploy mid-
  // reconcile leaves an audit trail for the next boot's reconciler.
  for (const ctx of all) {
    const inflight = ctx.engine.inFlightBrokerOrderIds();
    if (inflight.length > 0) {
      log.warn('shutdown: in-flight Tradier orders at exit', {
        count: inflight.length,
        orders: inflight.map(o => `${o.kind} ${o.optionSymbol} #${o.orderId} (${o.env})`).join(', '),
      });
    }
  }
  // Flush every user's pending trade-history writes synchronously before exit.
  try {
    await Promise.all(all.flatMap(ctx => [persistStocksNow(ctx), persistCryptoNow(ctx)]));
  } catch (err: unknown) {
    log.warn('shutdown persist failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // TRA-406 — drain any in-flight structured-log / audit / alert file writes.
  await flushLogs().catch(() => undefined);
  log.info('shutdown drain complete — exiting');
  process.exit(0);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
