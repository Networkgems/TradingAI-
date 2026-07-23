// TRA-2200 (parent TRA-2171, grandparent TRA-1996) — decoupled exit-evaluation
// cadence feature flag.
//
// WHY THIS EXISTS. `checkExits` (equity + options) runs INSIDE `signal.doTick`,
// and the `tickRunning` reentrancy guard holds the next tick until the current
// one finishes. On the 2026-07-23 bqb1 RTH tape the parent `signal.doTick` async
// wall-clock had p90 70s / p99 296s / max 853s at the ~568-symbol universe, and
// each engine spent ~65.7% of the session inside a single slow (>=1s) tick. So
// the SPACING between two consecutive stop/target evaluations is the tick period
// PLUS the tick's own duration — worst case 14.2 minutes on 2026-07-23.
//
// The TRA-2171 phase-2 attribution proved no single sink owns that: the two
// instrumented sub-labels are `cold-bar-scan` 36.8% and `mtf-refresh` 12.9%, and
// ~50.3% of doTick-seconds is code neither sub-label wraps. Capping either sink
// therefore SHORTENS the tick but cannot BOUND exit latency, because ~half the
// wall-clock is still unattributed. Hoisting the exit passes onto their own timer
// bounds exit latency regardless of which sink dominates — the same move TRA-1996
// (`e5f43b4`) made for quote freshness, and the only remedy robust to the dark 50%.
//
// ── WHY IT IS OFF BY DEFAULT ─────────────────────────────────────────────────
// Unlike the TRA-1996 quote refresher — pure book-keeping, no order path — this
// flag arms a SECOND caller of `optionsAccount.checkExits` and, in live-mirroring
// mode, of `submitStagedOptionExits`. The engine serialises the two callers (see
// `shouldRunDecoupledExitPass` + the `exitCriticalRegion` window in
// signal-engine.ts) so they can never interleave, but a second path onto a real
// broker order route is a board-visible change, not a silent one. It stays dark
// until it is armed deliberately.
//
// OFF by default ⇒ zero cost: no second timer is even created (see `start()`),
// so behaviour is byte-for-byte the shipped path.
//
// ── ARMING NOTE (bqb1 / TRA-1648) ────────────────────────────────────────────
// bqb1 is the frozen go-live soak host. An ENV/SETTINGS write REDEPLOYS it
// (Render trigger `service_updated`) and restarts the soak window — so arming
// this via a Render env var is itself a deploy. The flag is on
// `DEMO_FLAG_ALLOWLIST` so the demo book can be armed through
// `<DATA_DIR>/demo-flags.json` WITHOUT an env write or a restart; the live book
// reads `process.env` and therefore needs a deliberate, scheduled deploy window.

export const DECOUPLED_EXIT_CADENCE_FLAG = 'ENABLE_DECOUPLED_EXIT_CADENCE';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the decoupled (off-tick) exit-evaluation cadence is enabled. */
export function isDecoupledExitCadenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[DECOUPLED_EXIT_CADENCE_FLAG]);
}
