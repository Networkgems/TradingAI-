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
// ── PER-ENGINE, NEVER POOLED (TRA-1834) ──────────────────────────────────────
// The fleet runs MORE THAN ONE demo engine (`/api/health/demo-book-public` reports
// `demoEngineCount: 2`). They are two SignalEngine instances, both `mode === 'demo'`.
// Keying the ledger by `mode` ALONE made them share one slot — and the deterministic
// sweep yields to the event loop mid-pass (TRA-1082, `EQUITY_EVAL_YIELD_EVERY`), which
// lets the two interleave. A gated tick on demo-2 called `recordEquityEntryPassGated`,
// which NULLED the shared open pass — the one demo-1 was still iterating. Every symbol
// demo-1 evaluated after that hit the null-guard and was SILENTLY DROPPED. A truncated
// pass and an idle pass then emit the same bytes: this module's own bug class, one layer
// down. So the ledger is keyed by `(mode, engineId)` — a halted book and an active book
// never sum into one row, and one engine can no longer null another's in-flight pass.
// The report labels each engine as its own block (`demo-1`, `demo-2`), the same way demo
// and live are already kept apart.
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
  | 'non_usd_quote_currency'     // TRA-3390 — quote is not USD (or unknown on a foreign listing); the book has no FX layer
  // ── openSma200Pullback only (its gates are per-candidate, not per-pass) ──────
  | 'capital_gate_manifest'      // TRA-819/817 — not registered as an OOS-passed live entry
  | 'auto_trading_disabled'      // TRA-544 — auto-trading off / agent layer owns the decision
  | 'risk_halted'                // TRA-526 — kill switch / daily circuit-breaker
  | 'market_closed'              // TRA-726 — no entries outside regular trading hours
  // ── routeEquitySignal + openSma200Pullback (intraday edge overlay) ───────────
  | 'session_edge_blackout';     // TRA-2049 — first/last N min of the session; DARK until ENABLE_SESSION_EDGE_BLACKOUT (like churn_brake)

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
 * TRA-1835 — cap on the per-reason symbol-NAME list.
 *
 * The name list is IN-UNIVERSE-only (swing mode: the curated 21 names; swing off: the
 * active set), so under the ticket's regime it can never exceed 21 and this cap never
 * bites. It exists so that if the universe ever grows past this the route says so with an
 * explicit `symbolsSkippedSymbolsTruncated: true` rather than SILENTLY cutting the list —
 * a silently-cut list reads as a complete one, which is this program's whole disease
 * (`stale_feed: 4` that names 3 is worse than a count of 4). 64 leaves generous headroom.
 */
const MAX_SKIPPED_SYMBOLS_PER_REASON = 64;

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
  /**
   * TRA-1834 — passes whose open slot was nulled while STILL ITERATING (before
   * `endEquityEntryPass` finalized them). The detector for the pooling disease this
   * ticket cured: with per-engine keying no sibling engine can reach this slot, and a
   * single engine's tick either gates OR sweeps (never both), so this MUST stay `0`. If
   * it ever moves, an `engineId` is being shared and the drop-counts bug is back.
   */
  passesTruncated: number;
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

  /**
   * TRA-1835 — the ACTUAL tickers skipped on the last iterated pass, IN-UNIVERSE only,
   * `reason → string[]`. The point of the ticket: `stale_feed: 4` reads identically
   * whether the 4 dark names are the tail (DIA/IWM/XLF/ORCL — lose nothing) or the head
   * (NVDA/TSLA/COIN/MSTR — the book is amputated). A count cannot tell those apart; names
   * can. `off_swing_universe` is deliberately NOT listed — those ~134 skips are the
   * expected, benign off-universe cut and QuantTrader explicitly does not want them named.
   * `null` until an iterated pass has run.
   */
  lastPassSymbolsSkippedSymbols: Partial<Record<EquitySymbolSkipReason, string[]>> | null;
  /** TRA-1835 — a per-reason list hit `MAX_SKIPPED_SYMBOLS_PER_REASON` and was capped. */
  lastPassSymbolsSkippedTruncated: boolean;

  /** Cumulative since boot. */
  cumCandidates: number;
  cumAdmitted: number;
  cumRejected: Counter<EquityEntryRejectReason>;
  cumBySource: Counter<EquityEntrySource>;
  cumSymbolsConsidered: number;
  cumSymbolsEvaluated: number;
  cumSymbolsSkipped: Counter<EquitySymbolSkipReason>;
  /**
   * TRA-1835 — since-boot per-symbol skip tally, IN-UNIVERSE only: `reason → symbol → n`.
   * A name dark on 100% of passes (a broken feed subscription) and a name dark on 5% (feed
   * jitter) both land in the same `stale_feed` integer today; this splits them. Read against
   * `iteratedPassCount` for the rate. Bounded by the universe size (≤21 under swing mode).
   */
  cumSymbolsSkippedByName: Partial<Record<EquitySymbolSkipReason, Record<string, number>>>;
}

