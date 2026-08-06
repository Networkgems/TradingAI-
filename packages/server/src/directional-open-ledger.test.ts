import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordDirectionalOpen,
  anySleeveOpensFor,
  directionalOpensFor,
  recordDirectionalGateReject,
  hydrateDirectionalOpensFromDisk,
  summarizeDirectionalGate,
  clearDirectionalOpenLedger,
  directionalOpenLogPath,
  recordDirectionalArm,
  summarizeDirectionalArm,
  armDispositionIsReachable,
  __setDirectionalArmBootId,
} from './directional-open-ledger.js';

// TRA-1486 D2 — the DURABLE per-name/ET-day open ledger that fixes the per-name-cap
// leak (the in-memory counter reset on every bqb1 reboot → the cap restarted at 0
// and never bit). Proves: write-through append, reboot-durable per-day counts via a
// hydrate, ET-day keying/rollover, retention-window compaction.
//
// TRA-1564 — two grade-blocking blindspots the re-grade fire hit:
//   B2 (sleeve conflation): the durable open write lived in the SHARED chokepoint, so
//       `openCountsBySymbol` + the directional cap read conflated all five open
//       sleeves. Records now carry a `sleeve` tag; `directionalOpensFor` is
//       directional-only (the cap + health view) while `anySleeveOpensFor` stays
//       cross-sleeve (the TRA-1408 churn brake).
//   B1 (non-durable rejects): the reject-by-code counters were in-memory since-boot,
//       so the post-close re-grade fire (after the daily reboot) always read `{}`.
//       They are now JSONL-backed + ET-day-keyed and hydrate on boot.

const ET_DAY = '2026-07-08';
const NOW = 1_751_990_000_000; // arbitrary fixed ms epoch (in the 2025-07 range)

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'directional-open-'));
  clearDirectionalOpenLedger();
});
afterEach(() => {
  clearDirectionalOpenLedger();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordDirectionalOpen / directionalOpensFor (TRA-1486 D2)', () => {
  it('counts per name and appends one JSONL line per open under DATA_DIR', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW); // configures dataDir
    recordDirectionalOpen('rivn', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 1);
    recordDirectionalOpen('spy', ET_DAY, 'directional', NOW + 2);

    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(2); // case-insensitive
    expect(directionalOpensFor('spy', ET_DAY)).toBe(1);
    expect(directionalOpensFor('nvda', ET_DAY)).toBe(0);

    const lines = readFileSync(directionalOpenLogPath(dir), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(3);
  });

  it('keys counts by ET day so a different day is independent', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', '2026-07-08', 'directional', NOW);
    recordDirectionalOpen('RIVN', '2026-07-08', 'directional', NOW + 1);
    recordDirectionalOpen('RIVN', '2026-07-09', 'directional', NOW + 2);
    expect(directionalOpensFor('RIVN', '2026-07-08')).toBe(2);
    expect(directionalOpensFor('RIVN', '2026-07-09')).toBe(1);
  });

  it('updates the in-memory count even with no dataDir (unit-test / CLI path)', () => {
    // no hydrate → dataDir null; the count still updates, only the write is skipped
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(1);
  });
});

describe('sleeve scoping — directional-only vs cross-sleeve (TRA-1564 B2)', () => {
  it('directionalOpensFor counts only `directional` opens; anySleeveOpensFor counts all', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    // NVDA: 1 directional + 2 non-directional (equity-swing / RV / OTM) opens.
    recordDirectionalOpen('NVDA', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('NVDA', ET_DAY, 'other', NOW + 1);
    recordDirectionalOpen('NVDA', ET_DAY, 'other', NOW + 2);

    // The directional cap read sees only the ONE directional open — a `count:3` on a
    // multi-sleeve name is no longer a false cap breach.
    expect(directionalOpensFor('NVDA', ET_DAY)).toBe(1);
    // The cross-sleeve churn brake still sees all three.
    expect(anySleeveOpensFor('NVDA', ET_DAY)).toBe(3);
  });

  it('defaults to `directional` when sleeve is omitted (back-compat with the record call)', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('SPY', ET_DAY);
    expect(directionalOpensFor('SPY', ET_DAY)).toBe(1);
    expect(anySleeveOpensFor('SPY', ET_DAY)).toBe(1);
  });

  it('the health view (summarize) is directional-only', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('QQQ', ET_DAY, 'other', NOW); // equity-swing, not directional
    recordDirectionalOpen('QQQ', ET_DAY, 'other', NOW + 1);
    recordDirectionalOpen('QQQ', ET_DAY, 'directional', NOW + 2);
    const s = summarizeDirectionalGate(ET_DAY);
    expect(s.openCountsBySymbol).toEqual([{ symbol: 'QQQ', count: 1 }]);
    expect(s.opensRecorded).toBe(1); // only the directional open
    expect(s.trackedSymbols).toBe(1);
  });
});

