// TRA-4378 (parent TRA-4053, CEO ruling `fe0369d7` + riders R1–R5) — the
// board-approved BOUNDED EXPLORATION ALLOWANCE for `single_leg_directional`.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The demo cost-aware bar has held `single_leg_directional` at 0 admits /
// 12,452 rejects (durable window, 2026-09-08) since 2026-08-12. The gate's
// admission basis is the journal tape of the very sleeve it gates, so the
// evidence can never accrue: `insufficient_evidence` is a DEADLOCK, not a
// delay (TRA-4044, TRA-4053). A config/env carve-out is impossible on the
// shipped surface — `ENABLE_OPTION_COST_AWARE_GATE` is one flag over all
// three options structures, and the one per-structure env lever
// (`OPTION_NET_EDGE_STRUCTURES`) fails closed on the SAME starved statistic
// (TRA-4053 comment `e8a994d7`). The CEO therefore authorized exactly this
// minimal code change (rider R3): structure-scoped, flag-gated, demo-only,
// `liveCapitalReachable: false`, default-off, removable in one revert.
//
// ── WHAT IT DOES ─────────────────────────────────────────────────────────────
// When the flat cost bar REJECTS a demo `directional` candidate and this
// allowance is armed and within every cap, the candidate is ADMITTED instead
// (recorded as an admit on the `directional` ledger row, which is what the
// pre-registered control 1 reads). Board-approved caps, ENFORCED IN CODE:
//
//   • 25 exploration opens, then self-disarm            (`row_cap`)
//   • −$600 cumulative realized demo P&L, then self-disarm (`pnl_cap`)
//   • $150 at-risk per open (sizing is clamped at the open site)
//   • max 2 concurrent exploration positions; max 2 new opens per ET session
//   • 40 trading sessions from arm, then UNCONDITIONAL expiry (`box_expiry`)
//
// The 40-session box is a PURE FUNCTION of `armedEtDay` and the market
// calendar (`isMarketDayIso` — the same predicate the close ledger and the
// denominator tape gate on), so expiry fires on any read or consult with no
// external trigger, survives restarts, and does not depend on the engine
// having scanned. Terminal disarms (`row_cap` / `pnl_cap` / `box_expiry` /
// `scope_drift`) are PERSISTED: once bound they survive flag flips and
// reboots. `flag_off` is the one reversible state — it is the resolved flag,
// not a recorded event.
//
// ── CONTAINMENT (why live capital is unreachable) ────────────────────────────
// The ONLY caller of {@link explorationBypassGrant} is the `mode === 'demo'`
// branch of `SignalEngine.costAwareGateReject`, for `structure ===
// 'directional'` only; the live branch of that method never consults this
// module, and no live order site imports it. The open the grant authorizes is
// a paper open (`openOptionFromRvCandidate`, demo — no equity override, no
// Tradier mirror). Removability: revert this module + its four wiring points
// (signal-engine grant/commit, options-account `maxAtRiskUsd` clamp, index.ts
// hydrate/listener, health route block) — one commit, and the gate returns to
// today's behaviour byte-for-byte. With the flag unset the whole module is
// inert: `explorationBypassGrant` refuses before touching any state.
//
// ── ATTRIBUTION (pre-registration `2cf70382` §"Counting S2/S3") ──────────────
// `rowsUsed` is incremented by THIS module when the open it authorized is
// COMMITTED (the paper position actually opened), keyed by the position id the
// journal row shares — never re-derived by filtering the journal on
// structure/sleeve stamps (a lot's two legs can carry different `sleeve`
// stamps — TRA-3926). Realized P&L resolves per committed open via the
// journal's own close notification for that exact row id (`onOptionTradeClose`
// — the close row's `realizedPnlUsd` is CUMULATIVE, partials included, per
// TRA-2895). A grant that never reaches an open (delta ceiling, dedup, sizing
// or cash refusal) consumes NOTHING — the 25-row budget buys trades, not scan
// passes; the gate ledger's `admitted` counter is the record of grants.
//
// ── DURABILITY ───────────────────────────────────────────────────────────────
// JSONL under DATA_DIR (same substrate as `cost-aware-gate-ledger`), hydrated
// on boot, NEVER compacted — the whole file is ≤ ~55 lines by construction
// (1 arm + 25 opens + 25 closes + terminal disarms) and every line is a cap
// input. A hydrate FAILURE fails closed: grants refuse and the health block
// publishes `null` counters (absent ⇒ UNREAD, never OK), because caps that
// cannot be read must not be presumed unbound.

