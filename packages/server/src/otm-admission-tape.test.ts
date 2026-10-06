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
  otmAdmissionSlotAllowance,
  otmAdmissionSlotFraction,
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
    // ⚠ The lower bound is 1,500 rather than v2's 2,000 because this fixture is
    // a COLD BOOT: rule 3's share denominator falls back to SEED_ROWS_PER_SLOT
    // where the slot has no prior day on disk, and that seed is sized off real
    // desk demand (~2,100 rows/slot), which is ~4x this fixture's. A live deploy
    // hydrates ten days of history and thins against each slot's OWN measured
    // demand instead — simulated at −12%..−23% of v2 volume, not −60%.
    expect(day.candidateRows).toBeGreaterThan(1500);
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
  it('writes a budgetdrop row carrying the slot, the shed count and the full pass size', () => {
    const { symbol, book } = oversizedForFixtureSlot(NOW);
    fixturePass(NOW, 250, symbol, book); // 250 > MAX_ROWS_PER_SLOT_OTHER (200)

    const rows = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // TRA-4954: the pass is THINNED, not dropped whole — the shed row lands
    // first, then whatever banked. v2 wrote the shed row and nothing else.
    const shed = rows.find((r) => r.kind === 'budgetdrop');
    const banked = rows.filter((r) => r.kind === 'candidate');
    expect(shed).toMatchObject({
      kind: 'budgetdrop',
      ts: NOW,
      etDay: '2026-09-16',
      accountClass: 'fixture',
      slot: otmAdmissionSlot(NOW),
      underlying: symbol,
      passRows: 250,
    });
    expect(banked.length).toBeGreaterThan(0); // AC1 — the symbol is REPRESENTED
    expect(shed.banked).toBe(banked.length);
    expect(shed.rows).toBe(250 - banked.length); // `rows` means rows SHED

    const summary = summarizeOtmAdmissionTape();
    const day = summary.byClass.find((c) => c.accountClass === 'fixture')!.days[0]!;
    expect(day.dropsBySlotEt).toEqual({
      '11:00': { passes: 1, rows: 250 - banked.length, banked: banked.length, passRows: 250, wholeDrops: 0 },
    });
    // The scalars are KEPT (AC: not removed); a thinned pass counts as thinned.
    expect(summary.counters.slotBudgetPassesDropped).toBe(0);
    expect(summary.counters.slotBudgetPassesThinned).toBe(1);
    expect(summary.counters.slotBudgetRowsShed).toBe(250 - banked.length);
  });

  it('dropsBySlotEt SURVIVES A BOOT — the whole point (AC1)', () => {
    const { symbol, book } = oversizedForFixtureSlot(NOW);
    fixturePass(NOW, 250, symbol, book);
    // A second shed in a LATER slot, so the rebuild has to be per-slot, not a total.
    const later = NOW + 90 * 60 * 1000; // 12:30 ET
    const s2 = selectedSymbol('qa_tape', later, 'fixture');
    fixturePass(later, 210, s2, book);

    const before = summarizeOtmAdmissionTape().byClass
      .find((c) => c.accountClass === 'fixture')!.days[0]!.dropsBySlotEt;

    // Boot: fresh process state, aggregates rebuilt from disk alone.
    clearOtmAdmissionTape();
    hydrateOtmAdmissionTapeFromDisk(dir, NOW + 2 * 60 * 60 * 1000);

    const summary = summarizeOtmAdmissionTape();
    const day = summary.byClass.find((c) => c.accountClass === 'fixture')!.days[0]!;
    expect(Object.keys(day.dropsBySlotEt ?? {})).toEqual(['11:00', '12:30']);
    expect(day.dropsBySlotEt).toEqual(before); // every field round-trips, per slot
    expect(day.dropsBySlotEt!['11:00']!.passRows).toBe(250);
    expect(day.dropsBySlotEt!['12:30']!.passRows).toBe(210);
    // The process-total scalar is exactly what a boot DESTROYS — that is why the
    // rows exist. Its reading 0 here while dropsBySlotEt is intact IS the AC.
    expect(summary.counters.slotBudgetPassesThinned).toBe(0);
  });

  it('a budgetdrop row is NOT SAMPLE — it enters no other count (AC2)', () => {
    // A WHOLE drop (the v2 shape) so there are no banked rows to confuse the
    // "enters no other count" reading: policy v3 still produces one when a slot
    // presents more symbols than its reserve was sized for.
    const whole = {
      kind: 'budgetdrop', ts: NOW, etDay: '2026-09-16', accountClass: 'fixture',
      slot: otmAdmissionSlot(NOW), underlying: 'SPY', rows: 250, passRows: 250, banked: 0,
    };
    writeFileSync(otmAdmissionTapePath(dir), JSON.stringify(whole) + '\n', 'utf8');
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
    // The PASS still counts — losing it would understate rule 3's bite. A v2 row
    // carries neither `passRows` nor `banked`: it was dropped WHOLE, so its full
    // size IS `rows` and nothing banked. Here `rows` is itself unreadable, so
    // `passRows` folds to 0 — the pass count is the part that must not be lost.
    expect(day.dropsBySlotEt).toEqual({
      '11:00': { passes: 1, rows: 0, banked: 0, passRows: 0, wholeDrops: 1 },
    });
  });

  it('a v2 budgetdrop row is NOT retconned into a thinned one on hydrate', () => {
    // The whole v2 corpus (2026-09-19..2026-10-01) carries neither field. Reading the
    // absence as "banked: unknown" and guessing would make those days look like
    // they thinned — they did not, and that difference is the TRA-4954 finding.
    const v2 = {
      kind: 'budgetdrop', ts: NOW, etDay: '2026-09-16', accountClass: 'desk',
      slot: otmAdmissionSlot(NOW), underlying: 'SPY', rows: 246,
    };
    writeFileSync(otmAdmissionTapePath(dir), JSON.stringify(v2) + '\n', 'utf8');
    hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    const day = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk')!.days[0]!;
    expect(day.dropsBySlotEt).toEqual({
      '11:00': { passes: 1, rows: 246, banked: 0, passRows: 246, wholeDrops: 1 },
    });
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
    // TRA-4954 bumped this to 3 (thinning: a v3 slot is a per-symbol capped
    // subsample of its demand where a v2 slot was a first-come prefix), and
    // TRA-5211 to 4 (the forward expectation decays over the slot's life, so
    // the within-slot spending profile moved from 57-61% to ~full budget on a
    // saturated slot). The dedup (TRA-4906) was NOT a bump — no candidate row
    // moved.
    expect(policy.samplingPolicy).toBe(4);
  });

  it('🔴 TRA-4954 did NOT raise the budget or the byte cap (AC2/AC4)', () => {
    const { policy } = summarizeOtmAdmissionTape();
    expect(policy.maxRowsPerSlotDesk).toBe(1000);
    expect(policy.maxRowsPerSlotOther).toBe(200);
    expect(policy.maxFileBytes).toBe(144 * 1024 * 1024);
    expect(policy.floorRowsPerSymbol).toBe(2);
  });
});

