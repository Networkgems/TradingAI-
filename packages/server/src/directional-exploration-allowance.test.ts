// TRA-4378 — the board-approved bounded exploration allowance for the demo
// directional sleeve. Every cap is demonstrated to BIND and (where terminal)
// to SELF-DISARM with the right `disarmedReason`; the box expiry is shown to
// fire with NO external trigger (a bare summary read after the calendar
// passes); default-off and fail-closed-on-unreadable-state are negative
// controls, not assertions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DIRECTIONAL_EXPLORATION_FLAG,
  EXPLORATION_CAPS,
  clearExplorationAllowanceForTests,
  commitExplorationOpen,
  explorationAllowanceLogPath,
  explorationBypassGrant,
  explorationSessionsElapsed,
  handleExplorationJournalClose,
  hydrateExplorationAllowanceFromDisk,
  summarizeExplorationAllowance,
  takeExplorationGrant,
} from './directional-exploration-allowance.js';

// 2026-06-01 is a Monday and not in MARKET_HOLIDAYS.
const ARM_DAY = '2026-06-01';
const ON: NodeJS.ProcessEnv = { [DIRECTIONAL_EXPLORATION_FLAG]: '1' };
const OFF: NodeJS.ProcessEnv = {};

const grant = (env: NodeJS.ProcessEnv, day = ARM_DAY, est = 100) =>
  explorationBypassGrant(env, day, est, 1_000);

/** Grant + commit one exploration open in one call (the engine's two-step, collapsed). */
function openOne(id: string, day = ARM_DAY, atRiskUsd = 100): void {
  const g = grant(ON, day);
  expect(g.granted).toBe(true);
  expect(takeExplorationGrant()).not.toBeNull();
  commitExplorationOpen({ id, occ: `OCC${id}`, atRiskUsd, etDay: day }, 1_000);
}