describe('hydrateDirectionalOpensFromDisk — reboot durability (TRA-1486 D2)', () => {
  it('rebuilds same-ET-day counts from disk after a "reboot"', () => {
    // session 1: three RIVN directional opens
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 1);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 2);

    // simulate reboot: in-memory dropped, then hydrate from the same file
    clearDirectionalOpenLedger();
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(0); // memory gone

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 3);
    expect(h.records).toBe(3);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(3); // restored → cap keeps biting
    expect(anySleeveOpensFor('RIVN', ET_DAY)).toBe(3);
  });

  it('rebuilds the sleeve split across a reboot', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('NVDA', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('NVDA', ET_DAY, 'other', NOW + 1);

    clearDirectionalOpenLedger();
    hydrateDirectionalOpensFromDisk(dir, NOW + 2);
    expect(directionalOpensFor('NVDA', ET_DAY)).toBe(1);
    expect(anySleeveOpensFor('NVDA', ET_DAY)).toBe(2);
  });

  it('treats a legacy untagged open line as `other` (never inflates the directional cap)', () => {
    const path = directionalOpenLogPath(dir);
    // A pre-TRA-1564 line: no `kind`, no `sleeve`.
    writeFileSync(path, JSON.stringify({ ts: NOW, etDay: ET_DAY, symbol: 'AMPG' }) + '\n', 'utf8');
    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 1);
    expect(h.records).toBe(1);
    expect(directionalOpensFor('AMPG', ET_DAY)).toBe(0); // NOT counted as directional
    expect(anySleeveOpensFor('AMPG', ET_DAY)).toBe(1);   // still counts cross-sleeve
  });

  it('drops records older than the retention window and COMPACTS the file', () => {
    const path = directionalOpenLogPath(dir);
    const stale = NOW - 10 * 24 * 60 * 60 * 1000; // 10 days ago — outside the window
    writeFileSync(
      path,
      [
        JSON.stringify({ kind: 'open', ts: stale, etDay: '2026-06-28', symbol: 'OLD', sleeve: 'directional' }),
        JSON.stringify({ kind: 'open', ts: NOW, etDay: ET_DAY, symbol: 'RIVN', sleeve: 'directional' }),
        JSON.stringify({ kind: 'open', ts: NOW + 1, etDay: ET_DAY, symbol: 'RIVN', sleeve: 'directional' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 2);
    expect(h.records).toBe(2); // stale line dropped
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(2);
    expect(directionalOpensFor('OLD', '2026-06-28')).toBe(0);

    // file was rewritten to just the retained lines
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('OLD'))).toBe(false);
  });

  it('is best-effort on a missing file (empty hydration, no throw)', () => {
    const h = hydrateDirectionalOpensFromDisk(dir, NOW);
    expect(h.records).toBe(0);
    expect(h.rejects).toBe(0);
    expect(h.days).toBe(0);
    expect(existsSync(directionalOpenLogPath(dir))).toBe(false);
  });

  it('skips a torn/partial trailing line rather than aborting', () => {
    const path = directionalOpenLogPath(dir);
    writeFileSync(
      path,
      JSON.stringify({ kind: 'open', ts: NOW, etDay: ET_DAY, symbol: 'RIVN', sleeve: 'directional' }) + '\n{ "ts": 12',
      'utf8',
    );
    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 1);
    expect(h.records).toBe(1);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(1);
  });
});