// ── TRA-4954 — rule 3 THINS, it does not starve ──────────────────────────────

/**
 * Replay a whole desk slot: `symbols` distinct underlyings, each presenting one
 * pass of `size(i)` rows, in arrival order. Returns per-symbol banked counts and
 * the shed rows, read back OFF DISK — never off a counter (the AC1 instruction).
 */
function replaySlot(
  now: number,
  book: string,
  accountClass: string,
  sizes: number[],
): { banked: Map<string, number>; shed: Record<string, unknown>[]; slotRows: number } {
  const slot = otmAdmissionSlot(now);
  const etDay = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const chosen: string[] = [];
  for (let i = 0; chosen.length < sizes.length && i < 200_000; i += 1) {
    const sym = `W${i}`;
    if (otmAdmissionSlotSelected(book, sym, etDay, slot, accountClass)) chosen.push(sym);
  }
  chosen.forEach((sym, i) => {
    const p = beginOtmAdmissionPass({ symbol: sym, book, mode: 'live', now: now + i });
    if (!p) throw new Error(`pass ${sym} was not selected — fix the fixture`);
    for (let k = 0; k < sizes[i]!; k += 1) {
      p.onAdmission(decision({ underlying: sym, occSymbol: `${sym}C${String(k).padStart(5, '0')}` }));
    }
    p.commit();
  });
  const rows = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const banked = new Map<string, number>(chosen.map((s) => [s, 0]));
  let slotRows = 0;
  for (const r of rows) {
    if (r.kind !== 'candidate') continue;
    banked.set(r.underlying, (banked.get(r.underlying) ?? 0) + 1);
    slotRows += 1;
  }
  return { banked, shed: rows.filter((r) => r.kind === 'budgetdrop'), slotRows };
}

