/**
 * TRA-2688 (leg 1 of TRA-2654) — the per-session CLOSE LEDGER at the report
 * boundary, and the read that consumes it.
 *
 * ## What it is
 *
 * At EOD archive time, alongside the `<date>.json` the archive already writes
 * into `targetDir`, this writes `closes/<date>.json`: one row per symbol in
 * `state.symbols`, carrying `symbol`, `price`, `change`, `changePct`,
 * `lastUpdated`, `quoteStatus` and `moveSuspect`.
 *
 * It exists to remove TRA-2634's limits 1 (day 1) and 2 (population) from the
 * level-continuity detector. Today that detector can only grade a symbol that
 * was in YESTERDAY's published `top5Movers` — five rows out of ~614 — so on
 * bqb1 292 of 515 rows abstain `no_prior_observation` purely because we never
 * wrote down what we saw.
 *
 * ## The two properties that must survive every future edit
 *
 * **ZERO NETWORK.** Every value comes off `state.symbols`, already in memory.
 * That is why this cannot reopen TRA-2627's fan-out budget or the TRA-2170
 * ceiling, and it is a property of the DESIGN rather than of a measurement, so
 * it has to be preserved deliberately. ⛔ **Do not add a fetch to "fill in"
 * symbols missing from `state.symbols`.** A row we cannot write from memory is
 * ABSENT, and absent must ABSTAIN.
 *
 * **NEVER THROWS.** The EOD report is a human-read money artifact and this is
 * go-live week. Every path here returns a status object and logs; nothing
 * propagates to report generation. Same posture as
 * `denominator-flip-tape-writer.ts` (leg 2), which was deliberately shaped like
 * this writer so the two could be folded together later without moving a file.
 *
 * ## State budget (hard, from the CTO's ruling on TRA-2654)
 *
 * - **Row cap {@link CLOSE_LEDGER_MAX_ROWS} per file.** Over it, truncate,
 *   stamp `truncated` IN the file and log at warn. No silent caps: a truncated
 *   ledger must not read like a complete one, which is why `truncated` is
 *   stamped unconditionally (a `0` you can see beats a field you have to notice
 *   is absent).
 * - **Retention {@link CLOSE_LEDGER_MAX_FILES} files per bucket AND
 *   {@link LEDGER_AGGREGATE_MAX_BYTES} aggregate across ALL buckets** — the
 *   aggregate is SHARED with leg 2's `tape/`, per the ruling. Both prune
 *   oldest-first at every write and report `prunedFiles`.
 *
 * The per-bucket count alone is NOT a bound on bytes: at ~614 rows/session one
 * bucket at full retention is ~250 x ~90 KB ~= 22 MB, so four busy buckets
 * would blow the 64 MB on their own. The aggregate leg is the one that actually
 * binds, and it is the reason there is no unbounded growth path even if the
 * universe grows.
 *
 * ## Consumption, and the FAILURE POSTURE that composes with it
 *
 * The ruling states both halves and they have to be read together:
 *
 * > The continuity check prefers the ledger when a ledger file exists for
 * > `previousMarketDayIso(reportDate)`, and falls back to `prior.top5Movers`
 * > otherwise. **The fallback is not optional** — it is what keeps the 223-pair
 * > historical measurement reproducible against the existing archive.
 *
 * > On a missing, partial or unparseable ledger the next session's continuity
 * > check **abstains**; it must never grade against a partial parse.
 *
 * Composed: a ledger that does not parse, or fails its shape check, is
 * discarded **WHOLE** — never row-by-row, never "the prefix that parsed" — and
 * the read falls back to the archive. Every symbol outside yesterday's top five
 * then reaches `assessLevelContinuity` with `prior == null` and abstains
 * `no_prior_observation`. That is the abstain the ruling asks for, and it is
 * the same behaviour the detector had before this ticket, which is what keeps
 * the fallback census bit-reproducible.
 *
 * ## Why the reader is STRICTER than the writer
 *
 * The writer stores EVERY row, including `lastUpdated === 0` (never fetched)
 * and stale carry-forwards. The reader admits only `lastUpdated > 0`.
 *
 * That asymmetry is deliberate and is the boundary between leg 1 and leg 2. The
 * archive path could only ever offer FRESH priors — `top5Movers` filters
 * `lastUpdated > 0` before it ranks — so admitting stale carry-forwards as
 * prior observations would silently widen the population this detector grades
 * against, and it would do it in the one direction that manufactures breaks
 * (yesterday's stale price is not yesterday's close). `lastUpdated` is stored
 * so leg 2 can MEASURE staleness instead of inferring it from equal prices;
 * turning that measurement into a verdict is leg 2's job, not this one's.
 * ⛔ Do not "simplify" the reader by dropping the freshness filter.
 */

