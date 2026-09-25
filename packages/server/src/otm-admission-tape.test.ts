// TRA-4628 — the OTM candidate-admission tape: append-only rows for admitted
// AND refused scanner candidates, pass-level quote-independent sampling, and
// the boot hydrate/compaction that makes 20+ sessions survivable on bqb1.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OtmAdmissionDecision } from '@trading-app/engine';
import {
  beginOtmAdmissionPass,
  clearOtmAdmissionTape,
  hydrateOtmAdmissionTapeFromDisk,
  otmAdmissionSlot,
  otmAdmissionSlotSelected,
  otmAdmissionTapePath,
  readOtmAdmissionTapeRows,
  recordOtmAdmissionOrdered,
  recordOtmAdmissionRanked,
  summarizeOtmAdmissionTape,
} from './otm-admission-tape.js';

const NOW = Date.parse('2026-09-16T15:00:00Z'); // 11:00 ET, a Wednesday RTH session

function decision(overrides: Partial<OtmAdmissionDecision> = {}): OtmAdmissionDecision {
  return {
    occSymbol: 'RIG261016C00005000',
    underlying: 'RIG',
    right: 'call',
    strike: 5,
    expiry: '2026-10-16',
    bid: 0.1,
    ask: 0.12,
    mark: 0.11,
    spreadPct: 0.02 / 0.11,
    openInterest: 500,
    admitted: true,
    bindingReason: 'none',
    ...overrides,
  };
}

/** First symbol the v2 slot sampler selects (or rejects) for `book` at `now`. */
function selectedSymbol(book: string, now: number, accountClass = 'desk', want = true): string {
  const slot = otmAdmissionSlot(now);
  const etDay = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (let i = 0; i < 10_000; i += 1) {
    const sym = `T${i}`;
    if (otmAdmissionSlotSelected(book, sym, etDay, slot, accountClass) === want) return sym;
  }
  throw new Error('no symbol found');
}
const SEL = selectedSymbol('deskbook', NOW);
const UNSEL = selectedSymbol('deskbook', NOW, 'desk', false);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra4628-'));
  hydrateOtmAdmissionTapeFromDisk(dir, NOW);
});

afterEach(() => {
  clearOtmAdmissionTape();
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-4628 — pass recording', () => {
  it('commits admitted AND refused rows to disk with accountClass and bindingReason', () => {
    const pass = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    expect(pass).not.toBeNull();
    pass!.onAdmission(decision());
    pass!.onAdmission(
      decision({ occSymbol: 'RIG261016C00009000', mark: 0.03, admitted: false, bindingReason: 'min_mark' }),
    );
    pass!.commit();

    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    const rows = raw.map((l) => JSON.parse(l));
    expect(rows[0].kind).toBe('candidate');
    expect(rows[0].accountClass).toBe('desk');
    expect(rows[0].admitted).toBe(true);
    expect(rows[1].bindingReason).toBe('min_mark');
    expect(rows[1].admitted).toBe(false);
    // No username on disk — the class is stored, never the book string.
    expect(raw[0]).not.toContain('deskbook');

    const summary = summarizeOtmAdmissionTape();
    const desk = summary.byClass.find((c) => c.accountClass === 'desk');
    expect(desk?.candidateRows).toBe(2);
    expect(desk?.admitted).toBe(1);
    expect(desk?.sessionsWithAdmissions).toBe(1);
    expect(summary.deskSessionsWithAdmissions).toBe(1);
  });

  it('records at most one pass per symbol×book per ET slot; an unselected pair is never taped', () => {
    const p1 = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    p1!.onAdmission(decision());
    p1!.commit();

    expect(
      beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW + 60_000 }),
    ).toBeNull();
    expect(
      beginOtmAdmissionPass({ symbol: UNSEL, book: 'deskbook', mode: 'live', now: NOW + 60_000 }),
    ).toBeNull();
    expect(summarizeOtmAdmissionTape().counters.unsampledPasses).toBe(2);
  });

  it('an abandoned pass (no commit) does not consume the slot', () => {
    beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    // no commit — breaker / no-chain shape
    expect(
      beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW + 1000 }),
    ).not.toBeNull();
  });

  it('selection is a pure function of identity and clock — the quote cannot move it', () => {
    const slot = otmAdmissionSlot(NOW);
    const a = otmAdmissionSlotSelected('deskbook', SEL, '2026-09-16', slot, 'desk');
    const b = otmAdmissionSlotSelected('deskbook', UNSEL, '2026-09-16', slot, 'desk');
    expect(a).toBe(true);
    expect(b).toBe(false);
    // The begin call never sees a quote: a cheap-and-wide and a rich-and-tight
    // chain for the same pair are both taped (or both not) in the same slot.
    for (const d of [decision({ mark: 0.03, spreadPct: 1.5 }), decision({ mark: 4.2, spreadPct: 0.02 })]) {
      clearOtmAdmissionTape();
      hydrateOtmAdmissionTapeFromDisk(dir, NOW);
      const p = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
      expect(p).not.toBeNull();
      p!.onAdmission(d);
      p!.commit();
    }
  });
});