describe('TRA-4954 — the slot budget THINS wide-chain names instead of starving them', () => {
  it('AC1 — every symbol presenting in an OVER-SUBSCRIBED slot banks ≥1 row', () => {
    // 40 desk symbols × 120 rows = 4,800 rows presented into a 1,000-row slot.
    // Under v2 the first ~8 passes banked everything and the other 32 symbols
    // banked ZERO — the measured defect (24 desk / 159 fixture symbols on 09-25).
    const { banked, slotRows } = replaySlot(NOW, 'deskbook', 'desk', Array(40).fill(120));
    expect(banked.size).toBe(40);
    expect([...banked.values()].filter((n) => n === 0)).toEqual([]); // read off disk
    expect(Math.min(...banked.values())).toBeGreaterThanOrEqual(2); // the floor
    expect(slotRows).toBeLessThanOrEqual(1000); // AC2, same breath
  });

  it('AC1 — the LAST symbol to present is not starved by the first (the eviction order)', () => {
    // One 400-row monster first, then 30 ordinary names. v2's first-come rule is
    // exactly what let the monster take 40% of the slot and starve the tail.
    const { banked } = replaySlot(NOW, 'deskbook', 'desk', [400, ...Array(30).fill(100)]);
    const values = [...banked.values()];
    // The ticket's own statement of the defect: "a 246-row SPY pass must not be
    // able to consume 25% of a 1,000-row slot". v2 gave this pass all 400 (40%).
    expect(values[0]).toBeLessThan(1000 * 0.25);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(2);
    expect(values[values.length - 1]).toBeGreaterThanOrEqual(2); // arriving last costs nothing
  });

  it('AC2 — rowsBySlot still respects MAX_ROWS_PER_SLOT, and still equals candidateRows', () => {
    replaySlot(NOW, 'deskbook', 'desk', Array(40).fill(120));
    const day = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk')!.days[0]!;
    const perSlot = Object.values(day.rowsBySlotEt ?? {});
    expect(Math.max(...perSlot)).toBeLessThanOrEqual(1000);
    // The identity the AC names, exactly — not approximately.
    expect(perSlot.reduce((a, b) => a + b, 0)).toBe(day.candidateRows);
  });

  it('AC3 — the shed FRACTION does not depend on pass size (the size filter is gone)', () => {
    // Widths spanning 14x. Under v2 the wide ones were dropped whole (shed
    // fraction 1.0) and the narrow ones banked whole (0.0) — a perfect filter.
    const sizes = [20, 40, 60, 80, 100, 140, 180, 220, 260, 280];
    const { banked, shed } = replaySlot(NOW, 'deskbook', 'desk', sizes);
    const byUnderlying = new Map(shed.map((r) => [r.underlying as string, r]));
    const fractions = [...banked.entries()].map(([sym, got]) => {
      const row = byUnderlying.get(sym);
      const full = row ? (row.passRows as number) : got;
      return (full - got) / full;
    });
    const spread = Math.max(...fractions) - Math.min(...fractions);
    expect(spread).toBeLessThan(0.1); // every width sheds the same share, ±10pp
    // …and the comparison the AC pre-registered, off the shed rows directly.
    const shedSizes = shed.map((r) => r.passRows as number);
    const meanShed = shedSizes.reduce((a, b) => a + b, 0) / shedSizes.length;
    const meanAll = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    expect(Math.abs(meanShed / meanAll - 1)).toBeLessThan(0.1);
  });

  it('🔴 a truncation keeps rows by HASH RANK, never by chain position', () => {
    // Chain position correlates with strike and therefore with mark. If the
    // thinner kept a prefix, the banked strikes would be the low ones — which
    // would make the tape's own axis a function of its sampling.
    const { banked } = replaySlot(NOW, 'deskbook', 'desk', Array(30).fill(200));
    const rows = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((r) => r.kind === 'candidate');
    const first = [...banked.keys()][0]!;
    const kept = rows.filter((r) => r.underlying === first).map((r) => Number(r.occSymbol.slice(-5)));
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThan(200); // it really was truncated
    // A prefix would put every kept index below `kept.length`; a hash rank
    // scatters them across the whole chain.
    expect(Math.max(...kept)).toBeGreaterThan(200 * 0.5);
    expect(Math.min(...kept)).toBeLessThan(200 * 0.5);
  });

  it('AC5 — `ordered` is still unconditional under a saturated slot', () => {
    replaySlot(NOW, 'deskbook', 'desk', Array(40).fill(120)); // saturate first
    for (let i = 0; i < 20; i += 1) {
      recordOtmAdmissionOrdered({ symbol: 'RIG', book: 'deskbook', mode: 'live', now: NOW + i }, `RIG${i}`);
    }
    const desk = summarizeOtmAdmissionTape().byClass.find((c) => c.accountClass === 'desk')!;
    expect(desk.ordered).toBe(20); // never deduped, never throttled, never budgeted
  });

  it('the allowance is a pure function of counts — no quote, no scan order, reaches it', () => {
    const base = {
      budget: 1000, banked: 400, presented: 900, symbolsSeen: 12, symbolIsNew: true,
      expectedSymbols: 36, expectedRows: 2048, passRows: 120,
    };
    const a = otmAdmissionSlotAllowance(base);
    expect(a).toBe(otmAdmissionSlotAllowance({ ...base })); // deterministic
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(base.passRows);
    // Doubling the pass doubles the share — the proportionality AC3 rests on.
    const wide = otmAdmissionSlotAllowance({ ...base, passRows: 240 });
    expect(wide / a).toBeGreaterThan(1.8);
    expect(wide / a).toBeLessThan(2.2);
  });

  it('the AC1 reserve invariant holds for every state in a swept grid', () => {
    // `banked ≤ budget − floorK × unseenAfter` is what makes AC1 a property of
    // the function rather than of one fixture. Swept, not sampled.
    for (const budget of [200, 1000]) {
      for (const expectedSymbols of [8, 36, 110]) {
        const floorK = Math.max(1, Math.min(2, Math.floor(budget / expectedSymbols)));
        for (let seen = 0; seen <= expectedSymbols; seen += 1) {
          for (const n of [1, 3, 40, 246, 400]) {
            for (const banked of [0, Math.floor(budget / 2), budget - 1, budget]) {
              for (const isNew of [true, false]) {
                const got = otmAdmissionSlotAllowance({
                  budget, banked, presented: banked, symbolsSeen: seen, symbolIsNew: isNew,
                  expectedSymbols, expectedRows: budget * 3, passRows: n,
                });
                expect(got).toBeGreaterThanOrEqual(0);
                expect(got).toBeLessThanOrEqual(n);
                expect(banked + got).toBeLessThanOrEqual(budget); // AC2, always
                const unseenAfter = Math.max(0, Math.max(expectedSymbols, seen + (isNew ? 1 : 0)) - seen - (isNew ? 1 : 0));
                if (banked + floorK * (unseenAfter + (isNew ? 1 : 0)) <= budget) {
                  // There was room for the reserve going in, so it survives.
                  expect(banked + got + floorK * unseenAfter).toBeLessThanOrEqual(budget);
                  if (isNew) expect(got).toBeGreaterThanOrEqual(Math.min(n, floorK));
                }
              }
            }
          }
        }
      }
    }
  });

  it('the demand learner rebuilds from disk and never folds TODAY into the expectation', () => {
    // A slot's own partial total is not a statement about the whole slot: if it
    // fed back, pass 2 would see "nothing left to come" and take the budget
    // first-come — the bias this ticket removes.
    replaySlot(NOW, 'deskbook', 'desk', Array(20).fill(60));
    const live = summarizeOtmAdmissionTape().policy.slotDemand;
    clearOtmAdmissionTape();
    hydrateOtmAdmissionTapeFromDisk(dir, NOW);
    expect(summarizeOtmAdmissionTape().policy.slotDemand).toEqual(live); // same path
    const cell = live[`desk|${otmAdmissionSlot(NOW)}`]!;
    expect(cell.symbols).toBeGreaterThanOrEqual(20); // learned, floored at the seed
    expect(cell.rows).toBe(2100); // the SEED — today is not prior-day history
  });
});

