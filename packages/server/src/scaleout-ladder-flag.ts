// TRA-1300 (parent TRA-1290, board confirmation `38a50f39`) — observe-only
// scale-out (take-profit) ladder overlay feature flag.
//
// Mirrors `crypto-ignition-flag.ts` (TRA-1271) and the other observe-only scanner
// flags: a single standalone master flag checker (1/true/yes/on). It is a
// STANDALONE flag — NOT under the `EXIT_RISK_RULES_ENABLED` master — because unlike
// the take-profit-early / correlated-exposure rules this path places NO order and
// mutates NO book: it only LOGS intended trims into a durable ledger for forward
// validation. Gating an observe-only capture behind the book-mutating exit-risk
// master would needlessly couple it to that switch.
//
// OFF by default ⇒ zero cost: no per-position ladder pass, no ledger writes, and
// `enabled:false` on `GET /api/health/scaleout-ladder`.
//
// ── HARD INVARIANT (do NOT violate) ──────────────────────────────────────────
// Observe-only, ZERO capital, NO order submission, NO sizing, NO account touch
// anywhere off this flag. The scale-out ladder governs the UPSIDE only; the
// downside handoff to the shipped chandelier + give-back cap (TRA-1267/1268) is
// unchanged. Any move to route these trims into the book is a separate,
// board-visible decision (out of scope). The board REJECTED the add-down /
// averaging-down ladder (TRA-1291 NO-GO); there is no add-down path here.
//
// The flag is on `DEMO_FLAG_ALLOWLIST` so a non-admin operator can flip it in demo
// via `<DATA_DIR>/demo-flags.json` (see demo-flags.ts) — the only writable switch a
// non-admin agent has on the self-hosted host.

export const SCALEOUT_LADDER_FLAG = 'ENABLE_SCALEOUT_LADDER';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the observe-only scale-out (take-profit) ladder overlay is enabled. */
export function isScaleoutLadderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[SCALEOUT_LADDER_FLAG]);
}
