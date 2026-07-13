// TRA-1768 (parent TRA-1318, surfaced by TRA-1729) — READ-ONLY instrument for the
// equity entry funnel.
//
// EQUITY_SWING_MODE reports ACTIVE and the demo equity book has held ZERO positions
// — open or closed — for 8+ days, while the option journal accrued 2,192 rows. The
// scale-out ladder (TRA-1729) iterates that book and has seen an empty array every
// tick. The ladder is the symptom; the entry funnel is the cause. Today nothing
// counts the rejections, so we cannot tell:
//
//   candidatesEvaluated: 0            → the signal never fires   (a STRATEGY problem)
//   candidatesEvaluated: N, admitted:0 → a guardrail eats them all (a CALIBRATION problem)
//
// Both read as "no positions". This module makes them distinguishable.
//
// It matters beyond demo: the swing sleeve was flipped to LIVE on TRA-955/TRA-1306
// and runs the SAME entry logic (`routeEquitySignal`). A live sleeve that admits
// nothing holds no risk and books no P&L — and on the wire that is byte-identical to
// a healthy sleeve that happens to be flat. Hence: report demo and live SEPARATELY,
// never pooled.
//
// ── HARD INVARIANT ───────────────────────────────────────────────────────────
// READ-ONLY. Pure counters. This module places no order, mutates no account, and
// gates nothing. Every hook is called for its side effect on a counter and its
// return value is discarded; deleting the whole module must not change a single
// entry decision. It does NOT "fix" the emptiness — relaxing the swing universe,
// the churn brake, or the ≥2-day hold floor is QuantTrader's policy call and is
// explicitly out of scope until this instrument says which one (if any) is eating.
//
// ── WHY IN-MEMORY / SINCE-BOOT (and not a durable JSONL like TRA-1300) ───────
// Deliberate. `DATA_DIR` is ephemeral on bqb1 (TRA-1719) — a durable ledger there
// dies at every deploy, so any counter needing accrual is pinned at 0 forever and
// reads `pending` for eternity (the trap that killed the TRA-1318 `trimCount>=1`
// gate). This instrument's `n` is 1: ONE tick proves the pass fires and ONE pass
// tells us whether candidates exist. Since-boot is a POORER measurement than a
// durable one — and it is the one we can actually READ, on the FIRST tick after the
// pin lifts. That trade is the whole point.
//
// ── THREE-VALUED, NO FALSE ZEROES ────────────────────────────────────────────
// `null` = no reading. `0` = the pass ran and genuinely saw nothing. `>0` = real.
//
// The subtle one, and the reason `passGateBlockedReason` exists: the deterministic
// equity pass is itself wrapped in a four-way gate —
//
//     if (equityStrategiesActiveOnTick && isDeterministicAutoTradingEnabled()
//         && !riskGovernor.isHalted() && isStockMarketOpen())   // signal-engine.ts
//
// When any of those is false the candidate loop NEVER ITERATES. Stamping
// `candidatesEvaluated: 0` there would be a FALSE ZERO of the worst kind: it would
// read as "the pass ran and generated no ideas" (a strategy problem) when the truth
// is "the pass never looked" (the market was shut). That is precisely the
// pass-state/fail-state collision this issue was opened to kill, so a GATED pass
// leaves `candidatesEvaluated: null` and reports WHICH gate held it. A pass that
// generated no candidates did not reject 0 candidates for a reason — it had NO
// candidates — and those two must never collide.

/** Which book the funnel row describes. Demo and live are NEVER pooled. */
export type EquityEntryMode = 'demo' | 'live';

/**
 * Which generator produced the candidate.
 *
 * Load-bearing under EQUITY_SWING_MODE: swing mode HARD-NULLS the two intraday
 * churners (`orb`, `bbFade_1h` — see `/api/health/equity-swing`.guardrail), which
 * leaves Ichimoku as the ONLY intraday candidate generator on the `deterministic`
 * path, plus the daily `sma200_pullback` router. If `deterministic` reads 0 while
 * swing mode is on, that is Ichimoku alone being dry — not "the scan is broken".
 */
export type EquityEntrySource = 'deterministic' | 'agent-gating' | 'sma200-pullback';

