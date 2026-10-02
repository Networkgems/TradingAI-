// TRA-5020 — `oneShotCostBarGrant.counterProvenance`: which fields on the grant
// block survive a restart.
//
// The defect being closed is an INSTRUMENT that reads identically in pass and
// fail: `commits: 0` (since-boot, zeroed by every one of bqb1's ~6 daily reboots)
// rendered beside `committed: {}` (durable) with nothing distinguishing them, so
// a post-reboot read of "the grant was never spent" and a read that knows
// NOTHING were byte-identical.
//
// The hazard direction on every assertion here is therefore THE SAFE-LOOKING
// VALUE: a state the route could not measure must never render as proven. The
// happy path alone would rebuild the defect one layer up, so the fail states —
// ephemeral dir, torn file, unsupplied boot stamp, spend-without-durable-write —
// are each demonstrated against a REAL read of REAL on-disk state below.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LIVE_OTM_ONESHOT_GRANT_VAR,
  consultLiveOtmOneShotGrant,
  commitLiveOtmOneShotGrant,
  getLiveOtmOneShotGrantState,
  __resetLiveOtmOneShotGrantForTest,
} from './live-otm-oneshot-grant.js';

const IN_WINDOW = Date.parse('2026-09-25T15:00:00Z');
const BOOT = '2026-10-02T12:51:47.439Z';
const COMMIT_FILE = 'live-otm-oneshot-grant-committed.json';

function specJson(): string {
  return JSON.stringify({
    card: '6b82a9e7',
    books: ['admin', 'v0nni'],
    maxPerContractUsd: 300,
    validFromIso: '2026-09-25T13:45:00Z',
    validUntilIso: '2026-09-25T19:30:00Z',
  });
}

/** A durable dir: real path, none of the TRA-4896 ephemeral markers. */
let dir: string;
const env = () => ({ [LIVE_OTM_ONESHOT_GRANT_VAR]: specJson() });
const read = (startedAt: string | null = BOOT) =>
  getLiveOtmOneShotGrantState(env(), IN_WINDOW, { processStartedAt: startedAt });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra5020-grant-'));
  __resetLiveOtmOneShotGrantForTest({ dataDir: dir });
});
afterEach(() => {
  __resetLiveOtmOneShotGrantForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-5020 — the two counter classes are labelled, not left to the reader', () => {
  it('names the SINCE-BOOT fields and the DURABLE fields explicitly, per field', () => {
    const p = read().counterProvenance;
    expect(p.issue).toBe('TRA-5020');
    // Must NOT be readable as the TRA-4879 `top_level` label, whose `covers`
    // names `decisionsRecorded`/`byGate` and has never extended to this block.
    expect(p.scope).toBe('one_shot_cost_bar_grant');
    for (const f of ['consults', 'grants', 'commits', 'refusalsByReason']) {
      expect(p.covers.sinceBoot).toContain(f);
    }
    expect(p.covers.sinceBoot).toContain('ZEROED BY EVERY RESTART');
    expect(p.covers.durable).toContain('committed');
    expect(p.covers.durable).toContain('stateUnreadable');
    // The since-boot class is STRUCTURAL (a module-level const), not measured.
    expect(p.talliesSinceBoot).toBe(true);
    expect(p.talliesSinceIso).toBe(BOOT);
    expect(p.talliesSinceStamped).toBe(true);
    expect(p.note).toContain('MUST NOT be cited as a cross-boot zero');
  });

  it('⭐ THE HEADLINE CELL: across a restart the durable witness survives while the tally resets to 0', () => {
    consultLiveOtmOneShotGrant(env(), 'admin', 250, IN_WINDOW);
    expect(commitLiveOtmOneShotGrant('admin', 'SOUN261016C00010000', IN_WINDOW)).toBe(true);

    const before = read();
    expect(before.commitsSinceBoot).toBe(1);
    expect(before.commitsDurable).toBe(1);

    // Restart: same DATA_DIR, fresh module state — exactly a bqb1 reboot.
    __resetLiveOtmOneShotGrantForTest({ dataDir: dir });
    const after = read();

    // The pre-TRA-5020 field reads ZERO and is evidence about nothing...
    expect(after.commits).toBe(0);
    expect(after.commitsSinceBoot).toBe(0);
    // ...while the durable count still names the spend. These two numbers
    // disagreeing IS the fact the block previously could not express.
    expect(after.commitsDurable).toBe(1);
    expect(Object.keys(after.committed)).toEqual(['admin']);
    const p = after.counterProvenance;
    expect(p.committedLoadedAtBoot).toBe(true);
    expect(p.hydrateOutcome).toBe('loaded');
    expect(p.hydratedBooks).toBe(1);
    expect(p.verdict).toBe('tallies_boot_scoped_committed_durable');
    expect(p.note).toContain('hydrated 1 committed row');
  });

  it('`commits` keeps its original name AND its original since-boot value', () => {
    consultLiveOtmOneShotGrant(env(), 'admin', 250, IN_WINDOW);
    commitLiveOtmOneShotGrant('admin', 'SOUN261016C00010000', IN_WINDOW);
    const s = read();
    // A silent re-point of `commits` to the durable integer would be the same
    // class of defect: identical rendering, different meaning.
    expect(s.commits).toBe(1);
    expect(s.commits).toBe(s.commitsSinceBoot);
  });
});

