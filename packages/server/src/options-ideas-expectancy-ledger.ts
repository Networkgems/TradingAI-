// TRA-2199 (parent TRA-2175 → TRA-2005) — durable SHADOW ledger + rollup for the
// options-ideas positive-expectancy gate.
//
// THE DEFECT THIS CLOSES. `options-research.ts` builds `expectancyShadow` and
// spreads it into `OptionsResearchResult`, and then **nothing reads it**. Repo-wide
// the identifier appeared only inside the producer: no reader, no persistence, no
// route. The ledger was therefore unobservable BY CONSTRUCTION — no deploy and no
// env flip could make it readable, so the TRA-2005 leg looked armed when it was
// inert. This module is the missing reader.
//
// WHAT IS PERSISTED, AND WHY IT IS AGGREGATE-ONLY. The probe that consumes this
// (`GET /api/health/options-ideas-expectancy`) is NO-AUTH on bqb1 — QuantTrader has
// no session there, which is exactly why TRA-2004 needed a public probe. So the row
// carries the same redacted basis as `/api/health/options-ideas-decomposition`:
// verdict COUNTS, config, and aggregate expectancy statistics sliced by structure
// FAMILY. Deliberately NOT persisted: per-idea text (the gate's `reasons` strings
// interpolate live numbers and are not stable keys anyway), tickers, and any P&L.
// Drop causes are recorded as a bounded histogram of canonical CODES derived
// structurally from the verdict fields — never by parsing a reason string.
//
// ONE ROW PER FRESH SLATE. The caller records only when `research.cached === false`,
// mirroring the TRA-658 spend guardrail: a batch-cache hit re-serves the SAME
// result object (including the same `expectancyShadow`), so recording on a hit would
// inflate the cohort with duplicate slates off the panel's 60s poll.
//
// DURABLE BECAUSE bqb1 REBOOTS. Same reason as the TRA-1602 / TRA-1892 ledgers: an
// in-memory since-boot counter reads empty by the time a post-close grade fires. The
// rollup therefore hydrates from JSONL on boot and publishes `durability.ephemeral`
// (TRA-1681) so a reader can never mistake a wiped DATA_DIR for a quiet gate.
//
// SHADOW-ONLY. Pure accounting over verdicts ALREADY computed upstream. Wires no
// capital, reorders nothing, drops nothing, alters no surfaced slate. Notional $0.

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  resolveExpectancyGateConfig,
  EXPECTANCY_GATE_ENABLE_VAR,
  type IdeaExpectancyShadow,
  type IdeaExpectancyShadowEntry,
} from '@trading-app/agents';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';
import { etDateKey } from './options-chain-recorder.js';
import { isEphemeralDataDir } from './data-dir.js';

const log = logger.child({ module: 'options-ideas-expectancy-ledger' });

export const OPTIONS_IDEAS_EXPECTANCY_LOG_FILENAME = 'options-ideas-expectancy-shadow.jsonl';

/** Rolling window the rollup reports over — long enough to hold a verdict cohort. */
export const EXPECTANCY_LEDGER_WINDOW_DAYS = 30;

/** Bounded tail kept in memory for the health view (counts stay complete). */
const MAX_RECENT_SLATES = 60;

/**
 * Canonical, text-free drop causes. Derived STRUCTURALLY from the verdict fields —
 * never by parsing the gate's human-readable `reasons`, which interpolate live
 * numbers and would explode the histogram's key space.
 */
export type ExpectancyDropCode =
  /** Parked structure family (too-thin sample) — dropped regardless of modelled edge. */
  | 'parked_structure'
  /** IV-rank unknown or below the credit-structure floor. */
  | 'iv_rank_floor'
  /** E[R] below the configured minimum at the calibrated POP. */
  | 'expectancy_below_min'
  /** credit/width below the breakeven the structure must clear. */
  | 'credit_width_below_breakeven';

/** Verdict counts — the same shape the gate rolls up, reused per slice. */
export interface ExpectancyVerdictCounts {
  total: number;
  /** Would be surfaced as tradable. */
  admit: number;
  /** CONFIRMED negative-expectancy / credit-width / IVR would-drop — the leak cohort. */
  drop: number;
  parked: number;
  /** Credit structure the model didn't price — a data gap, NOT a confirmed −EV. */
  unpriced: number;
  /** Debit / long-premium family — out of scope for this gate. */
  notCredit: number;
}

/** Aggregate expectancy statistics over the PRICED credit entries of a slice. */
export interface ExpectancyStats {
  /** Priced entries the statistics are taken over (finite E[R] only). */
  n: number;
  meanExpectancyR: number | null;
  minExpectancyR: number | null;
  maxExpectancyR: number | null;
  meanCreditWidth: number | null;
  meanBreakevenCreditWidth: number | null;
  /** Mean POP actually scored (calibrated, else the interim flat haircut). */
  meanPopUsed: number | null;
}

