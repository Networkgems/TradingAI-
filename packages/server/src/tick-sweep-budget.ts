// TRA-2262 (parent TRA-2203, grandparent TRA-2171) — a per-tick wall-clock
// BUDGET plus a rotating CURSOR for the three `signal.doTick` fan-out sinks.
//
// ── What this bounds, and why a throttle cannot ──────────────────────────────
// TRA-2203's complete Friday 2026-07-24 RTH tape (3.4% unattributed, n=5,944,
// boot-excluded) attributed `signal.doTick` (n=2,152, Σ 60,107.6s, p90 59.4s,
// max 1,214.9s) to four sinks. Three of them are the same defect — an unbounded
// whole-universe walk sitting behind a time throttle:
//
//   sink                  Σ share    p90       max
//   short-premium-scan     34.7%   109.8s    293.0s   (fully sequential)
//   otm-scan               14.7%   110.5s    213.8s   (fully sequential)
//   mtf-refresh            12.0%   106.9s    935.1s   (BATCH=5, 114 rounds)
//
// ⭐ The Σ-leader is NOT the tail owner: `mtf-refresh` is fourth by Σ and owns
// 77% of the single worst tick. The cap here is sized off max/p90, never Σ.
//
// ⛔ Widening the interval constants is the WRONG knob. TRA-2205 settled it: a
// throttle bounds FREQUENCY, never MAGNITUDE. Firing a 935s scan half as often
// leaves the 935s excursion exactly where it is — and the quantity gating the
// live arm is a max, because on the real-money book TRA-2200's exit hoist is
// still deferred, so `exit-evaluation interval ≡ doTick duration` STILL HOLDS
// there. Friday's worst-case live exit latency is 1,214.9s = 20m15s.
//
// ── The bound ────────────────────────────────────────────────────────────────
// Each sink gets {@link SWEEP_BUDGET_MS} of wall clock per invocation. When the
// budget runs out the pass STOPS and records the symbol to resume at; the next
// invocation picks up exactly there and the universe is still covered — across
// N passes instead of one.
//
// ── Preserving coverage and the feed rate ────────────────────────────────────
// Chopping a sink into slices WITHOUT letting it re-enter divides its
// symbols-per-minute by the number of slices, so a bound bought naively is a
// coverage cut wearing a latency win. Two things stop that here:
//
//  1. an UNFINISHED sweep re-enters on the NEXT TICK ({@link SWEEP_RESUME_INTERVAL_MS}
//     = 0) rather than on the sink's own 5-minute throttle;
//  2. the budget is sized so one pass per 30s tick reproduces today's
//     symbols-per-minute.
//
// (1) cannot become a feed-quota regression — the hazard behind TRA-1996 — and
// the reason is structural, not empirical: these sweeps are latency-bound, so
// spending at most B ms of wall clock every T >= B ms can never exceed the
// throughput of spending it back-to-back, which is what the unbounded sweep
// already does. Slicing a serial walk can only LOWER its request rate.
//
// ── 🔴 The sizing, re-derived — and it moved: 10s → 30s ──────────────────────
// TRA-2262's own ticket specified "10s per sink ≈ 30 symbols/tick", derived as
// `935.1s / 568 = 1.65 s/symbol at BATCH=5`. **That double-counts the batch.**
// 935.1s is the wall clock of the whole fan-out, so 1.65 s/symbol is ALREADY
// amortised over the 5-wide rounds (114 rounds × 8.23s). A 10s budget therefore
// buys 6 symbols, not 30 — a full watchlist sweep in 95 passes ≈ 47 min against
// ~15.6 min today, a 3× coverage regression. The ticket said "re-derive this
// from the tape before shipping — do not inherit my arithmetic unchecked"; this
// is that re-derivation, and it changes the number.
//
//   sink                 max/568 = s/sym   syms @30s   sweep @1 pass/30s   today
//   mtf-refresh                    1.646        18.2         16.0 min      15.6
//   short-premium-scan             0.516        58.2          5.0 min       4.9
//   otm-scan                       0.376        79.7          4.0 min       3.6
//
// 30s lands all three within ~10% of today's sweep duration AND today's feed
// rate. It is not a split-the-difference number: it is the point where the
// bound is free in coverage terms.
//
// ⭐ What buying MORE tail would cost. The tick's residual — `cold-bar-scan`
// (max 205.9s) plus everything not in this ticket's scope — is 279.8s of the
// 1,214.9s worst tick. So the graded max lands at 3B + ~280s:
//
//   B = 10s → 309.8s (5.2 min)    B = 30s → 369.8s (6.2 min)    B = 60s → 459.8s
//
// i.e. dropping 30s → 10s buys 60s off a ~370s tick (16%) and costs 3× the
// coverage on every sink. The tail below ~280s is NOT purchasable here at any
// budget — it belongs to `cold-bar-scan`, which this ticket does not scope.
// Either way the number gating the live arm falls from 20m15s to ~6m.
//
// The residual coverage cost is payable on its own terms: the cold sweep's
// stated job is keeping cold symbols warm for the analysts, and
// `getOrComputeTechnicalSnapshot` already computes on demand for any analyst
// query that outruns it.
//
// ── Later callers of this helper ─────────────────────────────────────────────
// TRA-2477 added a FOURTH sink, `supertrend-series` — n=168, share 2.3%, p90
// 25.8s, max 381.1s on the boot-excluded 07-28 tape, i.e. the worst single stall
// of that window on a 2.3% Σ share. It reuses {@link SWEEP_BUDGET_MS} unchanged,
// and the justification is the p90 rather than new arithmetic: 25.8s < 30s, so
// the modal rotation is never truncated and the cap bites only the tail.
// ⚠️ It also needed something the three sinks above did not — the shadow pass
// coordinates ACROSS ENGINES, so slicing a sink whose start stamps a fleet-wide
// window means the window must advance once per ROTATION, not once per slice.
// See `_sharedShadowRotationPending` in signal-engine.ts before budgeting any
// further sink that has a fleet-wide claim in front of it.
//
// ── Why the cursor is persisted ──────────────────────────────────────────────
// A zero-init cursor on a box that boots ~6× a session is TRA-2205's bug with
// the sign flipped: instead of re-firing a sink on every boot it would restart
// every sweep at index 0, so the HEAD of the watchlist is refreshed constantly
// and the TAIL is systematically starved — a bias that is invisible in every
// aggregate. The cursor is therefore mirrored to disk (best-effort, throttled).
// In-memory stays authoritative: an unwritable DATA_DIR degrades to the
// zero-init behaviour rather than failing the tick.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

