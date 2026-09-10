// TRA-1278 (parent TRA-1276 → TRA-971) — persistent conviction-DCA add ledger.
//
// The TRA-971 forward-evidence gate (TRA-1276 weekly review) has to pull the
// demo/paper conviction-DCA scale-in fills accrued since the a255c2d deploy and
// verify each fill's blended R-cap. Today those fills exist ONLY as ephemeral
// `log.info('TRA-954 conviction-DCA add filled (demo)', …)` lines and an
// in-memory `dcaTranches` Map that is re-seeded from book state on every boot —
// so the canonical host (Render demo `tradingai-bqb1`, reboots ~daily) loses the
// entire add history each restart. The gate therefore reads a structural "0" it
// cannot distinguish from lost evidence.
//
// This module is the durable source of truth. Mirrors the TRA-1216 funding-history
// JSONL + TRA-1264/1271 hydrate-on-boot pattern:
//   • one JSONL line per add fill (equity `addToPosition` demo path + option
//     scale-in) under DATA_DIR — a write-through of values ALREADY computed at the
//     log site, so it adds no new decision;
//   • counts rebuilt from the full JSONL on boot (survive restart — do NOT reset);
//   • a read-only `GET /api/health/conviction-dca` folds the store into the gate's
//     addCount / breachCount / lastAddAt / recent tail.
//
// OBSERVE-ONLY: this is pure accounting. NO entry/exit/scale-in decision is read
// or changed here. Unlike the funding-history / ignition logs this ledger is NOT
// rotated — it IS the promotion evidence and must stay complete; add fills are
// rare (the gate reads ~0), so the file stays tiny and a full-read hydrate is
// exact. A full read on boot also means counts need no separate snapshot: each
// line is one terminal fill, so `addCount === lines`.

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';
// TRA-2598 — the single ET-correct day helper (scheduler.ts imports only
// observability + et-clock, so there is no cycle back through the signal engine).
// A local `toISOString().slice(0,10)` would roll the session 4-5h early and split one
// ET session across two rows in the per-session rollup.
import { etDateString } from './scheduler.js';

const log = logger.child({ module: 'conviction-dca-ledger' });

export const CONVICTION_DCA_LOG_FILENAME = 'conviction-dca-fills.jsonl';

/** R-cap slack — a fill is a breach only when it clears the budget by > this. */
const BREACH_EPSILON = 1e-6;

/** Size of the `recent` tail the health route projects (a DISPLAY cap only). */
const MAX_RECENT_FILLS = 50;

/**
 * TRA-2303 — how many parsed fills are retained in memory.
 *
 * This used to be `MAX_RECENT_FILLS` (50): the retained array was both the health
 * tail AND the only thing the anchored branch of {@link summarizeConvictionDca}
 * could re-derive over. That made setting `CONVICTION_DCA_DEPLOY_ANCHOR` silently
 * drop `byClass.equity.addCount` from 3 to 0 — all 3 equity fills landed on
 * 2026-07-06 and were evicted from a 50-fill tail within two days at the observed
 * rate. It failed HONESTLY (the sums still reconciled) which is exactly what made
 * it dangerous: a truncated count read byte-identical to a complete one.
 *
 * The fix is to retain enough to make the anchored branch EXACT. Sizing, measured
 * off live bqb1 on 2026-07-25 (`/api/health/conviction-dca`): 600 fills over 18.27
 * days = 32.8 fills/day, ~600 bytes/fill retained. 25 000 ⇒ ~2.1 years of headroom
 * at that rate for ~15 MB — and the boot hydrate already reads the whole file into
 * one string regardless, so this is not a new order of cost.
 *
 * The cap is a backstop, not a working limit. When it IS hit the summary says so
 * (`countsExact: false` / `countsBasis: 'retained-truncated'`) instead of quietly
 * serving a short count — the failing state the 50-fill version never had.
 */
const MAX_RETAINED_FILLS = 25_000;

/**
 * One durable conviction-DCA add fill — the gate's per-fill R evidence. Every
 * value is a write-through of what the signal-engine already computed at the fill
 * site (equity ~L5659 / option ~L5788), so appending one is free of new logic.
 */
export interface ConvictionDcaFill {
  /** Fill time, ms epoch. */
  ts: number;
  /** Book mode the add executed on — demo/paper today (live add-order path is gated). */
  mode: 'demo' | 'live';
  assetClass: 'equity' | 'option';
  symbol: string;
  /** Engine position/option id the tranche was added to. */
  positionId: string;
  /**
   * TRA-2598 — the OWNING BOOK. Same string an options-account journal row stamps
   * as its `account` (`setAlertUsername` → `acct.setOwner`), so a reader partitions
   * the ledger and the journal by the same predicate instead of reconstructing the
   * mapping through a `positionId` → journal-row join.
   *
   * OPTIONAL because the JSONL predates this field: every line written before this
   * commit carries no `account`, and inventing one would be worse than admitting the
   * gap. Unstamped lines land in the {@link UNATTRIBUTED_ACCOUNT_KEY} bucket — never
   * folded into a named book — so a pooled legacy tail is VISIBLE as a count rather
   * than silently attributed to whichever book happens to be reading.
   */
  account?: string;
  /** DCA core verdict — 'add' | 'shrink'. */
  action: string;
  /** Shares (equity) or contracts (option) added this fill. */
  addQty: number;
  /** Fill price — share price (equity) or per-contract debit in $ (option). */
  addPrice: number;
  /** Blended avg cost after the add (equity); per-contract premium basis (option). */
  blendedAvg: number;
  /** Position stop after the add (equity); null for defined-risk options. */
  stop: number | null;
  /** Total shares/contracts held after the add. */
  totalQty: number;
  /** Realized dollar risk after the add: (blended−stop)·qty (equity) / Σ premium (option). */
  realizedRiskDollars: number;
  /** Per-position risk budget R the fill is checked against. */
  riskBudget: number;
  /** realizedRiskDollars ≤ riskBudget + ε — the R-cap invariant at fill time. */
  withinBudget: boolean;
  /** DCA core reason string. */
  reason: string;
}

