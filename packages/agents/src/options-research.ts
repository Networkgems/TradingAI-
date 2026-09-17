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
import {
  evaluateIdeasExpectancyShadow,
  resolveExpectancyGateConfig,
  type IdeaExpectancyShadow,
} from './options-ideas-expectancy-gate.js';
import {
  creditWidthRatioOf,
  evaluateCreditWidthFloor,
  evaluateIdeasCreditWidthFloor,
  resolveCreditWidthFloorConfig,
  type CreditWidthFloorConfig,
  type CreditWidthFloorShadow,
} from './options-idea-credit-width-floor.js';
import {
  debitRetirementPromptAddendum,
  isCreditClassStrategy,
  isDebitSleeveRetirementEnabled,
} from './options-debit-retirement.js';

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

// ── TRA-1974 event-IV "sell the crush" ────────────────────────────────────────
//
// The deterministic teeth of the D3 rule: when a scheduled catalyst sits INSIDE
// an idea's expiry and IV is elevated, a net-long-vega DEBIT single-leg
// (long_call / long_put) is exactly what the post-event IV crush punishes. We
// drop those ideas post-model and let a defined-risk CREDIT structure surface
// instead. This mirrors the engine's `selectStructureByIv` / `preferCreditForEvent`
// rule (packages/engine/src/options/supertrend-options.ts) — the agents package is
// deliberately decoupled from the engine, so the threshold is mirrored here, not
// imported. Keep the two in sync (both = 50, below the 60 vertical-IV cutoff).

/**
 * TRA-1974 — event-IV "sell-the-crush" min IV-rank. A scheduled catalyst lowers
 * the bar for going credit vs the plain high-IV cutoff, because the post-event
 * vol collapse is the specific, dated risk the rule exists to dodge. Mirrors
 * `DEFAULT_IV_GATE.eventIvMinRank` in `@trading-app/engine`.
 */
export const EVENT_IV_MIN_RANK = 50;

/** The net-long-vega debit single-legs the IV crush hurts most. */
export const LONG_VEGA_DEBIT_SINGLE_LEGS: ReadonlySet<string> = new Set(['long_call', 'long_put']);

/** A catalyst `daysAway` sits inside a `dte`-day expiry when 0 ≤ daysAway ≤ dte. */
function catalystInsideExpiry(daysAway: number | null | undefined, dte: number): boolean {
  return daysAway != null && Number.isFinite(daysAway) && daysAway >= 0 && daysAway <= dte;
}

/**
 * TRA-1974 — is the event-IV "sell-the-crush" rule active for an idea on `sym`
 * with `dteDays` to expiry? True when IV is elevated (`ivRank >= EVENT_IV_MIN_RANK`)
 * AND a scheduled catalyst sits INSIDE the chosen expiry — earnings (primary) or
 * FOMC (secondary). Pure; unknown IV-rank, missing symbol, or no in-window
 * catalyst → false (no fabricated edge). This is the same read
 * (`ivRank` + `nextEarningsInDays` / `daysToFOMC`) the server fusion attaches to
 * each symbol, now consumed as a deterministic rule rather than only an LLM badge.
 */