describe('durable reject telemetry (TRA-1564 B1)', () => {
  it('appends a JSONL line per reject and rebuilds per-ET-day counts across a reboot', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalGateReject('min_price', ET_DAY, NOW);
    recordDirectionalGateReject('min_price', ET_DAY, NOW + 1);
    recordDirectionalGateReject('insufficient_liquidity_samples', ET_DAY, NOW + 2);
    recordDirectionalGateReject('per_name_cap', ET_DAY, NOW + 3);

    // simulate the post-close reboot: memory dropped, then hydrate from the file
    clearDirectionalOpenLedger();
    let s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRejectedTotal).toBe(0); // memory gone

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 4);
    expect(h.rejects).toBe(4);
    s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRejectedByCode.min_price).toBe(2);
    expect(s.opensRejectedByCode.insufficient_liquidity_samples).toBe(1);
    expect(s.opensRejectedByCode.per_name_cap).toBe(1);
    expect(s.opensRejectedTotal).toBe(4); // survives the daily close reboot
  });

  it('keys rejects by ET day so the graded day is isolated', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalGateReject('min_price', '2026-07-08', NOW);
    recordDirectionalGateReject('min_price', '2026-07-09', NOW + 1);
    expect(summarizeDirectionalGate('2026-07-08').opensRejectedByCode.min_price).toBe(1);
    expect(summarizeDirectionalGate('2026-07-09').opensRejectedByCode.min_price).toBe(1);
    expect(summarizeDirectionalGate('2026-07-08').opensRejectedTotal).toBe(1);
  });

  it('updates the in-memory reject count even with no dataDir', () => {
    recordDirectionalGateReject('min_dollar_volume', ET_DAY, NOW);
    expect(summarizeDirectionalGate(ET_DAY).opensRejectedByCode.min_dollar_volume).toBe(1);
  });
});

describe('summarizeDirectionalGate (TRA-1486 / TRA-1564)', () => {
  it('folds directional-only per-name counts and per-ET-day reject codes', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 1);
    recordDirectionalOpen('SPY', ET_DAY, 'directional', NOW + 2);
    recordDirectionalOpen('SPY', ET_DAY, 'other', NOW + 3); // non-directional — excluded from the view
    recordDirectionalGateReject('min_price', ET_DAY, NOW + 4);
    recordDirectionalGateReject('min_price', ET_DAY, NOW + 5);
    recordDirectionalGateReject('insufficient_liquidity_samples', ET_DAY, NOW + 6);
    recordDirectionalGateReject('per_name_cap', ET_DAY, NOW + 7);

    const s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRecorded).toBe(3); // directional opens only
    expect(s.trackedSymbols).toBe(2);
    expect(s.openCountsBySymbol[0]).toEqual({ symbol: 'RIVN', count: 2 }); // busiest first
    expect(s.openCountsBySymbol).toContainEqual({ symbol: 'SPY', count: 1 }); // directional only
    expect(s.opensRejectedByCode.min_price).toBe(2);
    expect(s.opensRejectedByCode.insufficient_liquidity_samples).toBe(1);
    expect(s.opensRejectedByCode.per_name_cap).toBe(1);
    expect(s.opensRejectedTotal).toBe(4);
    expect(s.lastRejectAt).toBe(NOW + 7);
  });

  it('reports an empty per-name view for a day with no opens', () => {
    const s = summarizeDirectionalGate('2026-01-01');
    expect(s.openCountsBySymbol).toEqual([]);
    expect(s.trackedSymbols).toBe(0);
    expect(s.opensRejectedTotal).toBe(0);
  });
});

// ── TRA-3080 — retained ARM DISPOSITION ──────────────────────────────────────
//
// The desk's directional entries stopped after 2026-07-29 while the qa_*/ctoverify*
// fixture books kept firing on every session, and NO live instrument could say why.
// The cause sits UPSTREAM of every counter in this file: `evaluateDemoDirectional`
// opens its scan only after the arm gate, so a book the gate turns away leaves no
// scan, no reject and no open — byte-identical to a book that scanned and found
// nothing. The `admin` book had moved to `settings.mode: 'live'` for the live-OTM
// window, and live needs `ENABLE_OPTION_LIVE_DIRECTIONAL` (unset by design).
//
// These tests pin the three properties that make the new axis non-vacuous:
//   1. the three states are actually DISTINGUISHABLE (reachable / unreachable+reason
//      / absent) — an instrument that cannot separate them is the bug being fixed;
//   2. it survives the daily reboot AND outlives the 3-day open retention, because
//      the question it exists to answer is about LAST WEEK;
//   3. a re-flush inside one boot does not double-count, and a second boot on the
//      same ET day ADDS — the TRA-1486 D2 failure one axis over.

const ARM_DESK = {
  account: 'admin',
  accountClass: 'desk' as const,
  mode: 'live' as const,
  disposition: 'live_arm_off' as const,
};
const ARM_FIXTURE = {
  account: 'qa_reg_0710202220',
  accountClass: 'fixture' as const,
  mode: 'demo' as const,
  disposition: 'armed_demo' as const,
};

