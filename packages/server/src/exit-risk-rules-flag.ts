// TRA-1267 (TRA-1250) — master switch for the board-approved exit-side
// loss-control rules (TRA-1249 analysis, request_confirmation `d7175f7e`).
//
// Phase-1 is EXIT/entry-gate side only: the ATR chandelier trail + per-trade
// profit-lock (TRA-1268) and the book-level daily give-back cap / session stop
// (Rule 3, THIS issue). The pure decision logic lives in `@trading-app/engine`
// (`exit-rules.ts`); the wiring reads this ONE flag so the whole package can
// ship DARK and be tuned/reverted atomically. OFF by default — nothing changes
// live behaviour until the board flips `EXIT_RISK_RULES_ENABLED` at the
// TRA-1270 enable+deploy+verify gate (QuantTrader threshold-parity review).

export const EXIT_RISK_RULES_FLAG = 'EXIT_RISK_RULES_ENABLED';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the exit-side loss-control rules are enabled (accepts 1/true/yes/on).
 * Gates the book-level give-back cap (Rule 3) markBook/flatten wiring and its
 * entry-gate halt in both the equity and options entry chokepoints.
 */
export function isExitRiskRulesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[EXIT_RISK_RULES_FLAG]);
}

// TRA-1269 (TRA-1250 Rule 1, live-equity path) — a SEPARATE sub-flag for the
// one path with real broker-execution risk: trailing a live Tradier equity stop
// by modifying its resting OCO stop leg. It is deliberately gated by BOTH the
// master switch AND its own flag so the board can enable the demo/options
// chandelier + book give-back cap (TRA-1267/1268) in production while the live
// stop-modify stays dark — and can flip only this one on for the small
// board-placed verification position without touching everything else. OFF
// unless `EXIT_RISK_RULES_ENABLED` AND `LIVE_EQUITY_STOP_MODIFY_ENABLED` are
// both truthy (1/true/yes/on).
export const LIVE_EQUITY_STOP_MODIFY_FLAG = 'LIVE_EQUITY_STOP_MODIFY_ENABLED';

/**
 * True iff the live-equity chandelier stop-modify path is enabled. Requires the
 * master exit-risk switch on as well — the sub-flag alone does nothing.
 */
export function isLiveEquityStopModifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[LIVE_EQUITY_STOP_MODIFY_FLAG]);
}

// TRA-1294 — take-profit-early (the PROFIT-side mirror of the give-back cap /
// chandelier loss-control). A STANDALONE flag, deliberately NOT gated under the
// `EXIT_RISK_RULES_ENABLED` master. The board approved arming take-profit-early
// on the DEMO book only (interaction `73ef18b0`, parent TRA-1290). bqb1 is the
// SINGLE production instance (it also owns the live Tradier creds), so flipping
// the process-wide master there would enable the loss-side rules (TRA-1267/1268)
// on the LIVE options path too — that is NOT demo-only and is a separate
// TRA-1270 decision. Decoupling lets the demo rollout arm the profit mirror with
// zero live-path change. The caller additionally scopes the attach to
// `mode === 'demo'` and reads the flag through the `<DATA_DIR>/demo-flags.json`
// override (see DEMO_FLAG_ALLOWLIST), matching the scale-out-ladder / sma200
// forward-test observe-only rollout pattern. OFF by default (1/true/yes/on).
export const TAKE_PROFIT_EARLY_FLAG = 'TAKE_PROFIT_EARLY_ENABLED';

/** True iff take-profit-early is enabled (standalone; accepts 1/true/yes/on). */
export function isTakeProfitEarlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[TAKE_PROFIT_EARLY_FLAG]);
}

// TRA-1295 — the "7%" leg of the 3-5-7 governor: the correlated-exposure cap. A
// SEPARATE sub-flag so the board can run the shipped loss-control rules
// (TRA-1267/1268) and independently arm the correlated-exposure admission gate
// once it's validated. Deliberately gated by BOTH the master switch AND its own
// flag: it can REJECT / scale down new entries, so it stays dark unless
// `EXIT_RISK_RULES_ENABLED` AND `CORRELATED_EXPOSURE_CAP_ENABLED` are both truthy
// (1/true/yes/on).
export const CORRELATED_EXPOSURE_CAP_FLAG = 'CORRELATED_EXPOSURE_CAP_ENABLED';