// ── TRA-5211 — the forward expectation DECAYS instead of expiring unused ────

/**
 * Replay a desk slot with passes ARRIVING ACROSS ITS LIFE (minute-resolution
 * timestamps), the shape the single-instant {@link replaySlot} cannot express
 * and the one the decay exists for. Read back off disk, never off a counter.
 */
function replaySlotTimed(
  book: string,
  sizes: { size: number; minute: number }[],
): { banked: Map<string, number>; presented: number; bankedTotal: number } {
  const slot = otmAdmissionSlot(NOW);
  const etDay = new Date(NOW).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const chosen: string[] = [];
  for (let i = 0; chosen.length < sizes.length && i < 200_000; i += 1) {
    const sym = `W${i}`;
    if (otmAdmissionSlotSelected(book, sym, etDay, slot, 'desk')) chosen.push(sym);
  }
  chosen.forEach((sym, i) => {
    const now = NOW + sizes[i]!.minute * 60_000 + i; // NOW is minute 0 of its slot
    const p = beginOtmAdmissionPass({ symbol: sym, book, mode: 'live', now });
    if (!p) throw new Error(`pass ${sym} was not selected — fix the fixture`);
    for (let k = 0; k < sizes[i]!.size; k += 1) {
      p.onAdmission(decision({ underlying: sym, occSymbol: `${sym}C${String(k).padStart(5, '0')}` }));
    }
    p.commit();
  });
  const rows = readFileSync(otmAdmissionTapePath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const banked = new Map<string, number>(chosen.map((s) => [s, 0]));
  let bankedTotal = 0;
  for (const r of rows) {
    if (r.kind !== 'candidate') continue;
    banked.set(r.underlying, (banked.get(r.underlying) ?? 0) + 1);
    bankedTotal += 1;
  }
  return { banked, presented: sizes.reduce((a, b) => a + b.size, 0), bankedTotal };
}

describe('TRA-5211 — the floor reservation decays over the slot instead of expiring unused', () => {
  const mid = {
    budget: 1000, banked: 300, presented: 700, symbolsSeen: 20, symbolIsNew: true,
    expectedSymbols: 48, expectedRows: 2100, passRows: 60,
  };

  it('an ABSENT or ZERO slotFractionElapsed computes the undecayed v3 allowance exactly', () => {
    // The backward-compatibility contract: a slot's first minute has no
    // observation window, so both projections stay off — which is also what
    // keeps every single-instant TRA-4954 fixture above (NOW is minute 0 of
    // its slot) grading the same policy it graded before this ticket.
    for (const isNew of [true, false]) {
      for (const n of [1, 40, 246]) {
        const st = { ...mid, symbolIsNew: isNew, passRows: n };
        const undecayed = otmAdmissionSlotAllowance(st);
        expect(otmAdmissionSlotAllowance({ ...st, slotFractionElapsed: 0 })).toBe(undecayed);
        expect(otmAdmissionSlotAllowance({ ...st, slotFractionElapsed: undefined })).toBe(undecayed);
      }
    }
  });

  it('the allowance is non-decreasing in slot age — decay only ever RELEASES headroom', () => {
    let prev = 0;
    for (let m = 0; m < 30; m += 1) {
      const a = otmAdmissionSlotAllowance({ ...mid, slotFractionElapsed: m / 30 });
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    // …and a stalled expectation has measurably released by late slot: 20 of 48
    // expected symbols arrived, 700 of 2100 expected rows presented, yet v3
    // held the full reserve + denominator to the last minute.
    expect(otmAdmissionSlotAllowance({ ...mid, slotFractionElapsed: 29 / 30 }))
      .toBeGreaterThan(otmAdmissionSlotAllowance(mid));
  });

  it('AC2 and the per-arrival floor survive every decay state (swept over f)', () => {
    for (const f of [0, 1 / 30, 0.25, 0.5, 0.75, 29 / 30, 1]) {
      for (const banked of [0, 500, 998, 1000]) {
        for (const isNew of [true, false]) {
          for (const n of [1, 40, 400]) {
            const got = otmAdmissionSlotAllowance({
              budget: 1000, banked, presented: banked, symbolsSeen: 12, symbolIsNew: isNew,
              expectedSymbols: 48, expectedRows: 2100, passRows: n, slotFractionElapsed: f,
            });
            expect(got).toBeGreaterThanOrEqual(0);
            expect(got).toBeLessThanOrEqual(n);
            expect(banked + got).toBeLessThanOrEqual(1000); // AC2, unconditionally
            // A new symbol's floor does not depend on the decayed reserve.
            if (isNew && 1000 - banked >= 2) expect(got).toBeGreaterThanOrEqual(Math.min(n, 2));
          }
        }
      }
    }
  });

  it('🔴 a straggler floor is held to the slot\'s LAST minute — decay is not deletion', () => {
    // Share-driven spending can take the budget to (budget − floorK), never
    // through it, while any symbol could still arrive: the reserve projection
    // ceil()s to ≥ 1 symbol for every f < 1 once anything has arrived. This is
    // the TRA-4954-regression guard the ticket's AC2 names.
    for (const f of [0.5, 0.9, 29 / 30]) {
      const allow = otmAdmissionSlotAllowance({
        budget: 1000, banked: 900, presented: 2000, symbolsSeen: 30, symbolIsNew: false,
        expectedSymbols: 48, expectedRows: 2100, passRows: 400, slotFractionElapsed: f,
      });
      expect(900 + allow).toBeLessThanOrEqual(1000 - 2);
    }
  });

  it('AC1 — an under-demand slot banks ≥95% of presented rows (v3 shed 38% of them)', () => {
    // 26 symbols × 35 rows = 910 presented into a 1,000-row budget, arriving
    // uniformly across the slot — the measured live shape (presented below the
    // 2,100-row learner max, every slot shedding against free headroom). The
    // TRA-5211 AC1 bar is shed-while-budget-free ≤ 5% of presented.
    const sizes = Array.from({ length: 26 }, (_, i) => ({ size: 35, minute: Math.floor((i * 30) / 26) }));
    const { banked, presented, bankedTotal } = replaySlotTimed('deskbook', sizes);
    const freeShed = Math.min(presented - bankedTotal, 1000 - bankedTotal);
    expect(freeShed).toBeLessThanOrEqual(0.05 * presented);
    expect([...banked.values()].filter((n) => n === 0)).toEqual([]); // AC2: no starvation
  });

  it('AC1 — an OVER-subscribed slot fills its budget, and the floor still holds', () => {
    // 44 × 30 = 1,320 presented into 1,000: the shed is now genuine budget
    // pressure, not free-headroom expiry. v3 banked 619 of this shape.
    const sizes = Array.from({ length: 44 }, (_, i) => ({ size: 30, minute: Math.floor((i * 30) / 44) }));
    const { banked, bankedTotal } = replaySlotTimed('deskbook', sizes);
    expect(bankedTotal).toBeGreaterThanOrEqual(950);
    expect(bankedTotal).toBeLessThanOrEqual(1000); // AC3: the budget is not raised
    expect(Math.min(...banked.values())).toBeGreaterThanOrEqual(2); // TRA-4954 floor
  });

  it('the slot fraction is minute-resolution ET and agrees with the slot index', () => {
    expect(otmAdmissionSlotFraction(NOW)).toBe(0); // 11:00 ET — a slot boundary
    expect(otmAdmissionSlotFraction(NOW + 17 * 60_000)).toBeCloseTo(17 / 30, 12);
    expect(otmAdmissionSlot(NOW + 29 * 60_000)).toBe(otmAdmissionSlot(NOW)); // same cell
    expect(otmAdmissionSlotFraction(NOW + 30 * 60_000)).toBe(0); // next slot re-arms
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

  // The export is the AC4 consumer's only surface, and a (day × class) slice is
  // NOT guaranteed to fit one response — measured 2026-10-02, desk 2026-09-24
  // is 21,384 rows against a 20,000 ceiling, so an unpaged reader silently got
  // the day's EARLY slots only. Paging must be exact and `kind` must be able to
  // drop the link rows the sweep never reads.
  it('pages a slice that exceeds one response, and filters by kind', async () => {
    const ctx = { symbol: SEL, book: 'deskbook', mode: 'live', now: NOW } as const;
    const pass = beginOtmAdmissionPass({ ...ctx });
    pass!.onAdmission(decision({ occSymbol: 'RIG1' }));
    pass!.onAdmission(decision({ occSymbol: 'RIG2', admitted: false, bindingReason: 'min_mark' }));
    pass!.onAdmission(decision({ occSymbol: 'RIG3' }));
    pass!.commit();
    recordOtmAdmissionRanked({ ...ctx }, 'RIG1');
    recordOtmAdmissionOrdered({ ...ctx }, 'RIG1');

    // Unpaged, under the ceiling: complete, and no cursor handed back.
    const all = await readOtmAdmissionTapeRows({});
    expect(all.rows).toHaveLength(5);
    expect(all.truncated).toBe(false);
    expect(all.nextOffset).toBeNull();

    // Paged at the ceiling: the concatenation is the whole slice, in file order,
    // with every row seen exactly once.
    const collected: string[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    while (cursor !== null) {
      const page = await readOtmAdmissionTapeRows({ limit: 2, offset: cursor });
      expect(page.offset).toBe(cursor);
      for (const r of page.rows) collected.push(`${r.kind}:${'occSymbol' in r ? r.occSymbol : ''}`);
      cursor = page.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(10); // a cursor that does not advance must fail loudly
    }
    expect(collected).toEqual(
      all.rows.map((r) => `${r.kind}:${'occSymbol' in r ? r.occSymbol : ''}`),
    );

    // kind narrows the slice to the sweep's own population. The COUNT is read
    // off the unfiltered slice, not hard-coded: this is a COLD BOOT, so rule 3's
    // share denominator falls back to SEED_ROWS_PER_SLOT and even a 3-row pass is
    // thinned (TRA-4954). The subject here is the filter, not the budget.
    const bankedHere = all.rows.filter((r) => r.kind === 'candidate').length;
    expect(bankedHere).toBeGreaterThanOrEqual(2);
    const candidates = await readOtmAdmissionTapeRows({ kind: 'candidate' });
    expect(candidates.rows.map((r) => r.kind)).toEqual(Array(bankedHere).fill('candidate'));
    expect(candidates.truncated).toBe(false);
    // …and the shed row is reachable by its own kind, which is how AC1 is graded.
    const shed = await readOtmAdmissionTapeRows({ kind: 'budgetdrop' });
    expect(shed.rows).toHaveLength(all.rows.length - bankedHere - 2); // minus ranked+ordered
    const ranked = await readOtmAdmissionTapeRows({ kind: 'ranked' });
    expect(ranked.rows).toHaveLength(1);

    // offset past the end of the slice is empty and terminal, never a wrap.
    const past = await readOtmAdmissionTapeRows({ kind: 'candidate', offset: 99 });
    expect(past.rows).toHaveLength(0);
    expect(past.nextOffset).toBeNull();
  });
});