/**
 * Why a candidate that WAS evaluated did not reach the book.
 *
 * A closed union on purpose: a free-form string would let a typo silently mint a new
 * bucket that nobody reads, and an unread bucket is indistinguishable from an empty
 * one. Every member below corresponds to a real `return null` on a live code path.
 *
 * NOTE — there is deliberately NO `min_holding_days` member, though TRA-1768 lists
 * it as a candidate reason. `EQUITY_SWING_GUARDRAIL.minHoldingTradingDays` is read
 * in exactly one place (health-routes, for DISPLAY) and gates discretionary CLOSES,
 * never entries. A rejection bucket for it could never increment, and a bucket that
 * reads 0 both when it is not eating candidates and when it CANNOT eat candidates is
 * a dead instrument — the exact failure this issue exists to prevent. If the hold
 * floor is ever wired into the entry path, add it here and it starts counting.
 */
export type EquityEntryRejectReason =
  // ── routeEquitySignal (the shared chokepoint: deterministic + agent-gating) ──
  | 'swing_universe'             // TRA-952 — symbol outside the curated liquid swing universe
  | 'already_open'               // an equity position for this symbol+type is already open
  | 'recent_signal_dedup'        // same symbol+type fired within the last 5 minutes
  | 'no_quote'                   // TRA-134 — no cached quote; retried next tick
  | 'invalid_bracket'            // TRA-520 — non-positive / inverted stop-target bracket
  | 'daily_trades_limit'         // TRA-554 — daily equity entry cap already reached
  | 'churn_brake'                // TRA-1408 — per-name same-session open cap
  | 'correlated_exposure_cap'    // TRA-1301 — correlated-exposure cap rejected below the risk floor
  | 'live_client_missing'        // live only — Tradier equity client not configured
  | 'live_order_rejected'        // live only — Tradier rejected/cancelled the OTOCO bracket
  | 'sizing_returned_no_position'// the account/mirror returned null (e.g. sized below a floor)
  // ── openSma200Pullback only (its gates are per-candidate, not per-pass) ──────
  | 'capital_gate_manifest'      // TRA-819/817 — not registered as an OOS-passed live entry
  | 'auto_trading_disabled'      // TRA-544 — auto-trading off / agent layer owns the decision
  | 'risk_halted'                // TRA-526 — kill switch / daily circuit-breaker
  | 'market_closed';             // TRA-726 — no entries outside regular trading hours

/**
 * Why the deterministic pass never iterated at all. Distinct from a rejection: no
 * candidate was even LOOKED AT, so `candidatesEvaluated` stays `null`, not `0`.
 */
export type EquityEntryPassGateReason =
  | 'strategies_inactive_on_tick'
  | 'auto_trading_disabled'
  | 'risk_halted'
  | 'market_closed';

/**
 * `never_ran`     — no pass since boot. Says NOTHING about the book.
 * `gated`         — passes fired, but every one was held at the pass gate; the loop
 *                   never iterated. NOT a strategy verdict — see passGateBlockedReason.
 * `no_candidates` — an ungated pass ran and generated ZERO ideas. **The alarm.**
 *                   The signal side is dry; a guardrail cannot be blamed.
 * `all_rejected`  — ideas were generated and every one was eaten. Read
 *                   rejectedByReason: this is a CALIBRATION problem, and it names the eater.
 * `admitting`     — at least one candidate reached the book since boot.
 */
export type EquityEntryFunnelStatus =
  | 'never_ran'
  | 'gated'
  | 'no_candidates'
  | 'all_rejected'
  | 'admitting';

type Counter<K extends string> = Partial<Record<K, number>>;

interface ModeLedger {
  passCount: number;
  gatedPassCount: number;
  /** Passes that actually ITERATED the candidate loop. 0 ⇒ candidatesEvaluated is null. */
  iteratedPassCount: number;
  lastPassAt: number | null;
  lastPassGateBlockedReason: EquityEntryPassGateReason | null;
  lastAdmittedAt: number | null;

  /** Last ITERATED pass only. `null` until one has run. */
  lastPassCandidates: number | null;
  lastPassAdmitted: number | null;
  lastPassRejected: Counter<EquityEntryRejectReason> | null;