/**
 * True iff the correlated-exposure cap (Rule 5) is enabled. Requires the master
 * exit-risk switch on as well — the sub-flag alone does nothing.
 */
export function isCorrelatedExposureCapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[CORRELATED_EXPOSURE_CAP_FLAG]);
}

// TRA-1293 — PoP / delta entry gate + Delta/Theta ratio floor. A SEPARATE
// sub-flag so the board can run the shipped loss-control / take-profit rules and
// independently arm the Greeks entry gate once its thresholds are tuned.
// Deliberately gated by BOTH the master switch AND its own flag: it is a HARD
// entry filter that can REJECT new option opens, so it stays dark unless
// `EXIT_RISK_RULES_ENABLED` AND `ENTRY_GREEKS_GATE_ENABLED` are both truthy
// (1/true/yes/on).
export const ENTRY_GREEKS_GATE_FLAG = 'ENTRY_GREEKS_GATE_ENABLED';

/**
 * True iff the PoP / delta entry gate (TRA-1293) is enabled. Requires the master
 * exit-risk switch on as well — the sub-flag alone does nothing.
 */
export function isEntryGreeksGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[ENTRY_GREEKS_GATE_FLAG]);
}

// TRA-1407 (parent TRA-1406 "less noise, more quality") — a minimum |delta| floor
// on the single_leg_otm opener. The demo journal showed the OTM sleeve bleeds
// entirely in low delta (Δ<0.15 avgR −0.075, −$6.2k) while Δ≥0.45 makes avgR
// +0.55 — a floor flips the sleeve from ≈−$7.1k to +$7.9k by dropping the
// lottery-ticket tail. A STANDALONE flag (NOT under the EXIT_RISK_RULES master):
// the signal-engine consults it ONLY on the `mode === 'demo'` OTM branch, so it
// is structurally incapable of altering a live option open, matching the
// containment TAKE_PROFIT_EARLY_ENABLED / ENTRY_GREEKS_GATE use. This partially
// walks back the TRA-1207 far-OTM thesis toward near-money, so it ships OFF by
// default and the board flips it via demo-flags.json after QuantTrader's
// forward-validation. OFF by default (1/true/yes/on).
export const OTM_DELTA_FLOOR_FLAG = 'OTM_DELTA_FLOOR_ENABLED';
/** Numeric override of the floor (default 0.40, the QuantTrader recommendation). */
export const OTM_DELTA_FLOOR_VALUE = 'OTM_DELTA_FLOOR';
export const OTM_DELTA_FLOOR_DEFAULT = 0.4;

/** True iff the OTM delta floor is enabled (standalone; accepts 1/true/yes/on). */
export function isOtmDeltaFloorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OTM_DELTA_FLOOR_FLAG]);
}

/**
 * Resolve the effective |delta| floor. Reads the optional numeric `OTM_DELTA_FLOOR`
 * override, falling back to {@link OTM_DELTA_FLOOR_DEFAULT}. A malformed or
 * out-of-range value (≤0 or ≥1 — a delta is a probability-like [0,1] magnitude)
 * falls back to the default rather than silently disabling the gate.
 */
export function resolveOtmDeltaFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OTM_DELTA_FLOOR_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
  }
  return OTM_DELTA_FLOOR_DEFAULT;
}