const log = logger.child({ module: 'tick-sweep-budget' });

// TRA-2603 — resolve through the one predicate (TRA-1681), NOT the inlined
// `env.DATA_DIR ?? join(__dirname, '..', 'data')` literal this line used to hold.
// (Deliberately not quoted verbatim: `check:data-dir` greps for that shape, and a
// copy of it in a comment is a phantom hit — the fixed file should drop out of the
// sweep, not need an exemption.) That literal takes the env branch for a
// present-but-blank value, because `' '` is truthy and `??` only guards
// null/undefined; `resolveDataDir` also requires `.trim()`. Blank-but-
// present is a state bqb1 has reached twice (TRA-2136 / TRA-2193 / TRA-2195), and
// it fails SILENTLY here: the mirror lands in a directory literally named `" "`
// relative to the launch cwd, `mkdirSync`/`writeFileSync` both succeed, and
// `flushCursors` swallows errors by design — so every cursor silently resets to
// zero-init on the next boot, which is precisely the tail-starvation bias this
// module exists to prevent.
//
// `data-dir.ts` imports only `path` and `url`, so it stays a leaf and this cannot
// recreate the barrel/cycle shape of TRA-1684.
const DATA_DIR = resolveDataDir();
const CURSOR_PATH = join(DATA_DIR, 'scan-cursors.json');

/**
 * Wall-clock a single sink may spend inside one `doTick` invocation. Sized off
 * the tape's max/p90, never its Σ (the Σ-leader is not the tail owner), and off
 * the coverage-parity point rather than the smallest number that sounds bold —
 * see the sizing table above. The three bounded sinks together move from a
 * worst case of ~1,442s to ~90s, taking the worst tick from 1,214.9s to ~370s.
 */
export const SWEEP_BUDGET_MS = 30_000;

/**
 * How long a caller should wait before re-entering a sink whose sweep is
 * UNFINISHED: the next tick. A sliced latency-bound walk cannot exceed the
 * request rate of the unsliced one it replaces, so resuming at tick cadence is
 * the setting that preserves coverage AND stays under the feed quota.
 */
export const SWEEP_RESUME_INTERVAL_MS = 0;

/** Minimum gap between disk mirrors of the cursor map (the map is tiny; the tick is not). */
const CURSOR_FLUSH_MIN_MS = 15_000;

