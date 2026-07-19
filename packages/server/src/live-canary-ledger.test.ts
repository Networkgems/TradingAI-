import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { RiskManager } from '@trading-app/engine';
import { MANAGED_ACCOUNT_RATIO } from '@trading-app/shared';
import {
  LIVE_CANARY_FLAG,
  isLiveCanaryEnabled,
  setLiveCanaryLedgerFileForTests,
  initLiveCanaryLedger,
  getCanaryState,
  armCanaryCandidate,
  recordCanaryGuardSweep,
  sizeCanaryTrade,
  buildCanaryHealth,
} from './live-canary-ledger.js';
import type { CanaryTelemetry } from '@trading-app/engine';

const ON = { [LIVE_CANARY_FLAG]: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'live-canary-'));
  setLiveCanaryLedgerFileForTests(join(dir, 'state.jsonl'));
});

afterEach(async () => {
  setLiveCanaryLedgerFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

function cleanTelemetry(): CanaryTelemetry {
  return {
    allocation: 25_000,
    cumulativePnl: -1_000,
    dailyPnl: -500,
    tradesToday: 2,
    concurrentPositions: 1,
    realizedSlippageBps: 6,
    modeledSlippageBps: 5,
    maxTradeNotional: 10_000,
  };
}

describe('isLiveCanaryEnabled — default OFF', () => {
  it('is OFF when unset and accepts the usual truthy spellings', () => {
    expect(isLiveCanaryEnabled({})).toBe(false);
    expect(isLiveCanaryEnabled({ [LIVE_CANARY_FLAG]: 'false' })).toBe(false);
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isLiveCanaryEnabled({ [LIVE_CANARY_FLAG]: v })).toBe(true);
    }
  });
});

describe('flag OFF — zero behaviour change', () => {
  it('records nothing and leaves the safe default state', async () => {
    await initLiveCanaryLedger();
    const arm = await armCanaryCandidate('cand-1', 1_000, OFF);
    expect(arm.armed).toBe(false);
    expect(arm.reason).toBe('flag_off');

    const sweep = await recordCanaryGuardSweep(cleanTelemetry(), 2_000, undefined, OFF);
    expect(sweep.recorded).toBe(false);

    const state = await getCanaryState();
    expect(state.stage).toBe('shadow');
    expect(state.canaryDemoted).toBe(false);

    const health = await buildCanaryHealth(undefined, OFF);
    expect(health.flagEnabled).toBe(false);
    expect(health.stage).toBe('shadow');
    expect(health.lastSweepAt).toBeNull();
  });
});

describe('flag ON — arm, sweep, auto-demote latch', () => {
  it('arms one candidate and continues on a clean sweep', async () => {
    await initLiveCanaryLedger();
    const arm = await armCanaryCandidate('cand-1', 1_000, ON);
    expect(arm.armed).toBe(true);
    expect(arm.state.stage).toBe('canary');

    const sweep = await recordCanaryGuardSweep(cleanTelemetry(), 2_000, undefined, ON);
    expect(sweep.recorded).toBe(true);
    expect(sweep.action).toBe('continue');
    expect(sweep.state.stage).toBe('canary');
  });

  it('refuses a second candidate while one is armed (one at a time)', async () => {
    await initLiveCanaryLedger();
    await armCanaryCandidate('cand-1', 1_000, ON);
    const second = await armCanaryCandidate('cand-2', 1_500, ON);
    expect(second.armed).toBe(false);
    expect(second.reason).toBe('already_armed');
  });

  it('auto-demotes to shadow and LATCHES on a breach', async () => {
    await initLiveCanaryLedger();
    await armCanaryCandidate('cand-1', 1_000, ON);
    const breach = await recordCanaryGuardSweep(
      { ...cleanTelemetry(), dailyPnl: -5_000 }, // -20% today, over the 5% breaker
      2_000,
      undefined,
      ON,
    );
    expect(breach.action).toBe('demote');
    expect(breach.state.stage).toBe('shadow');
    expect(breach.state.candidateId).toBeNull();
    expect(breach.state.canaryDemoted).toBe(true);
    expect(breach.state.demotionReasons).toContain('DAILY_LOSS_CAP');
  });

  it('auto-demotes fail-closed on missing telemetry', async () => {
    await initLiveCanaryLedger();
    await armCanaryCandidate('cand-1', 1_000, ON);
    const t = cleanTelemetry();
    // @ts-expect-error — corrupt a reading
    t.realizedSlippageBps = undefined;
    const breach = await recordCanaryGuardSweep(t, 2_000, undefined, ON);
    expect(breach.action).toBe('demote');
    expect(breach.evaluation.failClosed).toBe(true);
    expect(breach.state.canaryDemoted).toBe(true);
  });

  it('refuses to re-arm once the latch is set', async () => {
    await initLiveCanaryLedger();
    await armCanaryCandidate('cand-1', 1_000, ON);
    await recordCanaryGuardSweep({ ...cleanTelemetry(), dailyPnl: -5_000 }, 2_000, undefined, ON);
    const reArm = await armCanaryCandidate('cand-2', 3_000, ON);
    expect(reArm.armed).toBe(false);
    expect(reArm.reason).toBe('demotion_latched');
  });
});

