// TRA-1463 — synchronous-phase attribution for the event-loop watchdog.
//
// The watchdog (event-loop-watchdog.ts) has proven the residual bqb1 crash is a
// SINGLE continuous ~71-second SYNCHRONOUS event-loop block firing at ~200s of
// uptime (flat RSS ~420MB — NOT OOM). It records the block's MAGNITUDE (max lag
// 71538ms in one window) but NOT which code phase blocked, so root-cause has
// stayed at "3 static suspects" without a way to name the culprit from the box.
//
// Why a live "currentPhase" pointer would read null: the block is synchronous, so
// the watchdog's own setInterval CANNOT fire during it — it only evaluates AFTER
// the loop resumes, by which point any wrapping try/finally has already cleared a
// "current phase" flag. So instead of a live pointer we record, at the END of each
// instrumented synchronous phase, its measured wall duration. A phase that just
// held the loop for ~71s records a ~71s duration into `lastSlowPhase` (+ a small
// ring) in its `finally` — BEFORE returning to the loop — so the very next
// watchdog evaluation (and the trip breadcrumb it persists) names EXACTLY which
// phase blocked. This converts the 3 static suspects into 1 named culprit with
// ZERO reproduction and zero Render-log access.
//
// Observability only: the overhead is two Date.now() reads per instrumented
// phase, and only phases that block >= PHASE_TIMING_SLOW_MS (default 1s) are ever
// recorded. Wrap SYNCHRONOUS sections only — an awaited async op yields the loop,
// so its wall time is dominated by I/O and would mislabel a non-blocking phase.

import { logger } from './observability/index.js';

const log = logger.child({ module: 'phase-timing' });

/**
 * TRA-2111 — how a recorded phase's wall duration relates to event-loop lag.
 *
 * - `sync`: recorded by {@link timeSyncPhase} around a PURELY synchronous section.
 *   Its wall duration IS event-loop-block time — a `sync` entry of 5s means the
 *   loop was starved for ~5s. This is the ONLY kind that attributes a health-check
 *   block / watchdog `block` trip to a culprit.
 * - `async`: recorded by {@link withPhase} around a whole async tick/driver. Its
 *   wall duration INCLUDES awaited I/O, so a slow `async` entry is NOT a block — a
 *   `signal.doTick` async entry of 13s during a both-feeds-down stampede is the
 *   awaited fetchQuotes fan-out (8s budget + retries), with peak loop lag ~35ms.
 *   Kept for tick-latency visibility, but MUST NOT be read as a block.
 *
 * Before this tag the two were indistinguishable in the ring: a 13s I/O tick and a
 * 13s sync block looked identical, and an I/O tick could overwrite (poison) the
 * `lastSlowPhase` a watchdog trip breadcrumb then blamed. Read {@link
 * PhaseAttribution.lastSlowSyncPhase} to find the residual synchronous burst.
 */
export type PhaseKind = 'sync' | 'async';

/** A completed phase whose wall time crossed the slow threshold. */
export interface SlowPhase {
  /** Stable phase label (e.g. `crypto.doTick`, `signal.doTick`, `ledger.hydrate`). */
  name: string;
  /** Measured wall duration, ms (rounded). For `sync` this is loop-block time. */
  durationMs: number;
  /** Wall-clock (ms) when the phase completed. */
  atMs: number;
  /** Whether the duration is a pure-sync block (`sync`) or includes awaited I/O (`async`). */
  kind: PhaseKind;
}

/**
 * Threshold (ms) above which a completed synchronous phase is recorded. Default
 * 1000ms: a phase that holds the loop >= 1s is already a health-check risk, and
 * the 71s bqb1 block dwarfs it. Env-tunable via PHASE_TIMING_SLOW_MS to tighten
 * during diagnosis without a redeploy of the threshold constant.
 */
function resolveSlowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['PHASE_TIMING_SLOW_MS'];
  const n = raw != null && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1_000;
}

