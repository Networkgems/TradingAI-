// TRA-1486 (parent TRA-1476 → TRA-1471) — DURABLE per-name/ET-day open ledger +
// gate-reject telemetry for the demo directional "ignition" entry path.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The TRA-1476 quality gate armed on bqb1 (render.yaml
// ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE=1, price=10, $vol=300000, cap=2) and STILL
// leaked: 78 of 87 post-arm opens on 2026-07-08 landed on cap-violating names
// (RIVN 17, AMPG 13, ZETA 11, QQQ 10 …). Root cause of the per-name-cap miss (D2 on
// TRA-1486): the shared TRA-1408 per-name counter (`churnOpensToday`) is an IN-MEMORY
// Map that RESETS on every process reboot. bqb1 rebooted several times that session,
// so the count started from 0 each boot and never accumulated to the cap within a
// boot window — the cap check ran, but always saw count < 2.
//
// This module is the durable source of truth for the per-name/ET-day open count.
// Mirrors the TRA-1278 conviction-DCA + TRA-1300 scale-out JSONL/hydrate pattern:
//   • one JSONL line per recorded DEMO open under DATA_DIR, keyed by ET calendar day;
//   • counts rebuilt from disk on boot (survive restart — the cap sees the real
//     same-ET-day total after a mid-session reboot, not a reset 0);
//   • the file is COMPACTED on boot to a short retention window (the cap only ever
//     consults the CURRENT ET day, so a couple of days is enough) — unlike the
//     conviction-DCA ledger (which is promotion evidence and never rotates), demo
//     directional opens are frequent (~dozens/name/day), so an unbounded file would
//     grow without benefit.
//
// It also holds the gate-reject counters (by verdict code, per ET day) that back
// `GET /api/health/directional-quality-gate`, so a grade reads the gate's
// enforcement directly instead of inferring it from `/api/reports/desk`.
//
// ── SLEEVE SCOPING (TRA-1564) ─────────────────────────────────────────────────
// Two different consumers read this ledger and they need DIFFERENT scopes:
//   • the TRA-1408 churn brake is CROSS-SLEEVE by design ("don't re-churn a name on
//     ANY sleeve") — it wants the all-sleeve per-name count;
//   • the TRA-1476 directional quality-gate cap is DIRECTIONAL-ONLY ("≤ N *directional*
//     opens/name/ET-day") — it must not count equity-swing / RV / OTM opens.
// The write chokepoint (`recordChurnOpen` in signal-engine) fires from five open
// sleeves, so each recorded open is TAGGED with its sleeve and we rebuild two counts:
//   • {@link anySleeveOpensFor} — all-sleeve (churn brake, still reboot-durable);
//   • {@link directionalOpensFor} — directional-only (the quality gate + the health
//     `openCountsBySymbol` view).
// Before TRA-1564 the durable write lived in the shared chokepoint untagged, so BOTH
// the directional cap read AND the health view conflated all five sleeves — a
// `count:3` on a multi-sleeve name (equity-swing + directional) looked like a
// directional cap breach when the 3rd open came from a non-directional sleeve, and
// the grader could not certify the directional cap through the telemetry.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. NEVER places an order or mutates an account. The engine
// records here ONLY on the DEMO open chokepoints (no-op on the live path), so every
// counter reflects the DEMO book. No balances/PII — just symbol, ET day, sleeve tag,
// and reject codes.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';
// Type-only (erased at compile ⇒ no runtime import edge). The class string is
// produced by `classifySpreadCeilingAccount` at the CALL SITE and merely stored
// here, so binding the type keeps the two from drifting without coupling modules.
import type { SpreadCeilingAccountClass } from './option-spread-cost.js';

const log = logger.child({ module: 'directional-open-ledger' });

export const DIRECTIONAL_OPEN_LOG_FILENAME = 'directional-opens.jsonl';

