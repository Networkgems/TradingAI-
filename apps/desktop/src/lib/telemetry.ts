// TRA-413 — desktop error telemetry.
//
// The desktop client is a Tauri shell around the same React UI the mobile PWA
// uses. (The issue is titled "Electron"; the app has always been Tauri — the
// host process is Rust, not a Node main process. The design below is the Tauri
// equivalent and meets the same acceptance bar.)
//
// Before this, the app only had a React error boundary (TRA-398) whose reports
// hit a server route that merely `console.error`d them — they never reached the
// queryable error destination (`errors.jsonl` / `ERROR_WEBHOOK_URL`) that
// TRA-406 built for server-side errors. This module closes that gap from the
// renderer:
//
//   * `captureClientError` POSTs a structured record to `/api/client-error`,
//     which now files it through the server's `captureException` — so a desktop
//     error lands in the SAME destination as a server error.
//   * Every report carries a fresh `traceId`. The server files the error under
//     exactly that id, so the "something went wrong" screen can show it and a
//     user can quote it in a bug report.
//   * `installGlobalErrorHandlers` wires `window.onerror` /
//     `unhandledrejection`, capturing errors that escape React's render path.
//   * `installTraceHeader` patches `fetch` so every outbound API request
//     carries the session `X-Trace-Id`, correlating desktop activity with the
//     server traces it produces (the server's `traceMiddleware` honours an
//     inbound `X-Trace-Id`).
//   * `drainMainProcessCrashes` pulls panic records the Rust host process wrote
//     to a crash file and forwards them through the same path — so a host
//     (main-process) crash also surfaces in the queryable destination.

import { HTTP_URL } from '../server-url';

/** Where in the desktop client an error originated. */
export type ClientErrorSource =
  | 'renderer' // caught by the React error boundary
  | 'window.onerror' // uncaught error event on window
  | 'unhandledrejection' // unhandled promise rejection
  | 'tauri-main'; // panic in the Rust host process

/** The structured record POSTed to the server's `/api/client-error` route. */
export interface ClientErrorReport {
  /** Human-readable area name — e.g. the error boundary's `label`. */
  label: string;
  name: string;
  message: string;
  stack: string | null;
  componentStack: string | null;
  source: ClientErrorSource;
  /** Per-error id; the server files the error under this and the UI shows it. */
  traceId: string;
  /** Stable per-launch id shared by every request this session makes. */
  sessionTraceId: string;
  url: string | null;
  userAgent: string | null;
  time: string;
}

/** A new RFC-4122 id, with a non-crypto fallback for old webviews. */
export function newTraceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual generator */
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// One id per app launch. Every outbound request and error report this session
// produces shares it, so server traces from a single session group together.
let sessionTraceId = newTraceId();

/** The trace id shared by every request/report this session makes. */
export function getSessionTraceId(): string {
  return sessionTraceId;
}

/** Test-only: pin the session trace id so assertions are deterministic. */
export function _setSessionTraceIdForTest(id: string): void {
  sessionTraceId = id;
}

function normalizeError(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  if (typeof error === 'string') {
    return { name: 'NonError', message: error, stack: null };
  }
  try {
    return { name: 'NonError', message: JSON.stringify(error), stack: null };
  } catch {
    return { name: 'NonError', message: String(error), stack: null };
  }
}

// Best-effort delivery. The body is JSON but sent as text/plain on purpose: an
// application/json Content-Type is not CORS-safelisted, so cross-origin (the
// desktop webview hitting a remote API) it forces a preflight that silently
// drops `navigator.sendBeacon` POSTs. text/plain is safelisted; the server
// parses /api/client-error as text and JSON.parses the body. (See TRA-400.)
function deliver(report: ClientErrorReport): void {
  try {
    const body = JSON.stringify(report);
    const endpoint = `${HTTP_URL}/api/client-error`;
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const queued = navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }));
      if (queued) return;
    }
    if (typeof fetch === 'function') {
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        keepalive: true,
      }).catch(() => {
        /* reporting is best-effort */
      });
    }
  } catch {
    /* telemetry must never throw back into the code that was reporting */
  }
}

export interface CaptureOptions {
  source?: ClientErrorSource;
  componentStack?: string | null;
  /** Reuse a specific id (e.g. one already shown to the user). */
  traceId?: string;
}

/**
 * Capture a client-side error: build a structured record and forward it to the
 * server's queryable error destination. Returns the trace id the error was
 * filed under so a caller (the error boundary) can show it to the user. Never
 * throws — a telemetry failure must not compound the original error.
 */
export function captureClientError(
  label: string,
  error: unknown,
  opts: CaptureOptions = {},
): string {
  const traceId = opts.traceId ?? newTraceId();
  try {
    const norm = normalizeError(error);
    const report: ClientErrorReport = {
      label,
      name: norm.name,
      message: norm.message,
      stack: norm.stack,
      componentStack: opts.componentStack ?? null,
      source: opts.source ?? 'renderer',
      traceId,
      sessionTraceId,
      url: typeof window !== 'undefined' ? window.location.href : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      time: new Date().toISOString(),
    };
    deliver(report);
  } catch {
    /* never throw */
  }
  return traceId;
}

let globalHandlersInstalled = false;

/**
 * Capture errors that escape React's render path: uncaught `error` events and
 * unhandled promise rejections. Idempotent — safe to call once at startup.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') return;
  globalHandlersInstalled = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    captureClientError('window.onerror', event.error ?? event.message, {
      source: 'window.onerror',
    });
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    captureClientError('window.unhandledrejection', event.reason, {
      source: 'unhandledrejection',
    });
  });
}

let traceHeaderInstalled = false;

/**
 * Patch `fetch` so every request to our own server carries the session
 * `X-Trace-Id`. The server honours the inbound header, so an error it logs for
 * a desktop-triggered request shares a trace id with this client. An explicit
 * `X-Trace-Id` already on a request is left untouched. Idempotent.
 */
export function installTraceHeader(): void {
  if (traceHeaderInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return;
  }
  traceHeaderInstalled = true;
  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url && url.startsWith(HTTP_URL)) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has('X-Trace-Id')) {
          headers.set('X-Trace-Id', sessionTraceId);
          return original(input, { ...init, headers });
        }
      }
    } catch {
      /* header injection must never break a request */
    }
    return original(input, init);
  };
}

/**
 * Drain panic records the Rust host process wrote to its crash file and forward
 * each to the same destination renderer errors use. The host process has no
 * HTTP client and a panic there tears the app down before it could report, so
 * the renderer flushes the file on its next launch. A no-op outside Tauri (the
 * same bundle also ships as a plain PWA).
 */
export async function drainMainProcessCrashes(): Promise<void> {
  try {
    const hasTauri =
      typeof window !== 'undefined' &&
      (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null;
    if (!hasTauri) return;

    const { invoke } = await import('@tauri-apps/api/core');
    const reports = await invoke<string[]>('take_crash_reports');
    for (const raw of reports) {
      let rec: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') rec = parsed as Record<string, unknown>;
      } catch {
        /* unparseable line — fall back to the raw text as the message */
      }
      const message = typeof rec['message'] === 'string' ? rec['message'] : raw;
      const err = new Error(message);
      err.name = 'HostProcessPanic';
      if (typeof rec['location'] === 'string') err.stack = `panic at ${rec['location']}`;
      captureClientError('main-process.panic', err, {
        source: 'tauri-main',
        ...(typeof rec['traceId'] === 'string' ? { traceId: rec['traceId'] } : {}),
      });
    }
  } catch {
    /* draining crashes is best-effort */
  }
}
