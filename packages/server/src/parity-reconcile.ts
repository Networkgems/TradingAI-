// TRA-2237 (parent TRA-2234 → grandparent TRA-2174, board `de2afcbd`) — the
// parity-reconcile monitor.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────────
// A pure summarizer + durable daily series + no-auth health route that turns each
// SANDBOX round-trip's OWN mid-vs-fill into a per-strategy demo-mark-vs-sandbox-fill
// P&L-gap / half-spread observable. Everything needed is already on the
// `SandboxStrategyRecord` legs (TRA-2134): `requestedPx` = the decision mid = what the
// demo book marks at, `fillPx` = the real sandbox fill. There is NO new order stream
// and NO cross-account matching — the "demo" side is a labelled COUNTERFACTUAL
// mid-mark of the very same sandbox round-trip, not the demo `option-trade-journal`.
//
// ── WHY IT CANNOT GATE ANYTHING ──────────────────────────────────────────────
// Sandbox fills are broker-SIMULATED (`fillRealism:'SANDBOX_SIMULATED'`): they model
// no real queue position, slippage, or partial-fill-under-load. So this gap is a
// data-quality observable ONLY. It sits under the TRA-1897 hold — nothing here gates,
// arms, or graduates. The `fillRealism` tag rides on the payload precisely so no
// downstream reader mistakes it for a live-execution number.
//
// ── THE IDENTITY THAT MAKES IT COMPUTABLE FROM ONE ACCOUNT ───────────────────
// Per leg, the signed cost of crossing the spread AWAY from the decision mid is
//   signedCostPerContract = side === 'buy' ? (fillPx − requestedPx)   // paid up to buy
//                                          : (requestedPx − fillPx)   // gave up to sell
// A round-trip's demo-mark cashflow marks every leg at `requestedPx`; its real cashflow
// marks at `fillPx`. Summing signed leg cashflows,
//   parityGapUsd(rt) = Σ_legs signedCostPerContract × 100  ==  demoMarkPnl − sandboxFillPnl
// i.e. the half-spread the demo book's mid-mark silently omits vs. the real fill. Both
// P&Ls here EXCLUDE modeled commission by construction (they differ only in px), so the
// gap isolates the fill-vs-mid spread cost, not fees. (Contract multiplier 100, qty
// assumed 1 — TRA-2134 round-trips are single-contract; tagged `qtyAssumed:1`.)
//
// ── NULL DISCIPLINE (the recurring false-zero trap) ──────────────────────────
// A leg with `requestedPx == null` (one-sided decision quote) OR `fillPx == null`
// (never filled) makes the WHOLE round-trip uncomputable: it is EXCLUDED and an
// `uncomputable` counter is incremented. A null is NEVER folded as 0 — a 0-gap and an
// unprovable gap must not read alike. Likewise `gapToDemoMarkRatio` is 3-valued: null
// when the demo-mark denominator is below the materiality floor, never a fabricated 0 —
// and `gapToDemoMarkRatioStatus` says WHICH null it is, so no null is unattributable.
//
// ── TRA-2279 D1 — THE FIELD FORMERLY CALLED `gapPct` ─────────────────────────
// `gapPct` was a RATIO wearing a percent's name: no `× 100`, so the live payload's
// `gapPct: 17` meant 17× (1700%), and the TRA-2277 handoff duly read it as "17.00%".
// It is REMOVED, not rescaled-in-place: a key that keeps its name while its value moves
// 100× is exactly the instrument that reads identically in a right and a wrong state.
// An ABSENT key makes a stale reader fail loudly instead of quoting a units error.
// The replacement `gapToDemoMarkRatio` is unit-honest in its name AND guarded by a
// materiality floor on |demoMarkPnlUsd| — rescaling alone would not have fixed the
// real defect, which is that the denominator ($1.00–$1.50 live) sits so near zero that
// the ratio diverges and can flip sign on a one-tick mid change.
//
// ── TRA-2279 D2 — THE DAILY POINT IS NO LONGER FROZEN AT FIRST READ ──────────
// Accrual was `hasSnapshotFor(etDay) ⇒ no-op`, so the day froze at the FIRST read that
// found `n > 0` and every later fill landed in `cumulative` but in no daily point ever.
// Worse, the covered window was UNDEFINED (it depended on whether the runner curled the
// route before or after placing that fire's trades) and nothing in the payload said so.
// Now the same-day fold is an UPSERT — last-write-wins per ET day — and each point
// stamps `firstFoldTs` / `lastFoldTs` / `foldCount` / `sessionComplete` so a reader can
// tell a full session from a 90-minute slice WITHOUT reading the cron. A day that was
// observed-and-empty now writes a point (`perStrategy:{}`, `observedRecords`,
// `uncomputable`), so ABSENT — nobody looked — no longer reads like a genuine no-trade
// day. The JSONL stays append-only; hydration keeps the LAST record per `etDay`.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { etDateString } from './scheduler.js';
import { FILL_REALISM, FILL_REALISM_NOTE } from './tradier-sandbox-options-smoke.js';
import type { SandboxStrategyRecord } from './sandbox-strategy-journal.js';