/**
 * Retain this many ms of open records on disk (compacted on boot). The per-name cap
 * only ever consults the CURRENT ET day, so a 3-day window comfortably covers a
 * same-ET-day reboot (the AC's "≥1 mid-session reboot") while bounding the file.
 */
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Which open sleeve a durable record came from. Only `directional` opens count
 * toward the directional quality-gate cap; every sleeve counts toward the
 * cross-sleeve churn brake. Legacy (pre-TRA-1564) records carry no tag and are
 * treated as `other` on hydrate — conservative: they never inflate the directional
 * cap read (they age out of the 3-day retain window within a session or two).
 */
export type OpenSleeve = 'directional' | 'other';

/** Reject verdict codes we count (mirrors {@link DirectionalQualityVerdict.code} minus `ok`). */
export type DirectionalRejectCode =
  | 'min_price'
  | 'min_dollar_volume'
  | 'insufficient_liquidity_samples'
  | 'per_name_cap';

/** One durable OPEN record — a write-through of the open the engine just booked. */
interface DirectionalOpenRecord {
  kind?: 'open';
  /** Open time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the per-name cap rolls on. */
  etDay: string;
  /** Normalized underlier symbol. */
  symbol: string;
  /** Sleeve the open fired on (absent on legacy pre-TRA-1564 lines ⇒ treated as `other`). */
  sleeve?: OpenSleeve;
}

/** One durable REJECT record — the quality gate refused a directional open (TRA-1564 B1). */
interface DirectionalRejectRecord {
  kind: 'reject';
  /** Reject time, ms epoch. */
  ts: number;
  /** ET calendar day the reject fired on (the key the health view rolls on). */
  etDay: string;
  /** Failing verdict code. */
  code: DirectionalRejectCode;
}

/**
 * TRA-3080 — ARM DISPOSITION of the directional pass for ONE owning book, per ET day.
 *
 * ── WHY A THIRD RECORD KIND ──────────────────────────────────────────────────
 * The two records above can only describe a pass that RAN. When the desk's
 * directional entries stopped after 2026-07-29 there was no instrument anywhere that
 * could say why, because the thing that stopped them is UPSTREAM of every counter:
 * `evaluateDemoDirectional` opens its scan (`beginRvScan('directional', …)`) AFTER
 * the arm gate, so a book the gate turns away records no scan, no reject, and no
 * open — byte-identical to a book that scanned and found nothing.
 *
 * The actual cause was a MODE flip, not a rejection: the `admin` desk book moved to
 * `settings.mode: 'live'` on 2026-07-30 for the board-authorised live-OTM window
 * (TRA-2536 → TRA-2760 → TRA-2877). In live the directional pass requires
 * `ENABLE_OPTION_LIVE_DIRECTIONAL`, which is unset on bqb1 and OFF by design
 * (TRA-1490 dark build; arming real capital is a separate board approval). So the
 * pass became unreachable for that book while the sibling OTM scan — which carries
 * NO mode term (`shouldRunOtmScan`) — kept firing, and while the `qa_*`/`ctoverify*`
 * fixture books stayed in demo and kept journalling directional opens.
 *
 * ── WHY IT MUST BE RETAINED, NOT SINCE-BOOT ──────────────────────────────────
 * `/api/health/rv-scan` already publishes the directional path's `enabled` flag, but
 * that is `isOptionDemoDirectionalEnabled(process.env)` — a PROCESS-WIDE flag that
 * reads `true` whether or not any resident book's mode can actually reach the pass.
 * It is fleet-blind, and its `scanCountSinceBoot` is a since-boot latch on a box that
 * reboots daily. Neither can testify about last week. This record can: it is keyed by
 * ET day, attributed to an account class, and hydrated from disk across reboots.
 *
 * ── HOW THE TICK COUNT STAYS HONEST ACROSS REBOOTS ───────────────────────────
 * A line is appended on the FIRST tick under a given key and at most once per
 * {@link ARM_FLUSH_MS} thereafter, each carrying the running `ticks` for THIS boot.
 * `bootId` makes later lines supersede earlier ones for the same boot rather than
 * double-count, so the hydrate folds to "last line wins per (key, bootId)" and then
 * SUMS across boots. That is what makes a same-day reboot add ticks instead of
 * resetting them — the TRA-1486 D2 failure, one axis over.
 */
