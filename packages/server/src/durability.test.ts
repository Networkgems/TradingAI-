import { describe, it, expect } from 'vitest';
import {
  evaluateDurability,
  enforceDurabilityPolicy,
  resolveDurabilityPolicy,
  DurabilityRefusedError,
  type DurabilityInputs,
} from './durability.js';

// TRA-1681 — every durable store on this box fails OPEN, and the sum of those local,
// individually-defensible decisions is a process that can run with nothing durable
// under it while reading completely healthy. These tests pin the two properties that
// make the verdict trustworthy: an UNMEASURED guarantee is never a passing one, and a
// KNOWN-BROKEN one can actually stop the boot.

const DURABLE_ENV = { DATA_DIR: '/data' } as NodeJS.ProcessEnv;
const OPEN_DB = { available: true, reason: null, initialized: true };

function inputs(over: Partial<DurabilityInputs> = {}): DurabilityInputs {
  return {
    dataDir: '/data',
    stateDb: OPEN_DB,
    journal: { corruptLines: 0, readError: null },
    ledger: { appendErrors: 0 },
    ...over,
  };
}

describe('durability policy (TRA-1681)', () => {
  it('defaults to observe, and only the exact string "refuse" arms the refusal', () => {
    expect(resolveDurabilityPolicy({} as NodeJS.ProcessEnv)).toBe('observe');
    expect(resolveDurabilityPolicy({ DURABILITY_POLICY: 'refuse' } as NodeJS.ProcessEnv)).toBe('refuse');
    expect(resolveDurabilityPolicy({ DURABILITY_POLICY: ' REFUSE ' } as NodeJS.ProcessEnv)).toBe('refuse');
    // Anything else is observe. A typo must not silently arm a boot refusal.
    expect(resolveDurabilityPolicy({ DURABILITY_POLICY: 'refus' } as NodeJS.ProcessEnv)).toBe('observe');
    expect(resolveDurabilityPolicy({ DURABILITY_POLICY: '1' } as NodeJS.ProcessEnv)).toBe('observe');
  });
});

