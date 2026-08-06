// TRA-1681 — the durable-state verdict, in ONE place, with a policy that can REFUSE.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Every durable store on this box fails OPEN. Not by accident — each one chose,
// separately and defensibly, to keep serving rather than break a trade pass:
//
//   1. `better-sqlite3` missing            → `initStateDb` swallows, hot state goes in-memory
//   2. `DATA_DIR` unset                    → writes land in the build bundle and die at redeploy
//   3. option-journal read error           → the book serves 0 rows
//   4. option-journal torn line            → the row is skipped
//   5. cost-gate append throws             → the write is swallowed
//   6. the volume is FULL                  → every write throws ENOSPC and each caller's
//                                            own try/catch swallows it (TRA-3011)
//
// #6 was missing from this list until 2026-08-06, and its absence had a six-day
// cost. From 2026-07-30T23:40Z to 2026-08-04T~21:20Z every write to `/data` on bqb1
// returned `ENOSPC`; the EOD ledger wrote nothing across 47 books, the option-chain
// and sentiment recorders lost two full trading days each, and THIS ROUTE served
// `ok: true`, `violations: []`, `unmeasured: []` and the note "Durable state is
// intact … Counts on this box survive a redeploy" the entire time. Every field it
// grades was true: the path was persistent, the store was open, the journal loaded
// clean. It graded WHERE the bytes go and never WHETHER THEY GO. A verdict whose
// own name is durability had no failing state for the disk being full.
//
// Individually each is a reasonable local call. Together they mean the box can be
// running with NOTHING durable under it and still look completely healthy, because
// the failure state and the healthy state produce the same readings.
//
// Fail-open #2 is the one with teeth, and it is why this cannot be a try/catch:
// **there is no error to catch.** `DATA_DIR` unset makes the caller fall back to a
// real, writable directory inside the bundle. `mkdirSync` succeeds. `appendFileSync`
// succeeds. The boot hydrate reads it straight back. Every IO-level check passes and
// the data still evaporates on the next redeploy. The ONLY discriminator is the PATH.
//
// So the verdict has to be COMPUTED and PUBLISHED, not caught — and then something
// has to be willing to act on it. A guard protecting an invariant must fail CLOSED.

import { isEphemeralDataDir } from './data-dir.js';
// TRA-3011 — the staleness bar for a disk reading. `disk-watermark.ts` has only a
// type-only import of its own, so this pulls in no runtime dependency.
import { DISK_READING_MAX_AGE_SEC } from './observability/disk-watermark.js';

/**
 * What the process does when durability is KNOWN BROKEN.
 *
 * - `observe` (default) — report it, keep serving. Exactly today's behaviour.
 * - `refuse` — refuse to boot. For a box whose ledgers back a capital decision:
 *   a gate that cannot be graded should not silently accrue a sample nobody can use.
 *
 * Defaults to `observe` deliberately. `refuse` is only safe to arm once the healthy
 * value has been READ off a running build — arming a refusal before you can see what
 * `ok: true` looks like in prod is how you halt a box to protect it from a risk it
 * never had. That read is blocked on the TRA-1648 deploy pin.
 */
export type DurabilityPolicy = 'observe' | 'refuse';

/** A durability guarantee that is KNOWN BROKEN right now. */
export type DurabilityViolation =
  /** DATA_DIR resolves inside the build bundle ⇒ every byte dies at the next redeploy. */
  | 'data_dir_ephemeral'
  /** The SQLite hot-state store did not open ⇒ the agent-spend cap is not durable. */
  | 'state_db_unavailable'
  /** The option journal could not be read ⇒ it is serving an empty book over real trades. */
  | 'journal_read_error'
  /** The journal dropped unparseable lines ⇒ rows are missing and nothing decreased. */
  | 'journal_corrupt_lines'
  /** Cost-gate appends threw and were swallowed ⇒ published counts overstate disk. */
  | 'ledger_append_errors'
  /**
   * TRA-3011 — the volume backing DATA_DIR is below the `disk-near-full`
   * threshold on blocks or inodes ⇒ writes are failing, or about to.
   *
   * Deliberately NOT in `REFUSABLE_VIOLATIONS`. See `enforceDurabilityPolicy`.
   */
  | 'data_dir_no_space';

/**
 * A guarantee that has NOT BEEN MEASURED YET — which is not the same as a passing one,
 * and the whole family of bugs behind this ticket survives on treating it as one.
 *
 * `corruptLines: null` means "no load has run", never "a clean load" (TRA-1707). A
 * reader that folds unmeasured into ok=true reproduces the exact false-green it was
 * written to catch.
 */
export type DurabilityUnmeasured =
  | 'journal_integrity'
  | 'ledger_appends'
  /**
   * TRA-3011 — no FRESH disk reading. Either nothing has ever measured the
   * volume, `statfs` failed, or the 60s observability monitor that feeds the
   * reading stopped ticking. All three are UNKNOWN, and the whole point of the
   * outage this axis was added for is that unknown reads exactly like fine.
   */
  | 'disk_headroom';