/**
 * One persisted slate — the verdicts the gate WOULD have applied to one freshly
 * researched AI-Options-Ideas feed. Aggregate-only by construction (see header).
 */
export interface ExpectancyShadowSlateRecord {
  /** Slate build time, ms epoch. */
  ts: number;
  /** Same instant, ISO-8601 — the `generatedAt` the verdict cohort keys on. */
  generatedAt: string;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the rollup windows on. */
  etDay: string;
  counts: ExpectancyVerdictCounts;
  /** Resolved gate config the verdicts were scored under (audit reproducibility). */
  config: IdeaExpectancyShadow['config'];
  stats: ExpectancyStats;
  /** Verdict counts by structure FAMILY (e.g. bull_put_spread) — no tickers. */
  byStrategy: Record<string, ExpectancyVerdictCounts>;
  /** Histogram of canonical drop codes. A drop can carry more than one code. */
  dropCodes: Partial<Record<ExpectancyDropCode, number>>;
}

// ── In-memory store ──────────────────────────────────────────────────────────
//
// Module-global + observe-only, matching the sibling ledgers: `dataDir` is set once
// at boot by the hydrate so the feed call site can append without threading a path
// through the service. Counters are rebuilt from the full JSONL on boot.

let dataDir: string | null = null;
const slates: ExpectancyShadowSlateRecord[] = [];

export function optionsIdeasExpectancyLogPath(dir: string): string {
  return join(dir, OPTIONS_IDEAS_EXPECTANCY_LOG_FILENAME);
}

/** Test seam — drop every slate and the configured dir. */
export function clearOptionsIdeasExpectancyLedger(): void {
  dataDir = null;
  slates.length = 0;
}

function emptyCounts(): ExpectancyVerdictCounts {
  return { total: 0, admit: 0, drop: 0, parked: 0, unpriced: 0, notCredit: 0 };
}

/** Fold one entry's verdict into a counts bucket. */
function tally(into: ExpectancyVerdictCounts, verdict: string): void {
  into.total += 1;
  if (verdict === 'admit') into.admit += 1;
  else if (verdict === 'drop') into.drop += 1;
  else if (verdict === 'parked') into.parked += 1;
  else if (verdict === 'unpriced') into.unpriced += 1;
  else if (verdict === 'not_credit') into.notCredit += 1;
}

/**
 * Canonical drop codes for one entry, derived from the verdict FIELDS. A 'drop'
 * with non-finite expectancy fields can only be the bare IV-rank rejection (the
 * gate's check 3 is the sole bare drop); a priced drop reports whichever of the two
 * numeric tests it failed, and can fail both.
 */
function dropCodesOf(entry: IdeaExpectancyShadowEntry, minExpectancyR: number): ExpectancyDropCode[] {
  const r = entry.result;
  if (r.verdict === 'parked') return ['parked_structure'];
  if (r.verdict !== 'drop') return [];
  if (!Number.isFinite(r.expectancyR)) return ['iv_rank_floor'];
  const codes: ExpectancyDropCode[] = [];
  if (r.expectancyR < minExpectancyR) codes.push('expectancy_below_min');
  if (Number.isFinite(r.creditWidth) && r.creditWidth < r.breakevenCreditWidth) {
    codes.push('credit_width_below_breakeven');
  }
  // A drop the two numeric tests don't explain would otherwise vanish from the
  // histogram; attribute it to the expectancy leg rather than losing the row.
  return codes.length > 0 ? codes : ['expectancy_below_min'];
}

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Aggregate expectancy statistics over entries carrying a finite E[R]. */
function statsOf(entries: readonly IdeaExpectancyShadowEntry[]): ExpectancyStats {
  const priced = entries.filter((e) => Number.isFinite(e.result.expectancyR));
  if (priced.length === 0) {
    return {
      n: 0,
      meanExpectancyR: null,
      minExpectancyR: null,
      maxExpectancyR: null,
      meanCreditWidth: null,
      meanBreakevenCreditWidth: null,
      meanPopUsed: null,
    };
  }
  const er = priced.map((e) => e.result.expectancyR);
  return {
    n: priced.length,
    meanExpectancyR: mean(er),
    minExpectancyR: Math.min(...er),
    maxExpectancyR: Math.max(...er),
    meanCreditWidth: mean(priced.map((e) => e.result.creditWidth).filter(Number.isFinite)),
    meanBreakevenCreditWidth: mean(
      priced.map((e) => e.result.breakevenCreditWidth).filter(Number.isFinite),
    ),
    meanPopUsed: mean(priced.map((e) => e.result.popUsed).filter(Number.isFinite)),
  };
}

