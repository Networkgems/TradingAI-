// TRA-1418 (TRA-1417 build, parent TRA-1406 "less noise, more quality" /
// TRA-1410 option (a)) — per-tick combo mark + defined-risk-spread exit policy.
//
// Problem (TRA-1410 / TRA-1417): every multi-leg defined-risk structure the demo
// book opens closes at exactly $0 — 100% scratch, no WIN/LOSS resolution. Root
// cause is structural: a combo carries a synthetic (non-OCC) `optionSymbol`, so
// the per-symbol mark refresh never matches it and the per-tick exit engine skips
// it entirely ("held to manual close / expiry", options-account.ts ~L1960). In
// the always-on demo book there is no manual close, so the structure is only ever
// resolved at a force-scratch near entry → $0.
//
// This is TRA-1410 option (a), the DURABLE fix (vs the (b) open-pause stopgap in
// `multileg-open-pause-flag.ts`): when armed, the combo gets a real per-tick net
// mark and the QuantTrader defined-risk exit policy (profit-take at 50% of max
// profit, credit 2× / debit 50% stop clamped to max loss, 21-DTE time-stop) so it
// books a non-$0 WIN/LOSS through the normal realized-P&L path.
//
// A STANDALONE flag, deliberately NOT under the EXIT_RISK_RULES_ENABLED master —
// mirroring the containment of ENABLE_OPTION_MULTILEG_PAUSE / ENTRY_GREEKS_GATE /
// TAKE_PROFIT_EARLY / OTM_DELTA_FLOOR. The caller additionally HARD-gates on
// `mode === 'demo'`, so the exit policy is structurally incapable of altering a
// live option close. DEFAULT OFF ⇒ combos stay on the legacy skip, so no existing
// behaviour or test changes until the board arms it via demo-flags.json (no
// PM2/admin). Accepts 1/true/yes/on.

export const MULTILEG_EXIT_FLAG = 'ENABLE_OPTION_MULTILEG_EXIT';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the demo multi-leg exit policy is armed (standalone; 1/true/yes/on).
 * Default OFF ⇒ combos keep the legacy per-tick skip. The caller additionally
 * hard-gates on `mode === 'demo'`, so this can never manage a live combo.
 */
export function isMultiLegExitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[MULTILEG_EXIT_FLAG]);
}