export interface StateDbStatus {
  /** The store opened and durable hot-state is live. */
  available: boolean;
  /** Why it did not open (null when it did, or when init has not run). */
  reason: string | null;
  /** False ⇒ `initStateDb` has not been called; `available:false` here means UNKNOWN, not broken. */
  initialized: boolean;
}

/**
 * TRA-3011 — free-space headroom on the volume backing DATA_DIR, as a VERDICT
 * plus a since-boot MEMORY. Numbers stay off this type on purpose: the byte and
 * inode figures are gated behind admin auth on `/api/health/storage/detail`
 * (TRA-2599) and this report is served unauthenticated.
 */
export interface DurabilityDiskInput {
  /**
   * Blocks OR inodes below the `disk-near-full` threshold RIGHT NOW.
   *
   * `null` ⇒ `statfs` could not read the volume — UNKNOWN, never `false`. The
   * pre-TRA-2599 storage route dropped this key entirely on the failure branch,
   * so `if (body.disk.belowThreshold)` read an unmeasurable filesystem as a
   * healthy one. Same trap, so the same tri-state.
   */
  belowThreshold: boolean | null;
  /** Which resource: `'blocks'`, `'inodes'`, `'blocks+inodes'`, or `null`. */
  exhausted: 'blocks' | 'inodes' | 'blocks+inodes' | null;
  /** Age of the reading in seconds. `null` ⇒ nothing has ever been measured. */
  ageSec: number | null;
  /**
   * **The post-hoc field.** TRUE ⇒ at least one reading SINCE THIS BOOT was
   * below the threshold, whether or not it is below now. `false` on a
   * freshly-booted box means "not since boot", not "not recently" — read
   * `readings` and `bootedAt` beside it.
   */
  belowThresholdSeen: boolean;
  /** Axes seen below since boot, unioned. */
  exhaustedSeen: 'blocks' | 'inodes' | 'blocks+inodes' | null;
  /** Readings folded into the watermark. `0` is NOT MEASURED, not a pass. */
  readings: number;
  firstBelowAt: string | null;
  lastBelowAt: string | null;
  /** When the watermark started accumulating (process boot). */
  bootedAt: string;
}

/** Everything the verdict is computed from. Omitted members are UNMEASURED, not passing. */
export interface DurabilityInputs {
  /** The resolved DATA_DIR (null = memory-only: nothing is durable by definition). */
  dataDir: string | null;
  stateDb: StateDbStatus;
  /** Option-journal load integrity. Omit before any load has run. */
  journal?: { corruptLines: number | null; readError: string | null };
  /** Cost-aware-gate swallowed-append count. Omit when the ledger has not hydrated. */
  ledger?: { appendErrors: number };
  /**
   * TRA-3011 — free-space headroom. Omit ⇒ `disk_headroom` is UNMEASURED, like
   * every other omitted member. There is no "assume fine" branch here: assuming
   * fine is precisely what this route did for six days.
   */
  disk?: DurabilityDiskInput;
}

export interface DurabilityReport {
  /**
   * A grader's green. TRUE only when nothing is broken AND nothing is unmeasured.
   *
   * NOT `violations.length === 0`. An unmeasured guarantee reads identically to a
   * satisfied one, and that identity is the bug this whole ticket is about.
   */
  ok: boolean;
  policy: DurabilityPolicy;
  /** Resolved append target. `null` ⇒ memory-only. */
  dataDir: string | null;
  /** TRUE ⇒ every durable count on this box dies at the next redeploy. Read this FIRST. */
  ephemeral: boolean;
  stateDb: StateDbStatus;
  journal: { corruptLines: number | null; readError: string | null } | null;
  ledger: { appendErrors: number } | null;
  /** TRA-3011 — the disk headroom verdict + watermark. `null` ⇒ not supplied. */
  disk: DurabilityDiskInput | null;
  /** Known-broken guarantees. `enforceDurabilityPolicy` refuses on these. */
  violations: DurabilityViolation[];
  /** Not-yet-measurable guarantees. These VOID a grade; they never refuse a boot. */
  unmeasured: DurabilityUnmeasured[];
}

export function resolveDurabilityPolicy(env: NodeJS.ProcessEnv = process.env): DurabilityPolicy {
  return (env['DURABILITY_POLICY'] ?? '').trim().toLowerCase() === 'refuse' ? 'refuse' : 'observe';
}