describe('durability verdict (TRA-1681)', () => {
  it('is ok ONLY when nothing is broken and nothing is unmeasured', () => {
    const r = evaluateDurability(inputs(), DURABLE_ENV);
    expect(r.violations).toEqual([]);
    expect(r.unmeasured).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.ephemeral).toBe(false);
  });

  it('flags an ephemeral DATA_DIR even though every IO-level check would PASS', () => {
    // The one with teeth, and the reason this cannot be a try/catch. DATA_DIR unset ⇒
    // the caller falls back to a real, writable directory inside the build bundle.
    // mkdir succeeds, append succeeds, the boot hydrate reads it straight back — and
    // the data still evaporates on the next redeploy. No exception is ever raised.
    // The PATH is the only discriminator.
    const r = evaluateDurability(
      inputs({ dataDir: '/app/packages/server/data' }),
      {} as NodeJS.ProcessEnv, // DATA_DIR unset
    );
    expect(r.ephemeral).toBe(true);
    expect(r.violations).toContain('data_dir_ephemeral');
    expect(r.ok).toBe(false);
  });

  it('treats an UNMEASURED journal as not-ok, never as a pass', () => {
    // `corruptLines: null` means no load has run. It is NOT `0`, which is a real
    // measurement of a clean file (TRA-1707). Folding unmeasured into ok=true would
    // reproduce the precise false-green this ticket exists to kill.
    const nullJournal = evaluateDurability(inputs({ journal: { corruptLines: null, readError: null } }), DURABLE_ENV);
    expect(nullJournal.unmeasured).toContain('journal_integrity');
    expect(nullJournal.violations).toEqual([]); // unknown is not broken...
    expect(nullJournal.ok).toBe(false); // ...but it is not ok, either.

    const absentJournal = evaluateDurability(inputs({ journal: undefined }), DURABLE_ENV);
    expect(absentJournal.unmeasured).toContain('journal_integrity');
    expect(absentJournal.ok).toBe(false);

    const absentLedger = evaluateDurability(inputs({ ledger: undefined }), DURABLE_ENV);
    expect(absentLedger.unmeasured).toContain('ledger_appends');
    expect(absentLedger.ok).toBe(false);
  });

  it('does not call an UNINITIALISED state db broken — that is unknown, not a violation', () => {
    // A CLI or a unit test never opens the store. Reporting that as an outage is how a
    // guard earns a reputation for crying wolf, and a guard with that reputation gets
    // disarmed. Only a store that TRIED and FAILED counts.
    const notTried = evaluateDurability(
      inputs({ stateDb: { available: false, reason: null, initialized: false } }),
      DURABLE_ENV,
    );
    expect(notTried.violations).toEqual([]);

    const triedAndFailed = evaluateDurability(
      inputs({ stateDb: { available: false, reason: 'Cannot find module better-sqlite3', initialized: true } }),
      DURABLE_ENV,
    );
    expect(triedAndFailed.violations).toContain('state_db_unavailable');
    expect(triedAndFailed.ok).toBe(false);
  });

  it('flags a journal read error, dropped lines, and swallowed ledger appends', () => {
    expect(
      evaluateDurability(inputs({ journal: { corruptLines: 0, readError: 'EISDIR' } }), DURABLE_ENV).violations,
    ).toContain('journal_read_error');

    expect(
      evaluateDurability(inputs({ journal: { corruptLines: 3, readError: null } }), DURABLE_ENV).violations,
    ).toContain('journal_corrupt_lines');

    // A swallowed append means the counters the ledger publishes OVERSTATE what is on
    // disk. Uncounted, a lost row reads identically to a written one.
    expect(evaluateDurability(inputs({ ledger: { appendErrors: 2 } }), DURABLE_ENV).violations).toContain(
      'ledger_append_errors',
    );
  });
});

describe('durability enforcement (TRA-1681)', () => {
  it('observe (the default) reports a broken guarantee and keeps serving', () => {
    const r = evaluateDurability(inputs({ dataDir: '/app/packages/server/data' }), {} as NodeJS.ProcessEnv);
    expect(r.policy).toBe('observe');
    expect(r.violations).toContain('data_dir_ephemeral');
    expect(() => enforceDurabilityPolicy(r)).not.toThrow(); // byte-for-byte today's behaviour
  });

  it('refuse REFUSES on a known-broken guarantee — the fail-CLOSED half', () => {
    const r = evaluateDurability(inputs({ dataDir: '/app/packages/server/data' }), {
      DURABILITY_POLICY: 'refuse',
    } as NodeJS.ProcessEnv);
    expect(() => enforceDurabilityPolicy(r)).toThrow(DurabilityRefusedError);
    expect(() => enforceDurabilityPolicy(r)).toThrow(/data_dir_ephemeral/);
  });

  it('refuse does NOT refuse on an UNMEASURED guarantee — that would be unbootable by construction', () => {
    // The asymmetry that makes `refuse` shippable. At boot the journal has not been read
    // yet, so its integrity is legitimately unknown. Refusing over a measurement that
    // cannot exist yet would deadlock every boot. `unmeasured` VOIDS A GRADE; it never
    // stops a process.
    const r = evaluateDurability(
      { dataDir: '/data', stateDb: OPEN_DB }, // no journal, no ledger — exactly the boot call
      { DATA_DIR: '/data', DURABILITY_POLICY: 'refuse' } as NodeJS.ProcessEnv,
    );
    expect(r.ok).toBe(false);
    expect(r.unmeasured).toEqual(['journal_integrity', 'ledger_appends']);
    expect(r.violations).toEqual([]);
    expect(() => enforceDurabilityPolicy(r)).not.toThrow();
  });
});