/** What one budgeted pass did. Callers drive their re-entry interval off `complete`. */
export interface SweepPass {
  /** Symbols visited this pass, in universe order. */
  processed: string[];
  /** Total size of the universe this pass was walking. */
  total: number;
  /** Index the pass started at (0 on a fresh sweep). */
  startIndex: number;
  /**
   * True iff the pass reached the end of the universe. `false` means the cursor
   * is parked mid-universe and the caller should re-enter on
   * {@link SWEEP_RESUME_INTERVAL_MS} — UNLESS {@link stopped} is also true.
   */
  complete: boolean;
  /** True iff the budget (rather than the end of the universe) ended the pass. */
  budgetExhausted: boolean;
  /** True iff the worker asked to stop early (a caller-side gate, not the budget). */
  stopped: boolean;
  /** Symbol the next pass resumes at, or null once the sweep is complete. */
  resumeAt: string | null;
  /** Wall clock the pass consumed. */
  elapsedMs: number;
}

/**
 * Per-sink resume position. Values are SYMBOLS, not indices: the universe of a
 * sink changes between passes (active-interest membership churns, the watchlist
 * is edited), and an index into a list that has shifted resumes at an arbitrary
 * place, silently. A symbol that has left the universe is unambiguous — the
 * sweep restarts.
 */
export interface SweepCursorStore {
  get(key: string): string | null;
  set(key: string, symbol: string): void;
  clear(key: string): void;
}

// ── The persisted default store ──────────────────────────────────────────────

let cursors: Record<string, string> | null = null;
let lastFlushAt = 0;
let flushPending = false;
/** Set once a disk read/write has failed, so we degrade quietly instead of logging per tick. */
let diskDisabled = false;

function loadCursors(): Record<string, string> {
  if (cursors) return cursors;
  cursors = {};
  try {
    const raw = JSON.parse(readFileSync(CURSOR_PATH, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) cursors[k] = v;
      }
    }
  } catch {
    // Absent (first boot) or corrupt — either way a fresh sweep is correct, and
    // the next flush rewrites the file.
  }
  return cursors;
}