import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { isMarketDayIso } from './scheduler.js';
import { DIRECTIONAL_STRUCTURE_LABEL, classifySpreadCeilingAccount } from './option-spread-cost.js';
import { appendBoundedTapeLineSync } from './data-tape-bounds.js';

const log = logger.child({ module: 'directional-exploration-allowance' });

export const EXPLORATION_ALLOWANCE_LOG_FILENAME = 'directional-exploration-allowance.jsonl';

/**
 * Master switch. OFF by default (an unset/malformed value is OFF), demo-flags
 * overlay capable so QuantTrader arms it without a redeploy, exactly like
 * `ENABLE_OPTION_COST_AWARE_GATE`. Turning it off mid-run reads `flag_off` and
 * stops new grants immediately; open exploration positions still run their
 * exits (the allowance governs ADMISSION only, never an exit).
 */
export const DIRECTIONAL_EXPLORATION_FLAG = 'ENABLE_DIRECTIONAL_EXPLORATION_ALLOWANCE';

/**
 * The cost-aware-gate ledger key this allowance's admits land on. NOT the
 * sleeve label: `retained.byStructure` publishes BOTH `directional` (the cost
 * bar ledger) and `single_leg_directional` (spread-ceiling counters only,
 * `barR null`). Control 1 reads the `directional` row (pre-registration
 * `2cf70382` §2b) — keying anything here to the full-length twin would read 0
 * forever, including when the allowance works perfectly.
 */
export const EXPLORATION_GATE_STRUCTURE = 'directional';

/** Board-approved caps (TRA-4053 card `17e5f566`, accepted 2026-09-08). Not tunable — no env knob on purpose. */
export const EXPLORATION_CAPS = {
  rowCap: 25,
  pnlCapUsd: -600,
  perOpenAtRiskCapUsd: 150,
  maxConcurrent: 2,
  maxPerSession: 2,
  sessionBox: 40,
} as const;

/** Terminal (persisted) disarm reasons. `flag_off` is deliberately absent — it is resolved state, not an event. */
export type ExplorationTerminalReason = 'row_cap' | 'pnl_cap' | 'box_expiry' | 'scope_drift';

type ExplorationEvent =
  | { kind: 'arm'; etDay: string; ts: number }
  | { kind: 'open'; id: string; occ: string | null; atRiskUsd: number; etDay: string; ts: number }
  | { kind: 'close'; id: string; realizedPnlUsd: number; etDay: string; ts: number }
  | { kind: 'disarm'; reason: ExplorationTerminalReason; etDay: string; ts: number };

interface ExplorationOpenState {
  occ: string | null;
  atRiskUsd: number;
  etDay: string;
  ts: number;
  closed: boolean;
  realizedPnlUsd: number | null;
}

// ── In-memory state, rebuilt from JSONL on boot ──────────────────────────────
let dataDir: string | null = null;
let armedEtDay: string | null = null;
let disarm: { reason: ExplorationTerminalReason; etDay: string; ts: number } | null = null;
const opens = new Map<string, ExplorationOpenState>();
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedEvents = 0;
/** True ⇒ the on-disk state exists but could not be read. Fails every grant closed. */
let stateUnreadable = false;
/** In-memory (since-boot) refusal tally — legibility for "armed and quiet". */
const refusals: Record<string, number> = {};

