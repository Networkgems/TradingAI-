/**
 * TRA-3010 — durable record of every engine-basis restatement (TRA-2889).
 *
 * Gate A of TRA-2873 has to prove that the restatement moved an engine-opened
 * row's `premiumPaid` to broker truth and carried its risk schedule across. The
 * evidence is destroyed the instant it is produced:
 *
 *   • `restateEngineOpenedBasis` overwrites `premiumPaid` in place, and
 *     `reconcileLivePortfolio` runs on a 30s cadence, so the pre-state survives
 *     for seconds — no external poller can be relied on to catch it;
 *   • the thresholds are RESCALED, so `stopLossPremium / premiumPaid` reads the
 *     same constant before and after. A post-hoc read of the row is therefore
 *     byte-identical whether the restatement fired or was never wired at all;
 *   • the broker's `cost_basis` is not published by any read-only route.
 *
 * An in-memory buffer is not enough either: bqb1 restarts several times a day
 * and qualifying rows arrive at most ~once a day (the cost bar blocked 313 of
 * 314 evaluations on 2026-08-05), so a process-local ledger would very likely be
 * wiped before anyone read it — and an empty ledger after a restart is
 * indistinguishable from "the restatement never happened". So records go to
 * DATA_DIR as JSONL, the same durability substrate `cost-aware-gate-ledger.ts`
 * uses.
 *
 * Volume is inherently tiny (one line per actual basis correction), so this
 * reads the whole file on demand rather than maintaining a hydrated fold.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

import { logger } from './observability/index.js';

const log = logger.child({ module: 'engine-basis-restatement-log' });

export const ENGINE_BASIS_RESTATEMENT_FILENAME = 'engine-basis-restatements.jsonl';

/**
 * TRA-3896 — WHICH mechanism moved the basis.
 *
 * Both write the same shape, and without this field a reader of the ledger sees
 * "1.41 → 1.65" and cannot tell them apart — which matters enormously, because
 * they mean opposite things:
 *
 *   • `broker_reconcile` — the TRA-2889 sweep restated to Tradier's
 *     `cost_basis / quantity`. On a symbol where the broker's lot is a BLEND,
 *     a record of this kind AFTER TRA-3890 shipped means the `quantity_mismatch`
 *     refusal regressed.
 *   • `recorded_fill_repair` — the TRA-3896 admin repair, sourced from this
 *     engine's OWN `buy_to_open` records. Ordered by a human, once.
 *   • `desk_lot_split` — TRA-3909. The reconcile UNBLENDING a row that had
 *     already absorbed a desk contract: the engine row is shrunk back to the
 *     lot the fill ledger accounts for and restated to that lot's own fill,
 *     and the residual is minted as its own `desk_add` row. Also sourced from
 *     our own records, but written by the reconcile rather than by a human, and
 *     it is the only one of the three whose `contracts` moves as well as its
 *     basis — so a reader must not fold it into `recorded_fill_repair`.
 *
 * Optional because every record written before TRA-3896 carries none of them,
 * and back-filling a guess onto them would be inventing provenance. Absent reads
 * as "pre-TRA-3896, therefore `broker_reconcile`" — the only mechanism that
 * existed.
 */
export type EngineBasisRestatementSource =
  | 'broker_reconcile'
  | 'recorded_fill_repair'
  | 'desk_lot_split';

/** One witnessed restatement: both sides of an edit that is otherwise unobservable. */
export interface EngineBasisRestatementRecord {
  ts: number;
  positionId: string;
  optionSymbol: string;
  contracts: number;
  /** Our pre-restatement basis: the scanner's pre-trade NBBO mid. */
  premiumPaidBefore: number;
  /** Broker truth: Tradier `cost_basis / quantity / 100`. */
  premiumPaidAfter: number;
  ratio: number;
  brokerCostBasisUsd: number;
  /** TRA-3896 — see {@link EngineBasisRestatementSource}. Absent on pre-3896 rows. */
  source?: EngineBasisRestatementSource;
  tp1PremiumBefore: number;
  tp1PremiumAfter: number;
  stopLossPremiumBefore: number;
  stopLossPremiumAfter: number;
  trailingStopPremiumBefore: number;
  trailingStopPremiumAfter: number;
  trailingActive: boolean;
  tp1RatioBefore: number;
  tp1RatioAfter: number;
  stopRatioBefore: number;
  stopRatioAfter: number;
}