const log = logger.child({ module: 'parity-reconcile' });

export const PARITY_RECONCILE_LOG_FILENAME = 'parity-reconcile.jsonl';

/** Retain this many ms of daily snapshots on disk (compacted on boot). 60 days — same
 *  standing-program horizon as the sandbox journal this folds from. */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;

/** Option contract multiplier. qty is assumed 1 (single-contract round-trips). */
const CONTRACT_MULTIPLIER = 100;

/**
 * TRA-2279 D1 — MATERIALITY floor on |demoMarkPnlUsd| for `gapToDemoMarkRatio`, in USD.
 * NOT a divide-by-zero epsilon: the old `DENOM_EPS = 1e-9` guarded only an EXACT zero,
 * which left the ratio numerically unstable across the entire small-P&L regime this
 * sandbox actually operates in (live denominators were $1.00 / $1.00 / −$1.50).
 *
 * Where 10 comes from: option mids are quoted on a $0.01 grid, and the denominator is
 * (Σ signed mids) × 100, so ONE tick of mid movement on ONE leg moves the denominator by
 * ~$1.00. For the ratio to be stable to within ~10% of itself against a single-tick mid
 * change we need |denom| ≳ 10 × $1.00. Below that the ratio is reporting quote
 * quantization, not a spread cost — and it can flip sign outright. So it reads `null`.
 *
 * A ratio suppressed by this floor is NOT a missing observation: `parityGapUsd` and
 * `halfSpreadBps` are unit-correct and stable at any denominator and remain populated.
 * Only the RATIO — the one field whose denominator can vanish — is withheld.
 */
export const RATIO_DENOM_FLOOR_USD = 10;

/** TRA-2279 D1 — rides the payload so the units cannot be guessed wrong twice. */
export const GAP_RATIO_NOTE =
  'gapToDemoMarkRatio is a RATIO, not a percent: 0.15 = 15%. It replaces the removed '
  + '`gapPct`, which carried this same ratio under a percent name (a live `gapPct: 17` '
  + `meant 17x / 1700%). It is null unless |demoMarkPnlUsd| >= $${RATIO_DENOM_FLOOR_USD} `
  + '(a MATERIALITY floor: option mids move on a $0.01 grid x100 multiplier, so one tick '
  + 'shifts the denominator ~$1, and below the floor the ratio reports quote quantization '
  + 'and can flip sign). `parityGapUsd` and `halfSpreadBps` are unit-correct and stable at '
  + 'any denominator — grade on those.';

export const PARITY_SCOPE =
  'SANDBOX ONLY (acct VA20296703), $0 real notional. Demo side is a COUNTERFACTUAL '
  + 'mid-mark of the sandbox round-trip itself — NEVER pooled with demo option-trade-journal '
  + 'rows. Read-only observable under the TRA-1897 hold; gates/arms/graduates nothing.';

// ── per-round-trip fold (pure) ───────────────────────────────────────────────

