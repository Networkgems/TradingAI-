// TRA-604 (TRA-595 C4b) — the live `GET /api/options/ideas` orchestration.
//
// Wires the whole pipeline the issue describes:
//   resolve live watchlist → pull chains (Tradier) → fuseOptionsResearchInput
//   (earnings C1 + Fed/FOMC C2 + sentiment + IV-rank) → runOptionsResearch
//   (real Anthropic LlmClient + batch cache + C3 guardrail config) → map to the
//   C5 panel's `OptionsIdeasFeed`.
//
// Falls back to a clearly-labelled NON-LIVE response when no LLM key is set
// (acceptance: "or a labelled non-live response when no LLM key is configured").
import { type OptionChainRow, type TradierOptionsClient, daysUntil } from '@trading-app/engine';
import {
  runOptionsResearch,
  createAnthropicLlmClientFromEnv,
  describeAnthropicCredFromEnv,
  type OptionsResearchCache,
  type OptionsResearchResult,
  type DayTradingGuardrail,
} from '@trading-app/agents';
import { DAY_TRADING_GUARDRAIL, sectorOf } from '@trading-app/shared';
import {
  fuseOptionsResearchInput,
  type SymbolEventContext,
} from './options-research-input.js';
import type { OptionChainSnapshotFile } from './options-chain-recorder.js';
import { earningsInDaysSync } from './earnings-store.js';
import { daysToNextFOMCSync, eventsNearDateSync } from './macro-store.js';
import { ivRankSync, recordDailyIv, atmIvFromRows } from './iv-rank-store.js';
import {
  buildOptionsIdeasFeed,
  noDayTradingBlock,
  type OptionsIdeasFeed,
  type IdeaEntryIntent,
} from './options-ideas-feed.js';
import {
  isOverMonthlyCap,
  recordOptionsSpend,
  optionsSpendStatus,
} from './options-spend-store.js';
import { recordSurfacedIdeas } from './options-idea-journal.js';
import type { DefinedRiskStrategy } from '@trading-app/agents';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'options-ideas' });

/** Inclusive DTE window for chain pulls — matches the 21–60 idea-gen floor. */
const MIN_DTE = DAY_TRADING_GUARDRAIL.minIdeaDteDays; // 21
const MAX_DTE = 60;
/** Bound the universe per request so a wide watchlist can't fan out into a Tradier rate-limit storm. */
const MAX_SYMBOLS = 25;
/** Process-wide feed cache TTL — the panel polls every 60s; chains move slowly. */
const FEED_TTL_MS = 10 * 60_000;

/** The C3 guardrail the pass enforces — sourced from the first-class config (TRA-598). */
function ideaGuardrail(): DayTradingGuardrail {
  return { minDteDays: DAY_TRADING_GUARDRAIL.minIdeaDteDays, definedRiskOnly: true };
}

// One batch cache for the whole process so an identical universe re-run within
// the trading day costs $0 (the engine keys by UTC day + inputs).
const researchCache: OptionsResearchCache = (() => {
  const m = new Map<string, OptionsResearchResult>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
})();

// Last-built entry intents, keyed by idea id, for POST …/paper-enter.
const entryIntents = new Map<string, IdeaEntryIntent>();

export function getEntryIntent(id: string): IdeaEntryIntent | undefined {
  return entryIntents.get(id);
}

interface FeedCacheEntry {
  key: string;
  builtAt: number;
  feed: OptionsIdeasFeed;
}
let feedCache: FeedCacheEntry | null = null;

function daysBetween(fromTs: number, isoDate: string): number {
  const target = Date.parse(`${isoDate}T16:00:00-04:00`);
  if (!Number.isFinite(target)) return -1;
  return Math.round((target - fromTs) / 86_400_000);
}

/**
 * Infer spot from a chain via put-call parity at the near-ATM strike:
 * `S ≈ K + (C − P)` where K minimises |C − P| (carry/rate ignored — fine for an
 * intraday spot used only to anchor the scanners + sketch). Returns null when no
 * strike has both a call and put mid.
 */