/**
 * How many slow phases the ring retains.
 *
 * TRA-2200 (raised 16 → 512, parent TRA-2171). At 16 slots the ring held only
 * ~10 MINUTES of a 6.4-hour session at the observed slow-phase rate: the
 * 2026-07-23 post-close read of `/api/health/watchdog` returned 16/16 coarse
 * `signal.doTick` entries spanning 22:58:02Z→23:08:06Z and ZERO sub-labels, so
 * the attribution had to be reconstructed from the Render log tape instead. That
 * is worse than a gap — it reads as a POSITIVE "the sub-labels are missing",
 * i.e. an instrumentation-bug verdict, when the sub-labels were in fact emitting
 * all session. An instrument whose default read is a confident falsehood is a
 * trap, not a gap.
 *
 * 512 covers a full RTH session at the 2026-07-23 rate (1,451 parent + 1,086
 * child slow phases across 3 engines ≈ 2,537 records / 6.4h ≈ 400/h, so ~1.3h of
 * memory) and still bounds the array: each `SlowPhase` is 4 primitive fields plus
 * a short interned label, so 512 entries is single-digit KB — invisible against
 * the ~420MB RSS this box runs at. Env-tunable so a diagnosis window can widen it
 * without a redeploy of the constant, matching `PHASE_TIMING_SLOW_MS`.
 *
 * This does NOT make a post-close read of a whole session reliable — the durable
 * Render log tape (`module:"phase-timing"`) is still the only complete source.
 * It makes the LIVE read stop lying at ordinary session length.
 */
function resolveRingMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['PHASE_TIMING_RING_MAX'];
  const n = raw != null && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 512;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4920 — the SINCE-BOOT SYNC CENSUS.
//
// `recentSlowPhases` is a FIFO ring, and that makes it structurally unable to
// answer the only question a residual `yield-preempt` block raises: HOW MANY,
// and are they trending up?
//
// The mechanism is EVICTION, not exclusion — and the distinction matters,
// because the 2026-09-25 reading that opened this issue was read as exclusion.
// `recordPhaseDuration` pushes every record past the slow threshold into the
// ring regardless of `kind`, so a `sync` witness IS written there. But `async`
// records outnumber `sync` ones by orders of magnitude on this box (the ring
// read 512/512 `async` at 19:48Z while a `sync` witness from 19:01:20Z was
// still latched in `lastSlowSyncPhase`), so a rare `sync` record is shifted out
// of a 512-slot FIFO within minutes. The ring's retention horizon is set by the
// ASYNC rate; the thing we need to count arrives at the SYNC rate. Widening the
// ring does not fix that — it only moves the horizon.
//
// So: a monotonic, never-evicting census of `kind: 'sync'` records, alongside
// the ring rather than inside it. Three properties the ring cannot have:
//
//  - MONOTONIC `count`. It only ever rises, so "is this trending up" is two
//    reads on one boot instead of an anecdote. (Process-resident: it dies with
//    the pid like everything else here, so re-derive `build.pid`/`startedAt` in
//    the same heartbeat as any read of it.)
//  - A LOWER INTAKE FLOOR than the ring. The ring records at
//    PHASE_TIMING_SLOW_MS (1000ms). The census takes `sync` records from
//    SYNC_BLOCK_CENSUS_MIN_MS (250ms) up, bucketed, so the approach to 1000ms
//    is visible BEFORE a 1000ms block exists to be seen. A residual that decays
//    back toward the 5s health budget crosses 250 → 500 → 1000 first.
//  - PHASE NAMES retained per-bucket. The `yield-preempt@<phase>` witness is
//    never the culprit (see {@link SyncSliceMeter}) but it is diagnostically
//    load-bearing: it says the block was FOREIGN uninstrumented work observed
//    from <phase>'s yield, which is the opposite verdict from a `#slice`.
//
// ⚠️ A counter that reads 0 when the box is quiet AND when the tagger is broken
// is worse than no counter. The discriminating control is in
// `phase-timing.test.ts` (TRA-4920): the SAME real ≥1s sync yield-preempt,
// recorded through the SAME live call, with one flag (`heldTurns`) moved —
// census 1 when tagged `sync`, census 0 when the shipped `heldTurns > 0` branch
// re-tags it `async`. That is the live mis-tag path, not a synthetic mutant.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Census intake floor (ms) for `kind: 'sync'` records. Default 250 — a quarter
 * of the ring's 1000ms threshold, so the 250/500 buckets show a residual
 * climbing toward a block before it becomes one. Env-tunable for a diagnosis
 * window, exactly like PHASE_TIMING_SLOW_MS.
 */
function resolveSyncCensusMinMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['SYNC_BLOCK_CENSUS_MIN_MS'];
  const n = raw != null && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 250;
}

/**
 * Bucket edges (ms), FIXED and independent of the intake floor. 1000 is the
 * ring/latch threshold and 5000 is Render's HTTP health-check budget, so a
 * reader can map a bucket straight onto a consequence without interpolating.
 * Raising the floor above an edge simply leaves that bucket at 0 — which is why
 * `thresholdMs` is published beside the buckets.
 */
export const SYNC_CENSUS_BUCKET_EDGES_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const SYNC_CENSUS_BUCKET_KEYS = ['250-499', '500-999', '1000-1999', '2000-4999', '5000+'] as const;
export type SyncCensusBucketKey = (typeof SYNC_CENSUS_BUCKET_KEYS)[number];

/** How many distinct phase names the census keeps before folding into `__other__`. */
const SYNC_CENSUS_NAME_MAX = 64;

/** Per-phase-name roll-up inside the census. */
export interface SyncCensusName {
  count: number;
  maxMs: number;
  lastAtMs: number;
}

/** TRA-4920 — monotonic since-boot census of `kind: 'sync'` phase records. */
export interface SyncBlockCensus {
  /** Intake floor actually in force (ms). Buckets below it can never fill. */
  thresholdMs: number;
  /** Total `sync` records at/above `thresholdMs` since boot. Never decremented. */
  count: number;
  /** Of those, how many reached 1000ms — the ring/latch threshold. */
  countAtOrOver1s: number;
  /** Largest `sync` duration seen since boot, and who/when. */
  maxMs: number;
  maxName: string | null;
  maxAtMs: number | null;
  /** First and most-recent intake (ms epoch), so a rate can be derived. */
  firstAtMs: number | null;
  lastAtMs: number | null;
  /** Fixed-edge duration histogram. */
  buckets: Record<SyncCensusBucketKey, number>;
  /**
   * Per-phase-name roll-up. Symbol ranges inside `#slice[..]`/`#span[..]` are
   * collapsed to `[…]` so a per-symbol label cannot explode cardinality;
   * `yield-preempt@<phase>` names are kept verbatim.
   */
  byName: Record<string, SyncCensusName>;
  /** Records folded into `__other__` because `byName` was full. */
  namesTruncated: number;
}

const OTHER_NAME = '__other__';

/**
 * The lower of the ring threshold and the census floor — the point past which a
 * duration is interesting to SOMETHING. Used by {@link SyncSliceMeter} so a
 * caller-side filter can never be tighter than the tightest consumer.
 */
function minIntakeMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(resolveSlowMs(env), resolveSyncCensusMinMs(env));
}

function emptyBuckets(): Record<SyncCensusBucketKey, number> {
  return { '250-499': 0, '500-999': 0, '1000-1999': 0, '2000-4999': 0, '5000+': 0 };
}

let censusCount = 0;
let censusCountAtOrOver1s = 0;
let censusMaxMs = 0;
let censusMaxName: string | null = null;
let censusMaxAtMs: number | null = null;
let censusFirstAtMs: number | null = null;
let censusLastAtMs: number | null = null;
let censusBuckets = emptyBuckets();
let censusByName = new Map<string, SyncCensusName>();
let censusNamesTruncated = 0;