/**
 * The one-shot grant→commit handshake. `costAwareGateReject` sets it when it
 * admits a directional candidate under the allowance; the directional open
 * site consumes it UNCONDITIONALLY on the very next line after the gate call,
 * so a grant can never leak onto a later candidate. Everything between grant
 * and commit is synchronous (no awaits), so at most one grant is ever
 * outstanding.
 */
let pendingGrant: { etDay: string; ts: number } | null = null;

export function explorationAllowanceLogPath(dir: string): string {
  return join(dir, EXPLORATION_ALLOWANCE_LOG_FILENAME);
}

/** Test seam — reset every module-level cell (mirrors the sibling ledgers). */
export function clearExplorationAllowanceForTests(): void {
  dataDir = null;
  armedEtDay = null;
  disarm = null;
  opens.clear();
  appendErrors = 0;
  lastAppendError = null;
  hydratedEvents = 0;
  stateUnreadable = false;
  pendingGrant = null;
  for (const k of Object.keys(refusals)) delete refusals[k];
}

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the exploration allowance flag itself is set (1/true/yes/on). */
export function isExplorationAllowanceFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[DIRECTIONAL_EXPLORATION_FLAG]);
}

function apply(ev: ExplorationEvent): void {
  if (ev.kind === 'arm') {
    if (armedEtDay == null) armedEtDay = ev.etDay;
    return;
  }
  if (ev.kind === 'open') {
    if (!opens.has(ev.id)) {
      opens.set(ev.id, {
        occ: ev.occ,
        atRiskUsd: ev.atRiskUsd,
        etDay: ev.etDay,
        ts: ev.ts,
        closed: false,
        realizedPnlUsd: null,
      });
    }
    return;
  }
  if (ev.kind === 'close') {
    const o = opens.get(ev.id);
    // A close for an id we never opened is ignored on purpose: this ledger
    // counts EXPLORATION rows only, and the id join is what keeps a sleeve
    // re-stamp from smuggling foreign rows in (TRA-3926 family).
    if (o && !o.closed) {
      o.closed = true;
      o.realizedPnlUsd = ev.realizedPnlUsd;
    }
    return;
  }
  if (disarm == null) disarm = { reason: ev.reason, etDay: ev.etDay, ts: ev.ts };
}

function appendEvent(ev: ExplorationEvent): void {
  // In-memory first and unconditionally; disk best-effort — accounting must
  // never break a trade pass. `durability` on the health block is what tells a
  // memory-only tally from a durable one (the TRA-1681 rule).
  apply(ev);
  if (dataDir == null) return;
  const path = explorationAllowanceLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendBoundedTapeLineSync(path, JSON.stringify(ev) + '\n');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('exploration-allowance append failed', { reason: lastAppendError });
  }
}

/** What boot hydration recovered (for the boot log line). */
export interface ExplorationAllowanceHydration {
  events: number;
  rowsUsed: number;
  armedEtDay: string | null;
  disarmedReason: ExplorationTerminalReason | null;
  unreadable: boolean;
}

/**
 * Rebuild allowance state from DATA_DIR on boot. A missing file is a genuine
 * empty state (never armed); an EXISTING file that cannot be read or parsed
 * marks the state UNREADABLE, which refuses every grant and publishes null
 * counters — "could not check" must never grade as "checked and fine".
 */
export function hydrateExplorationAllowanceFromDisk(dir: string): ExplorationAllowanceHydration {
  clearExplorationAllowanceForTests();
  dataDir = dir;
  const path = explorationAllowanceLogPath(dir);
  let raw: string | null = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      stateUnreadable = true;
      log.warn('exploration-allowance ledger unreadable — grants fail closed', {
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (raw != null) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        apply(JSON.parse(trimmed) as ExplorationEvent);
        hydratedEvents += 1;
      } catch {
        // One mangled line poisons the caps it may have carried — fail closed.
        stateUnreadable = true;
        log.warn('exploration-allowance ledger line unparseable — grants fail closed', { path });
      }
    }
  }
  return {
    events: hydratedEvents,
    rowsUsed: opens.size,
    armedEtDay,
    disarmedReason: disarm?.reason ?? null,
    unreadable: stateUnreadable,
  };
}

