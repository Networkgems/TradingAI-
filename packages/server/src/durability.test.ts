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

// TRA-3011 — a fresh, healthy disk reading. `ageSec` inside the staleness bar.
const HEALTHY_DISK: NonNullable<DurabilityInputs['disk']> = {
  belowThreshold: false,
  exhausted: null,
  ageSec: 30,
  belowThresholdSeen: false,
  exhaustedSeen: null,
  readings: 42,
  firstBelowAt: null,
  lastBelowAt: null,
  bootedAt: '2026-08-06T00:00:00.000Z',
};

function disk(
  over: Partial<NonNullable<DurabilityInputs['disk']>> = {},
): NonNullable<DurabilityInputs['disk']> {
  return { ...HEALTHY_DISK, ...over };
}

function inputs(over: Partial<DurabilityInputs> = {}): DurabilityInputs {
  return {
    dataDir: '/data',
    stateDb: OPEN_DB,
    journal: { corruptLines: 0, readError: null },
    ledger: { appendErrors: 0 },
    disk: HEALTHY_DISK,
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

  // ── TRA-4896 ───────────────────────────────────────────────────────────────────────
  // The self-host's DATA_DIR was SET (so the `data_dir_unset` arm above never applied)
  // and pointed at `<paperclip scratch>/_default/tradingai_repo/packages/server/data`.
  // It tripped `data_dir_ephemeral` on the `/packages/server` marker alone — which is
  // the right VERDICT for the wrong REASON, and the wrong reason has a different fix.
  // The bundle marker says "point DATA_DIR off the bundle"; obeying that literally
  // lands you at `<paperclip scratch>/_default/data`, which is just as erasable and
  // would have read GREEN. These pin that it does not.
  describe('the ephemeral scratch tree is its own reason, not a bundle-path accident', () => {
    const scratch = 'C:/Users/x/.paperclip/instances/default/projects/co/proj/_default';

    it('names the scratch tree when the path is inside it but OUT of the bundle', () => {
      const dataDir = `${scratch}/data`;
      const r = evaluateDurability(inputs({ dataDir }), { DATA_DIR: dataDir } as NodeJS.ProcessEnv);
      expect(r.ephemeral).toBe(true);
      expect(r.ephemeralReason).toBe('in_ephemeral_scratch_tree');
      expect(r.violations).toContain('data_dir_ephemeral');
    });

    it('reports the live pre-fix path (both markers) as ephemeral', () => {
      const dataDir = `${scratch}/tradingai_repo/packages/server/data`;
      const r = evaluateDurability(inputs({ dataDir }), { DATA_DIR: dataDir } as NodeJS.ProcessEnv);
      expect(r.ephemeral).toBe(true);
      expect(r.violations).toContain('data_dir_ephemeral');
    });

    it('accepts the post-fix machine-wide targets and reports reason null', () => {
      for (const dataDir of ['C:/ProgramData/TradingAI/data', '/srv/tradingai/data', '/data']) {
        const r = evaluateDurability(inputs({ dataDir }), { DATA_DIR: dataDir } as NodeJS.ProcessEnv);
        expect(r.ephemeral, dataDir).toBe(false);
        expect(r.ephemeralReason, dataDir).toBeNull();
        expect(r.violations, dataDir).toEqual([]);
      }
    });

    it('carries the reason on the two pre-existing arms too', () => {
      expect(
        evaluateDurability(inputs({ dataDir: null }), { DATA_DIR: '/data' } as NodeJS.ProcessEnv)
          .ephemeralReason,
      ).toBe('memory_only');
      expect(
        evaluateDurability(inputs({ dataDir: '/data' }), {} as NodeJS.ProcessEnv).ephemeralReason,
      ).toBe('data_dir_unset');
      expect(
        evaluateDurability(
          inputs({ dataDir: '/app/packages/server/data' }),
          { DATA_DIR: '/app/packages/server/data' } as NodeJS.ProcessEnv,
        ).ephemeralReason,
      ).toBe('in_build_bundle');
    });

    it('is separable from the disk axis — free space cannot clear it (TRA-4854)', () => {
      // The parent ticket's deliverable was "durability reads ok:true", pursued by
      // pruning disk. This is the arithmetic showing that could never have worked.
      const dataDir = `${scratch}/tradingai_repo/packages/server/data`;
      const r = evaluateDurability(
        inputs({ dataDir, disk: disk({ belowThreshold: false, belowThresholdSeen: false }) }),
        { DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      );
      expect(r.violations).toEqual(['data_dir_ephemeral']);
      expect(r.ok).toBe(false);
    });
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
    expect(r.unmeasured).toEqual(['journal_integrity', 'ledger_appends', 'disk_headroom']);
    expect(r.violations).toEqual([]);
    expect(() => enforceDurabilityPolicy(r)).not.toThrow();
  });
});

// ── TRA-3011 — the sixth fail-open: the volume is FULL ───────────────────────
//
// From 2026-07-30T23:40Z to 2026-08-04T~21:20Z every write to `/data` on bqb1
// returned ENOSPC. This verdict served `ok: true, violations: [], unmeasured: []`
// the entire time, because every guarantee it graded was genuinely satisfied: the
// path was persistent, the store was open, the journal loaded clean. It graded
// WHERE the bytes go and never WHETHER THEY GO.
describe('durability disk axis (TRA-3011)', () => {
  it('★ reproduces the outage: everything else healthy, disk full ⇒ NOT ok', () => {
    // The exact shape of the 2026-07-30 box. Before this axis existed, this
    // input produced `ok: true` — there was no value of the disk that could have
    // made it fail, which is what makes it a blind spot rather than a bug.
    const r = evaluateDurability(
      inputs({ disk: disk({ belowThreshold: true, exhausted: 'inodes', belowThresholdSeen: true }) }),
      DURABLE_ENV,
    );
    expect(r.violations).toEqual(['data_dir_no_space']);
    expect(r.ok).toBe(false);
    // The rest of the verdict is untouched — this is additive, not a reweighting.
    expect(r.ephemeral).toBe(false);
    expect(r.stateDb.available).toBe(true);
  });

  it('the negative control: the same box with headroom is ok', () => {
    const r = evaluateDurability(inputs(), DURABLE_ENV);
    expect(r.violations).toEqual([]);
    expect(r.unmeasured).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.disk?.belowThreshold).toBe(false);
  });

  it('an ABSENT, UNREADABLE or STALE reading is UNMEASURED — never a pass', () => {
    // Three ways to have no fresh reading, one verdict. `unknown` is not `off`.
    expect(evaluateDurability(inputs({ disk: undefined }), DURABLE_ENV).unmeasured).toContain(
      'disk_headroom',
    );
    // statfs failed — the tri-state that the pre-TRA-2599 storage route erased.
    expect(
      evaluateDurability(inputs({ disk: disk({ belowThreshold: null }) }), DURABLE_ENV).unmeasured,
    ).toContain('disk_headroom');
    // Nothing has ever measured it.
    expect(
      evaluateDurability(inputs({ disk: disk({ ageSec: null, readings: 0 }) }), DURABLE_ENV).unmeasured,
    ).toContain('disk_headroom');
    // The 60s monitor that feeds the reading stopped: the last sample is stale
    // and permanently `false`, so it would otherwise certify a disk nobody is
    // watching. 180s is the same stall bar `/api/health/storage` grades on.
    expect(
      evaluateDurability(inputs({ disk: disk({ ageSec: 181 }) }), DURABLE_ENV).unmeasured,
    ).toContain('disk_headroom');
    // …and the boundary is inclusive on the passing side, so a monitor ticking
    // exactly on time is not perpetually unmeasured.
    expect(
      evaluateDurability(inputs({ disk: disk({ ageSec: 180 }) }), DURABLE_ENV).unmeasured,
    ).toEqual([]);
  });

  it('a full disk is GRADED but NEVER refuses a boot, unlike every other violation', () => {
    // The asymmetry, and the reason it is not an oversight: a configuration
    // fault cannot heal by running, so refusing costs nothing already lost. A
    // full disk CAN heal by running — the TRA-2817 backup prune is what ended
    // the 2026-07-30 outage, and it only runs inside a live process. Refusing
    // would cycle the box into PM2's max_restarts and take the health surface
    // this ticket adds dark at exactly the moment someone needs to read it.
    const full = evaluateDurability(
      inputs({ disk: disk({ belowThreshold: true, exhausted: 'blocks' }) }),
      { DATA_DIR: '/data', DURABILITY_POLICY: 'refuse' } as NodeJS.ProcessEnv,
    );
    expect(full.policy).toBe('refuse');
    expect(full.violations).toEqual(['data_dir_no_space']);
    expect(() => enforceDurabilityPolicy(full)).not.toThrow();

    // The control that proves the filter is not just swallowing everything: a
    // configuration fault alongside it still refuses.
    const alsoEphemeral = evaluateDurability(
      {
        ...inputs({ disk: disk({ belowThreshold: true, exhausted: 'blocks' }) }),
        dataDir: '/app/packages/server/data',
      },
      { DURABILITY_POLICY: 'refuse' } as NodeJS.ProcessEnv,
    );
    expect(alsoEphemeral.violations).toContain('data_dir_no_space');
    expect(() => enforceDurabilityPolicy(alsoEphemeral)).toThrow(DurabilityRefusedError);
    // And the thrown message names ONLY the refusable one, so the remediation
    // it prints is the one that actually applies.
    expect(() => enforceDurabilityPolicy(alsoEphemeral)).toThrow(/data_dir_ephemeral/);
    expect(() => enforceDurabilityPolicy(alsoEphemeral)).not.toThrow(/data_dir_no_space/);
  });

  it('carries the since-boot watermark through to the report for the RECOVERED case', () => {
    // A box that filled and was pruned back reads clean on every instantaneous
    // field. `belowThresholdSeen` is the only thing that says otherwise, so the
    // report has to carry it rather than collapsing the disk block to a verdict.
    const r = evaluateDurability(
      inputs({
        disk: disk({
          belowThreshold: false,
          belowThresholdSeen: true,
          exhaustedSeen: 'inodes',
          firstBelowAt: '2026-08-06T01:00:00.000Z',
          lastBelowAt: '2026-08-06T02:00:00.000Z',
        }),
      }),
      DURABLE_ENV,
    );
    // `ok` is TRUE — the disk is genuinely fine NOW, and claiming otherwise
    // would make the verdict unusable for the rest of its job.
    expect(r.ok).toBe(true);
    expect(r.disk?.belowThresholdSeen).toBe(true);
    expect(r.disk?.exhaustedSeen).toBe('inodes');
  });
});
