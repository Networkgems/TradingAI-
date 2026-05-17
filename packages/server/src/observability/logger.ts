// TRA-406 — structured logging.
//
// Replaces ad-hoc `console.log` with a single JSON-line logger so production
// incidents are queryable. Every record is written two ways:
//   1. stdout as one JSON object per line — Render/PM2 capture this stream.
//   2. an on-disk rotating file (`<LOG_DIR>/app.jsonl`) so the box itself
//      keeps a `grep`/`jq`-able history that survives a log-stream gap.
//
// Records carry the active per-request trace id (see `trace.ts`) so a line in
// `app.jsonl`, an entry in `errors.jsonl` and the `X-Trace-Id` response header
// all correlate to the same request.
//
// The module intentionally has no third-party dependency: it must never be the
// thing that crashes the process, and a logger that can't be imported offline
// is worse than no logger at all.

import { appendFile, mkdir, stat, rename } from 'fs/promises';
import { dirname, join } from 'path';
import { getTraceContext } from './trace.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Where the on-disk log files live. Defaults under DATA_DIR so they land on
 *  the Render persistent disk rather than the ephemeral build directory. */
export const LOG_DIR =
  process.env['LOG_DIR'] ?? join(process.env['DATA_DIR'] ?? process.cwd(), 'logs');

const APP_LOG_FILE = join(LOG_DIR, 'app.jsonl');

/** Lines below this level are dropped. `LOG_LEVEL=debug` opens the firehose. */
const MIN_LEVEL: LogLevel = ((): LogLevel => {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error'
    ? raw
    : 'info';
})();

/** Rotate a log file once it crosses this size (keeps one `.1` generation). */
const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Set by tests to keep `app.jsonl` writes out of the repo / CI sandbox. */
let fileSinkEnabled = process.env['NODE_ENV'] !== 'test' && process.env['LOG_NO_FILE'] !== '1';

export function setFileSinkEnabled(enabled: boolean): void {
  fileSinkEnabled = enabled;
}

export type LogFields = Record<string, unknown>;

interface LogRecord extends LogFields {
  ts: string;
  level: LogLevel;
  msg: string;
  traceId?: string;
  user?: string;
}

// ── on-disk sink ─────────────────────────────────────────────────────────────
//
// Appends are serialised through a per-file promise chain so concurrent
// callers can't interleave a half-written line or race the rotation rename.

const writeChains = new Map<string, Promise<void>>();

/**
 * Append a single line to `file`, creating the directory and rotating the file
 * when it grows past `MAX_LOG_BYTES`. Never throws — a logging failure must not
 * take down a trade tick — it degrades to a stderr notice instead.
 */
export function appendJsonLine(file: string, line: string): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      await mkdir(dirname(file), { recursive: true });
      try {
        const s = await stat(file);
        if (s.size > MAX_LOG_BYTES) {
          await rename(file, `${file}.1`).catch(() => undefined);
        }
      } catch {
        // File does not exist yet — nothing to rotate.
      }
      await appendFile(file, line + '\n', 'utf-8');
    } catch (err) {
      process.stderr.write(
        `[logger] failed to write ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });
  writeChains.set(file, next.catch(() => undefined));
  return next;
}

/** Resolve any in-flight file writes — used by the graceful-shutdown flush. */
export function flushLogs(): Promise<void> {
  return Promise.all([...writeChains.values()]).then(() => undefined);
}

// ── core emit ────────────────────────────────────────────────────────────────

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;

  const ctx = getTraceContext();
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx?.username ? { user: ctx.username } : {}),
    ...(fields ?? {}),
  };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // A field held a circular structure — fall back to a safe subset.
    line = JSON.stringify({ ts: record.ts, level, msg, serializeError: true });
  }

  // stdout/stderr — captured by PM2 + Render's log stream.
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');

  if (fileSinkEnabled) void appendJsonLine(APP_LOG_FILE, line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that stamps `bindings` onto every record (e.g. a module tag). */
  child(bindings: LogFields): Logger;
}

function makeLogger(bindings: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields => ({ ...bindings, ...(fields ?? {}) });
  return {
    debug: (msg, fields) => emit('debug', msg, merge(fields)),
    info: (msg, fields) => emit('info', msg, merge(fields)),
    warn: (msg, fields) => emit('warn', msg, merge(fields)),
    error: (msg, fields) => emit('error', msg, merge(fields)),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

/** Process-wide logger. Prefer `logger.child({ module: '...' })` per file. */
export const logger: Logger = makeLogger({});