/** Collapse an unbounded symbol range so `byName` cardinality stays bounded. */
function censusNameKey(name: string): string {
  return name.replace(/(#(?:slice|span))\[[^\]]*\]/, '$1[…]');
}

function bucketKeyFor(durationMs: number): SyncCensusBucketKey {
  // Walk down: the highest edge the duration reaches wins.
  for (let i = SYNC_CENSUS_BUCKET_EDGES_MS.length - 1; i >= 0; i -= 1) {
    if (durationMs >= SYNC_CENSUS_BUCKET_EDGES_MS[i]!) return SYNC_CENSUS_BUCKET_KEYS[i]!;
  }
  // Below the lowest edge only reachable when SYNC_BLOCK_CENSUS_MIN_MS < 250;
  // it still belongs to the bottom bucket rather than being dropped.
  return SYNC_CENSUS_BUCKET_KEYS[0]!;
}

function noteSyncCensus(name: string, durationMs: number, atMs: number, env: NodeJS.ProcessEnv): void {
  if (!(durationMs >= resolveSyncCensusMinMs(env))) return;
  const ms = Math.round(durationMs);
  censusCount += 1;
  if (ms >= 1_000) censusCountAtOrOver1s += 1;
  if (ms > censusMaxMs) {
    censusMaxMs = ms;
    censusMaxName = name;
    censusMaxAtMs = atMs;
  }
  if (censusFirstAtMs === null) censusFirstAtMs = atMs;
  censusLastAtMs = atMs;
  censusBuckets[bucketKeyFor(ms)] += 1;
  const key = censusNameKey(name);
  const existing = censusByName.get(key);
  if (existing) {
    existing.count += 1;
    if (ms > existing.maxMs) existing.maxMs = ms;
    existing.lastAtMs = atMs;
    return;
  }
  if (censusByName.size >= SYNC_CENSUS_NAME_MAX) {
    censusNamesTruncated += 1;
    const other = censusByName.get(OTHER_NAME);
    if (other) {
      other.count += 1;
      if (ms > other.maxMs) other.maxMs = ms;
      other.lastAtMs = atMs;
    } else {
      // Evicting one named row to make room for `__other__` is still strictly
      // better than silently dropping every new name with no tell.
      const victim = censusByName.keys().next().value as string | undefined;
      if (victim !== undefined) censusByName.delete(victim);
      censusByName.set(OTHER_NAME, { count: 1, maxMs: ms, lastAtMs: atMs });
    }
    return;
  }
  censusByName.set(key, { count: 1, maxMs: ms, lastAtMs: atMs });
}

/** Read the since-boot sync census (TRA-4920). */
export function getSyncBlockCensus(env: NodeJS.ProcessEnv = process.env): SyncBlockCensus {
  return {
    thresholdMs: resolveSyncCensusMinMs(env),
    count: censusCount,
    countAtOrOver1s: censusCountAtOrOver1s,
    maxMs: censusMaxMs,
    maxName: censusMaxName,
    maxAtMs: censusMaxAtMs,
    firstAtMs: censusFirstAtMs,
    lastAtMs: censusLastAtMs,
    buckets: { ...censusBuckets },
    byName: Object.fromEntries([...censusByName].map(([k, v]) => [k, { ...v }])),
    namesTruncated: censusNamesTruncated,
  };
}

let lastSlowPhase: SlowPhase | null = null;
let lastSlowSyncPhase: SlowPhase | null = null;
const recentSlowPhases: SlowPhase[] = [];

/**
 * Record a completed phase's duration.
 *
 * TRA-4920 — TWO thresholds, deliberately different:
 *  - the SYNC CENSUS takes `kind: 'sync'` records from SYNC_BLOCK_CENSUS_MIN_MS
 *    (250ms) up, and never evicts;
 *  - the ring / `lastSlowPhase` / `lastSlowSyncPhase` / the log line stay on
 *    PHASE_TIMING_SLOW_MS (1000ms) exactly as before, so every existing reader
 *    and every persisted trip breadcrumb is byte-unchanged.
 *
 * `kind` defaults to `sync` (the module's original pure-sync-block contract) so
 * existing direct callers keep block semantics; {@link withPhase} passes `async`.
 */
export function recordPhaseDuration(
  name: string,
  durationMs: number,
  atMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  kind: PhaseKind = 'sync',
): void {
  // TRA-4920 — census intake FIRST, and only for `sync`: an `async` record's
  // wall time includes awaited I/O and is not loop-block time, so folding one
  // in would make the count unreadable as a block count.
  if (kind === 'sync') noteSyncCensus(name, durationMs, atMs, env);
  if (!(durationMs >= resolveSlowMs(env))) return;
  const rec: SlowPhase = { name, durationMs: Math.round(durationMs), atMs, kind };
  lastSlowPhase = rec;
  // TRA-2111 — keep a separate pointer to the last PURE-SYNC block so an awaited
  // `async` tick (I/O-bound, loop NOT starved) can never overwrite the culprit a
  // block diagnosis reads. `recentSlowPhases` still carries both, tagged.
  if (kind === 'sync') lastSlowSyncPhase = rec;
  recentSlowPhases.push(rec);
  // TRA-2200 — `resolveRingMax` is read per-record (not captured once) so a
  // PHASE_TIMING_RING_MAX change takes effect without a restart, and so a SHRINK
  // drains the ring instead of leaving it permanently over the new cap.
  const ringMax = resolveRingMax(env);
  while (recentSlowPhases.length > ringMax) recentSlowPhases.shift();
  // A single log line at record time is the live Render-log breadcrumb; the
  // persisted watchdog trip is the after-death one. Only a `sync` phase actually
  // held the loop — an `async` entry is a slow tick, not a block.
  log.warn(
    kind === 'sync' ? 'slow synchronous phase held the event loop' : 'slow async phase (I/O-bound tick, not a loop block)',
    { phase: name, durationMs: rec.durationMs, kind },
  );
}

/**
 * Run a SYNCHRONOUS phase, measuring the wall time it holds the loop and
 * recording it if it crosses the slow threshold. Returns the callback's result
 * and re-throws unchanged — the timing is taken in `finally`, so an exception is
 * still attributed. Use this ONLY around synchronous sections; do not wrap an
 * `await` in the callback, or the recorded duration will include yielded I/O time
 * and mislabel a non-blocking phase.
 */
export function timeSyncPhase<T>(name: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    recordPhaseDuration(name, Date.now() - start, Date.now(), process.env, 'sync');
  }
}

/**
 * The named phase currently IN FLIGHT. Set on {@link withPhase} entry and cleared
 * on exit. Unlike {@link lastSlowPhase} (a COMPLETED duration) this is a LIVE
 * pointer: when a synchronous block happens inside an async tick, the tick's
 * promise is still pending, so `currentPhase` stays set through the block and the
 * subsequent awaits — meaning the watchdog's next post-block evaluation reads the
 * subsystem that was executing. This is the primary "which tick blocked" signal;
 * `lastSlowPhase` is the backup for a block that is the very last op before the
 * async fn returns (which clears the pointer before the watchdog can sample).
 */
let currentPhase: { name: string; startedAtMs: number } | null = null;

/** Read the in-flight phase pointer (null when no instrumented phase is running). */
export function getCurrentPhase(): { name: string; startedAtMs: number } | null {
  return currentPhase;
}

/**
 * Run an async phase (a periodic tick / scheduled driver), holding the in-flight
 * {@link currentPhase} pointer for its whole lifetime and recording its wall
 * duration on completion. The wall duration includes awaited I/O, so a slow async
 * phase is NOT necessarily a block — correlate a recorded duration with a watchdog
 * `block` trip (or a high `lagMax`) to confirm the loop was actually starved.
 * Re-entrant safe: restores the prior pointer on exit so nested phases unwind.
 */
export async function withPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = currentPhase;
  const start = Date.now();
  currentPhase = { name, startedAtMs: start };
  try {
    return await fn();
  } finally {
    // TRA-2111 — `async`: wall time includes awaited I/O, so this is NOT a block.
    recordPhaseDuration(name, Date.now() - start, Date.now(), process.env, 'async');
    currentPhase = prev;
  }
}