describe('directional-exploration-allowance', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exploration-'));
    clearExplorationAllowanceForTests();
    hydrateExplorationAllowanceFromDisk(dir);
  });

  afterEach(() => {
    clearExplorationAllowanceForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── AC1: default-off ───────────────────────────────────────────────────────
  it('DEFAULT-OFF: unset flag refuses every grant and reads armed:false / flag_off', () => {
    expect(grant(OFF)).toEqual({ granted: false, refusal: 'flag_off' });
    expect(takeExplorationGrant()).toBeNull();
    const s = summarizeExplorationAllowance(OFF, ARM_DAY);
    expect(s.armed).toBe(false);
    expect(s.disarmedReason).toBe('flag_off');
    expect(s.flagValue).toBeNull();
    expect(s.armedEtDay).toBeNull();
    expect(s.rowsUsed).toBe(0);
  });

  it('malformed flag values are OFF (no typo can arm an exploration)', () => {
    for (const v of ['yess', '2', 'TRUE ✅', '']) {
      expect(grant({ [DIRECTIONAL_EXPLORATION_FLAG]: v }).granted).toBe(false);
    }
  });

  // ── AC2: armed behaviour ───────────────────────────────────────────────────
  it('ARMED: first consult arms the clock (persisted), grants, and a commit spends a row', () => {
    const g = grant(ON);
    expect(g).toEqual({ granted: true, refusal: null });
    expect(takeExplorationGrant()).toEqual({ etDay: ARM_DAY, ts: 1_000 });
    // one-shot: a second take returns null
    expect(takeExplorationGrant()).toBeNull();
    commitExplorationOpen({ id: 'p1', occ: 'OCC1', atRiskUsd: 105.35, etDay: ARM_DAY }, 1_001);
    const s = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(s.armed).toBe(true);
    expect(s.armedEtDay).toBe(ARM_DAY);
    expect(s.rowsUsed).toBe(1);
    expect(s.pnlUsd).toBe(0); // true zero: no closed rows, computed not fabricated
    expect(s.openConcurrent).toBe(1);
    expect(s.openedThisSession).toBe(1);
    expect(s.sessionsElapsed).toBe(1);
    expect(s.disarmedReason).toBeNull();
    expect(s.demoOnly).toBe(true);
    expect(s.liveCapitalReachable).toBe(false);
  });

  // ── AC3: row cap ───────────────────────────────────────────────────────────
  it('ROW CAP self-disarms at 25 committed opens with disarmedReason row_cap', () => {
    // Spread over days/closes so concurrency + per-session caps never bind first.
    for (let i = 0; i < EXPLORATION_CAPS.rowCap; i++) {
      const day = `2026-06-${String(1 + Math.floor(i / 2)).padStart(2, '0')}`; // 2/day, weekdays in June
      if (!grant(ON, day).granted) {
        // skip weekend days by moving on — regenerate a valid weekday grant
        throw new Error(`grant refused unexpectedly on ${day}`);
      }
      takeExplorationGrant();
      commitExplorationOpen({ id: `p${i}`, occ: null, atRiskUsd: 100, etDay: day }, 1_000 + i);
      // close immediately so maxConcurrent never binds
      handleExplorationJournalClose(`p${i}`, { realizedPnlUsd: -1 }, day, 2_000 + i);
    }
    const s = summarizeExplorationAllowance(ON, '2026-06-30');
    expect(s.rowsUsed).toBe(25);
    expect(s.armed).toBe(false);
    expect(s.disarmedReason).toBe('row_cap');
    expect(grant(ON, '2026-06-30').refusal).toBe('row_cap');
  });

  // ── AC3: P&L cap ───────────────────────────────────────────────────────────
  it('P&L CAP self-disarms when cumulative realized ≤ −$600 with disarmedReason pnl_cap', () => {
    openOne('p1', ARM_DAY);
    handleExplorationJournalClose('p1', { realizedPnlUsd: -150 }, ARM_DAY, 2_000);
    openOne('p2', ARM_DAY);
    handleExplorationJournalClose('p2', { realizedPnlUsd: -455 }, ARM_DAY, 2_001);
    // −605 total ⇒ terminal
    const s = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(s.pnlUsd).toBe(-605);
    expect(s.armed).toBe(false);
    expect(s.disarmedReason).toBe('pnl_cap');
    expect(grant(ON, '2026-06-02').refusal).toBe('pnl_cap');
  });

  it('a duplicate close for the same row is refused (one settle per row)', () => {
    openOne('p1');
    handleExplorationJournalClose('p1', { realizedPnlUsd: -50 }, ARM_DAY, 2_000);
    handleExplorationJournalClose('p1', { realizedPnlUsd: -50 }, ARM_DAY, 2_001);
    expect(summarizeExplorationAllowance(ON, ARM_DAY).pnlUsd).toBe(-50);
  });

  it('a close for a row the allowance never opened is ignored (id join, not sleeve stamps)', () => {
    openOne('p1');
    handleExplorationJournalClose('someone-elses-row', { realizedPnlUsd: -500 }, ARM_DAY, 2_000);
    expect(summarizeExplorationAllowance(ON, ARM_DAY).pnlUsd).toBe(0);
  });

  it('a non-finite realized P&L is refused, never recorded as 0 (absent ≠ zero)', () => {
    openOne('p1');
    handleExplorationJournalClose('p1', { realizedPnlUsd: Number.NaN }, ARM_DAY, 2_000);
    const s = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(s.pnlUsd).toBe(0);
    expect(s.openConcurrent).toBe(1); // still open here — not silently settled at a fabricated 0
  });

  // ── AC3: concurrency + per-session (non-terminal refusals) ────────────────
  it('CONCURRENCY refuses a 3rd open while 2 are open, and re-grants after a close', () => {
    openOne('p1', '2026-06-01');
    openOne('p2', '2026-06-02');
    const refused = grant(ON, '2026-06-03');
    expect(refused).toEqual({ granted: false, refusal: 'concurrency' });
    expect(summarizeExplorationAllowance(ON, '2026-06-03').disarmedReason).toBeNull(); // NOT terminal
    handleExplorationJournalClose('p1', { realizedPnlUsd: 10 }, '2026-06-03', 2_000);
    expect(grant(ON, '2026-06-03').granted).toBe(true);
    takeExplorationGrant();
  });

  it('PER-SESSION refuses a 3rd open on the same ET day, allows it the next day', () => {
    openOne('p1', ARM_DAY);
    handleExplorationJournalClose('p1', { realizedPnlUsd: 0 }, ARM_DAY, 2_000);
    openOne('p2', ARM_DAY);
    handleExplorationJournalClose('p2', { realizedPnlUsd: 0 }, ARM_DAY, 2_001);
    expect(grant(ON, ARM_DAY)).toEqual({ granted: false, refusal: 'per_session' });
    expect(grant(ON, '2026-06-02').granted).toBe(true);
    takeExplorationGrant();
  });

  // ── per-open at-risk ───────────────────────────────────────────────────────
  it('AT-RISK refuses a candidate whose single contract exceeds $150', () => {
    expect(grant(ON, ARM_DAY, 151)).toEqual({ granted: false, refusal: 'per_open_at_risk' });
    expect(grant(ON, ARM_DAY, Number.NaN).refusal).toBe('per_open_at_risk');
    expect(grant(ON, ARM_DAY, 139.5).granted).toBe(true);
    takeExplorationGrant();
  });

  it('SCOPE DRIFT: a committed open over the $150 cap terminally disarms (the clamp failed)', () => {
    openOne('p1', ARM_DAY, 200); // openOne asserts the grant; commit carries the breach
    const s = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(s.armed).toBe(false);
    expect(s.disarmedReason).toBe('scope_drift');
  });

  // ── AC3: box expiry — NO external trigger ──────────────────────────────────
  it('BOX EXPIRY: session arithmetic matches the market calendar', () => {
    // June 2026: 1st is Monday. 2026-06-01..2026-06-05 = 5 sessions.
    expect(explorationSessionsElapsed('2026-06-01', '2026-06-05')).toBe(5);
    // Weekend adds nothing.
    expect(explorationSessionsElapsed('2026-06-01', '2026-06-07')).toBe(5);
    // 2026-09-07 is Labor Day (a MARKET_HOLIDAYS entry): 09-04 Fri → 09-08 Tue adds 1, not 2.
    expect(
      explorationSessionsElapsed('2026-09-04', '2026-09-08')
      - explorationSessionsElapsed('2026-09-04', '2026-09-04'),
    ).toBe(1);
  });

  it('BOX EXPIRY fires on a bare summary read once 40 sessions pass — nothing else touched it', () => {
    openOne('p1', ARM_DAY);
    handleExplorationJournalClose('p1', { realizedPnlUsd: -10 }, ARM_DAY, 2_000);
    const armedRead = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(armedRead.armed).toBe(true);
    expect(armedRead.expiresEtDay).not.toBeNull();
    const lastDay = armedRead.expiresEtDay!;
    // On the 40th session the box is still live…
    expect(summarizeExplorationAllowance(ON, lastDay).armed).toBe(true);
    // …and 30 calendar days later (well past session 41) a BARE READ — no grant,
    // no commit, no cron — reads expired. That is the trigger-free property.
    const [y, m, d] = lastDay.split('-').map(Number);
    const after = new Date(Date.UTC(y!, m! - 1, d! + 30)).toISOString().slice(0, 10);
    const expired = summarizeExplorationAllowance(ON, after);
    expect(expired.armed).toBe(false);
    expect(expired.disarmedReason).toBe('box_expiry');
    // A grant attempt after expiry refuses AND persists the disarm durably.
    expect(grant(ON, after).refusal).toBe('box_expiry');
    hydrateExplorationAllowanceFromDisk(dir);
    expect(summarizeExplorationAllowance(ON, after).disarmedReason).toBe('box_expiry');
  });

  it('a terminal disarm is durable: the flag alone cannot re-arm past a bound cap', () => {
    openOne('p1', ARM_DAY);
    handleExplorationJournalClose('p1', { realizedPnlUsd: -700 }, ARM_DAY, 2_000);
    expect(grant(ON, '2026-06-02').refusal).toBe('pnl_cap'); // persists the disarm event
    // Fresh process, flag freshly on:
    hydrateExplorationAllowanceFromDisk(dir);
    const s = summarizeExplorationAllowance(ON, '2026-06-03');
    expect(s.disarmedReason).toBe('pnl_cap');
    expect(s.armed).toBe(false);
  });

  // ── durability / fail-closed ───────────────────────────────────────────────
  it('state survives a restart byte-for-byte (hydrate rebuilds rows, P&L, arm day)', () => {
    openOne('p1', ARM_DAY, 105.35);
    openOne('p2', '2026-06-02', 139.5);
    handleExplorationJournalClose('p1', { realizedPnlUsd: -23.75 }, '2026-06-02', 2_000);
    const before = summarizeExplorationAllowance(ON, '2026-06-03');
    clearExplorationAllowanceForTests();
    hydrateExplorationAllowanceFromDisk(dir);
    const after = summarizeExplorationAllowance(ON, '2026-06-03');
    // `durability`/`refusalsSinceBoot` are boot-scoped metadata by design; every
    // cap-bearing field must survive byte-for-byte.
    expect(after).toEqual({
      ...before,
      refusalsSinceBoot: after.refusalsSinceBoot,
      durability: after.durability,
    });
    expect(after.durability.hydratedEvents).toBe(4); // 1 arm + 2 opens + 1 close
    expect(after.rowsUsed).toBe(2);
    expect(after.pnlUsd).toBe(-23.75);
    expect(after.armedEtDay).toBe(ARM_DAY);
  });

  it('an UNREADABLE ledger fails closed: grants refuse, counters publish null (never 0)', () => {
    openOne('p1', ARM_DAY);
    appendFileSync(explorationAllowanceLogPath(dir), '{not json\n', 'utf8');
    clearExplorationAllowanceForTests();
    const h = hydrateExplorationAllowanceFromDisk(dir);
    expect(h.unreadable).toBe(true);
    expect(grant(ON, ARM_DAY)).toEqual({ granted: false, refusal: 'state_unreadable' });
    const s = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(s.armed).toBe(false);
    expect(s.rowsUsed).toBeNull();
    expect(s.pnlUsd).toBeNull();
    expect(s.openConcurrent).toBeNull();
    expect(s.durability.stateUnreadable).toBe(true);
  });

  it('a missing file is a genuine empty state, not an error', () => {
    clearExplorationAllowanceForTests();
    const h = hydrateExplorationAllowanceFromDisk(join(dir, 'never-written'));
    expect(h).toMatchObject({ events: 0, rowsUsed: 0, armedEtDay: null, unreadable: false });
  });

  it('refusals are tallied since boot for the health block', () => {
    grant(OFF);
    grant(ON, ARM_DAY, 999);
    const s = summarizeExplorationAllowance(ON, ARM_DAY);
    expect(s.refusalsSinceBoot.flag_off).toBe(1);
    expect(s.refusalsSinceBoot.per_open_at_risk).toBe(1);
  });
});

