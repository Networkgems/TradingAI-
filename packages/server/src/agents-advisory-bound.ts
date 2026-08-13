// TRA-3442 (parent TRA-2171 phase 2, siblings TRA-2262 / TRA-3019 / TRA-3441) —
// the wall-clock bound and the FAILURE CIRCUIT BREAKER for
// `signal.doTick.agents-advisory`.
//
// ── What the 90s actually was, measured ──────────────────────────────────────
// The ticket read the 2026-08-12 RTH tape as `n=9, p50 90.1s, p90 94.6s, max
// 94.6s — the distribution is flat, so EVERY invocation takes ~90s` and warned
// that a wall-clock cap would therefore truncate a *modal* pass and publish a
// permanent partial. Both halves of that reading are wrong, and the second one
// is wrong in the reassuring direction:
//
//  1. **The tape is LEFT-CENSORED at 1s.** `withPhase` routes through
//     `recordPhaseDuration`, which opens `if (!(durationMs >= resolveSlowMs(env)))
//     return;` — PHASE_TIMING_SLOW_MS, unset on bqb1, so 1000ms. Every sub-label's
//     tape is the ≥1s tail of its population. `p90 == max` can never mean "every
//     invocation": sub-second invocations are structurally invisible.
//
//  2. **There is no modal pass to protect.** Pulling the sink's own warn line off
//     the same window returns 5,184 `trading-agents advisory failed for symbol`
//     records, spanning 16:15:30.128Z → 16:30:13.621Z and NOTHING else in the
//     6.5h session, of which **5184/5184 are one error class**:
//
//         Error: 400 {"type":"error","error":{"type":"invalid_request_error",
//         "message":"Your credit balance is too low to access the Anthropic API."}}
//
//     Bucketed into passes (split on a >5s gap):
//
//         16:15:30 → 16:17:04   n=639  uniq=639  span 94.3s  medDelta 131ms
//         16:17:30 → 16:18:57   n=639  uniq=639  span 86.5s  medDelta 130ms
//         16:19:11 → 16:20:41   n=639  uniq=639  span 90.4s  medDelta 130ms
//         16:21:01 → 16:22:30   n=639  uniq=639  span 89.7s  medDelta 129ms
//         16:23:01 → 16:24:30   n=639  uniq=639  span 89.0s  medDelta 129ms
//         16:24:40 → 16:26:11   n=639  uniq=639  span 91.2s  medDelta 130ms
//         16:26:31 → 16:29:30  n=1278  uniq=639  span 179.9s medDelta 130ms
//         16:30:01 → 16:30:13   n=72   uniq=72   span 12.1s  medDelta 134ms
//
//     `first=AAPL last=BAOS` on every full pass. 639 = the whole
//     `getActiveSymbols()` universe. **639 × ~130ms ≈ 83s, which IS the ~90s.**
//     The distribution is flat because the pass is a fixed-size serial walk of
//     fixed-cost HTTP refusals — not because a healthy 90s workload exists.
//
// ⇒ the sink spent **732.6s of tick wall clock and 5,184 log lines producing
// ZERO recommendations, ZERO tokens and ZERO spend**, and would have gone on
// doing so for the whole session had the layer not been switched off at 16:30.
// `runTradingAgentsAdvisory` assigns `latestAgentRecommendations = recos`, and
// every symbol threw, so the published advisory set was `[]` on every pass.
//
// ── Why a budget ALONE is not the fix, and a breaker alone is not either ─────
// A 30s budget turns 639 doomed calls into ~230 doomed calls. That is a latency
// fix wearing a correctness face. The defect is that a *systemic* provider
// refusal — billing, credential, permission, outage — is indistinguishable, to
// this loop, from one bad symbol, so it re-tries the same refusal once per
// symbol per tick forever. Hence {@link AGENTS_ADVISORY_BREAK_STREAK}.
//
// ⭐ The breaker predicate is deliberately CONSECUTIVE-FAILURE COUNTING, not
// provider-error classification. Parsing `status`/`error.type` out of an SDK
// error would have to enumerate every systemic class (400-billing, 401, 403,
// 429, 5xx, DNS, socket) and would mis-file the one it had not seen — and the
// classes are the vendor's to change. A run of N consecutive failures is
// provider-agnostic, cannot mis-classify, and is exactly the observable the
// defect produces. It also self-heals: the cooldown expires, the next pass
// spends N calls re-testing, and a recovered provider resumes with no operator
// action and no redeploy.
//
// ── Sizing (TRA-3019's rule: worst pass = budget + the call that overruns it) ─
// `runBudgetedSweep` checks its budget AFTER a batch — it must, the overrun is
// always the unit already in flight — so the graded worst case is
//
//     AGENTS_ADVISORY_SWEEP_BUDGET_MS + AGENTS_ADVISORY_SYMBOL_DEADLINE_MS
//       = 30s + 25s = 55s  <=  AGENTS_ADVISORY_GRADED_MAX_MS (60s)   ✅
//
// 🔴 The overrun term had to be BUILT, not looked up — TRA-3441's lesson, second
// instance. One symbol is up to NINE model calls (a 4-wide analyst fan-out, then
// the trader, then the risk panel, each inside `completeJson`'s 3 validation
// attempts), and `createAnthropicLlmClientFromEnv` set neither `timeout` nor
// `maxRetries`, so each of those nine inherited the SDK's 10-minute default. The
// per-symbol term was therefore unbounded and NO budget met the bar at any
// value. Two things now bound it, and both are needed:
//   • {@link LLM_CALL_CEILING_MS} — an SDK-level timeout we own, so an abandoned
//     wait is also a CANCELLED socket rather than a leak;
//   • the per-symbol deadline below — the term the arithmetic is sized on, so
//     the bound does not depend on counting waves × attempts correctly.
// `assertAdvisoryBudgetArithmetic` fails the SUITE if either drifts.
import { LLM_CALL_CEILING_MS } from '@trading-app/agents';
import { runBudgetedSweep, type SweepCursorStore, type SweepPass } from './tick-sweep-budget.js';
import { companyDailyCapUsd } from './agent-spend-store.js';

