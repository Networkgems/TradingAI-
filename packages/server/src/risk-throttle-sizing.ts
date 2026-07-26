// TRA-1001 (parent TRA-995) — CONSUME the risk-autopilot throttle in per-trade
// sizing.
//
// TRA-995 shipped the autopilot: it decides HALT or THROTTLE and can only ever
// tighten. Its HALT has been consumed live since day one (every entry chokepoint
// reads `riskGovernor.isHalted()`), but the THROTTLE was surfaced-and-observed
// only — a 50% throttle logged a de-risk action in health + EOD while every
// ticket still sized at 100%. This module is the seam that makes the throttle
// actually trim share/contract counts.
//
// Two things live here, deliberately together:
//
//   1. `riskThrottleSizeMultiplier` — the PURE tighten-only clamp. It is the
//      single place that decides what a throttle value means for sizing, so the
//      "never raises a sized quantity" invariant is one unit-testable function
//      rather than a rule re-implemented at six call sites.
//
//   2. A since-boot counted registry. The throttle is 1 on most days, and a
//      multiplier of 1 is byte-for-byte the pre-TRA-1001 behaviour — i.e. an
//      ARMED-but-never-throttled build reads EXACTLY like an unarmed one, and
//      like a build where the wiring silently regressed. `trims` makes "did the
//      consuming path ever actually run with a real throttle?" a countable
//      question instead of an assumption (the TRA-2302 `source`-enum lesson).
//
// GATED (the issue title): this changes LIVE position-sizing math, so it ships
// OFF and the board arms it with `RISK_THROTTLE_SIZING_ENABLED` after forward
// evidence, exactly like the other live-risk flags in `exit-risk-rules-flag.ts`.
// Flag OFF ⇒ multiplier is always 1 ⇒ sizing is byte-for-byte unchanged, and the
// registry still records the consult (with `armed: false`), so health can show
// how often a throttle WOULD have trimmed before anyone flips it.
//
// TRA-2333 (parent TRA-2331) — two changes that make "arm it narrowly and grade
// what it did" reachable, neither of which TRA-1001's boolean supported:
//
//   A. The flag is TRI-STATE (`off` | `demo` | `all`) and the gate is per-PATH,
//      so `demo` provably leaves the two live-broker chokepoints at 1. The
//      snapshot's old `armed: boolean` is GONE, replaced by `armedScope` plus a
//      per-path `armed` — because a demo arm and a live arm both read
//      `armed: true`, and a health surface that cannot tell those apart is the
//      same defect this module's counted registry exists to prevent.
//
//   B. The applied multiplier is STAMPED ON THE FILL (`riskThrottleMultiplier` /
//      `riskThrottleArmedScope` on the option-journal open row and on the demo
//      equity `Position`). The since-boot counters here say how MANY tickets
//      were trimmed, never WHICH — so a trim could not be joined to the trade's
//      R/P&L, and grading trimmed fills against un-trimmed ones (the entire
//      TRA-2331 deliverable) was not computable. They are also since-BOOT, and
//      bqb1 restarts unguarded (TRA-2186 env writes, TRA-2203/2261 watchdog
//      pm2 self-restarts), so a daily counter sample silently loses every trim
//      from before the last restart — and an undercount reads exactly like a
//      quiet week. The stamp is durable and always written, including when it is
//      exactly 1: if it were written only on a trim, ABSENT would collapse into
//      "un-trimmed" and a build where the stamp regressed would be
//      indistinguishable from a calm market (the TRA-2302 `?? 0` lesson).
//      Absent therefore means exactly one thing: written by a build older than
//      TRA-2333.
//
// TRA-2339 (parent TRA-2331) — the DECIDED term, alongside the applied one.
//
// TRA-1001 claimed the registry could answer "how often WOULD a throttle have
// trimmed?" before anyone armed the flag. It could not, and the reason was one
// line: `trims` was gated on the APPLIED multiplier, and
// `riskThrottleSizeMultiplier(throttle, false)` returns 1 before it ever looks at
// `throttle`. So while the scope was `off`, `trims` was IDENTICALLY 0 and
// `minMultiplier` IDENTICALLY null — whether the autopilot had held 1.0 all week
// or 0.35 all week. `trims: 0` read exactly the same in "the throttle never
// fired" and in "the throttle fired on every entry and we could not see it":
// precisely the pass/fail-indistinguishable shape this counted registry was built
// to prevent, reintroduced one level down in the gating predicate. The only
// unconditional record was `lastThrottle` — last-write-wins, a point sample, not
// a count.
//
// That is not a historical curiosity now that `demo` is armed. Under `demo` the
// two live-broker paths resolve `armed: false` BY DESIGN, so THEIR `trims` stay
// structurally 0 — and the board's live-arm step needs exactly the number that
// gates on: how often, and how hard, would the live chokepoint have been trimmed?
// No observation period can produce it, because arming live to measure it is the
// very decision the measurement is meant to inform.
//
// So every consult now also carries the DECIDED term — what the multiplier would
// have been under `armed: true` — and it is recorded regardless of `armed`:
//
//   • `wouldTrims` / `minWouldMultiplier` — the dark-observation counters. Both
//     move while the path is unarmed.
//   • `trims` / `minMultiplier` — UNCHANGED, still the applied terms. The point is
//     to have both, not to redefine either: `trims` remains the answer to "did
//     this build actually shrink a ticket?", which is a different question and the
//     one the arm itself is graded on.
//
// Per-fill, the same pair is stamped on the row (`riskThrottleDecided` next to
// `riskThrottleMultiplier`), so `decided < 1 && multiplier === 1` is exactly the
// would-have-been-trimmed cohort, joinable to that trade's own R.

