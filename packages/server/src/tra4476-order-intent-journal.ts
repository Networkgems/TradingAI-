/**
 * TRA-4476 — THE DURABLE HALF of the unknown-outcome state machine.
 *
 * `packages/engine` is filesystem-free by convention, so it holds the state
 * machine and an in-memory journal. This is the JSONL-backed implementation the
 * server installs at boot, and the boot-time rehydrate that turns a restart
 * mid-intent into a HALT rather than a duplicate.
 *
 * ## Why an in-memory journal is not enough, concretely
 *
 * The sequence the engine's breaker cannot survive on its own:
 *
 *   1. we POST an order;
 *   2. the box is redeployed / OOM-killed / pm2-restarted (the memory watchdog's
 *      self-restart writes no deploy record at all — TRA-2203/TRA-2261 — so this
 *      is not a rare event here);
 *   3. the new process boots with an EMPTY breaker;
 *   4. the ladder resubmits, and the order from step 1 is still working.
 *
 * The pre-submit line on disk is the only thing that exists across step 2. It is
 * written **before** the POST for exactly that reason: a record written after the
 * response is a record that does not exist in the case it is for.
 *
 * ## What a `submitting` line means, and why it latches
 *
 * A line left at `submitting` is the worst case in the file: the process died
 * between the journal write and the response, so we never saw a status code at
 * all. It might be an order that was never sent; it might be a live position. It
 * latches, and only a reconcile or an operator release clears it. An operator
 * looking at a latched `submitting` line has the account, the shape and the
 * submit instant — which is everything needed to go read the broker by hand.
 *
 * ## Retention — NOT compacted, for the reason TRA-3939 gives
 *
 * Append-only and retained. These lines are EVIDENCE about real orders, not
 * measurements a later run can retake; the sibling ledger's docblock makes the
 * same call for the same reason. One line per submit and one per settle, at a
 * handful of submits per trading day, is single-digit MB per year.
 *
 * ⚠ The file is REWRITTEN on compaction of terminal intents ONLY at boot, and
 * only into a `.archive` sibling — never deleted. See {@link compactAtBoot}.
 */
import { appendFileSync, existsSync, readFileSync, renameSync } from 'fs';
import path from 'path';
import {
  getUnknownIntentBreaker,
  rehydrateBreakerFromJournal,
  setOrderIntentJournal,
  summarizeUnknownIntents,
  type OrderIntent,
  type OrderIntentJournal,
  type UnknownIntentSummary,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'tra4476-order-intent-journal' });

export const ORDER_INTENT_LOG_FILENAME = 'tra4476-order-intents.jsonl';

export function orderIntentLogPath(dir: string): string {
  return path.join(dir, ORDER_INTENT_LOG_FILENAME);
}

/**
 * A journal that writes every state transition as its own line.
 *
 * Last-line-wins per `intentId` on read. Rewriting a line in place would need a
 * read-modify-write on the submit hot path; appending is atomic enough for our
 * purposes (one process, `appendFileSync` under the 4KB pipe-atomicity bound)
 * and it keeps the full transition history, which is what an operator
 * reconstructing a lost order actually wants.
 */
export class FileOrderIntentJournal implements OrderIntentJournal {
  /**
   * Write failures are COUNTED, never swallowed silently. A journal that is
   * failing degrades us to the pre-TRA-4476 behaviour — which is the status quo,
   * not a new hazard — but a reader must be able to tell that from a journal
   * that is working and quiet.
   */
  private failures = 0;

  private writes = 0;

  constructor(private readonly filePath: string) {}

  private append(intent: OrderIntent): boolean {
    try {
      appendFileSync(this.filePath, `${JSON.stringify(intent)}\n`, 'utf8');
      this.writes += 1;
      return true;
    } catch (err) {
      this.failures += 1;
      // Log at most the first few — a disk that is full will produce one of
      // these per submit and must not become the outage itself.
      if (this.failures <= 3) {
        log.error('order-intent journal write failed', {
          intentId: intent.intentId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }
  }

  record(intent: OrderIntent): void {
    this.append(intent);
  }

  /**
   * TRA-4602 — the durable write receipt. `false` means the bytes did NOT land,
   * so no restart can reconstruct this order and the caller must decide whether
   * the submit may proceed. Never throws: the submit path wants a verdict, not
   * an exception.
   */
  recordDurable(intent: OrderIntent): boolean {
    return this.append(intent);
  }

  update(intent: OrderIntent): void {
    this.append(intent);
  }

  openUnknowns(): OrderIntent[] {
    return readOpenIntents(this.filePath).open;
  }

  stats(): { writes: number; failures: number; path: string } {
    return { writes: this.writes, failures: this.failures, path: this.filePath };
  }
}

export interface OrderIntentReadResult {
  /** Latest state of every intent id in the file. */
  latest: OrderIntent[];
  /** Those still `submitting` or `unknown` — the set that must re-latch. */
  open: OrderIntent[];
  /** Lines that would not parse. Counted, never silently dropped. */
  corrupt: number;
  /** True when the file is absent — distinct from "present and empty". */
  absent: boolean;
}

/**
 * Fold the append-only file to the latest state per intent id.
 *
 * `absent` is reported separately from an empty `latest` on purpose: "there is
 * no journal" and "the journal says nothing is outstanding" are different facts,
 * and only the second is an all-clear. Reading the first as the second is the
 * empty-witness mistake this repo has paid for repeatedly.
 */
export function readOpenIntents(filePath: string): OrderIntentReadResult {
  if (!existsSync(filePath)) return { latest: [], open: [], corrupt: 0, absent: true };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    log.error('order-intent journal unreadable', { reason: err instanceof Error ? err.message : String(err) });
    // Unreadable is NOT empty. Report it as absent so no caller reads a
    // successful all-clear out of a failed read.
    return { latest: [], open: [], corrupt: 0, absent: true };
  }
  const byId = new Map<string, OrderIntent>();
  let corrupt = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as OrderIntent;
      if (typeof parsed?.intentId !== 'string') {
        corrupt += 1;
        continue;
      }
      byId.set(parsed.intentId, parsed);
    } catch {
      corrupt += 1;
    }
  }
  const latest = [...byId.values()];
  return {
    latest,
    open: latest.filter((i) => i.status === 'submitting' || i.status === 'unknown'),
    corrupt,
    absent: false,
  };
}