export function inferSpotFromRows(rows: readonly OptionChainRow[]): number | null {
  const mids = new Map<string, { c?: number; p?: number }>();
  for (const r of rows) {
    const mid =
      typeof r.bid === 'number' && typeof r.ask === 'number' && r.ask > 0
        ? (r.bid + r.ask) / 2
        : typeof r.last === 'number' && r.last > 0
          ? r.last
          : null;
    if (mid == null) continue;
    const k = `${r.expiration}:${r.strike}`;
    const slot = mids.get(k) ?? {};
    if (r.optionType === 'call') slot.c = mid;
    else slot.p = mid;
    mids.set(k, slot);
  }
  let best: { spot: number; diff: number } | null = null;
  for (const [k, { c, p }] of mids) {
    if (c == null || p == null) continue;
    const strike = Number(k.split(':')[1]);
    const diff = Math.abs(c - p);
    if (!best || diff < best.diff) best = { spot: strike + (c - p), diff };
  }
  return best && best.spot > 0 ? best.spot : null;
}

/**
 * Pull in-window chains for one symbol into an in-memory snapshot (the same
 * shape the daily recorder writes, so `fuseOptionsResearchInput` consumes it
 * unchanged). Spot is inferred from the chain. Returns null on no usable data.
 */
async function fetchSnapshot(
  client: Pick<TradierOptionsClient, 'getExpirations' | 'getChainSnapshot'>,
  symbol: string,
  now: number,
): Promise<OptionChainSnapshotFile | null> {
  const sym = symbol.trim().toUpperCase();
  const expirations = await client.getExpirations(sym);
  const inWindow = expirations.filter((d) => {
    const dte = daysBetween(now, d);
    return dte >= MIN_DTE && dte <= MAX_DTE;
  });
  if (!inWindow.length) return null;
  const rows: OptionChainRow[] = [];
  for (const exp of inWindow) {
    rows.push(...(await client.getChainSnapshot(sym, exp)));
  }
  if (!rows.length) return null;
  const spot = inferSpotFromRows(rows);
  if (spot == null) return null;
  return { symbol: sym, spot, recordedAt: now, expirations: inWindow, rows };
}

/** Human macro labels ("CPI in 2d") for the fusion's `macroEventsNearby`. */
function macroLabels(now: number): string[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return eventsNearDateSync(today, 3)
    .map((e) => {
      const d = daysUntil(e.date, now);
      if (d == null || d < 0) return null;
      return `${e.type} in ${d}d`;
    })
    .filter((s): s is string => s != null);
}

export interface BuildIdeasOptions {
  /** Configured Tradier client; null → cannot pull chains. */
  client: Pick<TradierOptionsClient, 'getExpirations' | 'getChainSnapshot'> | null;
  /** Live universe (resolved watchlist). */
  symbols: readonly string[];
  /**
   * TRA-714 — the caller's own console API key (`sk-ant-api…`), installed
   * through the app and persisted per-user. When present it overrides the
   * server env credential (including a rate-limited Max OAuth token), so a user
   * on a Claude Max plan can make the feed live without any Render access. When
   * absent the feed falls back to the server env credential as before.
   */
  anthropicApiKey?: string | null;
  /** Clock seam. */
  now?: number;
  /** Bypass the process feed cache (tests). */
  noCache?: boolean;
  /**
   * TRA-1121 — the authed user's paper-options book equity. Threaded into the
   * feed builder so each idea's single-lot max loss is pre-flighted through the
   * same TRA-912 gate the paper-enter path uses; ideas that bust the per-trade
   * cap come back `enterable:false` with the gate's reason. Omitted → ideas are
   * left enterable (the open path's own gate still protects entries).
   */
  accountEquityUsd?: number;
}

/**
 * Build (or serve cached) the live ideas feed. Returns a NON-LIVE labelled feed
 * when no LLM key is configured or no chains are available, so the panel always
 * has something coherent to render.
 */
