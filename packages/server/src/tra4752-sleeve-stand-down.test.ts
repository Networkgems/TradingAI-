// TRA-4752 (parent TRA-4750) — a stood-down sleeve must be unable to reach live
// capital BY CONSTRUCTION.
//
// ── What was measured, and why a test is the remedy ────────────────────────
//
// Live `5d5cb869`, 30-day retained window:
//   • every populated `byScope` on `/api/health/live-enforce-gates` reports
//     `single_leg_otm` (plus `single_leg_rv` on 09-09/09-10); `directional`
//     reads `evaluated: 0` on all 21 retained days;
//   • `/api/health/rv-scan` `armByEtDay` reads `live_arm_off` / `reachable:
//     false` for the `live`/`desk` class on 21 of 21 of those days;
//   • `/api/health/options-live` reads `liveDirectionalArmed: false` with
//     `liveTestWindowOpen: true` until 2026-12-31.
//
// So the zero is honest — the sleeve never entered live mode — but the ONLY
// thing holding it out is one unset environment variable read at the top of
// `evaluateDemoDirectional`, upstream of every counter. An env write flips it
// with no code change, no review and no alarm, and a live directional open
// would then cross none of `entry_window` / `contract_floor` /
// `setup_confirmation` / `universe` / `underlying_asset_class` /
// `otm_delta_floor` / `aggregate_cap` / `fleet_reachable_bound` /
// `exit_actionability` (all OTM-scoped), nor the entry-delta ceiling (the
// directional call site is `entryDeltaCeilingRejectReason`, which returns null
// when `mode !== 'demo'`).
//
// These tests pin the remedy: the refusal is compiled in, it is bound at the
// one seam every live `buy_to_open` passes, and it carries its own denominator.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { SignalEngine } from './signal-engine.js';
import type { PaperOptionsAccount } from './options-account.js';
import {
  gradeSleeveStandDown,
  STOOD_DOWN_SLEEVES,
} from './sleeve-stand-down.js';
import {
  clearLiveEnforceGateLedger,
  summarizeLiveEnforceGate,
} from './live-enforce-gate-ledger.js';
import {
  summarizeBrokerSubmitCensus,
  __resetBrokerSubmitCensusForTest,
} from './broker-submit-census.js';
import { setOptionTradeJournalFileForTests } from './option-trade-journal.js';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';

// A Thursday inside RTH, so nothing upstream stands down on the clock.
const TRADING_TIME = Date.parse('2026-06-04T14:00:00Z');
const ET_DAY = '2026-06-04';
const OCC = 'SO260918C00092500';
const BOOK = 'tra4752-book';

function buildSignal(): OtmMispricingSignal {
  return {
    id: 'sig-4752',
    symbol: 'SO',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 0.4,
    stopLoss: 0.3,
    takeProfit: 0.8,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 92.5,
    expiration: '2026-09-18',
    mark: 0.4,
    theo: 0.6,
    mispricingPct: -0.21,
    delta: 0.22,
  };
}

const SETUP = {
  ivRank: null,
  trend: 'sideways' as const,
  sentiment: null,
  entryDelta: 0.22,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: null,
};

type EngineInternals = {
  mode: 'demo' | 'live';
  tradierLiveClient: unknown;
  alertUsername: string | null;
  readonly optionsAccount: PaperOptionsAccount;
  mirrorLiveOptionOpen: (
    opened: OptionPosition,
    surfaceLiveSkip: (reason: string) => void,
    opts?: { sleeve?: string; walk?: unknown },
  ) => Promise<boolean>;
};

/**
 * A live engine holding a small live paper option and a TRUTHY broker client, so
 * the seam runs past the TRA-3486 entry guards and reaches the stand-down.
 *
 * The client is a bare object: the only thing these tests ask of the broker leg
 * is whether it was REACHED, which `recordBrokerSubmit` answers one line above
 * the submit call — so no submit behaviour needs mocking.
 *
 * 1 contract @ $0.40 = $40 notional, deliberately under both the compiled $100
 * canary ceiling and the $300 hard-controls notional cap, so neither of the two
 * gates ordered ahead of the stand-down can be what refuses.
 */