export function sellTheCrushActive(sym: OptionsResearchSymbol | undefined, dteDays: number): boolean {
  if (!sym || sym.ivRank == null || !Number.isFinite(sym.ivRank) || sym.ivRank < EVENT_IV_MIN_RANK) {
    return false;
  }
  return catalystInsideExpiry(sym.nextEarningsInDays, dteDays) || catalystInsideExpiry(sym.daysToFOMC, dteDays);
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
  /**
   * TRA-4644 — IV PERCENTILE 0–100 (fraction of trailing sessions whose IV
   * closed strictly below today's), the distinct sibling statistic to `ivRank`
   * off the SAME store and window. READ-ONLY CARRIER for the published feed:
   * deliberately excluded from both the user-prompt payload (`buildUserPrompt`'s
   * explicit projection — the model must not see a field nothing may gate on;
   * ranking/gating on it is a TRA-3392 §6 pre-registration) and the batch cache
   * key (`optionsResearchBatchKey` — a value the model never sees must not bust
   * the cache). Optional so pre-TRA-4644 fixtures stay valid; absent ≡ null.
   */
  ivPercentile?: number | null;
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
  /**
   * TRA-2005 — net credit received per 1-lot in USD (= credit·100), for net-credit
   * structures. Optional: absent on debit families and on any credit idea the model
   * didn't price. With `maxLossUsd` (= (width − credit)·100) this fully prices the
   * spread for the positive-expectancy gate (`credit/(width−credit) = creditUsd/maxLossUsd`).
   */
  creditUsd?: number;
  /**
   * TRA-2208 — short-leg |delta| the model targeted for a credit vertical, 0..1.
   * Optional and advisory: it is recorded so the 0.20–0.30 band's effect on the
   * book is gradeable, and never gates emission on its own. Emitted only when the
   * credit/width floor flag states the band in the prompt contract.
   */
  shortDelta?: number;
  /**
   * TRA-2208 — realized `creditUsd / (creditUsd + maxLossUsd)` for a credit
   * vertical, stamped so the ratio the whole diagnosis turns on is gradeable
   * without re-deriving it downstream. Present ONLY when the credit/width floor
   * flag is on and the idea priced a credit; absent otherwise (flag off ⇒ the
   * emitted record is byte-for-byte the old shape).
   */
  creditWidthRatio?: number;
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
  /**
   * TRA-2005 — SHADOW-only positive-expectancy + IVR/credit-width verdicts over the
   * surfaced slate. Present ONLY when the gate flag is on; the slate itself is
   * unchanged (records what the gate WOULD drop, never acts). Absent = flag off.
   */
  expectancyShadow?: IdeaExpectancyShadow;
  /**
   * TRA-2208 — PRE-floor credit/width ledger over the ideas the model PROPOSED,
   * scored before the hard floor thinned them. Present ONLY when
   * `ENABLE_OPTIONS_IDEA_CREDIT_WIDTH_FLOOR` is on; absent = flag off = the floor
   * removed nothing and the emitted record is unchanged. Unlike the TRA-2005
   * expectancy shadow this is NOT a counterfactual: when it is present the floor
   * really did remove the `reject`/`unpriced` entries from `ideas`.
   */
  creditWidthFloorShadow?: CreditWidthFloorShadow;
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
    // TRA-2005 — creditUsd is OPTIONAL (only credit structures carry it); when
    // present it must be a positive net credit. A bad/absent value simply leaves
    // the idea 'unpriced' for the shadow expectancy gate, never a batch retry.
    if (idea.creditUsd !== undefined && (!isFiniteNumber(idea.creditUsd) || idea.creditUsd <= 0)) {
      errors.push(`${at}.creditUsd must be a number > 0 when present`);
    }
    // TRA-2208 — shortDelta is OPTIONAL and advisory. The model is only asked for
    // it when the credit/width floor flag states the delta band, so with the flag
    // off it is never emitted and this branch never fires. A bad value is a real
    // schema error (unlike an absent one) because a delta outside [0,1] means the
    // model misunderstood the field rather than declined to answer it.
    if (idea.shortDelta !== undefined) {
      const d = idea.shortDelta;
      if (!isFiniteNumber(d) || Math.abs(d) > 1) {
        errors.push(`${at}.shortDelta must be a number in [-1,1] when present`);
      }
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
  '   For a NET-CREDIT vertical, maxLossUsd = (width − credit) × 100. Also emit creditUsd = the',
  '   net credit received per 1-lot × 100 (so creditUsd + maxLossUsd = width × 100). creditUsd is',
  '   REQUIRED for credit structures (bull_put_spread / bear_call_spread / iron_condor /',
  '   iron_butterfly) and omitted for debit / long-premium structures.',
  '5. pop is your honest probability-of-profit estimate at expiry, 0..1, grounded in the',
  '   data given (delta, mispricing, IV-rank). When IV-rank is unknown, do not claim an IV edge.',
  '6. SELL THE CRUSH (event-IV, HARD). When a symbol carries `sellTheCrush: true` — a scheduled',
  '   catalyst (earnings, primary; FOMC, secondary) lands at/inside a tradeable expiry AND ivRank >= 50',
  '   — DO NOT propose long_call or long_put on it: a long-premium debit gets IV-crushed on the',
  '   post-event vol collapse. Use a defined-risk NET-CREDIT structure instead (bull_put_spread /',
  '   bear_call_spread / iron_condor / iron_butterfly), keeping your directional lean. A long single-leg',
  '   debit on a sell-the-crush name is DISCARDED deterministically after you answer — spend the slot on a',
  '   credit structure.',
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
  '7. Spread ideas across catalyst horizons. Use the soonest scheduled catalyst for each name',
  '   (earnings / FOMC / macro print) to gauge horizon: NEAR (catalyst within ~2 weeks),',
  '   MEDIUM (~2–5 weeks), LONG (no near catalyst / a longer-dated thesis). Do NOT return an',
  '   all-earnings-week book — mix the horizons when the data supports it.',
  '8. Spread ideas across sectors. The `sector` field is given when known; otherwise use your own',
  '   knowledge of each ticker. Avoid concentrating the slate in a single sector (e.g. all mega-cap Tech).',
  '9. DE-DUPE earnings events: never return more than ONE idea riding the same underlying\'s upcoming',
  '   earnings. Pick the single best structure for that event and drop the rest.',
  'A diversification re-rank is applied deterministically after you answer, so a clustered slate',
  'will be thinned — give a spread of your strongest distinct ideas, ranked best-first.',
  '',
  'Return ONLY a JSON object, no prose, of the form:',
  '{ "ideas": [ { "ticker": str, "strategy": str, "thesis": str, "pop": num(0..1),',
  '  "maxLossUsd": num>0, "creditUsd": num>0 (credit structures only), "dteDays": int,',
  '  "eventContext": [str] } ] }',
  'Rank best-first. Keep theses concise and tied to the data. If nothing clears the bar,',
  'return { "ideas": [] }.',
].join('\n');

/**
 * TRA-2208 — the credit/width floor + short-strike delta band, appended to the
 * system prompt ONLY when the floor flag is on. Kept as an addendum rather than
 * edited into {@link SYSTEM_PROMPT} so the flag-off prompt is the same string it
 * has always been — the cache key, the token count and the model's answer are all
 * unchanged when the floor is off.
 *
 * It states the band AND the reason for it. An unconstrained model asked to
 * maximise POP sells far OTM where the premium is a rounding error; telling it the
 * economics (below ~0.20 delta the premium does not clear our fee base) is what
 * stops it optimising the wrong number. The floor is ALSO enforced deterministically
 * after the answer — this addendum is what lets the model comply rather than be
 * silently thinned.
 *
 * TRA-2681 — RULE 13 MUST STATE THE WIDTH CEILING, or the addendum guarantees the
 * silent thinning it exists to prevent. `credit/width` is the width-AVERAGED dual
 * delta, so it falls strictly as the spread widens: a short strike sitting inside
 * the mandated 0.20–0.30 band fails the 0.20 floor past ~2 points of width (see
 * `options-idea-credit-width-floor.ts`). Rules 10, 11 and 13 were jointly
 * near-infeasible at the band bottom — rule 11 pins delta, rule 13 said "widen",
 * and widening is exactly what drives `c` under the floor and gets the idea
 * discarded. The model was never told a width ceiling existed, so it could not
 * comply. Rule 13 now names the real lever: DELTA buys width capacity, width does
 * not buy itself. Rule 10's anti-gaming clause was also pointed the wrong way — it
 * forbade widening, which cannot inflate `c` (it destroys it); NARROWING is the
 * gaming direction, and that is what rule 10 now prohibits.
 */
export function creditWidthFloorPromptAddendum(config: CreditWidthFloorConfig): string {
  const floorPct = (config.minCreditWidth * 100).toFixed(0);
  return [
    'CREDIT-VERTICAL PREMIUM FLOOR (HARD — violations are discarded):',
    `10. Any bull_put_spread / bear_call_spread / iron_condor / iron_butterfly must collect a NET`,
    `    CREDIT of at least ${config.minCreditWidth.toFixed(2)} of its spread width — i.e.`,
    `    creditUsd / (creditUsd + maxLossUsd) >= ${config.minCreditWidth.toFixed(2)}. An idea below that`,
    `    floor is DISCARDED after you answer; do not propose one. Do NOT narrow the spread to fake`,
    `    it: a razor-thin spread clears the ratio while collecting almost nothing in DOLLARS, which`,
    `    is the failure mode, not a fix. Pick a strike that genuinely pays ${floorPct}% of width at a`,
    `    real width, or leave the name out.`,
    `11. Target the SHORT leg at ${config.shortDeltaMin.toFixed(2)}–${config.shortDeltaMax.toFixed(2)} delta.`,
    `    Each candidate carries its own \`delta\`, so use it. WHY: below ~${config.shortDeltaMin.toFixed(2)} delta the`,
    '    premium collected does not clear transaction costs at our fee base, so the trade is negative',
    '    expectancy no matter how high its probability of profit; above the band the structure stops',
    '    being a high-probability credit trade and becomes a directional bet.',
    "12. Report the short leg's |delta| as `shortDelta` (0..1) on every credit structure.",
    '13. HOLD R CONSTANT — but BUY the width with DELTA, not by stretching a low-delta strike.',
    '    WIDENING LOWERS credit/width (you pay for the long leg), so the floor CAPS how wide you can',
    `    go: at ${config.shortDeltaMin.toFixed(2)} delta a 30-day name supports well under a point of width, at`,
    `    ${config.shortDeltaMax.toFixed(2)} delta several points. If the R you want needs more width than the floor`,
    `    allows, move the SHORT strike UP the ${config.shortDeltaMin.toFixed(2)}–${config.shortDeltaMax.toFixed(2)} band — do NOT hold delta and`,
    '    stretch (the ratio collapses and the idea is discarded), and do NOT narrow to a token-width',
    '    spread to hit the ratio. WHY: our costs are fixed in DOLLARS per trade (two legs, round trip)',
    '    while R = maxLossUsd = width × (1 − credit/width), so a thin spread that clears the floor',
    '    still loses to cost/R. Higher IV-rank names give more width headroom at the same delta —',
    '    prefer them when you need size.',
    'DO NOT optimise for POP. A very high POP on a far-OTM short strike is exactly the failure mode',
    'these rules exist to stop: it wins almost every time and collects too little to survive one',
    'loss. Prefer FEWER ideas that clear the floor over a full slate that does not. Returning',
    '{ "ideas": [] } is a correct answer when nothing in the universe pays enough premium.',
    '',
    'Amended JSON shape (adds one optional field):',
    '{ "ideas": [ { …, "creditUsd": num>0 (credit structures only),',
    '  "shortDelta": num(0..1) (credit structures only) } ] }',
  ].join('\n');
}

/**
 * The system prompt for one pass: the constant, plus the flag-gated TRA-2208 floor
 * addendum, plus the flag-gated TRA-4646 credit-only-mandate addendum. Both are
 * addenda (never edits) so the all-flags-off prompt is byte-for-byte the old one.
 */
function buildSystemPrompt(floor: CreditWidthFloorConfig | null, retireDebit: boolean): string {
  const parts = [SYSTEM_PROMPT];
  if (floor != null) parts.push(creditWidthFloorPromptAddendum(floor));
  if (retireDebit) parts.push(debitRetirementPromptAddendum());
  return parts.join('\n\n');
}

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
      // TRA-1974 — advisory event-IV "sell-the-crush" flag (rule 6). True when a
      // catalyst sits inside at least one candidate expiry AND ivRank >= 50, so
      // the model needn't redo the DTE arithmetic. The deterministic post-answer
      // drop enforces it per-idea regardless of what the model does with this.
      sellTheCrush: sellTheCrushActive(
        s,
        s.candidates.reduce((m, c) => Math.max(m, c.daysToExpiration), 0),
      ),
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
  /** TRA-2005 — net credit per 1-lot in USD; optional (credit structures only). */
  creditUsd?: number;
  /** TRA-2208 — short-leg |delta| 0..1; optional, asked for only under the floor flag. */
  shortDelta?: number;
  dteDays: number;
  eventContext?: string[];
}