import { MIN_RISK_THROTTLE } from './risk-autopilot.js';

export const RISK_THROTTLE_SIZING_FLAG = 'RISK_THROTTLE_SIZING_ENABLED';

/**
 * TRA-2333 — how far the sizing consumer is armed.
 *
 *   • `off`  — nobody consumes the throttle; every path sizes at multiplier 1.
 *   • `demo` — the paper/demo chokepoints consume it; the two LIVE-broker
 *              chokepoints are still hard-pinned to 1.
 *   • `all`  — every chokepoint consumes it, including the real Tradier
 *              bracket-order quantity.
 *
 * A tri-state rather than a boolean because TRA-2331 asks for "demo first", and
 * on the TRA-1001 boolean there is no such value: one `=1` armed all seven
 * chokepoints at once (`path` was passed to the registry for telemetry only and
 * did not gate). That was survivable in July 2026 only via three EMPIRICAL zeros
 * — `mode: demo`, broker `authOk:false`, and the TRA-1897 HOLD posture — i.e.
 * exactly the shape of the `EXIT_RISK` master-reach finding, where a bare live
 * call site was safe only while `liveEngineCount` happened to be 0. An empirical
 * zero expires; a structural scope does not.
 */
export type RiskThrottleSizingScope = 'off' | 'demo' | 'all';

/**
 * The chokepoints that put quantity on a REAL broker ticket. These require
 * `all`; `demo` leaves them at multiplier 1. `equity_live_mirror` is in here
 * with `equity_live` deliberately — the mirror books the local row for the
 * broker order, so arming one without the other would book a mirror that does
 * not match the ticket the broker filled.
 */
export const RISK_THROTTLE_LIVE_PATHS = ['equity_live', 'equity_live_mirror'] as const;

/**
 * Resolve the arming scope from the environment.
 *
 * LEGACY MAPPING (explicit, TRA-2333): the pre-existing truthy spellings
 * `1` / `true` / `yes` / `on` map to **`demo`**, NOT to `all`. The flag shipped
 * dark and has never been set anywhere, but the rule is chosen so that if a
 * truthy value ever does turn up — in an old runbook, a stale Render env row
 * restored by the TRA-2136 wipe recovery, a copied `.env` — it can only ever
 * *narrow* to demo. A legacy value must never be able to widen scope onto the
 * live broker path. Arming live is a deliberate, un-abbreviated `=all`.
 *
 * Anything unrecognised (including `0`/`false`/`off`/empty/absent) is `off`.
 */
export function riskThrottleSizingScope(env: NodeJS.ProcessEnv = process.env): RiskThrottleSizingScope {
  const raw = env[RISK_THROTTLE_SIZING_FLAG];
  if (typeof raw !== 'string') return 'off';
  const v = raw.trim().toLowerCase();
  if (v === 'all') return 'all';
  if (v === 'demo') return 'demo';
  // Legacy truthy ⇒ demo (narrowing only — see above).
  if (['1', 'true', 'yes', 'on'].includes(v)) return 'demo';
  return 'off';
}

/**
 * Is THIS chokepoint armed under THIS scope? The structural gate Gap A asks
 * for — the decision is made from the path, not re-derived at each call site.
 */
export function isRiskThrottleSizingArmedForPath(
  path: RiskThrottleSizingPath,
  scope: RiskThrottleSizingScope,
): boolean {
  if (scope === 'off') return false;
  if ((RISK_THROTTLE_LIVE_PATHS as readonly string[]).includes(path)) return scope === 'all';
  return true; // scope is 'demo' or 'all'
}