import { writeFile, readFile, readdir, unlink, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { isMoveSuspect } from '@trading-app/shared';
import type { SymbolState } from './signal-engine.js';

/** Sub-directory of the report bucket the ledger lives in. */
export const CLOSE_LEDGER_DIR = 'closes';
/** Hard row cap per file, from the ruling. */
export const CLOSE_LEDGER_MAX_ROWS = 1500;
/** Hard per-bucket retention, from the ruling. */
export const CLOSE_LEDGER_MAX_FILES = 250;
/**
 * Hard aggregate retention ACROSS ALL BUCKETS, from the ruling. Shared with
 * leg 2's tape — see {@link LEDGER_BUDGET_DIRS}.
 */
export const LEDGER_AGGREGATE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * The sub-directories the 64 MB aggregate is denominated over. `tape` is leg
 * 2's (`denominator-flip-tape-writer.ts`), and it is in here because the ruling
 * put it in here: *"this budget also covers leg 2's tape"*. A budget that
 * enumerated only its own writer's files would be a bound on the wrong
 * quantity.
 */
export const LEDGER_BUDGET_DIRS = ['closes', 'tape'] as const;

/** `YYYY-MM-DD.json`. Leads with the ISO date, so lexical order IS date order. */
const LEDGER_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * One symbol's close, as observed at the report boundary.
 *
 * `lastUpdated` is the load-bearing addition and is most of why this file is
 * worth its disk: 189 of 515 bqb1 rows currently abstain for
 * `republished_prior_row`, and that verdict is INFERRED from equal prices. With
 * a stored `lastUpdated` a genuine flat close and a stale carry-forward
 * republication stop being the same observation.
 */
export interface CloseLedgerRow {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  /** Epoch ms of the last successful quote. `0` = never fetched this session. */
  lastUpdated: number;
  quoteStatus: SymbolState['quoteStatus'] | null;
  /**
   * The EFFECTIVE verdict, `isMoveSuspect(s)` — not the raw `s.moveSuspect`
   * stamp. `signal-engine.ts` states the rule on the field itself: *"Consumers
   * must call `isMoveSuspect()`, never read this directly: it re-executes the
   * rule so a row written by a path that never assessed plausibility still
   * fails closed."* Storing the raw stamp under this name would bake that
   * fail-open into the durable record.
   */
  moveSuspect: boolean;
  /**
   * The RAW `s.moveSuspect` stamp, emitted ONLY when it disagrees with the
   * effective verdict above — i.e. the TRA-3243 session-scoped condemnations,
   * a handful of rows per session. Absent means "identical to `moveSuspect`".
   *
   * Conditional because it is pure cost on ~99% of rows and this file has a
   * byte budget; present at all because the disagreement is exactly the
   * attribution TRA-3243 exists to keep measurable, and a ledger that folded
   * the two would make it unrecoverable after the fact.
   */
  moveSuspectStamp?: boolean;
}

/** The serialized shape of `closes/<date>.json`. */
export interface CloseLedgerFile {
  issue: 'TRA-2688';
  date: string;
  generatedAt: string;
  /** `state.symbols.length` at archive time, BEFORE the row cap. */
  symbolsInState: number;
  /** The cap this file was written under, carried so a reader need not guess. */
  rowCap: number;
  /**
   * Rows dropped by the row cap. Stamped UNCONDITIONALLY, including `0`: the
   * ruling's "no silent caps" is about a truncated ledger not reading like a
   * complete one, and an absent field is something a reader has to notice.
   */
  truncated: number;
  rows: CloseLedgerRow[];
}

export interface CloseLedgerWriteResult {
  written: boolean;
  path?: string;
  rows: number;
  symbolsInState: number;
  truncated: number;
  bytes?: number;
  /** Files removed by the per-bucket count prune. */
  prunedFiles: number;
  /** Files removed by the shared aggregate byte prune. */
  prunedForAggregate: number;
  /**
   * What the aggregate leg actually did. `'skipped_no_root'` and
   * `'skipped_already_run'` are REPORTED rather than inferred from a zero —
   * a `prunedForAggregate: 0` that means "never looked" and one that means
   * "looked and we are under budget" are not the same fact.
   */
  aggregateSweep: 'ran' | 'skipped_no_root' | 'skipped_already_run' | 'failed';
  aggregateBytes?: number;
  /** Set when the write failed. The caller logs it; the report proceeds. */
  error?: string;
}

interface LedgerLog {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}

/** UTF-8 byte length — the budget is bytes on disk, not JS string length. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

/**
 * Project one `SymbolState` onto a ledger row.
 *
 * Non-finite numerics are normalized to `0` rather than dropped: `JSON` has no
 * `NaN`, so a raw `NaN` would serialize as `null` and read back as a different
 * type than the field's contract. `0` is already the "never fetched" value for
 * `lastUpdated`, and a `price: 0` row is one the reader refuses anyway.
 */
export function toCloseLedgerRow(s: SymbolState): CloseLedgerRow {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const effective = isMoveSuspect(s);
  const stamp = s.moveSuspect === true;
  return {
    symbol: s.symbol,
    price: num(s.price),
    change: num(s.change),
    changePct: num(s.changePct),
    lastUpdated: num(s.lastUpdated),
    quoteStatus: s.quoteStatus ?? null,
    moveSuspect: effective,
    ...(stamp === effective ? {} : { moveSuspectStamp: stamp }),
  };
}

/**
 * Apply the row cap, keeping the rows a reader can actually USE.
 *
 * Ordering: rows the reader admits (`lastUpdated > 0 && price > 0`) first, then
 * everything else; within each group, symbol ascending. That is deterministic
 * (so two runs over the same state produce the same file) and it degrades in
 * the right direction — if this ever fires, what survives is the set that can
 * serve as a prior observation, not an arbitrary alphabetical prefix of the
 * whole universe.
 *
 * At ~614 rows/session against a 1,500 cap this is a defensive branch. It fires
 * only if the universe grows ~2.4x, and when it does it says so.
 */
export function capCloseLedgerRows(
  rows: readonly CloseLedgerRow[],
  cap: number = CLOSE_LEDGER_MAX_ROWS,
): { rows: CloseLedgerRow[]; truncated: number } {
  if (rows.length <= cap) return { rows: [...rows], truncated: 0 };
  const usable = (r: CloseLedgerRow) => r.lastUpdated > 0 && r.price > 0;
  const ordered = [...rows].sort((a, b) => {
    const ua = usable(a) ? 0 : 1;
    const ub = usable(b) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
  return { rows: ordered.slice(0, Math.max(0, cap)), truncated: rows.length - Math.max(0, cap) };
}

/**
 * TRA-2688 — the once-per-session ledger write.
 *
 * NEVER THROWS. `log` is injected so this module does not reach into the
 * engine's logger, matching leg 2's writer.
 *
 * ⛔ `usersRoot` is what makes the 64 MB aggregate leg possible. Omitting it
 * does NOT silently disable the budget — it reports `skipped_no_root`, because
 * a bound nobody can see is not a bound.
 */
export async function writeCloseLedger(args: {
  targetDir: string;
  date: string;
  symbols: readonly SymbolState[];
  /** `<DATA_DIR>/users` — the root the aggregate budget is enumerated from. */
  usersRoot?: string;
  now?: number;
  log?: LedgerLog;
}): Promise<CloseLedgerWriteResult> {
  const { targetDir, date, symbols } = args;
  const nowMs = args.now ?? Date.now();
  const base: CloseLedgerWriteResult = {
    written: false,
    rows: 0,
    symbolsInState: symbols.length,
    truncated: 0,
    prunedFiles: 0,
    prunedForAggregate: 0,
    aggregateSweep: 'skipped_no_root',
  };
  try {
    const dir = join(targetDir, CLOSE_LEDGER_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${date}.json`);

    const capped = capCloseLedgerRows(symbols.map(toCloseLedgerRow));
    const file: CloseLedgerFile = {
      issue: 'TRA-2688',
      date,
      generatedAt: new Date(nowMs).toISOString(),
      symbolsInState: symbols.length,
      rowCap: CLOSE_LEDGER_MAX_ROWS,
      truncated: capped.truncated,
      rows: capped.rows,
    };
    // Compact: this is a machine-read artifact, and pretty-printing ~614 rows
    // would spend roughly a third of the file on whitespace for no reader.
    const json = JSON.stringify(file);
    await writeFile(path, json, 'utf-8');

    // Per-bucket count prune, oldest-first. Filenames lead with the ISO date so
    // lexical order is date order — no `stat` round-trip per file here.
    let prunedFiles = 0;
    try {
      const names = (await readdir(dir)).filter(n => LEDGER_FILE_RE.test(n)).sort();
      const excess = names.length - CLOSE_LEDGER_MAX_FILES;
      for (let i = 0; i < excess; i += 1) {
        await unlink(join(dir, names[i]));
        prunedFiles += 1;
      }
    } catch (err: unknown) {
      args.log?.warn('TRA-2688 close-ledger per-bucket prune failed', {
        dir,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const agg = await enforceAggregateLedgerBudget({
      usersRoot: args.usersRoot,
      date,
      log: args.log,
    });

    const result: CloseLedgerWriteResult = {
      written: true,
      path,
      rows: file.rows.length,
      symbolsInState: file.symbolsInState,
      truncated: file.truncated,
      bytes: byteLen(json),
      prunedFiles,
      prunedForAggregate: agg.pruned,
      aggregateSweep: agg.sweep,
      ...(agg.bytes == null ? {} : { aggregateBytes: agg.bytes }),
    };
    // No silent caps. A truncated ledger, or one written while the shared
    // budget was evicting, must not read like an ordinary complete session.
    if (file.truncated > 0 || agg.pruned > 0 || agg.sweep === 'failed') {
      args.log?.warn(
        'TRA-2688 close ledger is INCOMPLETE or evicted under budget — do not read it as a full census',
        { ...result },
      );
    } else {
      args.log?.info('TRA-2688 close ledger written', { ...result });
    }
    return result;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    args.log?.warn('TRA-2688 close-ledger write failed — the report is unaffected', { date, reason });
    return { ...base, error: reason };
  }
}

/**
 * Per-process memo for the aggregate sweep, keyed by ET date.
 *
 * The sweep walks every book's ledger + tape directories, and
 * `generateAndSaveReport` runs once per USER — so an unguarded sweep would
 * repeat that walk ~60 times per session for a budget that cannot have moved
 * much between two of them.
 *
 * ⚠️ STATED, because a bound you cannot see the slack in is not a bound: with
 * the memo the fleet can exceed 64 MB by at most ONE session's writes (~62
 * books x ~90 KB ~= 5.6 MB, i.e. under 9%) before the next date's first EOD
 * reclaims it. A restart clears the memo and simply re-runs an idempotent
 * prune, which is the safe direction.
 */
let aggregateSweptForDate: string | null = null;

/** Test seam — the memo is process-global and would leak between cases. */
export function resetAggregateLedgerSweepMemo(): void {
  aggregateSweptForDate = null;
}

/**
 * Enumerate every ledger/tape directory under `usersRoot`.
 *
 * Denominated in DIRECTORIES ON DISK, not in registry entries, for the reason
 * `bookReportRoots` documents on TRA-3064: three quarters of the book trees on
 * that volume answer to no entry in `users.json`, and a registry-driven sweep
 * would silently scope itself to the shrinking half of the problem while
 * reporting a clean run.
 */
async function ledgerBudgetDirs(usersRoot: string): Promise<string[]> {
  const out: string[] = [];
  let books: Array<{ name: string; isDirectory(): boolean }>;
  try {
    books = await readdir(usersRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const book of books) {
    if (!book.isDirectory()) continue;
    for (const root of ['reports', 'crypto-reports']) {
      const rootPath = join(usersRoot, book.name, root);
      let modes: Array<{ name: string; isDirectory(): boolean }>;
      try {
        modes = await readdir(rootPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const mode of modes) {
        if (!mode.isDirectory()) continue;
        for (const sub of LEDGER_BUDGET_DIRS) out.push(join(rootPath, mode.name, sub));
      }
    }
  }
  return out;
}

/**
 * Hold the SHARED 64 MB ceiling across every bucket, evicting oldest-first.
 *
 * "Oldest" is the filename's ISO date across ALL directories, not per
 * directory: the budget is one pool, so the globally oldest session is the
 * right thing to give up. Ties break on path so the order is deterministic.
 *
 * NEVER THROWS.
 */
export async function enforceAggregateLedgerBudget(args: {
  usersRoot?: string;
  date: string;
  maxBytes?: number;
  /** Test seam — bypass the once-per-date memo. */
  force?: boolean;
  log?: LedgerLog;
}): Promise<{ sweep: CloseLedgerWriteResult['aggregateSweep']; pruned: number; bytes?: number }> {
  const { usersRoot } = args;
  if (!usersRoot) return { sweep: 'skipped_no_root', pruned: 0 };
  if (!args.force && aggregateSweptForDate === args.date) {
    return { sweep: 'skipped_already_run', pruned: 0 };
  }
  const maxBytes = args.maxBytes ?? LEDGER_AGGREGATE_MAX_BYTES;
  try {
    const files: Array<{ path: string; name: string; size: number }> = [];
    let total = 0;
    for (const dir of await ledgerBudgetDirs(usersRoot)) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        // An absent `closes/` or `tape/` is the ordinary case for a book that
        // has not archived yet. Not an error, and not a reason to abort the
        // pool: a sweep that gave up on the first missing directory would
        // under-count the total and report a budget it never measured.
        continue;
      }
      for (const name of names) {
        // Leg 2's orphan files (`<date>.orphanN.json`) count too — they occupy
        // the same pool, and TRA-3116 already counts them against leg 2's own
        // retention for the same reason.
        if (!/^\d{4}-\d{2}-\d{2}(?:\.orphan\d+)?\.json$/.test(name)) continue;
        try {
          const st = await stat(join(dir, name));
          if (!st.isFile()) continue;
          files.push({ path: join(dir, name), name, size: st.size });
          total += st.size;
        } catch {
          // Vanished between readdir and stat (a concurrent prune). It is not
          // in the pool, so it is not in the total either.
        }
      }
    }
    let pruned = 0;
    if (total > maxBytes) {
      files.sort((a, b) => (a.name === b.name ? (a.path < b.path ? -1 : 1) : a.name < b.name ? -1 : 1));
      for (const f of files) {
        if (total <= maxBytes) break;
        try {
          await unlink(f.path);
          total -= f.size;
          pruned += 1;
        } catch {
          // Cannot remove it — leave the total as-is so the loop keeps trying
          // the next-oldest rather than spinning on one unremovable file.
        }
      }
      args.log?.warn('TRA-2688 shared ledger budget exceeded — evicted oldest sessions', {
        issue: 'TRA-2688',
        maxBytes,
        bytesAfter: total,
        prunedForAggregate: pruned,
        dirsScanned: LEDGER_BUDGET_DIRS.join('+'),
      });
    }
    aggregateSweptForDate = args.date;
    return { sweep: 'ran', pruned, bytes: total };
  } catch (err: unknown) {
    args.log?.warn('TRA-2688 shared ledger budget sweep failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { sweep: 'failed', pruned: 0 };
  }
}

/**
 * The result of asking for a prior session's ledger.
 *
 * Three states, not two, for the same reason `LevelContinuityVerdict` is
 * three-valued: `'absent'` (no ledger for that session — the ordinary case
 * before this ticket's first write, and every weekend boundary the archive
 * already handles) and `'unreadable'` (a ledger that exists and cannot be
 * trusted) demand the SAME action but are different facts, and folding them
 * would hide a corrupt file inside the ordinary case.
 */
export type CloseLedgerRead =
  | { state: 'absent' }
  | { state: 'ok'; file: CloseLedgerFile; rows: CloseLedgerRow[] }
  | { state: 'unreadable'; reason: string };

/** Structural check. Anything that fails is UNREADABLE — never partly used. */
function isCloseLedgerFile(v: unknown): v is CloseLedgerFile {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Partial<CloseLedgerFile>;
  return typeof f.date === 'string' && Array.isArray(f.rows);
}

/**
 * Read `closes/<date>.json`.
 *
 * ⛔ ALL-OR-NOTHING. A file that does not parse, or fails its shape check, is
 * discarded WHOLE — never "the rows that happened to survive". The ruling's
 * failure posture is the rule I care most about here: *on a missing, partial or
 * unparseable ledger the next session's continuity check abstains; it must
 * never grade against a partial parse.* The caller then falls back to the
 * archive, and every symbol outside yesterday's top five abstains
 * `no_prior_observation` — which is the pre-TRA-2688 behaviour, exactly.
 *
 * NEVER THROWS.
 */
export async function readCloseLedger(targetDir: string, date: string): Promise<CloseLedgerRead> {
  const path = join(targetDir, CLOSE_LEDGER_DIR, `${date}.json`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isCloseLedgerFile(parsed)) {
      return { state: 'unreadable', reason: 'close ledger failed its shape check' };
    }
    if (parsed.date !== date) {
      // A file whose own `date` disagrees with the name it was found under is
      // the one shape that could silently make a session continuous with
      // ITSELF (residual 1.0 => `consistent` on every row). Refuse it.
      return {
        state: 'unreadable',
        reason: `close ledger date mismatch: file says ${parsed.date}, expected ${date}`,
      };
    }
    return { state: 'ok', file: parsed, rows: parsed.rows };
  } catch (err: unknown) {
    return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The prior-session rows a continuity check may USE, from a ledger read.
 *
 * Only `lastUpdated > 0 && price > 0` rows are admitted — see the module header
 * for why the reader is stricter than the writer. A row that is dropped here is
 * not "clean"; it simply is not an observation, and the symbol abstains
 * `no_prior_observation` exactly as it did before this ticket.
 */
export function usableLedgerRows(rows: readonly CloseLedgerRow[]): CloseLedgerRow[] {
  return rows.filter(
    r =>
      typeof r?.symbol === 'string' && r.symbol.length > 0
      && Number.isFinite(r.price) && r.price > 0
      && Number.isFinite(r.lastUpdated) && r.lastUpdated > 0,
  );
}

/** A prior-session row in the shape the continuity detector already grades. */
export interface PriorSessionRow {
  symbol: string;
  price: number;
  changePct: number;
}

/**
 * Resolve the LEDGER half of "what did we publish for the prior session?".
 *
 * Returns `movers: null` for every non-`close_ledger` outcome, and the caller
 * MUST then take the archive fallback — the ruling makes that fallback
 * mandatory, and it is what keeps the historical census reproducible.
 *
 * ⚠️ `source` distinguishes four outcomes that all produce `null`. They demand
 * the same action and they are NOT the same fact: `ledger_absent` is the
 * ordinary shape on the ledger's own day 1 and after any retention prune;
 * `ledger_unreadable` means a file exists and could not be trusted;
 * `ledger_empty` means it parsed and held no admissible row. Folding them would
 * hide a corrupt file inside the ordinary case, which is the exact failure this
 * family of tickets keeps finding.
 *
 * ⛔ THIS NEVER RETURNS ROWS FOR THE SESSION BEING GRADED. `prevSession` is the
 * caller's to compute (`previousMarketDayIso(reportDate)`), and
 * {@link readCloseLedger} additionally refuses any file whose own `date`
 * disagrees with the one asked for — because a session compared against its own
 * ledger has residual 1.0 on every row and would publish `consistent` across
 * the board, which is a rubber stamp wearing a measurement's clothes.
 *
 * NEVER THROWS.
 */
export async function priorSessionLedgerMovers(args: {
  targetDir: string;
  prevSession: string;
  log?: LedgerLog;
  /** For the log line only. */
  username?: string;
}): Promise<{
  movers: PriorSessionRow[] | null;
  source: 'close_ledger' | 'ledger_absent' | 'ledger_unreadable' | 'ledger_empty';
  rowsInFile: number;
  rowsUsable: number;
  truncated: number | null;
  symbolsInState: number | null;
}> {
  const { targetDir, prevSession } = args;
  const miss = (source: 'ledger_absent' | 'ledger_unreadable' | 'ledger_empty') => ({
    movers: null,
    source,
    rowsInFile: 0,
    rowsUsable: 0,
    truncated: null,
    symbolsInState: null,
  });
  const read = await readCloseLedger(targetDir, prevSession);
  if (read.state === 'absent') return miss('ledger_absent');
  if (read.state === 'unreadable') {
    args.log?.warn('TRA-2688 prior-session close ledger unreadable — falling back to the archive', {
      username: args.username,
      prevSession,
      reason: read.reason,
    });
    return miss('ledger_unreadable');
  }
  const usable = usableLedgerRows(read.rows);
  args.log?.info('TRA-2688 prior-session close ledger read', {
    username: args.username,
    prevSession,
    rowsInFile: read.rows.length,
    // The gap between these two is the freshness filter. Printed because a
    // reader must be able to see how much of the file was NOT admissible as a
    // prior observation — an unstated filter is a silent cap.
    rowsUsable: usable.length,
    symbolsInState: read.file.symbolsInState,
    truncated: read.file.truncated,
  });
  if (usable.length === 0) return { ...miss('ledger_empty'), rowsInFile: read.rows.length };
  return {
    // Projected onto the detector's existing row shape.
    // `assessLevelContinuity` reads only `price` and `changePct` off the PRIOR
    // row (`impliedPrevClose` is computed from the CURRENT one), so a ledger row
    // and an archive row are verdict-equivalent for any symbol present in both:
    // the ledger changes the POPULATION, never the rule. That equivalence is
    // what makes the change additive, and it is what AC3 pins.
    movers: usable.map(r => ({ symbol: r.symbol, price: r.price, changePct: r.changePct })),
    source: 'close_ledger',
    rowsInFile: read.rows.length,
    rowsUsable: usable.length,
    truncated: read.file.truncated,
    symbolsInState: read.file.symbolsInState,
  };
}
