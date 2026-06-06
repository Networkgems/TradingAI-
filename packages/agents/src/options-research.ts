// TRA-599 (TRA-595 C4) — the "Head of Options Research" LLM pass: the heart of
// the AI Options Ideas feature. This is the disciplined automation of the Reddit
// workflow — real fused data → ONE structured, cacheable LLM triage call →
// ranked, DEFINED-RISK ideas (ticker / strategy / thesis / POP / max-loss).
//
// Honest framing (TRA-595 §5): the edge is NOT "the LLM picks winners". The
// model is a synthesis/triage layer over scanner mispricing + IV-rank +
// event-proximity discipline + news sentiment. It may only return capped-loss
// structures, and every idea must clear the C3 no-day-trading guardrail (a
// minimum DTE — no 0DTE/day-trades). Both are enforced deterministically AFTER
// the model speaks, so a chatty or over-eager model can never route an
// undefined-risk or day-trade idea.
//
// The call routes through `completeJson` (strict JSON, schema-validated,
// retried on malformed output) exactly like the analyst tier, so swapping the
// `StubLlmClient` for the company Anthropic key in production is a config change,
// not a code change. One call per idea batch; results are cacheable by a
// deterministic batch key so a re-run within the same trading day costs $0.
import type { OptionType } from '@trading-app/shared';
import { completeJson, type CompleteJsonResult, type LlmClient, type LlmMessage } from './llm-client.js';

/**
 * The capped-loss strategies the pass is allowed to emit. Anything outside this
 * allowlist (naked/short single legs, short straddles/strangles, ratio spreads)
 * is rejected by the guardrail — the whole product is defined-risk only.
 *   • long_call / long_put — debit, max loss = premium paid.
 *   • bull_call_spread / bear_put_spread — debit vertical, max loss = net debit.
 *   • bull_put_spread / bear_call_spread — credit vertical, max loss = width − credit.
 *   • iron_condor / iron_butterfly — two credit verticals, max loss = wing width − credit.
 *   • call_calendar / put_calendar — debit calendar, max loss = net debit.
 */
export type DefinedRiskStrategy =
  | 'long_call'
  | 'long_put'
  | 'bull_call_spread'
  | 'bear_put_spread'
  | 'bull_put_spread'
  | 'bear_call_spread'
  | 'iron_condor'
  | 'iron_butterfly'
  | 'call_calendar'
  | 'put_calendar';

export const DEFINED_RISK_STRATEGIES: ReadonlySet<string> = new Set<DefinedRiskStrategy>([
  'long_call',
  'long_put',
  'bull_call_spread',
  'bear_put_spread',
  'bull_put_spread',
  'bear_call_spread',
  'iron_condor',
  'iron_butterfly',
  'call_calendar',
  'put_calendar',
]);

/** Every defined-risk strategy has a finite, known max loss by construction. */
export function isDefinedRiskStrategy(strategy: string): strategy is DefinedRiskStrategy {
  return DEFINED_RISK_STRATEGIES.has(strategy);
}

/**
 * One scanner-surfaced contract, normalised from the RV and OTM-mispricing
 * scanners (`@trading-app/engine`). The server adapter projects either
 * `RelativeValueCandidate` or `OtmMispricingCandidate` into this shape so the
 * agent layer stays decoupled from the engine. Candidates are already inside the
 * live DTE window (21–60d) when they reach here.
 */
export interface OptionsScannerCandidate {
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  /** YYYY-MM-DD. */
  expiration: string;
  daysToExpiration: number;
  /** (bid + ask) / 2, per-share. */
  mark: number;
  /** σ used to value the row. */
  ivUsed: number;
  /** Sign-adjusted Black-Scholes delta. */
  delta: number;
  /** Scanner verdict, e.g. 'cheap' | 'expensive' | 'fair' | 'monotonic_violation'. */
  classification: string;
  /** (mark − fair) / fair. Positive → rich, negative → cheap. */
  mispricingPct: number;
  /** Which scanner surfaced it (provenance for the thesis). */
  source: 'relative_value' | 'otm_mispricing';
}