/**
 * The tighten-only sizing multiplier for a given autopilot throttle.
 *
 * Contract — the invariant TRA-995 Invariant 4 demands, enforced here so no
 * caller can violate it by arithmetic accident:
 *   • `armed === false`      ⇒ 1 (dark; sizing unchanged)
 *   • non-finite throttle    ⇒ 1 (no information ⇒ no trim; a NaN must never
 *                                 silently zero the book)
 *   • throttle ≥ 1           ⇒ 1 (the autopilot may never RAISE size)
 *   • otherwise              ⇒ clamped into [MIN_RISK_THROTTLE, 1)
 *
 * The `≤ 0` case clamps UP to `MIN_RISK_THROTTLE` rather than through to 0: a
 * zero/negative throttle is a corrupted input, and the conservative reading of
 * "de-risk" is "size small", not "the autopilot silently became a second halt".
 * A real halt is a separate, explicit, surfaced state (`isHalted()`).
 *
 * The return value is never > 1, so composing it into an existing
 * `sizeMultiplier` argument can only ever shrink a sized quantity.
 */
export function riskThrottleSizeMultiplier(throttle: number | null | undefined, armed: boolean): number {
  if (!armed) return 1;
  if (typeof throttle !== 'number' || !Number.isFinite(throttle)) return 1;
  if (throttle >= 1) return 1;
  return Math.min(1, Math.max(MIN_RISK_THROTTLE, throttle));
}

/**
 * TRA-2339 — the DECIDED sizing multiplier: what {@link riskThrottleSizeMultiplier}
 * would have returned for this throttle had the path been armed.
 *
 * Identical clamp, `armed` pinned to `true`. It exists as its own named function
 * rather than as a bare `riskThrottleSizeMultiplier(t, true)` at four call sites
 * so that "the counterfactual is computed through the SAME clamp as the applied
 * term" is a property of one function instead of a convention. If the clamp ever
 * changes, the decided/applied pair cannot drift apart — which matters, because
 * the whole value of the pair is that `decided < 1 && applied === 1` isolates the
 * arming decision and nothing else.
 *
 * Pure and side-effect free: it records nothing. Reading the counterfactual must
 * never be able to move a counter.
 */
export function riskThrottleDecidedMultiplier(throttle: number | null | undefined): number {
  return riskThrottleSizeMultiplier(throttle, true);
}

// ── Counted-reason telemetry ────────────────────────────────────────────────

/** Which sizing chokepoint consulted the throttle. */
export type RiskThrottleSizingPath =
  /** Live Tradier equity bracket — the real broker order quantity. */
  | 'equity_live'
  /** Local mirror of that bracket (kept in lockstep with `equity_live`). */
  | 'equity_live_mirror'
  /** Demo `PaperAccount.openPosition` share sizing. */
  | 'equity_demo'
  /** Single-leg options open (RV / directional / AI-ideas). */
  | 'options_single_leg'
  /** OTM-mispricing options open. */
  | 'options_otm'
  /** Correlated-exposure-cap candidate-risk estimate (not an order). */
  | 'equity_cap_estimate'
  /** Agent-proposal notional estimate (not an order). */
  | 'proposal_estimate';

export interface RiskThrottleSizingPathStats {
  /**
   * TRA-2333 — whether THIS path was armed on its most recent consult.
   *
   * The per-path bit is the whole point of the scope work: under
   * `RISK_THROTTLE_SIZING_ENABLED=demo` a reader must be able to see that
   * `equity_live` was consulted and was NOT armed while `equity_demo` was. A
   * single top-level boolean cannot express that, and a demo-armed build would
   * have read identically to an accidentally-live-armed one.
   *
   * "Most recent consult" is exact rather than approximate: the scope is
   * process-level (read from `process.env`), so within one boot every consult
   * of a given path sees the same value.
   */
  armed: boolean;
  /** How many times this path asked for the multiplier. */
  consults: number;
  /**
   * How many of those returned an APPLIED multiplier < 1, i.e. actually trimmed
   * size. Structurally 0 whenever this path is unarmed — that is correct and
   * intended (nothing was trimmed), but it is NOT the dark-observation number.
   * For that read {@link wouldTrims}.
   */
  trims: number;
  /** The smallest multiplier this path has APPLIED since boot (null ⇒ never trimmed). */
  minMultiplier: number | null;
  /**
   * TRA-2339 — how many consults the autopilot's throttle WOULD have trimmed,
   * counted from the decided term and therefore independent of `armed`.
   *
   * This is the counter TRA-2331 step 1 assumed `trims` already was. On an
   * unarmed path `wouldTrims > 0` with `trims === 0` is the whole dark-observation
   * signal: the throttle fired and we declined to consume it. On an armed path the
   * two track each other, and a divergence would mean the gate and the clamp
   * disagree.
   */
  wouldTrims: number;
  /**
   * TRA-2339 — the smallest DECIDED multiplier seen since boot (null ⇒ the
   * throttle has never been below 1 while this path was sizing). Answers "and by
   * how much?" for the unarmed case, where `minMultiplier` is identically null.
   */
  minWouldMultiplier: number | null;
  /** The throttle value seen on the most recent consult. */
  lastThrottle: number | null;
}

