// TRA-2208 (child of TRA-1965) — durable PRE-FLOOR ledger + rollup for the hard
// credit/width floor on the AI Options Ideas emission path.
//
// WHAT THIS ANSWERS. "How much of the current book would a 0.20 credit/width floor
// have removed?" — the number the Lead Quant asked for, and the one the TRA-1965
// CUT/continue fork turns on. The floor itself DROPS the failing ideas inside
// `options-research.ts`; without this reader the drop would be invisible, and the
// slate would just quietly get shorter. `options-ideas-expectancy-ledger.ts` exists
// because exactly that happened to the TRA-2005 shadow gate — a producer with no
// reader, unobservable by construction. This is the reader, written up-front.
//
// TWO SURVIVAL RATES, DELIBERATELY. This ledger measures the FORWARD book: what the
// model proposes once the prompt states the floor and the band. The decomposition
// probe's `creditWidthFloor` cell (`options-forward-test.ts`) measures the REALIZED
// book: what the ideas we already traded actually collected. The forward number is
// the one that decides whether a floored engine can still surface anything; the
// realized number is available today and needs no deploy. Read both — if the
// forward rate is high while the realized rate is ~0, the prompt contract is doing
// the work, which is the outcome the change is trying to produce.
//
// WHAT IS PERSISTED. Same redaction boundary as the sibling ledger: the probe is
// NO-AUTH on bqb1 (QuantTrader has no session there — that is why TRA-2004 needed a
// public probe), so a row carries verdict COUNTS, the config, aggregate credit/width
// statistics and per-structure-FAMILY counts. Deliberately NOT persisted: tickers,
// per-idea reason text, and any P&L.
//
// ONE ROW PER FRESH SLATE, and DURABLE BECAUSE bqb1 REBOOTS — both for the same
// reasons as the expectancy ledger: a batch-cache hit re-serves the SAME result
// object off the panel's 60s poll, and an in-memory since-boot counter reads empty
// by the time a post-close grade fires.
//
// SHADOW-adjacent, not shadow. Unlike the TRA-2005 ledger this records a floor that
// REALLY ACTED when its flag is on. It still wires no capital and touches no live
// routing: the only effect is that a below-floor credit idea is not surfaced.

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  resolveCreditWidthFloorConfig,
  resolveCreditWidthFloorConfigFromEnv,
  CREDIT_WIDTH_FLOOR_ENABLE_VAR,
  type CreditWidthFloorConfig,
  type CreditWidthFloorShadow,
  type CreditWidthVerdict,
} from '@trading-app/agents';
import { logger } from './observability/index.js';
import { timeSyncPhase } from './phase-timing.js';
import { etDateKey } from './options-chain-recorder.js';
import { isEphemeralDataDir } from './data-dir.js';

const log = logger.child({ module: 'options-ideas-credit-width-ledger' });

export const OPTIONS_IDEAS_CREDIT_WIDTH_LOG_FILENAME = 'options-ideas-credit-width-floor.jsonl';

/** Rolling window the rollup reports over — long enough to hold a verdict cohort. */
export const CREDIT_WIDTH_LEDGER_WINDOW_DAYS = 30;

/** Bounded tail kept in memory for the health view (counts stay complete). */
const MAX_RECENT_SLATES = 60;

/** Verdict counts — the same shape the floor rolls up, reused per slice. */
export interface CreditWidthCounts {
  /** Every idea the model proposed, all families. */
  total: number;
  /** Credit verticals the floor governs (`pass + reject + unpriced`). */
  credit: number;
  pass: number;
  reject: number;
  unpriced: number;
  notCredit: number;
}

/** Aggregate credit/width statistics over the PRICED credit entries of a slice. */
export interface CreditWidthStats {
  /** Priced credit entries the statistics are taken over. */
  priced: number;
  /** Mean PRE-floor credit/width — the 0.03 the diagnosis is built on. */
  meanCreditWidth: number | null;
  minCreditWidth: number | null;
  maxCreditWidth: number | null;
  /** Credit ideas that reported a short-leg delta at all. */
  deltaReported: number;
  /** Of those, how many landed inside the stated band. */
  deltaInBand: number;
}

