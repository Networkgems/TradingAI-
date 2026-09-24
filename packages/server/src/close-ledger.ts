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
 * - **Retention {@link CLOSE_LEDGER_MAX_FILES} files per bucket AND a
 *   per-directory aggregate across ALL buckets** — {@link CLOSE_LEDGER_MAX_BYTES}
 *   for every `closes/` and {@link TAPE_LEDGER_MAX_BYTES} for leg 2's `tape/`,
 *   64 MiB combined. TRA-4156 Phase 1 split what the TRA-2654 ruling ran as one
 *   shared pool: the shared pool pinned at 99.9% from 2026-08-21 and evicted
 *   the LIVE book's closes to make room for tape, so each writer now has its
 *   own ceiling and neither can evict the other. Both prune oldest-first at
 *   every write and report `prunedFiles`.
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
 *
 * ## TRA-3847 — the writer owns the market-day predicate, same as leg 2
 *
 * TRA-3844 put a calendar gate in leg 2's writer after a Sunday redeploy's
 * shutdown drain minted 67 ledger-bearing `tape/<date>.json` files. This writer
 * was deliberately shaped like that one and had **none** — `grep -c isMarketDay
 * close-ledger.ts` was 0 — so the two legs of TRA-2654 were asymmetric on the
 * calendar, which is the shape both TRA-3844 and TRA-3267 were raised on.
 *
 * ### The exposure was NARROWER than leg 2's, and it was still real
 *
 * There is no shutdown path here. `writeCloseLedger` is reached only from
 * `generateAndSaveReport`, whose callers are the backfill (close-ledger is
 * explicitly skipped), the EOD archive sweep (already gated `if
 * (stocksMarketDay)`), and `POST /api/reports/generate` — which had **no gate at
 * all**. A human hitting *Generate EOD report* on a Saturday minted
 * `closes/<saturday>.json`, and nothing downstream re-checked the calendar the
 * way `denominator-flip-tape-summary.ts` does for the tape.
 *
 * The census run for TRA-3847 over the writer's ENTIRE deployed lifetime (live
 * since deploy `4dac411`, 2026-08-13T11:20Z; Render's 30-day log retention
 * therefore covers 100% of it, so this is a complete count and not a floor)
 * found **201 writes across exactly three date keys — 2026-08-13, 08-14 and
 * 08-17, 67 books each, every one an NYSE session. Zero non-market dates, so
 * zero inert files and zero ledger-bearing ones.** The Sunday 2026-08-16
 * 14:44Z redeploy that minted leg 2's 67 weekend tape files minted **no** close
 * ledger, which is the paired control on "there is no shutdown path here".
 *
 * So this gate is prophylactic rather than a cleanup, and it is still worth its
 * lines: the defect TRA-3844 closed was a writer that could be *made* to mint a
 * false session by any caller, and closing it on the route alone would leave
 * exactly that.
 *
 * ### Why the gate is HERE and not on the route
 *
 * At the seam it covers all three present callers and every future one. On the
 * route it would cover one caller, leave the writer mintable, and additionally
 * refuse the ARCHIVE `<date>.json` write — a different artifact, with its own
 * calendar history (TRA-3267/TRA-3298) and its own owner. Narrowest correct fix
 * wins: `closes/<date>.json` existing is now itself the claim "this date was an
 * NYSE session", which is what a reader was always entitled to assume of a file
 * named after a trading day.
 *
 * ### The gate cannot blind the reader, STRUCTURALLY
 *
 * {@link priorSessionLedgerMovers} is only ever asked for
 * `previousMarketDayIso(reportDate)` (`index.ts`), so the set of dates the
 * reader can request is a SUBSET of the market days this gate admits, and the
 * set it refuses is one the reader can never ask for. A weekend ledger was
 * therefore unreadable residue even before this: nothing could reach it. Live
 * confirmation on the weekend that matters — Monday 2026-08-17's EOD read
 * `prior=2026-08-14`, `source=close_ledger`, on 67 of 67 books.
 */

