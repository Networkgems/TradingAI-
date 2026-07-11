import { logger } from './observability/index.js';

// TRA-1601 (TRA-1600 deliverable A) — CONFIGURABLE maker-fill chase ladder.
//
// The core maker-fill routing is the TRA-374 smart-open limit walk
// (`submitSmartBuyToOpen`: mid+1¢ stepping toward the ask, cancel-on-timeout,
// never crosses the ask). TRA-374 hard-coded both the walk schedule
// (`SMART_BUY_WALK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1.0]`) and the per-attempt
// wait window (30 000 ms). This module lifts those two knobs — plus a NEW
// "max cross ticks" knob that lets the last resort cross a bounded number of
// ticks past the ask — into operator-tunable env so the desk can retune the
// maker routing without a code change.
//
// DEFAULTS PRESERVE CURRENT BEHAVIOUR BYTE-FOR-BYTE: an unset env resolves to
// exactly the TRA-374 schedule, the 30 s wait, and zero cross ticks (the walk
// stops AT the ask, as today). Only an explicit, valid override changes the
// walk. A malformed override logs once and falls back to the default for that
// knob (never a partial / corrupt ladder), so a fat-fingered value can never
// widen the walk past the ask silently.

const log = logger.child({ module: 'option-maker-config' });

/** Env var: comma-separated walk fractions mid→ask, e.g. `0,0.25,0.5,0.75,1`. */
export const OPTION_MAKER_WALK_STEPS_ENV = 'OPTION_MAKER_WALK_STEPS';
/** Env var: per-attempt wait window in ms before cancelling and stepping up. */
export const OPTION_MAKER_STEP_WAIT_MS_ENV = 'OPTION_MAKER_STEP_WAIT_MS';
/** Env var: how many ticks past the ask the last-resort attempt may cross. */
export const OPTION_MAKER_MAX_CROSS_TICKS_ENV = 'OPTION_MAKER_MAX_CROSS_TICKS';

/**
 * TRA-374 walk schedule, kept as the default. Attempt 0 (fraction 0) is
 * special-cased in the walk to `mid + 1¢`; the rest are `mid + f × (ask − mid)`.
 */
export const DEFAULT_MAKER_WALK_FRACTIONS: readonly number[] = [0, 0.25, 0.5, 0.75, 1.0];
/** TRA-374 per-attempt wait window (30 s). */
export const DEFAULT_MAKER_STEP_WAIT_MS = 30_000;
/** TRA-374 behaviour: the walk stops AT the ask — never crosses it. */
export const DEFAULT_MAKER_MAX_CROSS_TICKS = 0;
/** Equity-option minimum price increment. */
export const OPTION_TICK_SIZE = 0.01;
/**
 * Hard cap on `maxCrossTicks` — a defensive backstop so an operator typo (e.g.
 * `1000`) can't turn the "bounded cross" into an effectively-unbounded market
 * order paying arbitrarily far above the ask.
 */
export const MAKER_MAX_CROSS_TICKS_LIMIT = 20;

export interface MakerWalkConfig {
  /**
   * Walk fractions mid→ask, ascending, deduped, each in [0, 1]. Fraction 0 is
   * the `mid + 1¢` bias step; 1 is the ask.
   */
  fractions: readonly number[];
  /** Per-attempt wait window in ms. */
  stepWaitMs: number;
  /** Ticks past the ask the last-resort attempt(s) may cross (0 = stop at ask). */
  maxCrossTicks: number;
  /** Price increment used to size the cross-tick steps. */
  tickSize: number;
}

/** The unset / all-defaults config — exactly the TRA-374 behaviour. */
export const DEFAULT_MAKER_WALK_CONFIG: MakerWalkConfig = {
  fractions: DEFAULT_MAKER_WALK_FRACTIONS,
  stepWaitMs: DEFAULT_MAKER_STEP_WAIT_MS,
  maxCrossTicks: DEFAULT_MAKER_MAX_CROSS_TICKS,
  tickSize: OPTION_TICK_SIZE,
};

/**
 * Parse the `OPTION_MAKER_WALK_STEPS` override into a validated, ascending,
 * deduped fraction list. Returns `null` (→ caller keeps the default) when the
 * value is absent, empty, or carries ANY non-finite / out-of-range token — we
 * never accept a partially-valid ladder, since a dropped step would silently
 * change how aggressively the walk chases.
 */
function parseWalkFractions(raw: string | undefined): number[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t !== '');
  if (tokens.length === 0) return null;
  const parsed: number[] = [];
  for (const tok of tokens) {
    const n = Number(tok);
    if (!Number.isFinite(n) || n < 0 || n > 1) return null;
    parsed.push(n);
  }
  // Ascending + deduped: the walk assumes each step is at least as aggressive
  // as the last (mid→ask). Sorting makes an out-of-order override safe rather
  // than rejecting it, and dedupe drops a repeated price.
  const sorted = Array.from(new Set(parsed)).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : null;
}

/** Parse a strictly-positive integer ms override; `null` → keep default. */
function parsePositiveInt(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Parse a non-negative integer tick count, capped; `null` → keep default. */
function parseNonNegativeTicks(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return Math.min(n, MAKER_MAX_CROSS_TICKS_LIMIT);
}

/**
 * Resolve the maker chase ladder from env. Each knob is independently validated;
 * a malformed value logs once and keeps that knob's default, leaving the others
 * honoured. With no env set this returns {@link DEFAULT_MAKER_WALK_CONFIG} — the
 * byte-for-byte TRA-374 behaviour.
 */
export function resolveMakerWalkConfig(env: NodeJS.ProcessEnv = process.env): MakerWalkConfig {
  const rawFractions = env[OPTION_MAKER_WALK_STEPS_ENV];
  const fractions = parseWalkFractions(rawFractions);
  if (rawFractions !== undefined && rawFractions.trim() !== '' && fractions === null) {
    log.warn('ignoring malformed OPTION_MAKER_WALK_STEPS — keeping default ladder', {
      raw: rawFractions,
      default: DEFAULT_MAKER_WALK_FRACTIONS,
    });
  }

  const rawWait = env[OPTION_MAKER_STEP_WAIT_MS_ENV];
  const stepWaitMs = parsePositiveInt(rawWait);
  if (rawWait !== undefined && rawWait.trim() !== '' && stepWaitMs === null) {
    log.warn('ignoring malformed OPTION_MAKER_STEP_WAIT_MS — keeping default wait', {
      raw: rawWait,
      default: DEFAULT_MAKER_STEP_WAIT_MS,
    });
  }

  const rawCross = env[OPTION_MAKER_MAX_CROSS_TICKS_ENV];
  const maxCrossTicks = parseNonNegativeTicks(rawCross);
  if (rawCross !== undefined && rawCross.trim() !== '' && maxCrossTicks === null) {
    log.warn('ignoring malformed OPTION_MAKER_MAX_CROSS_TICKS — keeping default (stop at ask)', {
      raw: rawCross,
      default: DEFAULT_MAKER_MAX_CROSS_TICKS,
    });
  }

  return {
    fractions: fractions ?? DEFAULT_MAKER_WALK_FRACTIONS,
    stepWaitMs: stepWaitMs ?? DEFAULT_MAKER_STEP_WAIT_MS,
    maxCrossTicks: maxCrossTicks ?? DEFAULT_MAKER_MAX_CROSS_TICKS,
    tickSize: OPTION_TICK_SIZE,
  };
}
