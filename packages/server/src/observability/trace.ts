// TRA-406 — per-request trace correlation.
//
// A `traceId` is stamped on every HTTP request, threaded through async work
// via `AsyncLocalStorage`, echoed back on the `X-Trace-Id` response header,
// and picked up automatically by the logger and error sink. That makes it
// possible to take a trace id off a user's failed request and pull every log
// line and captured exception for that exact request out of `app.jsonl` /
// `errors.jsonl`.

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export interface TraceContext {
  traceId: string;
  /** Authenticated username, filled in once `requireAuth` has run. */
  username?: string;
  /** HTTP method + path, for log readability. */
  route?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** New random trace id. Exposed so background jobs can open their own trace. */
export function newTraceId(): string {
  return randomUUID();
}

/** The trace context for the current async chain, if any. */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Run `fn` inside a fresh trace context — used to scope background jobs. */
export function runWithTrace<T>(
  ctx: Partial<TraceContext> & { traceId?: string },
  fn: () => T,
): T {
  return storage.run({ traceId: ctx.traceId ?? newTraceId(), ...ctx }, fn);
}

/** Attach the authenticated username to the live trace (called from auth). */
export function setTraceUser(username: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.username = username;
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Express middleware: opens a trace for the request. Honours an inbound
 * `X-Trace-Id` (so a desktop client can correlate its own report) and falls
 * back to a fresh id otherwise. The id is set on the response header before
 * the handler runs so it is present even on a thrown error.
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = headerValue(req.headers['x-trace-id']);
  const traceId = inbound && inbound.length <= 64 ? inbound : newTraceId();
  res.setHeader('X-Trace-Id', traceId);
  storage.run({ traceId, route: `${req.method} ${req.path}` }, () => next());
}
