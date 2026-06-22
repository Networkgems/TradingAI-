// ── External-intel PRODUCTION connectors + LLM extractor (TRA-999) ───────────
//
// The impure half of TRA-999, kept OUT of `external-intel.ts` so that the core
// (normalization, guardrails, the JSONL logs, orchestration) stays fully
// deterministic and unit-testable with stubs. Nothing here is exercised by the
// unit tests — these are the concrete `IntelSource` / `IntelExtractor`
// implementations the server wiring injects when `ENABLE_EXTERNAL_INTEL` is on.
//
// Authorization (board gate 0e77f074): PUBLIC / ToS-compliant sources ONLY —
// Reddit's official read-only OAuth API and public RSS/news feeds. There is NO
// paid/private Discord/Slack connector here, by design (invariant 3).

import { completeJson, type LlmClient } from '@trading-app/agents';
import { logger } from './observability/index.js';
import {
  normalizeTickers,
  type IntelExtractor,
  type IntelHypothesisCandidate,
  type IntelSource,
  type RawIntelItem,
  type TunableParamSpec,
  DEFAULT_TUNABLE_PARAMS,
} from './external-intel.js';

const log = logger.child({ module: 'external-intel-sources' });

const DEFAULT_USER_AGENT = 'trading-app/1.0 (external-intel; +https://github.com/Networkgems/TradingAI-)';

// Cheap cashtag scan, e.g. "$NVDA" or "AAPL". Conservative on purpose — the
// guardrails downstream don't depend on tickers; they're metadata for the scorer.
function scanTickers(text: string): string[] {
  const matches = text.match(/\$?[A-Z]{1,6}\b/g) ?? [];
  // Keep only $-prefixed cashtags or all-caps words 2-5 long, drop common stopwords.
  const stop = new Set(['A', 'I', 'THE', 'AND', 'FOR', 'YOU', 'ARE', 'BUY', 'SELL', 'CALL', 'PUT', 'DTE', 'IV', 'OTM', 'ITM', 'ATM', 'TP', 'SL', 'EOD', 'YOLO']);
  return normalizeTickers(matches.filter(m => m.startsWith('$') || (m.length >= 2 && m.length <= 5 && !stop.has(m))));
}

// ── Reddit: official read-only OAuth (application-only / client_credentials) ──

export interface RedditSourceConfig {
  /** Subreddit without the `r/`, e.g. `options`. */
  subreddit: string;
  clientId: string;
  clientSecret: string;
  /** Listing to pull (`new` is the lowest-latency public listing). */
  listing?: 'new' | 'hot' | 'top';
  /** Max items per pull (Reddit caps at 100). */
  limit?: number;
  userAgent?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build an {@link IntelSource} for one subreddit backed by Reddit's official
 * read-only OAuth API (application-only `client_credentials` token → the
 * `oauth.reddit.com` listing). Honours the documented `User-Agent` requirement
 * and the listing `limit` cap; a fetch failure surfaces as a thrown error that
 * `runExternalIntelCycle` catches and skips (the cycle continues with other
 * sources).
 */
export function makeRedditSource(config: RedditSourceConfig): IntelSource {
  const fetchImpl = config.fetchImpl ?? fetch;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const listing = config.listing ?? 'new';
  const limit = Math.min(Math.max(config.limit ?? 50, 1), 100);
  const sourceKey = `reddit:r/${config.subreddit}`;

  async function token(): Promise<string> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const res = await fetchImpl('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`reddit token ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('reddit token: no access_token in response');
    return json.access_token;
  }

  return {
    sourceKey,
    async fetch(): Promise<RawIntelItem[]> {
      const accessToken = await token();
      const url = `https://oauth.reddit.com/r/${config.subreddit}/${listing}?limit=${limit}`;
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': userAgent },
      });
      if (!res.ok) throw new Error(`reddit listing ${res.status} ${res.statusText}`);
      const json = (await res.json()) as {
        data?: { children?: Array<{ data?: Record<string, unknown> }> };
      };
      const children = json.data?.children ?? [];
      const items: RawIntelItem[] = [];
      for (const child of children) {
        const d = child.data;
        if (!d) continue;
        const id = String(d['id'] ?? '');
        if (!id) continue;
        const title = String(d['title'] ?? '');
        const text = String(d['selftext'] ?? '');
        const permalink = String(d['permalink'] ?? '');
        const createdUtc = Number(d['created_utc'] ?? 0);
        items.push({
          sourceKey,
          itemId: id,
          url: permalink ? `https://www.reddit.com${permalink}` : `https://redd.it/${id}`,
          author: d['author'] ? String(d['author']) : undefined,
          capturedAt: Number.isFinite(createdUtc) && createdUtc > 0 ? Math.round(createdUtc * 1000) : 0,
          title,
          text,
          tickers: scanTickers(`${title} ${text}`),
        });
      }
      log.info('reddit source fetched', { sourceKey, count: items.length });
      return items;
    },
  };
}

// ── Public RSS / Atom feed ───────────────────────────────────────────────────