import { writeFile, readFile, readdir, unlink, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { isMoveSuspect } from '@trading-app/shared';
import { isMarketDayIso } from './scheduler.js';
import type { SymbolState } from './signal-engine.js';

/** Sub-directory of the report bucket the ledger lives in. */
export const CLOSE_LEDGER_DIR = 'closes';
/** Hard row cap per file, from the ruling. */
export const CLOSE_LEDGER_MAX_ROWS = 1500;
/** Hard per-bucket retention, from the ruling. */
export const CLOSE_LEDGER_MAX_FILES = 250;
/**
 * TRA-4156 Phase 1 — the 64 MiB pool split into per-directory budgets, 75/25.
 * The split is conservative on purpose: the combined ceiling is unchanged, so
 * this cannot grow the disk footprint; it only stops the two writers evicting
 * each other's files.
 */
export const CLOSE_LEDGER_MAX_BYTES = 48 * 1024 * 1024;
/** Leg 2's (`denominator-flip-tape-writer.ts`) share of the split. */
export const TAPE_LEDGER_MAX_BYTES = 16 * 1024 * 1024;
/**
 * The per-directory ceilings, keyed by the sub-directory name the files live
 * under. `tape` is leg 2's, and it is in here because the TRA-2654 ruling put
 * the budget in here: *"this budget also covers leg 2's tape"*. A budget that
 * enumerated only its own writer's files would be a bound on the wrong
 * quantity — TRA-4156 changed the DENOMINATION (per directory instead of one
 * shared pool), not the ownership.
 */
export const LEDGER_BUDGET_LIMITS: Record<string, number> = {
  closes: CLOSE_LEDGER_MAX_BYTES,
  tape: TAPE_LEDGER_MAX_BYTES,
};
/** The sub-directories the budgets are denominated over. */
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
  /** Combined bytes across both directories — the pre-TRA-4156 quantity. */
  aggregateBytes?: number;
  /**
   * TRA-4156 Phase 1 — the per-directory view, keyed like
   * {@link LEDGER_BUDGET_LIMITS}. Reported (and logged) separately because the
   * combined number is exactly what hid the LIVE book's eviction: 99.9% of one
   * shared pool said nothing about WHICH writer's files were being given up.
   */
  aggregateByDir?: Record<string, { bytes: number; maxBytes: number; pruned: number }>;
  /** Set when the write failed. The caller logs it; the report proceeds. */
  error?: string;
  /**
   * TRA-3847 — the write was REFUSED on the calendar predicate, not attempted
   * and failed. Kept separate from `error` for the same reason leg 2 keeps them
   * separate: `error` is "a real session's rows did not reach disk", which is
   * something to chase; `skipped` is "there was no session", which is the
   * writer working. A caller that read `!written` alone could not tell a
   * refused Saturday from an ENOSPC on a Tuesday.
   */
  skipped?: boolean;
  skipReason?: string;
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
 * ⛔ `usersRoot` is what makes the aggregate budget leg possible. Omitting it
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
  /**
   * Test seam — forwarded verbatim to {@link enforceAggregateLedgerBudget}, so
   * the write-level eviction branches can be exercised without minting 48 MiB
   * of fixture. Production callers never pass it and get
   * {@link LEDGER_BUDGET_LIMITS}.
   */
  limits?: Partial<Record<(typeof LEDGER_BUDGET_DIRS)[number], number>>;
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

  // TRA-3847 — the calendar predicate, ahead of every path that touches disk
  // (including `mkdir`, so a refused write does not even create the bucket).
  // The SAME `isMarketDayIso` leg 2's writer gates on and the reader filters
  // `barDays[]` with: one predicate, one calendar, no second copy to drift.
  //
  // A malformed date key fails this test too, and that is the right answer
  // rather than an accident of the regex: a file named something no reader can
  // resolve to a session is worse than no file, and `readCloseLedger` would
  // never ask for it anyway.
  //
  // NOTHING IS LOST BY REFUSING. Unlike leg 2, this writer holds no ring — every
  // row is projected from `state.symbols`, which is still in memory and will be
  // re-projected at the next real session's close. There is no re-admission
  // question here, so there is nothing to discard; the count is still named in
  // the warn, because a write that did not happen and nothing said so is the
  // same fail-open the rest of this module is built against.
  if (!isMarketDayIso(date)) {
    args.log?.warn(
      'TRA-3847 close-ledger write on a NON-MARKET ET date — refusing to mint a session file (no rows are lost: they re-project from `state.symbols` at the next session)',
      { date, symbolsInState: symbols.length, dir: join(targetDir, CLOSE_LEDGER_DIR) },
    );
    return { ...base, skipped: true, skipReason: 'non-market-day' };
  }

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
      ...(args.limits == null ? {} : { limits: args.limits }),
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
      ...(agg.byDir == null ? {} : { aggregateByDir: agg.byDir }),
    };
    // No silent caps. A truncated ledger, or one written while ITS OWN pool was
    // evicting, must not read like an ordinary complete session.
    //
    // TRA-4503 AC3: the predicate keys on the `closes/` pool, NOT on the
    // combined count. Pre-split there was one pool, so `agg.pruned > 0` asked
    // the same question; after the split it does not. Measured live at the
    // 2026-09-24T01:00Z boundary: the admin LIVE book logged INCOMPLETE with
    // `closes: {pruned: 0, bytes: 20746889/50331648}` — all 407 evictions were
    // `tape/`, a sibling pool this file does not live in. Telling a reader that
    // a complete census may be incomplete is the same class of defect, pointed
    // the other way, as letting an evicted one read as whole.
    const ownPruned = agg.byDir == null ? agg.pruned : (agg.byDir.closes?.pruned ?? 0);
    const siblingPruned = agg.pruned - ownPruned;
    if (file.truncated > 0 || ownPruned > 0 || agg.sweep === 'failed') {
      args.log?.warn(
        'TRA-2688 close ledger is INCOMPLETE or evicted under budget — do not read it as a full census',
        { ...result },
      );
    } else {
      args.log?.info('TRA-2688 close ledger written', { ...result });
      // The sibling eviction is NOT suppressed by the narrowing above — it is
      // RESTATED here, at the write it did not damage, so narrowing the warn
      // cannot delete the surface that made the overage visible in the first
      // place. Its own `TRA-4156 per-directory ledger budget exceeded` line
      // (emitted once per sweep) remains the primary record.
      if (siblingPruned > 0) {
        args.log?.warn(
          'TRA-4156 a SIBLING ledger pool evicted during this write — this closes/ census is COMPLETE',
          { ...result, siblingPruned },
        );
      }
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
 * the memo the fleet can exceed the budgets by at most ONE session's writes
 * (~62 books x ~90 KB ~= 5.6 MB, i.e. under 12% of the 48 MiB `closes/` cap)
 * before the next date's first EOD reclaims it. A restart clears the memo and
 * simply re-runs an idempotent prune, which is the safe direction.
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
async function ledgerBudgetDirs(
  usersRoot: string,
): Promise<Array<{ path: string; kind: (typeof LEDGER_BUDGET_DIRS)[number] }>> {
  const out: Array<{ path: string; kind: (typeof LEDGER_BUDGET_DIRS)[number] }> = [];
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
        for (const sub of LEDGER_BUDGET_DIRS) {
          out.push({ path: join(rootPath, mode.name, sub), kind: sub });
        }
      }
    }
  }
  return out;
}

