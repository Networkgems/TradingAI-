// TRA-1289 (parent TRA-1288 → TRA-955 → TRA-1242) — demo-only, flag-gated
// forward-test fill path for the primary swing router `sma200_pullback`.
//
// CTO approved Option A on TRA-1288: permit a DEMO-ONLY, manifest-exempt,
// default-OFF paper fill off a fresh `sma200_pullback` signal so TRA-955 can
// forward-test signal accuracy and TRA-1242's leaf accrual (routine c60c98a2)
// can resume counting. The strategy is NOT gate-passed — TRA-455 was a flat
// FAIL and TRA-458 an in-sample re-sweep — so this path exists ONLY to open a
// paper position in demo; it can never touch live capital.
//
// ── HARD INVARIANT (do NOT violate) ──────────────────────────────────────────
// This flag is structurally incapable of opening real capital. The router
// (`signal-engine.ts::openSma200Pullback`) consults it ONLY on the
// `this.mode !== 'live'` branch; the `this.mode === 'live'` path stays
// unconditionally blocked by the TRA-817 capital-gate manifest
// (`isLiveEntryGatePassed`), which remains the sole live authority. Live
// promotion still requires clearing the OOS keeper gate (TRA-455/817); this
// path validates demo signal accuracy only.
//
// The flag is on `DEMO_FLAG_ALLOWLIST` (see demo-flags.ts) so a non-admin
// operator can flip it in demo via `<DATA_DIR>/demo-flags.json` — the only
// writable switch a non-admin agent has on the self-hosted host — with no
// secret/PM2 access. OFF by default ⇒ `sma200_pullback` stays display-only.

export const SMA200_DEMO_FORWARD_TEST_FLAG = 'ENABLE_SMA200_DEMO_FORWARD_TEST';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the demo-only `sma200_pullback` forward-test fill flag is enabled
 * (accepts 1/true/yes/on). Pure and side-effect-free — safe on the hot entry
 * path. Returns `false` for every unset/garbage value: the path is closed by
 * default and opens only on an explicit truthy flag.
 */
export function isSma200DemoForwardTestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[SMA200_DEMO_FORWARD_TEST_FLAG]);
}