/**
 * Everything the pass sees for one underlying — the fusion of scanner output
 * with the IV-rank, earnings/Fed event-proximity (C1/C2) and news-sentiment
 * lanes. Built by the server adapter; never crosses the WS boundary.
 */
export interface OptionsResearchSymbol {
  symbol: string;
  spot: number;
  /**
   * IV-rank 0–100 (where current IV sits in its trailing 52-week range). `null`
   * when no IV history is available — the model is told it's unknown and must
   * NOT claim an IV edge it can't see (honest framing, TRA-595 §5).
   */
  ivRank: number | null;
  /** Days to next scheduled earnings (C1), or `null` if uncovered/none ahead. */
  nextEarningsInDays: number | null;
  /** Days to the next FOMC decision (C2), or `null` if unknown. */
  daysToFOMC: number | null;
  /** Human-readable nearby macro prints, e.g. ["CPI in 2d", "Jobs in 4d"]. */
  macroEventsNearby: string[];
  /** Recency-weighted aggregate news sentiment −1…+1, or `null` with no feed. */
  newsSentiment: number | null;
  /** Candidate contracts the scanners surfaced for this symbol. */
  candidates: OptionsScannerCandidate[];
}

/**
 * The C3 "no day trading" guardrail, injected by the caller. Defined here as a
 * minimal contract so this pass stays forward-compatible with C3's first-class
 * config: the server passes C3's resolved values through, and absent that we
 * fall back to {@link DEFAULT_OPTIONS_GUARDRAIL}.
 */
export interface DayTradingGuardrail {
  /** Reject any idea whose nearest leg DTE is below this — no 0DTE/day-trades. */
  minDteDays: number;
  /** Only capped-loss structures pass. Always true for the options-ideas pass. */
  definedRiskOnly: boolean;
}

/** Matches the live scanner window floor (21–60 DTE); see TRA-373/TRA-595 §3. */
export const DEFAULT_OPTIONS_GUARDRAIL: DayTradingGuardrail = {
  minDteDays: 21,
  definedRiskOnly: true,
};

export interface OptionsResearchInput {
  /** Decision bar — every fused input is timestamped at/before this. */
  asOf: number;
  symbols: OptionsResearchSymbol[];
  /** Max ideas to return after ranking. Default 5. */
  maxIdeas?: number;
  /** The C3 guardrail. Defaults to {@link DEFAULT_OPTIONS_GUARDRAIL}. */
  guardrail?: DayTradingGuardrail;
}

export interface OptionsIdea {
  ticker: string;
  strategy: DefinedRiskStrategy;
  thesis: string;
  /** Probability of profit at expiry, 0…1. */
  pop: number;
  /** Defined max loss per 1-lot in USD — finite and > 0 by construction. */
  maxLossUsd: number;
  /** Nearest-leg DTE; guaranteed ≥ guardrail.minDteDays in the returned list. */
  dteDays: number;
  /** Event-context badges for the UI, e.g. ["earnings in 3d", "FOMC in 1d"]. */
  eventContext: string[];
  /** 1-based rank after deterministic re-sort (1 = best). */
  rank: number;
}

export interface RejectedIdea {
  idea: Partial<OptionsIdea>;
  reasons: string[];
}

export interface OptionsResearchResult {
  ideas: OptionsIdea[];
  /** Summed LLM cost across attempts. 0 when served from cache or short-circuited. */
  costUsd: number;
  attempts: number;
  /** LLM-proposed ideas the guardrail dropped — kept for audit/observability. */
  rejected: RejectedIdea[];
  /** True when the batch was served from cache (no LLM call this run). */
  cached: boolean;
}

/** Optional batch cache (TRA-595 §5: "one structured call per idea batch, cacheable"). */
export interface OptionsResearchCache {
  get(key: string): OptionsResearchResult | undefined;
  set(key: string, value: OptionsResearchResult): void;
}

export interface OptionsResearchDeps {
  llm: LlmClient;
  /** Batch cache. When supplied, an identical batch within the day costs $0. */
  cache?: OptionsResearchCache;
  /** Total ideas across attempts; clamps schema retries. Default 3. */
  maxAttempts?: number;
}

