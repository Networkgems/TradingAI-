import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateExecutionGate,
  killSwitchClear,
  buildOrderAudit,
  type ExecutionGateInput,
} from './agent-execution.js';
import { recordExecutedOrder, resetExecutionCapsForTests } from './agent-execution-caps-store.js';
import {
  shouldAutoConfirm,
  AUTO_CONFIRM_MIN_CONVICTION,
  AUTO_CONFIRM_MAX_NOTIONAL_USD,
} from '@trading-app/shared';

const NOW = Date.parse('2026-06-18T16:00:00Z');

// A baseline gate input where EVERYTHING is clear (would allow). Each test flips
// exactly one field so the assertion isolates that gate.
function baseGate(overrides: Partial<ExecutionGateInput> = {}): ExecutionGateInput {
  return {
    mode: 'demo',
    bannerEnabled: true,
    envKill: false,
    halted: false,
    autoTradeEnabled: true,
    liveGateCleared: true,
    user: 'tester',
    notional: 100,
    now: NOW,
    ...overrides,
  };
}

describe('agent-execution — evaluateExecutionGate (TRA-941 Piece 3)', () => {
  beforeEach(() => resetExecutionCapsForTests());

  it('allows execution when every gate is clear', () => {
    expect(evaluateExecutionGate(baseGate()).allowed).toBe(true);
  });

  it('kill-switch-off blocks execution — env kill', () => {
    const d = evaluateExecutionGate(baseGate({ envKill: true }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/env kill switch/i);
  });

  it('kill-switch-off blocks execution — banner toggle OFF', () => {
    const d = evaluateExecutionGate(baseGate({ bannerEnabled: false }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/banner toggle is OFF/i);
  });

  it('halt (risk circuit-breaker) blocks execution', () => {
    const d = evaluateExecutionGate(baseGate({ halted: true }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/halted/i);
  });

  it('per-mode auto-trade toggle OFF blocks execution', () => {
    const d = evaluateExecutionGate(baseGate({ autoTradeEnabled: false }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/auto-trading toggle is OFF/i);
  });

  it('live without the board+CTO go-live gate is blocked', () => {
    const d = evaluateExecutionGate(baseGate({ mode: 'live', liveGateCleared: false, notional: 100 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/go-live gate/i);
  });

  it('cap-exceeded blocks execution (live daily order cap)', () => {
    for (let i = 0; i < 5; i++) {
      recordExecutedOrder({ user: 'tester', mode: 'live', notional: 100, now: NOW });
    }
    const d = evaluateExecutionGate(baseGate({ mode: 'live', notional: 100 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/order cap reached/i);
  });

  it('killSwitchClear is true only when banner ON and env kill unset', () => {
    expect(killSwitchClear(true, false)).toBe(true);
    expect(killSwitchClear(false, false)).toBe(false);
    expect(killSwitchClear(true, true)).toBe(false);
  });

  it('buildOrderAudit captures the full provenance chain', () => {
    const a = buildOrderAudit({
      agentId: 'trading-agents',
      recommendationId: 'agent-AAPL-1000',
      proposalId: 'prop-agent-AAPL-1000-1',
      symbol: 'AAPL',
      side: 'buy',
      size: 3,
      notional: 300,
      mode: 'live',
      orderId: 98765,
      now: NOW,
    });
    expect(a).toMatchObject({
      agentId: 'trading-agents',
      recommendationId: 'agent-AAPL-1000',
      proposalId: 'prop-agent-AAPL-1000-1',
      symbol: 'AAPL',
      size: 3,
      notional: 300,
      mode: 'live',
      orderId: 98765,
      timestamp: NOW,
    });
  });
});

describe('shouldAutoConfirm — TRA-939 §A auto-confirm boundaries', () => {
  const ok = { autoTradeEnabled: true, killSwitchClear: true } as const;

  it('demo auto-confirms at exactly the ratified boundaries (>=0.70, <=$250)', () => {
    expect(shouldAutoConfirm({ mode: 'demo', conviction: AUTO_CONFIRM_MIN_CONVICTION, notional: AUTO_CONFIRM_MAX_NOTIONAL_USD, ...ok }).autoConfirm).toBe(true);
  });

  it('demo does NOT auto-confirm just below the conviction floor', () => {
    const d = shouldAutoConfirm({ mode: 'demo', conviction: 0.6999, notional: 100, ...ok });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/conviction/);
  });

  it('demo does NOT auto-confirm just above the notional ceiling', () => {
    const d = shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 250.01, ...ok });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/notional/);
  });

  it('live NEVER auto-confirms in v1, even with strong conviction & tiny notional', () => {
    const d = shouldAutoConfirm({ mode: 'live', conviction: 0.99, notional: 1, ...ok });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/live never auto-confirms/i);
  });

  it('demo does not auto-confirm when the kill switch is engaged or the toggle is off', () => {
    expect(shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 10, autoTradeEnabled: true, killSwitchClear: false }).autoConfirm).toBe(false);
    expect(shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 10, autoTradeEnabled: false, killSwitchClear: true }).autoConfirm).toBe(false);
  });
});
