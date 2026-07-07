// TRA-1410 (parent TRA-1406 "less noise, more quality") — the multi-leg
// (iron_condor / bear_put / bear_call / bull_put) demo-open PAUSE guard.
//
// Problem (TRA-1410): every multi-leg defined-risk structure the demo book opens
// closes at exactly $0 — 100% scratch, no WIN/LOSS resolution (18 closes on
// 07-06; similar all-time). Root cause is structural: a combo carries a synthetic
// (non-OCC) `optionSymbol`, so the per-symbol mark refresh never matches it and
// the per-tick exit engine skips it entirely ("held to manual close / expiry",
// options-account.ts ~L1949 / signal-engine.ts ~L1365). In the always-on demo
// book there is no manual close, so the structure is only ever "resolved" at a
// force-scratch near entry → $0. Until a real defined-risk-spread exit policy
// (profit-take at X% of max credit + stop at Y·credit + time-stop) exists (the
// durable fix, TRA-1410 option (a)), the combos are pure noise.
//
// This is the short-term guard (TRA-1410 option (b), QuantTrader's recommended
// stopgap): a STANDALONE flag (deliberately NOT under the EXIT_RISK_RULES_ENABLED
// master) that, when armed, PAUSES the demo multi-leg OPEN chokepoints and logs a
// reason instead of opening an un-manageable combo. The signal-engine consults it
// ONLY on the `mode === 'demo'` combo-open branches, so it is structurally
// incapable of altering a live option open. This mirrors the containment of
// OTM_DELTA_FLOOR / ENTRY_GREEKS_GATE / TAKE_PROFIT_EARLY / CHURN_LOSS_BRAKE.
//
// DEFAULT OFF (not paused) ⇒ demo combos open exactly as before, so no existing
// behaviour or test changes until the board arms it. When ON (1/true/yes/on),
// demo combo opens are rejected with a logged reason — satisfying the TRA-1410
// acceptance branch "disabled with a reason logged". The board flips it via
// demo-flags.json (daemon-free on the self-hosted host, no PM2/admin), so the
// retire-short-term can be armed the moment QuantTrader confirms the $0 closes are
// dead weight rather than a fixable force-close bug.

export const MULTILEG_OPEN_PAUSE_FLAG = 'ENABLE_OPTION_MULTILEG_PAUSE';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the demo multi-leg OPEN pause guard is armed (standalone; 1/true/yes/on).
 * Default OFF ⇒ combos open unchanged. The caller additionally hard-gates on
 * `mode === 'demo'`, so this can never pause a live open.
 */
export function isMultiLegOpenPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[MULTILEG_OPEN_PAUSE_FLAG]);
}