describe('TRA-4628 — v2 time coverage (the 2026-09-18 open-bias regression)', () => {
  it('a full desk RTH session spreads over the day instead of exhausting at the open', () => {
    // The 2026-09-18 desk shape: 192 symbols, ~31 decisions per pass, one
    // universe cycle ≈ 45 min. v1 filled its 6000-row DAILY budget by 10:17 ET.
    const open = Date.parse('2026-09-16T13:30:00Z'); // 09:30 ET
    const close = Date.parse('2026-09-16T20:00:00Z'); // 16:00 ET
    const cycleMs = 45 * 60 * 1000;
    const symbols = Array.from({ length: 192 }, (_, i) => `S${i}`);
    for (let start = open; start < close; start += cycleMs) {
      symbols.forEach((sym, i) => {
        const now = start + Math.floor((i * cycleMs) / symbols.length);
        if (now >= close) return;
        const p = beginOtmAdmissionPass({ symbol: sym, book: 'deskbook', mode: 'live', now });
        if (!p) return;
        for (let k = 0; k < 31; k += 1) {
          p.onAdmission(decision({ underlying: sym, occSymbol: `${sym}-${k}`, admitted: k % 5 === 0, bindingReason: k % 5 === 0 ? 'none' : 'max_spread_pct' }));
        }
        p.commit();
      });
    }
    const summary = summarizeOtmAdmissionTape();
    const day = summary.byClass.find((c) => c.accountClass === 'desk')!.days[0];
    const rthSlots = Object.keys(day.rowsBySlotEt ?? {}).filter((s) => s >= '09:30' && s < '16:00');
    expect(rthSlots.length).toBe(13); // every half-hour of the session is represented
    expect(summary.counters.slotBudgetPassesDropped).toBe(0);
    // Late-session coverage is not a sliver: the post-14:00 ET half holds a real share.
    const late = Object.entries(day.rowsBySlotEt ?? {})
      .filter(([s]) => s >= '14:00')
      .reduce((n, [, v]) => n + v, 0);
    expect(late / day.candidateRows).toBeGreaterThan(0.2);
    // Volume stays inside the byte plan (~1/12 of the unsampled ~53k rows).
    expect(day.candidateRows).toBeGreaterThan(2000);
    expect(day.candidateRows).toBeLessThan(8000);
    expect(summary.deskSessionsWithAdmissions).toBe(1);
  });

  it('v1 rows (no samplingPolicy) hydrate as legacy and never count toward AC4', () => {
    const v1 = {
      kind: 'candidate', ts: NOW, etDay: '2026-09-16', accountClass: 'desk', mode: 'live',
      underlying: 'RIG', occSymbol: 'RIG261016C00005000', expiry: '2026-10-16', strike: 5, right: 'call',
      bid: 0.1, ask: 0.12, mark: 0.11, spreadPct: 0.18, openInterest: 500, admitted: true, bindingReason: 'none',
    };
    writeFileSync(otmAdmissionTapePath(dir), JSON.stringify(v1) + '\n', 'utf8');
    hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    const summary = summarizeOtmAdmissionTape();
    const desk = summary.byClass.find((c) => c.accountClass === 'desk')!;
    expect(summary.deskSessionsWithAdmissions).toBe(0);
    expect(desk.legacySessions).toBe(1);
    expect(desk.days[0].legacyRows).toBe(1);
    expect(desk.days[0].passesRecorded).toBe(1); // rebuilt on hydrate
  });

  it('drops an oversized pass WHOLE — no partial truncation reaches disk', () => {
    const pass = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    for (let i = 0; i < 450; i += 1) {
      pass!.onAdmission(decision({ occSymbol: `RIG${i}`, strike: i }));
    }
    pass!.commit();
    expect(() => readFileSync(otmAdmissionTapePath(dir), 'utf8')).toThrow(); // nothing written
    expect(summarizeOtmAdmissionTape().counters.oversizedPassesDropped).toBe(1);
  });

  it('classifies a null book as unattributed, never desk', () => {
    const pass = beginOtmAdmissionPass({ symbol: selectedSymbol('', NOW, 'unattributed'), book: null, mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.commit();
    const summary = summarizeOtmAdmissionTape();
    expect(summary.byClass.map((c) => c.accountClass)).toEqual(['unattributed']);
    expect(summary.deskSessionsWithAdmissions).toBe(0);
  });
});

describe('TRA-4628 — ranked/ordered links', () => {
  it('records links and tallies them per class', () => {
    recordOtmAdmissionRanked({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW }, 'RIG261016C00005000');
    recordOtmAdmissionOrdered({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW + 1 }, 'RIG261016C00005000');
    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw.map((l) => JSON.parse(l).kind)).toEqual(['ranked', 'ordered']);
    const desk = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk');
    expect(desk?.ranked).toBe(1);
    expect(desk?.ordered).toBe(1);
  });
});

// ── TRA-4906 (ruling TRA-4905) ───────────────────────────────────────────────

/** A pass sized to blow the non-desk slot budget (200) in one go: 250 > 200. */
function oversizedForFixtureSlot(now: number): { symbol: string; book: string } {
  return { symbol: selectedSymbol('qa_tape', now, 'fixture'), book: 'qa_tape' };
}

/** Run one `rows`-decision pass for a fixture book, returning whether it taped. */
function fixturePass(now: number, rows: number, symbol: string, book: string): void {
  const p = beginOtmAdmissionPass({ symbol, book, mode: 'demo', now });
  if (!p) throw new Error('pass was not selected — fix the fixture');
  for (let i = 0; i < rows; i += 1) {
    p.onAdmission(decision({ underlying: symbol, occSymbol: `${symbol}-${i}` }));
  }
  p.commit();
}

describe('TRA-4906 — slot-budget drops are DURABLE and per-slot (AC1/AC2)', () => {
  it('writes a budgetdrop row carrying the slot and the dropped pass size', () => {
    const { symbol, book } = oversizedForFixtureSlot(NOW);
    fixturePass(NOW, 250, symbol, book); // 250 > MAX_ROWS_PER_SLOT_OTHER (200)

    const rows = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1); // the pass itself is dropped WHOLE — only the drop row lands
    expect(rows[0]).toMatchObject({
      kind: 'budgetdrop',
      ts: NOW,
      etDay: '2026-09-16',
      accountClass: 'fixture',
      slot: otmAdmissionSlot(NOW),
      underlying: symbol,
      rows: 250,
    });

    const summary = summarizeOtmAdmissionTape();
    const day = summary.byClass.find((c) => c.accountClass === 'fixture')!.days[0]!;
    expect(day.dropsBySlotEt).toEqual({ '11:00': { passes: 1, rows: 250 } });
    expect(summary.counters.slotBudgetPassesDropped).toBe(1); // the scalar is KEPT (AC: not removed)
  });

  it('dropsBySlotEt SURVIVES A BOOT — the whole point (AC1)', () => {
    const { symbol, book } = oversizedForFixtureSlot(NOW);
    fixturePass(NOW, 250, symbol, book);
    // A second drop in a LATER slot, so the rebuild has to be per-slot, not a total.
    const later = NOW + 90 * 60 * 1000; // 12:30 ET
    const s2 = selectedSymbol('qa_tape', later, 'fixture');
    fixturePass(later, 210, s2, book);

    // Boot: fresh process state, aggregates rebuilt from disk alone.
    clearOtmAdmissionTape();
    const h = hydrateOtmAdmissionTapeFromDisk(dir, NOW + 2 * 60 * 60 * 1000);
    expect(h.records).toBe(2); // both drop rows round-tripped through parseRow (AC2)

    const summary = summarizeOtmAdmissionTape();
    const day = summary.byClass.find((c) => c.accountClass === 'fixture')!.days[0]!;
    expect(day.dropsBySlotEt).toEqual({
      '11:00': { passes: 1, rows: 250 },
      '12:30': { passes: 1, rows: 210 },
    });
    // The process-total scalar is exactly what a boot DESTROYS — that is why the
    // rows exist. Its reading 0 here while dropsBySlotEt is intact IS the AC.
    expect(summary.counters.slotBudgetPassesDropped).toBe(0);
  });

  it('a budgetdrop row is NOT SAMPLE — it enters no other count (AC2)', () => {
    const { symbol, book } = oversizedForFixtureSlot(NOW);
    fixturePass(NOW, 250, symbol, book);
    clearOtmAdmissionTape();
    hydrateOtmAdmissionTapeFromDisk(dir, NOW);

    const summary = summarizeOtmAdmissionTape();
    const fixture = summary.byClass.find((c) => c.accountClass === 'fixture')!;
    expect(fixture.candidateRows).toBe(0);
    expect(fixture.admitted).toBe(0);
    expect(fixture.ranked).toBe(0);
    expect(fixture.ordered).toBe(0);
    expect(fixture.sessionsWithAdmissions).toBe(0);
    expect(fixture.legacySessions).toBe(0); // nor does it read as a v1 admitted day
    expect(summary.deskSessionsWithAdmissions).toBe(0);
    const day = fixture.days[0]!;
    expect(day.candidateRows).toBe(0);
    expect(day.passesRecorded).toBe(0); // a dropped pass is not a RECORDED pass
    expect(day.rowsBySlotEt).toEqual({}); // and never feeds the rule-3 budget denominator
  });

  it('accepts a budgetdrop row with no `rows` field, and rejects one with no slot', () => {
    const noRows = { kind: 'budgetdrop', ts: NOW, etDay: '2026-09-16', accountClass: 'desk', slot: 22, underlying: 'SPY' };
    const noSlot = { kind: 'budgetdrop', ts: NOW, etDay: '2026-09-16', accountClass: 'desk', underlying: 'SPY', rows: 300 };
    writeFileSync(otmAdmissionTapePath(dir), `${JSON.stringify(noRows)}\n${JSON.stringify(noSlot)}\n`, 'utf8');
    hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    const day = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk')!.days[0]!;
    // The PASS still counts — losing it would understate rule 3's bite.
    expect(day.dropsBySlotEt).toEqual({ '11:00': { passes: 1, rows: 0 } });
  });
});

