// TRA-406 — basic alerting.
//
// Turns four operational failure modes into an actionable alert:
//   • health-check    — `/api/health` stopped responding OK.
//   • disk-near-full  — the persistent disk is running out of space.
//   • restart-storm   — the process has restarted too many times in a window
//                       (the in-process proxy for "PM2 hit max_restarts").
//   • trade-volume-zero — no trades placed by mid-session on a market day.
//   • error-spike     — captured-exception rate crossed a threshold.
//
// An alert is recorded to `<LOG_DIR>/alerts.jsonl`, logged at error level, kept
// in a small in-memory ring buffer (read by `/api/health/alerts`), and — if a
// destination is configured — emailed (`ALERT_EMAIL`) and/or POSTed to a
// webhook (`ALERT_WEBHOOK_URL`). Each alert key is throttled so a sustained
// outage produces one alert per `ALERT_THROTTLE_MS`, not one per minute.

import { join } from 'path';
import { statfs, readFile } from 'fs/promises';
import { appendJsonLine, LOG_DIR, logger } from './logger.js';
import { sendOpsAlertEmail, isSmtpConfigured } from '../email.js';

export type AlertKey =
  | 'health-check'
  | 'disk-near-full'
  | 'restart-storm'
  | 'trade-volume-zero'
  | 'error-spike'
  | 'stale-state'
  // TRA-2284 — operator-triggered end-to-end probe of the alert PUSH path. Its
  // own key on purpose: it must never be mistaken for a real incident in the
  // ring/inbox, and it must not consume a real key's throttle window.
  | 'self-test';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  ts: string;
  key: AlertKey;
  severity: AlertSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

const ALERTS_LOG_FILE = join(LOG_DIR, 'alerts.jsonl');
const BOOT_HISTORY_FILE = join(LOG_DIR, 'boot-history.jsonl');

/** Minimum gap between two alerts of the same key. */
const ALERT_THROTTLE_MS = Number(process.env['ALERT_THROTTLE_MS'] ?? 30 * 60_000);

const ALERT_WEBHOOK_URL = process.env['ALERT_WEBHOOK_URL'];

const lastFiredAt = new Map<AlertKey, number>();
const ring: Alert[] = [];
const RING_SIZE = 100;

/** Recent alerts, newest last. Exposed for the `/api/health/alerts` endpoint. */
export function getRecentAlerts(): readonly Alert[] {
  return ring;
}

/** Clear throttle + buffer state. Test-only. */
export function __resetAlertsForTest(): void {
  lastFiredAt.clear();
  ring.length = 0;
}

export interface AlertingPosture {
  /** Whether any PUSH channel (email or webhook) can actually deliver an alert. */
  pushAlertingConfigured: boolean;
  /**
   * When no push channel is configured, alerting still records to the error log,
   * the on-disk `alerts.jsonl`, and the in-memory ring (readable via
   * `/api/health/alerts`). This names that fallback so a monitor can tell
   * "degraded, poll me" from "silently dark".
   */
  degradedTo: 'log+ring+poll' | null;
  channels: {
    email: { configured: boolean; recipientCount: number };
    webhook: { configured: boolean };
  };
  recent: {
    total: number;
    byKey: Partial<Record<AlertKey, number>>;
    newestTs: string | null;
    newestKey: AlertKey | null;
  };
}

/**
 * TRA-2136 — the alerting POSTURE: which push channels are wired and a count-only
 * summary of the recent alert ring. Exposed no-auth at `/api/health/alerting` so
 * ops can confirm alerting is not silently dark after a deploy — the exact risk
 * the Render env-var wipe created when SMTP became unrestorable. Counts only, no
 * alert detail (detail can carry host/path info, which is why `/api/health/alerts`
 * stays auth-gated).
 */