/** The computable parity of one round-trip, or `null` when any leg is unprovable. */
export interface RoundTripParity {
  demoMarkPnlUsd: number;
  sandboxFillPnlUsd: number;
  /** `demoMarkPnl − sandboxFillPnl` = Σ_legs signedCostPerContract × 100. */
  parityGapUsd: number;
  /** Per-leg `signedCostPerContract / requestedPx × 1e4`; only finite entries. */
  legHalfSpreadBps: number[];
}

/**
 * Fold one round-trip into its parity contribution. Returns `null` when ANY leg has a
 * null `requestedPx` or `fillPx` (⇒ the caller counts it `uncomputable` and drops it) —
 * a missing price is NEVER coerced to 0. A round-trip with zero legs is also
 * uncomputable (nothing to mark).
 */
export function parityForRoundTrip(rec: SandboxStrategyRecord): RoundTripParity | null {
  if (rec.legs.length === 0) return null;
  let demoMarkPnlUsd = 0;
  let sandboxFillPnlUsd = 0;
  let parityGapUsd = 0;
  const legHalfSpreadBps: number[] = [];
  for (const leg of rec.legs) {
    const { requestedPx, fillPx, side } = leg;
    if (requestedPx == null || fillPx == null) return null; // uncomputable — never fold as 0
    // A sell leg is a cash inflow (+px), a buy leg an outflow (−px). Marking every leg
    // at its mid gives the demo book's P&L; at its fill, the real sandbox P&L.
    const sign = side === 'sell' ? 1 : -1;
    demoMarkPnlUsd += sign * requestedPx * CONTRACT_MULTIPLIER;
    sandboxFillPnlUsd += sign * fillPx * CONTRACT_MULTIPLIER;
    const signedCostPerContract = side === 'buy' ? fillPx - requestedPx : requestedPx - fillPx;
    parityGapUsd += signedCostPerContract * CONTRACT_MULTIPLIER;
    if (requestedPx !== 0 && Number.isFinite(requestedPx)) {
      const bps = (signedCostPerContract / requestedPx) * 1e4;
      if (Number.isFinite(bps)) legHalfSpreadBps.push(bps);
    }
  }
  return { demoMarkPnlUsd, sandboxFillPnlUsd, parityGapUsd, legHalfSpreadBps };
}

// ── per-strategy aggregate (pure) ────────────────────────────────────────────

export interface ParityBucket {
  /** Computable (fully-priced) round-trips in this bucket. */
  n: number;
  /** Round-trips excluded because a leg had a null requested/fill price. NOT a 0-gap. */
  uncomputable: number;
  demoMarkPnlUsd: number;
  sandboxFillPnlUsd: number;
  parityGapUsd: { sum: number; mean: number | null };
  /**
   * TRA-2279 D1 — `parityGapUsd.sum / |demoMarkPnlUsd|` as a **RATIO**, not a percent:
   * `0.15` means 15%, `17` would mean 1700%. (The old `gapPct` carried this exact value
   * under a percent's name and was read as "17.00%" — hence the rename + removal.)
   * `null` unless |demoMarkPnlUsd| clears {@link RATIO_DENOM_FLOOR_USD}. 3-valued —
   * never a fabricated 0. See `gapToDemoMarkRatioStatus` for WHICH null this is.
   */
  gapToDemoMarkRatio: number | null;
  /** Attribution for the field above — a null is never left unexplained. */
  gapToDemoMarkRatioStatus:
    | 'computed'
    | 'no_computable_round_trips'
    | 'denominator_below_materiality_floor';
  halfSpreadBps: { mean: number | null; median: number | null; p90: number | null };
}

export interface ParityStrategyEntry {
  /** Metrics restricted to the reference ET day (`etDay` at the payload root). */
  etDay: ParityBucket;
  /** Metrics over every retained round-trip for this strategy. */
  cumulative: ParityBucket;
  fillRealism: typeof FILL_REALISM;
  qtyAssumed: 1;
}

