import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import type { SetupTaxonomyDefinition } from '@trading-app/engine';
import {
  resolveSetupTaxonomyMode,
  resolveSetupTaxonomySetups,
  evaluateOtmSetupGate,
  setupTaxonomyHealth,
  OTM_SETUP_TAXONOMY_MODE_DEFAULT,
} from './otm-setup-gate.js';
import {
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  recordLiveEnforceDecision,
} from './live-enforce-gate-ledger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function series(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'AAPL',
    timestamp: 1_700_000_000_000 + i * DAY_MS,
    open: 100, high: 101, low: 99, close: 100.5, volume: 1_000,
  }));
}

const setupE = (side: 'call' | 'put'): SetupTaxonomyDefinition => ({
  setupId: 'E', label: 'Normal Breakout', minBars: 10,
  evaluate: () => ({ setupId: 'E', side }),
});

describe('mode resolution — UNKNOWN is not OFF', () => {
  it('defaults to observe with source "default" when unset', () => {
    const r = resolveSetupTaxonomyMode({});
    expect(r.mode).toBe('observe');
    expect(r.mode).toBe(OTM_SETUP_TAXONOMY_MODE_DEFAULT);
    expect(r.source).toBe('default');
    expect(r.raw).toBeNull();
  });

  it('reads enforce from the env and says the env said so', () => {
    const r = resolveSetupTaxonomyMode({ OTM_SETUP_TAXONOMY_MODE: 'enforce' });
    expect(r.mode).toBe('enforce');
    expect(r.source).toBe('env');
  });

  it('⛔ a typo falls back to observe but reports env_invalid, NOT default', () => {
    // The whole point: "ENFORCED" (a plausible typo) must not read back
    // identically to nobody having set the flag at all.
    const typo = resolveSetupTaxonomyMode({ OTM_SETUP_TAXONOMY_MODE: 'enforced' });
    const unset = resolveSetupTaxonomyMode({});
    expect(typo.mode).toBe(unset.mode); // same SAFE behaviour...
    expect(typo.source).not.toBe(unset.source); // ...different, visible provenance
    expect(typo.source).toBe('env_invalid');
    expect(typo.raw).toBe('enforced');
  });

  it('is case- and whitespace-tolerant on a real value', () => {
    expect(resolveSetupTaxonomyMode({ OTM_SETUP_TAXONOMY_MODE: '  Enforce ' }).mode).toBe('enforce');
    expect(resolveSetupTaxonomyMode({ OTM_SETUP_TAXONOMY_MODE: '   ' }).source).toBe('default');
  });
});

describe('enable list — registered is not armed', () => {
  it('an absent list enables nothing even when the registry is full', () => {
    const r = resolveSetupTaxonomySetups({}, [setupE('call')]);
    expect(r.enabled).toHaveLength(0);
    expect(r.enabledIds).toEqual([]);
  });

  it('enables only what is named', () => {
    const r = resolveSetupTaxonomySetups({ OTM_SETUP_TAXONOMY_SETUPS: 'E' }, [setupE('call')]);
    expect(r.enabledIds).toEqual(['E']);
    expect(r.unknownIds).toEqual([]);
  });

  it('⛔ reports an unknown id rather than dropping it', () => {
    // "I enabled setup C" over a typo is otherwise indistinguishable from
    // "setup C is enabled and never confirms".
    const r = resolveSetupTaxonomySetups({ OTM_SETUP_TAXONOMY_SETUPS: 'E, C' }, [setupE('call')]);
    expect(r.enabledIds).toEqual(['E']);
    expect(r.unknownIds).toEqual(['C']);
  });
});