/** One persisted slate — the floor verdicts over one freshly researched feed. */
export interface CreditWidthSlateRecord {
  /** Slate build time, ms epoch. */
  ts: number;
  /** Same instant, ISO-8601. */
  generatedAt: string;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the rollup windows on. */
  etDay: string;
  counts: CreditWidthCounts;
  /** Resolved floor config the verdicts were scored under (audit reproducibility). */
  config: CreditWidthFloorConfig;
  stats: CreditWidthStats;
  /** Verdict counts by structure FAMILY (e.g. bull_put_spread) — no tickers. */
  byStrategy: Record<string, CreditWidthCounts>;
}

// ── In-memory store ──────────────────────────────────────────────────────────

let dataDir: string | null = null;
const slates: CreditWidthSlateRecord[] = [];

export function optionsIdeasCreditWidthLogPath(dir: string): string {
  return join(dir, OPTIONS_IDEAS_CREDIT_WIDTH_LOG_FILENAME);
}

/** Test seam — drop every slate and the configured dir. */
export function clearOptionsIdeasCreditWidthLedger(): void {
  dataDir = null;
  slates.length = 0;
}

function emptyCounts(): CreditWidthCounts {
  return { total: 0, credit: 0, pass: 0, reject: 0, unpriced: 0, notCredit: 0 };
}

/** Fold one entry's verdict into a counts bucket. */
function tally(into: CreditWidthCounts, verdict: CreditWidthVerdict): void {
  into.total += 1;
  if (verdict === 'not_credit') {
    into.notCredit += 1;
    return;
  }
  into.credit += 1;
  if (verdict === 'pass') into.pass += 1;
  else if (verdict === 'reject') into.reject += 1;
  else if (verdict === 'unpriced') into.unpriced += 1;
}

/**
 * Reduce one pre-floor ledger to its DURABLE aggregate row. Pure. This is the
 * redaction boundary: per-idea tickers and reason strings are read here and
 * deliberately do not survive into the record.
 */
export function summarizeCreditWidthSlate(
  shadow: CreditWidthFloorShadow,
  generatedAtMs: number,
): CreditWidthSlateRecord {
  const byStrategy: Record<string, CreditWidthCounts> = {};
  for (const entry of shadow.entries) {
    tally((byStrategy[entry.strategy] ??= emptyCounts()), entry.result.verdict);
  }
  return {
    ts: generatedAtMs,
    generatedAt: new Date(generatedAtMs).toISOString(),
    etDay: etDateKey(generatedAtMs),
    counts: { ...shadow.counts },
    config: { ...shadow.config },
    stats: { ...shadow.stats },
    byStrategy,
  };
}

/** Fold one slate into the in-memory tail (no IO). */
function applySlate(rec: CreditWidthSlateRecord): void {
  slates.push(rec);
  while (slates.length > MAX_RECENT_SLATES) slates.shift();
}

/**
 * Record one freshly-researched slate's floor verdicts: update the in-memory store
 * AND append one JSONL line under the configured DATA_DIR. Best-effort on IO — a
 * write failure logs and is swallowed so this accounting can never break the ideas
 * feed. With no dataDir configured (unit tests / CLI without boot) the in-memory
 * rollup still updates; only the file write is skipped.
 *
 * Call ONLY on a non-cached research pass — see the header on duplicate slates.
 */