function cellFor(days: ReturnType<typeof summarizeDirectionalArm>, etDay: string, cls: string) {
  return days.find((d) => d.etDay === etDay)?.cells.find((c) => c.accountClass === cls);
}

describe('directional arm disposition — the TRA-3080 discriminator', () => {
  it('separates "unreachable, and why" from "reachable" on the SAME ET day', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_FIXTURE }, NOW + 1);

    const days = summarizeDirectionalArm();
    const desk = cellFor(days, ET_DAY, 'desk')!;
    const fixture = cellFor(days, ET_DAY, 'fixture')!;

    // The desk answer: the pass was UNREACHABLE, and the reason is named.
    expect(desk.reachable).toBe(false);
    expect(desk.disposition).toBe('live_arm_off');
    expect(desk.mode).toBe('live');
    // The positive control on the same day, same route, sibling class.
    expect(fixture.reachable).toBe(true);
    expect(fixture.disposition).toBe('armed_demo');

    // Without this the two would be indistinguishable — that IS the defect.
    expect(desk.reachable).not.toBe(fixture.reachable);
  });

  it('leaves NO cell for a class that never ticked — a third state, not "off"', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_FIXTURE }, NOW);

    const days = summarizeDirectionalArm();
    expect(cellFor(days, ET_DAY, 'fixture')).toBeDefined();
    // Absent is not disarmed. A reader must not be able to confuse the two.
    expect(cellFor(days, ET_DAY, 'desk')).toBeUndefined();
  });

  it('every disposition is REACHABLE and classified — no dead arm of the predicate', () => {
    const all = [
      ['armed_demo', true],
      ['armed_live', true],
      ['demo_flag_off', false],
      ['live_arm_off', false],
      ['no_scanner', false],
    ] as const;
    hydrateDirectionalOpensFromDisk(dir, NOW);
    all.forEach(([d, reachable], i) => {
      expect(armDispositionIsReachable(d)).toBe(reachable);
      recordDirectionalArm(
        {
          etDay: ET_DAY,
          account: `book_${i}`,
          accountClass: 'desk',
          mode: d === 'armed_live' || d === 'live_arm_off' ? 'live' : 'demo',
          disposition: d,
        },
        NOW + i,
      );
    });
    const cells = summarizeDirectionalArm().find((x) => x.etDay === ET_DAY)!.cells;
    expect(new Set(cells.map((c) => c.disposition)).size).toBe(all.length);
  });

  it('attributes distinct BOOKS, so one noisy engine cannot stand in for a class', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + 1); // same book again
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK, account: 'Richard' }, NOW + 2);

    const desk = cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!;
    expect(desk.books).toBe(2); // admin + Richard, not 3 ticks
    expect(desk.ticks).toBe(3);
  });
});

