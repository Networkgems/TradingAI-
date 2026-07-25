// TRA-2134 (parent TRA-2125 → foundation TRA-2130) — DURABLE multi-strategy SANDBOX
// options data-gathering journal.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-2130 gave us a one-shot no-auth route (`POST
// /api/health/tradier-sandbox/options-smoke-order`) that round-trips a single ATM
// call + put in the Tradier sandbox and returns the full
// `signal → submit → ack → fill` timeline + slippage — but it deliberately BYPASSES
// every local journal: "the fills are recorded ONLY in the Tradier sandbox account."
// That is fine for a smoke test and useless for a STANDING learning program. A
// scheduled runner that fires the route every session leaves nothing a grader can
// read: the sandbox account history is not a no-auth `/api/health/*` surface, and
// bqb1 admin auth is dead (TRA-1992).
//
// So: land every round-trip here, durably, keyed by strategy, so the program accrues
// a graded-able series (QuantTrader sets which strategies graduate to forward-val).
//
// ── DURABILITY ───────────────────────────────────────────────────────────────
// JSONL under DATA_DIR, rebuilt on boot, compacted to RETAIN_MS. In-memory
// since-boot counts are NOT enough: bqb1 reboots daily (TRA-1564 B1 / TRA-1719), so a
// post-session read would see `{}` for a program that in fact ran for weeks. The
// health payload carries `durability.ephemeral` (TRA-1681) so a reader can tell a
// real persistent mount (`DATA_DIR=/data`) from the in-bundle fallback that silently
// evaporates on redeploy — the exact trap that pins counters at 0 forever.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// SANDBOX ONLY (acct VA20296703), $0 real notional. This module NEVER places an
// order or resolves a credential — it only RECORDS what the round-trip orchestrator
// (`tradier-sandbox-options-smoke.ts`) already produced. It is a pure sink + a pure
// summarizer, mirroring the shape of `entry-greeks-ledger.ts`.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import type { SmokeContractResult, SmokeLegResult } from './tradier-sandbox-options-smoke.js';

const log = logger.child({ module: 'sandbox-strategy-journal' });

export const SANDBOX_STRATEGY_LOG_FILENAME = 'sandbox-strategy-journal.jsonl';