// ── Partitioned counters (TRA-2265) ──────────────────────────────────────────
//
// The pooled addCount/breachCount above fold the equity and option add legs into
// ONE number — but the two legs are checked by DIFFERENT rules at the fill site:
//   • equity (signal-engine `evaluateConvictionDcaAdds`)       → (blended−stop)·qty ≤ R
//   • option (signal-engine `evaluateOptionConvictionDcaAdds`) → Σ premium ≤ R, stop null
// The TRA-971 promotion gate reads these numbers as evidence about the EQUITY
// R-cap. With 100/100 retained fills `assetClass:"option"`, a pooled
// `breachCount: 0` reads byte-identical whether the equity cap held across
// hundreds of fills or the equity add path never executed once — the pooled
// counter has no failing state for the leg that never fires.
//
// These per-class / per-mode buckets are the separator. Every bucket key is
// ALWAYS present, so an equity zero is a STATED zero (`addCount: 0`) rather than
// an absent key a reader could mistake for "not partitioned yet".
//
// STRICTLY OBSERVE-ONLY: no entry/exit/scale-in path reads them.

/** Per-partition counters — the same four fields the pooled summary reports. */
export interface ConvictionDcaBucket {
  addCount: number;
  breachCount: number;
  firstAddAt: number | null;
  lastAddAt: number | null;
}

/**
 * `unknown` is deliberate. A JSONL line predating (or violating) the assetClass
 * contract must NOT be silently folded into `equity` — that would manufacture
 * exactly the false positive this partition exists to kill. It lands in its own
 * bucket instead, so `equity + option + unknown === addCount` always holds and a
 * dropped/malformed class is VISIBLE rather than absorbed.
 */
export type ConvictionDcaClassKey = 'equity' | 'option' | 'unknown';
export type ConvictionDcaModeKey = 'demo' | 'live' | 'unknown';

export type ConvictionDcaClassBuckets = Record<ConvictionDcaClassKey, ConvictionDcaBucket>;
export type ConvictionDcaModeBuckets = Record<ConvictionDcaModeKey, ConvictionDcaBucket>;

/**
 * TRA-2598 — bucket for a fill carrying no `account` (every line written before the
 * field existed, plus a bare engine in a unit test). A DISTINCT key on purpose: the
 * defect this partition closes is a POOLED read manufacturing a false breach, and
 * quietly merging unstamped rows into a named book would reintroduce it under a new
 * name. The key is ALWAYS present, so "no legacy rows" is a stated zero.
 */
export const UNATTRIBUTED_ACCOUNT_KEY = 'unattributed';

/**
 * TRA-2598 — per-book buckets. Unlike byClass/byMode the key set is DYNAMIC (books
 * are discovered from the data), so only {@link UNATTRIBUTED_ACCOUNT_KEY} is
 * guaranteed present. An absent book key therefore means "no adds recorded for that
 * book in this window", which is why the summary also reports `accountCount`.
 */
export type ConvictionDcaAccountBuckets = Record<string, ConvictionDcaBucket>;

function emptyBucket(): ConvictionDcaBucket {
  return { addCount: 0, breachCount: 0, firstAddAt: null, lastAddAt: null };
}

function emptyClassBuckets(): ConvictionDcaClassBuckets {
  return { equity: emptyBucket(), option: emptyBucket(), unknown: emptyBucket() };
}

function emptyModeBuckets(): ConvictionDcaModeBuckets {
  return { demo: emptyBucket(), live: emptyBucket(), unknown: emptyBucket() };
}

function emptyAccountBuckets(): ConvictionDcaAccountBuckets {
  return { [UNATTRIBUTED_ACCOUNT_KEY]: emptyBucket() };
}

/**
 * TRA-2598 — resolve a fill's book key. A blank/whitespace `account` is treated the
 * same as an absent one: an empty string is not a book, and letting `''` become its
 * own key would split one population across two indistinguishable buckets.
 */
export function convictionDcaAccountKey(account: string | undefined | null): string {
  const raw = typeof account === 'string' ? account.trim() : '';
  return raw === '' ? UNATTRIBUTED_ACCOUNT_KEY : raw;
}

function classKeyOf(fill: ConvictionDcaFill): ConvictionDcaClassKey {
  return fill.assetClass === 'equity' || fill.assetClass === 'option' ? fill.assetClass : 'unknown';
}

function modeKeyOf(fill: ConvictionDcaFill): ConvictionDcaModeKey {
  return fill.mode === 'demo' || fill.mode === 'live' ? fill.mode : 'unknown';
}

/** Fold one fill into one bucket — same arithmetic as the pooled counters. */
function foldIntoBucket(bucket: ConvictionDcaBucket, fill: ConvictionDcaFill): void {
  bucket.addCount += 1;
  if (isBreach(fill)) bucket.breachCount += 1;
  if (bucket.firstAddAt == null || fill.ts < bucket.firstAddAt) bucket.firstAddAt = fill.ts;
  if (bucket.lastAddAt == null || fill.ts > bucket.lastAddAt) bucket.lastAddAt = fill.ts;
}

/** Copy the module buckets so a summary caller can never mutate ledger state. */
function cloneBuckets<K extends string>(
  buckets: Record<K, ConvictionDcaBucket>,
): Record<K, ConvictionDcaBucket> {
  const out = {} as Record<K, ConvictionDcaBucket>;
  for (const key of Object.keys(buckets) as K[]) out[key] = { ...buckets[key] };
  return out;
}

/** Re-derive every partition over an explicit fill list (the anchored path). */
function foldBuckets(fills: readonly ConvictionDcaFill[]): {
  byClass: ConvictionDcaClassBuckets;
  byMode: ConvictionDcaModeBuckets;
  byAccount: ConvictionDcaAccountBuckets;
} {
  const cls = emptyClassBuckets();
  const mode = emptyModeBuckets();
  const acct = emptyAccountBuckets();
  for (const f of fills) {
    foldIntoBucket(cls[classKeyOf(f)], f);
    foldIntoBucket(mode[modeKeyOf(f)], f);
    const key = convictionDcaAccountKey(f.account);
    (acct[key] ??= emptyBucket());
    foldIntoBucket(acct[key]!, f);
  }
  return { byClass: cls, byMode: mode, byAccount: acct };
}

// ── In-memory store (backs GET /api/health/conviction-dca) ───────────────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateConvictionDcaFromDisk so the deep fill site can append without threading
// a path through the SignalEngine. Counts are monotonic across the process life
// and are rebuilt from the full JSONL on boot, so they survive restart.

let dataDir: string | null = null;
let addCount = 0;
let breachCount = 0;
let firstAddAt: number | null = null;
let lastAddAt: number | null = null;
/**
 * TRA-2303 — ALL fills, capped at {@link MAX_RETAINED_FILLS}. The anchored branch
 * of the summary derives its counts from here, so this array's depth is what makes
 * an anchored count exact. The health `recent` tail is a 50-fill PROJECTION of it.
 */