// TRA-1670 (TRA-1647B, parent TRA-1647) — the OTHER half of the band: a
// per-structure entry-delta CEILING.
//
// ── WHY A SECOND KNOB AND NOT A RETUNE OF THE COST GATE ──────────────────────
// The TRA-1602 cost-aware gate admits iff
//   min(mult·|Δ|, cap)·(rewardR + 1) − 1  ≥  bar
// which solves to |Δ| ≥ (bar + 1) / (mult · (rewardR + 1)) — an algebraic ONE-SIDED
// FLOOR (|Δ| ≥ 0.495 at the shipped default). Raising delta always raises modeled R,
// so a higher-delta contract is always MORE admissible and no setting of
// mult / rewardR / cap / minGrossR can make the gate reject the top of the delta
// range: they only slide the floor. The cost gate is therefore structurally
// incapable of cutting the OTM loss tail, and only a ceiling can reach it.
//
// ── WHAT THE CEILING CUTS (QuantTrader, TRA-1670; numbers are theirs) ────────
// Over 2,153 closed demo rows on the pinned build, net of the MEASURED 0.285R taker
// cost (TRA-1656), the `single_leg_otm` sleeve under the floor+bar cut is n=75 /
// NET +1.198R (t=2.07). Adding a 0.55 ceiling: n=61 / NET +1.889R (t=2.89). The
// Δ>0.55 tail it removes is n=14 / NET −1.813R (t=−2.08). The mechanism — not just
// the mean — is that OTM's realized win rate TRACKS the gate's `winProb = |Δ|` model
// up to 0.50 (0.463 realized vs 0.475 modeled in 0.45–0.50) and then BREAKS
// (0.55–0.60: 0.077 realized vs 0.575 modeled). The gate's monotonicity assumption
// is provably false exactly where only a ceiling can reach.
//
// ── HONEST CAVEAT ────────────────────────────────────────────────────────────
// n=14 in the tail, post-hoc on the same book that was graded (the TRA-992 /
// TRA-1585 coin-flip trap). It ships DEMO-ONLY with zero capital at risk, and the
// invalidation is written into TRA-1647: if Δ ∈ (0.55, 0.70] reaches n ≥ 30 with net
// avgR > 0, DROP the ceiling.
//
// ── CONTAINMENT ──────────────────────────────────────────────────────────────
// STANDALONE flag (NOT under the EXIT_RISK_RULES master), and the signal-engine
// consults it only on a `mode === 'demo'` branch — structurally incapable of
// altering a LIVE option open, matching the OTM_DELTA_FLOOR / cost-gate containment.
// OFF by default. SCOPED, not global: the 0.55 number is measured on OTM ONLY, so
// the structure list defaults to `single_leg_otm` alone and the other sleeves stay
// UNCAPPED rather than inheriting an extrapolated number. The board can widen the
// list (or retune the number) via demo-flags.json with no redeploy.
export const OPTION_ENTRY_DELTA_CEILING_FLAG = 'OPTION_ENTRY_DELTA_CEILING_ENABLED';
/** Numeric override of the ceiling (default 0.55, the QuantTrader measurement). */
export const OPTION_ENTRY_DELTA_CEILING_VALUE = 'OPTION_ENTRY_DELTA_CEILING';
export const OPTION_ENTRY_DELTA_CEILING_DEFAULT = 0.55;
/**
 * CSV override of the structures the ceiling applies to (default `single_leg_otm`).
 *
 * TRA-1689 — each entry is `name` or `name:ceiling`. A BARE name inherits the global
 * OPTION_ENTRY_DELTA_CEILING; `name:value` gives that structure ITS OWN ceiling.
 *
 *   single_leg_otm,single_leg_rv:0.65   → OTM cut at the global 0.55, RV at 0.65
 *
 * The per-structure form exists because the number is MEASURED PER SLEEVE and the
 * global scalar silently coupled them: arming RV at 0.65 the only way the old config
 * allowed (add it to the list, set the global to 0.65) also dragged OTM's ceiling from
 * 0.55 to 0.65 — re-admitting the exact n=14 / NET −1.813R tail TRA-1670 shipped to
 * cut. One demo-flags edit, no redeploy, no error, and the health endpoint still read
 * ARMED. A band measured on one sleeve must not be reachable from another sleeve's knob.
 */