describe('TRA-4906 — `ranked` dedup, `ordered` unconditional (AC3/AC4)', () => {
  const ctx = { symbol: 'XLF', book: 'deskbook', mode: 'live' as const };

  it('collapses repeat nominations of one contract within a slot to ONE row (AC3)', () => {
    // The measured live shape: XLF261030C00056000 written 87 times in a session.
    for (let i = 0; i < 87; i += 1) {
      recordOtmAdmissionRanked({ ...ctx, now: NOW + i * 1000 }, 'XLF261030C00056000');
    }
    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    const summary = summarizeOtmAdmissionTape();
    expect(summary.byClass.find((c) => c.accountClass === 'desk')!.ranked).toBe(1);
    expect(summary.counters.rankedDuplicatesSkipped).toBe(86);
  });

  it('keys on (etDay, slot, accountClass, occSymbol) — each axis re-admits', () => {
    const OCC = 'XLF261030C00056000';
    recordOtmAdmissionRanked({ ...ctx, now: NOW }, OCC);
    recordOtmAdmissionRanked({ ...ctx, now: NOW + 30 * 60 * 1000 }, OCC); // next slot
    recordOtmAdmissionRanked({ ...ctx, now: NOW, book: 'qa_tape' }, OCC); // other class
    recordOtmAdmissionRanked({ ...ctx, now: NOW }, 'XLF261030C00057000'); // other contract
    recordOtmAdmissionRanked({ ...ctx, now: NOW }, OCC); // duplicate of the first
    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(4);
    expect(summarizeOtmAdmissionTape().counters.rankedDuplicatesSkipped).toBe(1);

    // A NEW ET day re-admits (and the set evicts the old day, staying bounded).
    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    recordOtmAdmissionRanked({ ...ctx, now: tomorrow }, OCC);
    expect(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('rebuilds the dedup set on hydrate — a boot does not re-admit a banked link', () => {
    recordOtmAdmissionRanked({ ...ctx, now: NOW }, 'XLF261030C00056000');
    clearOtmAdmissionTape();
    hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    recordOtmAdmissionRanked({ ...ctx, now: NOW + 5000 }, 'XLF261030C00056000');
    expect(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(summarizeOtmAdmissionTape().counters.rankedDuplicatesSkipped).toBe(1);
  });

  it('🔴 `ordered` is UNCONDITIONAL — no dedup, no budget, ever (AC4)', () => {
    for (let i = 0; i < 50; i += 1) {
      recordOtmAdmissionOrdered({ ...ctx, now: NOW + i * 1000 }, 'XLF261030C00056000');
    }
    const raw = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(50); // every single one — execution provenance
    expect(raw.every((l) => JSON.parse(l).kind === 'ordered')).toBe(true);
    expect(summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk')!.ordered).toBe(50);
    // Deduping `ranked` must not have leaked onto the `ordered` path.
    expect(summarizeOtmAdmissionTape().counters.rankedDuplicatesSkipped).toBe(0);
  });

  it('the dedup is quote-blind — the key holds no quote and no scan order', () => {
    // Same contract, wildly different quotes: still one row. The sample's
    // independence from mark/spreadPct is the load-bearing property here.
    recordOtmAdmissionRanked({ ...ctx, now: NOW }, 'XLF261030C00056000');
    recordOtmAdmissionRanked({ ...ctx, now: NOW + 1 }, 'XLF261030C00056000');
    expect(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('TRA-4906 — the sample parameters are UNCHANGED by this ticket (AC5)', () => {
  it('pins maxRowsPerSlot{Desk,Other} and maxFileBytes', () => {
    // TRA-4905 ruled NO-CUT: the slot budget already size-filters each slot's
    // tail (31/40 slots, p = 0.0007), so cutting it amplifies a measured bias
    // AND reweights sessions already banked under a pre-registered readout.
    // MAX_FILE_BYTES is re-derived by TRA-4905 §5 off a POST-dedup session, not here.
    const { policy } = summarizeOtmAdmissionTape();
    expect(policy.maxRowsPerSlotDesk).toBe(1000);
    expect(policy.maxRowsPerSlotOther).toBe(200);
    expect(policy.maxFileBytes).toBe(144 * 1024 * 1024);
    expect(policy.maxRowsPerPass).toBe(400);
    expect(policy.sampleModDesk).toBe(12);
    expect(policy.samplingPolicy).toBe(2); // the dedup is NOT a policy bump: no candidate row moved
  });
});

describe('TRA-4628 — hydrate / retention / export', () => {
  it('rebuilds aggregates from disk and drops rows older than retention', () => {
    const pass = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.commit();
    // A stale row from far outside the retention window, appended by hand.
    const stale = { ...JSON.parse(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim()), ts: NOW - 90 * 24 * 60 * 60 * 1000, etDay: '2026-06-01' };
    writeFileSync(
      otmAdmissionTapePath(dir),
      JSON.stringify(stale) + '\n' + readFileSync(otmAdmissionTapePath(dir), 'utf8'),
      'utf8',
    );

    const h = hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    expect(h.records).toBe(1); // stale line compacted away
    expect(h.days).toBe(1);
    const desk = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk');
    expect(desk?.candidateRows).toBe(1);
    // The compaction rewrote the file to the kept line only.
    expect(readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('skips a torn trailing line rather than aborting the hydrate', () => {
    const pass = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.commit();
    writeFileSync(
      otmAdmissionTapePath(dir),
      readFileSync(otmAdmissionTapePath(dir), 'utf8') + '{"kind":"candidate","ts":17',
      'utf8',
    );
    const h = hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    expect(h.records).toBe(1);
  });

  it('streams rows back filtered by day and class, and reports truncation', async () => {
    const pass = beginOtmAdmissionPass({ symbol: SEL, book: 'deskbook', mode: 'live', now: NOW });
    pass!.onAdmission(decision());
    pass!.onAdmission(decision({ occSymbol: 'RIG2', admitted: false, bindingReason: 'max_spread_pct' }));
    pass!.commit();

    const all = await readOtmAdmissionTapeRows({});
    expect(all.rows).toHaveLength(2);
    expect(all.truncated).toBe(false);

    const wrongDay = await readOtmAdmissionTapeRows({ etDay: '2020-01-01' });
    expect(wrongDay.rows).toHaveLength(0);

    const capped = await readOtmAdmissionTapeRows({ limit: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    const fixtureOnly = await readOtmAdmissionTapeRows({ accountClass: 'fixture' });
    expect(fixtureOnly.rows).toHaveLength(0);
  });
});