const retainedFills: ConvictionDcaFill[] = [];
/** Fills evicted by the retention cap. > 0 ⇒ an anchored count may under-report. */
let droppedFills = 0;
let byClass = emptyClassBuckets();
let byMode = emptyModeBuckets();
let byAccount = emptyAccountBuckets();

export function convictionDcaLogPath(dir: string): string {
  return join(dir, CONVICTION_DCA_LOG_FILENAME);
}

/** Test seam — drop every fill + counter and the configured dir. */
export function clearConvictionDcaLedger(): void {
  dataDir = null;
  addCount = 0;
  breachCount = 0;
  firstAddAt = null;
  lastAddAt = null;
  retainedFills.length = 0;
  droppedFills = 0;
  byClass = emptyClassBuckets();
  byMode = emptyModeBuckets();
  byAccount = emptyAccountBuckets();
  clearConvictionDcaGuardLedger();
}

function isBreach(fill: ConvictionDcaFill): boolean {
  return fill.realizedRiskDollars > fill.riskBudget + BREACH_EPSILON;
}

/** Fold one fill into the in-memory counters + rolling tail (no IO). */
function applyFill(fill: ConvictionDcaFill): void {
  addCount += 1;
  if (isBreach(fill)) breachCount += 1;
  if (firstAddAt == null || fill.ts < firstAddAt) firstAddAt = fill.ts;
  if (lastAddAt == null || fill.ts > lastAddAt) lastAddAt = fill.ts;
  foldIntoBucket(byClass[classKeyOf(fill)], fill);
  foldIntoBucket(byMode[modeKeyOf(fill)], fill);
  const acctKey = convictionDcaAccountKey(fill.account);
  (byAccount[acctKey] ??= emptyBucket());
  foldIntoBucket(byAccount[acctKey]!, fill);
  retainedFills.push(fill);
  while (retainedFills.length > MAX_RETAINED_FILLS) {
    retainedFills.shift();
    droppedFills += 1;
    if (droppedFills === 1) {
      // Loud once: from here on an anchored summary reports countsExact:false, and
      // the TRA-971 gate must not be graded off it until retention is resized.
      log.warn('conviction-dca retention cap reached — anchored counts now inexact', {
        cap: MAX_RETAINED_FILLS,
        addCount,
      });
    }
  }
}

/**
 * Record one conviction-DCA add fill: update the in-memory store AND append one
 * JSONL line under the configured DATA_DIR. Best-effort on IO — a write failure
 * logs and is swallowed so this accounting can never break the trade pass. When
 * no dataDir is configured (unit tests / CLI without boot) the counters still
 * update; only the file write is skipped.
 */
