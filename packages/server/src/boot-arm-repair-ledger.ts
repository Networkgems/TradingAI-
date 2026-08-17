// TRA-3810 (parent TRA-3809 → grandparent TRA-2649) — DURABLE, append-only record of
// every attempt to demote the pinned real-money operator off the board-ratified
// live-broker arm, plus the three-state instrument the detector reads.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Someone attempted to stand down the live real-money arm on bqb1 at
// 2026-08-16T18:42:20.569Z. The ENTIRE observable footprint of that attempt was:
//
//   1. one `log.warn` line (no log surface is exposed to the board/desk), and
//   2. `bootArmWriteRepairs`, a since-boot counter on `/api/health/options-live`.
//
// Nothing alarmed on either. The event became visible only because the TRA-2649 daily
// boot-arm guard's step 5 forces the counter into its report and a human read it. Absent
// that step, a demotion attempt on a live-money arm passes completely unobserved.
//
// ── WHY ALARMING ON `bootArmWriteRepairs` IS THE WRONG FIX ────────────────────
// It is a SINCE-BOOT DELTA, which breaks it as an alarm basis in BOTH directions:
//
//   • `0` reads IDENTICALLY for "the write path is clean" and "the write path has never
//     been exercised". The 2026-08-13 guard fire (TRA-3549) recorded `0`, and that was
//     never evidence the TRA-2649 fix worked; the 08-16 non-zero was the first actual
//     proof. A detector fed by that field is GREEN-BY-VACUITY for most of its life.
//   • A REDEPLOY ZEROES IT. The alarm therefore self-clears on every deploy, and the
//     window in which an event is observable is bounded by the current process lifetime.
//     The 18:42Z event was readable only while pid 73 / boot 14:44:26Z stayed up — and is
//     erased by the very deploy that ships this file.
//
// So the counter pins OFF exactly when it matters, and can never separate "no attempt"
// from "not looking". This module replaces it as the alarm basis. The counter stays on
// the route: it is a fine LIVENESS cross-check of the current process, just not evidence.
//
// ── THE THREE STATES (TRA-3810 acceptance) ───────────────────────────────────
// `state` is never a two-valued clean/alarm flag, because the failure this ticket exists
// to prevent is a vacuous green being read as a pass:
//
//   `attempts_recorded`    ≥ 1 durable repair event in the retained window. THE alarm.
//   `no_attempt_observed`  the instrument is SOUND and has seen nothing. VACUOUS — this
//                          is NOT a pass, and `observingSinceMs` says over what window
//                          the absence was actually measured.
//   `instrument_blind`     the record cannot be trusted at all: no hydrate ran, the path
//                          is ephemeral, an append was swallowed, or the arm is not
//                          eligible on this service (in which case `applyLiveBrokerArm`
//                          returns `[]` unconditionally and NO repair can ever be
//                          recorded — an empty ledger is empty BY CONSTRUCTION).
//                          `blindReasons` names which. Never a pass.
//
// ── OBSERVATION MARKERS: WHY "NO ATTEMPTS" IS OTHERWISE UNMEASURABLE ─────────
// An empty ledger has no timestamps, so "no attempts" has no denominator: a file wiped
// five seconds ago and a file that watched cleanly for six months are byte-identical. So
// each boot with a configured dir appends ONE `observation_start` marker row. The
// earliest retained marker is `observingSinceMs` — the window the absence is asserted
// over — and `observationBoots` is how many process lifetimes are behind it. A
// `no_attempt_observed` with `observingSinceMs: null` is an assertion about nothing, and
// is reported as such rather than as a clean run.
//
// ── DURABILITY (TRA-1681 / TRA-1719) ─────────────────────────────────────────
// JSONL-appended under DATA_DIR, rebuilt on boot. "A persisted file survives a reboot" is
// TRUE only if DATA_DIR points at a mounted persistent disk. With DATA_DIR unset the
// caller falls back to a path inside the build bundle — a real, writable directory, so
// `mkdirSync`/`appendFileSync`/read-back all SUCCEED and every byte still evaporates on
// the next redeploy, with no error to catch. The only discriminator is the PATH, so
// `durability.ephemeral` is decisive on the very first boot before a row exists — and on
// this ledger an ephemeral path is not a caveat, it is a total defeat (it degrades this
// back into exactly the since-boot counter it replaces). Hence: ephemeral ⇒ BLIND.
// bqb1 serves `DATA_DIR=/data`, `ephemeral:false` (measured 2026-08-17).
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only. NEVER places an order, mutates an account, or changes the arm. It is a
// write-through of a repair `applyLiveBrokerArm` ALREADY performed. It carries NO payload
// contents and NO credentials.
//
// PUBLICATION ASYMMETRY — `/api/health/options-live` is UNAUTHENTICATED. The full request
// origin (IP, forwarded-for, user-agent) is kept ON DISK, where it needs shell access,
// and is NEVER returned by {@link summarizeBootArmRepairs}. The public view carries the
// coarse attribution a detector actually needs — route, referer ORIGIN (scheme+host, no
// path or query), and a user-agent FAMILY — plus a count of distinct origins so a
// recurring rewriter is still countable. Publishing a raw client IP on an unauthenticated
// route would be a new exposure this ticket does not need.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'boot-arm-repair-ledger' });