export async function buildIdeasFeed(opts: BuildIdeasOptions): Promise<OptionsIdeasFeed> {
  const now = opts.now ?? Date.now();
  const guardrail = DAY_TRADING_GUARDRAIL;
  const universe = [...new Set(opts.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (universe.length > MAX_SYMBOLS) {
    log.info('options-ideas universe truncated', { requested: universe.length, used: MAX_SYMBOLS });
  }
  const symbols = universe.slice(0, MAX_SYMBOLS);

  // TRA-714 — resolve the effective Anthropic credential. A user's app-installed
  // console key (persisted per-user) overrides the server env credential, so a
  // Claude Max user can make the feed live without any Render access. The env
  // overlay is what both the client and the diagnostic read, so they always
  // agree on which credential actually ran.
  const userKey = (opts.anthropicApiKey ?? '').trim();
  const credEnv: NodeJS.ProcessEnv = userKey
    ? { ...process.env, ANTHROPIC_API_KEY: userKey }
    : process.env;
  const cred = describeAnthropicCredFromEnv(credEnv);

  // Fold the resolved credential mode/prefix into the cache key: two callers
  // with the same universe but different credentials (e.g. one with a console
  // key, one falling back to the rate-limited env token) must not share a
  // cached live-vs-non-live result. The prefix is a non-secret type marker.
  // TRA-1121 — fold the gating equity into the key: the feed cache is
  // process-wide (shared across users), and enterability is a function of book
  // equity. Two callers with the same universe but different equity must not
  // share a feed whose `enterable` flags were computed against the other's cap.
  // Bucket to whole dollars so sub-dollar mark drift doesn't thrash the cache.
  const equityKey = typeof opts.accountEquityUsd === 'number' ? Math.round(opts.accountEquityUsd) : 'na';
  const cacheKey = `${cred.mode}:${cred.prefix}|eq=${equityKey}|${symbols.slice().sort().join(',')}`;

  if (!opts.noCache && feedCache && feedCache.key === cacheKey && now - feedCache.builtAt < FEED_TTL_MS) {
    return feedCache.feed;
  }

  const nonLive = (note: string): OptionsIdeasFeed => ({
    ideas: [],
    noDayTrading: noDayTradingBlock(guardrail),
    generatedAt: now,
    source: 'non_live',
    note,
  });

  const llm = createAnthropicLlmClientFromEnv(credEnv);
  if (!llm) {
    return nonLive(
      'AI Options Ideas is not live: no Anthropic credential is configured. The simplest fix (no API key needed elsewhere) is to open the AI Ideas tab settings and paste a pay-as-you-go console API key from console.anthropic.com → API keys (it starts with "sk-ant-api03…"); it is stored with your account and activates the feed immediately. A Claude Pro/Max subscription token will NOT work here — Anthropic rate-limits it for server use. (Server operators may instead set ANTHROPIC_API_KEY in the environment.) The research pass and guardrails are wired; ideas and Paper entry activate once a console key is set.',
    );
  }
  if (!opts.client) {
    return nonLive('AI Options Ideas is not live: no Tradier options credentials are configured to pull option chains.');
  }
  if (!symbols.length) {
    return nonLive('AI Options Ideas is not live: the watchlist is empty.');
  }

  // 1) pull chains → snapshots, recording the daily ATM IV per symbol.
  const snapshots: OptionChainSnapshotFile[] = [];
  const rowsBySymbol = new Map<string, OptionChainRow[]>();
  for (const sym of symbols) {
    try {
      const snap = await fetchSnapshot(opts.client, sym, now);
      if (!snap) continue;
      snapshots.push(snap);
      rowsBySymbol.set(snap.symbol, snap.rows);
      const atmIv = snap.spot != null ? atmIvFromRows(snap.rows, snap.spot) : null;
      if (atmIv != null) {
        // Fire-and-forget: building the trailing IV history is a side effect, not
        // on the critical path for this request's rank read.
        void recordDailyIv(snap.symbol, atmIv, now).catch(() => {});
      }
    } catch (err) {
      log.warn('chain pull failed', { symbol: sym, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!snapshots.length) {
    return nonLive('AI Options Ideas is not live: no option chains returned for the current universe.');
  }

  // 2) fuse — wire C1 (earnings), C2 (Fed/FOMC + macro), IV-rank, sentiment.
  const macroNearby = macroLabels(now);
  const fomc = daysToNextFOMCSync(now);
  const contextFor = (symbol: string): SymbolEventContext => {
    const snap = snapshots.find((s) => s.symbol === symbol.toUpperCase());
    const atmIv = snap && snap.spot != null ? atmIvFromRows(snap.rows, snap.spot) : null;
    // TRA-846 — resolve the sector from the existing hand-maintained map (TRA-844).
    // 'Other'/unmapped → null so the ranker treats the name as its own bucket
    // rather than clustering every unmapped ticker into one "Other" sector.
    const sector = sectorOf(symbol);
    return {
      ivRank: atmIv != null ? ivRankSync(symbol, atmIv, now) : null,
      nextEarningsInDays: earningsInDaysSync(symbol, now),
      daysToFOMC: fomc,
      macroEventsNearby: macroNearby,
      newsSentiment: null,
      sector: sector === 'Other' ? null : sector,
    };
  };
  const input = fuseOptionsResearchInput(snapshots, now, { contextFor, now });
  input.guardrail = ideaGuardrail();

  // CFO spend guardrail (TRA-658): hard tripwire BEFORE the paid LLM call so the
  // feed can never spend past the board-approved monthly cap. Chains + IV history
  // above are kept warm (near-zero cost) so ivRank stays accurate when the cap
  // resets next month; only the Anthropic call is gated. Degrade to non_live —
  // the panel keeps its PREVIEW label, no user-facing break, no live-capital impact.
  if (isOverMonthlyCap(now)) {
    const s = optionsSpendStatus(now);
    return nonLive(
      `AI Options Ideas is paused for the rest of ${s.month}: the $${s.capUsd}/mo research budget is reached ($${s.spentUsd.toFixed(2)} spent). The feed resumes next month; live capital is unaffected (paper-only).`,
    );
  }

  // 3) run the Head-of-Options-Research pass against the real model.
  let research: OptionsResearchResult;
  try {
    research = await runOptionsResearch(input, { llm, cache: researchCache });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error('options-research pass failed', { reason });
    // Surface the concrete reason (TRA-714): a bare "try again" hid an auth
    // failure (e.g. an Anthropic credential that is read but rejected at call
    // time) behind a transient-looking message, making it undiagnosable from
    // outside. The reason is truncated and carries no secrets.
    //
    // Also surface WHICH credential path resolved (TRA-714): a 429 on the API
    // key means the key itself is rate-limited; a 429 while still on `oauth`
    // means an empty/whitespace ANTHROPIC_API_KEY silently fell back to the
    // rate-limited Max subscription token. The prefix (`sk-ant-api03` /
    // `sk-ant-oat01`) identifies the credential kind without exposing the secret.
    // Reuse the credential resolved at the top of this request (TRA-714): it
    // already reflects a user's app-installed console key overriding the env.
    const credNote = ` [auth=${cred.mode} prefix=${cred.prefix || 'n/a'} apiKeyPresent=${cred.apiKeyPresent} oauthPresent=${cred.oauthPresent}]`;
    return nonLive(
      `AI Options Ideas could not complete the research pass this cycle: ${reason.slice(0, 200)}${credNote}`,
    );
  }

  // 4) map engine ideas → panel feed; refresh the entry-intent registry.
  const { feed, intents } = buildOptionsIdeasFeed({
    research,
    input,
    rowsBySymbol,
    guardrail,
    generatedAt: now,
    // TRA-1121 — pre-flight enterability against the user's paper book equity.
    ...(typeof opts.accountEquityUsd === 'number' ? { accountEquityUsd: opts.accountEquityUsd } : {}),
  });
  entryIntents.clear();
  for (const [id, intent] of intents) entryIntents.set(id, intent);

  // CFO spend guardrail (TRA-658): account only real spend. A batch-cache hit
  // re-serves a prior result for $0 and must not double-count against the cap.
  if (!research.cached && research.costUsd > 0) {
    recordOptionsSpend(research.costUsd, now);
  }
  const spend = optionsSpendStatus(now);

  // C6 (TRA-601): journal the surfaced ideas for forward-testing. Fire-and-forget
  // and deduped per (ticker, strategy, expiration, ET day) inside the journal, so
  // the panel's 60s poll can't inflate the validation sample. The strategy enum
  // comes from the entry-intent registry (the panel view carries only a display
  // string); the journal needs the enum to price the right structure class.
  const strategyById = new Map<string, DefinedRiskStrategy>(
    [...intents].map(([id, intent]) => [id, intent.strategy]),
  );
  void recordSurfacedIdeas(feed.ideas, strategyById, now).catch((err) => {
    log.warn('idea journal append failed', { reason: err instanceof Error ? err.message : String(err) });
  });

  feedCache = { key: cacheKey, builtAt: now, feed };
  log.info('options-ideas feed built', {
    universe: symbols.length,
    snapshots: snapshots.length,
    ideas: feed.ideas.length,
    costUsd: research.costUsd,
    cached: research.cached,
    monthSpendUsd: spend.spentUsd,
    monthCapUsd: spend.capUsd,
  });
  return feed;
}