function emptyLedger(): ModeLedger {
  return {
    passCount: 0,
    gatedPassCount: 0,
    iteratedPassCount: 0,
    passesTruncated: 0,
    lastPassAt: null,
    lastPassGateBlockedReason: null,
    lastAdmittedAt: null,
    lastPassCandidates: null,
    lastPassAdmitted: null,
    lastPassRejected: null,
    lastPassSymbolsConsidered: null,
    lastPassSymbolsEvaluated: null,
    lastPassSymbolsSkipped: null,
    lastPassSymbolsSkippedSymbols: null,
    lastPassSymbolsSkippedTruncated: false,
    cumCandidates: 0,
    cumAdmitted: 0,
    cumRejected: {},
    cumBySource: {},
    cumSymbolsConsidered: 0,
    cumSymbolsEvaluated: 0,
    cumSymbolsSkipped: {},
    cumSymbolsSkippedByName: {},
  };
}

/**
 * The pass currently being accumulated, per engine. Present only between
 * `beginEquityEntryPass` and the next pass boundary; candidate hooks fold into BOTH
 * this and the cumulative ledger.
 *
 * `openSma200Pullback` runs on its own daily cadence and can fire when the
 * deterministic pass was GATED (no open window). Its candidates therefore always count
 * CUMULATIVELY — they are real equity candidates and must never be lost — and fold into
 * `lastPass` only when a window happens to be open (same tick, same funnel). This is
 * why `funnelStatus` keys off the cumulative counters, not `lastPass`: an SMA-200
 * candidate admitted during a gated tick must not read as `never_ran`.
 *
 * TRA-1834 — `complete` is set by `endEquityEntryPass` when the sweep finishes iterating.
 * A slot nulled (by a gate) or overwritten (by the next `beginEquityEntryPass`) while
 * `complete` is still false was cut off MID-ITERATION — that is a truncation. The flag
 * is what keeps the normal sweep→gate→sweep sequence from reading as a truncation: a
 * completed pass that lingers until the next tick's gate nulls it is not a drop.
 */
interface OpenPass {
  candidates: number;
  admitted: number;
  rejected: Counter<EquityEntryRejectReason>;
  symbolsEvaluated: number;
  symbolsSkipped: Counter<EquitySymbolSkipReason>;
  /** TRA-1835 — in-universe tickers skipped this pass, `reason → string[]`. */
  symbolsSkippedSymbols: Partial<Record<EquitySymbolSkipReason, string[]>>;
  /** TRA-1835 — a per-reason list hit the cap this pass. */
  symbolsSkippedTruncated: boolean;
  /** TRA-1834 — the sweep finished iterating this pass. See the truncation detector. */
  complete: boolean;
}

/**
 * TRA-1834 — one engine's funnel state. Keyed by `(mode, engineId)` so two demo engines
 * never share a ledger or an open pass. `engineId` is the engine's stable per-instance
 * id (`SignalEngine.feedContextKey`), so it survives every tick and never collides.
 */
interface EngineSlot {
  mode: EquityEntryMode;
  engineId: string;
  led: ModeLedger;
  open: OpenPass | null;
}

/**
 * All engine slots, in first-seen order. The Map's insertion order is load-bearing: it
 * fixes the `demo-1`/`demo-2` labels in the report, so the same engine keeps the same
 * label for the life of the process.
 */
const SLOTS = new Map<string, EngineSlot>();

/** `mode` is a closed union with no space, so a space separator can never alias keys. */
function slotKey(mode: EquityEntryMode, engineId: string): string {
  return `${mode} ${engineId}`;
}