/**
 * Reduce one shadow ledger to its DURABLE aggregate row. Pure. This is the
 * redaction boundary: per-idea tickers, ranks and reason strings are read here and
 * deliberately do not survive into the record.
 */
export function summarizeSlate(
  shadow: IdeaExpectancyShadow,
  generatedAtMs: number,
): ExpectancyShadowSlateRecord {
  const byStrategy: Record<string, ExpectancyVerdictCounts> = {};
  const dropCodes: Partial<Record<ExpectancyDropCode, number>> = {};
  for (const entry of shadow.entries) {
    const bucket = (byStrategy[entry.strategy] ??= emptyCounts());
    tally(bucket, entry.result.verdict);
    for (const code of dropCodesOf(entry, shadow.config.minExpectancyR)) {
      dropCodes[code] = (dropCodes[code] ?? 0) + 1;
    }
  }
  return {
    ts: generatedAtMs,
    generatedAt: new Date(generatedAtMs).toISOString(),
    etDay: etDateKey(generatedAtMs),
    counts: { ...shadow.counts },
    config: { ...shadow.config, parked: [...shadow.config.parked] },
    stats: statsOf(shadow.entries),
    byStrategy,
    dropCodes,
  };
}

/** Fold one slate into the in-memory tail (no IO). */
function applySlate(rec: ExpectancyShadowSlateRecord): void {
  slates.push(rec);
  while (slates.length > MAX_RECENT_SLATES) slates.shift();
}

/**
 * Record one freshly-researched slate's shadow verdicts: update the in-memory store
 * AND append one JSONL line under the configured DATA_DIR. Best-effort on IO — a
 * write failure logs and is swallowed so this accounting can never break the ideas
 * feed. With no dataDir configured (unit tests / CLI without boot) the in-memory
 * rollup still updates; only the file write is skipped.
 *
 * Call ONLY on a non-cached research pass — see the header on duplicate slates.
 */
