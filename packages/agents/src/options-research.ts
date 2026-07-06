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
import { DAY_TRADING_GUARDRAIL, type OptionType } from '@trading-app/shared';
import { completeJson, type CompleteJsonResult, type LlmClient, type LlmMessage } from './llm-client.js';

/**
 * The capped-loss strategies. Anything outside this allowlist (naked/short single
 * legs, short straddles/strangles, ratio spreads) is rejected by the guardrail —
 * the whole product is defined-risk only.
 *
 * Two ways a strategy can be capped-loss:
 *   (a) defined by an offsetting long option / net debit (the long-premium and
 *       spread families — what the LLM ideas pass may EMIT), and
 *   (b) TRA-1322 — defined by COLLATERAL: cash-secured / stock-covered short
 *       legs. These are covered, NOT naked, and are managed by the put-write
 *       sleeve; they are classified defined-risk here but are NOT surfaced as
 *       LLM ideas (see `COVERED_STRATEGIES` / the ideas-feed gate below).
 *
 *   • long_call / long_put — debit, max loss = premium paid.
 *   • bull_call_spread / bear_put_spread — debit vertical, max loss = net debit.
 *   • bull_put_spread / bear_call_spread — credit vertical, max loss = width − credit.
 *   • iron_condor / iron_butterfly — two credit verticals, max loss = wing width − credit.
 *   • call_calendar / put_calendar — debit calendar, max loss = net debit.
 *   • cash_secured_put — short put, fully cash-collateralized; max loss = (strike − credit) × 100.
 *   • covered_call — short call against owned/assigned stock; the stock covers assignment.
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
  | 'put_calendar'
  | CoveredStrategy;

/**
 * TRA-1322 — the wheel / put-write sleeve's collateral-covered short legs. These
 * are defined-risk by construction (cash-secured put: cash held against the
 * strike; covered call: stock held against assignment) — the "not naked"
 * distinction item 5 requires. They are sleeve-managed, not LLM-emittable.
 */
export type CoveredStrategy = 'cash_secured_put' | 'covered_call';

export const COVERED_STRATEGIES: ReadonlySet<string> = new Set<CoveredStrategy>([
  'cash_secured_put',
  'covered_call',
]);