/** Wall clock one `agents-advisory` pass may spend inside one `doTick`. */
export const AGENTS_ADVISORY_SWEEP_BUDGET_MS = 30_000;

/**
 * Ceiling on ONE symbol's advisory graph. This is the overrun term in the
 * sizing above: the budget is checked after a symbol completes, so the worst
 * pass is `budget + this`. Sized well above a healthy round-trip (every tier
 * bqb1 maps to is Haiku/Sonnet at 700–900 max tokens; `LLM_MODEL_STRONG` is
 * live-set to `claude-haiku-4-5`) and well below the bar.
 */
export const AGENTS_ADVISORY_SYMBOL_DEADLINE_MS = 25_000;

/** The bar TRA-3442 pre-registered: `agents-advisory` max on a post-deploy RTH tape. */
export const AGENTS_ADVISORY_GRADED_MAX_MS = 60_000;

/**
 * Consecutive per-symbol failures that trip the breaker and stop the pass.
 *
 * 5, not 1: a single symbol can legitimately fail on its own (an unparseable
 * model reply exhausting `completeJson`, a symbol whose news/social context
 * blows the context window), and stopping the whole sweep for that would be a
 * coverage cut caused by one bad row. 5 in a row is not a bad row.
 */
export const AGENTS_ADVISORY_BREAK_STREAK = 5;

/**
 * How long the sink stands down after the breaker trips. Long enough that a
 * systemic refusal costs {@link AGENTS_ADVISORY_BREAK_STREAK} calls per 5 min
 * instead of 639 per tick; short enough that a restored provider is picked up
 * within one throttle of an RTH session, with no operator action.
 */
export const AGENTS_ADVISORY_BREAKER_COOLDOWN_MS = 5 * 60_000;