export const BOOT_ARM_REPAIR_LOG_FILENAME = 'boot-arm-repair.jsonl';

/**
 * Retain this many ms of rows on disk (compacted on boot).
 *
 * 180 days, deliberately much longer than the 30 the give-back ledger keeps. Rows are
 * rare by construction (repairs are incidents; markers are one per boot, so ~180 lines
 * even on a box that restarts daily), and the whole point of the ticket is that the
 * observation window must be long enough that a clean read means something. A month
 * would put the denominator back inside the range a couple of quiet deploys can erase.
 */
const RETAIN_MS = 180 * 24 * 60 * 60 * 1000;

/** Where a repair came from. */
export type BootArmRepairOrigin =
  /** A `PUT /api/account/settings` whose body would have demoted the operator. */
  | 'settings_write'
  /**
   * The boot-arm found the PERSISTED operator already off the ratified arm and
   * re-converged it. Same class of event: something demoted it DURABLY, and either it
   * predates the write-path arm or it reached disk by some path that is not the settings
   * PUT. On a healthy box this is EMPTY every boot, because the write path repairs before
   * the persist — so a non-empty one is exactly as interesting as a write repair.
   */
  | 'boot';

/**
 * Full request origin as captured by the TRA-3809 warn line. Kept on DISK only — see the
 * publication-asymmetry note in the header. Every field is nullable because every one of
 * them is a header a caller controls or omits.
 */
export interface BootArmRepairRequestOrigin {
  ip: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
  /** `${method} ${originalUrl}`. */
  route: string | null;
  referer: string | null;
}

/** One durable JSONL line. Two kinds share the file so the ordering is unambiguous. */
interface BootArmRepairRecord {
  /** Event time, ms epoch. */
  ts: number;
  /**
   * `repair` — an attempt was re-converged. `observation_start` — a process came up with
   * this ledger configured, which is what makes an absence measurable.
   */
  kind: 'repair' | 'observation_start';
  /** Where it came from (`null` on a marker row). */
  origin: BootArmRepairOrigin | null;
  /** The operator whose arm was repaired (`null` on a marker row). */
  username: string | null;
  /** Fields `applyLiveBrokerArm` re-converged, e.g. `["mode"]`. Empty on a marker row. */
  repaired: string[];
  /** Which keys the caller actually sent — shape without contents. Empty on a marker. */
  bodyFields: string[];
  /** DISK-ONLY request origin. Never published. `null` on boot repairs and markers. */
  requestOrigin: BootArmRepairRequestOrigin | null;
  /**
   * Idempotency key. A boot repair is derived from a single latched outcome that any
   * number of readers could hand us; keying on it makes a double-record impossible.
   * `null` on rows that are inherently one-per-event.
   */
  dedupeKey: string | null;
}