describe('directional arm disposition — durability across reboots (TRA-3080)', () => {
  it('survives a reboot and SUMS ticks across boots on the same ET day', () => {
    const SIX_MIN = 6 * 60 * 1000;
    __setDirectionalArmBootId('boot-A');
    hydrateDirectionalOpensFromDisk(dir, NOW);
    // Spaced past the flush throttle so both ticks are actually on disk — see the
    // lower-bound test below for what happens when they are not.
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + SIX_MIN);
    expect(cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!.ticks).toBe(2);

    // reboot
    clearDirectionalOpenLedger();
    expect(summarizeDirectionalArm()).toEqual([]);
    __setDirectionalArmBootId('boot-B');
    hydrateDirectionalOpensFromDisk(dir, NOW + SIX_MIN + 1);

    // boot A's 2 ticks came back off disk...
    expect(cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!.ticks).toBe(2);
    // ...and boot B ADDS rather than resetting (the TRA-1486 D2 failure mode).
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + SIX_MIN + 2);
    const desk = cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!;
    expect(desk.ticks).toBe(3);
    expect(desk.boots).toBe(2);
  });

  it('reports ticks as a LOWER BOUND — an unflushed tail is lost, the DISPOSITION is not', () => {
    // The documented cost of throttling the append: ticks inside the 5-minute window
    // that had not been flushed when the process died are not on disk. This test
    // exists so that behaviour is a pinned contract rather than a surprise to whoever
    // next tries to build a criterion on an exact count.
    __setDirectionalArmBootId('boot-A');
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + 1); // inside the throttle
    expect(cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!.ticks).toBe(2); // in memory

    clearDirectionalOpenLedger();
    __setDirectionalArmBootId('boot-B');
    hydrateDirectionalOpensFromDisk(dir, NOW + 2);

    const desk = cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!;
    expect(desk.ticks).toBe(1); // the unflushed 2nd tick did not survive
    expect(desk.ticks).toBeGreaterThan(0); // ...but it is a floor, never zero
    // The fields the TRA-3080 answer actually rests on are exact from tick one.
    expect(desk.disposition).toBe('live_arm_off');
    expect(desk.reachable).toBe(false);
    expect(desk.accountClass).toBe('desk');
    expect(desk.firstAt).toBe(NOW);
  });

  it('does NOT double-count a throttled re-flush inside one boot', () => {
    __setDirectionalArmBootId('boot-A');
    hydrateDirectionalOpensFromDisk(dir, NOW);
    // First tick writes; then push past the 5-min throttle so a SECOND line lands
    // for the same (key, bootId) carrying the cumulative count.
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + 6 * 60 * 1000);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + 12 * 60 * 1000);

    const lines = readFileSync(directionalOpenLogPath(dir), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(1); // a re-flush really did happen

    clearDirectionalOpenLedger();
    __setDirectionalArmBootId('boot-B');
    hydrateDirectionalOpensFromDisk(dir, NOW + 13 * 60 * 1000);
    // 3 ticks, not 1+2+3 = 6. Last line wins WITHIN a boot.
    expect(cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!.ticks).toBe(3);
  });

  it('compacts superseded re-flushes to ONE line per (key, boot)', () => {
    __setDirectionalArmBootId('boot-A');
    hydrateDirectionalOpensFromDisk(dir, NOW);
    for (let i = 0; i < 4; i += 1) {
      recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW + i * 6 * 60 * 1000);
    }
    clearDirectionalOpenLedger();
    __setDirectionalArmBootId('boot-B');
    hydrateDirectionalOpensFromDisk(dir, NOW + 25 * 60 * 1000);

    const armLines = readFileSync(directionalOpenLogPath(dir), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'arm');
    expect(armLines).toHaveLength(1);
    expect(armLines[0].ticks).toBe(4);
  });

  it('OUTLIVES the 3-day open retention — it must answer about LAST WEEK', () => {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    __setDirectionalArmBootId('boot-A');
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);

    clearDirectionalOpenLedger();
    __setDirectionalArmBootId('boot-B');
    const h = hydrateDirectionalOpensFromDisk(dir, NOW + SEVEN_DAYS);

    // The open aged out of its 3-day window...
    expect(h.records).toBe(0);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(0);
    // ...while the arm record — the whole point — is still readable.
    expect(cellFor(summarizeDirectionalArm(), ET_DAY, 'desk')!.disposition).toBe('live_arm_off');
  });

  it('drops an arm record past the 30-day window (the retention is real, not nominal)', () => {
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
    __setDirectionalArmBootId('boot-A');
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalArm({ etDay: ET_DAY, ...ARM_DESK }, NOW);

    clearDirectionalOpenLedger();
    __setDirectionalArmBootId('boot-B');
    hydrateDirectionalOpensFromDisk(dir, NOW + THIRTY_ONE_DAYS);
    expect(summarizeDirectionalArm()).toEqual([]);
  });

  it('skips a torn/invalid arm line rather than aborting the hydrate', () => {
    const path = directionalOpenLogPath(dir);
    const base = {
      kind: 'arm',
      ts: NOW,
      etDay: ET_DAY,
      account: 'admin',
      accountClass: 'desk',
      mode: 'live',
      disposition: 'live_arm_off',
      bootId: 'x',
      ticks: 5,
    };
    writeFileSync(
      path,
      [
        JSON.stringify({ ...base, disposition: 'not_a_disposition' }),
        JSON.stringify({ ...base, account: '' }),
        JSON.stringify({ ...base, firstAt: NOW - 10 }),
        '{ torn',
      ].join('\n') + '\n',
      'utf8',
    );
    hydrateDirectionalOpensFromDisk(dir, NOW + 1);
    const cells = summarizeDirectionalArm().find((d) => d.etDay === ET_DAY)!.cells;
    expect(cells).toHaveLength(1);
    expect(cells[0].ticks).toBe(5);
    expect(cells[0].firstAt).toBe(NOW - 10);
  });
});