// ── batch key ───────────────────────────────────────────────────────────────

/** UTC `YYYY-MM-DD` bucket so a re-run on the same trading day hits cache. */
function utcDay(asOf: number): string {
  return new Date(asOf).toISOString().slice(0, 10);
}

/**
 * Deterministic cache key for an idea batch. Folds in only the fields that
 * change the model's answer — the day bucket, the guardrail, the idea cap, and a
 * compact per-symbol fingerprint (spot, IV-rank, event proximity, sentiment, and
 * each candidate's strike/type/mark/classification). Two batches with the same
 * inputs on the same day share a key; a moved spot or a fresh candidate busts it.
 */
export function optionsResearchBatchKey(input: OptionsResearchInput): string {
  const g = input.guardrail ?? DEFAULT_OPTIONS_GUARDRAIL;
  const maxIdeas = input.maxIdeas ?? 5;
  const round = (v: number | null, dp = 2): string =>
    v == null || !Number.isFinite(v) ? '_' : (Math.round(v * 10 ** dp) / 10 ** dp).toString();
  const symbols = [...input.symbols]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((s) => {
      const cands = [...s.candidates]
        .sort((a, b) => a.optionSymbol.localeCompare(b.optionSymbol))
        .map(
          (c) =>
            `${c.optionSymbol}:${c.optionType}:${c.strike}:${c.daysToExpiration}:${round(c.mark)}:${c.classification}:${round(c.mispricingPct, 3)}`,
        )
        .join(',');
      return [
        s.symbol,
        round(s.spot),
        round(s.ivRank, 1),
        s.nextEarningsInDays ?? '_',
        s.daysToFOMC ?? '_',
        s.macroEventsNearby.join('|'),
        round(s.newsSentiment, 3),
        cands,
      ].join('#');
    })
    .join(';');
  return [
    'options-research-v1',
    utcDay(input.asOf),
    `min${g.minDteDays}`,
    g.definedRiskOnly ? 'dr1' : 'dr0',
    `max${maxIdeas}`,
    symbols,
  ].join('|');
}

// ── validation ────────────────────────────────────────────────────────────────

interface RawIdeaBatch {
  ideas: unknown;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Schema for the batch the model returns: `{ ideas: OptionsIdea[] }`. Validates
 * STRUCTURE only — required fields present and well-typed, POP in range,
 * max-loss positive. Strategy-allowlist and DTE-floor enforcement happen
 * post-parse in the guardrail so a single bad idea triggers a drop, not a whole
 * batch retry. Returns the field-error list `completeJson` feeds back on retry.
 */
export function validateOptionsIdeaBatch(value: unknown): string[] {
  const errors: string[] = [];
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return ['root must be an object of the form { "ideas": [...] }'];
  }
  const batch = value as RawIdeaBatch;
  if (!Array.isArray(batch.ideas)) {
    return ['"ideas" must be an array'];
  }
  batch.ideas.forEach((raw, i) => {
    const at = `ideas[${i}]`;
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const idea = raw as Record<string, unknown>;
    if (!isNonEmptyString(idea.ticker)) errors.push(`${at}.ticker must be a non-empty string`);
    if (!isNonEmptyString(idea.strategy)) errors.push(`${at}.strategy must be a non-empty string`);
    if (!isNonEmptyString(idea.thesis)) errors.push(`${at}.thesis must be a non-empty string`);
    if (!isFiniteNumber(idea.pop) || idea.pop < 0 || idea.pop > 1) {
      errors.push(`${at}.pop must be a number in [0,1]`);
    }
    if (!isFiniteNumber(idea.maxLossUsd) || idea.maxLossUsd <= 0) {
      errors.push(`${at}.maxLossUsd must be a number > 0 (defined-risk only)`);
    }
    if (!isFiniteNumber(idea.dteDays) || idea.dteDays < 0) {
      errors.push(`${at}.dteDays must be a number ≥ 0`);
    }
    if (idea.eventContext !== undefined) {
      if (!Array.isArray(idea.eventContext) || !idea.eventContext.every((e) => typeof e === 'string')) {
        errors.push(`${at}.eventContext must be an array of strings when present`);
      }
    }
  });
  return errors;
}

// ── prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are the Head of Options Research for a disciplined, swing/positional desk.',
  'You DO NOT predict winners. You are a synthesis layer over real data: option-chain',
  'mispricing from our scanners, IV-rank, earnings and Fed/economic event proximity, and',
  'news sentiment. Your edge is IV-rank-aware DEFINED-RISK structures + event discipline',
  '(avoid getting long premium into earnings IV-crush; trade events with spreads) + the',
  'relative-value mispricing we already detect.',
  '',
  'HARD RULES — violations are discarded:',
  '1. DEFINED RISK ONLY. Allowed strategies (use these exact ids): long_call, long_put,',
  '   bull_call_spread, bear_put_spread, bull_put_spread, bear_call_spread, iron_condor,',
  '   iron_butterfly, call_calendar, put_calendar. Never propose naked/short single legs,',
  '   short straddles/strangles, or anything with unbounded loss.',
  '2. NO DAY TRADING. Every idea must use an expiration at or beyond the minimum DTE you',
  '   are given. Never propose 0DTE or sub-minimum-DTE ideas.',
  '3. Only trade tickers present in the supplied universe.',
  '4. maxLossUsd is the DEFINED dollar loss per 1-lot (100 multiplier). It must be > 0.',
  '5. pop is your honest probability-of-profit estimate at expiry, 0..1, grounded in the',
  '   data given (delta, mispricing, IV-rank). When IV-rank is unknown, do not claim an IV edge.',
  '',
  'When IV-rank is HIGH, prefer net-credit defined-risk structures (sell rich premium with a',
  'capped wing). When IV-rank is LOW, prefer net-debit structures. Around earnings/FOMC,',
  'prefer spreads over long single options to blunt IV-crush.',
  '',
  'Return ONLY a JSON object, no prose, of the form:',
  '{ "ideas": [ { "ticker": str, "strategy": str, "thesis": str, "pop": num(0..1),',
  '  "maxLossUsd": num>0, "dteDays": int, "eventContext": [str] } ] }',
  'Rank best-first. Keep theses concise and tied to the data. If nothing clears the bar,',
  'return { "ideas": [] }.',
].join('\n');

function buildUserPrompt(input: OptionsResearchInput, guardrail: DayTradingGuardrail, maxIdeas: number): string {
  const universe = input.symbols.map((s) => s.symbol).join(', ');
  const payload = {
    asOf: new Date(input.asOf).toISOString(),
    minDteDays: guardrail.minDteDays,
    maxIdeas,
    universe: input.symbols.map((s) => ({
      symbol: s.symbol,
      spot: s.spot,
      ivRank: s.ivRank,
      nextEarningsInDays: s.nextEarningsInDays,
      daysToFOMC: s.daysToFOMC,
      macroEventsNearby: s.macroEventsNearby,
      newsSentiment: s.newsSentiment,
      candidates: s.candidates.map((c) => ({
        optionSymbol: c.optionSymbol,
        optionType: c.optionType,
        strike: c.strike,
        expiration: c.expiration,
        dte: c.daysToExpiration,
        mark: c.mark,
        iv: c.ivUsed,
        delta: c.delta,
        classification: c.classification,
        mispricingPct: c.mispricingPct,
        source: c.source,
      })),
    })),
  };
  return [
    `Universe: ${universe}.`,
    `Minimum DTE (no day trading): ${guardrail.minDteDays}. Return at most ${maxIdeas} ranked ideas.`,
    'Fused per-symbol data follows as JSON:',
    JSON.stringify(payload),
  ].join('\n');
}

// ── guardrail enforcement ─────────────────────────────────────────────────────

interface RawIdea {
  ticker: string;
  strategy: string;
  thesis: string;
  pop: number;
  maxLossUsd: number;
  dteDays: number;
  eventContext?: string[];
}