/**
 * Retain this many ms of records on disk (compacted on boot). This is a STANDING
 * learning program, not a same-day gate — the series must survive weeks of daily
 * reboots so QuantTrader can grade data quality across strategies. 60 days.
 */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Per-TRA-2130 acceptance: our internal decision→submit latency must be under this.
 * A round-trip is only "clean AND in budget" when EVERY leg's `signalToSubmitMs`
 * clears it (a sandbox fill that took 900ms to leave our process is a plumbing
 * defect regardless of the broker's simulated fill).
 */
export const SIGNAL_TO_SUBMIT_BUDGET_MS = 500;

/**
 * Strategy tags. Kept as an OPEN string on the wire (adapters land incrementally,
 * gated behind flags — Tier-1 CSP/covered-call, Tier-2 verticals, Tier-3
 * straddles/calendars) but the Tier-1 long single-legs TRA-2130 already produces are
 * named here so the summary never blends an unknown tag into a known bucket.
 */
export type SandboxStrategy =
  | 'long_call'
  | 'long_put'
  | (string & {});

/** Derive the strategy tag for a single-leg long round-trip (TRA-2130's two outputs). */
export function longStrategyFor(optionType: 'call' | 'put'): SandboxStrategy {
  return optionType === 'call' ? 'long_call' : 'long_put';
}

/**
 * Derive the strategy tag for a TRA-2134 Tier-1 short round-trip:
 * - short put → 'csp' (cash-secured put)
 * - short call → 'covered_call'
 */
export function shortStrategyFor(optionType: 'call' | 'put'): SandboxStrategy {
  return optionType === 'call' ? 'covered_call' : 'csp';
}

/** One leg of a recorded round-trip — exactly the fields TRA-2134 acceptance names. */
export interface SandboxStrategyLeg {
  side: 'buy' | 'sell';
  optionSymbol: string | null;
  /** Wall-clock ms the order left our process. */
  submitTs: number;
  /** Wall-clock ms the leg reached a terminal (filled) status; `null` if it never did. */
  fillTs: number | null;
  /** Our internal decision→submit latency (the number TRA-2130 budgets at <500ms). */
  signalToSubmitMs: number;
  /** Decision-quote mid we anchored slippage to (the MARK); `null` on a one-sided quote. */
  requestedPx: number | null;
  /**
   * Decision-quote BID at submit time; `null` when the snap had no usable bid.
   * TRA-2283 D2 — persisted so the marketable(bid) MTM gate can measure its half-spread
   * off the QUOTED BOOK instead of off the fill. The quote is REAL even when the fill is
   * broker-simulated (`SANDBOX_SIMULATED`), which is the only reason that gate is
   * falsifiable on this venue at all: the sandbox fills at the decision mid, so a
   * fill-derived half-spread is ~0 by construction whatever the true spread is.
   */
  bid: number | null;
  /** Decision-quote ASK at submit time; `null` when the snap had no usable ask. TRA-2283 D2. */
  ask: number | null;
  /** Broker avg fill price; `null` if the leg never filled AT A USABLE PRICE (see mapLeg). */
  fillPx: number | null;
  /** `(fill − mid)/mid × 10_000`; `null` when either side is unprovable (NOT 0). */
  slippageBps: number | null;
  /** Decision-quote spread as a % of mid; `null` on a one-sided quote. */
  spreadAtSubmitPct: number | null;
  /** Fill inside `[bid, ask]` at the decision quote; `null` when unprovable. */
  withinSpread: boolean | null;
}

/** One durable round-trip record. */
export interface SandboxStrategyRecord {
  /** Record time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the program rolls on. */
  etDay: string;
  strategy: SandboxStrategy;
  underlying: string;
  /** True ⇒ every enabled leg filled with a usable fill price (a CLEAN round-trip). */
  ok: boolean;
  /** `(exitFill − entryFill) × 100 × qty − modeledCommission`; `null` if a fill is missing. */
  realizedRoundTripUsd: number | null;
  legs: SandboxStrategyLeg[];
}

// ── pure mapping from the TRA-2130 orchestrator output ───────────────────────

/**
 * A broker `avg_fill_price` of `0` (or negative) is NOT a price — it is a MISSING price
 * wearing a number's clothes, and it must be recorded as `null`.
 *
 * ── TRA-2283 D1: the decision, and why a `0` is never a legitimate record here ──
 * The question raised was whether a genuine worthless expiry should be booked as
 * `fillPx: 0`. It should not, and on this journal the case cannot even arise: every
 * record is a same-session OPEN→CLOSE round-trip driven by
 * `tradier-sandbox-options-smoke.ts` (entry leg then exit leg, minutes apart, TRA-2130 /
 * TRA-2134) — there is no hold-to-expiry path that could write a leg here at all. So a `0`
 * on this surface is always the broker failing to report a fill price on an order we
 * nonetheless read as terminal.
 *
 * And a `0` is not a harmless placeholder, because downstream consumers divide by the
 * mid: `actualH = (requestedPx − fillPx)/requestedPx` evaluates to EXACTLY ±1 — a 100%
 * half-spread — from a contract that in fact traded near its mid. Four such rows (13% of a
 * 30-record corpus) were enough to move each structure's mean `actualH` to ±0.13 and to
 * manufacture a 2.8× tail under-charge in the marketable-MTM forward-validation gate, while
 * pooling hid the whole thing at ~0.0026. The same false zero also produced the
 * `meanSlippageBps ≈ −1262 / −1251 / −1418 / −1443` readings on this route's own summary
 * (a single `0`-fill leg scores −10_000bps and drags the per-strategy mean).
 *
 * Even were an expiry ever recorded here, the honest record is an UNFILLED leg
 * (`fillPx: null`, `fillTs: null`) — the position was never sold, so no fill price exists.
 * `null` is exactly the "unprovable, therefore EXCLUDED" signal every reader of this
 * journal already handles; `0` is a value they are obliged to believe.
 *
 * NOTE this repairs the WRITER, so it applies to records booked from here on. Records
 * already on the `/data` disk keep their `0`s, which is why
 * `marketable-mtm-forward-validation.ts` ALSO guards `fillPx <= 0` on the read side and
 * reports the drop as `excludedZeroFill`.
 */
function usableFillPrice(avgFillPrice: number | null): number | null {
  return avgFillPrice != null && Number.isFinite(avgFillPrice) && avgFillPrice > 0
    ? avgFillPrice
    : null;
}

function mapLeg(leg: SmokeLegResult): SandboxStrategyLeg {
  const { decisionQuote, timeline, metrics } = leg;
  const mid = decisionQuote.mid;
  const fillPx = usableFillPrice(leg.avgFillPrice);
  // Recompute slippage from the SANITIZED fill rather than trusting `metrics.slippage`:
  // a false-zero fill would otherwise land here as a −10_000bps outlier (see above).
  const fillMinusMid = fillPx != null && mid != null ? fillPx - mid : null;
  const slippageBps =
    fillMinusMid != null && mid != null && mid > 0 ? (fillMinusMid / mid) * 10_000 : null;
  const spreadAtSubmitPct =
    decisionQuote.spreadBps != null ? decisionQuote.spreadBps / 100 : null;
  return {
    side: leg.side,
    optionSymbol: null, // filled by the record mapper (the symbol lives on the contract, not the leg)
    submitTs: timeline.tSubmit,
    fillTs: timeline.tFill,
    signalToSubmitMs: metrics.latencyMs.signalToSubmit,
    requestedPx: mid,
    bid: decisionQuote.bid,
    ask: decisionQuote.ask,
    fillPx,
    slippageBps: slippageBps != null ? Math.round(slippageBps * 100) / 100 : null,
    spreadAtSubmitPct: spreadAtSubmitPct != null ? Math.round(spreadAtSubmitPct * 10000) / 10000 : null,
    // An unusable fill cannot be shown to be inside the quoted spread — `null`, not `false`.
    withinSpread: fillPx != null ? metrics.withinSpread : null,
  };
}

/**
 * Build a durable record from one TRA-2130 `SmokeContractResult`. Pure: `etDay` and
 * `now` are passed in. Returns `null` when the round-trip never even built a contract
 * (no expiry in window / no chain / no ref price) — there is no leg to record and a
 * synthetic "empty" row would poison the per-strategy clean-count. The caller logs
 * the skip reason; only ROUND-TRIPS-THAT-RAN land in the journal.
 */
export function recordFromContractResult(
  strategy: SandboxStrategy,
  result: SmokeContractResult,
  etDay: string,
  now: number = Date.now(),
): SandboxStrategyRecord | null {
  if (!result.entry || !result.exit) return null;
  const optionSymbol = result.contract?.optionSymbol ?? null;
  const legs = [mapLeg(result.entry), mapLeg(result.exit)].map((l) => ({ ...l, optionSymbol }));
  return {
    ts: now,
    etDay,
    strategy,
    underlying: result.underlying,
    ok: result.ok,
    realizedRoundTripUsd: result.realizedRoundTripUsd,
    legs,
  };
}

// ── in-memory store (backs the durable counts + the health endpoint) ─────────

let dataDir: string | null = null;
const records: SandboxStrategyRecord[] = [];
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedRecords = 0;

export function sandboxStrategyLogPath(dir: string): string {
  return join(dir, SANDBOX_STRATEGY_LOG_FILENAME);
}

/**
 * Read-only view of the in-memory series (append + hydrate order = chronological).
 * TRA-2237's parity-reconcile monitor folds these SAME records into a demo-mark-vs-
 * sandbox-fill P&L-gap observable — it reads the journal, never a new order stream.
 * Returned as `readonly` so a consumer cannot mutate the live store.
 */
export function getSandboxStrategyRecords(): readonly SandboxStrategyRecord[] {
  return records;
}

/** Test seam — drop every counter and the configured dir. */
export function clearSandboxStrategyJournal(): void {
  dataDir = null;
  records.length = 0;
  appendErrors = 0;
  lastAppendError = null;
  hydratedRecords = 0;
}

function isValidRecord(rec: unknown): rec is SandboxStrategyRecord {
  if (rec == null || typeof rec !== 'object') return false;
  const r = rec as Record<string, unknown>;
  return (
    typeof r.ts === 'number' &&
    Number.isFinite(r.ts) &&
    typeof r.etDay === 'string' &&
    r.etDay !== '' &&
    typeof r.strategy === 'string' &&
    typeof r.underlying === 'string' &&
    typeof r.ok === 'boolean' &&
    Array.isArray(r.legs)
  );
}

/**
 * Append one round-trip record to the durable journal AND the in-memory series.
 * Best-effort on IO: a write failure is counted + logged, never thrown (this
 * accounting must never break the round-trip route). With no dataDir configured
 * (unit tests / boot not run) the in-memory series still updates; only the file
 * write is skipped.
 */
export function recordSandboxStrategy(rec: SandboxStrategyRecord): void {
  records.push(rec);
  if (dataDir == null) return;
  const path = sandboxStrategyLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('sandbox strategy record append failed', { reason: lastAppendError });
  }
}