  /** Cumulative since boot. */
  cumCandidates: number;
  cumAdmitted: number;
  cumRejected: Counter<EquityEntryRejectReason>;
  cumBySource: Counter<EquityEntrySource>;
}

function emptyLedger(): ModeLedger {
  return {
    passCount: 0,
    gatedPassCount: 0,
    iteratedPassCount: 0,
    lastPassAt: null,
    lastPassGateBlockedReason: null,
    lastAdmittedAt: null,
    lastPassCandidates: null,
    lastPassAdmitted: null,
    lastPassRejected: null,
    cumCandidates: 0,
    cumAdmitted: 0,
    cumRejected: {},
    cumBySource: {},
  };
}

const LEDGERS: Record<EquityEntryMode, ModeLedger> = {
  demo: emptyLedger(),
  live: emptyLedger(),
};

/**
 * The pass currently being accumulated, per mode. Present only between
 * `beginEquityEntryPass` and the next pass boundary; candidate hooks fold into BOTH
 * this and the cumulative ledger.
 *
 * `openSma200Pullback` runs on its own daily cadence and can fire when the
 * deterministic pass was GATED (no open window). Its candidates therefore always count
 * CUMULATIVELY — they are real equity candidates and must never be lost — and fold into
 * `lastPass` only when a window happens to be open (same tick, same funnel). This is
 * why `funnelStatus` keys off the cumulative counters, not `lastPass`: an SMA-200
 * candidate admitted during a gated tick must not read as `never_ran`.
 */
const OPEN_PASS: Record<EquityEntryMode, { candidates: number; admitted: number; rejected: Counter<EquityEntryRejectReason> } | null> = {
  demo: null,
  live: null,
};

function bump<K extends string>(c: Counter<K>, k: K): void {
  c[k] = (c[k] ?? 0) + 1;
}

/**
 * The deterministic equity pass ITERATED this tick. Opens a fresh per-pass window:
 * from here `candidatesEvaluated` is a real number and `0` is a TRUE zero — the pass
 * looked and found nothing.
 */
export function beginEquityEntryPass(mode: EquityEntryMode, at: number = Date.now()): void {
  const led = LEDGERS[mode];
  led.passCount += 1;
  led.iteratedPassCount += 1;
  led.lastPassAt = at;
  led.lastPassGateBlockedReason = null;
  OPEN_PASS[mode] = { candidates: 0, admitted: 0, rejected: {} };
  // Seed the last-pass fields immediately, so a pass that iterates and finds nothing
  // still reports `candidatesEvaluated: 0` (not null) even if no hook fires after this.
  led.lastPassCandidates = 0;
  led.lastPassAdmitted = 0;
  led.lastPassRejected = {};
}

/**
 * The pass FIRED but was held at the gate — the candidate loop never iterated.
 *
 * `passCount` still increments (it is the monotone proof the tick is alive: a pass
 * that never fires at all and a pass that fires but is gated are DIFFERENT states and
 * must not collide). `candidatesEvaluated` is deliberately left untouched — a gated
 * pass evaluated no candidates, it did not evaluate zero.
 */
export function recordEquityEntryPassGated(
  mode: EquityEntryMode,
  reason: EquityEntryPassGateReason,
  at: number = Date.now(),
): void {
  const led = LEDGERS[mode];
  led.passCount += 1;
  led.gatedPassCount += 1;
  led.lastPassAt = at;
  led.lastPassGateBlockedReason = reason;
  OPEN_PASS[mode] = null;
}

/** One equity entry candidate was evaluated (i.e. reached the entry chokepoint). */
export function recordEquityCandidate(mode: EquityEntryMode, source: EquityEntrySource): void {
  const led = LEDGERS[mode];
  led.cumCandidates += 1;
  bump(led.cumBySource, source);
  const pass = OPEN_PASS[mode];
  if (pass) {
    pass.candidates += 1;
    led.lastPassCandidates = pass.candidates;
  }
}

/** A candidate was evaluated and REJECTED before reaching the book. */
export function recordEquityEntryRejected(mode: EquityEntryMode, reason: EquityEntryRejectReason): void {
  const led = LEDGERS[mode];
  bump(led.cumRejected, reason);
  const pass = OPEN_PASS[mode];
  if (pass) {
    bump(pass.rejected, reason);
    led.lastPassRejected = { ...pass.rejected };
  }
}

