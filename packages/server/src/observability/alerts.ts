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
import { sendOpsAlertEmail } from '../email.js';

export type AlertKey =
  | 'health-check'
  | 'disk-near-full'
  | 'restart-storm'
  | 'trade-volume-zero'
  | 'error-spike'
  | 'stale-state';

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
}

/**
 * Check free space on the disk backing `path`. Alerts when free space drops
 * below `minFreePct` (default 10%). Returns the reading for `/api/health`.
 */
export async function checkDiskSpace(
  path: string,
  minFreePct = Number(process.env['DISK_MIN_FREE_PCT'] ?? 10),
): Promise<DiskReading | null> {
  try {
    const fs = await statfs(path);
    const totalBytes = fs.blocks * fs.bsize;
    const freeBytes = fs.bavail * fs.bsize;
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 100;
    const reading: DiskReading = { path, freeBytes, totalBytes, freePct };
    if (freePct < minFreePct) {
      dispatchAlert('disk-near-full', 'critical', `Disk ${freePct.toFixed(1)}% free — below ${minFreePct}%`, {
        path,
        freeBytes,
        totalBytes,
        freePct,
      });
    }
    return reading;
  } catch (err) {
    logger.warn('disk-space check failed', {
      module: 'alerts',
      path,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