/** What {@link hydrateSandboxStrategyJournalFromDisk} recovered (for the boot log line). */
export interface SandboxStrategyHydration {
  records: number;
  strategies: number;
}

/**
 * Rebuild the in-memory series from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first. Only records within {@link RETAIN_MS} of `now`
 * are kept, and the file is COMPACTED to exactly those lines. Best-effort: a missing
 * or corrupt file yields an empty hydration; a torn trailing line is skipped.
 */
export function hydrateSandboxStrategyJournalFromDisk(
  dir: string,
  now: number = Date.now(),
): SandboxStrategyHydration {
  clearSandboxStrategyJournal();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(sandboxStrategyLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  const strategies = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial line
    }
    if (!isValidRecord(rec)) continue;
    if (rec.ts < cutoff) continue;
    records.push(rec);
    strategies.add(rec.strategy);
    kept.push(JSON.stringify(rec));
  }
  hydratedRecords = records.length;

  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = sandboxStrategyLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('sandbox strategy journal compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { records: hydratedRecords, strategies: strategies.size };
}

// ── health summary ───────────────────────────────────────────────────────────

export interface SandboxStrategySummaryEntry {
  /** Round-trips recorded for this strategy (that actually ran — see mapper). */
  total: number;
  /** Round-trips where every enabled leg filled with a usable fill price. */
  clean: number;
  /**
   * CLEAN round-trips whose every leg also cleared the {@link SIGNAL_TO_SUBMIT_BUDGET_MS}
   * budget — the exact TRA-2134 acceptance unit ("≥1 clean round-trip ... signalToSubmit < 500ms").
   */
  cleanWithinLatencyBudget: number;
  /** True ⇔ `cleanWithinLatencyBudget ≥ 1` — this strategy's acceptance is met. */
  acceptanceMet: boolean;
  /** Worst (max) `signalToSubmitMs` across all legs of all recorded round-trips; `null` if none. */
  maxSignalToSubmitMs: number | null;
  /** Mean slippage in bps across legs that recorded a finite slippage; `null` if none. */
  meanSlippageBps: number | null;
  /** ms epoch of the most recent record; `null` if none. */
  lastTs: number | null;
  /** `ok` of the most recent record; `null` if none. */
  lastOk: boolean | null;
}