/** Sum of realized P&L over CLOSED exploration rows (a true 0 when none closed). */
function realizedPnlUsd(): number {
  let sum = 0;
  for (const o of opens.values()) {
    if (o.closed && o.realizedPnlUsd != null) sum += o.realizedPnlUsd;
  }
  return sum;
}

function openConcurrent(): number {
  let n = 0;
  for (const o of opens.values()) if (!o.closed) n += 1;
  return n;
}

function openedOn(etDay: string): number {
  let n = 0;
  for (const o of opens.values()) if (o.etDay === etDay) n += 1;
  return n;
}

/** Iterate ISO days from `fromIso` forward. Bounded; both endpoints inclusive. */
function* isoDays(fromIso: string, maxDays: number): Generator<string> {
  const [y, m, d] = fromIso.split('-').map(Number);
  let t = Date.UTC(y!, m! - 1, d!);
  for (let i = 0; i < maxDays; i++) {
    yield new Date(t).toISOString().slice(0, 10);
    t += 86_400_000;
  }
}

/**
 * Trading sessions elapsed in [armedEtDay .. todayEtDay], counted on the SAME
 * market calendar the rest of the repo grades with (`isMarketDayIso`:
 * weekends + the holiday table). The arm day counts as session 1 when it is a
 * market day. Pure — this is what makes box expiry trigger-free.
 */
export function explorationSessionsElapsed(armedIso: string, todayIso: string): number {
  if (todayIso < armedIso) return 0;
  let n = 0;
  for (const day of isoDays(armedIso, 4000)) {
    if (day > todayIso) break;
    if (isMarketDayIso(day)) n += 1;
  }
  return n;
}

/** The 40th market day counting the arm day (last day the box is live), or null pre-arm. */
function boxExpiryEtDay(armedIso: string): string | null {
  let n = 0;
  for (const day of isoDays(armedIso, 4000)) {
    if (isMarketDayIso(day)) {
      n += 1;
      if (n === EXPLORATION_CAPS.sessionBox) return day;
    }
  }
  return null;
}

/**
 * The reason the allowance is terminally dead as of `todayEtDay`, persisted or
 * newly binding — or null. Order fixes precedence: an already-recorded disarm
 * wins, then the caps in the order the pre-registration lists them.
 */
function terminalReason(todayEtDay: string): ExplorationTerminalReason | null {
  if (disarm != null) return disarm.reason;
  if (opens.size >= EXPLORATION_CAPS.rowCap) return 'row_cap';
  if (realizedPnlUsd() <= EXPLORATION_CAPS.pnlCapUsd) return 'pnl_cap';
  if (armedEtDay != null
    && explorationSessionsElapsed(armedEtDay, todayEtDay) > EXPLORATION_CAPS.sessionBox) {
    return 'box_expiry';
  }
  return null;
}

/** Persist a newly-binding terminal reason so it survives flag flips and reboots. */
function persistTerminal(reason: ExplorationTerminalReason, etDay: string, now: number): void {
  if (disarm == null) {
    appendEvent({ kind: 'disarm', reason, etDay, ts: now });
    log.warn('exploration allowance SELF-DISARMED', { reason, etDay, issue: 'TRA-4378' });
  }
}

export interface ExplorationGrantResult {
  granted: boolean;
  /** Non-null on refusal — which check said no (tallied since boot for the health block). */
  refusal: string | null;
}