/**
 * TRA-3660 — sync-SLICE attribution for a cooperative per-symbol loop.
 *
 * Trips #7/#8/#9/#11 (2026-09-03..09-08) were all single clean 6-9s blocks with
 * `slowSyncPhase: null` while a 22s ASYNC envelope (`equity-entry-sweep`,
 * `news-refresh`, `quote-batch`) was in flight. The envelopes are paced by
 * yielders that BOUND a contiguous stretch by yielding once control returns —
 * but the yielders never MEASURE the stretch, so a single un-preemptible slice
 * (one symbol's work, one huge parse) blocks 8s and no instrument names it. And
 * a block by FOREIGN work that runs during the loop's own yield is charged, via
 * the straddle read, to the innocent yielded envelope.
 *
 * This meter closes both gaps from inside the loop (the only place a sync block
 * is visible — the watchdog's timer cannot fire during one):
 *
 * - `endSlice(label)` — called when the loop's yielder decides a yield is due
 *   (and once at loop end). Measures the loop's OWN synchronous slice since the
 *   last boundary; a slow one is recorded as a `sync` phase named
 *   `<phase>#slice[<from>..<to>]`, so the trip breadcrumb carries the symbol
 *   range that blocked instead of the async envelope.
 * - `onYieldResumed(scheduledAtMs, label)` — called when the loop's yield
 *   resolves. The scheduled→resumed delay is time the event loop spent running
 *   OTHER tasks; a slow delay is recorded as `yield-preempt@<phase>`, which
 *   reads as "the loop was starved by uninstrumented work OUTSIDE <phase>,
 *   observed from <phase>'s yield" — the opposite verdict from a slice, and the
 *   one that stops a straddle read from convicting the yielded envelope. The
 *   name is an OBSERVATION, not a culprit: <phase> is the witness, never the
 *   blocker.
 *
 * Slice names are bounded by the ring (512) and only recorded past the slow
 * threshold, so per-symbol labels cannot explode cardinality anywhere that
 * aggregates by name.
 *
 * TRA-3660 (2026-09-09, trip-#13 beat) — the slice window is WALL time between
 * two boundary stamps, and the code between two boundaries may `await` (and 67
 * per-user meters interleave on one loop), so a raw window is NOT own sync
 * time: the live box recorded a 20465ms "#slice" on a boot whose worst loop lag
 * was 1516ms, and three concurrent ~1.16s "#slice"s within 6ms of each other —
 * sync time is exclusive, so at most one could be real. A fabricated sync name
 * landing in a trip's `slowSyncPhase` is the plausible-non-null hazard this
 * meter exists to avoid. The discriminator is the loop itself: a contiguous
 * sync block cannot let a `setImmediate` fire, so a shared one-shot beacon
 * (`armTurnBeacon`) bumps a module-global turn epoch whenever the loop turns
 * over. A slice whose window saw the epoch move provably spans foreign turns
 * and is recorded as `<phase>#span[..]` with kind `async` (wall-clock span,
 * never a block verdict); only an un-turned window records as a `sync` #slice.
 * A mixed window (small await + real sync block inside) demotes to a span and
 * loses the name — an honest span beats a fabricated culprit; the block's own
 * surrounding turns bound it for the other meters' yield-preempt records.
 */