describe('durable latch — survives a reload (fail-closed on restart)', () => {
  it('reloads a demoted/latched state from the ledger', async () => {
    await initLiveCanaryLedger();
    await armCanaryCandidate('cand-1', 1_000, ON);
    await recordCanaryGuardSweep({ ...cleanTelemetry(), cumulativePnl: -5_000 }, 2_000, undefined, ON);

    // Simulate a restart: drop the in-memory cache, re-point at the same file.
    setLiveCanaryLedgerFileForTests(join(dir, 'state.jsonl'));
    await initLiveCanaryLedger();

    const state = await getCanaryState();
    expect(state.stage).toBe('shadow');
    expect(state.canaryDemoted).toBe(true);
    expect(state.demotionReasons).toContain('CUMULATIVE_LOSS_CAP');

    // A latched canary cannot silently re-arm after the restart.
    const reArm = await armCanaryCandidate('cand-2', 4_000, ON);
    expect(reArm.armed).toBe(false);
    expect(reArm.reason).toBe('demotion_latched');
  });
});

describe('buildCanaryHealth — readout', () => {
  it('exposes stage, allocation, per-limit headroom and demotion state', async () => {
    await initLiveCanaryLedger();
    await armCanaryCandidate('cand-1', 1_000, ON);
    await recordCanaryGuardSweep(cleanTelemetry(), 2_000, undefined, ON);

    const h = await buildCanaryHealth(undefined, ON);
    expect(h.issue).toBe('TRA-2051');
    expect(h.flagEnabled).toBe(true);
    expect(h.stage).toBe('canary');
    expect(h.candidateId).toBe('cand-1');
    expect(h.allocation).toBe(25_000);
    expect(h.headroom).toHaveLength(5);
    expect(h.canaryDemoted).toBe(false);
    for (const row of h.headroom) expect(row.headroom).toBeGreaterThan(0);
  });
});

describe('sizeCanaryTrade — parity with the engine RiskManager', () => {
  // The canary MUST size positions from the SAME engine code the backtest runner
  // and live/paper accounts use (TRA-2034). Pin it against a directly-constructed
  // RiskManager across several [allocation, entry, stop, riskPct] cases, including
  // one where the TRA-178 notional cap binds.
  const cases: Array<{ allocation: number; entry: number; stop: number; riskPct: number; frac: boolean }> = [
    { allocation: 25_000, entry: 100, stop: 98, riskPct: 0.01, frac: false }, // risk-budget binds
    { allocation: 25_000, entry: 100, stop: 99.99, riskPct: 0.01, frac: false }, // notional cap binds
    { allocation: 10_000, entry: 250, stop: 240, riskPct: 0.0075, frac: false },
    { allocation: 25_000, entry: 60_000, stop: 58_800, riskPct: 0.01, frac: true }, // fractional (crypto)
  ];

  for (const [i, tc] of cases.entries()) {
    it(`case ${i}: canary sizing == RiskManager.sizeFromStop`, () => {
      const got = sizeCanaryTrade(tc.entry, tc.stop, {
        allocation: tc.allocation,
        riskPerTrade: tc.riskPct,
        fractionalQuantity: tc.frac,
      });
      // The canary allocation IS the managed equity, so back-scale to totalEquity.
      const totalEquity = tc.allocation / MANAGED_ACCOUNT_RATIO;
      const expected = new RiskManager(
        { totalEquity, availableCash: totalEquity, openPositions: [], dailyPnl: 0 },
        { fractionalQuantity: tc.frac },
      ).sizeFromStop(tc.entry, tc.stop, { riskPct: tc.riskPct });
      expect(got).toBe(expected);
    });
  }
});