export type DirectionalArmDisposition =
  /** mode=demo AND `ENABLE_OPTION_DEMO_DIRECTIONAL` on ⇒ the pass runs. */
  | 'armed_demo'
  /** mode=live AND `ENABLE_OPTION_LIVE_DIRECTIONAL` on ⇒ the pass runs on real capital. */
  | 'armed_live'
  /** mode=demo but the demo flag is off ⇒ silence is correct. */
  | 'demo_flag_off'
  /**
   * mode=live and the live arm is off ⇒ the pass is UNREACHABLE for this book.
   * This is the desk's state since 2026-07-30 and the answer to TRA-3080.
   */
  | 'live_arm_off'
  /** Armed, but the RV scanner dep is absent ⇒ the pass cannot run anyway. */
  | 'no_scanner';

const ARM_DISPOSITIONS: readonly DirectionalArmDisposition[] = [
  'armed_demo',
  'armed_live',
  'demo_flag_off',
  'live_arm_off',
  'no_scanner',
];

function isArmDisposition(v: unknown): v is DirectionalArmDisposition {
  return typeof v === 'string' && (ARM_DISPOSITIONS as readonly string[]).includes(v);
}

/** An arm disposition means the pass actually runs iff it is one of the `armed_*` states. */
export function armDispositionIsReachable(d: DirectionalArmDisposition): boolean {
  return d === 'armed_demo' || d === 'armed_live';
}

/**
 * Retain arm records for 30 days — an order of magnitude longer than {@link RETAIN_MS}
 * for opens, because the question these answer ("why was the desk quiet LAST WEEK")
 * is inherently retrospective. They are also far sparser: at most one line per
 * (ET day × book × disposition × boot) per {@link ARM_FLUSH_MS}, and superseded lines
 * are dropped on the boot compaction, so the file stays bounded.
 */
const ARM_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Append at most one arm line per key per 5 minutes (plus one on first sight). */
const ARM_FLUSH_MS = 5 * 60 * 1000;

/** One durable ARM-DISPOSITION record (TRA-3080). */
interface DirectionalArmRecord {
  kind: 'arm';
  /** Time of the most recent tick folded into this line, ms epoch. */
  ts: number;
  /** ET calendar day the ticks fell on. */
  etDay: string;
  /** Owning book label (the same string the options account stamps as `account`). */
  account: string;
  /** Class of that book, computed by `classifySpreadCeilingAccount` at the call site. */
  accountClass: SpreadCeilingAccountClass;
  /** Engine mode at evaluation time. */
  mode: 'demo' | 'live';
  disposition: DirectionalArmDisposition;
  /** Identifies the writing process so a re-flush supersedes rather than double-counts. */
  bootId: string;
  /**
   * RTH ticks observed under this key during THIS boot, as of the last flush.
   *
   * ⚠️ A LOWER BOUND once it has been through a hydrate. Persistence is throttled to
   * {@link ARM_FLUSH_MS}, so up to 5 minutes of ticks that had not yet been flushed
   * when the process died are not on disk. `disposition`, `accountClass` and
   * `firstAt` are exact from the very first tick — those are the fields that answer
   * "was the pass reachable, and why". Never grade on an exact tick count.
   */
  ticks: number;
  /** First tick under this key during this boot, ms epoch. */
  firstAt: number;
}

type DirectionalLedgerRecord =
  | DirectionalOpenRecord
  | DirectionalRejectRecord
  | DirectionalArmRecord;

const REJECT_CODES: readonly DirectionalRejectCode[] = [
  'min_price',
  'min_dollar_volume',
  'insufficient_liquidity_samples',
  'per_name_cap',
];