/**
 * Thrown when one symbol's advisory graph outruns
 * {@link AGENTS_ADVISORY_SYMBOL_DEADLINE_MS}. A distinct type so the caller can
 * report it as a bound rather than as a provider failure — and so it counts
 * toward the breaker streak, because a provider that is hanging is exactly as
 * systemic as one that is refusing.
 */
export class AdvisoryDeadlineError extends Error {
  constructor(readonly symbol: string, readonly deadlineMs: number) {
    super(`advisory graph for ${symbol} exceeded ${deadlineMs}ms`);
    this.name = 'AdvisoryDeadlineError';
  }
}

/**
 * Resolve `work` or reject with {@link AdvisoryDeadlineError} once `deadlineMs`
 * elapses.
 *
 * ⚠️ This is a WAIT bound, not a work-cancel — the same shape TRA-3441 shipped.
 * The socket-level cancel is {@link LLM_CALL_CEILING_MS}'s SDK timeout; this
 * layer only guarantees the SWEEP stops waiting, which is what the budget
 * arithmetic needs. The loser's rejection is swallowed explicitly so an
 * abandoned graph cannot surface as an unhandled rejection and kill the process
 * — a bound that crashes the box is worse than the latency it removes.
 */
export async function withSymbolDeadline<T>(
  symbol: string,
  deadlineMs: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const started = work();
  // Attach the guard BEFORE racing: if `work` rejects after the deadline has
  // already won, this catch is what keeps it handled.
  started.catch(() => { /* abandoned graph — reported by the deadline branch */ });
  try {
    return await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AdvisoryDeadlineError(symbol, deadlineMs)), deadlineMs);
        // Do not hold the event loop open for a bound that is only ever
        // meaningful while a tick is in flight.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Outcome of one bounded, breakered advisory pass. */
export interface AdvisorySweepResult {
  /** The underlying budgeted pass (cursor position, truncation flag, elapsed). */
  pass: SweepPass;
  /** True iff a RUN of {@link AGENTS_ADVISORY_BREAK_STREAK} failures stopped the pass. */
  breakerTripped: boolean;
  /** Longest consecutive-failure run observed this pass. */
  maxConsecutiveFailures: number;
  /** How many symbols failed this pass (not necessarily consecutive). */
  failures: number;
  /** First failure of the pass, `SYMBOL: message`, kept verbatim for the log line. */
  firstError: string | null;
}

/**
 * Walk `symbols` under the wall-clock budget AND the consecutive-failure
 * breaker.
 *
 * `advise` returns `true` when the symbol produced a recommendation (or was
 * legitimately skipped — a skip is NOT evidence about the provider and must not
 * feed the streak) and `false` when it failed.
 *
 * ⭐ Extracted from `signal-engine.ts` rather than inlined there so the breaker
 * is provable against the REAL `runBudgetedSweep` — cursor parking, forward
 * progress and the budget check all included — instead of against a hand-rolled
 * loop that resembles it. TRA-3441 shipped its wiring "verified by code read
 * only" and said so; this is that residual, closed.
 */