export interface SandboxStrategyJournalSummary {
  totalRecords: number;
  strategies: Record<string, SandboxStrategySummaryEntry>;
  retentionDays: number;
  signalToSubmitBudgetMs: number;
  durability: {
    dataDir: string | null;
    ephemeral: boolean;
    hydratedRecords: number;
    appendErrors: number;
    lastAppendError: string | null;
  };
}

/** True ⇔ every leg of this round-trip cleared the signal→submit latency budget. */
function withinLatencyBudget(rec: SandboxStrategyRecord): boolean {
  return rec.legs.length > 0 && rec.legs.every((l) => l.signalToSubmitMs < SIGNAL_TO_SUBMIT_BUDGET_MS);
}

/**
 * Fold the durable series into read-only health diagnostics. Pure — no IO. Groups by
 * `strategy` and reports, per strategy, the acceptance-unit counts + latency/slippage
 * quality. A strategy with `total > 0` but `acceptanceMet: false` is the tell that the
 * runner fired but never produced a clean, in-budget round-trip — do NOT read that the
 * same as "strategy not enabled" (which is simply absent from the map).
 */
export function summarizeSandboxStrategyJournal(): SandboxStrategyJournalSummary {
  const byStrategy = new Map<string, SandboxStrategyRecord[]>();
  for (const rec of records) {
    const list = byStrategy.get(rec.strategy) ?? [];
    list.push(rec);
    byStrategy.set(rec.strategy, list);
  }

  const strategies: Record<string, SandboxStrategySummaryEntry> = {};
  for (const [strategy, list] of byStrategy.entries()) {
    let clean = 0;
    let cleanWithinLatencyBudget = 0;
    let maxSignalToSubmitMs: number | null = null;
    let slipSum = 0;
    let slipN = 0;
    for (const rec of list) {
      if (rec.ok) {
        clean += 1;
        if (withinLatencyBudget(rec)) cleanWithinLatencyBudget += 1;
      }
      for (const leg of rec.legs) {
        if (maxSignalToSubmitMs == null || leg.signalToSubmitMs > maxSignalToSubmitMs) {
          maxSignalToSubmitMs = leg.signalToSubmitMs;
        }
        if (leg.slippageBps != null && Number.isFinite(leg.slippageBps)) {
          slipSum += leg.slippageBps;
          slipN += 1;
        }
      }
    }
    // list follows insertion order (append + hydrate both push chronologically).
    const last = list[list.length - 1];
    strategies[strategy] = {
      total: list.length,
      clean,
      cleanWithinLatencyBudget,
      acceptanceMet: cleanWithinLatencyBudget >= 1,
      maxSignalToSubmitMs,
      meanSlippageBps: slipN > 0 ? Math.round((slipSum / slipN) * 100) / 100 : null,
      lastTs: last?.ts ?? null,
      lastOk: last?.ok ?? null,
    };
  }

  return {
    totalRecords: records.length,
    strategies,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    signalToSubmitBudgetMs: SIGNAL_TO_SUBMIT_BUDGET_MS,
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      appendErrors,
      lastAppendError,
    },
  };
}