const pathStats = new Map<RiskThrottleSizingPath, RiskThrottleSizingPathStats>();

/**
 * Record one sizing consult for the since-boot rollup.
 *
 * `decided` is REQUIRED (TRA-2339) rather than optional-with-a-default. An
 * omitted-defaults-to-`multiplier` signature would let a call site that forgot it
 * report `wouldTrims: 0` on an unarmed path — reinstating, silently, the exact
 * false zero this field exists to remove. Required makes it a compile error at
 * every call site instead.
 */
export function recordRiskThrottleSizing(
  path: RiskThrottleSizingPath,
  detail: { armed: boolean; throttle: number; multiplier: number; decided: number },
): void {
  const cur = pathStats.get(path) ?? {
    armed: false,
    consults: 0,
    trims: 0,
    minMultiplier: null,
    wouldTrims: 0,
    minWouldMultiplier: null,
    lastThrottle: null,
  };
  cur.armed = detail.armed;
  cur.consults += 1;
  cur.lastThrottle = Number.isFinite(detail.throttle) ? detail.throttle : null;
  if (detail.multiplier < 1) {
    cur.trims += 1;
    cur.minMultiplier = cur.minMultiplier === null
      ? detail.multiplier
      : Math.min(cur.minMultiplier, detail.multiplier);
  }
  // TRA-2339 — the counterfactual, gated on the DECIDED term and NOT on `armed`.
  if (detail.decided < 1) {
    cur.wouldTrims += 1;
    cur.minWouldMultiplier = cur.minWouldMultiplier === null
      ? detail.decided
      : Math.min(cur.minWouldMultiplier, detail.decided);
  }
  pathStats.set(path, cur);
}

export interface RiskThrottleSizingSnapshot {
  /** The env flag name, so a health reader can see WHICH key arms this. */
  flag: string;
  /**
   * TRA-2333 — HOW FAR the consumer is armed right now, replacing the TRA-1001
   * `armed: boolean`.
   *
   * The boolean was deleted rather than kept alongside this on purpose. A
   * demo-armed build and an all-armed build both reported `armed: true`, so the
   * health surface could not tell a correctly-scoped arm from an accidental live
   * one — the same "reads identically in the pass and the fail state" defect the
   * counted registry below was built to avoid, reintroduced one level up. Any
   * reader still asking for `.armed` now gets `undefined` (loudly absent)
   * instead of a `true` that silently drops the distinction.
   */
  armedScope: RiskThrottleSizingScope;
  /** Total consults across every path since boot. */
  totalConsults: number;
  /**
   * Total consults that actually trimmed a sized quantity since boot. THE
   * countable bit: `armed: true` with `totalTrims: 0` means the throttle has
   * never been below 1 while an entry was sized — not that the wiring works.
   */
  totalTrims: number;
  /**
   * TRA-2339 — total consults the throttle WOULD have trimmed since boot,
   * regardless of arming. Compare against {@link totalTrims}:
   *
   *   • `totalWouldTrims: 0`             ⇒ the autopilot has genuinely held the
   *                                        throttle at 1 for every sized entry.
   *   • `> 0` with `totalTrims: 0`       ⇒ it fired and nothing consumed it —
   *                                        the dark cohort, and under `demo` the
   *                                        expected reading for the live paths.
   *   • `totalTrims > totalWouldTrims`   ⇒ impossible; the clamp is shared, so
   *                                        this would mean applied trims are
   *                                        coming from somewhere other than the
   *                                        governor.
   */
  totalWouldTrims: number;
  /** Per-chokepoint breakdown (only paths that were consulted appear). */
  byPath: Partial<Record<RiskThrottleSizingPath, RiskThrottleSizingPathStats>>;
}

/** Snapshot the since-boot counters for the health route. */
export function snapshotRiskThrottleSizing(env: NodeJS.ProcessEnv = process.env): RiskThrottleSizingSnapshot {
  const byPath: Partial<Record<RiskThrottleSizingPath, RiskThrottleSizingPathStats>> = {};
  let totalConsults = 0;
  let totalTrims = 0;
  let totalWouldTrims = 0;
  for (const [path, stats] of pathStats) {
    byPath[path] = { ...stats };
    totalConsults += stats.consults;
    totalTrims += stats.trims;
    totalWouldTrims += stats.wouldTrims;
  }
  return {
    flag: RISK_THROTTLE_SIZING_FLAG,
    armedScope: riskThrottleSizingScope(env),
    totalConsults,
    totalTrims,
    totalWouldTrims,
    byPath,
  };
}

/** Test seam — reset the since-boot counters. */
export function resetRiskThrottleSizingForTests(): void {
  pathStats.clear();
}
