// TRA-1481 (parent TRA-1408) — deterministic, in-memory telemetry for the
// per-name churn + same-day-loss brake.
//
// QuantTrader's post-close forward-validation (bqb1 build aabcfc8a) could only
// INFER the brake state from desk churn — two full demo sessions before the
// finding could be called ("armed-but-inert"). This module is the deterministic
// surface `GET /api/health/churn-brake` folds so the brake's behaviour is
// observable in one read instead of reconstructed from `/api/reports/desk`:
//
//   • per-symbol NEW-open counters for the current ET session (mirrors the
//     signal-engine's `churnOpensToday`, written from the SAME `recordChurnOpen`
//     chokepoint so the two never diverge);
//   • the count of opens the same-session cap actually REJECTED (the Nth+1 open
//     that was refused) — the direct evidence the cap is enforcing;
//   • the count of conviction-DCA adds the same-day-loss rule HALTED, split by
//     equity vs option leg.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. It NEVER places an order or mutates an account; the
// engine calls in ONLY on the demo chokepoints (the record/reject/halt helpers
// are no-ops on the live path), so every counter here reflects the DEMO book.
//
// In-memory + monotonic-since-boot (no JSONL): the per-symbol open counts are
// per-ET-session by construction (they roll at the ET-day boundary, exactly like
// the engine counter they mirror), and the reject/halt totals are since-boot —
// the same reset-on-reboot contract as `/api/health/live-equity`. A validation
// run reads them within a session, so disk durability buys nothing here.

/** Which conviction-DCA leg the same-day-loss rule halted. */
export type ChurnDcaLeg = 'equity' | 'option';

/** A per-symbol NEW-open counter scoped to one ET session. */
interface EtDayCount {
  etDay: string;
  count: number;
}

/** One reject/halt event for the rolling debug tail. */
export interface ChurnBrakeEvent {
  ts: number;
  kind: 'open_rejected' | 'dca_halted';
  symbol: string;
  /** For open_rejected: `${count}/${cap}` at the reject. For dca_halted: the ET-day net. */
  detail: string;
  /** DCA leg, only on dca_halted events. */
  leg?: ChurnDcaLeg;
}

/** Rolling recent-events retention for the health tail (counts stay complete). */
const MAX_RECENT_EVENTS = 50;
/** Top-N symbols surfaced in the per-symbol open/reject views (counts stay complete internally). */
const TOP_SYMBOLS = 25;

// ── Module-global store (backs GET /api/health/churn-brake) ──────────────────
let opensRejectedTotal = 0;
let dcaHaltedEquity = 0;
let dcaHaltedOption = 0;
let lastOpenRejectAt: number | null = null;
let lastDcaHaltAt: number | null = null;
const opensBySymbol = new Map<string, EtDayCount>();
const rejectsBySymbol = new Map<string, number>();
const haltsBySymbol = new Map<string, number>();
const recentEvents: ChurnBrakeEvent[] = [];

/** Test seam — drop every counter and event. */
export function clearChurnBrakeLedger(): void {
  opensRejectedTotal = 0;
  dcaHaltedEquity = 0;
  dcaHaltedOption = 0;
  lastOpenRejectAt = null;
  lastDcaHaltAt = null;
  opensBySymbol.clear();
  rejectsBySymbol.clear();
  haltsBySymbol.clear();
  recentEvents.length = 0;
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function pushEvent(ev: ChurnBrakeEvent): void {
  recentEvents.push(ev);
  while (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
}

/**
 * Mirror one recorded DEMO NEW-open against the per-name session counter. Called
 * from the SAME `recordChurnOpen` chokepoint the engine's own `churnOpensToday`
 * feeds, so this surface and the enforcement counter can never drift. Resets a
 * symbol's count at the ET-day roll (same-session semantics).
 */
export function recordChurnBrakeOpen(symbol: string, etDay: string): void {
  const sym = normSymbol(symbol);
  const rec = opensBySymbol.get(sym);
  const count = rec && rec.etDay === etDay ? rec.count : 0;
  opensBySymbol.set(sym, { etDay, count: count + 1 });
}

/**
 * Record one NEW open REJECTED by the same-session cap (the Nth+1 open refused).
 * `count`/`cap` are the verdict values at the reject. Monotonic since boot.
 */
export function recordChurnBrakeOpenRejected(
  symbol: string,
  count: number,
  cap: number,
  now: number = Date.now(),
): void {
  const sym = normSymbol(symbol);
  opensRejectedTotal += 1;
  rejectsBySymbol.set(sym, (rejectsBySymbol.get(sym) ?? 0) + 1);
  lastOpenRejectAt = now;
  pushEvent({ ts: now, kind: 'open_rejected', symbol: sym, detail: `${count}/${cap}` });
}

/**
 * Record one conviction-DCA add HALTED by the same-day-loss rule. `leg` splits
 * equity vs option; `netEtDay` is the name's realized+unrealized net at the halt.
 * Monotonic since boot.
 */
export function recordChurnBrakeDcaHalt(
  symbol: string,
  leg: ChurnDcaLeg,
  netEtDay: number,
  now: number = Date.now(),
): void {
  const sym = normSymbol(symbol);
  if (leg === 'equity') dcaHaltedEquity += 1;
  else dcaHaltedOption += 1;
  haltsBySymbol.set(sym, (haltsBySymbol.get(sym) ?? 0) + 1);
  lastDcaHaltAt = now;
  pushEvent({ ts: now, kind: 'dca_halted', symbol: sym, detail: netEtDay.toFixed(2), leg });
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface ChurnBrakeSymbolOpens {
  symbol: string;
  etDay: string;
  count: number;
}

export interface ChurnBrakeSymbolCount {
  symbol: string;
  count: number;
}

export interface ChurnBrakeSummary {
  /** Total opens the same-session cap rejected (since boot). */
  opensRejected: number;
  /** Per-symbol rejections, most-rejected first (top N). */
  opensRejectedBySymbol: ChurnBrakeSymbolCount[];
  /** Total conviction-DCA adds the same-day-loss rule halted (since boot). */
  dcaAddsHalted: number;
  /** Halt split by leg. */
  dcaAddsHaltedByLeg: { equity: number; option: number };
  /** Distinct symbols currently tracked with ≥1 recorded open. */
  trackedSymbols: number;
  /** Per-symbol current-session open counters, busiest first (top N). */
  openCountsBySymbol: ChurnBrakeSymbolOpens[];
  /** ms epoch of the last reject / halt (null if none yet). */
  lastOpenRejectAt: number | null;
  lastDcaHaltAt: number | null;
  /** Most-recent reject/halt events, oldest→newest (capped tail). */
  recent: ChurnBrakeEvent[];
}

/** Fold the store into the read-only health diagnostics. Pure — no IO. */
export function summarizeChurnBrake(): ChurnBrakeSummary {
  const openCounts = [...opensBySymbol.entries()]
    .map(([symbol, rec]) => ({ symbol, etDay: rec.etDay, count: rec.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SYMBOLS);
  const rejects = [...rejectsBySymbol.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SYMBOLS);
  return {
    opensRejected: opensRejectedTotal,
    opensRejectedBySymbol: rejects,
    dcaAddsHalted: dcaHaltedEquity + dcaHaltedOption,
    dcaAddsHaltedByLeg: { equity: dcaHaltedEquity, option: dcaHaltedOption },
    trackedSymbols: opensBySymbol.size,
    openCountsBySymbol: openCounts,
    lastOpenRejectAt,
    lastDcaHaltAt,
    recent: recentEvents.slice(-MAX_RECENT_EVENTS),
  };
}