/** The slot for one engine, created on first use (its first tick after boot). */
function slotFor(mode: EquityEntryMode, engineId: string): EngineSlot {
  const key = slotKey(mode, engineId);
  let slot = SLOTS.get(key);
  if (slot === undefined) {
    slot = { mode, engineId, led: emptyLedger(), open: null };
    SLOTS.set(key, slot);
  }
  return slot;
}

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
  // TRA-1834 — `engineId` is REQUIRED and positional (not optional with a default):
  // an omitted id would collapse two demo engines back into one slot, which is the exact
  // bug this ticket cures. Making it a required parameter turns every unmigrated call
  // site into a COMPILE error rather than a silent re-pool.
  engineId: string,
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
  const slot = slotFor(mode, engineId);
  const led = slot.led;
  const at = opts.at ?? Date.now();
  // TRA-1834 — a still-iterating pass being replaced was cut off mid-flight. Cannot
  // happen from a sibling engine (separate slot) nor from this engine's own tick (a tick
  // sweeps at most once), so it must stay 0; it is the sentinel that the split holds.
  if (slot.open !== null && !slot.open.complete) led.passesTruncated += 1;
  led.passCount += 1;
  led.iteratedPassCount += 1;
  led.lastPassAt = at;
  led.lastPassGateBlockedReason = null;
  slot.open = {
    candidates: 0,
    admitted: 0,
    rejected: {},
    symbolsEvaluated: 0,
    symbolsSkipped: {},
    symbolsSkippedSymbols: {},
    symbolsSkippedTruncated: false,
    complete: false,
  };
  // Seed the last-pass fields immediately, so a pass that iterates and finds nothing
  // still reports `candidatesEvaluated: 0` (not null) even if no hook fires after this.
  led.lastPassCandidates = 0;
  led.lastPassAdmitted = 0;
  led.lastPassRejected = {};
  led.lastPassSymbolsConsidered = opts.symbolsConsidered;
  led.lastPassSymbolsEvaluated = 0;
  led.lastPassSymbolsSkipped = {};
  // TRA-1835 — an iterated pass that skipped no in-universe name reports an EMPTY object,
  // not null: it looked and found nothing dark, which is a real reading (all 21 clean),
  // distinct from `null` = no iterated pass since boot.
  led.lastPassSymbolsSkippedSymbols = {};
  led.lastPassSymbolsSkippedTruncated = false;
  led.cumSymbolsConsidered += opts.symbolsConsidered;
}

/**
 * TRA-1834 — the sweep finished iterating; finalize the open pass.
 *
 * This marks the pass `complete` so a LATER tick's gate (which nulls the lingering slot)
 * is not miscounted as a truncation. It does NOT null the slot: `openSma200Pullback` and
 * the strategy loop still fold candidates/rejections/admits into this pass after the
 * sweep returns, on the same tick. Idempotent and a no-op if no pass is open.
 */
export function endEquityEntryPass(mode: EquityEntryMode, engineId: string): void {
  const slot = slotFor(mode, engineId);
  if (slot.open !== null) slot.open.complete = true;
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
  engineId: string,
  reason: EquityEntryPassGateReason,
  at: number = Date.now(),
): void {
  const slot = slotFor(mode, engineId);
  const led = slot.led;
  led.passCount += 1;
  led.gatedPassCount += 1;
  led.lastPassAt = at;
  led.lastPassGateBlockedReason = reason;
  // TRA-1834 — nulling a still-iterating pass is the disease itself: the pass was cut off
  // mid-sweep and every symbol after this is dropped. With per-engine keying the gate
  // only ever reaches THIS engine's slot, and this engine's tick gates XOR sweeps, so its
  // own open pass is always `complete` by now. A `complete` (or already-null) pass is a
  // clean close, not a truncation.
  if (slot.open !== null && !slot.open.complete) led.passesTruncated += 1;
  slot.open = null;
}

/**
 * TRA-1793 — a symbol inside an iterating pass REACHED strategy evaluation.
 *
 * This is the number that separates a dry signal from a dead feed. `0` on an iterated
 * pass is THE ALARM: no strategy was ever run, so nothing about the strategy can be
 * concluded.
 *
 * TRA-1834 — the cumulative counter now increments BEFORE the open-pass guard, matching
 * `recordEquityCandidate`/`recordEquityEntryRejected`/`recordEquityEntryAdmitted`. Under
 * the old mode-only keying a sibling engine could null this slot's pass mid-sweep, and
 * the guard-first order then DROPPED the count — the exact bytes this ticket chased. With
 * per-engine keying that null can no longer happen, so folding the cumulative before the
 * guard is defence-in-depth: even a stray call outside a pass now preserves the since-boot
 * total, and the per-pass fields still require an open pass.
 */
export function recordEquitySymbolEvaluated(mode: EquityEntryMode, engineId: string): void {
  const slot = slotFor(mode, engineId);
  slot.led.cumSymbolsEvaluated += 1;
  const pass = slot.open;
  if (!pass) return;
  pass.symbolsEvaluated += 1;
  slot.led.lastPassSymbolsEvaluated = pass.symbolsEvaluated;
}