/**
 * Hold the PER-DIRECTORY ceilings ({@link LEDGER_BUDGET_LIMITS}) across every
 * bucket, evicting oldest-first WITHIN each directory type.
 *
 * TRA-4156 Phase 1. This ran as one shared 64 MiB pool from the TRA-2654
 * ruling until 2026-09: leg 2's tape filled it, and "the globally oldest
 * session is the right thing to give up" then meant the LIVE book's closes
 * were evicted to make room for tape — a bound on the right total protecting
 * the wrong files. The pool is now denominated per directory type: a `tape/`
 * overage can only evict `tape/` files, and `closes/` likewise. Within a
 * type, "oldest" is still the filename's ISO date across ALL books, ties
 * breaking on path so the order is deterministic.
 *
 * NEVER THROWS.
 */
export async function enforceAggregateLedgerBudget(args: {
  usersRoot?: string;
  date: string;
  /**
   * Test seam — per-directory ceiling overrides, keyed like
   * {@link LEDGER_BUDGET_LIMITS}. Directories not named keep their defaults.
   */
  limits?: Partial<Record<(typeof LEDGER_BUDGET_DIRS)[number], number>>;
  /** Test seam — bypass the once-per-date memo. */
  force?: boolean;
  log?: LedgerLog;
}): Promise<{
  sweep: CloseLedgerWriteResult['aggregateSweep'];
  pruned: number;
  bytes?: number;
  byDir?: Record<string, { bytes: number; maxBytes: number; pruned: number }>;
}> {
  const { usersRoot } = args;
  if (!usersRoot) return { sweep: 'skipped_no_root', pruned: 0 };
  if (!args.force && aggregateSweptForDate === args.date) {
    return { sweep: 'skipped_already_run', pruned: 0 };
  }
  try {
    const filesByKind: Record<string, Array<{ path: string; name: string; size: number }>> = {};
    const totals: Record<string, number> = {};
    for (const kind of LEDGER_BUDGET_DIRS) {
      filesByKind[kind] = [];
      totals[kind] = 0;
    }
    for (const { path: dir, kind } of await ledgerBudgetDirs(usersRoot)) {
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
          filesByKind[kind].push({ path: join(dir, name), name, size: st.size });
          totals[kind] += st.size;
        } catch {
          // Vanished between readdir and stat (a concurrent prune). It is not
          // in the pool, so it is not in the total either.
        }
      }
    }
    let prunedAll = 0;
    let bytesAll = 0;
    const byDir: Record<string, { bytes: number; maxBytes: number; pruned: number }> = {};
    for (const kind of LEDGER_BUDGET_DIRS) {
      const maxBytes = args.limits?.[kind] ?? LEDGER_BUDGET_LIMITS[kind];
      let total = totals[kind];
      let pruned = 0;
      if (total > maxBytes) {
        const files = filesByKind[kind];
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
        args.log?.warn('TRA-4156 per-directory ledger budget exceeded — evicted oldest sessions', {
          issue: 'TRA-4156',
          dir: kind,
          maxBytes,
          bytesAfter: total,
          prunedForAggregate: pruned,
        });
      }
      byDir[kind] = { bytes: total, maxBytes, pruned };
      prunedAll += pruned;
      bytesAll += total;
    }
    aggregateSweptForDate = args.date;
    return { sweep: 'ran', pruned: prunedAll, bytes: bytesAll, byDir };
  } catch (err: unknown) {
    args.log?.warn('TRA-2688 ledger budget sweep failed', {
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