/**
 * Ask the allowance to bypass a flat cost-bar REJECT for one demo
 * `directional` candidate. Called ONLY from the demo branch of
 * `SignalEngine.costAwareGateReject` — that call-site containment IS the
 * demo-only / live-unreachable property. First consult with the flag on arms
 * the 40-session clock (persisted). A grant sets the one-shot pending token
 * the open site consumes; it mutates no cap counter — commit does that.
 *
 * `estPerContractUsd` is the candidate's premium notional for ONE contract
 * (mark × 100). A candidate whose single contract already exceeds the $150
 * per-open cap is refused here; multi-contract sizing is clamped to the cap at
 * the open site (`maxAtRiskUsd`), so between the two checks no exploration
 * open can put more than $150 at risk.
 *
 * `account` is the candidate's OWNING BOOK (`alertUsername` — the same string
 * the journal row will carry). TRA-4418: the allowance was authorized to buy
 * DESK evidence, and the ~63 QA fixture books scan in `mode: 'demo'` too
 * (99.86% of this gate's addressable rejects on 2026-09-08), so without this
 * check the 25-row budget is spent on rows the expectancy basis excludes by
 * design (TRA-3391). Classified by the ONE decision-time classifier
 * (`classifySpreadCeilingAccount`, TRA-2355) on the same env basis as the
 * spread-ceiling stamps, so the two ceiling cross-checks cannot disagree by
 * construction (TRA-2948). Only `desk` proceeds: `fixture` refuses
 * `fixture_book`; a blank/unbound book refuses `unattributed_book` rather than
 * folding into either — an unbound `alertUsername` wire must not read as QA
 * traffic, and defaulting it to desk would manufacture desk evidence out of an
 * unknown owner. A non-desk consult mutates NO state (no arm, no terminal
 * persist): the 40-session box starts on the first DESK-eligible consult.
 */
export function explorationBypassGrant(
  env: NodeJS.ProcessEnv,
  etDay: string,
  estPerContractUsd: number,
  account: string | undefined | null,
  now: number = Date.now(),
): ExplorationGrantResult {
  const refuse = (refusal: string): ExplorationGrantResult => {
    refusals[refusal] = (refusals[refusal] ?? 0) + 1;
    return { granted: false, refusal };
  };
  if (!isExplorationAllowanceFlagOn(env)) return refuse('flag_off');
  const accountClass = classifySpreadCeilingAccount(account);
  if (accountClass !== 'desk') {
    return refuse(accountClass === 'fixture' ? 'fixture_book' : 'unattributed_book');
  }
  if (stateUnreadable) return refuse('state_unreadable');
  if (armedEtDay == null) appendEvent({ kind: 'arm', etDay, ts: now });
  const terminal = terminalReason(etDay);
  if (terminal != null) {
    persistTerminal(terminal, etDay, now);
    return refuse(terminal);
  }
  if (openConcurrent() >= EXPLORATION_CAPS.maxConcurrent) return refuse('concurrency');
  if (openedOn(etDay) >= EXPLORATION_CAPS.maxPerSession) return refuse('per_session');
  if (!Number.isFinite(estPerContractUsd) || estPerContractUsd > EXPLORATION_CAPS.perOpenAtRiskCapUsd) {
    return refuse('per_open_at_risk');
  }
  pendingGrant = { etDay, ts: now };
  return { granted: true, refusal: null };
}

/**
 * Consume the pending grant. The directional open site calls this on the line
 * after the gate call, UNCONDITIONALLY, so a token can never survive onto a
 * later candidate. Null ⇒ the admit (if any) came from the bar itself.
 */
export function takeExplorationGrant(): { etDay: string; ts: number } | null {
  const g = pendingGrant;
  pendingGrant = null;
  return g;
}

/**
 * Record that the granted open actually happened. `id` is the paper position
 * id — the SAME id the journal row and its close notification carry, which is
 * the whole attribution join. This is the write that spends a row of the
 * 25-row budget. `atRiskUsd` is the open's full premium notional (contracts ×
 * premiumPaid × 100 — identical to the journal row's `atRiskUsd`); a value
 * over the per-open cap here means the open-site clamp failed, which is scope
 * drift: record the open (the money IS at risk) and terminally self-disarm.
 */