describe('TRA-5020 — an UNKNOWN never renders as the safe value', () => {
  it('FAIL STATE: a cold start with NO commit file is not "loaded" and not proven', () => {
    const p = read().counterProvenance;
    // The dir is durable, so `committed: {}` is a real "no book has spent" —
    // but NOTHING was read, and the label must say so rather than imply a
    // hydrated record.
    expect(p.hydrateOutcome).toBe('file_absent');
    expect(p.commitFileFound).toBe(false);
    expect(p.committedLoadedAtBoot).toBe(false);
    expect(p.hydratedBooks).toBe(0);
    expect(p.committedDurable).toBe(true);
    expect(p.note).toContain('it is an ABSENCE, not a hydrated record');
  });

  it('FAIL STATE: a torn commit file reads UNREADABLE, commitsDurable null (never 0)', () => {
    writeFileSync(join(dir, COMMIT_FILE), JSON.stringify({ committed: { admin: { atIso: 1 } } }), 'utf8');
    __resetLiveOtmOneShotGrantForTest({ dataDir: dir });
    const s = read();

    expect(s.stateUnreadable).toBe(true);
    // ⛔ The whole constraint: a file we could not trust must not render a 0
    // that reads as "no spend". `null` is not a count.
    expect(s.commitsDurable).toBeNull();
    const p = s.counterProvenance;
    expect(p.commitsDurable).toBeNull();
    expect(p.committedLoadedAtBoot).toBe(false);
    expect(p.commitFileFound).toBe(true);
    expect(p.hydrateOutcome).toBe('unreadable');
    expect(p.verdict).toBe('tallies_boot_scoped_committed_unreadable');
    expect(p.note).toContain('PARTIAL prefix of a torn file');
  });

  it('FAIL STATE: unparseable JSON reads UNREADABLE too (not an empty record)', () => {
    writeFileSync(join(dir, COMMIT_FILE), '{not json', 'utf8');
    __resetLiveOtmOneShotGrantForTest({ dataDir: dir });
    const p = read().counterProvenance;
    expect(p.hydrateOutcome).toBe('unreadable');
    expect(p.verdict).toBe('tallies_boot_scoped_committed_unreadable');
    expect(p.commitsDurable).toBeNull();
  });

  it('FAIL STATE: an EPHEMERAL dir makes `committed` boot-scoped too — no cross-boot witness at all', () => {
    // A DATA_DIR inside the build bundle: every IO check passes and the bytes
    // evaporate on the next redeploy with no error to catch (TRA-4896).
    const bundle = join(dir, 'packages', 'server', 'data');
    mkdirSync(bundle, { recursive: true });
    __resetLiveOtmOneShotGrantForTest({ dataDir: bundle });

    const p = read().counterProvenance;
    expect(p.committedDurable).toBe(false);
    expect(p.committedEphemeralReason).toBe('in_build_bundle');
    expect(p.verdict).toBe('tallies_boot_scoped_committed_ephemeral');
    expect(p.covers.durable).toContain('BUT THE DIR IS EPHEMERAL');
    expect(p.note).toContain('does not mean the shot is unspent');
  });

  it('FAIL STATE: no boot stamp ⇒ the span has no left edge, and it is NOT back-filled', () => {
    const p = read(null).counterProvenance;
    expect(p.talliesSinceIso).toBeNull();
    expect(p.talliesSinceStamped).toBe(false);
    // Still structurally since-boot — only the instant is unknown.
    expect(p.talliesSinceBoot).toBe(true);
    expect(p.covers.sinceBoot).toContain('start instant UNKNOWN');
    expect(p.note).toContain('do not substitute the read time');
  });

  it('FAIL STATE: a spend whose durable write FAILED is counted, not silently dropped', () => {
    // Make the dir unwritable in a cross-platform way: its parent is a FILE, so
    // `mkdirSync(dir, {recursive:true})` inside `persistCommitted` throws.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    __resetLiveOtmOneShotGrantForTest({ dataDir: join(blocker, 'nested') });

    expect(consultLiveOtmOneShotGrant(env(), 'admin', 250, IN_WINDOW).granted).toBe(true);
    // The shot is BURNED — the position would be real — and the write failed.
    expect(commitLiveOtmOneShotGrant('admin', 'SOUN261016C00010000', IN_WINDOW)).toBe(false);

    const s = read();
    const p = s.counterProvenance;
    // Pre-TRA-5020 this incremented nothing: it read exactly like a book that
    // never consulted.
    expect(p.commitsFailedDurableSinceBoot).toBe(1);
    expect(p.spentWithoutDurableRecord).toBe(true);
    expect(s.commitsSinceBoot).toBe(0);
    expect(p.commitsDurable).toBeNull();
    expect(s.stateUnreadable).toBe(true);
    expect(p.verdict).toBe('tallies_boot_scoped_committed_unreadable');
    expect(p.note).toContain('FAILED their durable write');
  });

  it('the healthy verdict is reachable — so the fail assertions above are discriminating', () => {
    // Negative control for the whole block: if `durable` were unreachable the
    // tests above would pass against a function that always refuses.
    expect(read().counterProvenance.verdict).toBe('tallies_boot_scoped_committed_durable');
    expect(read().counterProvenance.committedEphemeralReason).toBeNull();
  });
});
