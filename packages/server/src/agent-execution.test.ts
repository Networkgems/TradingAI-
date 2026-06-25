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
  AUTO_CONFIRM_OPTIONS_MIN_POP,
  AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD,
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

describe('shouldAutoConfirm — TRA-1142 §options auto-confirm gates', () => {
  const ok = { autoTradeEnabled: true, killSwitchClear: true } as const;
  // For an options proposal the base `conviction`/`notional` fields mirror the
  // option (POP / single-lot max loss); the `option` block is what the gate reads.
  const opt = (over: Partial<{ pop: number; maxLossUsd: number; definedRisk: boolean }> = {}) => ({
    pop: AUTO_CONFIRM_OPTIONS_MIN_POP,
    maxLossUsd: AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD,
    definedRisk: true,
    ...over,
  });

  it('demo auto-confirms at exactly the options boundaries (POP >= 0.55, maxLoss <= $250)', () => {
    const d = shouldAutoConfirm({
      mode: 'demo',
      conviction: AUTO_CONFIRM_OPTIONS_MIN_POP,
      notional: AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD,
      ...ok,
      option: opt(),
    });
    expect(d.autoConfirm).toBe(true);
  });

  it('live NEVER auto-confirms an options proposal, even with a strong POP and tiny max loss', () => {
    const d = shouldAutoConfirm({ mode: 'live', conviction: 0.99, notional: 1, ...ok, option: opt({ pop: 0.99, maxLossUsd: 1 }) });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/live never auto-confirms/i);
  });

  it('does NOT auto-confirm an undefined-risk options structure', () => {
    const d = shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 50, ...ok, option: opt({ definedRisk: false }) });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/undefined-risk/i);
  });

  it('does NOT auto-confirm when the max loss is unpriced (<= $0)', () => {
    const d = shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 0, ...ok, option: opt({ maxLossUsd: 0 }) });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/not priced/i);
  });

  it('does NOT auto-confirm just below the POP floor', () => {
    const d = shouldAutoConfirm({ mode: 'demo', conviction: 0.5, notional: 50, ...ok, option: opt({ pop: AUTO_CONFIRM_OPTIONS_MIN_POP - 0.0001 }) });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/POP/);
  });

  it('does NOT auto-confirm just above the single-lot max-loss cap', () => {
    const d = shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 250.01, ...ok, option: opt({ maxLossUsd: AUTO_CONFIRM_OPTIONS_MAX_LOSS_USD + 0.01 }) });
    expect(d.autoConfirm).toBe(false);
    expect(d.reason).toMatch(/max loss/i);
  });

  it('does NOT auto-confirm an options proposal when kill switch engaged or toggle off', () => {
    expect(shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 50, autoTradeEnabled: true, killSwitchClear: false, option: opt() }).autoConfirm).toBe(false);
    expect(shouldAutoConfirm({ mode: 'demo', conviction: 0.9, notional: 50, autoTradeEnabled: false, killSwitchClear: true, option: opt() }).autoConfirm).toBe(false);
  });
});