function flushCursors(now: number, force: boolean): void {
  if (diskDisabled) return;
  if (!force && now - lastFlushAt < CURSOR_FLUSH_MIN_MS) {
    flushPending = true;
    return;
  }
  lastFlushAt = now;
  flushPending = false;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CURSOR_PATH, JSON.stringify(loadCursors()), 'utf8');
  } catch (err) {
    diskDisabled = true;
    log.warn('scan-cursor mirror disabled (in-memory only)', {
      path: CURSOR_PATH,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The process-wide cursor store. Reads are in-memory; writes mirror to
 * `DATA_DIR/scan-cursors.json` at most once per {@link CURSOR_FLUSH_MIN_MS}, so
 * a crash loses at most that much cursor position — orders of magnitude better
 * than the zero-init restart it replaces, at no per-tick IO cost.
 */
export const sweepCursors: SweepCursorStore = {
  get(key) {
    return loadCursors()[key] ?? null;
  },
  set(key, symbol) {
    const map = loadCursors();
    if (map[key] === symbol) return;
    map[key] = symbol;
    flushCursors(Date.now(), false);
  },
  clear(key) {
    const map = loadCursors();
    if (!(key in map)) return;
    delete map[key];
    // A completed sweep is worth persisting promptly: it is the one transition
    // where a stale mirror would resume a sweep that has already finished.
    flushCursors(Date.now(), true);
  },
};

/** Current resume positions, for `GET /api/health/*` surfaces and the tape grader. */
export function sweepCursorSnapshot(): Record<string, string> {
  return { ...loadCursors() };
}

/** Test seam — drop every cursor and re-enable the disk mirror. */
export function resetSweepCursors(): void {
  cursors = {};
  lastFlushAt = 0;
  flushPending = false;
  diskDisabled = false;
}

/** Write any throttle-deferred cursor mirror. Called on shutdown; safe to call anywhere. */
export function flushSweepCursors(): void {
  if (flushPending) flushCursors(Date.now(), true);
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface BudgetedSweepOptions {
  /**
   * Cursor key. Namespace it per ENGINE — and an engine is a BOOK, not a mode
   * (`${mode}:${user}:${sink}`, see `SignalEngine.sweepKey`). A mode-only key is
   * shared by every per-user engine of that mode (TRA-4519).
   */
  key: string;
  /** The universe to walk, in a stable order. */
  symbols: readonly string[];
  /**
   * Worker for one batch. Resolve `false` to STOP the sweep here without
   * consuming the budget verdict (a caller-side gate — e.g. an options daily
   * cap — rather than the clock). The cursor is left on the un-run batch.
   */
  run: (batch: string[]) => Promise<boolean | void>;
  /** Wall-clock budget; defaults to {@link SWEEP_BUDGET_MS}. */
  budgetMs?: number;
  /** Symbols per batch. 1 (default) walks sequentially; >1 fans out per round. */
  batchSize?: number;
  /** Cursor store; defaults to the persisted {@link sweepCursors}. */
  cursors?: SweepCursorStore;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * Walk `symbols` from the stored cursor, one batch at a time, stopping once the
 * wall-clock budget is spent, and record where to resume.
 *
 * Invariants that matter more than the budget itself:
 *  • **Forward progress.** At least one batch runs per pass even if the budget
 *    is already blown by a single slow batch, so a pathological symbol can
 *    never wedge the cursor.
 *  • **The budget is checked AFTER a batch, never before.** A pre-check cannot
 *    bound anything — the overrun is always the batch already in flight — and a
 *    pre-check plus an empty budget is how you get a sweep that does nothing.
 *  • **A throw still advances the cursor** (try/finally), so a batch that fails
 *    every pass cannot livelock the sweep at one position. Per-symbol errors
 *    are the callers' business; they all swallow their own already.
 */
export async function runBudgetedSweep(opts: BudgetedSweepOptions): Promise<SweepPass> {
  const {
    key,
    symbols,
    run,
    budgetMs = SWEEP_BUDGET_MS,
    batchSize = 1,
    cursors: store = sweepCursors,
    now = Date.now,
  } = opts;

  const size = Math.max(1, Math.floor(batchSize));
  const startedAt = now();

  if (symbols.length === 0) {
    store.clear(key);
    return {
      processed: [], total: 0, startIndex: 0, complete: true,
      budgetExhausted: false, stopped: false, resumeAt: null, elapsedMs: 0,
    };
  }

  // Resume position. A cursor naming a symbol that has left the universe means
  // the universe changed under us; restarting is the only honest answer (and is
  // self-correcting — the next pass parks a cursor that does exist).
  const resumeSymbol = store.get(key);
  const found = resumeSymbol == null ? -1 : symbols.indexOf(resumeSymbol);
  const startIndex = found >= 0 ? found : 0;

  const processed: string[] = [];
  let i = startIndex;
  // Where the cursor is parked. Set to the END of a batch BEFORE that batch is
  // awaited, so a throw out of `run` leaves the cursor past the offending batch
  // rather than on it — a batch that fails every pass must not wedge the sweep.
  let cursorIndex = startIndex;
  let budgetExhausted = false;
  let stopped = false;

  try {
    while (i < symbols.length) {
      const batch = symbols.slice(i, i + size);
      cursorIndex = i + batch.length;
      const verdict = await run(batch);
      if (verdict === false) {
        // A caller-side gate refused this batch — it never ran, so leave the
        // cursor ON it and let the next pass retry from here.
        cursorIndex = i;
        stopped = true;
        break;
      }
      i = cursorIndex;
      processed.push(...batch);
      if (i < symbols.length && now() - startedAt >= budgetMs) {
        budgetExhausted = true;
        break;
      }
    }
  } finally {
    if (cursorIndex >= symbols.length) store.clear(key);
    else store.set(key, symbols[cursorIndex]!);
  }

  const complete = cursorIndex >= symbols.length;
  if (budgetExhausted) {
    // The one positive witness that the bound ARMED and BIT in a given window.
    // Without it a 30s `mtf-refresh` phase on the tape is ambiguous between "the
    // cap truncated a 935s sweep" and "the sweep happened to be short" — and a
    // grader that cannot tell those apart cannot grade this ticket. Emitted only
    // on truncation, so a sink running inside its budget stays silent.
    log.info('doTick sink truncated by its wall-clock budget (TRA-2262)', {
      component: 'tick-sweep-budget',
      sink: key,
      processed: processed.length,
      total: symbols.length,
      startIndex,
      resumeAt: symbols[cursorIndex],
      elapsedMs: Math.round(now() - startedAt),
      budgetMs,
    });
  }
  return {
    processed,
    total: symbols.length,
    startIndex,
    complete,
    budgetExhausted,
    stopped,
    resumeAt: complete ? null : symbols[cursorIndex]!,
    elapsedMs: now() - startedAt,
  };
}

/**
 * The interval a caller should wait before re-entering a sink, given the pass it
 * just ran. An unfinished sweep re-enters fast (so the bound does not become a
 * coverage cut); a finished one — or one a caller-side gate stopped — reverts to
 * the sink's own throttle.
 */
export function nextSweepDelayMs(pass: SweepPass | null, normalIntervalMs: number): number {
  if (!pass || pass.complete || pass.stopped) return normalIntervalMs;
  return Math.min(SWEEP_RESUME_INTERVAL_MS, normalIntervalMs);
}