function isRejectCode(v: unknown): v is DirectionalRejectCode {
  return typeof v === 'string' && (REJECT_CODES as readonly string[]).includes(v);
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateDirectionalOpensFromDisk so the deep engine chokepoint can append without
// threading a path through the SignalEngine. Counts are keyed by ET day so a stale
// day is naturally ignored by a current-day read.

let dataDir: string | null = null;
/** etDay -> (symbol -> open count) across ALL sleeves (cross-sleeve churn brake). */
const anySleeveByDay = new Map<string, Map<string, number>>();
/** etDay -> (symbol -> open count) for the DIRECTIONAL sleeve only (quality-gate cap + health). */
const directionalByDay = new Map<string, Map<string, number>>();
/** etDay -> (reject code -> count) — durable so a post-close fire reads RTH rejects (TRA-1564 B1). */
const rejectsByDay = new Map<string, Map<DirectionalRejectCode, number>>();
/** Total DIRECTIONAL opens seen (live + hydrated) across retained days. */
let directionalOpensTotal = 0;
let lastOpenAt: number | null = null;
let lastRejectAt: number | null = null;

/**
 * TRA-3080 — arm-disposition tallies, keyed by
 * `etDay \0 account \0 mode \0 disposition \0 bootId`. Holds BOTH the tallies
 * hydrated from previous boots and the one this boot is accumulating; they never
 * collide because `bootId` is part of the key, which is exactly what lets the
 * summary SUM ticks across boots without double-counting a re-flushed line.
 */
const armTallies = new Map<string, DirectionalArmTally>();

interface DirectionalArmTally {
  etDay: string;
  account: string;
  accountClass: SpreadCeilingAccountClass;
  mode: 'demo' | 'live';
  disposition: DirectionalArmDisposition;
  bootId: string;
  ticks: number;
  firstAt: number;
  lastAt: number;
  /** ms epoch of the last line appended for this tally (0 ⇒ never appended). */
  lastFlushedAt: number;
}

/**
 * Identifies THIS process for the supersede-vs-sum fold above. Derived from pid +
 * module-load time, which is unique per boot on a box that restarts in-place.
 */
let armBootId = `${process.pid}-${Date.now()}`;

/** Test seam — pin the boot id so a test can simulate two distinct boots. */
export function __setDirectionalArmBootId(id: string): void {
  armBootId = id;
}

function armKey(
  etDay: string,
  account: string,
  mode: 'demo' | 'live',
  disposition: DirectionalArmDisposition,
  bootId: string,
): string {
  return `${etDay}\u0000${account}\u0000${mode}\u0000${disposition}\u0000${bootId}`;
}

export function directionalOpenLogPath(dir: string): string {
  return join(dir, DIRECTIONAL_OPEN_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearDirectionalOpenLedger(): void {
  dataDir = null;
  anySleeveByDay.clear();
  directionalByDay.clear();
  rejectsByDay.clear();
  armTallies.clear();
  directionalOpensTotal = 0;
  lastOpenAt = null;
  lastRejectAt = null;
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function bump(store: Map<string, Map<string, number>>, etDay: string, symbol: string): void {
  let day = store.get(etDay);
  if (!day) {
    day = new Map();
    store.set(etDay, day);
  }
  day.set(symbol, (day.get(symbol) ?? 0) + 1);
}

/** Apply one open record to the in-memory counts (shared by record + hydrate). */
function applyOpen(symbol: string, etDay: string, sleeve: OpenSleeve, now: number): void {
  bump(anySleeveByDay, etDay, symbol);
  if (sleeve === 'directional') {
    bump(directionalByDay, etDay, symbol);
    directionalOpensTotal += 1;
    lastOpenAt = now;
  }
}

/** Apply one reject record to the in-memory counts (shared by record + hydrate). */
function applyReject(etDay: string, code: DirectionalRejectCode, now: number): void {
  let day = rejectsByDay.get(etDay);
  if (!day) {
    day = new Map();
    rejectsByDay.set(etDay, day);
  }
  day.set(code, (day.get(code) ?? 0) + 1);
  lastRejectAt = now;
}

/**
 * Durable CROSS-SLEEVE per-name open count for `symbol` on `etDay` (0 when none).
 * This is the reboot-durable value the TRA-1408 churn brake consults — it counts an
 * open on ANY sleeve, mirroring the brake's cross-sleeve intent, and reflects the
 * real same-ET-day total even after a mid-session restart.
 */
export function anySleeveOpensFor(symbol: string, etDay: string): number {
  return anySleeveByDay.get(etDay)?.get(normSymbol(symbol)) ?? 0;
}

/**
 * Durable DIRECTIONAL-ONLY per-name open count for `symbol` on `etDay` (0 when none).
 * This is the reboot-durable value the TRA-1476 directional quality-gate cap consults
 * — it counts ONLY opens tagged `directional`, so an equity-swing / RV / OTM open on
 * the same name never counts against the "≤ N directional opens/name" cap (TRA-1564 B2).
 */
export function directionalOpensFor(symbol: string, etDay: string): number {
  return directionalByDay.get(etDay)?.get(normSymbol(symbol)) ?? 0;
}

/**
 * Record one DEMO open against the durable per-name/ET-day counts AND append one JSONL
 * line under the configured DATA_DIR. `sleeve` scopes the record: `directional` opens
 * count toward BOTH the cross-sleeve churn brake and the directional quality-gate cap;
 * any other sleeve counts toward the churn brake only. Best-effort on IO — a write
 * failure logs and is swallowed so this accounting can never break the trade pass.
 * When no dataDir is configured (unit tests / CLI without boot) the in-memory counts
 * still update; only the file write is skipped.
 */
export function recordDirectionalOpen(
  symbol: string,
  etDay: string,
  sleeve: OpenSleeve = 'directional',
  now: number = Date.now(),
): void {
  const sym = normSymbol(symbol);
  applyOpen(sym, etDay, sleeve, now);
  if (dataDir == null) return;
  const path = directionalOpenLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: DirectionalOpenRecord = { kind: 'open', ts: now, etDay, symbol: sym, sleeve };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('directional-open append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record one directional open REJECTED by the quality gate, by verdict code, on
 * `etDay`. DURABLE (TRA-1564 B1): appends a JSONL line and rebuilds on boot, so the
 * post-close re-grade fire reads the full RTH session's rejects even though bqb1
 * reboots at/after the close (before the fix these counters were in-memory since-boot
 * and were already `{}` by post-market time). Best-effort on IO — a write failure
 * logs and is swallowed. When no dataDir is configured the in-memory count still
 * updates; only the file write is skipped.
 */
export function recordDirectionalGateReject(
  code: DirectionalRejectCode,
  etDay: string,
  now: number = Date.now(),
): void {
  applyReject(etDay, code, now);
  if (dataDir == null) return;
  const path = directionalOpenLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: DirectionalRejectRecord = { kind: 'reject', ts: now, etDay, code };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('directional-reject append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Append one arm line for `tally` (best-effort IO), stamping the flush time. */
function flushArm(tally: DirectionalArmTally): void {
  tally.lastFlushedAt = tally.lastAt;
  if (dataDir == null) return;
  const path = directionalOpenLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: DirectionalArmRecord = {
      kind: 'arm',
      ts: tally.lastAt,
      etDay: tally.etDay,
      account: tally.account,
      accountClass: tally.accountClass,
      mode: tally.mode,
      disposition: tally.disposition,
      bootId: tally.bootId,
      ticks: tally.ticks,
      firstAt: tally.firstAt,
    };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('directional-arm append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * TRA-3080 — record that the directional arm gate was EVALUATED for one book on one
 * RTH tick, with the disposition it produced.
 *
 * Call this at the gate itself, NOT inside the pass: the whole point is to leave a
 * trace for the books the gate turns away, which by definition never reach
 * `beginRvScan`. Callers should only invoke it while the stock market is open, so
 * that a day carrying NO record for a book is itself a distinguishable state ("that
 * engine did not tick during RTH") rather than being pooled with "the pass was off".
 *
 * Writes are throttled to one line per {@link ARM_FLUSH_MS} per key after the first,
 * so a 30s tick cadence costs ~12 lines/book/day, not ~780. Best-effort on IO — a
 * failure logs and is swallowed so this accounting can never break the trade pass.
 */
export function recordDirectionalArm(
  input: {
    etDay: string;
    account: string;
    accountClass: SpreadCeilingAccountClass;
    mode: 'demo' | 'live';
    disposition: DirectionalArmDisposition;
  },
  now: number = Date.now(),
): void {
  const key = armKey(input.etDay, input.account, input.mode, input.disposition, armBootId);
  let tally = armTallies.get(key);
  if (!tally) {
    tally = {
      etDay: input.etDay,
      account: input.account,
      accountClass: input.accountClass,
      mode: input.mode,
      disposition: input.disposition,
      bootId: armBootId,
      ticks: 0,
      firstAt: now,
      lastAt: now,
      lastFlushedAt: 0,
    };
    armTallies.set(key, tally);
  }
  tally.ticks += 1;
  tally.lastAt = now;
  // First sight always writes, so a disposition that lasts a single tick is still
  // durable; after that the 5-minute throttle bounds the file.
  if (tally.lastFlushedAt === 0 || now - tally.lastFlushedAt >= ARM_FLUSH_MS) {
    flushArm(tally);
  }
}

/** What {@link hydrateDirectionalOpensFromDisk} recovered (for the boot log line). */
export interface DirectionalOpenHydration {
  /** Distinct ET days retained after compaction (across opens + rejects). */
  days: number;
  /** Total open records retained. */
  records: number;
  /** Total reject records retained. */
  rejects: number;
}

/**
 * Rebuild the in-memory per-day counts (opens by sleeve + rejects by code) from disk
 * on boot and remember `dir` for subsequent appends. Idempotent: CLEARS first, so it
 * is safe to call exactly once at startup before any live pass. Only records within
 * {@link RETAIN_MS} of `now` are kept, and the file is COMPACTED to exactly those
 * lines (bounding growth). Best-effort: a missing/corrupt file yields an empty
 * hydration; a torn trailing line is skipped rather than throwing.
 */
export function hydrateDirectionalOpensFromDisk(dir: string, now: number = Date.now()): DirectionalOpenHydration {
  clearDirectionalOpenLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(directionalOpenLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  // TRA-3080 — arm records answer a retrospective question and are far sparser, so
  // they get their own, much longer window. Applying the 3-day open cutoff to them
  // would delete exactly the history the route exists to serve.
  const armCutoff = now - ARM_RETAIN_MS;
  const kept: string[] = [];
  let records = 0;
  let rejects = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: DirectionalLedgerRecord;
    try {
      rec = JSON.parse(trimmed) as DirectionalLedgerRecord;
    } catch {
      // skip a torn/partial line rather than abort the hydrate
      continue;
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;

    if (rec.kind === 'arm') {
      if (rec.ts < armCutoff) continue;
      if (!isArmDisposition(rec.disposition)) continue;
      if (typeof rec.account !== 'string' || rec.account === '') continue;
      if (rec.mode !== 'demo' && rec.mode !== 'live') continue;
      if (typeof rec.bootId !== 'string' || rec.bootId === '') continue;
      if (typeof rec.ticks !== 'number' || !Number.isFinite(rec.ticks) || rec.ticks < 0) continue;
      const key = armKey(rec.etDay, rec.account, rec.mode, rec.disposition, rec.bootId);
      const prior = armTallies.get(key);
      // Last line wins WITHIN a boot (it supersedes the earlier partial count);
      // distinct boots keep distinct keys and are summed by the reader. Guard on
      // `ticks` rather than `ts` so an out-of-order append cannot lose a count.
      if (prior && prior.ticks >= rec.ticks) continue;
      armTallies.set(key, {
        etDay: rec.etDay,
        account: rec.account,
        accountClass: rec.accountClass,
        mode: rec.mode,
        disposition: rec.disposition,
        bootId: rec.bootId,
        ticks: rec.ticks,
        firstAt: typeof rec.firstAt === 'number' && Number.isFinite(rec.firstAt) ? rec.firstAt : rec.ts,
        lastAt: rec.ts,
        // Hydrated tallies belong to a PREVIOUS boot (different bootId ⇒ different
        // key), so this boot never appends to them; the value is inert.
        lastFlushedAt: rec.ts,
      });
      continue;
    }

    if (rec.ts < cutoff) continue;

    if (rec.kind === 'reject') {
      if (!isRejectCode(rec.code)) continue;
      applyReject(rec.etDay, rec.code, rec.ts);
      kept.push(JSON.stringify({ kind: 'reject', ts: rec.ts, etDay: rec.etDay, code: rec.code }));
      rejects += 1;
      continue;
    }

    // Default (kind 'open' or absent — legacy untagged line).
    if (typeof rec.symbol !== 'string' || rec.symbol.trim() === '') continue;
    const sym = normSymbol(rec.symbol);
    // Legacy lines carry no sleeve tag; treat as `other` so they never inflate the
    // directional cap read (they only affect the cross-sleeve churn count).
    const sleeve: OpenSleeve = rec.sleeve === 'directional' ? 'directional' : 'other';
    applyOpen(sym, rec.etDay, sleeve, rec.ts);
    kept.push(JSON.stringify({ kind: 'open', ts: rec.ts, etDay: rec.etDay, symbol: sym, sleeve }));
    records += 1;
  }

  // TRA-3080 — re-emit ONE line per surviving (key, bootId) arm tally. The fold above
  // already dropped every superseded re-flush, so this is where the throttled
  // append's growth is actually reclaimed: a book that ticked all session writes ~12
  // lines/day and compacts back to 1.
  for (const t of armTallies.values()) {
    const rec: DirectionalArmRecord = {
      kind: 'arm',
      ts: t.lastAt,
      etDay: t.etDay,
      account: t.account,
      accountClass: t.accountClass,
      mode: t.mode,
      disposition: t.disposition,
      bootId: t.bootId,
      ticks: t.ticks,
      firstAt: t.firstAt,
    };
    kept.push(JSON.stringify(rec));
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop (kept count matches the non-empty lines) to avoid a
  // needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = directionalOpenLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('directional-open compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const days = new Set<string>([...directionalByDay.keys(), ...anySleeveByDay.keys(), ...rejectsByDay.keys()]);
  return { days: days.size, records, rejects };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface DirectionalOpenSymbolCount {
  symbol: string;
  count: number;
}

export interface DirectionalGateSummary {
  /** Total DEMO DIRECTIONAL opens recorded (live + hydrated, across retained days). */
  opensRecorded: number;
  /** Per-name DIRECTIONAL-only open counts for the requested ET day, busiest first. */
  openCountsBySymbol: DirectionalOpenSymbolCount[];
  /** DURABLE rejects for the requested ET day keyed by verdict code (only non-zero present). */
  opensRejectedByCode: Record<string, number>;
  /** Total rejects across all codes for the requested ET day. */
  opensRejectedTotal: number;
  /** Distinct names with ≥1 recorded DIRECTIONAL open on the requested ET day. */
  trackedSymbols: number;
  /** ms epoch of the last recorded directional open / reject (null if none yet). */
  lastOpenAt: number | null;
  lastRejectAt: number | null;
}

/**
 * TRA-3080 — one (ET day × account class × mode × disposition) cell of the retained
 * arm view. `books` is the DISTINCT count of owning books that produced this cell, so
 * a class is never credited to a single noisy engine.
 */
export interface DirectionalArmCell {
  accountClass: SpreadCeilingAccountClass;
  mode: 'demo' | 'live';
  disposition: DirectionalArmDisposition;
  /** Whether this disposition means the pass actually ran. Stated, not inferred. */
  reachable: boolean;
  /** Distinct owning books observed in this cell on this ET day. */
  books: number;
  /**
   * RTH ticks summed across every boot that contributed to this cell.
   *
   * ⚠️ A LOWER BOUND for any boot that has already ended: persistence is throttled,
   * so the final unflushed window (≤5 min) of a boot that died is not counted. Read
   * it as "the pass was evaluated AT LEAST this many times under this disposition".
   * The load-bearing fields — `disposition`, `reachable`, `accountClass`, `books` —
   * are exact from the first tick. Do not build a criterion on an exact tick count.
   */
  ticks: number;
  /** Distinct boots that contributed — a same-day reboot shows up here, not as a reset. */
  boots: number;
  firstAt: number;
  lastAt: number;
}

/** All arm cells for one ET day. */
export interface DirectionalArmDay {
  etDay: string;
  cells: DirectionalArmCell[];
}

/**
 * TRA-3080 — fold the retained arm tallies into a per-ET-day, account-class-attributed
 * view, most recent day first. Pure — no IO.
 *
 * This is the read that separates the three states TRA-3080 could not tell apart:
 *   • a cell with `reachable: true` ⇒ that class's books DID reach the scan, so any
 *     silence is a reject/no-candidate question and belongs to the rv-scan reject
 *     counters and `opensRejectedByCode`;
 *   • a cell with `reachable: false` ⇒ the pass was UNREACHABLE for those books, and
 *     `disposition` names why (`live_arm_off` = the book is in live mode and the live
 *     directional arm is off — the TRA-3080 desk answer);
 *   • NO cell for a class on that ET day ⇒ no engine of that class ticked during RTH
 *     at all, which is a third fact and must not be read as either of the above.
 */
export function summarizeDirectionalArm(): DirectionalArmDay[] {
  interface Agg {
    accountClass: SpreadCeilingAccountClass;
    mode: 'demo' | 'live';
    disposition: DirectionalArmDisposition;
    books: Set<string>;
    boots: Set<string>;
    ticks: number;
    firstAt: number;
    lastAt: number;
  }
  const byDay = new Map<string, Map<string, Agg>>();
  for (const t of armTallies.values()) {
    let day = byDay.get(t.etDay);
    if (!day) {
      day = new Map();
      byDay.set(t.etDay, day);
    }
    const cellKey = `${t.accountClass}\u0000${t.mode}\u0000${t.disposition}`;
    const agg = day.get(cellKey);
    if (!agg) {
      day.set(cellKey, {
        accountClass: t.accountClass,
        mode: t.mode,
        disposition: t.disposition,
        books: new Set([t.account]),
        boots: new Set([t.bootId]),
        ticks: t.ticks,
        firstAt: t.firstAt,
        lastAt: t.lastAt,
      });
      continue;
    }
    agg.books.add(t.account);
    agg.boots.add(t.bootId);
    // Summed across boots — the keys are bootId-scoped, so a re-flushed line was
    // already collapsed at hydrate and cannot be counted twice here.
    agg.ticks += t.ticks;
    if (t.firstAt < agg.firstAt) agg.firstAt = t.firstAt;
    if (t.lastAt > agg.lastAt) agg.lastAt = t.lastAt;
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([etDay, cells]) => ({
      etDay,
      cells: [...cells.values()]
        .map((a) => ({
          accountClass: a.accountClass,
          mode: a.mode,
          disposition: a.disposition,
          reachable: armDispositionIsReachable(a.disposition),
          books: a.books.size,
          ticks: a.ticks,
          boots: a.boots.size,
          firstAt: a.firstAt,
          lastAt: a.lastAt,
        }))
        .sort((x, y) => y.ticks - x.ticks),
    }));
}

/** Top-N symbols surfaced in the per-name view (counts stay complete internally). */
const TOP_SYMBOLS = 25;

/**
 * Fold the store into the read-only health diagnostics for `etDay` (the current ET
 * day at the caller). Pure — no IO. The per-name view is DIRECTIONAL-ONLY (TRA-1564
 * B2) so a `count` here is directly comparable to the directional cap; the rejects
 * are the DURABLE (TRA-1564 B1) count for that ET day so a post-close read is honest.
 */
export function summarizeDirectionalGate(etDay: string): DirectionalGateSummary {
  const day = directionalByDay.get(etDay);
  const openCounts = day
    ? [...day.entries()]
        .map(([symbol, count]) => ({ symbol, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_SYMBOLS)
    : [];
  const byCode: Record<string, number> = {};
  let rejectTotal = 0;
  const rej = rejectsByDay.get(etDay);
  if (rej) {
    for (const [code, count] of rej.entries()) {
      byCode[code] = count;
      rejectTotal += count;
    }
  }
  return {
    opensRecorded: directionalOpensTotal,
    openCountsBySymbol: openCounts,
    opensRejectedByCode: byCode,
    opensRejectedTotal: rejectTotal,
    trackedSymbols: day ? day.size : 0,
    lastOpenAt,
    lastRejectAt,
  };
}
