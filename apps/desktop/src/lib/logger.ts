// TRA-409 — structured client logger.
//
// The desktop app previously swallowed every failure with `catch { /* ignore */ }`,
// so WebSocket parse errors, HTTP polling failures and close-order errors left no
// trace. This logger gives every catch site a single, consistent reporting path:
// it writes to the console with a stable `[scope]` prefix and fans the entry out
// to any registered sinks (e.g. a future server-telemetry uploader), so wiring a
// remote sink later does not require touching every call site.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  /** Short, stable area name — e.g. 'ws', 'http', 'close-order'. */
  scope: string;
  message: string;
  /** Optional structured payload; errors are normalized before they reach sinks. */
  detail?: unknown;
  /** Epoch ms when the entry was emitted. */
  ts: number;
}

export type LogSink = (entry: LogEntry) => void;

const sinks: LogSink[] = [];

/**
 * Register a sink that receives every subsequent log entry. Returns an
 * unsubscribe function. A sink that throws is isolated so it can never break
 * the caller that was only trying to log a failure.
 */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

/** Test-only: drop all registered sinks. */
export function _resetLogSinks(): void {
  sinks.length = 0;
}

/** Convert an unknown thrown value into a plain, serializable shape. */
export function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (typeof error === 'string') {
    return { name: 'NonError', message: error };
  }
  try {
    return { name: 'NonError', message: JSON.stringify(error) };
  } catch {
    return { name: 'NonError', message: String(error) };
  }
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): LogEntry {
  const entry: LogEntry = { level, scope, message, detail, ts: Date.now() };
  const consoleFn: (...args: unknown[]) => void =
    level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : level === 'debug' ? console.debug
    : console.info;
  if (detail === undefined) {
    consoleFn(`[${scope}] ${message}`);
  } else {
    consoleFn(`[${scope}] ${message}`, detail);
  }
  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // A sink failure must never break the code path that was logging.
    }
  }
  return entry;
}

export const logger = {
  debug: (scope: string, message: string, detail?: unknown) => emit('debug', scope, message, detail),
  info: (scope: string, message: string, detail?: unknown) => emit('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: unknown) => emit('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: unknown) => emit('error', scope, message, detail),
};

/**
 * Log a caught error. Use this in place of `catch { /* ignore *\/ }` so the
 * failure is at least visible in the console and forwarded to telemetry sinks.
 */
export function logError(scope: string, message: string, error: unknown): LogEntry {
  return emit('error', scope, message, normalizeError(error));
}