export function recordConvictionDcaFill(fill: ConvictionDcaFill): void {
  applyFill(fill);
  if (dataDir == null) return;
  const path = convictionDcaLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(fill) + '\n', 'utf8');
  } catch (err) {
    log.warn('conviction-dca fill append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── TRA-2598: the same-day-loss GUARD's own denominator ──────────────────────
//
// `breachCount: 0` reads byte-identical whether the TRA-1408 same-day-loss brake
// held across hundreds of adds or never ran at all — a false-pass channel on a
// SAFETY BRAKE. (It is also a different invariant: `breachCount` counts R-CAP
// breaches, `realizedRiskDollars > riskBudget`; the same-day-loss rule halts an add
// BEFORE any fill exists, so a halt can never appear in the fill ledger at all. A
// working brake and a dark one produce the same fill file.)
//
// The fix is a denominator. Every add candidate that reaches the brake chokepoint is
// recorded — whether the flag was on, and whether the rule halted it — so the three
// states that previously shared one zero are separable:
//
//   presented 0                          → the DCA add path never produced a candidate
//   presented N, evaluated 0             → the guard is DARK (ENABLE_CHURN_LOSS_BRAKE off)
//   presented N, evaluated N, halted 0   → the guard RAN N times and nothing tripped
//   halted > 0                           → the guard is actively refusing adds
//
// DURABLE, not since-boot. `/api/health/churn-brake` already reports a halt count,
// but it is in-memory-monotonic and bqb1 reboots ~daily, so it cannot support the
// multi-session "N clean sessions" grade this instrument exists for — and mixing a
// since-boot halt count with an all-time `addCount` on one payload invites exactly
// the false "mostly dark" read. Same append + full-read-hydrate pattern as the fills.
//
// STRICTLY OBSERVE-ONLY: recording a candidate never changes the brake's verdict.

export const CONVICTION_DCA_GUARD_LOG_FILENAME = 'conviction-dca-guard.jsonl';

/** Retention for guard events. Same backstop contract as {@link MAX_RETAINED_FILLS}. */
const MAX_RETAINED_GUARD_EVENTS = 25_000;

/** Size of the guard `recent` tail (a DISPLAY cap only). */
const MAX_RECENT_GUARD_EVENTS = 50;

/**
 * One conviction-DCA add candidate as seen by the TRA-1408 same-day-loss brake.
 * Written at the brake chokepoint on EVERY branch — dark, passed and halted — so the
 * counts derived from it are a true denominator rather than a record of hits only.
 */
export interface ConvictionDcaGuardEvent {
  /** Evaluation time, ms epoch. */
  ts: number;
  /** Owning book — see {@link ConvictionDcaFill.account}. Absent ⇒ unattributed. */
  account?: string;
  mode: 'demo' | 'live';
  assetClass: 'equity' | 'option';
  symbol: string;
  positionId: string;
  /**
   * Was `ENABLE_CHURN_LOSS_BRAKE` on for this candidate? `false` ⇒ the rule did NOT
   * run, so this candidate counts toward `addsPresented` but NOT `addsEvaluated`.
   * This is the field that turns "0 halts" from ambiguous into diagnosable.
   */
  guardEnabled: boolean;
  /** Did the same-day-loss rule halt the add? Only ever true when `guardEnabled`. */
  halted: boolean;
  /** The name's ET-day realized+unrealized net at evaluation; null when dark. */
  netEtDay: number | null;
}

/**
 * TRA-4462 defect 2 — the rounding grain of `netEtDay`.
 *
 * `netEtDay` is stored as `Number((realized + unrealized).toFixed(2))`, so a net of
 * −0.001 lands on the wire as `-0` and `-0 >= 0` is `true` in JS. Testing "was this
 * candidate net-POSITIVE on the day?" with a bare `>= 0` would therefore classify a
 * correctly-halted sub-cent loser as a candidate the rule should have admitted, and
 * manufacture a `failing_closed` verdict out of arithmetic. The bar is one grain
 * above the rounding floor.
 */
const NET_POSITIVE_USD = 0.005;

/**
 * Per-partition guard counters. `addsHalted ≤ addsEvaluated ≤ addsPresented` always,
 * and `addsPassed + addsHalted === addsEvaluated`.
 */
export interface ConvictionDcaGuardBucket {
  /** Add candidates that reached the brake chokepoint. */
  addsPresented: number;
  /** Candidates the rule actually ran on (`guardEnabled`). */
  addsEvaluated: number;
  /** Candidates the rule refused. */
  addsHalted: number;
  /**
   * TRA-4462 — candidates the rule RAN ON and ADMITTED. Stated explicitly rather
   * than left as `addsEvaluated - addsHalted`: the arithmetic is trivial, but a
   * reader who never computes it never notices a partition where it is ZERO, which
   * is the whole finding on the equity leg (172/172 halted since 2026-06-01).
   */
  addsPassed: number;
  /**
   * TRA-4462 — **the discriminator.** Evaluated candidates whose name was net
   * POSITIVE on the ET day (`netEtDay >= ${NET_POSITIVE_USD}`), i.e. candidates the
   * same-day-loss rule is REQUIRED to admit.
   *
   * A partition with `addsPassed: 0` reads identically whether the rule is (a)
   * correctly refusing a run of genuine same-day losers or (b) hard-failing closed
   * on that partition — UNLESS you know whether a candidate the rule was obliged to
   * admit ever arrived. This is that number. `0` ⇒ the population never contained a
   * pass candidate, so the halt count is not evidence the rule can admit. `>0`
   * alongside `haltedAtPositiveNet > 0` ⇒ the rule refused an add it had no grounds
   * to refuse, which is a BUG, not a statistic.
   */
  presentedAtPositiveNet: number;
  /** Candidates HALTED despite `netEtDay >= ${NET_POSITIVE_USD}`. Non-zero is a finding. */
  haltedAtPositiveNet: number;
  /**
   * Range of `netEtDay` across evaluated candidates (null when none carried a finite
   * net). `netEtDayMax` is the closest this partition's population ever came to the
   * pass boundary — the distance from 0 says how far the sample is from ever having
   * been able to test the admit path.
   */
  netEtDayMin: number | null;
  netEtDayMax: number | null;
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * TRA-4462 — what a partition's halt count is EVIDENCE OF. Derived, never stored,
 * so it can never disagree with the counters beside it.
 *
 * `state` (above) answers "did the rule run?". This answers the question that
 * actually matters on a safety brake with a 100% halt rate: "is a PASS reachable
 * here at all, and if none was observed, is that because none was owed?"
 */
export type ConvictionDcaGuardPassState =
  /** The rule never ran on this partition — nothing to say. */
  | 'no_candidates'
  /** At least one candidate was admitted: the admit path demonstrably works here. */
  | 'pass_observed'
  /**
   * A candidate arrived net-POSITIVE on the day and was halted anyway. The rule is
   * refusing adds it has no grounds to refuse — a wiring bug, NOT a statistic.
   */
  | 'failing_closed'
  /**
   * Zero passes, and zero candidates the rule was obliged to admit ever arrived.
   * The halt count is therefore NOT evidence the brake works; the sample cannot
   * distinguish a working brake from one hard-failed closed. See TRA-4462 defect 2.
   */
  | 'no_pass_candidate';

/**
 * The named verdict a bare zero could not express. Derived, never stored — so it can
 * never disagree with the counters beside it.
 */
export type ConvictionDcaGuardState =
  /** No add candidate has ever reached the brake — nothing to say about the brake. */
  | 'no_candidates'
  /** Candidates presented but the flag was off for all of them: the brake is DARK. */
  | 'dark'
  /** The rule ran on every candidate and refused none. */
  | 'live_clean'
  /** The rule refused at least one add. */
  | 'live_firing'
  /** Some candidates were evaluated and some were not (the flag flipped mid-window). */
  | 'mixed';

function emptyGuardBucket(): ConvictionDcaGuardBucket {
  return {
    addsPresented: 0,
    addsEvaluated: 0,
    addsHalted: 0,
    addsPassed: 0,
    presentedAtPositiveNet: 0,
    haltedAtPositiveNet: 0,
    netEtDayMin: null,
    netEtDayMax: null,
    firstAt: null,
    lastAt: null,
  };
}

function foldIntoGuardBucket(bucket: ConvictionDcaGuardBucket, ev: ConvictionDcaGuardEvent): void {
  bucket.addsPresented += 1;
  if (ev.guardEnabled) bucket.addsEvaluated += 1;
  // Guard against a malformed line claiming a halt while dark: a halt is only
  // meaningful as a subset of the evaluated population, and letting an impossible
  // combination through would break `addsHalted ≤ addsEvaluated`.
  if (ev.guardEnabled && ev.halted) bucket.addsHalted += 1;
  // TRA-4462 — the admit side of the same population, and the net distribution that
  // says whether a pass was ever OWED. Scoped to `guardEnabled` for the same reason
  // `addsHalted` is: a dark candidate is not a verdict, so it must not enter either
  // numerator or the range.
  if (ev.guardEnabled) {
    if (!ev.halted) bucket.addsPassed += 1;
    if (typeof ev.netEtDay === 'number' && Number.isFinite(ev.netEtDay)) {
      if (bucket.netEtDayMin == null || ev.netEtDay < bucket.netEtDayMin) {
        bucket.netEtDayMin = ev.netEtDay;
      }
      if (bucket.netEtDayMax == null || ev.netEtDay > bucket.netEtDayMax) {
        bucket.netEtDayMax = ev.netEtDay;
      }
      if (ev.netEtDay >= NET_POSITIVE_USD) {
        bucket.presentedAtPositiveNet += 1;
        if (ev.halted) bucket.haltedAtPositiveNet += 1;
      }
    }
  }
  if (bucket.firstAt == null || ev.ts < bucket.firstAt) bucket.firstAt = ev.ts;
  if (bucket.lastAt == null || ev.ts > bucket.lastAt) bucket.lastAt = ev.ts;
}

/**
 * TRA-4462 — derive {@link ConvictionDcaGuardPassState} for one partition. Pure.
 *
 * `failing_closed` is tested FIRST and independently of `addsPassed`: a partition
 * that admits most candidates but halts one it was obliged to admit is still buggy,
 * and ranking `pass_observed` above it would let a busy leg hide a real refusal.
 */
export function convictionDcaGuardPassStateOf(
  bucket: ConvictionDcaGuardBucket,
): ConvictionDcaGuardPassState {
  if (bucket.addsEvaluated === 0) return 'no_candidates';
  if (bucket.haltedAtPositiveNet > 0) return 'failing_closed';
  if (bucket.addsPassed > 0) return 'pass_observed';
  return 'no_pass_candidate';
}

function guardStateOf(bucket: ConvictionDcaGuardBucket): ConvictionDcaGuardState {
  if (bucket.addsPresented === 0) return 'no_candidates';
  if (bucket.addsEvaluated === 0) return 'dark';
  if (bucket.addsHalted > 0) return 'live_firing';
  if (bucket.addsEvaluated < bucket.addsPresented) return 'mixed';
  return 'live_clean';
}

let guardEvents: ConvictionDcaGuardEvent[] = [];
let droppedGuardEvents = 0;

export function convictionDcaGuardLogPath(dir: string): string {
  return join(dir, CONVICTION_DCA_GUARD_LOG_FILENAME);
}

/** Test seam — drop every guard event. Called by {@link clearConvictionDcaLedger}. */
export function clearConvictionDcaGuardLedger(): void {
  guardEvents = [];
  droppedGuardEvents = 0;
}

function applyGuardEvent(ev: ConvictionDcaGuardEvent): void {
  guardEvents.push(ev);
  while (guardEvents.length > MAX_RETAINED_GUARD_EVENTS) {
    guardEvents.shift();
    droppedGuardEvents += 1;
    if (droppedGuardEvents === 1) {
      log.warn('conviction-dca guard retention cap reached — guard counts now inexact', {
        cap: MAX_RETAINED_GUARD_EVENTS,
      });
    }
  }
}

/**
 * Record one add candidate the same-day-loss brake saw. Best-effort on IO, exactly
 * like {@link recordConvictionDcaFill}: a write failure logs and is swallowed so this
 * accounting can never break the trade pass. With no dataDir configured the in-memory
 * counters still update.
 */
export function recordConvictionDcaGuardEvaluation(ev: ConvictionDcaGuardEvent): void {
  applyGuardEvent(ev);
  if (dataDir == null) return;
  const path = convictionDcaGuardLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(ev) + '\n', 'utf8');
  } catch (err) {
    log.warn('conviction-dca guard event append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ConvictionDcaGuardSummary extends ConvictionDcaGuardBucket {
  /** The named verdict — what the counters above MEAN. */
  state: ConvictionDcaGuardState;
  /**
   * TRA-4462 — whether a PASS is reachable at all, pooled. Read this beside
   * {@link passStateByClass}: a pooled `pass_observed` carried entirely by one leg
   * is exactly how the equity leg's zero stayed invisible for three months.
   */
  passState: ConvictionDcaGuardPassState;
  /** Same counts per book, and per asset-class leg. */
  byAccount: Record<string, ConvictionDcaGuardBucket>;
  byClass: Record<ConvictionDcaClassKey, ConvictionDcaGuardBucket>;
  /** Per-book named verdicts, so one dark book cannot hide behind a busy one. */
  stateByAccount: Record<string, ConvictionDcaGuardState>;
  /**
   * TRA-4462 — per-LEG pass-state verdicts. The equity and option legs are two
   * different predicates over two different populations sharing one field name;
   * pooling them is what let `addsHalted: 8572` read as evidence the brake works
   * while one of its two legs had never once admitted an add.
   */
  passStateByClass: Record<ConvictionDcaClassKey, ConvictionDcaGuardPassState>;
  /** Per-book pass-state verdicts, same rationale as {@link stateByAccount}. */
  passStateByAccount: Record<string, ConvictionDcaGuardPassState>;
  /** The USD bar `presentedAtPositiveNet` / `haltedAtPositiveNet` apply. */
  netPositiveThresholdUsd: number;
  /** What the pass-state fields mean, on the wire, for a reader who has no ticket. */
  passStateNote: string;
  /** Distinct books with ≥1 presented candidate. */
  accountCount: number;
  retainedEventCount: number;
  droppedEventCount: number;
  /** `false` ⇒ retention evicted events, so every count above is a LOWER BOUND. */
  countsExact: boolean;
  /** Display tail, oldest→newest. Never a count basis. */
  recent: ConvictionDcaGuardEvent[];
}

/**
 * Fold the guard store into the read-only diagnostics. When `deployAnchor` is given,
 * only events at/after it are counted — the same window the fill summary applies, so
 * the two halves of the payload describe one population.
 */
export function summarizeConvictionDcaGuard(
  deployAnchor: number | null = null,
): ConvictionDcaGuardSummary {
  const scoped =
    deployAnchor == null ? guardEvents : guardEvents.filter((e) => e.ts >= deployAnchor);
  const pooled = emptyGuardBucket();
  const byAcct: Record<string, ConvictionDcaGuardBucket> = {
    [UNATTRIBUTED_ACCOUNT_KEY]: emptyGuardBucket(),
  };
  const byCls: Record<ConvictionDcaClassKey, ConvictionDcaGuardBucket> = {
    equity: emptyGuardBucket(),
    option: emptyGuardBucket(),
    unknown: emptyGuardBucket(),
  };
  for (const ev of scoped) {
    foldIntoGuardBucket(pooled, ev);
    const key = convictionDcaAccountKey(ev.account);
    foldIntoGuardBucket((byAcct[key] ??= emptyGuardBucket()), ev);
    const cls: ConvictionDcaClassKey =
      ev.assetClass === 'equity' || ev.assetClass === 'option' ? ev.assetClass : 'unknown';
    foldIntoGuardBucket(byCls[cls], ev);
  }
  const stateByAccount: Record<string, ConvictionDcaGuardState> = {};
  const passStateByAccount: Record<string, ConvictionDcaGuardPassState> = {};
  for (const [key, bucket] of Object.entries(byAcct)) {
    stateByAccount[key] = guardStateOf(bucket);
    passStateByAccount[key] = convictionDcaGuardPassStateOf(bucket);
  }
  const passStateByClass = {
    equity: convictionDcaGuardPassStateOf(byCls.equity),
    option: convictionDcaGuardPassStateOf(byCls.option),
    unknown: convictionDcaGuardPassStateOf(byCls.unknown),
  } satisfies Record<ConvictionDcaClassKey, ConvictionDcaGuardPassState>;
  return {
    ...pooled,
    state: guardStateOf(pooled),
    passState: convictionDcaGuardPassStateOf(pooled),
    byAccount: byAcct,
    byClass: byCls,
    stateByAccount,
    passStateByClass,
    passStateByAccount,
    netPositiveThresholdUsd: NET_POSITIVE_USD,
    passStateNote:
      'TRA-4462 — `state` says whether the rule RAN; `passState` says whether a PASS was '
      + 'reachable. A partition with addsPassed:0 reads identically whether the rule is '
      + 'correctly halting genuine same-day losers or hard-failing closed, so read '
      + '`presentedAtPositiveNet` (evaluated candidates the rule was OBLIGED to admit, '
      + `netEtDay >= ${NET_POSITIVE_USD}). no_pass_candidate = zero passes and zero such `
      + 'candidates ever arrived ⇒ the halt count is NOT evidence the brake works. '
      + 'failing_closed = one arrived and was halted anyway ⇒ a bug, not a statistic. '
      + 'Grade per LEG (`passStateByClass`), never pooled: the equity and option legs are '
      + 'different predicates over different populations behind one field name.',
    accountCount: Object.values(byAcct).filter((b) => b.addsPresented > 0).length,
    retainedEventCount: guardEvents.length,
    droppedEventCount: droppedGuardEvents,
    countsExact: droppedGuardEvents === 0,
    recent: scoped.slice(-MAX_RECENT_GUARD_EVENTS),
  };
}

/** What {@link hydrateConvictionDcaFromDisk} recovered (for the boot log line). */
export interface ConvictionDcaHydration {
  addCount: number;
  breachCount: number;
  firstAddAt: number | null;
  lastAddAt: number | null;
  /** TRA-2265 — the same counts partitioned, rebuilt from the FULL JSONL. */
  byClass: ConvictionDcaClassBuckets;
  byMode: ConvictionDcaModeBuckets;
  /** TRA-2598 — the same counts per owning book. */
  byAccount: ConvictionDcaAccountBuckets;
  /** TRA-2598 — guard candidates recovered from the companion guard JSONL. */
  guardEventCount: number;
}

/**
 * Rebuild the in-memory store from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any live pass. Reads the ENTIRE JSONL — each line is one terminal fill,
 * so `addCount` is exact and no snapshot is needed. Best-effort: a missing/corrupt
 * file yields an empty hydration (and a torn trailing line is skipped) rather than
 * throwing.
 */
export function hydrateConvictionDcaFromDisk(dir: string): ConvictionDcaHydration {
  clearConvictionDcaLedger();
  dataDir = dir;

  // TRA-1463 — boot-hydrate synchronous read+parse; wrap so a stall here is NAMED
  // in the watchdog trip breadcrumb (`slowPhase`).
  return timeSyncPhase('hydrate.convictionDca', () => {
    let raw = '';
    try {
      raw = readFileSync(convictionDcaLogPath(dir), 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const fill = JSON.parse(trimmed) as ConvictionDcaFill;
        if (typeof fill.ts === 'number' && Number.isFinite(fill.realizedRiskDollars)) {
          applyFill(fill);
        }
      } catch {
        // skip a torn/partial trailing line rather than abort the hydrate
      }
    }

    // TRA-2598 — the companion guard log. Same best-effort contract: a missing file
    // (every host before this commit) hydrates to zero events, which the summary
    // reports as `state: 'no_candidates'` rather than as a clean brake.
    let guardRaw = '';
    try {
      guardRaw = readFileSync(convictionDcaGuardLogPath(dir), 'utf8');
    } catch {
      guardRaw = '';
    }
    for (const line of guardRaw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const ev = JSON.parse(trimmed) as ConvictionDcaGuardEvent;
        if (typeof ev.ts === 'number' && typeof ev.guardEnabled === 'boolean') {
          applyGuardEvent(ev);
        }
      } catch {
        // skip a torn/partial trailing line rather than abort the hydrate
      }
    }

    return {
      addCount,
      breachCount,
      firstAddAt,
      lastAddAt,
      byClass: cloneBuckets(byClass),
      byMode: cloneBuckets(byMode),
      byAccount: cloneBuckets(byAccount),
      guardEventCount: guardEvents.length,
    };
  });
}

/**
 * Resolve the configurable "since deploy" anchor (ms epoch) from
 * `CONVICTION_DCA_DEPLOY_ANCHOR` — an ISO string or a ms-epoch number. Unset or
 * unparseable ⇒ null (all-time counts; the ledger is created at deploy, so the
 * whole file already IS the since-deploy window). Env-driven so the TRA-1276
 * review can re-anchor without a redeploy.
 */
export function resolveConvictionDcaDeployAnchor(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env['CONVICTION_DCA_DEPLOY_ANCHOR'];
  if (raw == null || raw.trim() === '') return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : null;
}

// ── Health summary ───────────────────────────────────────────────────────────

/**
 * TRA-2303 — what the reported counts were derived FROM. A reader grading the
 * TRA-971 promotion gate must be able to tell a complete count from a truncated
 * one; before this the two were indistinguishable.
 *   • `monotonic-full`     — no anchor: the boot-hydrated all-time counters (exact).
 *   • `retained-full`      — anchored, re-derived over retained fills, none evicted (exact).
 *   • `retained-truncated` — anchored, but the retention cap evicted fills that may
 *                            fall inside the window. Counts may UNDER-report.
 */
export type ConvictionDcaCountBasis = 'monotonic-full' | 'retained-full' | 'retained-truncated';

export interface ConvictionDcaSummary {
  /** Total add fills recorded since the deploy anchor (or all-time when unset). */
  addCount: number;
  /** Fills where realizedRiskDollars > riskBudget + ε — the R-cap breach count. */
  breachCount: number;
  /** ms epoch of the first / last recorded add (within the anchor window). */
  firstAddAt: number | null;
  lastAddAt: number | null;
  /** The deploy anchor applied to the counts (ms epoch), or null for all-time. */
  deployAnchor: number | null;
  /**
   * TRA-2265 — the SAME counts partitioned by asset class / book mode. Every key
   * is always present, so `byClass.equity.addCount: 0` is a stated zero. Sums
   * reconcile against the pooled counts in both branches:
   *   Σ byClass[*].addCount === addCount === Σ byMode[*].addCount
   * Observe-only: no decision path reads these.
   */
  byClass: ConvictionDcaClassBuckets;
  byMode: ConvictionDcaModeBuckets;
  /**
   * TRA-2598 — the SAME counts per OWNING BOOK, and the reason this route exists.
   * The demo journal is one firm-wide JSONL: a union of every demo book including the
   * QA probe books (`qa_*`, `ctoverify_*`, `qtverify_*`). Pooled, "did this add land on
   * a name already net-negative today?" is unanswerable and wrong in BOTH directions —
   * a loss realised in an unrelated book reads as a breach in the adding book (the
   * false FIRY violation of 2026-07-28), and a real breach can hide behind a third
   * book's win. Only a per-book read grades the brake.
   *
   * Keys are DYNAMIC; only {@link UNATTRIBUTED_ACCOUNT_KEY} is guaranteed. The sum
   * reconciles in both branches: Σ byAccount[*].addCount === addCount.
   */
  byAccount: ConvictionDcaAccountBuckets;
  /** Distinct books with ≥1 add in this window (`unattributed` counts as one). */
  accountCount: number;
  /** TRA-2303 — what these counts were derived from. */
  countsBasis: ConvictionDcaCountBasis;
  /**
   * TRA-2303 — `false` ⇒ the retention cap evicted fills that may fall inside the
   * anchored window, so every count above is a LOWER BOUND. Do NOT grade the
   * TRA-971 gate off an inexact summary; resize retention (or drop the anchor,
   * which reads the exact monotonic counters) first.
   */
  countsExact: boolean;
  /** Fills held in memory (the anchored derivation's population). */
  retainedFillCount: number;
  /** Fills evicted by the retention cap — non-zero is what makes counts inexact. */
  droppedFillCount: number;
  /**
   * A WINDOW of fills, oldest→newest. Historically a fixed 50-fill tail, which is
   * what made this route uninspectable: 50 of 658 adds is 7.6% coverage spanning 3 of
   * 15 post-arm sessions, so any "N clean sessions" verdict read off it was bounded by
   * the window and not by the data. Now pageable — see {@link recentWindow}.
   *
   * Still a DISPLAY projection: never derive a count from it. Use the buckets (exact
   * over the full ledger) or {@link bySession} (exact over retention).
   */
  recent: ConvictionDcaRecentFill[];
  /**
   * TRA-2598 — what `recent` actually covers, so a partial page can never be mistaken
   * for the whole corpus. `returned < matched` ⇒ there are more pages.
   */
  recentWindow: {
    /** Fills in the anchored window, i.e. the size of the pageable corpus. */
    matched: number;
    /** Offset from the OLDEST matched fill. */
    offset: number;
    limit: number;
    returned: number;
    /** `true` ⇒ this page is the whole window. */
    complete: boolean;
  };
  /**
   * TRA-2598 — per-ET-session rollup over the FULL retained window, not the page. This
   * is what lets an acceptance check see its own corpus: the sessions a verdict claims
   * to cover are enumerated here with their own counts, so "15 clean sessions" is
   * checkable against 15 named rows instead of asserted off a 3-session tail.
   *
   * Newest session first. ET days (not UTC) — a UTC day rolls 4-5h early and would
   * split one session in two.
   */
  bySession: ConvictionDcaSessionRollup[];
}

/** One ET trading session's adds — see {@link ConvictionDcaSummary.bySession}. */
export interface ConvictionDcaSessionRollup {
  /** ET calendar day, `YYYY-MM-DD`. */
  etDay: string;
  addCount: number;
  breachCount: number;
  /** Books that added on this session, sorted — the per-session partition. */
  accounts: string[];
  /** Add candidates the same-day-loss brake saw / ran on / refused this session. */
  addsPresented: number;
  addsEvaluated: number;
  addsHalted: number;
  /** The brake's named verdict FOR THIS SESSION. */
  guardState: ConvictionDcaGuardState;
}

/**
 * TRA-2598 — a fill as PROJECTED into `recent`, where `account` is always present.
 *
 * On the stored {@link ConvictionDcaFill} the field is optional, because the JSONL
 * predates it and rewriting history would invent attribution. But `undefined` does
 * not survive `JSON.stringify`, so an optional field made the wire row omit the key
 * entirely — and a reader that tests for the key (the obvious way to ask "does this
 * host have the account fix?") then reads a fully-patched route as UNPATCHED. That
 * is the same defect this issue exists to remove — an instrument that reads
 * identically in two different states — reintroduced one level down.
 *
 * So the projection states the answer instead of omitting it: a legacy row reports
 * the {@link UNATTRIBUTED_ACCOUNT_KEY} sentinel, exactly the bucket it is already
 * counted in by `byAccount`. Presence now means "this route attributes fills";
 * the VALUE, never the key's existence, is what says whether this row is attributed.
 * Storage is untouched — this is a read-side projection only.
 */
export type ConvictionDcaRecentFill = ConvictionDcaFill & { account: string };

/** TRA-2598 — paging controls for the `recent` window. */
export interface ConvictionDcaRecentPaging {
  /** Page size. Clamped to [1, {@link MAX_RECENT_PAGE_SIZE}]; default {@link MAX_RECENT_FILLS}. */
  limit?: number;
  /** Offset from the OLDEST fill in the window. Negative is clamped to 0. */
  offset?: number;
}

/**
 * Hard ceiling on one page. Bounded because the payload is serialized in one shot on
 * an unauthenticated route; `bySession` (a rollup, not rows) is the surface for
 * whole-corpus questions, and `offset` walks the rows for anything finer.
 */
export const MAX_RECENT_PAGE_SIZE = 1_000;

/**
 * TRA-2598 — parse `?limit=` / `?offset=` off an Express query bag into paging opts.
 *
 * Lives here rather than in the route so the parsing has a unit test that does not
 * require standing up the 69-field health-route deps object. Express hands back
 * `string | string[] | ParsedQs`; anything that is not a finite numeric string is
 * DROPPED (not coerced to 0), so a junk `?limit=abc` falls back to the default page
 * instead of silently returning an empty one that reads like "no adds".
 */
export function parseConvictionDcaPaging(
  query: Record<string, unknown> | undefined,
): ConvictionDcaRecentPaging {
  const asCount = (raw: unknown): number | undefined => {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const limit = asCount(query?.['limit']);
  const offset = asCount(query?.['offset']);
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

function resolvePaging(paging: ConvictionDcaRecentPaging | undefined): {
  limit: number;
  offset: number;
} {
  const rawLimit = paging?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), MAX_RECENT_PAGE_SIZE)
      : MAX_RECENT_FILLS;
  const rawOffset = paging?.offset;
  const offset =
    typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : 0;
  return { limit, offset };
}

/**
 * Page the window oldest→newest. Note the DEFAULT (offset 0, limit 50) deliberately
 * still yields the NEWEST 50 — the shape every existing reader depends on — and only
 * an explicit `offset` walks backwards from the oldest end. A page that silently
 * changed which end it served would break the tail readers this route already has.
 */
function pageFills(
  window: readonly ConvictionDcaFill[],
  limit: number,
  offset: number,
): ConvictionDcaRecentFill[] {
  const page = offset === 0 ? window.slice(-limit) : window.slice(offset, offset + limit);
  // State the book on every row — see {@link ConvictionDcaRecentFill} for why an
  // omitted key is not an acceptable way to say "unattributed".
  return page.map((fill) => ({ ...fill, account: convictionDcaAccountKey(fill.account) }));
}

/** Fold the retained window into per-ET-session rows, newest session first. */
function rollupSessions(
  fills: readonly ConvictionDcaFill[],
  events: readonly ConvictionDcaGuardEvent[],
): ConvictionDcaSessionRollup[] {
  const rows = new Map<
    string,
    {
      addCount: number;
      breachCount: number;
      accounts: Set<string>;
      guard: ConvictionDcaGuardBucket;
    }
  >();
  const rowFor = (etDay: string) => {
    let row = rows.get(etDay);
    if (!row) {
      row = { addCount: 0, breachCount: 0, accounts: new Set(), guard: emptyGuardBucket() };
      rows.set(etDay, row);
    }
    return row;
  };
  for (const f of fills) {
    const row = rowFor(etDateString(new Date(f.ts)));
    row.addCount += 1;
    if (isBreach(f)) row.breachCount += 1;
    row.accounts.add(convictionDcaAccountKey(f.account));
  }
  for (const ev of events) {
    foldIntoGuardBucket(rowFor(etDateString(new Date(ev.ts))).guard, ev);
  }
  return [...rows.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([etDay, row]) => ({
      etDay,
      addCount: row.addCount,
      breachCount: row.breachCount,
      accounts: [...row.accounts].sort(),
      addsPresented: row.guard.addsPresented,
      addsEvaluated: row.guard.addsEvaluated,
      addsHalted: row.guard.addsHalted,
      guardState: guardStateOf(row.guard),
    }));
}

/**
 * Fold the store into the read-only gate diagnostics. When `deployAnchor` (ms
 * epoch) is given, counts/tail are restricted to fills at/after it — the
 * configurable "since deploy" window the TRA-1276 review pulls. With no anchor
 * the whole ledger is summarized (the file is created at deploy, so it IS the
 * since-deploy window). Pure — no IO, no realized PnL.
 *
 * TRA-2303 — BOTH branches are exact over the full ledger. Check `countsExact`
 * before grading anything off an anchored result.
 */
export function summarizeConvictionDca(
  deployAnchor: number | null = null,
  paging?: ConvictionDcaRecentPaging,
): ConvictionDcaSummary {
  const { limit, offset } = resolvePaging(paging);
  if (deployAnchor == null) {
    // `bySession` and the pageable window derive from `retainedFills` even here, where
    // the pooled counts come from the monotonic counters. That is deliberate and the
    // two are NOT interchangeable: the monotonic counts are exact over the whole file,
    // the session rows are exact over retention. `droppedFillCount > 0` is the flag
    // that says the session rows no longer reach the oldest sessions — do not read an
    // absent session row as a session with no adds when it is non-zero.
    const window = retainedFills;
    const page = pageFills(window, limit, offset);
    // Both the pooled counts AND the partitions come from the monotonic
    // boot-hydrated counters here — i.e. the FULL JSONL, not the 50-fill tail.
    // Re-deriving byClass from `recentFills` would reproduce the very blindness
    // this partition exists to remove, at a new name.
    return {
      addCount,
      breachCount,
      firstAddAt,
      lastAddAt,
      deployAnchor: null,
      byClass: cloneBuckets(byClass),
      byMode: cloneBuckets(byMode),
      byAccount: cloneBuckets(byAccount),
      accountCount: Object.values(byAccount).filter((b) => b.addCount > 0).length,
      countsBasis: 'monotonic-full',
      countsExact: true,
      retainedFillCount: retainedFills.length,
      droppedFillCount: droppedFills,
      recent: page,
      recentWindow: {
        matched: window.length,
        offset,
        limit,
        returned: page.length,
        complete: page.length === window.length,
      },
      bySession: rollupSessions(window, guardEvents),
    };
  }
  // TRA-2303 — the monotonic counters can't be re-filtered by ts, so the anchored
  // branch re-derives. It derives over ALL retained fills, NOT the 50-fill display
  // tail: that tail spans ~1.5 days at the observed rate, so re-deriving over it
  // silently dropped every equity fill (all 3 landed on the ledger's first day) the
  // moment an anchor was set — reinstating, behind an env var, exactly the blindness
  // the TRA-2265 partition exists to remove. When retention itself has truncated,
  // `countsExact:false` below says so rather than serving a short count as complete.
  const anchored = retainedFills.filter((f) => f.ts >= deployAnchor);
  let breaches = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const f of anchored) {
    if (isBreach(f)) breaches += 1;
    if (first == null || f.ts < first) first = f.ts;
    if (last == null || f.ts > last) last = f.ts;
  }
  // Partitions re-derive over the SAME anchored population the pooled counts above
  // use, so the sum reconciliation holds in this branch too.
  const {
    byClass: anchoredByClass,
    byMode: anchoredByMode,
    byAccount: anchoredByAccount,
  } = foldBuckets(anchored);
  const anchoredPage = pageFills(anchored, limit, offset);
  return {
    addCount: anchored.length,
    breachCount: breaches,
    firstAddAt: first,
    lastAddAt: last,
    deployAnchor,
    byClass: anchoredByClass,
    byMode: anchoredByMode,
    byAccount: anchoredByAccount,
    accountCount: Object.values(anchoredByAccount).filter((b) => b.addCount > 0).length,
    countsBasis: droppedFills === 0 ? 'retained-full' : 'retained-truncated',
    // Deliberately conservative: ANY eviction marks the anchored counts inexact,
    // even though an anchor after the eviction boundary would still be exact.
    // That would rely on the JSONL being ts-ordered; a wrong "exact" is far worse
    // than a pessimistic one, so this fails closed on the retention question.
    countsExact: droppedFills === 0,
    retainedFillCount: retainedFills.length,
    droppedFillCount: droppedFills,
    recent: anchoredPage,
    recentWindow: {
      matched: anchored.length,
      offset,
      limit,
      returned: anchoredPage.length,
      complete: anchoredPage.length === anchored.length,
    },
    bySession: rollupSessions(
      anchored,
      guardEvents.filter((e) => e.ts >= deployAnchor),
    ),
  };
}