export interface ParityReconcileSummary {
  /** The reference ET calendar day the `etDay` bucket is scoped to (from `now`). */
  etDay: string;
  totalRecords: number;
  strategies: Record<string, ParityStrategyEntry>;
  /** TRA-2279 D1 — the |demoMarkPnlUsd| floor below which `gapToDemoMarkRatio` is null. */
  gapRatioDenomFloorUsd: number;
  /** TRA-2279 D1 — spelled out on the payload so no reader has to infer the units. */
  gapRatioNote: string;
  retentionDays: number;
  fillRealism: typeof FILL_REALISM;
  fillRealismNote: string;
  qtyAssumed: 1;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** TRA-2279 — ratios need more places than dollars: `round2` would flatten a 0.4%
 *  gap-to-mark ratio (0.004) to 0.00 and manufacture a false zero out of a real ratio. */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Percentile by linear interpolation on the sorted sample; `null` on an empty sample.
 *  p=0.5 ⇒ median, p=0.9 ⇒ p90. n=1 returns that single value for any p. */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/** Aggregate a set of round-trips into one bucket. Pure. */
function foldBucket(recs: readonly SandboxStrategyRecord[]): ParityBucket {
  let n = 0;
  let uncomputable = 0;
  let demoMarkPnlUsd = 0;
  let sandboxFillPnlUsd = 0;
  let gapSum = 0;
  const halfSpreads: number[] = [];
  for (const rec of recs) {
    const p = parityForRoundTrip(rec);
    if (p == null) {
      uncomputable += 1;
      continue;
    }
    n += 1;
    demoMarkPnlUsd += p.demoMarkPnlUsd;
    sandboxFillPnlUsd += p.sandboxFillPnlUsd;
    gapSum += p.parityGapUsd;
    for (const bps of p.legHalfSpreadBps) halfSpreads.push(bps);
  }
  // TRA-2279 D1 — the ratio is withheld unless its denominator is MATERIAL, and the
  // reason is stamped. `no_computable_round_trips` (n===0) and a real-but-tiny
  // denominator are different facts and must not both surface as a bare `null`.
  const denom = Math.abs(demoMarkPnlUsd);
  const ratioStatus: ParityBucket['gapToDemoMarkRatioStatus'] =
    n === 0
      ? 'no_computable_round_trips'
      : denom >= RATIO_DENOM_FLOOR_USD
        ? 'computed'
        : 'denominator_below_materiality_floor';
  const sorted = halfSpreads.slice().sort((a, b) => a - b);
  const hsMean = halfSpreads.length > 0 ? halfSpreads.reduce((a, b) => a + b, 0) / halfSpreads.length : null;
  return {
    n,
    uncomputable,
    demoMarkPnlUsd: round2(demoMarkPnlUsd),
    sandboxFillPnlUsd: round2(sandboxFillPnlUsd),
    parityGapUsd: { sum: round2(gapSum), mean: n > 0 ? round2(gapSum / n) : null },
    gapToDemoMarkRatio: ratioStatus === 'computed' ? round4(gapSum / denom) : null,
    gapToDemoMarkRatioStatus: ratioStatus,
    halfSpreadBps: {
      mean: hsMean != null ? round2(hsMean) : null,
      median: (() => { const m = percentile(sorted, 0.5); return m != null ? round2(m) : null; })(),
      p90: (() => { const m = percentile(sorted, 0.9); return m != null ? round2(m) : null; })(),
    },
  };
}

/**
 * Fold the sandbox journal records into the per-strategy parity summary. Pure — no IO.
 * `now` fixes the reference ET day the `etDay` bucket is scoped to; `cumulative` spans
 * every retained record for the strategy. A strategy present with `n:0` but
 * `uncomputable>0` is the tell that it ran but every round-trip was unpriced — do NOT
 * read that as a 0 gap.
 */
export function summarizeParityReconcile(
  records: readonly SandboxStrategyRecord[],
  now: number = Date.now(),
): ParityReconcileSummary {
  const refEtDay = etDateString(new Date(now));
  const byStrategy = new Map<string, SandboxStrategyRecord[]>();
  for (const rec of records) {
    const list = byStrategy.get(rec.strategy) ?? [];
    list.push(rec);
    byStrategy.set(rec.strategy, list);
  }
  const strategies: Record<string, ParityStrategyEntry> = {};
  for (const [strategy, list] of byStrategy.entries()) {
    const today = list.filter((r) => r.etDay === refEtDay);
    strategies[strategy] = {
      etDay: foldBucket(today),
      cumulative: foldBucket(list),
      fillRealism: FILL_REALISM,
      qtyAssumed: 1,
    };
  }
  return {
    etDay: refEtDay,
    totalRecords: records.length,
    strategies,
    gapRatioDenomFloorUsd: RATIO_DENOM_FLOOR_USD,
    gapRatioNote: GAP_RATIO_NOTE,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    fillRealism: FILL_REALISM,
    fillRealismNote: FILL_REALISM_NOTE,
    qtyAssumed: 1,
  };
}

// ── durable daily series ─────────────────────────────────────────────────────

/** One compact per-strategy point in a daily snapshot. */
export interface ParitySnapshotStrategy {
  parityGapUsd: number;
  meanHalfSpreadBps: number | null;
  n: number;
}

/**
 * One appended snapshot: the etDay bucket, per strategy, for a single ET calendar day.
 *
 * TRA-2279 D2 — the window stamps are the point. Before them a daily row was a fold over
 * however much of the session happened to have elapsed at whatever moment the runner first
 * curled the route, and NOTHING on the payload distinguished a full session from a
 * 90-minute slice. `firstFoldTs`/`lastFoldTs`/`foldCount`/`sessionComplete` make the
 * covered window readable off the row itself.
 */
export interface ParityDailySnapshot {
  etDay: string;
  /** ms epoch of the LATEST fold for this day. Retention/compaction key; == `lastFoldTs`. */
  ts: number;
  /** ms epoch of the first fold that observed this ET day. */
  firstFoldTs: number;
  /** ms epoch of the most recent re-fold. The row is a fold of the day AS OF this instant. */
  lastFoldTs: number;
  /**
   * How many times this day has been folded (route reads + the hourly accrual tick).
   * ≥1 on every persisted row, which is what separates OBSERVED-AND-EMPTY (a row with
   * `perStrategy:{}`) from ABSENT (no row at all — nobody looked). Those two read
   * identically before this field existed.
   */
  foldCount: number;
  /**
   * True ⇔ `lastFoldTs` is at/after this ET day's 16:00 ET equity close, i.e. the row
   * covers the whole session. DST-correct (derived from ET wall-clock, not a fixed
   * 20:00Z), so it stays right through the November transition.
   */
  sessionComplete: boolean;
  /** Sandbox journal records carrying this `etDay` at the last fold — computable or not. */
  observedRecords: number;
  /** Round-trips this day EXCLUDED for a null leg price. Never folded as a 0 gap. */
  uncomputable: number;
  perStrategy: Record<string, ParitySnapshotStrategy>;
}

/** 16:00 ET — the equity close, as minutes since ET midnight. */
const SESSION_CLOSE_ET_MINUTES = 16 * 60;

const ET_HOUR_MINUTE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Minutes since ET midnight for `ts`. Goes through `Intl` rather than subtracting a fixed
 * UTC offset so the close comparison is DST-correct: the equity close is 20:00Z in EDT but
 * 21:00Z in EST, and hard-coding either one silently mis-stamps `sessionComplete` for half
 * the year. (`hourCycle:'h23'` keeps midnight at 0; the `% 24` is belt-and-braces against
 * runtimes that still render it as 24.)
 */
function etMinutesOfDay(ts: number): number {
  const parts = ET_HOUR_MINUTE_FMT.formatToParts(new Date(ts));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** True ⇔ `ts` falls at/after the 16:00 ET close of its own ET day. */
export function isPostCloseEt(ts: number): boolean {
  return etMinutesOfDay(ts) >= SESSION_CLOSE_ET_MINUTES;
}

let dataDir: string | null = null;
const series: ParityDailySnapshot[] = [];
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedSnapshots = 0;

export function parityReconcileLogPath(dir: string): string {
  return join(dir, PARITY_RECONCILE_LOG_FILENAME);
}

/** Test seam — drop every counter, the series, and the configured dir. */
export function clearParityReconcile(): void {
  dataDir = null;
  series.length = 0;
  appendErrors = 0;
  lastAppendError = null;
  hydratedSnapshots = 0;
}

/** Read-only view of the durable daily series (chronological). */
export function getParityReconcileSeries(): readonly ParityDailySnapshot[] {
  return series;
}

/** The always-present core of a persisted row; the TRA-2279 window stamps may be absent. */
function isValidSnapshot(snap: unknown): snap is Record<string, unknown> {
  if (snap == null || typeof snap !== 'object') return false;
  const s = snap as Record<string, unknown>;
  return (
    typeof s.etDay === 'string' &&
    s.etDay !== '' &&
    typeof s.ts === 'number' &&
    Number.isFinite(s.ts) &&
    s.perStrategy != null &&
    typeof s.perStrategy === 'object'
  );
}

function finiteNumberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Normalize a persisted row to the current shape.
 *
 * TRA-2279 D2 — rows written before this change carry no window stamps. They are NOT
 * back-filled with a guess: a pre-change row was written by first-write-wins code, so
 * `foldCount: 1` and `firstFoldTs === lastFoldTs === ts` are the literal truth about it,
 * and `sessionComplete` is re-derived from that single `ts` (which for the mid-session
 * runner cadence correctly reads FALSE). `observedRecords` is genuinely unknown for a
 * legacy row, so it is stamped `-1` — a sentinel that cannot be mistaken for an observed
 * zero. `uncomputable` likewise.
 */
function normalizeSnapshot(s: Record<string, unknown>): ParityDailySnapshot {
  const ts = s.ts as number;
  const lastFoldTs = finiteNumberOr(s.lastFoldTs, ts);
  const legacy = typeof s.foldCount !== 'number';
  return {
    etDay: s.etDay as string,
    ts,
    firstFoldTs: finiteNumberOr(s.firstFoldTs, ts),
    lastFoldTs,
    foldCount: finiteNumberOr(s.foldCount, 1),
    sessionComplete:
      typeof s.sessionComplete === 'boolean' ? s.sessionComplete : isPostCloseEt(lastFoldTs),
    observedRecords: finiteNumberOr(s.observedRecords, legacy ? -1 : 0),
    uncomputable: finiteNumberOr(s.uncomputable, legacy ? -1 : 0),
    perStrategy: s.perStrategy as Record<string, ParitySnapshotStrategy>,
  };
}

/**
 * Rebuild the daily series from disk on boot and remember `dir` for subsequent appends.
 * Idempotent: CLEARS first. Only snapshots within {@link RETAIN_MS} of `now` are kept, and
 * — TRA-2279 D2 — only the LAST record per `etDay`, since same-day re-folds append. The
 * file is COMPACTED to exactly those lines, so the daily re-fold appends do not accumulate
 * across reboots. Best-effort: a missing/corrupt file yields an empty series; a torn
 * trailing line is skipped. `snapshots` counts DISTINCT ET days after dedupe, so it now
 * equals `days` by construction.
 */
export function hydrateParityReconcileFromDisk(
  dir: string,
  now: number = Date.now(),
): { snapshots: number; days: number } {
  clearParityReconcile();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(parityReconcileLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  // TRA-2279 D2 — the log is append-only and same-day re-folds each append a line, so a
  // day can legitimately appear MANY times. Hydration keeps the LAST record per `etDay`
  // (append order == chronological), which is what makes last-write-wins survive a reboot.
  // Keying by `etDay` also means an interrupted re-fold degrades to the previous good row
  // rather than to nothing.
  const cutoff = now - RETAIN_MS;
  const byDay = new Map<string, ParityDailySnapshot>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let snap: unknown;
    try {
      snap = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial line
    }
    if (!isValidSnapshot(snap)) continue;
    if ((snap.ts as number) < cutoff) continue;
    const normalized = normalizeSnapshot(snap);
    byDay.set(normalized.etDay, normalized); // later line wins
  }

  const deduped = [...byDay.values()].sort((a, b) => a.ts - b.ts);
  const kept: string[] = [];
  const days = new Set<string>();
  for (const snap of deduped) {
    series.push(snap);
    days.add(snap.etDay);
    kept.push(JSON.stringify(snap));
  }
  hydratedSnapshots = series.length;

  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = parityReconcileLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('parity-reconcile series compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { snapshots: hydratedSnapshots, days: days.size };
}

/** Index of the in-memory snapshot for `etDay`, or −1. At most one row per day is held. */
function indexOfSnapshot(etDay: string): number {
  return series.findIndex((s) => s.etDay === etDay);
}

/**
 * Self-accrual: RE-FOLD today's etDay bucket on every call — last-write-wins per ET day.
 *
 * TRA-2279 D2 — this used to be first-write-wins (`hasSnapshotFor(etDay)` ⇒ no-op), which
 * froze the day at whatever moment the runner routine first curled the route. Both of
 * `d8ec9395`'s triggers are MID-session (15:00Z and 18:30Z against a 20:00Z close), so
 * every fill after the first read landed in `cumulative` and in NO daily point, ever —
 * and the covered window wasn't merely partial, it was undefined, because it depended on
 * whether the runner read the journal before or after placing that fire's trades.
 *
 * Re-folding is safe and cheap: it is a pure fold over the already-in-memory sandbox
 * journal, not a broker call. The JSONL stays append-only (a second line for the same
 * `etDay` is written, and hydration keeps the LAST one), so a torn write can never destroy
 * the earlier good row — it just leaves a staler one in place.
 *
 * A day observed with NO computable round-trip is now still persisted (`perStrategy:{}`
 * plus `observedRecords`/`uncomputable`/`foldCount`). That is the point: `null` + no row
 * made "we looked and there was nothing" indistinguishable from "nobody ever looked".
 *
 * Best-effort on IO: a write failure is counted + logged, never thrown — a monitor must
 * never break its own read.
 */
export function appendParitySnapshotForDay(
  records: readonly SandboxStrategyRecord[],
  now: number = Date.now(),
): ParityDailySnapshot {
  const etDay = etDateString(new Date(now));
  const summary = summarizeParityReconcile(records, now);

  const perStrategy: Record<string, ParitySnapshotStrategy> = {};
  let uncomputable = 0;
  for (const [strategy, entry] of Object.entries(summary.strategies)) {
    uncomputable += entry.etDay.uncomputable;
    if (entry.etDay.n === 0) continue; // no computable round-trip for this strategy today
    perStrategy[strategy] = {
      parityGapUsd: entry.etDay.parityGapUsd.sum,
      meanHalfSpreadBps: entry.etDay.halfSpreadBps.mean,
      n: entry.etDay.n,
    };
  }

  const at = indexOfSnapshot(etDay);
  const prior = at >= 0 ? series[at] : null;
  const snapshot: ParityDailySnapshot = {
    etDay,
    ts: now,
    // Carry the FIRST fold forward across re-folds; only `lastFoldTs` advances. The pair
    // is what tells a reader the covered window, so the lower bound must not drift up.
    firstFoldTs: prior?.firstFoldTs ?? now,
    lastFoldTs: now,
    foldCount: (prior?.foldCount ?? 0) + 1,
    sessionComplete: isPostCloseEt(now),
    observedRecords: records.filter((r) => r.etDay === etDay).length,
    uncomputable,
    perStrategy,
  };

  if (at >= 0) series[at] = snapshot;
  else series.push(snapshot);

  if (dataDir != null) {
    const path = parityReconcileLogPath(dataDir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(snapshot) + '\n', 'utf8');
    } catch (err) {
      appendErrors += 1;
      lastAppendError = err instanceof Error ? err.message : String(err);
      log.warn('parity-reconcile snapshot append failed', { reason: lastAppendError });
    }
  }
  return snapshot;
}

export interface ParityReconcileDurability {
  dataDir: string | null;
  ephemeral: boolean;
  hydratedSnapshots: number;
  appendErrors: number;
  lastAppendError: string | null;
}

export function parityReconcileDurability(): ParityReconcileDurability {
  return {
    dataDir,
    ephemeral: isEphemeralDataDir(dataDir),
    hydratedSnapshots,
    appendErrors,
    lastAppendError,
  };
}