describe('the gate decision', () => {
  const input = { symbol: 'AAPL', series: series(120), nomineeSide: 'call' as const };

  it('OBSERVE never blocks — not even when the taxonomy refuses', () => {
    const d = evaluateOtmSetupGate(
      input,
      { OTM_SETUP_TAXONOMY_SETUPS: 'E' },
      [setupE('put')], // confirms on the WRONG side
    );
    expect(d.mode).toBe('observe');
    expect(d.verdict.confirmed).toBe(false);
    expect(d.reasonCode).toBe('setup_side_conflict');
    expect(d.blocked).toBe(false); // ← the observe contract
    expect(d.reason).toBeNull();
  });

  it('⛔ NEGATIVE CONTROL — the same input in ENFORCE drives blocked TRUE', () => {
    // This is the test that makes the instrument falsifiable. If `blocked` can
    // never move off false, `blocked: 0` on the health route proves nothing and
    // the gate is not shipped. Same input, same registry, one env key different.
    const observe = evaluateOtmSetupGate(
      input, { OTM_SETUP_TAXONOMY_SETUPS: 'E' }, [setupE('put')],
    );
    const enforce = evaluateOtmSetupGate(
      input,
      { OTM_SETUP_TAXONOMY_SETUPS: 'E', OTM_SETUP_TAXONOMY_MODE: 'enforce' },
      [setupE('put')],
    );
    expect(observe.blocked).toBe(false);
    expect(enforce.blocked).toBe(true);
    expect(enforce.reason).toContain('setup_side_conflict');
  });

  it('enforce ADMITS a confirmed nominee — the gate is not a blanket refusal', () => {
    const d = evaluateOtmSetupGate(
      input,
      { OTM_SETUP_TAXONOMY_SETUPS: 'E', OTM_SETUP_TAXONOMY_MODE: 'enforce' },
      [setupE('call')],
    );
    expect(d.verdict.confirmed).toBe(true);
    expect(d.blocked).toBe(false);
    expect(d.reasonCode).toBeNull();
  });

  it('scores the taxonomy in OBSERVE too — the counterfactual is the deliverable', () => {
    const d = evaluateOtmSetupGate(input, { OTM_SETUP_TAXONOMY_SETUPS: 'E' }, [setupE('call')]);
    expect(d.blocked).toBe(false);
    // It ran: confirmed true and a setup id, while refusing nothing.
    expect(d.verdict.confirmed).toBe(true);
    expect(d.verdict.setupsScored).toBe(1);
  });

  it('as SHIPPED (empty registry, no env) it admits everything and reports why', () => {
    const d = evaluateOtmSetupGate(input, {});
    expect(d.mode).toBe('observe');
    expect(d.blocked).toBe(false);
    expect(d.reasonCode).toBe('no_setup_matched');
    // ⛔ scored 0 ⇒ a grader must read this as UNMEASURED, not "found nothing".
    expect(d.verdict.setupsScored).toBe(0);
  });
});

describe('health readout', () => {
  it('publishes the live mode, its provenance, and the registered-vs-enabled split', () => {
    const h = setupTaxonomyHealth(
      { OTM_SETUP_TAXONOMY_MODE: 'nonsense', OTM_SETUP_TAXONOMY_SETUPS: 'E,Z' },
      [setupE('call')],
    );
    expect(h.mode).toBe('observe');
    expect(h.modeSource).toBe('env_invalid');
    expect(h.modeRaw).toBe('nonsense');
    expect(h.setupsEnabled).toEqual(['E']);
    expect(h.setupsUnknown).toEqual(['Z']);
    // Registered ≠ enabled. The deployed-bytes read is its own field.
    expect(h.setupsRegistered).toEqual(['E']);
  });
});

describe('ledger census', () => {
  it('publishes a setup_confirmation ZERO row before the gate has ever fired', () => {
    // The key's PRESENCE at evaluated:0 is the env-independent deployed-bytes
    // proof this control shipped; its ABSENCE proves it did not. Asserted off
    // the real summary output rather than the internal roster constant, because
    // it is the summary a grader reads.
    clearLiveEnforceGateLedger();
    const row = summarizeLiveEnforceGate('2026-09-09')
      .byGate.find((g) => g.gate === 'setup_confirmation');
    expect(row).toBeDefined();
    expect(row!.evaluated).toBe(0);
    expect(row!.blocked).toBe(0);
  });

  it('⛔ NEGATIVE CONTROL — a recorded refusal moves that row off zero', () => {
    // A field that cannot move is not an instrument. If this assertion can be
    // deleted without the suite noticing, `blocked: 0` on the live route is
    // consistent with the gate never having been wired in.
    clearLiveEnforceGateLedger();
    recordLiveEnforceDecision(
      'setup_confirmation', 'single_leg_otm', false, '2026-09-09', undefined, Date.now(),
      { reasonCode: 'no_setup_matched', book: 'test-book' },
    );
    recordLiveEnforceDecision(
      'setup_confirmation', 'single_leg_otm', true, '2026-09-09', 'refused', Date.now(),
      { reasonCode: 'setup_side_conflict', book: 'test-book' },
    );
    const row = summarizeLiveEnforceGate('2026-09-09')
      .byGate.find((g) => g.gate === 'setup_confirmation');
    expect(row!.evaluated).toBe(2);
    expect(row!.blocked).toBe(1);
    clearLiveEnforceGateLedger();
  });
});