export function recordExpectancyShadowSlate(
  shadow: IdeaExpectancyShadow,
  generatedAtMs: number,
): ExpectancyShadowSlateRecord {
  const rec = summarizeSlate(shadow, generatedAtMs);
  applySlate(rec);
  if (dataDir == null) return rec;
  const path = optionsIdeasExpectancyLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('options-ideas expectancy slate append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return rec;
}

/** What {@link hydrateOptionsIdeasExpectancyFromDisk} recovered (for the boot log). */
export interface OptionsIdeasExpectancyHydration {
  slates: number;
  days: number;
}

/**
 * Rebuild the in-memory rollup from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup.
 * Best-effort — a missing/corrupt file yields an empty hydration (and a torn
 * trailing line is skipped) rather than throwing.
 */
export function hydrateOptionsIdeasExpectancyFromDisk(
  dir: string,
): OptionsIdeasExpectancyHydration {
  clearOptionsIdeasExpectancyLedger();
  dataDir = dir;

  // TRA-1463 — boot-hydrate synchronous read+parse; wrap so a stall here is NAMED
  // in the watchdog trip breadcrumb (`slowPhase`).
  return timeSyncPhase('hydrate.optionsIdeasExpectancy', () => {
    let raw = '';
    try {
      raw = readFileSync(optionsIdeasExpectancyLogPath(dir), 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as ExpectancyShadowSlateRecord;
        if (typeof rec.ts === 'number' && rec.counts != null) applySlate(rec);
      } catch {
        // skip a torn/partial trailing line rather than abort the hydrate
      }
    }
    return { slates: slates.length, days: new Set(slates.map((s) => s.etDay)).size };
  });
}

// ── Health rollup ────────────────────────────────────────────────────────────

/** The cohort rollup `GET /api/health/options-ideas-expectancy` returns. */
export interface OptionsIdeasExpectancySummary {
  /**
   * Whether the shadow gate is currently RECORDING (ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE).
   * This is the field that separates "gate off, nothing recorded" from "gate on,
   * nothing qualified" — the distinction whose absence made this leg look armed
   * when it was inert. Note this flag is INVERTED versus TRA-2006's
   * ENABLE_POP_CALIBRATION: there, OFF still computes the shadow fit; here, OFF
   * skips the shadow pass entirely and records nothing at all.
   */
  enabled: boolean;
  /** The env var `enabled` reflects, named so a reader can act on it without grep. */
  flag: string;
  /** Rolling window the rollup covers, in ET days. */
  windowDays: number;
  /** Slates recorded in-window, and the distinct ET days they span. */
  slates: number;
  days: number;
  firstSlateAt: string | null;
  lastSlateAt: string | null;
  /** Verdict counts summed over every in-window slate — the cohort denominator. */
  counts: ExpectancyVerdictCounts;
  /** Share of scored ideas the gate would have dropped, null when nothing scored. */
  dropRate: number | null;
  /** Cohort expectancy statistics, slate-weighted over priced entries. */
  stats: ExpectancyStats;
  byStrategy: Record<string, ExpectancyVerdictCounts>;
  dropCodes: Partial<Record<ExpectancyDropCode, number>>;
  /** Config the most recent slate was scored under, or null when none recorded. */
  config: IdeaExpectancyShadow['config'] | null;
  /** Per-slate tail, oldest→newest (bounded). */
  recent: ExpectancyShadowSlateRecord[];
  /** TRA-1681 — a wiped DATA_DIR must never read as a quiet gate. */
  durability: { dataDir: string | null; ephemeral: boolean };
}

function addCounts(into: ExpectancyVerdictCounts, from: ExpectancyVerdictCounts): void {
  into.total += from.total;
  into.admit += from.admit;
  into.drop += from.drop;
  into.parked += from.parked;
  into.unpriced += from.unpriced;
  into.notCredit += from.notCredit;
}

/**
 * Fold the store into the read-only cohort rollup. Pure — no IO. `enabled` is read
 * from the environment at call time so a flag flip is visible on the next read
 * without a restart of this module's state.
 *
 * The window is applied on ET day so the cohort matches the sessions QuantTrader
 * grades. Statistics are weighted by PRICED entries (each slate contributes its own
 * `stats.n`), which keeps a one-idea slate from carrying the same weight as a full one.
 */
export function summarizeOptionsIdeasExpectancy(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): OptionsIdeasExpectancySummary {
  const enabled = resolveExpectancyGateConfig(env) != null;
  const cutoff = nowMs - EXPECTANCY_LEDGER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inWindow = slates.filter((s) => s.ts >= cutoff);

  const counts = emptyCounts();
  const byStrategy: Record<string, ExpectancyVerdictCounts> = {};
  const dropCodes: Partial<Record<ExpectancyDropCode, number>> = {};
  let pricedN = 0;
  let erSum = 0;
  let cwSum = 0;
  let bwSum = 0;
  let popSum = 0;
  let erMin: number | null = null;
  let erMax: number | null = null;

  for (const s of inWindow) {
    addCounts(counts, s.counts);
    for (const [strategy, c] of Object.entries(s.byStrategy)) {
      addCounts((byStrategy[strategy] ??= emptyCounts()), c);
    }
    for (const [code, n] of Object.entries(s.dropCodes)) {
      const key = code as ExpectancyDropCode;
      dropCodes[key] = (dropCodes[key] ?? 0) + (n ?? 0);
    }
    const st = s.stats;
    if (st.n > 0) {
      pricedN += st.n;
      if (st.meanExpectancyR != null) erSum += st.meanExpectancyR * st.n;
      if (st.meanCreditWidth != null) cwSum += st.meanCreditWidth * st.n;
      if (st.meanBreakevenCreditWidth != null) bwSum += st.meanBreakevenCreditWidth * st.n;
      if (st.meanPopUsed != null) popSum += st.meanPopUsed * st.n;
      if (st.minExpectancyR != null) erMin = erMin == null ? st.minExpectancyR : Math.min(erMin, st.minExpectancyR);
      if (st.maxExpectancyR != null) erMax = erMax == null ? st.maxExpectancyR : Math.max(erMax, st.maxExpectancyR);
    }
  }

  // Drop rate is taken over the SCORED credit cohort: out-of-scope debit families
  // and unpriced data gaps are not evidence either way about the expectancy leak.
  const scored = counts.admit + counts.drop + counts.parked;

  return {
    enabled,
    flag: EXPECTANCY_GATE_ENABLE_VAR,
    windowDays: EXPECTANCY_LEDGER_WINDOW_DAYS,
    slates: inWindow.length,
    days: new Set(inWindow.map((s) => s.etDay)).size,
    firstSlateAt: inWindow[0]?.generatedAt ?? null,
    lastSlateAt: inWindow[inWindow.length - 1]?.generatedAt ?? null,
    counts,
    dropRate: scored > 0 ? counts.drop / scored : null,
    stats: {
      n: pricedN,
      meanExpectancyR: pricedN > 0 ? erSum / pricedN : null,
      minExpectancyR: erMin,
      maxExpectancyR: erMax,
      meanCreditWidth: pricedN > 0 ? cwSum / pricedN : null,
      meanBreakevenCreditWidth: pricedN > 0 ? bwSum / pricedN : null,
      meanPopUsed: pricedN > 0 ? popSum / pricedN : null,
    },
    byStrategy,
    dropCodes,
    config: inWindow[inWindow.length - 1]?.config ?? null,
    recent: inWindow.slice(-MAX_RECENT_SLATES),
    durability: { dataDir, ephemeral: isEphemeralDataDir(dataDir) },
  };
}
