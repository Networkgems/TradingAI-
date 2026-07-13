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
 * TRA-1793 — why a symbol inside an ITERATING pass never reached strategy evaluation.
 *
 * The hole this closes: the pass gate above proves the loop iterated, but three
 * per-symbol `continue`s (signal-engine.ts) can skip EVERY symbol before a single
 * strategy runs. The pass then produces zero candidates and stamps a TRUE
 * `candidatesEvaluated: 0` — which the TRA-1768 read rule says is "the signal never
 * fires, a STRATEGY problem". It would not be. It would be a DATA problem, and
 * Ichimoku would be indicted for a stale feed or a cold cache. This is the same false
 * zero TRA-1768 killed at the pass gate, one layer down: a `continue` inside an
 * iterating pass re-creates it per-symbol. `symbolsEvaluated` is the one number that
 * separates them — and until now it was a local whose only consumer was a `log.warn`.
 * A fact that reaches nothing but a log line does not exist downstream.
 *
 * `off_swing_universe` is EXPECTED to be large and benign under EQUITY_SWING_MODE (the
 * universe is 21 of N watchlist names). It is here so the other two buckets are
 * readable against a known baseline — not as an alarm.
 */
export type EquitySymbolSkipReason =
  | 'insufficient_candles'   // cold candle cache (< 15 bars) — e.g. shortly after a reboot
  | 'off_swing_universe'     // TRA-952 — off the curated 21-name liquid swing universe
  | 'stale_feed';            // TRA-418 — the equity feed is dead during RTH

/**
 * NOTE (TRA-1793) — the status enum is DELIBERATELY unchanged. A pass that iterated but
 * evaluated no symbol still reports `no_candidates`, because QuantTrader's read rule
 * (TRA-1794) is pre-registered against these five values and moving the goalposts under
 * a pre-registered rule is how a verdict gets laundered. The DATA-vs-STRATEGY split is
 * carried by the new `symbolsEvaluated` field instead:
 *
 *   no_candidates + symbolsEvaluated > 0  ⇒ strategies ran and were DRY   (STRATEGY)
 *   no_candidates + symbolsEvaluated = 0  ⇒ no strategy ever ran          (DATA)
 *                                           — symbolsSkippedByReason names why.
 *
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

  /** TRA-1793 — the symbol layer of the last ITERATED pass. `null` until one has run. */
  lastPassSymbolsConsidered: number | null;
  lastPassSymbolsEvaluated: number | null;
  lastPassSymbolsSkipped: Counter<EquitySymbolSkipReason> | null;

  /** Cumulative since boot. */
  cumCandidates: number;
  cumAdmitted: number;
  cumRejected: Counter<EquityEntryRejectReason>;
  cumBySource: Counter<EquityEntrySource>;
  cumSymbolsConsidered: number;
  cumSymbolsEvaluated: number;
  cumSymbolsSkipped: Counter<EquitySymbolSkipReason>;
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
    lastPassSymbolsConsidered: null,
    lastPassSymbolsEvaluated: null,
    lastPassSymbolsSkipped: null,
    cumCandidates: 0,
    cumAdmitted: 0,
    cumRejected: {},
    cumBySource: {},
    cumSymbolsConsidered: 0,
    cumSymbolsEvaluated: 0,
    cumSymbolsSkipped: {},
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
interface OpenPass {
  candidates: number;
  admitted: number;
  rejected: Counter<EquityEntryRejectReason>;
  symbolsEvaluated: number;
  symbolsSkipped: Counter<EquitySymbolSkipReason>;
}