function liveEngine(): { internals: EngineInternals; position: OptionPosition } {
  const engine = new SignalEngine(undefined, undefined, undefined);
  const internals = engine as unknown as EngineInternals;
  internals.mode = 'live';
  internals.tradierLiveClient = {};
  internals.alertUsername = BOOK;

  const position = internals.optionsAccount.openOptionFromCandidate(
    buildSignal(), 'live', undefined, 88.2, SETUP, 1,
  );
  expect(position).not.toBeNull();
  return { internals, position: position! };
}

async function mirror(
  internals: EngineInternals,
  position: OptionPosition,
  sleeve: string | undefined,
): Promise<{ mirrored: boolean; skips: string[] }> {
  const skips: string[] = [];
  const mirrored = await internals.mirrorLiveOptionOpen.call(
    internals,
    position,
    (reason: string) => { skips.push(reason); },
    sleeve === undefined ? {} : { sleeve },
  );
  return { mirrored, skips };
}

/** The `sleeve_stand_down` row from the ledger's own day fold. */
function standDownGate(): { evaluated: number; blocked: number; byScope: Record<string, { evaluated: number; blocked: number }> } {
  const summary = summarizeLiveEnforceGate(ET_DAY) as unknown as {
    byGate: ReadonlyArray<{
      gate: string;
      evaluated: number;
      blocked: number;
      byScope?: ReadonlyArray<{ scope: string; evaluated: number; blocked: number }>;
    }>;
  };
  const row = summary.byGate.find(g => g.gate === 'sleeve_stand_down');
  expect(row, '`sleeve_stand_down` must be published even at evaluated: 0').toBeDefined();
  const byScope: Record<string, { evaluated: number; blocked: number }> = {};
  for (const s of row!.byScope ?? []) byScope[s.scope] = { evaluated: s.evaluated, blocked: s.blocked };
  return { evaluated: row!.evaluated, blocked: row!.blocked, byScope };
}

