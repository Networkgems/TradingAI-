import { describe, it, expect } from 'vitest';
import { isDecoupledExitCadenceEnabled, DECOUPLED_EXIT_CADENCE_FLAG } from './exit-cadence-flag.js';
import { DEMO_FLAG_ALLOWLIST } from './demo-flags.js';

describe('TRA-2200 — decoupled exit-cadence flag', () => {
  it('is OFF when unset — a second broker-order exit path never arms itself', () => {
    expect(isDecoupledExitCadenceEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('accepts the house truthy set, case- and whitespace-insensitively', () => {
    for (const raw of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isDecoupledExitCadenceEnabled({ [DECOUPLED_EXIT_CADENCE_FLAG]: raw })).toBe(true);
    }
  });

  it('treats anything else as OFF — including the near-misses that read as intent', () => {
    // `enabled`/`0`/`false` must not arm it. A flag that half-parses is worse than
    // one that does not parse at all: the operator believes it is on.
    for (const raw of ['0', 'false', 'no', 'off', '', '  ', 'enabled', '2']) {
      expect(isDecoupledExitCadenceEnabled({ [DECOUPLED_EXIT_CADENCE_FLAG]: raw })).toBe(false);
    }
  });

  it('is on DEMO_FLAG_ALLOWLIST so the demo book arms without an env write', () => {
    // bqb1 is the frozen TRA-1648 soak host: a Render ENV/SETTINGS write REDEPLOYS
    // it (trigger `service_updated`) and restarts the soak window. The demo-flags
    // file is the only writable switch that does not.
    expect([...DEMO_FLAG_ALLOWLIST]).toContain(DECOUPLED_EXIT_CADENCE_FLAG);
  });
});