export async function runAdvisorySweep(opts: {
  key: string;
  symbols: readonly string[];
  advise: (symbol: string) => Promise<boolean>;
  onFailure?: (symbol: string, error: string) => void;
  budgetMs?: number;
  breakStreak?: number;
  cursors?: SweepCursorStore;
  now?: () => number;
}): Promise<AdvisorySweepResult> {
  const breakStreak = opts.breakStreak ?? AGENTS_ADVISORY_BREAK_STREAK;
  let consecutive = 0;
  let maxConsecutive = 0;
  let failures = 0;
  let firstError: string | null = null;
  let breakerTripped = false;

  const pass = await runBudgetedSweep({
    key: opts.key,
    symbols: opts.symbols,
    budgetMs: opts.budgetMs ?? AGENTS_ADVISORY_SWEEP_BUDGET_MS,
    ...(opts.cursors ? { cursors: opts.cursors } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    run: async (batch) => {
      for (const sym of batch) {
        let ok = false;
        try {
          ok = await opts.advise(sym);
        } catch (err) {
          // `advise` owns its own reporting; a throw that escapes it is still a
          // failure and must feed the streak rather than abort the tick.
          ok = false;
          if (firstError == null) firstError = `${sym}: ${String(err)}`;
          opts.onFailure?.(sym, String(err));
        }
        if (ok) {
          consecutive = 0;
          continue;
        }
        failures++;
        consecutive++;
        if (consecutive > maxConsecutive) maxConsecutive = consecutive;
        if (consecutive >= breakStreak) {
          breakerTripped = true;
          // `false` is `runBudgetedSweep`'s caller-side STOP: it parks the cursor
          // on this batch and records `stopped`, distinct from `budgetExhausted`.
          return false;
        }
      }
      return true;
    },
  });

  return { pass, breakerTripped, maxConsecutiveFailures: maxConsecutive, failures, firstError };
}

// ─── TRA-3514 (TRA-3460 (a)) — THE UNIVERSE BOUND ────────────────────────────
//
// TRA-3442 (above) bounded how LONG a pass may run. It did not bound how WIDE
// the pass is, and width is what the money bound is about: `runTradingAgentsAdvisory`
// was handed `getActiveSymbols()` — 639 names — against a $0.50/day company cap.
//
// ⭐ These two bounds are NOT redundant, and it matters which one is load-bearing
// for which failure. The wall-clock budget truncates a wide pass and PARKS THE
// CURSOR, so coverage rotates and every symbol is eventually attempted — which is
// correct for a latency bound and exactly WRONG for a spend bound, because a
// rotating cursor spends the cap on whichever slice the cursor happened to reach.
// A cap that is exhausted by symbol ~10 does not need a fair rotation over 639
// names; it needs a universe it can actually AFFORD, chosen for relevance rather
// than for cursor position. Hence a width bound, and hence one pass per session
// rather than a cursor.
//
// The CFO's sizing (TRA-3514 Part 2), re-derived here and asserted below:
//
//     company daily cap                       $0.50   (TRADING_AGENTS_COMPANY_DAILY_USD_CAP)
//     per-symbol cost, conservative           $0.05   (top of the parent's $0.02-0.05 band)
//     8 symbols x $0.05 x 1 pass/session      $0.40   -> 20% headroom under the cap
//     12 symbols would be $0.60               OVER    -> which is why the ceiling is 8, not 12

/**
 * Hard ceiling on symbols handed to ONE advised pass. A CEILING, not a target: a
 * shortlist that comes in under it is advised whole.
 */
export const ADVISORY_MAX_SYMBOLS_PER_PASS = 8;

/**
 * Conservative per-symbol advisory cost used for the affordability arithmetic —
 * the TOP of the parent's measured $0.02-0.05 band, so the bound is sized against
 * the expensive end rather than the hoped-for one.
 *
 * ⚠️ This is an ESTIMATE and is labelled as one. TRA-3514 Part 4 replaces it with
 * a MEASURED figure off the first funded RTH session; if the measurement puts 8
 * symbols outside the cap, the number the CFO re-sizes is this one.
 */
export const ADVISORY_PER_SYMBOL_COST_USD_ESTIMATE = 0.05;

/** Advised passes permitted per RTH session (a ceiling, like the width). */
export const ADVISORY_PASSES_PER_SESSION = 1;

/** Worst-case daily advisory spend under the shipped width/cadence bounds, USD. */
export function advisoryWorstDailyUsd(
  maxSymbols: number = ADVISORY_MAX_SYMBOLS_PER_PASS,
  perSymbolUsd: number = ADVISORY_PER_SYMBOL_COST_USD_ESTIMATE,
  passes: number = ADVISORY_PASSES_PER_SESSION,
): number {
  return maxSymbols * perSymbolUsd * passes;
}

/**
 * Throw unless the shipped width/cadence bounds still fit the LIVE company daily
 * cap. Called from the suite, so raising the width, the cadence or the cost
 * estimate fails HERE rather than showing up as a silent tail of deterministic
 * recommendations in a funded session.
 *
 * ⭐ Reads {@link companyDailyCapUsd} rather than hard-coding $0.50: the cap is an
 * env value the CFO owns and can move without a redeploy, and an arithmetic
 * assertion pinned to a literal would go quietly false the moment they did. The
 * cost of that choice is that the assertion is only as good as the env the SUITE
 * runs under — which is why the failure message prints the cap it actually read.
 */
export function assertAdvisoryUniverseAffordable(capUsd: number = companyDailyCapUsd()): void {
  const worst = advisoryWorstDailyUsd();
  if (!(worst <= capUsd)) {
    throw new Error(
      `TRA-3514 universe bound violated: ${ADVISORY_MAX_SYMBOLS_PER_PASS} symbols x `
      + `$${ADVISORY_PER_SYMBOL_COST_USD_ESTIMATE}/symbol x ${ADVISORY_PASSES_PER_SESSION} pass `
      + `= $${worst.toFixed(2)}/day > the $${capUsd.toFixed(2)} company daily cap`,
    );
  }
}

/** Where a shortlisted symbol came from — the reason it earned a paid read. */
export type AdvisoryShortlistReason = 'open_position' | 'pending_proposal' | 'curated_shortlist';

export interface AdvisoryShortlist {
  /** The bounded universe, in priority order, `<= max`. */
  symbols: string[];
  /** Why each symbol is in, keyed by symbol — the audit trail for the bound. */
  reasons: Record<string, AdvisoryShortlistReason>;
  /** How many candidates the cap DROPPED. Non-zero must never be silent. */
  dropped: number;
  /** Distinct candidates before the cap (post-dedup). */
  candidates: number;
}

/**
 * Build the bounded advised universe: open positions, then active-interest /
 * pending proposals, then the curated liquid swing shortlist — deduped, in that
 * priority order, capped at `max`.
 *
 * ⭐ THE ORDER IS THE POLICY, and it is the part a reader should check rather than
 * the cap. When the cap binds, the order decides who gets the paid read, so it
 * runs strictly most-committed-first: a symbol we are ALREADY EXPOSED TO is worth
 * more analysis than one we might enter, which is worth more than one on a
 * watchlist. The previous behaviour had no order at all — `getActiveSymbols()` is
 * alphabetical, so the paid reads went to whatever sorted first (`AAPL` ... on
 * every pass of the 2026-08-12 tape) and an open position at `Z` never got one.
 * That is the positional bias the parent named, and an ordering is the fix for it;
 * the width bound alone would merely have made it cheaper.
 *
 * Pure and total: no clock, no engine, no env. Everything it decides is a
 * function of its arguments, so the priority policy is unit-testable at the
 * boundary (exactly-at-cap, over-cap, empty shortlist) without a live book.
 */
export function buildAdvisoryShortlist(opts: {
  /** Symbols with an OPEN position — highest priority, we are already exposed. */
  openPositions: readonly string[];
  /** Symbols with active interest: a pending/unresolved trade proposal. */
  pendingProposals: readonly string[];
  /** The curated liquid swing universe — the standing scan candidates. */
  curated: readonly string[];
  max?: number;
}): AdvisoryShortlist {
  const max = Math.max(0, Math.floor(opts.max ?? ADVISORY_MAX_SYMBOLS_PER_PASS));
  const reasons: Record<string, AdvisoryShortlistReason> = {};
  const ordered: string[] = [];
  const seen = new Set<string>();

  const tiers: Array<readonly [AdvisoryShortlistReason, readonly string[]]> = [
    ['open_position', opts.openPositions],
    ['pending_proposal', opts.pendingProposals],
    ['curated_shortlist', opts.curated],
  ];
  for (const [reason, list] of tiers) {
    for (const raw of list) {
      const sym = String(raw ?? '').trim().toUpperCase();
      if (sym === '' || seen.has(sym)) continue;
      seen.add(sym);
      ordered.push(sym);
      // First tier to claim a symbol owns its reason — a symbol that is BOTH an
      // open position and curated is reported as the open position, which is the
      // fact that earned it the slot.
      reasons[sym] = reason;
    }
  }

  const symbols = ordered.slice(0, max);
  // ⚠️ Reasons are trimmed to the ADMITTED set. Publishing a reason for a symbol
  // that was dropped would read as coverage the pass never gave it.
  const trimmed: Record<string, AdvisoryShortlistReason> = {};
  for (const s of symbols) trimmed[s] = reasons[s]!;
  return {
    symbols,
    reasons: trimmed,
    dropped: ordered.length - symbols.length,
    candidates: ordered.length,
  };
}

/**
 * TRA-3514 (TRA-3460 (c) §4) — the per-pass backing census. `advised` and
 * `fellBack` are the two ways a symbol PRODUCES a recommendation; the split is
 * the whole point, because before this the two were summed into one
 * `recommendationCount` and the degradation was invisible.
 *
 * ⚠️ `skipped` and `failed` are kept APART on purpose (the ticket's "a missing
 * symbol and a deterministically-advised symbol are different facts", one level
 * in): a skip is a symbol we declined to ask about (too few candles), a failure
 * is a symbol we asked about and got nothing for. Summing them would make a dead
 * provider look like a thin watchlist.
 */
export interface AdvisoryPassCensus {
  /** Symbols that produced an LLM-backed recommendation. */
  advised: number;
  /** Symbols that produced a DETERMINISTIC (zero-cost) recommendation. */
  fellBack: number;
  /** Symbols deliberately not asked about (insufficient candles). */
  skipped: number;
  /** Symbols asked about that produced nothing (throw / deadline). */
  failed: number;
}

/** A census with every counter at zero — the shape a pass starts from. */
export function emptyAdvisoryPassCensus(): AdvisoryPassCensus {
  return { advised: 0, fellBack: 0, skipped: 0, failed: 0 };
}

/**
 * The per-book advisory readout, as far as the fleet summary needs to see it.
 * Structurally typed so `SignalEngine.getAgentsAdvisoryBound`'s richer return
 * satisfies it without an import cycle.
 */
export interface AdvisoryBookReadout {
  /** The per-book "Trading Agents" toggle — the ELIGIBILITY bit. */
  enabled: boolean;
  sessionLatched: boolean;
  breakerCooldownUntil: number | null;
  lastPass: { census: AdvisoryPassCensus } | null;
}

export interface AdvisoryFleetSummary {
  /**
   * Books with the advisory layer ON. **The denominator that makes the rest of
   * this object gradeable** — see the note on {@link summariseAdvisoryFleet}.
   */
  enabledBooks: number;
  latched: number;
  advised: number;
  fellBack: number;
  skipped: number;
  failed: number;
  breakered: number;
  booksWithAPass: number;
  booksTotal: number;
}

/**
 * TRA-3514 (monitor 08-13T14:30Z) — roll the per-book readouts into the fleet
 * census, and decide which books the default (unfiltered) view keeps.
 *
 * ⭐⭐⭐ **A ZERO NEEDS THE *ELIGIBLE* DENOMINATOR, NOT THE TOTAL ONE.** The first
 * cut of this endpoint shipped `booksWithAPass` beside `booksTotal` precisely so a
 * zero could be graded — and it still could not be. 66 books with the layer OFF and
 * 66 books with the layer ON that every failed to run produce byte-identical
 * readouts under that pair, and only the second is a defect. `enabledBooks` is the
 * number that separates them. Counting a denominator is not the same as counting
 * the RIGHT denominator, and "I already shipped a denominator" is what stopped the
 * question being asked a second time.
 *
 * ⚠️ And the filter follows the same rule. It used to keep books with a pass, a
 * latch or a breaker — every one of which is a book that already RAN. An ENABLED
 * book that has never run a pass is the exact failure this endpoint exists to
 * surface, and it was the single row the default view dropped. **A filter tuned to
 * what already worked is blind to what did not.**
 *
 * Both counters are accumulated DIRECTLY rather than derived from each other:
 * a derived counter inherits the bugs of both its inputs and reports them with a
 * clean face.
 */
export function summariseAdvisoryFleet<T extends AdvisoryBookReadout>(
  books: Array<{ user: string; bound: T }>,
): { fleet: AdvisoryFleetSummary; perBook: Array<{ user: string; bound: T }>; booksOmitted: number } {
  const fleet: AdvisoryFleetSummary = {
    enabledBooks: 0, latched: 0, advised: 0, fellBack: 0, skipped: 0,
    failed: 0, breakered: 0, booksWithAPass: 0, booksTotal: 0,
  };
  const perBook: Array<{ user: string; bound: T }> = [];
  let booksOmitted = 0;
  for (const entry of books) {
    const b = entry.bound;
    fleet.booksTotal++;
    if (b.enabled) fleet.enabledBooks++;
    if (b.sessionLatched) fleet.latched++;
    if (b.breakerCooldownUntil != null) fleet.breakered++;
    if (b.lastPass) {
      fleet.booksWithAPass++;
      fleet.advised += b.lastPass.census.advised;
      fleet.fellBack += b.lastPass.census.fellBack;
      fleet.skipped += b.lastPass.census.skipped;
      fleet.failed += b.lastPass.census.failed;
    }
    if (advisoryBookIsInteresting(b)) perBook.push(entry);
    else booksOmitted++;
  }
  return { fleet, perBook, booksOmitted };
}

/** Whether the default view keeps this book. See {@link summariseAdvisoryFleet}. */
export function advisoryBookIsInteresting(b: AdvisoryBookReadout): boolean {
  return b.enabled || b.lastPass != null || b.sessionLatched || b.breakerCooldownUntil != null;
}

/**
 * The graded worst case of one bounded pass. Exported so the ticket's arithmetic
 * lives in code (and in the suite) rather than only in a comment — TRA-2262's
 * "put the spec's arithmetic in the suite", applied at the spot it was learned.
 */
export function advisoryWorstPassMs(
  budgetMs: number = AGENTS_ADVISORY_SWEEP_BUDGET_MS,
  deadlineMs: number = AGENTS_ADVISORY_SYMBOL_DEADLINE_MS,
): number {
  return budgetMs + deadlineMs;
}

/**
 * Throw unless the shipped constants still meet TRA-3442's bar. Called from the
 * suite so that raising the per-call ceiling in `@trading-app/agents`, the
 * budget, or the deadline fails HERE — loudly, at build time — instead of
 * silently pushing the sink back over 60s and grading FAIL on a live tape a day
 * later.
 */
export function assertAdvisoryBudgetArithmetic(): void {
  const worst = advisoryWorstPassMs();
  if (worst > AGENTS_ADVISORY_GRADED_MAX_MS) {
    throw new Error(
      `TRA-3442 bound violated: budget ${AGENTS_ADVISORY_SWEEP_BUDGET_MS}ms + symbol deadline `
      + `${AGENTS_ADVISORY_SYMBOL_DEADLINE_MS}ms = ${worst}ms > ${AGENTS_ADVISORY_GRADED_MAX_MS}ms bar`,
    );
  }
  // The per-symbol deadline is only a real bound if the SDK can be relied on to
  // give the socket up at least once inside it; a deadline shorter than one
  // whole call ceiling means every truncation abandons work mid-flight, every
  // time, which is a spend leak rather than a bound.
  if (AGENTS_ADVISORY_SYMBOL_DEADLINE_MS < LLM_CALL_CEILING_MS / 2) {
    throw new Error(
      `TRA-3442: symbol deadline ${AGENTS_ADVISORY_SYMBOL_DEADLINE_MS}ms is small against the `
      + `provider call ceiling ${LLM_CALL_CEILING_MS}ms — every pass would abandon work in flight`,
    );
  }
}