// ── In-memory store ──────────────────────────────────────────────────────────
//
// Module-global + observe-only, matching every sibling ledger. `dataDir` is set once at
// boot by the hydrate so the two call sites can append without threading a path through.

let dataDir: string | null = null;
/** Repair rows, ascending by ts. */
const repairs: BootArmRepairRecord[] = [];
/** Observation markers, ascending by ts. */
const markers: BootArmRepairRecord[] = [];
const seenDedupeKeys = new Set<string>();
// TRA-1681 — durability provenance. The arrays are fed by BOTH the boot hydrate and the
// live pass, and once folded the two are indistinguishable. These say which.
/** Rows recovered FROM DISK at boot (0 after a reboot on an ephemeral mount). */
let hydratedRecords = 0;
/** Repair rows specifically, recovered from disk. The number that survived a restart. */
let hydratedRepairs = 0;
/** Appends that threw and were swallowed. > 0 ⇒ what is reported is NOT all on disk. */
let appendErrors = 0;
let lastAppendError: string | null = null;

export function bootArmRepairLogPath(dir: string): string {
  return join(dir, BOOT_ARM_REPAIR_LOG_FILENAME);
}

/** Test seam — drop every row, counter, and the configured dir. */
export function clearBootArmRepairLedger(): void {
  dataDir = null;
  repairs.length = 0;
  markers.length = 0;
  seenDedupeKeys.clear();
  hydratedRecords = 0;
  hydratedRepairs = 0;
  appendErrors = 0;
  lastAppendError = null;
}

function apply(rec: BootArmRepairRecord): void {
  if (rec.dedupeKey !== null) {
    if (seenDedupeKeys.has(rec.dedupeKey)) return;
    seenDedupeKeys.add(rec.dedupeKey);
  }
  const target = rec.kind === 'repair' ? repairs : markers;
  target.push(rec);
  target.sort((a, b) => a.ts - b.ts);
}

/** Append one line, best-effort. A throw is COUNTED so the swallow is never silent. */
function appendRow(rec: BootArmRepairRecord): void {
  if (dataDir == null) return;
  const path = bootArmRepairLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    // Swallowed so a settings PUT can never 500 on telemetry — but COUNTED, and the
    // count drives `instrument_blind`, so a swallowed write can never read as clean.
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('boot-arm repair ledger append failed', { reason: lastAppendError, kind: rec.kind });
  }
}

/**
 * Record ONE attempt to demote the pinned operator, durably.
 *
 * Called from the two — and only two — chokepoints where `applyLiveBrokerArm` returns a
 * non-empty repair set: the settings PUT (`origin: 'settings_write'`) and the boot-arm
 * outcome (`origin: 'boot'`). A repair of `[]` is a healthy no-op and is NOT an event;
 * callers must not call this for one, and it is rejected here anyway so a future caller
 * cannot flood the ledger with non-events and manufacture an `attempts_recorded`.
 *
 * Best-effort on IO and never throws: this sits inline in a real-money settings write.
 */
export function recordBootArmRepair(input: {
  origin: BootArmRepairOrigin;
  username: string;
  repaired: readonly string[];
  bodyFields?: readonly string[];
  requestOrigin?: BootArmRepairRequestOrigin | null;
  dedupeKey?: string | null;
  now?: number;
}): void {
  const repaired = [...(input.repaired ?? [])].filter((f) => typeof f === 'string' && f !== '');
  // A no-op convergence is not an attempt. Guarded here, not just at the call sites.
  if (repaired.length === 0) return;

  const rec: BootArmRepairRecord = {
    ts: input.now ?? Date.now(),
    kind: 'repair',
    origin: input.origin,
    username: input.username,
    repaired,
    bodyFields: [...(input.bodyFields ?? [])].filter((f) => typeof f === 'string'),
    requestOrigin: input.requestOrigin ?? null,
    dedupeKey: input.dedupeKey ?? null,
  };

  const before = repairs.length;
  apply(rec);
  if (repairs.length === before) return; // deduped — already on disk from a prior read
  appendRow(rec);
}

