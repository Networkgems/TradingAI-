// TRA-409 — WebSocket reconnect backoff.
//
// The dashboards reconnect their WebSocket on a flat 3s timer, which hammers
// the server during an outage. computeBackoff produces an exponential delay
// with optional jitter; createReconnectController wraps the attempt counter so
// reconnect logic is testable in isolation (TRA-409 acceptance: "cover
// WebSocket reconnect").

export interface BackoffOptions {
  /** Delay for the first retry, in ms. */
  baseMs?: number;
  /** Hard ceiling on any single delay, in ms. */
  maxMs?: number;
  /** Multiplier applied per attempt. */
  factor?: number;
  /**
   * When true, the returned delay is randomized within [delay/2, delay] to
   * avoid a thundering herd of clients reconnecting in lockstep.
   */
  jitter?: boolean;
}

const DEFAULTS: Required<BackoffOptions> = {
  baseMs: 1000,
  maxMs: 30000,
  factor: 2,
  jitter: true,
};

/**
 * Compute the reconnect delay for a given zero-based attempt number.
 * Attempt 0 -> baseMs, attempt 1 -> baseMs*factor, ... capped at maxMs.
 */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs, maxMs, factor, jitter } = { ...DEFAULTS, ...options };
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, safeAttempt));
  if (!jitter) return Math.round(raw);
  return Math.round(raw / 2 + Math.random() * (raw / 2));
}

export interface ReconnectController {
  /** Delay (ms) to wait before the next reconnect attempt; advances the counter. */
  nextDelay: () => number;
  /** Reset the attempt counter — call after a connection succeeds. */
  reset: () => void;
  /** Current zero-based attempt count (number of failures so far). */
  readonly attempts: number;
}

/**
 * Stateful helper around computeBackoff. Each nextDelay() call returns the
 * delay for the current attempt and increments the counter; reset() returns to
 * attempt 0 once the socket is healthy again.
 */
export function createReconnectController(options: BackoffOptions = {}): ReconnectController {
  let attempt = 0;
  return {
    nextDelay() {
      const delay = computeBackoff(attempt, options);
      attempt += 1;
      return delay;
    },
    reset() {
      attempt = 0;
    },
    get attempts() {
      return attempt;
    },
  };
}