export function recordCreditWidthSlate(
  shadow: CreditWidthFloorShadow,
  generatedAtMs: number,
): CreditWidthSlateRecord {
  const rec = summarizeCreditWidthSlate(shadow, generatedAtMs);
  applySlate(rec);
  if (dataDir == null) return rec;
  const path = optionsIdeasCreditWidthLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('options-ideas credit-width slate append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return rec;
}

/** What {@link hydrateOptionsIdeasCreditWidthFromDisk} recovered (for the boot log). */
export interface OptionsIdeasCreditWidthHydration {
  slates: number;
  days: number;
}

/**
 * Rebuild the in-memory rollup from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup.
 * Best-effort — a missing/corrupt file yields an empty hydration (and a torn
 * trailing line is skipped) rather than throwing.
 */
export function hydrateOptionsIdeasCreditWidthFromDisk(
  dir: string,
): OptionsIdeasCreditWidthHydration {
  clearOptionsIdeasCreditWidthLedger();
  dataDir = dir;
  // TRA-1463 — boot-hydrate synchronous read+parse; wrap so a stall here is NAMED
  // in the watchdog trip breadcrumb (`slowPhase`).
  return timeSyncPhase('hydrate.optionsIdeasCreditWidth', () => {
    let raw = '';
    try {
      raw = readFileSync(optionsIdeasCreditWidthLogPath(dir), 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as CreditWidthSlateRecord;
        if (typeof rec.ts === 'number' && rec.counts != null) applySlate(rec);
      } catch {
        // skip a torn/partial trailing line rather than abort the hydrate
      }
    }
    return { slates: slates.length, days: new Set(slates.map((s) => s.etDay)).size };
  });
}

// ── Health rollup ────────────────────────────────────────────────────────────

/** The cohort rollup `GET /api/health/options-ideas-credit-width` returns. */
export interface OptionsIdeasCreditWidthSummary {
  /**
   * Whether the floor is currently ENFORCING (and therefore recording). OFF skips
   * the pass entirely, so `enabled:false` + `slates:0` means "nothing was recorded",
   * NOT "nothing was rejected" — the same distinction whose absence hid the TRA-2199
   * defect. Read it before reading `survivalRate`.
   */
  enabled: boolean;
  /** The env var `enabled` reflects, named so a reader can act on it without grep. */
  flag: string;
  /** Rolling window the rollup covers, in ET days. */
  windowDays: number;
  slates: number;
  days: number;
  firstSlateAt: string | null;
  lastSlateAt: string | null;
  /** Verdict counts summed over every in-window slate — the cohort denominator. */
  counts: CreditWidthCounts;
  /**
   * THE FORK NUMBER: `pass / credit` over the whole in-window cohort — the share of
   * the proposed credit book that clears the floor. Null when no credit idea was
   * proposed at all (an honest "no basis", never a 0 or 1 that reads as a
   * measurement). `unpriced` sits in the denominator: a credit idea that refuses to
   * price itself did not survive, and excluding it would flatter the rate.
   *
   * A LOW RATE IS A VALID RESULT, not a signal to lower the floor. It says our
   * universe/IV regime does not offer sellable premium at our cost base — which is
   * the CUT signal on TRA-1965.
   */
  survivalRate: number | null;
  /** Cohort credit/width statistics, weighted by priced entries per slate. */
  stats: CreditWidthStats;
  byStrategy: Record<string, CreditWidthCounts>;
  /** Config the most recent slate was scored under, or null when none recorded. */
  config: CreditWidthFloorConfig | null;
  /**
   * TRA-2680 — the config the NEXT slate would be scored under, resolved from env
   * on every read and INDEPENDENT of {@link enabled}. Never null.
   *
   * `config` above is a HISTORICAL record: it is `null` until a slate has actually
   * been scored, which cannot happen until the floor is armed — and by then it has
   * already gated ideas under whatever value was live. That left the one thing worth
   * auditing (has an undeclared env override moved the floor?) checkable only on the
   * single beat it stopped mattering. This field is the same numbers, readable
   * BEFORE anything is gated, so the audit is a precondition rather than a postmortem.
   *
   * TRA-2217 is why it matters: the floor is DERIVED from the resolved band bottom,
   * so `OPTIONS_IDEA_SHORT_DELTA_MIN` silently moves it. That var is not declared in
   * the blueprint, so `/api/health/env-drift` (declared keys only) cannot see it.
   *
   * READING IT: on stock config this is `{0.20, 0.20, 0.30}`. Any other value means
   * an undeclared override is live. Compare against the module defaults, NOT against
   * `pendingConfig.shortDeltaMin` — `minCreditWidth === shortDeltaMin` is merely
   * today's DEFAULTING RULE, so an equality check passes just as happily when an
   * override has moved BOTH, and would have to be retracted the moment the derivation
   * is corrected (TRA-2681). Equality proves the fallback fired; it proves nothing
   * about the value.
   *
   * When `enabled` is true, a `pendingConfig` that differs from `config` means env
   * changed after the last slate was scored.
   */
  pendingConfig: CreditWidthFloorConfig;
  /** Per-slate tail, oldest→newest (bounded). */
  recent: CreditWidthSlateRecord[];
  /** TRA-1681 — a wiped DATA_DIR must never read as a quiet floor. */
  durability: { dataDir: string | null; ephemeral: boolean };
}

function addCounts(into: CreditWidthCounts, from: CreditWidthCounts): void {
  into.total += from.total;
  into.credit += from.credit;
  into.pass += from.pass;
  into.reject += from.reject;
  into.unpriced += from.unpriced;
  into.notCredit += from.notCredit;
}

/**
 * Fold the store into the read-only cohort rollup. Pure — no IO. `enabled` is read
 * from the environment at call time so a flag flip is visible on the next read
 * without a restart of this module's state. Statistics are weighted by PRICED
 * entries so a one-idea slate cannot carry the same weight as a full one.
 */
export function summarizeOptionsIdeasCreditWidth(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): OptionsIdeasCreditWidthSummary {
  const enabled = resolveCreditWidthFloorConfig(env) != null;
  const cutoff = nowMs - CREDIT_WIDTH_LEDGER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inWindow = slates.filter((s) => s.ts >= cutoff);

  const counts = emptyCounts();
  const byStrategy: Record<string, CreditWidthCounts> = {};
  let pricedN = 0;
  let cwSum = 0;
  let deltaReported = 0;
  let deltaInBand = 0;
  let cwMin: number | null = null;
  let cwMax: number | null = null;

  for (const s of inWindow) {
    addCounts(counts, s.counts);
    for (const [strategy, c] of Object.entries(s.byStrategy)) {
      addCounts((byStrategy[strategy] ??= emptyCounts()), c);
    }
    const st = s.stats;
    deltaReported += st.deltaReported ?? 0;
    deltaInBand += st.deltaInBand ?? 0;
    if (st.priced > 0) {
      pricedN += st.priced;
      if (st.meanCreditWidth != null) cwSum += st.meanCreditWidth * st.priced;
      if (st.minCreditWidth != null) cwMin = cwMin == null ? st.minCreditWidth : Math.min(cwMin, st.minCreditWidth);
      if (st.maxCreditWidth != null) cwMax = cwMax == null ? st.maxCreditWidth : Math.max(cwMax, st.maxCreditWidth);
    }
  }

  return {
    enabled,
    flag: CREDIT_WIDTH_FLOOR_ENABLE_VAR,
    windowDays: CREDIT_WIDTH_LEDGER_WINDOW_DAYS,
    slates: inWindow.length,
    days: new Set(inWindow.map((s) => s.etDay)).size,
    firstSlateAt: inWindow[0]?.generatedAt ?? null,
    lastSlateAt: inWindow[inWindow.length - 1]?.generatedAt ?? null,
    counts,
    survivalRate: counts.credit > 0 ? counts.pass / counts.credit : null,
    stats: {
      priced: pricedN,
      meanCreditWidth: pricedN > 0 ? cwSum / pricedN : null,
      minCreditWidth: cwMin,
      maxCreditWidth: cwMax,
      deltaReported,
      deltaInBand,
    },
    byStrategy,
    config: inWindow[inWindow.length - 1]?.config ?? null,
    pendingConfig: resolveCreditWidthFloorConfigFromEnv(env),
    recent: inWindow.slice(-MAX_RECENT_SLATES),
    durability: { dataDir, ephemeral: isEphemeralDataDir(dataDir) },
  };
}
