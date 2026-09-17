// TRA-4646 (parent TRA-1965) — retire the off-mandate DEBIT sleeve from the
// AI-Options-Ideas surfacing path, behind a named flag.
//
// WHY. TRA-1964/TRA-1965 commissioned a premium-INCOME product — SELLING premium
// with defined risk. The graded forward-test book nonetheless carried a 31% debit
// sleeve (long_call / bull_call_spread / bear_put_spread), which the 2026-09-17
// evidence roll-up measured as BOTH the entire negative signal (perfect credit/debit
// sign separation, 5 of 5 structures: credit +0.070 vs debit −0.729 centered) AND
// the variance source that forces the power criterion's n_req to 727 (σ debit 0.617
// vs credit 0.275; credit-only requires ~337). Buying premium is the opposite trade
// to the one the board commissioned, and it was drowning the mandated sleeve's
// signal.
//
// WHAT THE FLAG DOES (default OFF — byte-for-byte the old behaviour until armed):
//   • prompt: appends {@link debitRetirementPromptAddendum} so the model spends its
//     slate slots on credit structures instead of being silently thinned;
//   • guardrail: `enforceGuardrail` (options-research.ts) DROPS any non-credit-class
//     idea deterministically, recorded in `rejected` for audit;
//   • feed: `buildOptionsIdeasFeed` (server) skips non-credit-class strategies as
//     defense in depth;
//   • scoring: the server's forward-test read re-scores the gate CREDIT-ONLY by
//     excluding debit rows as `off_mandate_debit` — FORWARD scoring only. The
//     resolved journal rows are never deleted or amended; they are the evidence the
//     retirement decision rests on.
//
// ⚠️ ARMING ORDER (TRA-4646 AC2/AC3): do NOT arm this flag until the per-sleeve
// expectancy read in the R UNIT (`/api/health/options-ideas-journal`,
// `sleeveExpectancy`) has confirmed the debit sleeve's negative sign. The power
// module's centered statistic `c` is not the same unit as `expectancyNetR`; the
// sign separation was unit-invariant but the retirement is conditioned on the R
// confirmation.

/** The named flag. Truthy values: `1` / `true` / `yes` / `on` (TRA-2208 idiom). */
export const DEBIT_SLEEVE_RETIREMENT_VAR = 'ENABLE_OPTIONS_DEBIT_SLEEVE_RETIREMENT';

/**
 * The premium-INCOME (net-credit) strategy families — the mandate's universe.
 * The complement of this set over `LLM_EMITTABLE_STRATEGIES` is the debit sleeve
 * the flag retires: long_call, long_put, bull_call_spread, bear_put_spread,
 * call_calendar, put_calendar. Kept as ONE source of truth: the prompt addendum,
 * the guardrail drop, the feed drop and the structure modeler's credit/debit
 * classification all read this set, so they can never drift apart.
 */
export const CREDIT_CLASS_STRATEGIES: ReadonlySet<string> = new Set([
  'bull_put_spread',
  'bear_call_spread',
  'iron_condor',
  'iron_butterfly',
]);

/** True iff `strategy` is a net-credit (premium-income) family. */
export function isCreditClassStrategy(strategy: string): boolean {
  return CREDIT_CLASS_STRATEGIES.has(strategy);
}

/**
 * Whether the debit-sleeve retirement is armed. Reading the flag never requires
 * arming anything; callers that only want the state (probes, comparison blocks)
 * call this directly.
 */
export function isDebitSleeveRetirementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env[DEBIT_SLEEVE_RETIREMENT_VAR] ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

/**
 * The credit-only mandate stated to the model, appended to the system prompt ONLY
 * when the flag is on (same addendum-not-edit pattern as TRA-2208's floor: the
 * flag-off prompt, cache key and token count are unchanged). Stated so the model
 * can COMPLY rather than be silently thinned — the deterministic guardrail drop
 * enforces it regardless of what the model does with this.
 */
export function debitRetirementPromptAddendum(): string {
  return [
    'CREDIT-ONLY MANDATE (HARD — violations are discarded):',
    '14. This desk sells premium. Propose ONLY net-credit defined-risk structures (use these',
    '    exact ids): bull_put_spread, bear_call_spread, iron_condor, iron_butterfly. Every',
    '    debit / long-premium id (long_call, long_put, bull_call_spread, bear_put_spread,',
    '    call_calendar, put_calendar) is DISCARDED deterministically after you answer — do not',
    '    spend a slot on one. Express a bullish lean with a bull_put_spread and a bearish lean',
    '    with a bear_call_spread; a range thesis with an iron_condor / iron_butterfly.',
  ].join('\n');
}