// ── AC2 + AC4: the gate integration, driven through the REAL private method ──
// `costAwareGateReject` is where the allowance is consulted; these tests drive
// the actual engine branch rather than a re-implementation of it. The tape
// table is never folded in this process, so the flat verdict for every
// candidate is a REJECT (`insufficient_evidence`) — exactly the deadlock state
// the allowance exists to bypass.
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { clearCostAwareGateLedger, summarizeCostAwareGate } from './cost-aware-gate-ledger.js';
import { etDateString } from './scheduler.js';

type GateInternals = {
  costAwareGateReject(
    structure: string,
    inputs: { mark: number; delta: number },
  ): string | null;
};

describe('TRA-4378 gate integration (costAwareGateReject demo branch)', () => {
  beforeEach(() => {
    clearExplorationAllowanceForTests();
    clearCostAwareGateLedger();
    process.env.ENABLE_OPTION_COST_AWARE_GATE = '1';
    process.env[DIRECTIONAL_EXPLORATION_FLAG] = '1';
  });

  afterEach(() => {
    delete process.env.ENABLE_OPTION_COST_AWARE_GATE;
    delete process.env[DIRECTIONAL_EXPLORATION_FLAG];
    clearExplorationAllowanceForTests();
    clearCostAwareGateLedger();
  });

  it('ARMED: a bar-rejected directional candidate is ADMITTED, recorded on the directional row, with a one-shot grant', () => {
    const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }) as unknown as GateInternals;
    const verdict = e.costAwareGateReject('directional', { mark: 1.0, delta: 0.5 });
    expect(verdict).toBeNull(); // admitted under the allowance
    expect(takeExplorationGrant()).not.toBeNull();
    // Control 1's read: the admit lands on the `directional` ledger row.
    const s = summarizeCostAwareGate(etDateString(new Date())) as unknown as {
      byStructure: { structure: string; admitted: number; rejected: number }[];
    };
    expect(s.byStructure.find((r) => r.structure === 'directional')).toMatchObject({
      admitted: 1,
      rejected: 0,
    });
  });

  it('NEGATIVE CONTROL (AC1): allowance flag off ⇒ the same candidate is rejected and no grant exists', () => {
    delete process.env[DIRECTIONAL_EXPLORATION_FLAG];
    const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }) as unknown as GateInternals;
    const verdict = e.costAwareGateReject('directional', { mark: 1.0, delta: 0.5 });
    expect(typeof verdict).toBe('string'); // the flat bar's reject stands
    expect(takeExplorationGrant()).toBeNull();
    const s = summarizeCostAwareGate(etDateString(new Date())) as unknown as {
      byStructure: { structure: string; admitted: number; rejected: number }[];
    };
    expect(s.byStructure.find((r) => r.structure === 'directional')).toMatchObject({
      admitted: 0,
      rejected: 1,
    });
  });

  it('SCOPE (AC4): the allowance never fires for the OTHER structures the bar governs', () => {
    const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }) as unknown as GateInternals;
    for (const structure of ['single_leg_rv', 'single_leg_otm']) {
      const verdict = e.costAwareGateReject(structure, { mark: 1.0, delta: 0.5 });
      expect(typeof verdict).toBe('string'); // still rejected — no bypass outside directional
      expect(takeExplorationGrant()).toBeNull();
    }
  });

  it('LIVE UNREACHABLE (AC4): the live branch never consults the allowance, flag on or not', () => {
    const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' }) as unknown as GateInternals;
    // Live enforce flag is unset ⇒ the live branch is inert; and even the
    // enforcing live path has no allowance call — assert no grant is minted.
    const verdict = e.costAwareGateReject('directional', { mark: 1.0, delta: 0.5 });
    expect(verdict).toBeNull(); // inert live gate, NOT an exploration admit:
    expect(takeExplorationGrant()).toBeNull(); // …no token exists,
    expect(summarizeExplorationAllowance(process.env, ARM_DAY).rowsUsed).toBe(0); // …no row spent.
  });
});
