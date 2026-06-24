// TRA-747 (TRA-529 P2 §6.5) — the CFO spend guardrail for the advisory
// multi-agent layer. The CFO approved the envelope on TRA-746 with four operating
// conditions; this module enforces the cost ones IN CODE so the layer can never
// spend past them once the company Anthropic key is provisioned:
//
//   • a HARD per-user/day cap (acceptance #1) — every AgentRecommendation stamps its
//     real costUsd, the day's running total per user is accumulated here, and
//     `isOverUserDailyCap` halts that user/day at the cap. No untested cap. TRA-915
//     raised the board-approved figure from $2 to $10/user/day.
//   • a HARD company-wide daily ceiling (TRA-915, TRA-908 plan §4) — a second,
//     aggregate-level kill so total spend across ALL users can never run away even
//     if many users each stay under their per-user cap. `isOverCompanyDailyCap` halts
//     every user/day once the aggregate reaches the ceiling, and `recordAgentSpend`
//     fires a one-shot ALERT (error-level) the first time it is breached.
//   • a DAILY AGGREGATE readout across ALL users (acceptance #4) — the CFO owns the
//     P&L and wants the absolute number, not just the per-user bound. `agentSpendAggregate`
//     returns it for `GET /api/health/agent-spend`, and a one-shot daily INFO log
//     emits it for the record.
//   • a re-review tripwire (FYI per the issue) — a one-shot WARN when aggregate spend
//     first crosses the review level, the point at which the CFO revisits the envelope
//     BEFORE the hard ceiling stops spending.
//
// Pattern mirrors options-spend-store.ts (the TRA-658 monthly cap) but keyed by
// (user, ET/UTC day) with an aggregate roll-up. In-memory + process-global so the
// aggregate spans every per-user engine in the process; resets when the day rolls.
//
// TRA-1052 (TRA-1045 R1) — the COMMITTED per-user/day ledger is now mirrored to
// SQLite on the Render disk so the daily cap is not silently reset by a redeploy
// mid-day: each day-bucket hydrates its committed totals from the db on creation,
// and every commit upserts the new total. Fail-soft — when the db is unavailable
// the store behaves exactly as before (pure in-memory). The in-flight `reserved`
// map (R2) is intentionally NOT persisted: it nets to 0 at rest and a restart
// correctly forgets any call that was in flight when the process died.
import { logger } from './observability/index.js';
import { getStateDb, type StateDb } from './sqlite.js';

const log = logger.child({ module: 'agent-spend' });