/**
 * Deterministic post-LLM gate. Drops any proposed idea that is not in the
 * defined-risk allowlist, falls below the C3 minimum DTE, or names a ticker
 * outside the supplied universe. Survivors are re-sorted best-first (POP desc,
 * then smaller max-loss) and renumbered, then truncated to `maxIdeas`. This is
 * the line that makes the acceptance guarantee — every RETURNED idea is
 * defined-risk and clears the guardrail — independent of what the model said.
 */
function enforceGuardrail(
  raw: RawIdea[],
  input: OptionsResearchInput,
  guardrail: DayTradingGuardrail,
  maxIdeas: number,
): { ideas: OptionsIdea[]; rejected: RejectedIdea[] } {
  const universe = new Set(input.symbols.map((s) => s.symbol.toUpperCase()));
  const kept: OptionsIdea[] = [];
  const rejected: RejectedIdea[] = [];

  for (const r of raw) {
    const ticker = r.ticker.trim().toUpperCase();
    const reasons: string[] = [];
    if (!universe.has(ticker)) reasons.push(`ticker ${ticker} not in universe`);
    if (guardrail.definedRiskOnly && !isDefinedRiskStrategy(r.strategy)) {
      reasons.push(`strategy "${r.strategy}" is not defined-risk`);
    }
    if (r.dteDays < guardrail.minDteDays) {
      reasons.push(`dteDays ${r.dteDays} < minDteDays ${guardrail.minDteDays} (day-trade guardrail)`);
    }
    if (reasons.length > 0) {
      rejected.push({
        idea: { ticker, strategy: r.strategy as DefinedRiskStrategy, thesis: r.thesis, pop: r.pop, maxLossUsd: r.maxLossUsd, dteDays: r.dteDays },
        reasons,
      });
      continue;
    }
    kept.push({
      ticker,
      strategy: r.strategy as DefinedRiskStrategy,
      thesis: r.thesis.trim(),
      pop: r.pop,
      maxLossUsd: r.maxLossUsd,
      dteDays: r.dteDays,
      eventContext: r.eventContext ?? [],
      rank: 0,
    });
  }

  kept.sort((a, b) => (b.pop !== a.pop ? b.pop - a.pop : a.maxLossUsd - b.maxLossUsd));
  const ideas = kept.slice(0, maxIdeas).map((idea, i) => ({ ...idea, rank: i + 1 }));
  return { ideas, rejected };
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Run the Head of Options Research pass over a fused batch and return ranked,
 * defined-risk ideas. Makes at most ONE LLM call (retried only on malformed
 * output via `completeJson`), short-circuits to $0 when there is nothing to
 * research, and serves from `deps.cache` when an identical batch was already
 * researched today.
 */
export async function runOptionsResearch(
  input: OptionsResearchInput,
  deps: OptionsResearchDeps,
): Promise<OptionsResearchResult> {
  const guardrail = input.guardrail ?? DEFAULT_OPTIONS_GUARDRAIL;
  const maxIdeas = Math.max(1, input.maxIdeas ?? 5);

  // Nothing to research → no spend, no call.
  const hasCandidates = input.symbols.some((s) => s.candidates.length > 0);
  if (input.symbols.length === 0 || !hasCandidates) {
    return { ideas: [], costUsd: 0, attempts: 0, rejected: [], cached: false };
  }

  const key = optionsResearchBatchKey(input);
  const cached = deps.cache?.get(key);
  if (cached) {
    return { ...cached, cached: true };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(input, guardrail, maxIdeas) },
  ];

  const completion: CompleteJsonResult<RawIdeaBatch> = await completeJson<RawIdeaBatch>(
    deps.llm,
    { tier: 'strong', purpose: 'options-research', messages, temperature: 0.2 },
    { validate: validateOptionsIdeaBatch, maxAttempts: deps.maxAttempts ?? 3 },
  );

  const { ideas, rejected } = enforceGuardrail(
    completion.value.ideas as RawIdea[],
    input,
    guardrail,
    maxIdeas,
  );

  const result: OptionsResearchResult = {
    ideas,
    costUsd: completion.costUsd,
    attempts: completion.attempts,
    rejected,
    cached: false,
  };
  deps.cache?.set(key, result);
  return result;
}