let turnEpoch = 0;
let turnBeaconPending = false;
function armTurnBeacon(): void {
  if (turnBeaconPending) return;
  turnBeaconPending = true;
  setImmediate(() => {
    turnBeaconPending = false;
    turnEpoch++;
  });
}

export class SyncSliceMeter {
  private sliceStartMs = Date.now();
  private sliceStartLabel: string | undefined;
  private sliceStartEpoch: number;
  constructor(
    private readonly phase: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.sliceStartEpoch = turnEpoch;
    armTurnBeacon();
  }

  /** End the current sync slice (yield due / loop end); records it if slow. */
  endSlice(label?: string): void {
    const nowMs = Date.now();
    const durationMs = nowMs - this.sliceStartMs;
    // TRA-4920 — hand off at the LOWER of the two floors. This method used to
    // gate on the ring threshold alone, so a 250-999ms sync record could never
    // reach `recordPhaseDuration` and the census's own lower floor was
    // unreachable from here: the 250/500 buckets would have read 0 forever,
    // which is exactly the "green that cannot go red" this issue is about.
    // `recordPhaseDuration` still decides ring/latch membership on its own
    // threshold, so nothing below 1000ms enters the ring.
    if (durationMs >= minIntakeMs(this.env)) {
      const from = this.sliceStartLabel ?? '<start>';
      const to = label ?? '?';
      if (turnEpoch === this.sliceStartEpoch) {
        recordPhaseDuration(`${this.phase}#slice[${from}..${to}]`, durationMs, nowMs, this.env, 'sync');
      } else {
        // The loop turned over inside this window: awaited I/O and/or foreign
        // tasks ran, so the wall time is a span, not an own sync block.
        recordPhaseDuration(`${this.phase}#span[${from}..${to}]`, durationMs, nowMs, this.env, 'async');
      }
    }
    this.sliceStartMs = nowMs;
    this.sliceStartLabel = label;
    this.sliceStartEpoch = turnEpoch;
    armTurnBeacon();
  }