export interface RssSourceConfig {
  /** Stable key, e.g. `rss:seekingalpha-options`. */
  sourceKey: string;
  feedUrl: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

function tag(block: string, name: string): string | undefined {
  // CDATA-aware single-tag extractor; case-insensitive, first match.
  const re = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build an {@link IntelSource} for a public RSS/Atom feed. Parses `<item>` /
 * `<entry>` blocks with a dependency-free CDATA-aware extractor (no XML lib) —
 * enough for the title/link/guid/description we normalize, robust to chatty
 * feeds. ToS compliance is the operator's responsibility when wiring a feed URL.
 */
export function makeRssSource(config: RssSourceConfig): IntelSource {
  const fetchImpl = config.fetchImpl ?? fetch;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  return {
    sourceKey: config.sourceKey,
    async fetch(): Promise<RawIntelItem[]> {
      const res = await fetchImpl(config.feedUrl, { headers: { 'User-Agent': userAgent } });
      if (!res.ok) throw new Error(`rss ${config.sourceKey} ${res.status} ${res.statusText}`);
      const xml = await res.text();
      const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) ?? [];
      const items: RawIntelItem[] = [];
      for (const block of blocks) {
        const title = stripHtml(tag(block, 'title') ?? '');
        const guid = tag(block, 'guid') ?? tag(block, 'id');
        const link = tag(block, 'link') ?? guid ?? '';
        const itemId = (guid ?? link).trim();
        if (!itemId) continue;
        const desc = stripHtml(tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? '');
        const pub = tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published');
        const ms = pub ? Date.parse(pub) : NaN;
        items.push({
          sourceKey: config.sourceKey,
          itemId,
          url: link || itemId,
          capturedAt: Number.isFinite(ms) ? ms : 0,
          title,
          text: desc,
          tickers: scanTickers(`${title} ${desc}`),
        });
      }
      log.info('rss source fetched', { sourceKey: config.sourceKey, count: items.length });
      return items;
    },
  };
}

// ── LLM extractor (real `LlmClient`, schema-validated, retry on mismatch) ─────

const EXTRACT_SYSTEM = [
  'You convert public retail-trading discussion into AT MOST a few concrete, testable parameter-change',
  'hypotheses for a crypto mean-reversion backtest. You may ONLY target params from the allow-list given.',
  'Each hypothesis proposes ONE numeric change to ONE allow-listed param. If the post contains no testable,',
  'on-topic parameter idea, return an empty array. NEVER invent a param outside the allow-list. Keep deltas',
  'SMALL — a nudge, not a regime change. Reply with ONLY a JSON array, no prose.',
].join(' ');

function allowListText(registry: readonly TunableParamSpec[]): string {
  return registry
    .map(p => `- ${p.path} (${p.kind}); set∈[${p.set[0]},${p.set[1]}], |add|≤${p.maxAbsAdd}, mul∈[${p.mul[0]},${p.mul[1]}]`)
    .join('\n');
}

function validateCandidateArray(value: unknown): string[] {
  if (!Array.isArray(value)) return ['top-level value must be a JSON array'];
  const errs: string[] = [];
  value.forEach((c, i) => {
    if (typeof c !== 'object' || c === null) { errs.push(`[${i}] must be an object`); return; }
    const o = c as Record<string, unknown>;
    if (typeof o['targetPath'] !== 'string') errs.push(`[${i}].targetPath must be a string`);
    if (!['set', 'add', 'mul'].includes(String(o['op']))) errs.push(`[${i}].op must be set|add|mul`);
    if (typeof o['value'] !== 'number' || !Number.isFinite(o['value'])) errs.push(`[${i}].value must be a finite number`);
    if (typeof o['rationale'] !== 'string' || !o['rationale']) errs.push(`[${i}].rationale must be a non-empty string`);
  });
  return errs;
}

export interface LlmIntelExtractorOptions {
  registry?: readonly TunableParamSpec[];
  /** Total LLM tries incl. the first (schema-validate-and-retry). Default 3. */
  maxAttempts?: number;
}

/**
 * Build the production {@link IntelExtractor} backed by a real `LlmClient`. The
 * model is pinned to the allow-list in-prompt and its output is JSON-schema
 * validated with retry-on-mismatch via `completeJson` (TRA-529 §3). This is only
 * the FIRST line of defence — every returned candidate is still run through the
 * hard guardrails (`validateCandidate`) before a hypothesis is built, so a model
 * that ignores the bounds is rejected, never clamped. On a hard LLM/schema
 * failure the extractor degrades to an empty candidate set (the cycle goes on).
 */
export function makeLlmIntelExtractor(
  llm: LlmClient,
  opts: LlmIntelExtractorOptions = {},
): IntelExtractor {
  const registry = opts.registry ?? DEFAULT_TUNABLE_PARAMS;
  const maxAttempts = opts.maxAttempts ?? 3;
  return async (item: RawIntelItem, promptVersion: string): Promise<IntelHypothesisCandidate[]> => {
    const userMsg = [
      `promptVersion: ${promptVersion}`,
      '',
      'Allow-listed tunable params (target ONLY these):',
      allowListText(registry),
      '',
      `Source: ${item.sourceKey}`,
      item.tickers && item.tickers.length ? `Tickers: ${item.tickers.join(', ')}` : '',
      `Title: ${item.title}`,
      `Body: ${item.text.slice(0, 4000)}`,
      '',
      'Return a JSON array of {targetPath, op, value, rationale}. Empty array if nothing testable.',
    ].filter(Boolean).join('\n');

    try {
      const { value } = await completeJson<IntelHypothesisCandidate[]>(
        llm,
        {
          tier: 'fast',
          purpose: 'external-intel:extract',
          temperature: 0,
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: userMsg },
          ],
        },
        { validate: validateCandidateArray, maxAttempts },
      );
      return value;
    } catch (err) {
      log.warn('external-intel LLM extraction failed, yielding no candidates', {
        sourceKey: item.sourceKey,
        itemId: item.itemId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  };
}