/**
 * Append the per-boot `observation_start` marker. Idempotent per `bootId` (the process
 * start time), so calling it twice in one process records once.
 *
 * This is the row that gives a clean read a denominator. Without it `no_attempt_observed`
 * is an assertion over an unknown window, which is the failure mode this whole ticket is
 * about, one level up.
 */
export function recordBootArmObservationStart(bootId: string, now: number = Date.now()): void {
  const rec: BootArmRepairRecord = {
    ts: now,
    kind: 'observation_start',
    origin: null,
    username: null,
    repaired: [],
    bodyFields: [],
    requestOrigin: null,
    dedupeKey: `observation_start:${bootId}`,
  };
  const before = markers.length;
  apply(rec);
  if (markers.length === before) return;
  appendRow(rec);
}

/** What {@link hydrateBootArmRepairLedgerFromDisk} recovered (for the boot log line). */
export interface BootArmRepairHydration {
  /** Total rows retained (repairs + markers). */
  records: number;
  /** Repair rows retained — the ones that had to survive a restart. */
  repairs: number;
  /** Observation markers retained, i.e. prior process lifetimes on record. */
  markers: number;
  /** ms epoch of the earliest retained marker (the observation window's start). */
  observingSinceMs: number | null;
}

function parseRow(trimmed: string): BootArmRepairRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null; // torn/partial line — skip rather than abort the hydrate
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<BootArmRepairRecord>;
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null;
  if (r.kind !== 'repair' && r.kind !== 'observation_start') return null;
  const origin = r.origin === 'settings_write' || r.origin === 'boot' ? r.origin : null;
  const repaired = Array.isArray(r.repaired)
    ? r.repaired.filter((f): f is string => typeof f === 'string' && f !== '')
    : [];
  // A `repair` row with no repaired fields cannot be an attempt — it is corruption or a
  // row written by a caller that ignored the guard. Drop it: an unattributable row must
  // never be able to raise the alarm.
  if (r.kind === 'repair' && (origin === null || repaired.length === 0)) return null;
  const ro = r.requestOrigin;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  return {
    ts: r.ts,
    kind: r.kind,
    origin,
    username: typeof r.username === 'string' && r.username !== '' ? r.username : null,
    repaired,
    bodyFields: Array.isArray(r.bodyFields)
      ? r.bodyFields.filter((f): f is string => typeof f === 'string')
      : [],
    requestOrigin:
      ro && typeof ro === 'object'
        ? {
            ip: str((ro as BootArmRepairRequestOrigin).ip),
            forwardedFor: str((ro as BootArmRepairRequestOrigin).forwardedFor),
            userAgent: str((ro as BootArmRepairRequestOrigin).userAgent),
            route: str((ro as BootArmRepairRequestOrigin).route),
            referer: str((ro as BootArmRepairRequestOrigin).referer),
          }
        : null,
    dedupeKey: typeof r.dedupeKey === 'string' && r.dedupeKey !== '' ? r.dedupeKey : null,
  };
}

/**
 * Rebuild the in-memory rows from disk and remember `dir` for subsequent appends.
 * Idempotent: CLEARS first, so it is safe to call exactly once at startup — and it MUST
 * run before either chokepoint records, or the clear would wipe a live row.
 *
 * Only rows within {@link RETAIN_MS} of `now` are kept, and the file is COMPACTED to
 * exactly those lines. Best-effort: a missing/corrupt file yields an empty hydration and
 * a torn trailing line is skipped rather than throwing.
 */