  /**
   * Stamp the resume of a yield. Records a slow scheduled→resumed delay as
   * `yield-preempt@<phase>` (foreign work starved the loop during the yield),
   * and starts the next slice AT THE RESUME so the yield's queue time is never
   * counted against the loop's own next slice.
   *
   * TRA-4524 — `heldTurns` is how many extra loop turns the process-wide yield
   * gate held this waiter (round-robin behind sibling engines). A held wait
   * spans turns in which timers and I/O ran, so it is NOT one block. It records
   * as `yield-wait@<phase>` with kind `async`, never as a sync verdict (the
   * same rule as the #span demotion above).
   */
  onYieldResumed(scheduledAtMs: number, label?: string, heldTurns = 0): void {
    const nowMs = Date.now();
    const delayMs = nowMs - scheduledAtMs;
    // TRA-4920 — same widening as `endSlice`: the `yield-preempt@*` witness is
    // the record class the census exists to count, so it must not be filtered
    // out one level above the census.
    if (delayMs >= minIntakeMs(this.env)) {
      if (heldTurns > 0) {
        recordPhaseDuration(`yield-wait@${this.phase}`, delayMs, nowMs, this.env, 'async');
      } else {
        recordPhaseDuration(`yield-preempt@${this.phase}`, delayMs, nowMs, this.env, 'sync');
      }
    }
    this.sliceStartMs = nowMs;
    this.sliceStartLabel = label;
    this.sliceStartEpoch = turnEpoch;
    armTurnBeacon();
  }
}

/** Snapshot surfaced by the watchdog + `/api/health/watchdog`. */
export interface PhaseAttribution {
  /**
   * Most-recent completed phase (either kind) that crossed the slow threshold.
   * May be an `async` I/O-bound tick — inspect `.kind` before reading it as a
   * block. To diagnose a health-check block, read {@link lastSlowSyncPhase}.
   */
  lastSlowPhase: SlowPhase | null;
  /**
   * TRA-2111 — most-recent PURE-SYNC (`kind: 'sync'`) phase that crossed the
   * threshold: the residual synchronous burst that starves the loop. Null until a
   * real block is recorded, and never overwritten by a slow `async` tick. This is
   * the field a block diagnosis / watchdog `block` attribution should read.
   */
  lastSlowSyncPhase: SlowPhase | null;
  /**
   * Short ring of prior slow phases (both kinds, tagged), newest last.
   *
   * ⚠️ TRA-4920 — this is a FIFO bounded at PHASE_TIMING_RING_MAX and its
   * retention horizon is set by the `async` arrival rate, which on bqb1 is
   * orders of magnitude above the `sync` rate. A `sync` record IS written here,
   * but it is evicted within minutes. NEVER read "0 sync in the ring" as "no
   * sync blocks" — read {@link syncBlockCensus}, which does not evict.
   */
  recentSlowPhases: SlowPhase[];
  /** The phase IN FLIGHT at read time (the block-in-progress attribution). */
  activePhase: { name: string; elapsedMs: number } | null;
  /**
   * TRA-4920 — monotonic since-boot count + duration histogram of `kind: 'sync'`
   * records from 250ms up, with phase names retained. This is the ONLY surface
   * that answers "how many, and is it trending"; `lastSlowSyncPhase` is a
   * single last-write-wins latch and the ring evicts.
   *
   * Live JSON path: `.watchdog.phaseAttribution.syncBlockCensus`.
   */
  syncBlockCensus: SyncBlockCensus;
}

/** Read the current phase attribution (most-recent slow + sync-only + ring + in-flight + census). */
export function getPhaseAttribution(env: NodeJS.ProcessEnv = process.env): PhaseAttribution {
  return {
    lastSlowPhase,
    lastSlowSyncPhase,
    recentSlowPhases: recentSlowPhases.slice(),
    activePhase: currentPhase
      ? { name: currentPhase.name, elapsedMs: Math.max(0, Date.now() - currentPhase.startedAtMs) }
      : null,
    syncBlockCensus: getSyncBlockCensus(env),
  };
}

/** Test seam — clear the module-global attribution between tests. */
export function _resetPhaseTimingForTests(): void {
  lastSlowPhase = null;
  lastSlowSyncPhase = null;
  recentSlowPhases.length = 0;
  currentPhase = null;
  censusCount = 0;
  censusCountAtOrOver1s = 0;
  censusMaxMs = 0;
  censusMaxName = null;
  censusMaxAtMs = null;
  censusFirstAtMs = null;
  censusLastAtMs = null;
  censusBuckets = emptyBuckets();
  censusByName = new Map();
  censusNamesTruncated = 0;
}