export const OPTION_ENTRY_DELTA_CEILING_STRUCTURES_VALUE = 'OPTION_ENTRY_DELTA_CEILING_STRUCTURES';
export const OPTION_ENTRY_DELTA_CEILING_STRUCTURES_DEFAULT: readonly string[] = ['single_leg_otm'];
/**
 * TRA-1689 — CSV of structures the ceiling OBSERVES rather than ENFORCES. A breach on
 * an observe-only structure is COUNTED (its own ledger axis) and then ADMITTED: the
 * open proceeds exactly as if the ceiling were off.
 *
 * This is the only way to answer "is the tail above X actually a loser on THIS sleeve?"
 * without betting the sleeve on the answer. Arming a ceiling to find out costs you every
 * trade above it; observing costs nothing and yields the same n. Empty by default —
 * every listed structure ENFORCES unless it appears here.
 */
export const OPTION_ENTRY_DELTA_CEILING_OBSERVE_VALUE = 'OPTION_ENTRY_DELTA_CEILING_OBSERVE_STRUCTURES';

/** True iff the entry-delta ceiling is enabled (standalone; accepts 1/true/yes/on). */
export function isEntryDeltaCeilingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OPTION_ENTRY_DELTA_CEILING_FLAG]);
}

/**
 * Resolve the effective |delta| ceiling. A malformed or out-of-range value (≤0 or
 * ≥1 — a delta is a probability-like [0,1] magnitude) falls back to the default
 * rather than silently disabling the cut.
 */
export function resolveEntryDeltaCeiling(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OPTION_ENTRY_DELTA_CEILING_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
  }
  return OPTION_ENTRY_DELTA_CEILING_DEFAULT;
}

/**
 * TRA-1689 — resolve the EFFECTIVE ceiling map: structure -> its own |delta| ceiling.
 *
 * Each CSV entry is `name` (inherits the global OPTION_ENTRY_DELTA_CEILING) or
 * `name:value` (that structure's own number). An out-of-range or malformed `:value`
 * falls back to the global rather than dropping the structure — a typo in the number
 * must never silently UNCAP a sleeve the operator plainly meant to cap.
 *
 * An empty / all-blank override falls back to the default (OTM only) — an operator
 * cannot accidentally disarm the cut by blanking the list; disarming is what the
 * flag is for.
 */
export function resolveEntryDeltaCeilingMap(env: NodeJS.ProcessEnv = process.env): Map<string, number> {
  const globalCeiling = resolveEntryDeltaCeiling(env);
  const raw = env[OPTION_ENTRY_DELTA_CEILING_STRUCTURES_VALUE];
  const entries = typeof raw === 'string' && raw.trim() !== ''
    ? raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '')
    : [];
  const source = entries.length > 0 ? entries : [...OPTION_ENTRY_DELTA_CEILING_STRUCTURES_DEFAULT];

  const map = new Map<string, number>();
  for (const entry of source) {
    const sep = entry.indexOf(':');
    if (sep < 0) {
      map.set(entry, globalCeiling);
      continue;
    }
    const name = entry.slice(0, sep).trim();
    if (name === '') continue;
    const parsed = Number(entry.slice(sep + 1).trim());
    const valid = Number.isFinite(parsed) && parsed > 0 && parsed < 1;
    map.set(name, valid ? parsed : globalCeiling);
  }
  return map;
}

/**
 * Resolve the structures the ceiling applies to (names only — the numbers live in
 * `resolveEntryDeltaCeilingMap`). Kept for the health view and existing callers.
 */
export function resolveEntryDeltaCeilingStructures(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...resolveEntryDeltaCeilingMap(env).keys()];
}

/**
 * TRA-1689 — the structures whose breaches are OBSERVED, not enforced. Empty by
 * default. Listing a structure here that is not in the ceiling map does nothing:
 * observation is a property of an armed ceiling, not a way to arm one.
 */
export function resolveEntryDeltaCeilingObserveStructures(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env[OPTION_ENTRY_DELTA_CEILING_OBSERVE_VALUE];
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
}