/**
 * TRA-846 — classify an idea's catalyst horizon from its underlying's soonest
 * scheduled catalyst (earnings or FOMC). With no near catalyst we fall back to
 * the idea's own DTE, so a longer-dated swing thesis reads as "long".
 *
 * TRA-1368 — exported so the server feed can re-derive the DISPLAYED horizon
 * against the executed leg DTE (the horizon is capped at the option's actual
 * life: an option expiring in 25 days can't reach a catalyst 40 days out, so
 * `min(catalyst, legDte)` is the coherent bucket the card should show).
 */
export function classifyHorizon(
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

/**
 * TRA-2208 — the optional `creditWidthRatio` / `shortDelta` stamp for one surviving
 * idea. Each field is omitted rather than nulled when it cannot be formed, so a
 * debit idea's record is identical with and without the flag.
 */
function creditWidthStamp(r: RawIdea): { creditWidthRatio?: number; shortDelta?: number } {
  const ratio = creditWidthRatioOf(r.creditUsd, r.maxLossUsd);
  const delta =
    typeof r.shortDelta === 'number' && Number.isFinite(r.shortDelta) ? Math.abs(r.shortDelta) : null;
  return {
    ...(ratio != null ? { creditWidthRatio: ratio } : {}),
    ...(delta != null ? { shortDelta: delta } : {}),
  };
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
  floor: CreditWidthFloorConfig | null,
  retireDebit: boolean,
): { ideas: OptionsIdea[]; rejected: RejectedIdea[] } {
  const symByTicker = new Map<string, OptionsResearchSymbol>();
  for (const s of input.symbols) symByTicker.set(s.symbol.toUpperCase(), s);
  const universe = new Set(symByTicker.keys());
  const kept: ScoredIdea[] = [];
  const rejected: RejectedIdea[] = [];

  for (const r of raw) {
    const ticker = r.ticker.trim().toUpperCase();
    const sym = symByTicker.get(ticker);
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
    // TRA-4646 — credit-only mandate: with the debit-sleeve retirement armed, any
    // non-credit-class (premium-BUYING) idea is dropped deterministically, recorded
    // here for audit rather than silently thinned. The prompt addendum states the
    // mandate so the model spends its slots on credit structures instead.
    if (retireDebit && !isCreditClassStrategy(r.strategy)) {
      reasons.push(
        `strategy "${r.strategy}" buys premium — off-mandate under the credit-only mandate ` +
          `(TRA-4646 debit-sleeve retirement); use bull_put_spread / bear_call_spread / iron_condor / iron_butterfly`,
      );
    }
    // TRA-1974 — event-IV "sell the crush": a net-long-vega debit single-leg
    // (long_call / long_put) held across a scheduled catalyst inside its expiry,
    // with elevated IV, gets IV-crushed post-event. Drop it deterministically so
    // a defined-risk CREDIT structure surfaces for that name instead. This is the
    // hard rule replacing the old LLM-badge nudge; it consumes the same
    // ivRank + earnings/FOMC read the fusion attaches to each symbol.
    if (LONG_VEGA_DEBIT_SINGLE_LEGS.has(r.strategy) && sellTheCrushActive(sym, r.dteDays)) {
      const earningsInside =
        sym!.nextEarningsInDays != null &&
        sym!.nextEarningsInDays >= 0 &&
        sym!.nextEarningsInDays <= r.dteDays;
      const cat = earningsInside ? `earnings in ${sym!.nextEarningsInDays}d` : `FOMC in ${sym!.daysToFOMC}d`;
      reasons.push(
        `strategy "${r.strategy}" is net-long-vega debit into an elevated-IV pre-event window ` +
          `(sell-the-crush: ${cat} inside ${r.dteDays}d DTE, ivRank ${Math.round(sym!.ivRank as number)} >= ${EVENT_IV_MIN_RANK}); ` +
          `prefer a defined-risk credit structure`,
      );
    }
    if (r.dteDays < guardrail.minDteDays) {
      reasons.push(`dteDays ${r.dteDays} < minDteDays ${guardrail.minDteDays} (day-trade guardrail)`);
    }
    // TRA-2208 — HARD credit/width floor. A credit vertical that collects less than
    // `minCreditWidth` of its own defined width cannot pay for its loss rate at our
    // cost base, and is DROPPED here rather than silently downgraded: it lands in
    // `rejected` with the pre-floor ratio in its reason, so the removal is audited
    // rather than invisible. `floor == null` ⇒ flag off ⇒ this block never runs.
    if (floor != null) {
      const verdict = evaluateCreditWidthFloor(
        { strategy: r.strategy, maxLossUsd: r.maxLossUsd, creditUsd: r.creditUsd, shortDelta: r.shortDelta },
        floor,
      );
      if (!verdict.admit) reasons.push(...verdict.reasons);
    }
    if (reasons.length > 0) {
      rejected.push({
        idea: { ticker, strategy: r.strategy as DefinedRiskStrategy, thesis: r.thesis, pop: r.pop, maxLossUsd: r.maxLossUsd, dteDays: r.dteDays },
        reasons,
      });
      continue;
    }
    const horizon = classifyHorizon(sym, r.dteDays, policy);
    kept.push({
      idea: {
        ticker,
        strategy: r.strategy as DefinedRiskStrategy,
        thesis: r.thesis.trim(),
        pop: r.pop,
        maxLossUsd: r.maxLossUsd,
        ...(typeof r.creditUsd === 'number' && Number.isFinite(r.creditUsd) && r.creditUsd > 0
          ? { creditUsd: r.creditUsd }
          : {}),
        // TRA-2208 — stamp the ratio the whole TRA-1965 diagnosis turns on, plus the
        // short-leg delta the band asked for, so both are gradeable downstream
        // without re-deriving them. Only under the flag: with the floor off the
        // model was never asked for `shortDelta` and the emitted record keeps its
        // old shape exactly.
        ...(floor != null ? creditWidthStamp(r) : {}),
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

  // TRA-2208 — resolve the hard credit/width floor once per pass. `null` = flag off
  // = the prompt, the cache key, the guardrail and the emitted idea shape are all
  // exactly what they were before this issue.
  const floor = resolveCreditWidthFloorConfig();
  // TRA-4646 — resolve the credit-only mandate once per pass. False = flag off =
  // the prompt, the cache key, the guardrail and the slate are all unchanged.
  const retireDebit = isDebitSleeveRetirementEnabled();

  // The floor changes the PROMPT, so it must change the cache key too — otherwise a
  // slate researched under the old prompt would be re-served to a flag-on caller and
  // the floor would appear to have removed nothing. Suffix-only, so the flag-off key
  // is byte-for-byte the old one. TRA-4646 — same reasoning for the credit-only
  // mandate suffix.
  const key = [
    optionsResearchBatchKey(input),
    ...(floor == null
      ? []
      : [`cwfloor${floor.minCreditWidth}:${floor.shortDeltaMin}-${floor.shortDeltaMax}`]),
    ...(retireDebit ? ['creditonly'] : []),
  ].join('|');
  const cached = deps.cache?.get(key);
  if (cached) {
    return { ...cached, cached: true };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(floor, retireDebit) },
    { role: 'user', content: buildUserPrompt(input, guardrail, maxIdeas, diversification) },
  ];

  const completion: CompleteJsonResult<RawIdeaBatch> = await completeJson<RawIdeaBatch>(
    deps.llm,
    { tier: 'strong', purpose: 'options-research', messages, temperature: 0.2 },
    { validate: validateOptionsIdeaBatch, maxAttempts: deps.maxAttempts ?? 3 },
  );

  const proposed = completion.value.ideas as RawIdea[];
  const { ideas, rejected } = enforceGuardrail(
    proposed,
    input,
    guardrail,
    maxIdeas,
    diversification,
    floor,
    retireDebit,
  );

  const result: OptionsResearchResult = {
    ideas,
    costUsd: completion.costUsd,
    attempts: completion.attempts,
    rejected,
    cached: false,
    // TRA-2005 — SHADOW-only: when the flag is on, score the surfaced slate against
    // the positive-expectancy + IVR/credit-width gate and attach the verdicts. The
    // slate itself is UNCHANGED (records what the gate would drop, never acts).
    // Flag off → config is null → field absent → byte-for-byte the old result.
    ...buildExpectancyShadow(ideas, input.symbols),
    // TRA-2208 — the PRE-floor ledger, scored over what the model PROPOSED rather
    // than what survived, because "how much of the current book the floor removes"
    // is unanswerable from the post-floor slate alone. Flag off → `floor` is null →
    // field absent → byte-for-byte the old result.
    ...(floor == null
      ? {}
      : {
          creditWidthFloorShadow: evaluateIdeasCreditWidthFloor(
            proposed.map((r) => ({
              ticker: r.ticker.trim().toUpperCase(),
              strategy: r.strategy,
              maxLossUsd: r.maxLossUsd,
              ...(r.creditUsd !== undefined ? { creditUsd: r.creditUsd } : {}),
              ...(r.shortDelta !== undefined ? { shortDelta: r.shortDelta } : {}),
            })),
            floor,
          ),
        }),
  };
  deps.cache?.set(key, result);
  return result;
}

/**
 * TRA-2005 — build the SHADOW expectancy ledger for a surfaced slate, or `{}` when
 * the gate flag is off (so the result is spread-in unchanged). Looks up each idea's
 * underlying IV-rank from the input symbols; POP is the raw stated POP (the interim
 * −0.15 haircut stands in for the TRA-2006 calibrated POP until it is armed here).
 */
function buildExpectancyShadow(
  ideas: OptionsIdea[],
  symbols: OptionsResearchSymbol[],
): { expectancyShadow?: IdeaExpectancyShadow } {
  const config = resolveExpectancyGateConfig();
  if (config == null) return {};
  const ivByTicker = new Map<string, number | null>();
  for (const s of symbols) ivByTicker.set(s.symbol.toUpperCase(), s.ivRank);
  const shadow = evaluateIdeasExpectancyShadow(
    ideas.map((idea) => ({
      ticker: idea.ticker,
      strategy: idea.strategy,
      rank: idea.rank,
      pop: idea.pop,
      maxLossUsd: idea.maxLossUsd,
      creditUsd: idea.creditUsd,
      ivRank: ivByTicker.get(idea.ticker.toUpperCase()) ?? null,
    })),
    config,
  );
  return { expectancyShadow: shadow };
}
