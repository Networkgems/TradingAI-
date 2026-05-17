// TRA-406 — error telemetry.
//
// Every captured exception becomes a structured record that is:
//   1. written to `<LOG_DIR>/errors.jsonl` — a dedicated, queryable error
//      stream separate from the general app log;
//   2. emitted through the logger at `error` level (so it also reaches stdout
//      and `app.jsonl` with the request's trace id);
//   3. forwarded, best-effort, to an external sink if one is configured.
//
// The external sink is intentionally pluggable. Set `ERROR_WEBHOOK_URL` to any
// HTTPS endpoint (a Sentry/Datadog ingest proxy, a Slack incoming webhook, an
// internal collector) and captured errors are POSTed there as JSON. This keeps
// the code free of a paid-vendor SDK while still satisfying "errors surface in
// a queryable destination": the destination is `errors.jsonl` locally and the
// webhook target remotely. Wiring a real Sentry DSN is then a config-only
// change on top of this hook.

import { join } from 'path';
import { appendJsonLine, LOG_DIR, logger } from './logger.js';
import { getTraceContext } from './trace.js';

const ERROR_LOG_FILE = join(LOG_DIR, 'errors.jsonl');
const ERROR_WEBHOOK_URL = process.env['ERROR_WEBHOOK_URL'];

export interface ErrorRecord {
  ts: string;
  traceId?: string;
  user?: string;
  /** Where the error was caught — e.g. `crypto-feed.coinbaseStats`. */
  scope: string;
  name: string;
  message: string;
  stack?: string;
  /** Arbitrary structured context (symbol, orderId, …). */
  context?: Record<string, unknown>;
}

/** Rolling in-memory window of recent capture timestamps, for the error-spike alert. */
const recentTimestamps: number[] = [];
const RECENT_WINDOW_MS = 15 * 60_000;

/** Count of errors captured in the last `windowMs` — read by the alert monitor. */
export function getErrorCountSince(windowMs: number = RECENT_WINDOW_MS): number {
  const cutoff = Date.now() - windowMs;
  return recentTimestamps.filter((t) => t >= cutoff).length;
}

function normalizeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { name: 'NonError', message: typeof err === 'string' ? err : JSON.stringify(err) };
}

async function forwardToSink(record: ErrorRecord): Promise<void> {
  if (!ERROR_WEBHOOK_URL) return;
  try {
    await fetch(ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // The error sink failing must not itself raise — degrade quietly.
    logger.warn('error webhook delivery failed', {
      module: 'observability',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Capture an exception. `scope` identifies the call site so errors can be
 * grouped (`grep '"scope":"tradier.smartClose"' errors.jsonl`). Returns the
 * trace id the error was filed under so a handler can echo it to the client.
 */
export function captureException(
  err: unknown,
  scope: string,
  context?: Record<string, unknown>,
): string | undefined {
  const ctx = getTraceContext();
  const norm = normalizeError(err);
  const record: ErrorRecord = {
    ts: new Date().toISOString(),
    ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx?.username ? { user: ctx.username } : {}),
    scope,
    name: norm.name,
    message: norm.message,
    ...(norm.stack ? { stack: norm.stack } : {}),
    ...(context ? { context } : {}),
  };

  recentTimestamps.push(Date.now());
  if (recentTimestamps.length > 1000) recentTimestamps.splice(0, recentTimestamps.length - 1000);

  logger.error(`[${scope}] ${norm.message}`, {
    module: 'error',
    scope,
    errName: norm.name,
    ...(norm.stack ? { stack: norm.stack } : {}),
    ...(context ?? {}),
  });

  if (process.env['NODE_ENV'] !== 'test') void appendJsonLine(ERROR_LOG_FILE, JSON.stringify(record));
  void forwardToSink(record);

  return ctx?.traceId;
}

/**
 * Install last-resort handlers for errors that escape every `try/catch`. An
 * uncaught exception leaves the process in an undefined state, so we capture,
 * flush and exit — PM2 then restarts a clean process. Unhandled rejections are
 * captured but not fatal.
 */
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    captureException(err, 'process.uncaughtException');
    // Give the async file write a moment, then hand the restart to PM2.
    setTimeout(() => process.exit(1), 250);
  });
  process.on('unhandledRejection', (reason) => {
    captureException(reason, 'process.unhandledRejection');
  });
}

/**
 * Express error-handling middleware. Captures the error against the request's
 * trace id and returns a JSON body that includes that id so a user can quote
 * it in a bug report. Mount it last, after all routes.
 */
export function errorMiddleware(
  err: unknown,
  _req: import('express').Request,
  res: import('express').Response,
  // The 4-argument signature is what marks this as an Express error handler;
  // `_next` is required for the shape even though we don't delegate.
  _next: import('express').NextFunction,
): void {
  const traceId = captureException(err, 'http.unhandled');
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error', traceId: traceId ?? null });
}