// ─── TRA-1052 durable committed-ledger mirror ────────────────────────────────
// Table per (utc-day, user) holding ONLY committed (real-money) spend. Keyed so
// a day's totals are a single indexed range read on bucket hydration.
const spendTableReady = new WeakSet<object>();
function spendDb(): StateDb | null {
  const db = getStateDb();
  if (!db) return null;
  if (!spendTableReady.has(db)) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS agent_spend (
         day TEXT NOT NULL,
         user TEXT NOT NULL,
         spent_usd REAL NOT NULL,
         PRIMARY KEY (day, user)
       )`,
    );
    spendTableReady.add(db);
  }
  return db;
}

/** Load a day's committed per-user totals from the db into a fresh bucket. */
function hydrateBucket(b: DayBucket): void {
  const db = spendDb();
  if (!db) return;
  try {
    const rows = db.prepare('SELECT user, spent_usd FROM agent_spend WHERE day = ?').all(b.day) as Array<{
      user: string;
      spent_usd: number;
    }>;
    for (const r of rows) {
      if (Number.isFinite(r.spent_usd) && r.spent_usd > 0) b.perUser.set(r.user, r.spent_usd);
    }
    if (rows.length > 0) log.info('hydrated committed agent-spend ledger from SQLite', { day: b.day, users: rows.length });
  } catch (err) {
    log.warn('agent-spend: SQLite hydrate failed, continuing in-memory only', {
      day: b.day,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Persist a user's new committed running total for the day (idempotent upsert). */
function persistUserSpend(day: string, user: string, total: number): void {
  const db = spendDb();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO agent_spend (day, user, spent_usd) VALUES (?, ?, ?)
       ON CONFLICT(day, user) DO UPDATE SET spent_usd = excluded.spent_usd`,
    ).run(day, user, total);
  } catch (err) {
    log.warn('agent-spend: SQLite persist failed, in-memory total still updated', {
      day,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Per-user/day cap (TRA-746/TRA-747 §6.5; TRA-915 raised $2 → $10). Board-approved
 * recommended figure from the TRA-908 confirmation. Override via env.
 */
export const DEFAULT_DAILY_USER_CAP_USD = 10;
/** Aggregate level at which the CFO revisits the envelope (re-review tripwire, FYI). */
export const DEFAULT_AGGREGATE_REVIEW_USD = 50;
/**
 * HARD company-wide daily ceiling (TRA-915). Total spend across all users hard-stops
 * here regardless of per-user headroom — the runaway-spend backstop the board asked
 * for alongside the per-user bump. Sits above the re-review level so the CFO is warned
 * (review tripwire) before the ceiling actually cuts spend. Override via env.
 */
export const DEFAULT_COMPANY_DAILY_CAP_USD = 100;
/**
 * TRA-1045 R2 — conservative upper-bound estimate of a single advisory run's LLM
 * cost, RESERVED against the per-user/company ledgers the instant a paid call is
 * admitted (before the awaited model round-trip) and reconciled to the real cost
 * once it returns. This is what closes the read-then-write TOCTOU window: two
 * concurrent advisory calls for the same user can no longer both observe headroom
 * across the `await`, because the first call's reservation is already counted
 * toward the cap when the second checks. Default covers a typical 6-call run on the
 * cheap tiers (apex escalation is off by default); tune via env. Larger = more
 * conservative (fewer concurrent paid calls admitted near the boundary).
 */
export const DEFAULT_CALL_COST_ESTIMATE_USD = 2;
/** Env override for the per-user/day cap (USD). Empty/invalid → the default. */
export const USER_CAP_ENV_VAR = 'TRADING_AGENTS_DAILY_USER_USD_CAP';
/** Env override for the in-flight per-call reservation estimate (USD). */
export const CALL_COST_ESTIMATE_ENV_VAR = 'TRADING_AGENTS_CALL_COST_ESTIMATE_USD';
/** Env override for the aggregate re-review level (USD). */
export const AGGREGATE_REVIEW_ENV_VAR = 'TRADING_AGENTS_AGGREGATE_REVIEW_USD';
/** Env override for the company-wide daily ceiling (USD). */
export const COMPANY_CAP_ENV_VAR = 'TRADING_AGENTS_COMPANY_DAILY_USD_CAP';

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The enforced per-user/day cap in USD — env-configurable, defaulting to $10. */
export function dailyUserCapUsd(): number {
  return envUsd(USER_CAP_ENV_VAR, DEFAULT_DAILY_USER_CAP_USD);
}

/** The aggregate re-review level in USD — env-configurable, defaulting to $50. */
export function aggregateReviewUsd(): number {
  return envUsd(AGGREGATE_REVIEW_ENV_VAR, DEFAULT_AGGREGATE_REVIEW_USD);
}

/** The enforced company-wide daily ceiling in USD — env-configurable, defaulting to $100. */
export function companyDailyCapUsd(): number {
  return envUsd(COMPANY_CAP_ENV_VAR, DEFAULT_COMPANY_DAILY_CAP_USD);
}

/** The in-flight per-call reservation estimate in USD — env-configurable, default $2. */
export function callCostEstimateUsd(): number {
  return envUsd(CALL_COST_ESTIMATE_ENV_VAR, DEFAULT_CALL_COST_ESTIMATE_USD);
}

/** Calendar-day bucket key in UTC, e.g. "2026-06-09". */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface DayBucket {
  day: string;
  /** Recorded (committed, real-money) per-user spend for the day, USD. */
  perUser: Map<string, number>;
  /**
   * TRA-1045 R2 — in-flight per-user RESERVATIONS for paid calls that have been
   * admitted but not yet reconciled. Counted toward the caps so concurrent calls
   * see the headroom a sibling call already claimed. Always reconciled (committed
   * into `perUser` or released) when the call settles, so it nets to 0 at rest.
   */
  reserved: Map<string, number>;
  /** One-shot: aggregate crossed the re-review level. */
  reviewAlerted: boolean;
  /** One-shot: aggregate crossed the hard company-wide ceiling (TRA-915). */
  ceilingAlerted: boolean;
}

// Process-wide accumulator. Resets automatically when the calendar day rolls.
let bucket: DayBucket | null = null;

function currentBucket(now: number): DayBucket {
  const day = dayKey(now);
  if (!bucket || bucket.day !== day) {
    // On the day roll, emit the CLOSING aggregate readout for the day that just
    // ended (acceptance #4: a real end-of-day total, not a $0 start-of-day one).
    if (bucket) emitClosingReadout(bucket);
    bucket = { day, perUser: new Map(), reserved: new Map(), reviewAlerted: false, ceilingAlerted: false };
    // TRA-1052 — rehydrate the day's committed totals so a mid-day redeploy does
    // not reset the per-user cap (the in-flight `reserved` map is left empty).
    hydrateBucket(bucket);
  }
  return bucket;
}

/** Committed + in-flight reserved spend for a user — what the caps actually gate on. */
function effectiveUserSpend(b: DayBucket, u: string): number {
  return (b.perUser.get(u) ?? 0) + (b.reserved.get(u) ?? 0);
}

/** Committed + in-flight reserved spend across ALL users — the company-cap gate input. */
function effectiveCompanySpend(b: DayBucket): number {
  let total = 0;
  for (const spent of b.perUser.values()) total += spent;
  for (const r of b.reserved.values()) total += r;
  return total;
}

function emitClosingReadout(b: DayBucket): void {
  let total = 0;
  const perUser: Array<{ user: string; spentUsd: number }> = [];
  for (const [user, spent] of b.perUser) {
    total += spent;
    perUser.push({ user, spentUsd: round4(spent) });
  }
  perUser.sort((a, c) => c.spentUsd - a.spentUsd);
  log.info('trading-agents daily aggregate LLM spend readout (day closed)', {
    day: b.day,
    totalUsd: round2(total),
    userCount: perUser.length,
    userCapUsd: dailyUserCapUsd(),
    perUser,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Normalise a user key so an unset owner still has a stable bucket. */
function userKey(user: string | undefined): string {
  const u = (user ?? '').trim();
  return u === '' ? 'anonymous' : u;
}

export interface UserSpendStatus {
  /** UTC calendar day this total covers, e.g. "2026-06-09". */
  day: string;
  user: string;
  /** Recorded LLM spend so far today for this user, USD. */
  spentUsd: number;
  /** The enforced per-user/day cap, USD. */
  capUsd: number;
  /** Remaining headroom before the cap, USD (0 once reached). */
  remainingUsd: number;
  /** True once this user has reached the cap today — the layer stops spending. */
  overCap: boolean;
}

/** Snapshot of one user's spend vs the per-user/day cap. */
export function agentUserSpendStatus(user: string | undefined, now = Date.now()): UserSpendStatus {
  const b = currentBucket(now);
  const u = userKey(user);
  const cap = dailyUserCapUsd();
  const spent = b.perUser.get(u) ?? 0;
  return {
    day: b.day,
    user: u,
    spentUsd: round4(spent),
    capUsd: cap,
    remainingUsd: round4(Math.max(0, cap - spent)),
    overCap: spent >= cap,
  };
}

/**
 * Hard tripwire (acceptance #1): true once this user's recorded spend has reached
 * the per-user/day cap. The advisory layer reads this BEFORE issuing a paid LLM
 * call and falls back to the deterministic (zero-cost) path when it is true, so a
 * user/day can never spend past the cap.
 */
export function isOverUserDailyCap(user: string | undefined, now = Date.now()): boolean {
  const b = currentBucket(now);
  // TRA-1045 R2 — gate on committed + in-flight reserved spend so a sibling call's
  // not-yet-reconciled reservation counts here (closes the read-then-write TOCTOU).
  return effectiveUserSpend(b, userKey(user)) >= dailyUserCapUsd();
}

/**
 * Hard company-wide tripwire (TRA-915): true once the aggregate spend across ALL
 * users has reached the company-wide daily ceiling. The advisory layer reads this
 * BEFORE issuing a paid LLM call — alongside the per-user cap — and falls back to the
 * deterministic (zero-cost) path when it is true, so total company spend can never run
 * past the ceiling even when individual users still have per-user headroom.
 */
export function isOverCompanyDailyCap(now = Date.now()): boolean {
  const b = currentBucket(now);
  // TRA-1045 R2 — include in-flight reservations (see isOverUserDailyCap).
  return effectiveCompanySpend(b) >= companyDailyCapUsd();
}

export interface AggregateSpendStatus {
  /** UTC calendar day this total covers. */
  day: string;
  /** Total LLM spend across ALL users today, USD (the CFO's absolute number). */
  totalUsd: number;
  /** Per-user breakdown, sorted high→low. */
  perUser: Array<{ user: string; spentUsd: number }>;
  /** Number of users with any spend today. */
  userCount: number;
  /** The enforced per-user/day cap, USD. */
  userCapUsd: number;
  /** The aggregate level at which the CFO revisits the envelope. */
  reviewUsd: number;
  /** True once aggregate spend has crossed the re-review level. */
  overReview: boolean;
  /** The enforced company-wide daily ceiling, USD (TRA-915). */
  companyCapUsd: number;
  /** True once aggregate spend has reached the company-wide ceiling — the hard stop. */
  overCompanyCap: boolean;
}

/**
 * The DAILY AGGREGATE readout (acceptance #4): total $/day across all users plus a
 * per-user breakdown. Served by `GET /api/health/agent-spend` and logged once/day.
 */
export function agentSpendAggregate(now = Date.now()): AggregateSpendStatus {
  const b = currentBucket(now);
  let total = 0;
  const perUser: Array<{ user: string; spentUsd: number }> = [];
  for (const [user, spent] of b.perUser) {
    total += spent;
    perUser.push({ user, spentUsd: round4(spent) });
  }
  perUser.sort((a, c) => c.spentUsd - a.spentUsd);
  const reviewUsd = aggregateReviewUsd();
  const companyCapUsd = companyDailyCapUsd();
  return {
    day: b.day,
    totalUsd: round2(total),
    perUser,
    userCount: perUser.length,
    userCapUsd: dailyUserCapUsd(),
    reviewUsd,
    overReview: total >= reviewUsd,
    companyCapUsd,
    overCompanyCap: total >= companyCapUsd,
  };
}

/**
 * Record real (non-zero) LLM spend for a user against the current day. Emits a
 * one-shot WARN the first time the daily aggregate crosses the re-review level, and a
 * one-shot ERROR-level ALERT the first time it reaches the hard company-wide ceiling
 * (TRA-915). Non-positive or non-finite costs are ignored. Returns the user's new status.
 */
export function recordAgentSpend(
  user: string | undefined,
  costUsd: number,
  now = Date.now(),
): UserSpendStatus {
  const b = currentBucket(now);
  const u = userKey(user);
  if (Number.isFinite(costUsd) && costUsd > 0) {
    const total = (b.perUser.get(u) ?? 0) + costUsd;
    b.perUser.set(u, total);
    persistUserSpend(b.day, u, total); // TRA-1052 — durable committed ledger
    maybeEmitAggregateAlerts(b, now);
  }
  return agentUserSpendStatus(u, now);
}

/**
 * One-shot WARN when the daily aggregate first crosses the CFO re-review level, and a
 * one-shot ERROR-level ALERT the first time it reaches the hard company-wide ceiling
 * (TRA-915). Driven by COMMITTED spend (the real-money readout), shared by every path
 * that books spend (direct record + reservation commit, TRA-1045 R2).
 */
function maybeEmitAggregateAlerts(b: DayBucket, now: number): void {
  const agg = agentSpendAggregate(now);
  if (!b.reviewAlerted && agg.totalUsd >= aggregateReviewUsd()) {
    b.reviewAlerted = true;
    log.warn('trading-agents aggregate LLM spend crossed the CFO re-review level', {
      day: agg.day,
      totalUsd: agg.totalUsd,
      reviewUsd: agg.reviewUsd,
      userCount: agg.userCount,
    });
  }
  // TRA-915 — hard ceiling alert: spend is now cut to zero company-wide for the rest
  // of the day. Error-level so it pages, distinct from the FYI re-review WARN above.
  if (!b.ceilingAlerted && agg.overCompanyCap) {
    b.ceilingAlerted = true;
    log.error('trading-agents aggregate LLM spend BREACHED the company-wide daily ceiling — LLM advisory now disabled until the day rolls', {
      day: agg.day,
      totalUsd: agg.totalUsd,
      companyCapUsd: agg.companyCapUsd,
      userCount: agg.userCount,
    });
  }
}

/**
 * A claim on a slice of a user's daily budget for one in-flight paid advisory call
 * (TRA-1045 R2). Hold it across the awaited model call, then exactly one of
 * {@link commitReservation} (reconcile to the real cost) or {@link releaseReservation}
 * (the call ended up free / failed) settles it. Idempotent: a second settle is a no-op.
 */
export interface SpendReservation {
  user: string;
  /** Reserved estimate, USD — what currently counts toward the caps for this claim. */
  amountUsd: number;
  /** Day bucket key the reservation belongs to (guards against a day-roll race). */
  day: string;
  settled: boolean;
}

/**
 * Atomically admit one in-flight paid advisory call (TRA-1045 R2). This runs the cap
 * check AND books the reservation in a single synchronous step — with no `await`
 * between them — so two concurrent callers can never both pass the gate on stale
 * headroom. Returns a {@link SpendReservation} when the user is under the per-user cap
 * AND the company is under the daily ceiling (counting already-reserved in-flight
 * spend); returns null otherwise, signalling the caller to take the deterministic
 * zero-cost path. Always pair a non-null return with commit/release.
 */
export function tryReserveAgentSpend(user: string | undefined, now = Date.now()): SpendReservation | null {
  const b = currentBucket(now);
  const u = userKey(user);
  if (effectiveUserSpend(b, u) >= dailyUserCapUsd()) return null;
  if (effectiveCompanySpend(b) >= companyDailyCapUsd()) return null;
  const amountUsd = callCostEstimateUsd();
  b.reserved.set(u, (b.reserved.get(u) ?? 0) + amountUsd);
  return { user: u, amountUsd, day: b.day, settled: false };
}

/** Drop a reservation's hold without booking spend (no-op if already settled or day-rolled). */
function dropReservation(res: SpendReservation, now: number): DayBucket | null {
  if (res.settled) return null;
  res.settled = true;
  const b = currentBucket(now);
  // If the day rolled while the call was in flight, the old bucket is gone and its
  // reservations went with it — nothing to unwind.
  if (b.day !== res.day) return null;
  const remaining = (b.reserved.get(res.user) ?? 0) - res.amountUsd;
  if (remaining > 1e-9) b.reserved.set(res.user, remaining);
  else b.reserved.delete(res.user);
  return b;
}

/**
 * Reconcile a reservation to the call's REAL cost (TRA-1045 R2): release the in-flight
 * hold and book the actual committed spend, firing the aggregate alerts on the real
 * number. Non-positive / non-finite costs book nothing (the hold is simply released).
 */
export function commitReservation(
  res: SpendReservation,
  actualCostUsd: number,
  now = Date.now(),
): void {
  const b = dropReservation(res, now);
  if (!b) return;
  if (Number.isFinite(actualCostUsd) && actualCostUsd > 0) {
    const total = (b.perUser.get(res.user) ?? 0) + actualCostUsd;
    b.perUser.set(res.user, total);
    persistUserSpend(b.day, res.user, total); // TRA-1052 — durable committed ledger
    maybeEmitAggregateAlerts(b, now);
  }
}

/** Release a reservation that booked no spend — the call was free, deferred, or failed. */
export function releaseReservation(res: SpendReservation, now = Date.now()): void {
  dropReservation(res, now);
}

/**
 * Force-log the CURRENT running aggregate-spend readout (acceptance #4: "a simple
 * logged/queryable daily total is fine"). Intended for a once-daily scheduler hook
 * (e.g. the 9 PM ET close) so the day's total is on the record even if the process
 * does not survive to the natural day-roll readout. The live total is always
 * queryable at `GET /api/health/agent-spend`.
 */
export function logAgentSpendDailyReadout(now = Date.now()): void {
  const agg = agentSpendAggregate(now);
  log.info('trading-agents daily aggregate LLM spend readout', {
    day: agg.day,
    totalUsd: agg.totalUsd,
    userCount: agg.userCount,
    userCapUsd: agg.userCapUsd,
    perUser: agg.perUser,
  });
}

/** Test seam — reset the in-memory accumulator. */
export function resetAgentSpendForTests(): void {
  bucket = null;
}