export function commitExplorationOpen(
  args: { id: string; occ: string | null; atRiskUsd: number; etDay: string },
  now: number = Date.now(),
): void {
  appendEvent({ kind: 'open', id: args.id, occ: args.occ, atRiskUsd: args.atRiskUsd, etDay: args.etDay, ts: now });
  // Tolerance covers float dust only — a real breach is a broken clamp.
  if (args.atRiskUsd > EXPLORATION_CAPS.perOpenAtRiskCapUsd + 1e-6) {
    persistTerminal('scope_drift', args.etDay, now);
  }
  if (opens.size >= EXPLORATION_CAPS.rowCap) persistTerminal('row_cap', args.etDay, now);
  log.info('exploration open committed (TRA-4378)', {
    id: args.id, occ: args.occ, atRiskUsd: args.atRiskUsd, rowsUsed: opens.size,
  });
}

/**
 * Journal close listener body (registered once at boot via
 * `onOptionTradeClose`). Ignores every id that is not a committed exploration
 * open. The journal close row's `realizedPnlUsd` is CUMULATIVE for the round
 * trip (partials folded in — TRA-2895), so one close event settles the row. A
 * non-finite P&L is refused (logged, row left open here): recording a
 * fabricated 0 would be the absent≠zero trap.
 */
export function handleExplorationJournalClose(
  id: string,
  /** TRA-4857: realizedPnlUsd can be null for unpriced reconcile closes. */
  close: { realizedPnlUsd: number | null },
  etDay: string,
  now: number = Date.now(),
): void {
  const o = opens.get(id);
  if (!o || o.closed) return;
  // TRA-4857 — null is NOT the same as a non-finite number: null is "unmeasured",
  // while NaN is a defect. An unpriced close contributes $0 to cumulative P&L.
  if (close.realizedPnlUsd === null) {
    log.info('exploration close was unpriced (broker_reconcile, no fill) — recorded as $0', { id });
    appendEvent({ kind: 'close', id, realizedPnlUsd: 0, etDay, ts: now });
    const pnl = realizedPnlUsd();
    log.info('exploration close recorded (TRA-4378)', { id, realizedPnlUsd: 0, cumPnlUsd: pnl });
    o.closed = true;
    return;
  }
  if (!Number.isFinite(close.realizedPnlUsd)) {
    log.warn('exploration close carried non-finite realizedPnlUsd — NOT recorded', { id });
    return;
  }
  appendEvent({ kind: 'close', id, realizedPnlUsd: close.realizedPnlUsd, etDay, ts: now });
  const pnl = realizedPnlUsd();
  log.info('exploration close recorded (TRA-4378)', { id, realizedPnlUsd: close.realizedPnlUsd, cumPnlUsd: pnl });
  if (pnl <= EXPLORATION_CAPS.pnlCapUsd) persistTerminal('pnl_cap', etDay, now);
}

/** The health block published on `/api/health/cost-aware-gate` (control 2 of the pre-registration). */
export interface ExplorationAllowanceSummary {
  armed: boolean;
  flag: string;
  flagValue: string | null;
  structure: string;
  gateLedgerKey: string;
  rowsUsed: number | null;
  rowCap: number;
  pnlUsd: number | null;
  pnlCapUsd: number;
  openConcurrent: number | null;
  maxConcurrent: number;
  openedThisSession: number | null;
  maxPerSession: number;
  perOpenAtRiskCapUsd: number;
  armedEtDay: string | null;
  sessionsElapsed: number | null;
  sessionBox: number;
  expiresEtDay: string | null;
  disarmedReason: ExplorationTerminalReason | 'flag_off' | null;
  demoOnly: true;
  liveCapitalReachable: false;
  refusalsSinceBoot: Record<string, number>;
  durability: {
    ephemeral: boolean;
    hydratedEvents: number;
    appendErrors: number;
    lastAppendError: string | null;
    stateUnreadable: boolean;
  };
  note: string;
}

/**
 * Resolve the allowance's own state for the health route. EFFECTIVE state:
 * a box that expired since the last consult reads `box_expiry` here even
 * though the durable disarm event lands on the next grant attempt — the read
 * must never lag the truth. Counters publish `null` (never 0) when the ledger
 * is unreadable: absent ⇒ UNREAD.
 */