/** The long-premium / spread families the LLM ideas pass is allowed to EMIT. */
export const LLM_EMITTABLE_STRATEGIES: ReadonlySet<string> = new Set<Exclude<DefinedRiskStrategy, CoveredStrategy>>([
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

/**
 * Every defined-risk strategy has a finite, known max loss by construction —
 * whether by an offsetting long leg (the emittable families) or by collateral
 * (the covered families). This is the classifier item 5 asks to "treat the
 * CSP + covered-call pair as defined-risk".
 */
export const DEFINED_RISK_STRATEGIES: ReadonlySet<string> = new Set<string>([
  ...LLM_EMITTABLE_STRATEGIES,
  ...COVERED_STRATEGIES,
]);

/** True for collateral-covered short legs (cash-secured put / covered call). */
export function isCoveredStrategy(strategy: string): strategy is CoveredStrategy {
  return COVERED_STRATEGIES.has(strategy);
}

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
  /**
   * Which scanner surfaced it (provenance for the thesis). `atm_seed` (TRA-895)
   * is NOT a scanner anomaly: it is a near-ATM anchor seeded on liquid names when
   * neither scanner flagged a mispricing, so the research pass can still propose
   * event/thesis-driven defined-risk structures on calm days. A seed carries
   * `classification: 'fair'` and `mispricingPct: 0` — the model must NOT claim a
   * mispricing edge from it and must lean on IV-rank / event proximity instead.
   */
  source: 'relative_value' | 'otm_mispricing' | 'atm_seed';
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
  /**
   * TRA-846 — coarse sector bucket (e.g. "Technology", "Financials") for the
   * diversification guardrail. `null`/absent when the caller can't resolve one;
   * the ranker then treats the ticker as its own bucket (no false clustering) and
   * leans on the model's own sector knowledge from the prompt instead.
   */
  sector?: string | null;
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

/**
 * Idea-gen guardrail defaults. `minDteDays` is sourced from the C3 central
 * config block (`DAY_TRADING_GUARDRAIL.minIdeaDteDays`, TRA-598) so idea-gen and
 * the order-time paths share one source of truth — it matches the live scanner
 * window floor (21–60 DTE; TRA-373/TRA-595 §3).
 */
export const DEFAULT_OPTIONS_GUARDRAIL: DayTradingGuardrail = {
  minDteDays: DAY_TRADING_GUARDRAIL.minIdeaDteDays,
  definedRiskOnly: true,
};

/**
 * TRA-846 — catalyst horizon a returned idea sits in, derived deterministically
 * from the soonest scheduled catalyst (earnings/FOMC) for its underlying, or the
 * idea's own DTE when there is no near catalyst:
 *   • near   — catalyst within `nearMaxDays`
 *   • medium — catalyst within `mediumMaxDays`
 *   • long   — no near catalyst / longer-dated thesis
 */
export type CatalystHorizon = 'near' | 'medium' | 'long';

/**
 * TRA-846 — the idea-ranker diversification guardrail. Applied deterministically
 * AFTER the defined-risk / DTE guardrail so the surfaced slate is spread across
 * catalyst horizons and sectors rather than clustering (e.g. an all-earnings-week,
 * all-mega-cap-Tech book). Pure re-ranking — no new infra, no new LLM call.
 */
export interface DiversificationPolicy {
  /** Max ideas allowed to share one sector bucket in the returned slate. */
  maxPerSector: number;
  /** Collapse multiple ideas riding the SAME underlying's upcoming earnings to one (best-scored wins). */
  dedupeEarningsEvent: boolean;
  /** A catalyst ≤ this many days out is "near". */
  nearMaxDays: number;
  /** A catalyst ≤ this many days out (and > nearMaxDays) is "medium"; beyond is "long". */
  mediumMaxDays: number;
}

/**
 * Diversification defaults. Two ideas per sector, one per earnings event, and a
 * near/medium/long split at 14d / 35d (the 35d upper edge ~ the live 21–60 DTE
 * window midpoint, so a swing idea with no nearer catalyst reads as "long").
 */
export const DEFAULT_DIVERSIFICATION: DiversificationPolicy = {
  maxPerSector: 2,
  dedupeEarningsEvent: true,
  nearMaxDays: 14,
  mediumMaxDays: 35,
};

export interface OptionsResearchInput {
  /** Decision bar — every fused input is timestamped at/before this. */
  asOf: number;
  symbols: OptionsResearchSymbol[];
  /** Max ideas to return after ranking. Default 5. */
  maxIdeas?: number;
  /** The C3 guardrail. Defaults to {@link DEFAULT_OPTIONS_GUARDRAIL}. */
  guardrail?: DayTradingGuardrail;
  /** TRA-846 diversification guardrail. Defaults to {@link DEFAULT_DIVERSIFICATION}. */
  diversification?: DiversificationPolicy;
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
  /** TRA-846 — catalyst horizon bucket this idea sits in (near/medium/long). */
  catalystHorizon: CatalystHorizon;
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
  const d = input.diversification ?? DEFAULT_DIVERSIFICATION;
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
        s.sector ?? '_',
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
    `div${d.maxPerSector}:${d.dedupeEarningsEvent ? 1 : 0}:${d.nearMaxDays}:${d.mediumMaxDays}`,
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
  'CANDIDATE PROVENANCE. Each candidate carries a `source`: `relative_value` / `otm_mispricing`',
  'are real scanner anomalies (`mispricingPct` is meaningful). `source: "atm_seed"` is NOT an',
  'anomaly — it is a near-ATM anchor we seeded on a liquid name because no mispricing was flagged.',
  'For a seed, `mispricingPct` is 0 and `classification` is "fair": do NOT invent a mispricing edge',
  'from it. You may still build a defined-risk idea around a seed when IV-rank and/or a scheduled',
  'event (earnings/FOMC/macro) supports a thesis; otherwise leave that name out. Quality over',
  'quantity — a thin or eventless name with only a seed and unknown IV-rank is a pass, not a forced idea.',
  '',
  'When IV-rank is HIGH, prefer net-credit defined-risk structures (sell rich premium with a',
  'capped wing). When IV-rank is LOW, prefer net-debit structures. Around earnings/FOMC,',
  'prefer spreads over long single options to blunt IV-crush.',
  '',
  'DIVERSIFICATION — build a SPREAD slate, not a clustered one:',
  '6. Spread ideas across catalyst horizons. Use the soonest scheduled catalyst for each name',
  '   (earnings / FOMC / macro print) to gauge horizon: NEAR (catalyst within ~2 weeks),',
  '   MEDIUM (~2–5 weeks), LONG (no near catalyst / a longer-dated thesis). Do NOT return an',
  '   all-earnings-week book — mix the horizons when the data supports it.',
  '7. Spread ideas across sectors. The `sector` field is given when known; otherwise use your own',
  '   knowledge of each ticker. Avoid concentrating the slate in a single sector (e.g. all mega-cap Tech).',
  '8. DE-DUPE earnings events: never return more than ONE idea riding the same underlying\'s upcoming',
  '   earnings. Pick the single best structure for that event and drop the rest.',
  'A diversification re-rank is applied deterministically after you answer, so a clustered slate',
  'will be thinned — give a spread of your strongest distinct ideas, ranked best-first.',
  '',
  'Return ONLY a JSON object, no prose, of the form:',
  '{ "ideas": [ { "ticker": str, "strategy": str, "thesis": str, "pop": num(0..1),',
  '  "maxLossUsd": num>0, "dteDays": int, "eventContext": [str] } ] }',
  'Rank best-first. Keep theses concise and tied to the data. If nothing clears the bar,',
  'return { "ideas": [] }.',
].join('\n');

function buildUserPrompt(
  input: OptionsResearchInput,
  guardrail: DayTradingGuardrail,
  maxIdeas: number,
  diversification: DiversificationPolicy,
): string {
  const universe = input.symbols.map((s) => s.symbol).join(', ');
  const payload = {
    asOf: new Date(input.asOf).toISOString(),
    minDteDays: guardrail.minDteDays,
    maxIdeas,
    diversification: {
      maxPerSector: diversification.maxPerSector,
      nearMaxDays: diversification.nearMaxDays,
      mediumMaxDays: diversification.mediumMaxDays,
      dedupeEarningsEvent: diversification.dedupeEarningsEvent,
    },
    universe: input.symbols.map((s) => ({
      symbol: s.symbol,
      sector: s.sector ?? null,
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
    `Diversify: at most ${diversification.maxPerSector} ideas per sector, one idea per earnings event,`,
    `and spread across near (<=${diversification.nearMaxDays}d) / medium (<=${diversification.mediumMaxDays}d) / long catalyst horizons.`,
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
 * TRA-846 — classify an idea's catalyst horizon from its underlying's soonest
 * scheduled catalyst (earnings or FOMC). With no near catalyst we fall back to
 * the idea's own DTE, so a longer-dated swing thesis reads as "long".
 */
function classifyHorizon(
  sym: OptionsResearchSymbol | undefined,
  dteDays: number,
  policy: DiversificationPolicy,
): CatalystHorizon {
  const catalysts: number[] = [];
  if (sym) {
    if (sym.nextEarningsInDays != null && sym.nextEarningsInDays >= 0) catalysts.push(sym.nextEarningsInDays);
    if (sym.daysToFOMC != null && sym.daysToFOMC >= 0) catalysts.push(sym.daysToFOMC);
  }
  const ref = catalysts.length > 0 ? Math.min(...catalysts) : dteDays;
  if (ref <= policy.nearMaxDays) return 'near';
  if (ref <= policy.mediumMaxDays) return 'medium';
  return 'long';
}

/**
 * Sector bucket for the per-sector cap. A known sector groups names together; an
 * unknown sector falls back to a per-ticker bucket so unmapped names are NOT
 * falsely clustered into one giant "unknown" sector that the cap would over-thin.
 */
function sectorKeyFor(sym: OptionsResearchSymbol | undefined, ticker: string): string {
  const sector = sym?.sector?.trim();
  return sector ? `S:${sector.toUpperCase()}` : `U:${ticker}`;
}

/** Earnings-event key: the underlying, but only when it has an upcoming earnings to de-dupe on. */
function earningsKeyFor(sym: OptionsResearchSymbol | undefined, ticker: string): string | null {
  if (!sym || sym.nextEarningsInDays == null || sym.nextEarningsInDays < 0) return null;
  return `E:${ticker}`;
}

interface ScoredIdea {
  idea: OptionsIdea;
  sectorKey: string;
  horizon: CatalystHorizon;
  earningsKey: string | null;
}

/**
 * Deterministic post-LLM gate. Two stages:
 *
 *   1. HARD guardrail (the acceptance guarantee). Drops any proposed idea that
 *      is not in the defined-risk allowlist, falls below the C3 minimum DTE, or
 *      names a ticker outside the supplied universe. Every RETURNED idea is
 *      defined-risk and clears the guardrail, independent of what the model said.
 *
 *   2. TRA-846 DIVERSIFICATION re-rank over the survivors (POP desc, then smaller
 *      max-loss as the base score): de-dupe ideas riding the same earnings event,
 *      then greedily select up to `maxIdeas` while covering near/medium/long
 *      catalyst horizons and capping ideas per sector. Always takes the
 *      best-scored eligible idea, so within a horizon/sector the ranking is still
 *      score order. Ideas thinned by the re-rank are recorded in `rejected` for
 *      audit. Pure re-ranking — no new infra, no extra LLM call.
 */
function enforceGuardrail(
  raw: RawIdea[],
  input: OptionsResearchInput,
  guardrail: DayTradingGuardrail,
  maxIdeas: number,
  policy: DiversificationPolicy,
): { ideas: OptionsIdea[]; rejected: RejectedIdea[] } {
  const symByTicker = new Map<string, OptionsResearchSymbol>();
  for (const s of input.symbols) symByTicker.set(s.symbol.toUpperCase(), s);
  const universe = new Set(symByTicker.keys());
  const kept: ScoredIdea[] = [];
  const rejected: RejectedIdea[] = [];

  for (const r of raw) {
    const ticker = r.ticker.trim().toUpperCase();
    const reasons: string[] = [];
    if (!universe.has(ticker)) reasons.push(`ticker ${ticker} not in universe`);
    if (guardrail.definedRiskOnly && !isDefinedRiskStrategy(r.strategy)) {
      reasons.push(`strategy "${r.strategy}" is not defined-risk`);
    }
    // TRA-1322 — covered structures (cash_secured_put / covered_call) are
    // defined-risk by collateral but are managed by the put-write sleeve, not
    // surfaced as LLM ideas. Keep the ideas feed to the long-premium/spread
    // families so widening the defined-risk classifier can't leak a short leg
    // into the (paper-only) ideas → paper-enter path.
    else if (guardrail.definedRiskOnly && isCoveredStrategy(r.strategy)) {
      reasons.push(`strategy "${r.strategy}" is sleeve-managed, not an LLM idea`);
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
    const sym = symByTicker.get(ticker);
    const horizon = classifyHorizon(sym, r.dteDays, policy);
    kept.push({
      idea: {
        ticker,
        strategy: r.strategy as DefinedRiskStrategy,
        thesis: r.thesis.trim(),
        pop: r.pop,
        maxLossUsd: r.maxLossUsd,
        dteDays: r.dteDays,
        eventContext: r.eventContext ?? [],
        catalystHorizon: horizon,
        rank: 0,
      },
      sectorKey: sectorKeyFor(sym, ticker),
      horizon,
      earningsKey: earningsKeyFor(sym, ticker),
    });
  }

  // Base score: POP desc, then smaller max-loss.
  kept.sort((a, b) =>
    b.idea.pop !== a.idea.pop ? b.idea.pop - a.idea.pop : a.idea.maxLossUsd - b.idea.maxLossUsd,
  );

  // Stage 2a — earnings-event de-dupe (best-scored idea per event wins).
  const seenEarnings = new Set<string>();
  const deduped: ScoredIdea[] = [];
  for (const s of kept) {
    if (policy.dedupeEarningsEvent && s.earningsKey) {
      if (seenEarnings.has(s.earningsKey)) {
        rejected.push({
          idea: { ...s.idea, rank: 0 },
          reasons: [`duplicate ${s.idea.ticker} earnings event (a higher-ranked idea already trades it)`],
        });
        continue;
      }
      seenEarnings.add(s.earningsKey);
    }
    deduped.push(s);
  }

  // Stage 2b — diversity-aware greedy selection (horizon spread + per-sector cap).
  const used = new Array<boolean>(deduped.length).fill(false);
  const sectorCount = new Map<string, number>();
  const coveredHorizons = new Set<CatalystHorizon>();
  const selected: ScoredIdea[] = [];
  const underCap = (i: number): boolean =>
    (sectorCount.get(deduped[i]!.sectorKey) ?? 0) < policy.maxPerSector;
  const take = (i: number): void => {
    used[i] = true;
    const s = deduped[i]!;
    sectorCount.set(s.sectorKey, (sectorCount.get(s.sectorKey) ?? 0) + 1);
    coveredHorizons.add(s.horizon);
    selected.push(s);
  };
  while (selected.length < maxIdeas) {
    let pick = -1;
    // A: best idea that opens a not-yet-covered horizon AND keeps its sector under cap.
    for (let i = 0; i < deduped.length; i++) {
      if (!used[i] && underCap(i) && !coveredHorizons.has(deduped[i]!.horizon)) { pick = i; break; }
    }
    // B: else best idea whose sector is still under cap.
    if (pick < 0) for (let i = 0; i < deduped.length; i++) if (!used[i] && underCap(i)) { pick = i; break; }
    // C: else best remaining (sector cap relaxed only to fill the slate).
    if (pick < 0) for (let i = 0; i < deduped.length; i++) if (!used[i]) { pick = i; break; }
    if (pick < 0) break;
    take(pick);
  }

  // Audit: survivors thinned by the diversification re-rank (beyond maxIdeas / sector spread).
  for (let i = 0; i < deduped.length; i++) {
    if (!used[i]) {
      rejected.push({
        idea: { ...deduped[i]!.idea, rank: 0 },
        reasons: ['dropped by diversification re-rank (beyond maxIdeas / sector spread)'],
      });
    }
  }

  const ideas = selected.map((s, i) => ({ ...s.idea, rank: i + 1 }));
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
  const diversification = input.diversification ?? DEFAULT_DIVERSIFICATION;
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
    { role: 'user', content: buildUserPrompt(input, guardrail, maxIdeas, diversification) },
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
    diversification,
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