/** Compute the verdict. Pure — no IO, no logging, safe to call from a health route. */
export function evaluateDurability(
  inputs: DurabilityInputs,
  env: NodeJS.ProcessEnv = process.env,
): DurabilityReport {
  const violations: DurabilityViolation[] = [];
  const unmeasured: DurabilityUnmeasured[] = [];

  const ephemeral = isEphemeralDataDir(inputs.dataDir, env);
  if (ephemeral) violations.push('data_dir_ephemeral');

  // `initialized:false` is UNKNOWN, not broken — a CLI or a unit test never opens the
  // store, and refusing to boot over that would be a bootstrap deadlock. Only a store
  // that TRIED and FAILED is a violation.
  if (inputs.stateDb.initialized && !inputs.stateDb.available) violations.push('state_db_unavailable');

  if (inputs.journal === undefined || inputs.journal.corruptLines === null) {
    unmeasured.push('journal_integrity');
  } else {
    if (inputs.journal.readError !== null) violations.push('journal_read_error');
    if (inputs.journal.corruptLines > 0) violations.push('journal_corrupt_lines');
  }

  if (inputs.ledger === undefined) {
    unmeasured.push('ledger_appends');
  } else if (inputs.ledger.appendErrors > 0) {
    violations.push('ledger_append_errors');
  }

  // TRA-3011 — the disk axis. THREE states, and the middle one is the whole point:
  //
  //   absent / unreadable / STALE  → `disk_headroom` UNMEASURED (voids a grade)
  //   below the threshold          → `data_dir_no_space` VIOLATION
  //   fresh and above              → nothing
  //
  // Staleness is graded here rather than at the call site because the reader is
  // the 60s observability monitor: a stopped monitor produces a reading that is
  // permanently `belowThreshold: false` and permanently WRONG, and its last
  // healthy sample would otherwise keep certifying a disk nobody is watching.
  if (
    inputs.disk === undefined
    || inputs.disk.ageSec === null
    || inputs.disk.ageSec > DISK_READING_MAX_AGE_SEC
    || inputs.disk.belowThreshold === null
  ) {
    unmeasured.push('disk_headroom');
  } else if (inputs.disk.belowThreshold) {
    violations.push('data_dir_no_space');
  }

  return {
    ok: violations.length === 0 && unmeasured.length === 0,
    policy: resolveDurabilityPolicy(env),
    dataDir: inputs.dataDir,
    ephemeral,
    stateDb: inputs.stateDb,
    journal: inputs.journal ?? null,
    ledger: inputs.ledger ?? null,
    disk: inputs.disk ?? null,
    violations,
    unmeasured,
  };
}

export class DurabilityRefusedError extends Error {
  constructor(readonly violations: DurabilityViolation[]) {
    super(
      `DURABILITY_POLICY=refuse and durable state is broken: ${violations.join(', ')}. `
        + 'Set DATA_DIR to the mounted persistent disk (/data on Render) and ensure better-sqlite3 '
        + 'is installed, or set DURABILITY_POLICY=observe to boot anyway (nothing will survive a redeploy).',
    );
    this.name = 'DurabilityRefusedError';
  }
}

/**
 * TRA-3011 — the violations a `refuse` policy will actually stop a boot over.
 *
 * `data_dir_no_space` is the one that is graded but NOT refusable, and the
 * asymmetry is deliberate. Every other violation here is a CONFIGURATION fault:
 * an ephemeral DATA_DIR, a missing native module, a corrupt journal. The box
 * cannot fix any of them by running, so refusing costs nothing that was not
 * already lost.
 *
 * A full disk is a RUNTIME condition, and the box demonstrably CAN fix it by
 * running: the TRA-2817 backup prune is what ended the 2026-07-30 outage, and it
 * only runs inside a live process. Refusing would take the box down, PM2 would
 * cycle it into `max_restarts`, and the health surface this ticket exists to add
 * would go dark at exactly the moment someone needs to read it — turning a
 * degraded box into a total outage with no instrument. Grade it, alert on it,
 * publish the watermark; do not make it a suicide switch.
 */
export const REFUSABLE_VIOLATIONS: readonly DurabilityViolation[] = [
  'data_dir_ephemeral',
  'state_db_unavailable',
  'journal_read_error',
  'journal_corrupt_lines',
  'ledger_append_errors',
];

/**
 * The fail-CLOSED half. Throws when the policy says `refuse` and a guarantee is KNOWN
 * BROKEN.
 *
 * Refuses on `violations` ONLY, never on `unmeasured`. At boot the journal has not been
 * read yet, so its integrity is legitimately unknown — refusing over a measurement that
 * cannot exist yet would make the process unbootable by construction. `unmeasured` VOIDS
 * A GRADE (see `ok`); it does not stop a boot.
 *
 * TRA-3011 — and it refuses only on `REFUSABLE_VIOLATIONS`. A violation that is
 * self-healing while the process runs is reported, never fatal.
 */
export function enforceDurabilityPolicy(report: DurabilityReport): void {
  const refusable = report.violations.filter((v) => REFUSABLE_VIOLATIONS.includes(v));
  if (report.policy === 'refuse' && refusable.length > 0) {
    throw new DurabilityRefusedError(refusable);
  }
}