export function hydrateBootArmRepairLedgerFromDisk(
  dir: string,
  now: number = Date.now(),
): BootArmRepairHydration {
  clearBootArmRepairLedger();
  dataDir = dir;

  let rawText = '';
  try {
    rawText = readFileSync(bootArmRepairLogPath(dir), 'utf8');
  } catch {
    rawText = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const rec = parseRow(trimmed);
    if (rec === null || rec.ts < cutoff) continue;
    const beforeR = repairs.length;
    const beforeM = markers.length;
    apply(rec);
    if (repairs.length === beforeR && markers.length === beforeM) continue; // deduped
    kept.push(JSON.stringify(rec));
  }

  // Compact to the retained rows only (best-effort), skipped when nothing was dropped so
  // a clean boot does not rewrite the file for nothing.
  const nonEmptyLines = rawText.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = bootArmRepairLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('boot-arm repair ledger compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // TRA-1681 — freeze what came OFF DISK before this process folds its own rows in.
  // After the first live append the two are one array and no consumer can tell "recovered
  // an attempt from before the restart" from "one happened just now".
  hydratedRecords = repairs.length + markers.length;
  hydratedRepairs = repairs.length;
  return {
    records: hydratedRecords,
    repairs: hydratedRepairs,
    markers: markers.length,
    observingSinceMs: markers.length > 0 ? markers[0]!.ts : null,
  };
}

// ── Public (unauthenticated-route-safe) view ─────────────────────────────────

/** Coarse attribution — everything a detector needs, nothing a raw IP would add. */
export interface PublishedBootArmRepairOrigin {
  /** `${method} ${originalUrl}`. */
  route: string | null;
  /** Referer reduced to scheme+host. Path and query are DROPPED. */
  refererOrigin: string | null;
  /** Coarse user-agent family, never the full string. */
  userAgentFamily: string | null;
}

export interface PublishedBootArmRepair {
  /** ms epoch. */
  ts: number;
  /** ISO-8601, for a human reading the probe. */
  at: string;
  origin: BootArmRepairOrigin;
  /** Fields re-converged, e.g. `["mode"]`. */
  repaired: string[];
  /** Which keys the caller sent — shape only, never contents. */
  bodyFields: string[];
  /** Coarse request attribution; `null` for a boot repair, which has no request. */
  requestOrigin: PublishedBootArmRepairOrigin | null;
  /**
   * TRUE ⇔ this row came off DISK at boot rather than being observed by this process.
   * The acceptance criterion "a repair observed before a restart is still readable after
   * it" is exactly this flag being true on a row whose ts predates the current boot.
   */
  survivedRestart: boolean;
}

/** TRA-1681 — is anything reported here actually ON DISK? Read `ephemeral` FIRST. */
export interface BootArmRepairDurability {
  /** Resolved append target. `null` = memory-only: no hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /**
   * TRUE ⇒ every row here dies on the next redeploy, which degrades this ledger back into
   * precisely the since-boot counter it exists to replace. A property of the PATH, so it
   * is decisive on the first boot before any row exists. Forces `instrument_blind`.
   */
  ephemeral: boolean;
  /** Rows recovered FROM DISK at boot. */
  hydratedRecords: number;
  /** Repair rows recovered FROM DISK at boot — the restart-survival evidence. */
  hydratedRepairs: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ forces `instrument_blind`. */
  appendErrors: number;
  lastAppendError: string | null;
}

/**
 * The three-state verdict. See the header — the point of the third state is that a green
 * must never be reportable when the instrument could not have seen anything.
 */
export type BootArmRepairState = 'attempts_recorded' | 'no_attempt_observed' | 'instrument_blind';

/**
 * Why an ABSENCE here proves nothing. Note these are computed independently of `state`:
 * a reason can be present alongside `attempts_recorded`, and there it means the recorded
 * count is a LOWER BOUND, not that the alarm is unreliable.
 */
export type BootArmRepairBlindReason =
  /** No boot hydrate ran; the ledger is memory-only and nothing is durable. */
  | 'not_hydrated'
  /** DATA_DIR resolves inside the bundle — rows evaporate on redeploy (TRA-1719). */
  | 'ephemeral_data_dir'
  /** At least one append threw and was swallowed; the record is incomplete. */
  | 'append_errors'
  /**
   * The live-broker arm is not eligible on this service, so `applyLiveBrokerArm` returns
   * `[]` unconditionally and NO repair can ever be recorded. An empty ledger here is
   * empty BY CONSTRUCTION — the same vacuity trap `check-boot-arm.mjs` control 3 pins.
   */
  | 'arm_not_eligible';

export interface BootArmRepairSummary {
  /** Read this FIRST. Never a bare boolean — see {@link BootArmRepairState}. */
  state: BootArmRepairState;
  /**
   * Which blindness applies. Independent of `state`: non-empty alongside
   * `attempts_recorded` means `attempts` is a LOWER BOUND (see the precedence note in
   * {@link summarizeBootArmRepairs}).
   */
  blindReasons: BootArmRepairBlindReason[];
  /**
   * Durable repair events in the retained window, most recent FIRST.
   *
   * Published even when blind: a blind instrument that nonetheless holds a recorded
   * attempt must not hide it. Blindness is about what an ABSENCE proves, never about
   * suppressing a positive.
   */
  events: PublishedBootArmRepair[];
  /** `events.length`. The alarm quantity. */
  attempts: number;
  /** Split by origin, so a request-borne demotion is never pooled with a boot repair. */
  attemptsByOrigin: Record<BootArmRepairOrigin, number>;
  /** Distinct `route + refererOrigin + userAgentFamily` triples across request repairs. */
  distinctRequestOrigins: number;
  /** ms epoch of the most recent repair, or `null` when there is none. */
  lastAttemptAt: number | null;
  /**
   * ms epoch from which this ledger has been continuously observing (earliest retained
   * `observation_start` marker), or `null` when no marker is on record.
   *
   * `null` under `no_attempt_observed` means the absence is asserted over an UNKNOWN
   * window — which is not a measurement. It is reported, not smoothed over.
   */
  observingSinceMs: number | null;
  /** Whole days covered by `observingSinceMs`, or `null` when that is null. */
  observingDays: number | null;
  /** Retained `observation_start` markers = process lifetimes behind the window. */
  observationBoots: number;
  /** How many days back rows are retained. A longer read gap can miss an attempt. */
  retentionDays: number;
  /** TRA-1681 — whether ANY of the above survives a reboot. Read before any count. */
  durability: BootArmRepairDurability;
}

/** Reduce a Referer to scheme+host. Path/query carry no attribution value and can. */
function refererOrigin(referer: string | null): string | null {
  if (referer === null) return null;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Coarse UA family. Enough to separate "our own dashboard in a browser" from "a script",
 * which is the distinction that took a client-side grep to make on 2026-08-16, without
 * republishing a fingerprintable UA string on an unauthenticated route.
 */
function userAgentFamily(ua: string | null): string | null {
  if (ua === null) return null;
  const s = ua.toLowerCase();
  // Order matters: every one of these also claims Mozilla/5.0 or contains "chrome".
  if (s.includes('curl')) return 'curl';
  if (s.includes('wget')) return 'wget';
  if (s.includes('python') || s.includes('httpx') || s.includes('aiohttp')) return 'python';
  if (s.includes('node') || s.includes('undici') || s.includes('axios')) return 'node';
  if (s.includes('go-http-client')) return 'go';
  if (s.includes('bot') || s.includes('spider') || s.includes('crawl')) return 'bot';
  if (s.includes('edg/')) return 'browser:edge';
  if (s.includes('firefox')) return 'browser:firefox';
  if (s.includes('chrome') || s.includes('chromium')) return 'browser:chrome';
  if (s.includes('safari')) return 'browser:safari';
  if (s.includes('mozilla')) return 'browser:other';
  return 'other';
}

function publish(rec: BootArmRepairRecord, bootMs: number | null): PublishedBootArmRepair {
  const ro = rec.requestOrigin;
  return {
    ts: rec.ts,
    at: new Date(rec.ts).toISOString(),
    origin: rec.origin ?? 'boot',
    repaired: [...rec.repaired],
    bodyFields: [...rec.bodyFields],
    requestOrigin:
      ro === null
        ? null
        : {
            route: ro.route,
            refererOrigin: refererOrigin(ro.referer),
            userAgentFamily: userAgentFamily(ro.userAgent),
          },
    survivedRestart: bootMs !== null && rec.ts < bootMs,
  };
}

/**
 * Fold the store into the read-only three-state verdict. Pure — no IO.
 *
 * `eligible` is the caller's `shouldBootArmLiveEquity` verdict for the pinned operator.
 * Pass it. Omitting it (or passing `null`) means "unknown", which is itself blinding:
 * without it, an empty ledger on a disarmed service is indistinguishable from an empty
 * ledger on an armed one, and that is the exact vacuity trap this ticket is about. It
 * fails CLOSED — unknown reads blind, never clean.
 *
 * `bootMs` is this process's start time, used only to mark which rows predate it. Omit
 * it and `survivedRestart` is `false` everywhere (understating, never overstating).
 */
export function summarizeBootArmRepairs(
  opts: { now?: number; eligible?: boolean | null; bootMs?: number | null } = {},
): BootArmRepairSummary {
  const now = opts.now ?? Date.now();
  const bootMs = opts.bootMs ?? null;
  const eligible = opts.eligible ?? null;

  const events = [...repairs].sort((a, b) => b.ts - a.ts).map((r) => publish(r, bootMs));
  const attemptsByOrigin: Record<BootArmRepairOrigin, number> = { settings_write: 0, boot: 0 };
  const originTriples = new Set<string>();
  for (const e of events) {
    attemptsByOrigin[e.origin] += 1;
    if (e.requestOrigin !== null) {
      originTriples.add(
        `${e.requestOrigin.route ?? ''}|${e.requestOrigin.refererOrigin ?? ''}|${e.requestOrigin.userAgentFamily ?? ''}`,
      );
    }
  }

  const ephemeral = isEphemeralDataDir(dataDir);
  const blindReasons: BootArmRepairBlindReason[] = [];
  if (dataDir === null) blindReasons.push('not_hydrated');
  else if (ephemeral) blindReasons.push('ephemeral_data_dir');
  if (appendErrors > 0) blindReasons.push('append_errors');
  // Unknown eligibility fails CLOSED. Only an explicit `true` clears this reason.
  if (eligible !== true) blindReasons.push('arm_not_eligible');

  const observingSinceMs = markers.length > 0 ? markers[0]!.ts : null;
  // PRECEDENCE: `attempts_recorded` OUTRANKS `instrument_blind`. A recorded attempt is a
  // POSITIVE, and a positive is true whatever the instrument's coverage is — blindness
  // bounds what an ABSENCE proves, nothing else. Ranking blind first would let a stray
  // `appendErrors` demote a real live-money demotion attempt into a plumbing complaint,
  // which is the same class of defect as the alarm this ticket replaces. When both hold,
  // `blindReasons` stays populated and `attempts` is read as a LOWER BOUND.
  const state: BootArmRepairState =
    events.length > 0
      ? 'attempts_recorded'
      : blindReasons.length > 0
        ? 'instrument_blind'
        : 'no_attempt_observed';

  return {
    state,
    blindReasons,
    events,
    attempts: events.length,
    attemptsByOrigin,
    distinctRequestOrigins: originTriples.size,
    lastAttemptAt: events.length > 0 ? events[0]!.ts : null,
    observingSinceMs,
    observingDays:
      observingSinceMs === null
        ? null
        : Math.max(0, Math.floor((now - observingSinceMs) / (24 * 60 * 60 * 1000))),
    observationBoots: markers.length,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    durability: {
      dataDir,
      ephemeral,
      hydratedRecords,
      hydratedRepairs,
      appendErrors,
      lastAppendError,
    },
  };
}