/** Did the seam reach the broker at all? `recordBrokerSubmit` fires one line above the submit. */
function brokerSubmits(): number {
  return summarizeBrokerSubmitCensus(ET_DAY, [BOOK]).rollup.submitted;
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  clearLiveEnforceGateLedger();
  __resetBrokerSubmitCensusForTest();
  tmpFile = join(tmpdir(), `tra4752-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  clearLiveEnforceGateLedger();
  __resetBrokerSubmitCensusForTest();
  await rm(tmpFile, { force: true });
});

describe('TRA-4752 — the roster is a compiled fact, not a configuration', () => {
  it('stands the directional sleeve down under BOTH spellings of its label', () => {
    expect(gradeSleeveStandDown('single_leg_directional').allowed).toBe(false);
    // `LiveFillSleeve` carries both spellings; a roster matching only the long
    // one would be bypassed by a caller using the short one.
    expect(gradeSleeveStandDown('directional').allowed).toBe(false);
    for (const sleeve of Object.keys(STOOD_DOWN_SLEEVES)) {
      expect(gradeSleeveStandDown(sleeve).ruling).toBe('TRA-4750');
      expect(gradeSleeveStandDown(sleeve).reasonCode).toBe('sleeve_stood_down');
    }
  });

  // THE DENOMINATOR CONTROL. A gate that refuses everything cannot be told apart
  // from a gate wired in backwards, and `blocked === evaluated` would read the
  // same either way.
  //
  // `single_leg_otm` is the load-bearing half of this: TRA-4750 ruled it down
  // too, but its live arm is ON and nine live gates sit upstream of this seam on
  // that path, so refusing it here would both change an armed sleeve's behaviour
  // outside this ticket's scope AND make those nine gates vacuous. See the
  // roster comment. It is the sleeve with live traffic, so it is also what keeps
  // this gate's `evaluated` denominator non-zero in production.
  it('ADMITS the sleeves this roster deliberately omits, so the refusals discriminate', () => {
    for (const sleeve of ['single_leg_otm', 'single_leg_rv']) {
      const v = gradeSleeveStandDown(sleeve);
      expect(v.allowed, `${sleeve} must not be refused by this roster`).toBe(true);
      expect(v.scope).toBe(sleeve);
      expect(v.reasonCode).toBeUndefined();
    }
  });

  // "Could not tell" must never share an outcome with "checked and it is fine".
  it('REFUSES an open whose sleeve cannot be read, rather than admitting it', () => {
    for (const unreadable of [undefined, null, '', '   ', 'unattributed']) {
      const v = gradeSleeveStandDown(unreadable);
      expect(v.allowed, `sleeve ${JSON.stringify(unreadable)} must fail closed`).toBe(false);
      expect(v.reasonCode).toBe('sleeve_unattributable');
      expect(v.scope).toBe('unattributed');
    }
  });

  // The whole point of compiling the roster in: the stand-down TRA-4752 found
  // rested on one env var, so the remedy must not rest on another one.
  it('cannot be lifted by an environment variable', () => {
    process.env['ENABLE_OPTION_LIVE_DIRECTIONAL'] = '1';
    process.env['STOOD_DOWN_SLEEVES'] = '';
    process.env['SLEEVE_STAND_DOWN'] = 'off';
    try {
      expect(gradeSleeveStandDown('single_leg_directional').allowed).toBe(false);
    } finally {
      delete process.env['ENABLE_OPTION_LIVE_DIRECTIONAL'];
      delete process.env['STOOD_DOWN_SLEEVES'];
      delete process.env['SLEEVE_STAND_DOWN'];
    }
  });
});

describe('TRA-4752 — the refusal is BOUND at the live buy_to_open seam', () => {
  it('refuses a live single_leg_directional open and never reaches the broker', async () => {
    const { internals, position } = liveEngine();

    // Positive controls: the row this test claims to roll back is on the live
    // book first, and no order has been submitted yet.
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(1);
    expect(brokerSubmits()).toBe(0);

    const { mirrored, skips } = await mirror(internals, position, 'single_leg_directional');

    expect(mirrored).toBe(false);
    // ⭐ THE ASSERTION THAT MATTERS: the order never reached Tradier.
    expect(brokerSubmits()).toBe(0);
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(0);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('TRA-4752');
    expect(skips[0]).toContain('TRA-4750');
    expect(skips[0]).toContain('single_leg_directional');
  });

  it('records the refusal on the sleeve_stand_down gate, scoped to the sleeve', async () => {
    const { internals, position } = liveEngine();
    await mirror(internals, position, 'single_leg_directional');

    const gate = standDownGate();
    expect(gate.evaluated).toBe(1);
    expect(gate.blocked).toBe(1);
    expect(gate.byScope['single_leg_directional']).toEqual({ evaluated: 1, blocked: 1 });
  });

  // The counters have to separate "the roster is enforcing and nothing tried it"
  // from "the roster is not wired in" — which is only possible if the ADMITS are
  // on the same axis as the blocks.
  it('records an ADMIT for a sleeve off the roster, and lets it reach the broker', async () => {
    const { internals, position } = liveEngine();
    await mirror(internals, position, 'single_leg_rv');

    const gate = standDownGate();
    expect(gate.evaluated).toBe(1);
    expect(gate.blocked).toBe(0);
    expect(gate.byScope['single_leg_rv']).toEqual({ evaluated: 1, blocked: 0 });
    // Past the stand-down, so the seam went on to ask the broker. This is what
    // makes the `single_leg_directional` `brokerSubmits() === 0` above evidence
    // about the GATE rather than about the fixture failing to reach the submit.
    expect(brokerSubmits()).toBe(1);
  });

  it('refuses an open that carries no sleeve at all', async () => {
    const { internals, position } = liveEngine();
    const { mirrored, skips } = await mirror(internals, position, undefined);

    expect(mirrored).toBe(false);
    expect(brokerSubmits()).toBe(0);
    expect(skips[0]).toContain('fail-closed');

    const gate = standDownGate();
    expect(gate.byScope['unattributed']).toEqual({ evaluated: 1, blocked: 1 });
  });

  // A stand-down that stranded open positions would be worse than the hazard it
  // closes. This seam is opens-only; the test states it so a future move of the
  // call site onto a shared open/close path fails here.
  it('is bound to a seam a DEMO open never reaches, so nothing off the live path is touched', async () => {
    const { internals, position } = liveEngine();
    internals.mode = 'demo';

    const { mirrored } = await mirror(internals, position, 'single_leg_directional');

    // The seam's own `mode !== 'live'` head returns true and touches nothing.
    expect(mirrored).toBe(true);
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(1);
    expect(standDownGate().evaluated).toBe(0);
  });
});