export function getAlertingPosture(): AlertingPosture {
  const recipientCount = (process.env['ALERT_EMAIL'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
  const emailConfigured = isSmtpConfigured() && recipientCount > 0;
  const webhookConfigured = Boolean(ALERT_WEBHOOK_URL);
  const pushAlertingConfigured = emailConfigured || webhookConfigured;

  const byKey: Partial<Record<AlertKey, number>> = {};
  for (const a of ring) byKey[a.key] = (byKey[a.key] ?? 0) + 1;
  const newest = ring.at(-1) ?? null;

  return {
    pushAlertingConfigured,
    degradedTo: pushAlertingConfigured ? null : 'log+ring+poll',
    channels: {
      email: { configured: emailConfigured, recipientCount },
      webhook: { configured: webhookConfigured },
    },
    recent: {
      total: ring.length,
      byKey,
      newestTs: newest?.ts ?? null,
      newestKey: newest?.key ?? null,
    },
  };
}

async function deliver(alert: Alert): Promise<void> {
  const subject = `[TradeAI ${alert.severity.toUpperCase()}] ${alert.key}`;
  const body = `${alert.message}\n\n${JSON.stringify(alert.detail ?? {}, null, 2)}\n\nat ${alert.ts}`;
  await Promise.allSettled([
    sendOpsAlertEmail(subject, body),
    ALERT_WEBHOOK_URL
      ? fetch(ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert),
          signal: AbortSignal.timeout(5000),
        }).then(() => undefined)
      : Promise.resolve(),
  ]);
}

/**
 * Raise an alert. Returns `true` if it fired, `false` if it was throttled by a
 * recent alert of the same key. Never throws.
 */