/** The ceiling's verdict on one candidate. */
export interface EntryDeltaCeilingVerdict {
  /** True iff |delta| exceeded this structure's ceiling. */
  breached: boolean;
  /** True iff the breach must BLOCK the open (false = observe-only: count and admit). */
  enforced: boolean;
  /** The ceiling this structure was actually measured against (null when uncapped/off). */
  ceiling: number | null;
  /** Human-readable reason — present on ANY breach, enforced or merely observed. */
  reason: string | null;
}

const ADMITTED: EntryDeltaCeilingVerdict = { breached: false, enforced: false, ceiling: null, reason: null };

/**
 * The ceiling verdict for one candidate.
 *
 * A missing or non-finite delta is ADMITTED (honest-unknown): the ceiling's job is
 * to cut a measured tail, and rejecting on an absent greek would silently starve a
 * sleeve on a data outage rather than cut a loser. The floor upstream is what keeps
 * a delta-less candidate out when that is wanted.
 */
export function entryDeltaCeilingVerdict(
  structure: string,
  delta: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EntryDeltaCeilingVerdict {
  if (!isEntryDeltaCeilingEnabled(env)) return ADMITTED;
  const ceiling = resolveEntryDeltaCeilingMap(env).get(structure);
  if (ceiling === undefined) return ADMITTED;
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return ADMITTED;
  const abs = Math.abs(delta);
  if (abs <= ceiling) return { breached: false, enforced: false, ceiling, reason: null };

  const enforced = !resolveEntryDeltaCeilingObserveStructures(env).includes(structure);
  const suffix = enforced ? '' : ' [OBSERVE-ONLY: counted, not blocked]';
  return {
    breached: true,
    enforced,
    ceiling,
    reason: `entry delta ceiling (TRA-1670): |Δ| ${abs.toFixed(3)} > ${ceiling.toFixed(2)} on ${structure}${suffix}`,
  };
}

/**
 * The ceiling's BLOCKING verdict: a rejection reason only when the breach actually
 * stops the open. An observe-only breach returns `null` here — it did not reject
 * anything, and a caller that treats it as a rejection would be lying about what the
 * engine did (TRA-1682). Use `entryDeltaCeilingVerdict` when you need to COUNT breaches.
 */
export function entryDeltaCeilingReject(
  structure: string,
  delta: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const verdict = entryDeltaCeilingVerdict(structure, delta, env);
  return verdict.breached && verdict.enforced ? verdict.reason : null;
}

// TRA-1409 (parent TRA-1406 "less noise, more quality") — the RV single_leg exit
// re-tune: require a CONFIRMED N-bar Supertrend flip before the structural
// `supertrend_flip` exit fires (QuantTrader variant (a), N=2 — decision
// TRA-1415). The 07-06 demo journal showed the single-bar supertrend_flip is the
// scratch driver (202 exits, 97% scratch, +$318) vs the ma20_close_through winner
// exit (80 exits, +$2,453); requiring 2 consecutive flipped bars drops whipsaws
// so winners survive to the MA20 cross. A STANDALONE flag (NOT under the
// EXIT_RISK_RULES master): the signal-engine consults it ONLY on the
// `mode === 'demo'` RV branch, so it is structurally incapable of altering a live
// option exit — matching the OTM_DELTA_FLOOR / TAKE_PROFIT_EARLY containment. It
// only ever makes the STRUCTURAL flip fire LESS, never suppresses/loosens/delays
// a risk-side exit (chandelier / give-back / hard SL run in their own block and
// keep precedence). OFF by default; the board flips it via demo-flags.json after
// QuantTrader's forward-validation (no PM2/admin). Accepts 1/true/yes/on.
export const RV_EXIT_RETUNE_FLAG = 'RV_EXIT_RETUNE_ENABLED';
/** Numeric override of the confirm-bars count (default 2, the QuantTrader pick). */
export const RV_EXIT_RETUNE_CONFIRM_BARS_VALUE = 'RV_EXIT_RETUNE_CONFIRM_BARS';
export const RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT = 2;
// TRA-1480 (v2) — winner-protect P&L gate on the RV `supertrend_flip` exit. The
// v1 2-bar confirm did NOT cut the churn: forward journal showed supertrend_flip
// still 96.9% scratch (352 closed / +$425 ≈ breakeven pump) while the winner
// exits — ma20_close_through (+$2.4k) and trail (+$21k) — pay. Root cause: a
// confirmed flip still exits FLAT/WINNING RV positions at breakeven before MA20
// develops. This override sets the loss threshold below which (and only below
// which) the flip is allowed to fire; a flat-or-green position ignores the flip
// and runs to ma20/trail. Absent/blank → undefined → v1 behaviour unchanged (no
// silent behavioural change on redeploy of the already-armed v1). Expected loss
// fraction in (-1, 0]; out-of-range/malformed falls back to undefined.
export const RV_EXIT_FLIP_MIN_LOSS_PCT_VALUE = 'RV_EXIT_FLIP_MIN_LOSS_PCT';

/** True iff the RV exit re-tune is enabled (standalone; accepts 1/true/yes/on). */
export function isRvExitRetuneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[RV_EXIT_RETUNE_FLAG]);
}

