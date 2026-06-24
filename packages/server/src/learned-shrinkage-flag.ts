// TRA-1056 (TRA-1041c L3) — cold-start weak-prior shrinkage switch.
//
// Both learners (`learned-signal-weights.ts`, `learned-option-weights.ts`) now
// compute TWO scoring multipliers per bucket: `multiplierHardGate` (today's
// neutral-until-minSamples behavior) and `multiplierShrunk` (the Beta-Binomial
// posterior pulled toward the learner's global pooled rate). The fold is pure and
// always carries both for the A/B readout; THIS flag selects which one the live
// combined multiplier (`reversalSignalMultiplier` / `optionSetupMultiplier`)
// actually reads.
//
// OFF by default. Per the TRA-1055 graded sign-off nothing may change scoring
// behavior until QuantTrader re-runs the replay on the populated reversal-shadow +
// option-trade ledgers and confirms the prior improves / does-not-harm demo
// expectancy. Live-capital promotion stays gated on TRA-382 regardless of this
// flag — these learners SCORE, they never size or gate capital.

export const LEARNED_SHRINKAGE_FLAG = 'ENABLE_LEARNED_WEIGHT_SHRINKAGE';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the cold-start shrinkage flag is enabled (accepts 1/true/yes/on). When
 * on, the combined multipliers read each bucket's `multiplierShrunk` instead of
 * the confident-gated `multiplierHardGate`.
 */
export function isLearnedShrinkageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[LEARNED_SHRINKAGE_FLAG]);
}