export function dispatchAlert(
  key: AlertKey,
  severity: AlertSeverity,
  message: string,
  detail?: Record<string, unknown>,
): boolean {
  const now = Date.now();
  const last = lastFiredAt.get(key) ?? 0;
  if (now - last < ALERT_THROTTLE_MS) return false;
  lastFiredAt.set(key, now);

  const alert: Alert = {
    ts: new Date().toISOString(),
    key,
    severity,
    message,
    ...(detail ? { detail } : {}),
  };

  ring.push(alert);
  if (ring.length > RING_SIZE) ring.shift();

  logger.error(`ALERT ${key}: ${message}`, { module: 'alerts', alertKey: key, severity, ...(detail ?? {}) });

  if (process.env['NODE_ENV'] !== 'test') {
    void appendJsonLine(ALERTS_LOG_FILE, JSON.stringify(alert));
    void deliver(alert).catch((err) =>
      logger.warn('alert delivery failed', {
        module: 'alerts',
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return true;
}

/**
 * TRA-2284 — result of the operator-triggered alerting self-test.
 *
 * Every field exists to separate a state that `dispatchAlert` deliberately
 * collapses. The real dispatch path is fire-and-forget (`void deliver(...)`) so
 * that a mail outage can never stall a monitor tick — which also means a caller
 * learns nothing about delivery. `/api/health/alerting` has the same blind spot
 * in the other direction: it reports `channels.email.configured: true` from
 * `isSmtpConfigured() && recipientCount > 0`, i.e. PRESENCE of credentials, and
 * reads identically whether the transport has ever accepted a message or not.
 * This is the missing failing state.
 */
export interface AlertSelfTestResult {
  /** False ⇒ throttled by a recent self-test; nothing was recorded or sent. */
  fired: boolean;
  /** Ms until the next self-test is allowed (0 when `fired`). */
  throttledForMs: number;
  /** Addresses parsed out of `ALERT_EMAIL`. Zero ⇒ nothing could be mailed. */
  recipientCount: number;
  /** Whether the SMTP transport credentials exist at all. */
  smtpConfigured: boolean;
  /**
   * True ONLY when the transport actually accepted the message. `false` with no
   * `error` means the send was never attempted (no recipients / no SMTP) — the
   * distinction `sendOpsAlertEmail`'s silent early return erases.
   */
  emailDelivered: boolean;
  webhookConfigured: boolean;
  error?: string;
  /** The alert as recorded into the ring / `alerts.jsonl` (absent when throttled). */
  alert?: Alert;
}

/**
 * Self-test throttle. Deliberately shorter than `ALERT_THROTTLE_MS` (30 min):
 * the abuse ceiling that matters is "one authenticated user cannot flood
 * `ALERT_EMAIL`", and 5 minutes holds that while leaving the probe usable during
 * an incident or a post-deploy check.
 */
const SELF_TEST_THROTTLE_MS = Number(process.env['ALERT_SELF_TEST_THROTTLE_MS'] ?? 5 * 60_000);

/**
 * TRA-2284 — fire a clearly-labelled alert through the REAL push path and AWAIT
 * the result, so an operator can prove the ops-alert channel delivers rather
 * than inferring it from configuration.
 *
 * Same recording as a real alert (error log + `alerts.jsonl` + the ring read by
 * `/api/health/alerts` and counted by `/api/health/alerting`), so a successful
 * probe also leaves a durable, no-auth-readable trace: `recent.newestKey`
 * becomes `self-test`. Uses the `self-test` key, so it neither masquerades as an
 * incident nor burns a real key's throttle window.
 *
 * Never throws — a transport failure comes back as `emailDelivered: false` plus
 * `error`, which the caller surfaces as a 502.
 */
export async function runAlertingSelfTest(requestedBy: string): Promise<AlertSelfTestResult> {
  const recipients = (process.env['ALERT_EMAIL'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const smtpConfigured = isSmtpConfigured();
  const webhookConfigured = Boolean(ALERT_WEBHOOK_URL);

  const now = Date.now();
  const last = lastFiredAt.get('self-test') ?? 0;
  const elapsed = now - last;
  if (elapsed < SELF_TEST_THROTTLE_MS) {
    return {
      fired: false,
      throttledForMs: SELF_TEST_THROTTLE_MS - elapsed,
      recipientCount: recipients.length,
      smtpConfigured,
      emailDelivered: false,
      webhookConfigured,
    };
  }
  lastFiredAt.set('self-test', now);

  const alert: Alert = {
    ts: new Date(now).toISOString(),
    key: 'self-test',
    severity: 'warning',
    message: 'Alerting self-test — NOT an incident. Confirms the ops-alert push path delivers.',
    detail: { requestedBy, recipientCount: recipients.length, smtpConfigured, webhookConfigured },
  };

  ring.push(alert);
  if (ring.length > RING_SIZE) ring.shift();
  logger.warn(`ALERT ${alert.key}: ${alert.message}`, {
    module: 'alerts',
    alertKey: alert.key,
    severity: alert.severity,
    requestedBy,
  });
  if (process.env['NODE_ENV'] !== 'test') {
    void appendJsonLine(ALERTS_LOG_FILE, JSON.stringify(alert));
  }

  const base: AlertSelfTestResult = {
    fired: true,
    throttledForMs: 0,
    recipientCount: recipients.length,
    smtpConfigured,
    emailDelivered: false,
    webhookConfigured,
    alert,
  };

  // `sendOpsAlertEmail` returns silently when there is nothing to send to, so
  // check the preconditions HERE rather than reading a resolved promise as proof.
  if (recipients.length === 0) {
    return { ...base, error: 'ALERT_EMAIL is empty — no recipient to mail' };
  }
  if (!smtpConfigured) {
    return { ...base, error: 'SMTP is not configured — alert email cannot be sent' };
  }

  try {
    await sendOpsAlertEmail(
      `[TradeAI SELF-TEST] alerting self-test (not an incident)`,
      `${alert.message}\n\n${JSON.stringify(alert.detail, null, 2)}\n\nat ${alert.ts}`,
    );
    return { ...base, emailDelivered: true };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── individual checks ────────────────────────────────────────────────────────

/**
 * Probe application health. `probe` resolves `true` when `/api/health` is OK.
 * A `false` result or a thrown probe raises a critical alert.
 */
export async function runHealthCheck(probe: () => Promise<boolean>): Promise<boolean> {
  let ok = false;
  try {
    ok = await probe();
  } catch (err) {
    dispatchAlert('health-check', 'critical', 'Health probe threw', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!ok) {
    dispatchAlert('health-check', 'critical', '/api/health is not returning OK');
  }
  return ok;
}

export interface DiskReading {
  path: string;
  freeBytes: number;
  totalBytes: number;
  freePct: number;
  /**
   * TRA-2420 — blocks free but reserved for root (`bfree - bavail`). `df` counts
   * these as USED, yet no writer put anything in them, so any "used minus what I
   * measured" residual credits them to a phantom writer. On ext4 the default
   * reserve is 5% of the filesystem, which is ~49 MB on bqb1's 1 GB volume.
   * Zero on NTFS/APFS, where `bfree === bavail`.
   */
  reservedBytes: number;
  /**
   * TRA-2817 — THE INODE AXIS. Total / free entries in the filesystem's inode
   * table (`statfs.files` / `statfs.ffree`), and free as a percentage.
   *
   * A filesystem has TWO exhaustible resources and `ENOSPC` is what both of
   * them raise. Grading only blocks gives the near-full alarm a shape with no
   * failing state on half of its own failure surface — and on 2026-07-30 that
   * half is the one that fired. `/data` on bqb1 returned `ENOSPC` on every
   * write for five days (the EOD ledger stopped dead across 47 books, TRA-2817)
   * while this reading served `freeBytes 383434752`, `freePct 37.6` and a clean
   * `belowThreshold: false`. It was never out of bytes. It was out of inodes:
   * 65524 of the 65536 entries an ext4 volume of this size gets, 39590 of them
   * held by `backups/`.
   *
   * `null` — never a fabricated 100% — on a filesystem that does not report an
   * inode table. Some do not (`files === 0` on several virtual and network
   * filesystems), and a synthesised "plenty free" there would rebuild exactly
   * the blind spot this field exists to remove: unmeasurable and healthy have
   * to stay distinguishable. `checkDiskSpace` therefore cannot fire on a `null`
   * axis, which is correct — it also cannot report one as a pass.
   */
  inodesTotal: number | null;
  inodesFree: number | null;
  inodeFreePct: number | null;
}

/** The `disk-near-full` threshold actually in force, in percent free. */
export function diskMinFreePct(): number {
  return Number(process.env['DISK_MIN_FREE_PCT'] ?? 10);
}

/**
 * TRA-2357 — read free space on the disk backing `path`. PURE: it never
 * dispatches, so a polled read-only surface can report headroom without emitting
 * an alert or, worse, silently consuming the `disk-near-full` throttle window and
 * suppressing the real one. Two surfaces call it: the OPEN
 * `/api/health/storage` (which publishes only `disk.belowThreshold` against this
 * threshold) and the admin `/api/health/storage/detail` (the byte figures) —
 * TRA-2599. Purity matters MORE now, not less: the open one is reachable by
 * anyone, so a dispatching reader there would let a stranger burn the throttle.
 *
 * `freeBytes` is `bavail` (space available to this non-root process), while
 * `totalBytes` is the full filesystem size including reserved blocks — so
 * `freePct` is deliberately the conservative figure the alert grades on, and
 * runs ~1-2 points below `(capacity - usage)` as a hosting dashboard reports it.
 */
export async function readDiskSpace(path: string): Promise<DiskReading | null> {
  try {
    const fs = await statfs(path);
    const totalBytes = fs.blocks * fs.bsize;
    const freeBytes = fs.bavail * fs.bsize;
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 100;
    // Never negative: a filesystem that reports bavail > bfree is lying, and a
    // negative reserve would inflate the attributable figure instead of the residual.
    const reservedBytes = Math.max(0, (fs.bfree - fs.bavail) * fs.bsize);
    // TRA-2817 — `files === 0` means "this filesystem has no inode table to
    // report", not "zero inodes exist". Treating it as a real reading would
    // publish `inodeFreePct: 0` on every tmpfs/NTFS mount and make the new axis
    // a permanent false alarm; fabricating 100 would make it a permanent green.
    // Neither. It is `null`, and `null` is NOT MEASURED.
    const hasInodes = Number.isFinite(fs.files) && fs.files > 0;
    const inodesTotal = hasInodes ? fs.files : null;
    const inodesFree = hasInodes && Number.isFinite(fs.ffree) ? Math.max(0, fs.ffree) : null;
    const inodeFreePct =
      inodesTotal != null && inodesFree != null ? (inodesFree / inodesTotal) * 100 : null;
    return {
      path,
      freeBytes,
      totalBytes,
      freePct,
      reservedBytes,
      inodesTotal,
      inodesFree,
      inodeFreePct,
    };
  } catch (err) {
    logger.warn('disk-space read failed', {
      module: 'alerts',
      path,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check free space on the disk backing `path`. Alerts when free space drops
 * below `minFreePct` (default 10%). Returns the reading for `/api/health`.
 */
export async function checkDiskSpace(
  path: string,
  minFreePct = diskMinFreePct(),
): Promise<DiskReading | null> {
  const reading = await readDiskSpace(path);
  if (!reading) return null;
  const { freeBytes, totalBytes, freePct, inodesTotal, inodesFree, inodeFreePct } = reading;
  // TRA-2817 — EITHER resource being exhausted means the disk cannot be written
  // to, and `ENOSPC` is what both of them raise. The blocks term alone let a
  // filesystem with 383 MB free and zero writable inodes alert nobody for five
  // days. The two are ORed, not chained: a blocks-only alarm must keep firing
  // exactly as before on a filesystem that reports no inode table at all.
  const blocksLow = freePct < minFreePct;
  const inodesLow = inodeFreePct != null && inodeFreePct < minFreePct;
  if (blocksLow || inodesLow) {
    // Name the resource that actually ran out. "Disk 37.6% free" as the subject
    // line of an inode exhaustion is the alert that gets closed as a false
    // positive — the number in it looks fine, because it is fine.
    const subject = inodesLow
      ? `Disk inodes ${inodeFreePct!.toFixed(1)}% free — below ${minFreePct}% (${freePct.toFixed(1)}% of BYTES still free; writes will fail with ENOSPC)`
      : `Disk ${freePct.toFixed(1)}% free — below ${minFreePct}%`;
    dispatchAlert('disk-near-full', 'critical', subject, {
      path,
      freeBytes,
      totalBytes,
      freePct,
      // TRA-2357 — the threshold is part of the reading. The 2026-07-25T20:33Z
      // CRITICAL was `16.3% free — below 99%`: a healthy disk against a bad
      // threshold. Without `minFreePct` in the detail, that alert is
      // indistinguishable from a genuine one.
      minFreePct,
      // TRA-2817 — which axis tripped, and both readings, so a responder is
      // never left inferring the resource from a byte figure that reads healthy.
      exhausted: inodesLow ? (blocksLow ? 'blocks+inodes' : 'inodes') : 'blocks',
      inodesTotal,
      inodesFree,
      inodeFreePct,
    });
  }
  return reading;
}

/** Read prior boot timestamps from `boot-history.jsonl`. Missing file → []. */
async function readBootHistory(): Promise<number[]> {
  try {
    const raw = await readFile(BOOT_HISTORY_FILE, 'utf-8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return Number((JSON.parse(line) as { bootMs?: number }).bootMs);
        } catch {
          return NaN;
        }
      })
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Record this process boot and alert if the process has restarted more than
 * `maxBoots` times within `windowMs`. This is the in-process signal for "PM2
 * is cycling the app" — `ecosystem.config.cjs` sets `max_restarts: 10`, so a
 * burst of boots means the app is crash-looping toward that ceiling.
 *
 * Without overrides it reads/appends `boot-history.jsonl`; `history` and
 * `persist` are injectable so the behaviour is unit-testable offline.
 */
export async function recordBootAndCheckRestarts(opts?: {
  maxBoots?: number;
  windowMs?: number;
  history?: number[];
  persist?: (bootTs: number) => Promise<void>;
}): Promise<{ bootsInWindow: number; alerted: boolean }> {
  const maxBoots = opts?.maxBoots ?? Number(process.env['MAX_BOOTS_PER_WINDOW'] ?? 5);
  const windowMs = opts?.windowMs ?? 10 * 60_000;
  const now = Date.now();

  const history = opts?.history ?? (await readBootHistory());

  if (opts?.persist) {
    await opts.persist(now);
  } else {
    void appendJsonLine(BOOT_HISTORY_FILE, JSON.stringify({ ts: new Date(now).toISOString(), bootMs: now }));
  }

  const cutoff = now - windowMs;
  const recent = history.filter((t) => t >= cutoff);
  const bootsInWindow = recent.length + 1; // +1 for this boot

  let alerted = false;
  if (bootsInWindow > maxBoots) {
    alerted = dispatchAlert(
      'restart-storm',
      'critical',
      `Process restarted ${bootsInWindow}x in ${Math.round(windowMs / 60_000)}min — approaching PM2 max_restarts`,
      { bootsInWindow, windowMinutes: Math.round(windowMs / 60_000) },
    );
  }
  return { bootsInWindow, alerted };
}

/**
 * Alert when no trades have been placed by mid-session on a market day. A
 * sudden drop to zero volume usually means the feed, scheduler or auth path
 * has silently broken.
 */
export function checkTradeVolume(opts: {
  tradeCountToday: number;
  etHour: number;
  isMarketDay: boolean;
  /** ET hour after which zero volume is suspicious. Default 12:00. */
  thresholdHour?: number;
}): boolean {
  const thresholdHour = opts.thresholdHour ?? 12;
  if (!opts.isMarketDay) return false;
  if (opts.etHour < thresholdHour) return false;
  if (opts.tradeCountToday > 0) return false;
  return dispatchAlert(
    'trade-volume-zero',
    'warning',
    `No trades placed by ${thresholdHour}:00 ET on a market day`,
    { etHour: opts.etHour },
  );
}

/** Alert when captured-error volume crosses `threshold` within its window. */
export function checkErrorSpike(errorCount: number, threshold = Number(process.env['ERROR_SPIKE_THRESHOLD'] ?? 25)): boolean {
  if (errorCount < threshold) return false;
  return dispatchAlert('error-spike', 'critical', `${errorCount} errors captured in the last 15 min`, {
    errorCount,
    threshold,
  });
}

/**
 * TRA-528 — alert when the market-data feed has gone stale while the market is
 * open. This is the direct detector for the recurring "nothing works in Live"
 * incident: the engine is up and `/api/health` is green, but no fresh quotes
 * are landing, so no signals fire and the desk silently stops trading.
 *
 * Fires a critical alert only when ALL of:
 *   - the market is open (a stale feed after hours is expected, not an incident);
 *   - the engine is tracking at least one symbol;
 *   - not one tracked symbol carries a fresh quote (`freshSymbols === 0`).
 *
 * Throttled on the `stale-state` key like every other alert, so a sustained
 * outage produces one alert per window rather than one per monitor tick.
 */
export function checkStaleState(opts: {
  marketOpen: boolean;
  trackedSymbols: number;
  freshSymbols: number;
  mode?: string;
  lastTickAgeSec?: number | null;
}): boolean {
  if (!opts.marketOpen) return false;
  if (opts.trackedSymbols <= 0) return false;
  if (opts.freshSymbols > 0) return false;
  return dispatchAlert(
    'stale-state',
    'critical',
    `Market open but 0/${opts.trackedSymbols} tracked symbols have a fresh quote — data feed appears stale`,
    {
      mode: opts.mode ?? 'unknown',
      trackedSymbols: opts.trackedSymbols,
      freshSymbols: opts.freshSymbols,
      lastTickAgeSec: opts.lastTickAgeSec ?? null,
    },
  );
}