/**
 * Resolve the effective RV Supertrend-flip confirm-bars count. Reads the optional
 * integer `RV_EXIT_RETUNE_CONFIRM_BARS` override (clamped to a sane [1,10]),
 * falling back to {@link RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT}. A malformed or
 * out-of-range value falls back to the default rather than silently disabling the
 * confirmation.
 */
export function resolveRvExitConfirmBars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RV_EXIT_RETUNE_CONFIRM_BARS_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) return parsed;
  }
  return RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT;
}

/**
 * Resolve the optional RV `supertrend_flip` winner-protect loss threshold
 * (TRA-1480 v2). Reads {@link RV_EXIT_FLIP_MIN_LOSS_PCT_VALUE}; returns the
 * parsed fraction only when it is a finite loss in the range (-1, 0], otherwise
 * `undefined` (gate disabled → v1 flip-at-any-P&L behaviour preserved). A value
 * of 0 suppresses the flip on ANY non-losing position. This is consulted only
 * inside the demo RV exit branch that already requires `RV_EXIT_RETUNE_ENABLED`,
 * so no separate enable flag is needed.
 */
export function resolveRvExitFlipMinLossPct(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[RV_EXIT_FLIP_MIN_LOSS_PCT_VALUE];
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > -1 && parsed <= 0) return parsed;
  }
  return undefined;
}

// TRA-1435 — minimum ARM floor for the book-level give-back cap (Rule 3). Today
// the give-back cap arms at ANY positive peak, so a +$7 peak on a $2.2k book that
// gives back ~$5 inside spread/noise latches a whole-session halt — STRICTER than
// the sibling session-stop (which has a 0.5R arm). This sub-flag arms a minimum
// floor: the give-back cap only trips once the day's peak reaches
// `max(BOOK_GIVEBACK_ARM_ABS_FLOOR_USD, BOOK_GIVEBACK_ARM_FLOOR_R × book risk
// unit)`. Gated by BOTH the `EXIT_RISK_RULES_ENABLED` master AND its own flag so
// the give-back cap's arm behavior is a deliberate, revertible board/CTO arm
// decision (validated by QuantTrader on the demo book). OFF by default preserves
// the current (arm-at-any-peak) behavior — the caller passes a 0 arm floor, so
// `bookGiveBackDecision` is byte-for-byte unchanged. Accepts 1/true/yes/on.
export const BOOK_GIVEBACK_ARM_FLOOR_FLAG = 'BOOK_GIVEBACK_ARM_FLOOR_ENABLED';

/**
 * True iff the give-back cap's minimum arm floor (TRA-1435) is enabled. Requires
 * the master exit-risk switch on as well — the sub-flag alone does nothing (the
 * give-back cap itself only runs when `EXIT_RISK_RULES_ENABLED` is on).
 */
export function isBookGiveBackArmFloorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExitRiskRulesEnabled(env) && flagOn(env[BOOK_GIVEBACK_ARM_FLOOR_FLAG]);
}