/** A candidate reached `openPosition` / the broker and a position exists. */
export function recordEquityEntryAdmitted(mode: EquityEntryMode, at: number = Date.now()): void {
  const led = LEDGERS[mode];
  led.cumAdmitted += 1;
  led.lastAdmittedAt = at;
  const pass = OPEN_PASS[mode];
  if (pass) {
    pass.admitted += 1;
    led.lastPassAdmitted = pass.admitted;
  }
}

function statusFor(led: ModeLedger): EquityEntryFunnelStatus {
  // A cumulative verdict, not a last-pass one: the question this instrument answers
  // is "has this sleeve admitted ANYTHING since boot", and one flat tick must not be
  // able to report `no_candidates` over a book that opened a position an hour ago.
  if (led.cumAdmitted > 0) return 'admitting';
  if (led.cumCandidates > 0) return 'all_rejected';
  if (led.iteratedPassCount === 0) return led.passCount === 0 ? 'never_ran' : 'gated';
  return 'no_candidates';
}

/** Serialized funnel for one mode. Every count is three-valued; `null` means NO READING. */
export interface EquityEntryFunnelView {
  funnelStatus: EquityEntryFunnelStatus;
  /** Monotone proof the pass fires at all. 0 ⇒ the engine never reached the pass. */
  passCount: number;
  /** Passes held at the four-way pass gate (market closed, halted, …). */
  gatedPassCount: number;
  /** Passes that actually iterated the candidate loop. 0 ⇒ candidatesEvaluated is null. */
  iteratedPassCount: number;
  lastPassAt: string | null;
  /** Which gate held the most recent pass; null when it iterated. */
  passGateBlockedReason: EquityEntryPassGateReason | null;
  lastAdmittedAt: string | null;
  /** The most recent ITERATED pass. All null until one has run. */
  lastPass: {
    candidatesEvaluated: number | null;
    admitted: number | null;
    rejectedByReason: Counter<EquityEntryRejectReason> | null;
  };
  /** Since boot. `candidatesEvaluated: 0` after an iterated pass is THE ALARM. */
  cumulative: {
    candidatesEvaluated: number | null;
    admitted: number | null;
    rejectedByReason: Counter<EquityEntryRejectReason> | null;
    candidatesBySource: Counter<EquityEntrySource> | null;
  };
}

function viewFor(mode: EquityEntryMode): EquityEntryFunnelView {
  const led = LEDGERS[mode];
  // Three-valued: with no ITERATED pass since boot there is NO READING of the
  // candidate side — not a zero. `0` here must only ever mean "we looked and the
  // signal side was dry", because that reading is what indicts the strategy.
  const looked = led.iteratedPassCount > 0 || led.cumCandidates > 0;
  return {
    funnelStatus: statusFor(led),
    passCount: led.passCount,
    gatedPassCount: led.gatedPassCount,
    iteratedPassCount: led.iteratedPassCount,
    lastPassAt: led.lastPassAt === null ? null : new Date(led.lastPassAt).toISOString(),
    passGateBlockedReason: led.lastPassGateBlockedReason,
    lastAdmittedAt: led.lastAdmittedAt === null ? null : new Date(led.lastAdmittedAt).toISOString(),
    lastPass: {
      candidatesEvaluated: led.lastPassCandidates,
      admitted: led.lastPassAdmitted,
      rejectedByReason: led.lastPassRejected,
    },
    cumulative: {
      candidatesEvaluated: looked ? led.cumCandidates : null,
      admitted: looked ? led.cumAdmitted : null,
      rejectedByReason: looked ? led.cumRejected : null,
      candidatesBySource: looked ? led.cumBySource : null,
    },
  };
}

/** Demo and live, separately labelled. Never pooled — see the module header. */
export function summarizeEquityEntryFunnel(): { demo: EquityEntryFunnelView; live: EquityEntryFunnelView } {
  return { demo: viewFor('demo'), live: viewFor('live') };
}

/** Test-only: drop all state back to boot. */
export function __resetEquityEntryFunnelForTests(): void {
  LEDGERS.demo = emptyLedger();
  LEDGERS.live = emptyLedger();
  OPEN_PASS.demo = null;
  OPEN_PASS.live = null;
}