/**
 * Appends that threw and were swallowed. A non-zero value means the counters a
 * reader sees are NOT backed by disk — published rather than logged-and-lost,
 * because "no records" and "records we failed to write" grade differently.
 */
let appendErrors = 0;
let lastAppendError: string | null = null;

export function engineBasisRestatementLogPath(dir: string): string {
  return join(dir, ENGINE_BASIS_RESTATEMENT_FILENAME);
}

/**
 * TRA-3846 — the persistence root, bound ONCE at boot by `index.ts` from
 * `resolveDataDir()` (the TRA-522/TRA-2603 guarded resolver; a raw env read
 * here would take a present-but-blank `DATA_DIR` at face value and mint a
 * directory literally named `" "`). Mirrors the
 * fee/slippage ledger's design: a process that never booted the server — unit
 * tests, ad-hoc CLIs — leaves this null and the append below stays a no-op,
 * so exercising an account in a test cannot write into a real data root.
 */
let configuredDataDir: string | null = null;

export function configureEngineBasisRestatementLog(dir: string): void {
  configuredDataDir = dir;
}

/** The boot-configured root, or undefined before/without boot (append skips). */
export function engineBasisRestatementDataDir(): string | undefined {
  return configuredDataDir ?? undefined;
}

/** Test seam. */
export function clearEngineBasisRestatementLogErrors(): void {
  appendErrors = 0;
  lastAppendError = null;
}

/**
 * Best-effort append. IO failure must never break a live reconcile — the
 * restatement itself is the real work; this is observation. The failure is
 * counted so it cannot pass as an empty ledger.
 */
export function appendEngineBasisRestatement(
  dir: string | undefined,
  rec: EngineBasisRestatementRecord,
): void {
  if (!dir) return;
  try {
    const path = engineBasisRestatementLogPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch (err: unknown) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('engine-basis restatement append failed', {
      issue: 'TRA-3010',
      reason: lastAppendError,
    });
  }
}

export interface EngineBasisRestatementLogRead {
  /** Records recovered from disk, oldest first. */
  records: EngineBasisRestatementRecord[];
  /** Lines present but unparseable — surfaced, never silently dropped. */
  malformedLines: number;
  appendErrors: number;
  lastAppendError: string | null;
  /**
   * `false` when DATA_DIR is unset or the file does not exist yet. Distinct from
   * `records: []` with `logPresent: true`, which means the branch really has
   * produced nothing.
   */
  logPresent: boolean;
  dataDir: string | null;
}

export function readEngineBasisRestatements(dir: string | undefined): EngineBasisRestatementLogRead {
  const base: EngineBasisRestatementLogRead = {
    records: [],
    malformedLines: 0,
    appendErrors,
    lastAppendError,
    logPresent: false,
    dataDir: dir ?? null,
  };
  if (!dir) return base;
  const path = engineBasisRestatementLogPath(dir);
  if (!existsSync(path)) return base;
  base.logPresent = true;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Unreadable is NOT empty. Leave `logPresent: true` and no records so the
    // caller cannot read this as "the restatement never ran".
    return base;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as EngineBasisRestatementRecord;
      if (typeof parsed?.positionId === 'string' && typeof parsed?.premiumPaidBefore === 'number') {
        base.records.push(parsed);
      } else {
        base.malformedLines += 1;
      }
    } catch {
      base.malformedLines += 1;
    }
  }
  return base;
}