/**
 * TRA-1793 — a symbol was SKIPPED before strategy evaluation, and this is why.
 *
 * TRA-1835 — `opts.symbol` names the ticker and `opts.inUniverse` says whether it is one of
 * the curated swing names. The NAME is recorded (per-pass list + since-boot tally) ONLY when
 * `inUniverse` is true, so the ~134 benign `off_swing_universe` skips are counted but never
 * NAMED — QuantTrader wants the 21 in-universe drops named and the off-universe cut left as a
 * bare integer. `opts` is optional so the pure-count contract survives a caller that has no
 * symbol to hand (and the existing tests that drive counts alone keep passing); a call without
 * it degrades to exactly the old behaviour — the count moves, no name is listed.
 */
export function recordEquitySymbolSkipped(
  mode: EquityEntryMode,
  engineId: string,
  reason: EquitySymbolSkipReason,
  opts?: { symbol?: string; inUniverse?: boolean },
): void {
  const slot = slotFor(mode, engineId);
  const led = slot.led;
  bump(led.cumSymbolsSkipped, reason); // TRA-1834 — cumulative BEFORE the guard (see above)
  // TRA-1835 — the since-boot per-symbol tally, in-universe only. Folds cumulatively (before
  // the open-pass guard) so an intermittently-dark name's history survives across passes.
  if (opts?.inUniverse && opts.symbol) {
    const byName = (led.cumSymbolsSkippedByName[reason] ??= {});
    byName[opts.symbol] = (byName[opts.symbol] ?? 0) + 1;
  }
  const pass = slot.open;
  if (!pass) return;
  bump(pass.symbolsSkipped, reason);
  led.lastPassSymbolsSkipped = { ...pass.symbolsSkipped };
  // TRA-1835 — the last-pass NAME list, in-universe only and capped. A name already listed
  // this pass is not duplicated (a symbol is evaluated once per sweep, but guard defensively).
  if (opts?.inUniverse && opts.symbol) {
    const names = (pass.symbolsSkippedSymbols[reason] ??= []);
    if (!names.includes(opts.symbol)) {
      if (names.length < MAX_SKIPPED_SYMBOLS_PER_REASON) {
        names.push(opts.symbol);
      } else {
        pass.symbolsSkippedTruncated = true;
      }
    }
    led.lastPassSymbolsSkippedSymbols = cloneNameLists(pass.symbolsSkippedSymbols);
    led.lastPassSymbolsSkippedTruncated = pass.symbolsSkippedTruncated;
  }
}

/** TRA-1835 — deep-copy a `reason → string[]` map so a later push cannot mutate a served view. */
function cloneNameLists(
  src: Partial<Record<EquitySymbolSkipReason, string[]>>,
): Partial<Record<EquitySymbolSkipReason, string[]>> {
  const out: Partial<Record<EquitySymbolSkipReason, string[]>> = {};
  for (const [reason, names] of Object.entries(src) as [EquitySymbolSkipReason, string[]][]) {
    out[reason] = [...names];
  }
  return out;
}

/** One equity entry candidate was evaluated (i.e. reached the entry chokepoint). */
export function recordEquityCandidate(mode: EquityEntryMode, engineId: string, source: EquityEntrySource): void {
  const slot = slotFor(mode, engineId);
  const led = slot.led;
  led.cumCandidates += 1;
  bump(led.cumBySource, source);
  const pass = slot.open;
  if (pass) {
    pass.candidates += 1;
    led.lastPassCandidates = pass.candidates;
  }
}

/** A candidate was evaluated and REJECTED before reaching the book. */
export function recordEquityEntryRejected(mode: EquityEntryMode, engineId: string, reason: EquityEntryRejectReason): void {
  const slot = slotFor(mode, engineId);
  const led = slot.led;
  bump(led.cumRejected, reason);
  const pass = slot.open;
  if (pass) {
    bump(pass.rejected, reason);
    led.lastPassRejected = { ...pass.rejected };
  }
}