export function summarizeExplorationAllowance(
  env: NodeJS.ProcessEnv,
  todayEtDay: string,
): ExplorationAllowanceSummary {
  const on = isExplorationAllowanceFlagOn(env);
  const terminal = stateUnreadable ? null : terminalReason(todayEtDay);
  const disarmedReason: ExplorationTerminalReason | 'flag_off' | null =
    terminal ?? (on ? null : 'flag_off');
  const armed = on && !stateUnreadable && terminal == null;
  const sessions = armedEtDay != null && !stateUnreadable
    ? explorationSessionsElapsed(armedEtDay, todayEtDay)
    : null;
  const readable = !stateUnreadable;
  return {
    armed,
    flag: DIRECTIONAL_EXPLORATION_FLAG,
    flagValue: env[DIRECTIONAL_EXPLORATION_FLAG] ?? null,
    structure: DIRECTIONAL_STRUCTURE_LABEL,
    gateLedgerKey: EXPLORATION_GATE_STRUCTURE,
    rowsUsed: readable ? opens.size : null,
    rowCap: EXPLORATION_CAPS.rowCap,
    pnlUsd: readable ? realizedPnlUsd() : null,
    pnlCapUsd: EXPLORATION_CAPS.pnlCapUsd,
    openConcurrent: readable ? openConcurrent() : null,
    maxConcurrent: EXPLORATION_CAPS.maxConcurrent,
    openedThisSession: readable ? openedOn(todayEtDay) : null,
    maxPerSession: EXPLORATION_CAPS.maxPerSession,
    perOpenAtRiskCapUsd: EXPLORATION_CAPS.perOpenAtRiskCapUsd,
    armedEtDay,
    sessionsElapsed: sessions,
    sessionBox: EXPLORATION_CAPS.sessionBox,
    expiresEtDay: armedEtDay != null ? boxExpiryEtDay(armedEtDay) : null,
    disarmedReason,
    demoOnly: true,
    liveCapitalReachable: false,
    refusalsSinceBoot: { ...refusals },
    durability: {
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedEvents,
      appendErrors,
      lastAppendError,
      stateUnreadable,
    },
    note: stateUnreadable
      ? 'STATE UNREADABLE — the on-disk allowance ledger exists but could not be read; every grant fails closed and every counter above is null. This is UNREAD, not quiet.'
      : armed
        ? `ARMED (demo-only, TRA-4378): a flat cost-bar reject on a DESK-book demo '${EXPLORATION_GATE_STRUCTURE}' candidate is admitted while every cap holds (fixture/unattributed books refuse fixture_book/unattributed_book — TRA-4418); admits land on retained.byStructure[${EXPLORATION_GATE_STRUCTURE}] (assert barR != null on the row you read — the '${DIRECTIONAL_STRUCTURE_LABEL}' twin carries spread-ceiling counters only). Caps: ${EXPLORATION_CAPS.rowCap} opens, $${EXPLORATION_CAPS.perOpenAtRiskCapUsd} at-risk/open, ${EXPLORATION_CAPS.pnlCapUsd} USD realized, ${EXPLORATION_CAPS.maxConcurrent} concurrent / ${EXPLORATION_CAPS.maxPerSession} per session, ${EXPLORATION_CAPS.sessionBox}-session box (expires after ${armedEtDay != null ? boxExpiryEtDay(armedEtDay) : 'n/a'}). Zero live-capital reach: consulted only on the demo branch of the gate.`
        : disarmedReason === 'flag_off'
          ? `DISARMED (default-off): set ${DIRECTIONAL_EXPLORATION_FLAG}=1 (DATA_DIR/demo-flags.json or env) to arm. No exploration open can occur while this reads false.${armedEtDay != null ? ' Previously armed — counters above are the durable record and still bind on re-arm.' : ''}`
          : `SELF-DISARMED (${String(disarmedReason)}) — terminal and durable; re-setting the flag does NOT re-arm past a bound cap. Rider R1: no extension.`,
  };
}