let installed: FileOrderIntentJournal | null = null;

export interface InstallResult {
  installed: boolean;
  path: string | null;
  /** Intents re-latched from disk. */
  rehydrated: number;
  corruptLines: number;
  journalAbsent: boolean;
}

/**
 * Install the durable journal and re-latch anything the previous process left
 * outstanding. Call once, at boot, BEFORE any client can submit.
 */
export function installOrderIntentJournal(dataDir: string | null): InstallResult {
  if (dataDir === null) {
    log.warn('order-intent journal NOT installed — no data dir; unknown-outcome halts will not survive a restart');
    return { installed: false, path: null, rehydrated: 0, corruptLines: 0, journalAbsent: true };
  }
  const filePath = orderIntentLogPath(dataDir);
  const priorRead = readOpenIntents(filePath);
  const journal = new FileOrderIntentJournal(filePath);
  installed = journal;
  setOrderIntentJournal(journal);

  // Re-latch from what the PREVIOUS process left behind. `rehydrateBreakerFromJournal`
  // reads `openUnknowns()`, which is this same fold.
  const rehydrated = rehydrateBreakerFromJournal(journal);
  if (rehydrated > 0) {
    log.warn('TRA-4476 re-latched unresolved order intents from disk', {
      count: rehydrated,
      shapes: getUnknownIntentBreaker().keys(),
    });
  }
  if (priorRead.corrupt > 0) {
    log.warn('order-intent journal had unparseable lines', { corrupt: priorRead.corrupt });
  }
  return {
    installed: true,
    path: filePath,
    rehydrated,
    corruptLines: priorRead.corrupt,
    journalAbsent: priorRead.absent,
  };
}

/**
 * Move the current journal aside to a timestamped `.archive` sibling. The only
 * sanctioned way to shrink the file, and it is an ARCHIVE, never a delete —
 * these lines are the only record that a given order was ever attempted.
 */
export function compactAtBoot(dataDir: string, now: number = Date.now()): string | null {
  const filePath = orderIntentLogPath(dataDir);
  if (!existsSync(filePath)) return null;
  const target = `${filePath}.${new Date(now).toISOString().replace(/[:.]/g, '-')}.archive`;
  try {
    renameSync(filePath, target);
    return target;
  } catch (err) {
    log.error('order-intent journal archive failed', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * What `/api/health/order-intents` publishes.
 *
 * `journalInstalled` is stated rather than implied: a reader must be able to
 * tell "no shape is halted" from "nothing is recording", because the second one
 * also reports zero halts.
 */
export interface OrderIntentHealth extends UnknownIntentSummary {
  journalInstalled: boolean;
  journalPath: string | null;
  journalWrites: number;
  journalFailures: number;
  /** Intents outstanding on disk right now — including any this process latched. */
  openOnDisk: number;
  /** True when no journal file exists yet. NOT the same as `openOnDisk === 0`. */
  journalAbsent: boolean;
  corruptLines: number;
}

export function orderIntentHealth(): OrderIntentHealth {
  const base = summarizeUnknownIntents();
  if (installed === null) {
    return {
      ...base,
      journalInstalled: false,
      journalPath: null,
      journalWrites: 0,
      journalFailures: 0,
      openOnDisk: 0,
      journalAbsent: true,
      corruptLines: 0,
    };
  }
  const stats = installed.stats();
  const read = readOpenIntents(stats.path);
  return {
    ...base,
    journalInstalled: true,
    journalPath: stats.path,
    journalWrites: stats.writes,
    journalFailures: stats.failures,
    openOnDisk: read.open.length,
    journalAbsent: read.absent,
    corruptLines: read.corrupt,
  };
}

/** Test seam. */
export function __resetOrderIntentJournalForTest(): void {
  installed = null;
  setOrderIntentJournal(null);
}