/** A candidate reached `openPosition` / the broker and a position exists. */
export function recordEquityEntryAdmitted(mode: EquityEntryMode, engineId: string, at: number = Date.now()): void {
  const slot = slotFor(mode, engineId);
  const led = slot.led;
  led.cumAdmitted += 1;
  led.lastAdmittedAt = at;
  const pass = slot.open;
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

/** Serialized funnel for ONE engine. Every count is three-valued; `null` means NO READING. */
export interface EquityEntryFunnelView {
  funnelStatus: EquityEntryFunnelStatus;
  /** Monotone proof the pass fires at all. 0 ⇒ the engine never reached the pass. */
  passCount: number;
  /** Passes held at the four-way pass gate (market closed, halted, …). */
  gatedPassCount: number;
  /** Passes that actually iterated the candidate loop. 0 ⇒ candidatesEvaluated is null. */
  iteratedPassCount: number;
  /**
   * TRA-1834 — passes cut off mid-iteration by a slot null. MUST be 0: per-engine keying
   * makes it structurally impossible, so any non-zero here means an engineId collision
   * and the drop-counts bug is live again. `symbolsEvaluated`/`symbolsSkippedByReason`
   * would then be LOWER BOUNDS, not real counts.
   */
  passesTruncated: number;
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
    /**
     * TRA-1835 — the ACTUAL in-universe tickers skipped this pass, `reason → string[]`.
     * `off_swing_universe` is intentionally absent (the benign off-universe cut is counted
     * in `symbolsSkippedByReason` but not named). `{}` = an iterated pass skipped no
     * in-universe name; `null` = no iterated pass since boot.
     */
    symbolsSkippedSymbols: Partial<Record<EquitySymbolSkipReason, string[]>> | null;
    /** TRA-1835 — a per-reason name list was capped at MAX_SKIPPED_SYMBOLS_PER_REASON. */
    symbolsSkippedSymbolsTruncated: boolean;
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
    /**
     * TRA-1835 — since-boot per-symbol skip tally, in-universe only: `reason → symbol → n`.
     * Divides a name dark on every pass (a dead subscription) from one dark occasionally
     * (feed jitter) — read each count against `iteratedPassCount`. `null` on a pass that
     * never swept the universe (same predicate as the other cumulative symbol fields).
     */
    symbolsSkippedByName: Partial<Record<EquitySymbolSkipReason, Record<string, number>>> | null;
  };
}

function viewOf(led: ModeLedger): EquityEntryFunnelView {
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
    passesTruncated: led.passesTruncated,
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
      symbolsSkippedSymbols: led.lastPassSymbolsSkippedSymbols,
      symbolsSkippedSymbolsTruncated: led.lastPassSymbolsSkippedTruncated,
    },
    cumulative: {
      candidatesEvaluated: looked ? led.cumCandidates : null,
      admitted: looked ? led.cumAdmitted : null,
      rejectedByReason: looked ? led.cumRejected : null,
      candidatesBySource: looked ? led.cumBySource : null,
      symbolsConsidered: swept ? led.cumSymbolsConsidered : null,
      symbolsEvaluated: swept ? led.cumSymbolsEvaluated : null,
      symbolsSkippedByReason: swept ? led.cumSymbolsSkipped : null,
      symbolsSkippedByName: swept ? led.cumSymbolsSkippedByName : null,
    },
  };
}

/**
 * TRA-1834 — one engine's funnel, labelled. The fleet runs more than one demo engine and
 * they must never sum into one row, so the report is a LIST per mode: each block carries
 * its own `engineId` (the stable `feedContextKey`) and a positional `label` (`demo-1`,
 * `demo-2`, …) assigned in first-seen order.
 */
export interface EquityEntryFunnelBlock extends EquityEntryFunnelView {
  /** Stable per-instance engine id (`SignalEngine.feedContextKey`). */
  engineId: string;
  /** Positional label within the mode, first-seen order. `demo-1`, `live-1`, … */
  label: string;
}

/**
 * Every engine's funnel, split by mode and NEVER pooled — see the module header.
 *
 * An EMPTY array is the fleet-level `never_ran`: no engine of that mode has ticked since
 * boot, so there is genuinely nothing to report — not a zero. A reader takes each block's
 * own `funnelStatus`; there is deliberately no aggregate row, because a halted book and an
 * active book summing into one is the bug this ticket cured.
 */
export function summarizeEquityEntryFunnel(): { demo: EquityEntryFunnelBlock[]; live: EquityEntryFunnelBlock[] } {
  const out: { demo: EquityEntryFunnelBlock[]; live: EquityEntryFunnelBlock[] } = { demo: [], live: [] };
  for (const slot of SLOTS.values()) {
    const bucket = out[slot.mode];
    bucket.push({ engineId: slot.engineId, label: `${slot.mode}-${bucket.length + 1}`, ...viewOf(slot.led) });
  }
  return out;
}

/** Test-only: drop all state back to boot. */
export function __resetEquityEntryFunnelForTests(): void {
  SLOTS.clear();
}