const OPEN_PASS: Record<EquityEntryMode, OpenPass | null> = {
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
export function beginEquityEntryPass(
  mode: EquityEntryMode,
  // TRA-1793 — an options object, not positional args: the previous signature was
  // `(mode, at)`, and adding `symbolsConsidered` positionally would let an unmigrated
  // `beginEquityEntryPass('demo', NOW)` silently book a 1.7e12-symbol universe. A
  // required named field makes every stale call site a COMPILE error instead.
  opts: {
    /** Universe size this pass iterated (`activeSymbols.length`). */
    symbolsConsidered: number;
    at?: number;
  },
): void {
  const led = LEDGERS[mode];
  const at = opts.at ?? Date.now();
  led.passCount += 1;
  led.iteratedPassCount += 1;
  led.lastPassAt = at;
  led.lastPassGateBlockedReason = null;
  OPEN_PASS[mode] = { candidates: 0, admitted: 0, rejected: {}, symbolsEvaluated: 0, symbolsSkipped: {} };
  // Seed the last-pass fields immediately, so a pass that iterates and finds nothing
  // still reports `candidatesEvaluated: 0` (not null) even if no hook fires after this.
  led.lastPassCandidates = 0;
  led.lastPassAdmitted = 0;
  led.lastPassRejected = {};
  led.lastPassSymbolsConsidered = opts.symbolsConsidered;
  led.lastPassSymbolsEvaluated = 0;
  led.lastPassSymbolsSkipped = {};
  led.cumSymbolsConsidered += opts.symbolsConsidered;
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

/**
 * TRA-1793 — a symbol inside an iterating pass REACHED strategy evaluation.
 *
 * This is the number that separates a dry signal from a dead feed. `0` on an iterated
 * pass is THE ALARM: no strategy was ever run, so nothing about the strategy can be
 * concluded. Only counted inside an open pass — a symbol cannot be evaluated by a pass
 * that never iterated, and stamping one outside would mint the false zero's inverse.
 */
export function recordEquitySymbolEvaluated(mode: EquityEntryMode): void {
  const led = LEDGERS[mode];
  const pass = OPEN_PASS[mode];
  if (!pass) return;
  led.cumSymbolsEvaluated += 1;
  pass.symbolsEvaluated += 1;
  led.lastPassSymbolsEvaluated = pass.symbolsEvaluated;
}

/** TRA-1793 — a symbol was SKIPPED before strategy evaluation, and this is why. */
export function recordEquitySymbolSkipped(mode: EquityEntryMode, reason: EquitySymbolSkipReason): void {
  const led = LEDGERS[mode];
  const pass = OPEN_PASS[mode];
  if (!pass) return;
  bump(led.cumSymbolsSkipped, reason);
  bump(pass.symbolsSkipped, reason);
  led.lastPassSymbolsSkipped = { ...pass.symbolsSkipped };
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
    /** TRA-1793 — universe size the pass iterated. */
    symbolsConsidered: number | null;
    /** TRA-1793 — symbols that reached strategy evaluation. `0` on an iterated pass is THE ALARM. */
    symbolsEvaluated: number | null;
    symbolsSkippedByReason: Counter<EquitySymbolSkipReason> | null;
  };
  /** Since boot. `candidatesEvaluated: 0` after an iterated pass is THE ALARM. */
  cumulative: {
    candidatesEvaluated: number | null;
    admitted: number | null;
    rejectedByReason: Counter<EquityEntryRejectReason> | null;
    candidatesBySource: Counter<EquityEntrySource> | null;
    symbolsConsidered: number | null;
    symbolsEvaluated: number | null;
    symbolsSkippedByReason: Counter<EquitySymbolSkipReason> | null;
  };
}

function viewFor(mode: EquityEntryMode): EquityEntryFunnelView {
  const led = LEDGERS[mode];
  // Three-valued: with no ITERATED pass since boot there is NO READING of the
  // candidate side — not a zero. `0` here must only ever mean "we looked and the
  // signal side was dry", because that reading is what indicts the strategy.
  const looked = led.iteratedPassCount > 0 || led.cumCandidates > 0;
  // TRA-1793 — the SYMBOL counters are three-valued off a STRICTER predicate: only the
  // deterministic sweep iterates a universe. `openSma200Pullback` runs on its own daily
  // cadence and can mint a cumulative candidate while the deterministic pass was GATED
  // (`looked === true`, `iteratedPassCount === 0`). Reporting `symbolsEvaluated: 0` in
  // that state would say "we swept the universe and every symbol was skipped" when no
  // sweep ever happened — the exact false zero this ticket exists to kill, re-minted in
  // the field built to kill it.
  const swept = led.iteratedPassCount > 0;
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
      symbolsConsidered: led.lastPassSymbolsConsidered,
      symbolsEvaluated: led.lastPassSymbolsEvaluated,
      symbolsSkippedByReason: led.lastPassSymbolsSkipped,
    },
    cumulative: {
      candidatesEvaluated: looked ? led.cumCandidates : null,
      admitted: looked ? led.cumAdmitted : null,
      rejectedByReason: looked ? led.cumRejected : null,
      candidatesBySource: looked ? led.cumBySource : null,
      symbolsConsidered: swept ? led.cumSymbolsConsidered : null,
      symbolsEvaluated: swept ? led.cumSymbolsEvaluated : null,
      symbolsSkippedByReason: swept ? led.cumSymbolsSkipped : null,
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
