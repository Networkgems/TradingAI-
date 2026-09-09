// TRA-3942 (parent TRA-3927, board card `a29b2db8` accepted 2026-08-22T04:18Z) —
// the ENTRY-TIME window on the `single_leg_otm` sleeve.
//
// ── What the tape said (finding F1) ─────────────────────────────────────────
// 15 of 17 live OTM entries filled 13:35–13:51Z — the widest-spread,
// highest-IV-crush window of the session. The scanner was reacting to the
// overnight gap (the largest mispricing print on the chain, and therefore what
// `|mispricingPct|` ranks first), not to a confirmed intraday structure.
//
// ── What is asserted ────────────────────────────────────────────────────────
//  1. AC1's five clock instants, verbatim, in EDT — and then the SAME five ET
//     wall-clock times in JANUARY, where the UTC stamps are an hour later. The
//     winter block is the negative control on the DST clause: a hard-coded −4
//     passes every EDT case here and fails every EST one.
//  2. AC1's last clause — an EXIT at 13:45Z still fires — behaviourally, on a
//     real `PaperOptionsAccount` round trip, plus a source-level proof that no
//     exit path can reach the module at all.
//  3. AC2 — the refusal carries the low-cardinality code `entry_window_closed`
//     on BOTH counters it has to be countable on: the OTM scan's
//     `rejectionsByGate` bucket and the `entry_window` live-enforce axis.
//  4. The WIRING, source-level (the tra2331/tra3218 house pattern: line numbers
//     shift, symbols do not). A predicate that is correct and unreached is the
//     vacuous pass this repo keeps paying for.
//  5. AC4 — the arm, the row size and the 2-row cap are not read here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveOtmEntryWindows,
  otmEntryWindowVerdict,
  otmEntryWindowsUtcAt,
  formatOtmEntryWindows,
  formatEtMinutes,
  OTM_ENTRY_WINDOWS_DEFAULT,
  OTM_ENTRY_WINDOWS_VALUE,
  OTM_ENTRY_WINDOW_CLOSED_CODE,
} from './otm-entry-window.js';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveEnforceGateLedger,
  recordLiveEnforceDecision,
  summarizeLiveEnforceGate,
} from './live-enforce-gate-ledger.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
// Normalised to LF: the checkout is CRLF on Windows, and a source-level matcher
// that silently depends on the line ending is a grader that is green on one
// developer's box and red on another's.
const ENGINE_SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8').replace(/\r\n/g, '\n');

/** The body of a class method, from its signature to its closing brace. */
function methodBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const end = src.indexOf('\n  }\n', at);
  expect(end, `${signature} (closing brace)`).toBeGreaterThan(at);
  return src.slice(at, end);
}

/** A summer (EDT, UTC−4) Tuesday. RTH is 13:30–20:00Z on this day. */
const EDT_DAY = '2026-08-25';
/** A winter (EST, UTC−5) Tuesday. RTH is 14:30–21:00Z on this day. */
const EST_DAY = '2026-01-13';

const at = (day: string, hhmmZ: string): number => Date.parse(`${day}T${hhmmZ}:00Z`);
const openAt = (day: string, hhmmZ: string): boolean =>
  otmEntryWindowVerdict(at(day, hhmmZ), resolveOtmEntryWindows({})).open;

describe('TRA-3942 — resolveOtmEntryWindows', () => {
  it('defaults to the board ruling: 10:15–11:30 ET and 15:00–15:45 ET', () => {
    expect(formatOtmEntryWindows(OTM_ENTRY_WINDOWS_DEFAULT)).toBe('10:15-11:30,15:00-15:45');
    expect(resolveOtmEntryWindows({})).toEqual({
      windows: OTM_ENTRY_WINDOWS_DEFAULT,
      source: 'default',
      raw: null,
    });
    // Blank is absent, not a disarm.
    expect(resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: '   ' }).source).toBe('default');
  });

  it('honours a well-formed override and sorts it by start', () => {
    const r = resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: '15:00-15:45, 10:15-11:30' });
    expect(r.source).toBe('env');
    expect(formatOtmEntryWindows(r.windows)).toBe('10:15-11:30,15:00-15:45');
    expect(r.raw).toBe('15:00-15:45, 10:15-11:30');
  });

  it('a WIDEN is spellable, but only deliberately and visibly', () => {
    const r = resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: '00:00-24:00' });
    expect(r.source).toBe('env');
    expect(otmEntryWindowVerdict(at(EDT_DAY, '13:45'), r).open).toBe(true);
    // …and the state is on the wire, not inferred: the resolution names the
    // source AND retains the raw string the operator wrote.
    expect(r.raw).toBe('00:00-24:00');
  });

  it('every malformed shape voids the WHOLE string and falls back to the RULING, loudly', () => {
    const typos = [
      '10:15',              // no end
      '10:15-',             // empty end
      '1015-1130',          // no colon
      '10:15-11:30-12:00',  // three halves
      '11:30-10:15',        // reversed
      '10:15-10:15',        // zero width
      '25:00-26:00',        // out of range hour
      '10:75-11:30',        // out of range minute
      '10:15-11:30,broken', // ONE bad member voids the list
      ',',                  // empty after trimming
      'always',
      'off',
    ];
    for (const raw of typos) {
      const r = resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: raw });
      expect(r.source, raw).toBe('env_invalid');
      // FAIL CLOSED: a typo gets the board's windows, never the whole session.
      expect(formatOtmEntryWindows(r.windows), raw).toBe('10:15-11:30,15:00-15:45');
      expect(otmEntryWindowVerdict(at(EDT_DAY, '13:45'), r).open, raw).toBe(false);
    }
  });
});

// ── AC1 ─────────────────────────────────────────────────────────────────────
describe('TRA-3942 AC1 — the five clock instants (EDT)', () => {
  it('13:45Z REFUSED — the F1 window', () => {
    expect(openAt(EDT_DAY, '13:45')).toBe(false);
  });
  it('14:20Z ACCEPTED — inside the morning window', () => {
    expect(openAt(EDT_DAY, '14:20')).toBe(true);
  });
  it('16:00Z REFUSED — midday, between the windows', () => {
    expect(openAt(EDT_DAY, '16:00')).toBe(false);
  });
  it('19:10Z ACCEPTED — inside the afternoon window', () => {
    expect(openAt(EDT_DAY, '19:10')).toBe(true);
  });
  it('19:50Z REFUSED — past the afternoon window, into the close', () => {
    expect(openAt(EDT_DAY, '19:50')).toBe(false);
  });

  it('the edges are half-open [start, end) — a boundary fill is refused, not admitted', () => {
    expect(openAt(EDT_DAY, '14:15')).toBe(true);   // 10:15 ET — start is INCLUSIVE
    expect(openAt(EDT_DAY, '14:14')).toBe(false);  // 10:14 ET
    expect(openAt(EDT_DAY, '15:29')).toBe(true);   // 11:29 ET
    expect(openAt(EDT_DAY, '15:30')).toBe(false);  // 11:30 ET — end is EXCLUSIVE
    expect(openAt(EDT_DAY, '19:00')).toBe(true);   // 15:00 ET
    expect(openAt(EDT_DAY, '18:59')).toBe(false);  // 14:59 ET
    expect(openAt(EDT_DAY, '19:44')).toBe(true);   // 15:44 ET
    expect(openAt(EDT_DAY, '19:45')).toBe(false);  // 15:45 ET
  });

  it('the whole 13:30–14:00Z band F1 named is refused, minute by minute (AC3 in unit form)', () => {
    for (let m = 0; m < 30; m += 1) {
      const hh = 13 + Math.floor((30 + m) / 60);
      const mm = (30 + m) % 60;
      const stamp = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      expect(openAt(EDT_DAY, stamp), stamp).toBe(false);
    }
  });
});

// ── AC1, the DST clause ─────────────────────────────────────────────────────
// "verify DST handling, do not hardcode an ET offset". The windows are ET, so in
// January every one of them sits an hour LATER in UTC. Each pair below is a
// subject and its negative control: the UTC stamp that is correct in August is
// WRONG in January, and a hard-coded −4 cannot tell them apart.
describe('TRA-3942 AC1 — the windows are ET, and follow DST', () => {
  it('the EDT-correct stamps are REFUSED in January', () => {
    expect(openAt(EST_DAY, '14:20')).toBe(false); // 09:20 ET — pre-open in winter
    expect(openAt(EST_DAY, '19:10')).toBe(false); // 14:10 ET
  });

  it('the SAME ET wall-clock times are ACCEPTED an hour later in UTC', () => {
    expect(openAt(EST_DAY, '15:20')).toBe(true);  // 10:20 ET
    expect(openAt(EST_DAY, '20:10')).toBe(true);  // 15:10 ET
    // …and the F1 band, which in winter is 14:30–15:00Z, is still refused.
    expect(openAt(EST_DAY, '14:45')).toBe(false); // 09:45 ET
  });

  it('the ET minute the verdict reports is the ET wall clock in BOTH regimes', () => {
    expect(otmEntryWindowVerdict(at(EDT_DAY, '14:20'), resolveOtmEntryWindows({})).etMinutes)
      .toBe(10 * 60 + 20);
    expect(otmEntryWindowVerdict(at(EST_DAY, '15:20'), resolveOtmEntryWindows({})).etMinutes)
      .toBe(10 * 60 + 20);
  });

  it('the published UTC rendering MOVES with the season while the ET spec does not', () => {
    // This is the field a grader reads off /api/health/options-live. A stored
    // UTC constant would print the same string in both rows and be wrong in one.
    expect(otmEntryWindowsUtcAt(OTM_ENTRY_WINDOWS_DEFAULT, at(EDT_DAY, '14:20')))
      .toEqual(['14:15Z-15:30Z', '19:00Z-19:45Z']);
    expect(otmEntryWindowsUtcAt(OTM_ENTRY_WINDOWS_DEFAULT, at(EST_DAY, '15:20')))
      .toEqual(['15:15Z-16:30Z', '20:00Z-20:45Z']);
    expect(formatOtmEntryWindows(OTM_ENTRY_WINDOWS_DEFAULT)).toBe('10:15-11:30,15:00-15:45');
  });

  it('fails CLOSED on an unreadable clock, and says which of the two refusals it is', () => {
    const v = otmEntryWindowVerdict(new Date(Number.NaN), resolveOtmEntryWindows({}));
    expect(v.open).toBe(false);
    expect(v.clockReadable).toBe(false);
    expect(v.etMinutes).toBeNull();
    expect(v.reason).toMatch(/fail-closed/);
    // An admitted verdict carries no reason and no code — the two states are
    // never both truthy.
    const admitted = otmEntryWindowVerdict(at(EDT_DAY, '14:20'), resolveOtmEntryWindows({}));
    expect(admitted.reason).toBeNull();
    expect(admitted.reasonCode).toBeNull();
    expect(admitted.window).toEqual({ startMin: 615, endMin: 690 });
  });

  it('formatEtMinutes renders the 24:00 upper edge without wrapping to 00:00', () => {
    expect(formatEtMinutes(0)).toBe('00:00');
    expect(formatEtMinutes(615)).toBe('10:15');
    expect(formatEtMinutes(1440)).toBe('24:00');
  });
});

// ── AC1, last clause: EXITS ARE NOT GATED ───────────────────────────────────
describe('TRA-3942 AC1 — an EXIT at 13:45Z still fires', () => {
  function buildOtmSignal(ts: number): OtmMispricingSignal {
    return {
      id: 'sig-otm-3942',
      symbol: 'AAPL',
      type: 'otm_mispricing',
      side: 'buy',
      entryPrice: 1.0,
      stopLoss: 0.75,
      takeProfit: 1.5,
      riskRewardRatio: 2,
      timestamp: ts,
      optionSymbol: 'AAPL260918C00300000',
      optionType: 'call',
      strike: 300,
      expiration: '2026-09-18',
      mark: 1.0,
      theo: 1.30,
      mispricingPct: -0.23,
      delta: 0.18,
    };
  }

  /**
   * Open inside the morning window, then mark the premium THROUGH the −20% stop
   * at `exitStampZ` and ask for exits. The account is the same in both runs; the
   * only thing that moves is the clock the exit pass is taken on.
   */
  function runToTheStop(exitStampZ: string) {
    vi.setSystemTime(at(EDT_DAY, '14:20'));
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildOtmSignal(at(EDT_DAY, '14:20')), 'demo', undefined, 300);
    expect(pos).not.toBeNull();
    expect(pos!.stopLossPremium).toBeCloseTo(0.80, 6);
    const sym = pos!.optionSymbol!;

    vi.setSystemTime(at(EDT_DAY, exitStampZ));
    const closed = acct.checkExits(new Map([['AAPL', 280]]), new Map([[sym, 0.60]]), 'demo');
    return { acct, closed };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('SUBJECT — 13:45Z is a REFUSED ENTRY window, and the stop still closes the row there', () => {
    // The instant is the one AC1 refuses entries on…
    expect(openAt(EDT_DAY, '13:45')).toBe(false);
    // …and the exit is unaffected.
    const { acct, closed } = runToTheStop('13:45');
    expect(closed).toHaveLength(1);
    // Filled AT the stop level (0.80), not at the 0.60 mark that breached it —
    // the account's own stop-fill convention, unchanged by this ticket.
    expect(closed[0].currentPremium).toBeCloseTo(0.80, 6);
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('POSITIVE CONTROL — the same path inside the window closes identically', () => {
    // Without this pair, "it closed" says nothing about whether the window was
    // consulted: it could have closed for a reason the clock does not touch in
    // EITHER run. Same rows, same reason, same premium ⇒ the exit path does not
    // read the window at all.
    const inside = runToTheStop('14:25');
    const outside = runToTheStop('13:45');
    expect(openAt(EDT_DAY, '14:25')).toBe(true);
    expect(inside.closed).toHaveLength(1);
    expect(outside.closed).toHaveLength(1);
    expect(outside.closed[0].exitReason).toBe(inside.closed[0].exitReason);
  });

  it('SOURCE-LEVEL — no exit path can reach the window module at all', () => {
    // The behavioural test above proves ONE exit rule on ONE clock. This proves
    // the property for every exit rule there is or will be: the module has no
    // importer on any close/exit path. `options-account.ts` owns `checkExits`
    // and every harness-owned stop; `exit-risk-rules-flag.ts` owns the rule
    // resolution. Neither may import it.
    const importers = readdirSync(HERE)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(join(HERE, f), 'utf8').includes("from './otm-entry-window.js'"));
    // The OPEN path, the health surface, and READ-ONLY reporters. Nothing else.
    //
    // ⚠️ REPAIRED 2026-09-09 (TRA-4422): this roster had been RED on `main`
    // since `otm-evaluation-window.ts` (TRA-4342/TRA-4345, 09-03) began
    // importing the module. That importer resolves the window only to DESCRIBE
    // it in the starvation diagnosis — `resolveOtmEntryWindows` /
    // `formatOtmEntryWindows`, no verdict, no close — so the invariant this
    // guards (NO EXIT PATH REACHES THE WINDOW) held the whole time; the literal
    // was stale. It stayed invisible because the pre-push deploy gate runs
    // `tsc -b --force`, which TYPE-checks `.test.ts` files without executing
    // them: a test that compiles and fails is invisible to `check:deploy-build`
    // by construction. A roster a new importer must join is doing its job; one
    // that is already red is a roster nobody reads.
    expect(importers.sort()).toEqual([
      'index.ts', 'otm-evaluation-window.ts', 'signal-engine.ts',
    ]);
    expect(importers).not.toContain('options-account.ts');
    expect(importers).not.toContain('exit-risk-rules-flag.ts');
  });
});

// ── AC2 ─────────────────────────────────────────────────────────────────────
describe('TRA-3942 AC2 — the refusal is COUNTABLE', () => {
  const DAY = EDT_DAY;

  beforeEach(() => { clearLiveEnforceGateLedger(); });

  it('carries the low-cardinality code `entry_window_closed`, not just prose', () => {
    const v = otmEntryWindowVerdict(at(EDT_DAY, '13:45'), resolveOtmEntryWindows({}));
    expect(v.reasonCode).toBe(OTM_ENTRY_WINDOW_CLOSED_CODE);
    expect(OTM_ENTRY_WINDOW_CLOSED_CODE).toBe('entry_window_closed');
    // The prose names the clock, the windows AND the entry/exit scope, so an
    // operator reading the feed does not have to guess which of the two it is.
    expect(v.reason).toContain('09:45 ET');
    expect(v.reason).toContain('10:15-11:30,15:00-15:45');
    expect(v.reason).toContain('exits unaffected');
  });

  it('the `entry_window` axis is published BEFORE it has ever fired', () => {
    // The key's PRESENCE in the census is the env-independent deployed-bytes
    // proof the gate shipped; its ABSENCE proves it did not. A gate that only
    // appears once it blocks cannot be graded on a quiet day.
    const row = summarizeLiveEnforceGate(DAY).byGate.find((g) => g.gate === 'entry_window');
    expect(row).toBeDefined();
    expect(row!.evaluated).toBe(0);
    expect(row!.blocked).toBe(0);
  });

  it('records BOTH verdicts, so the denominator separates "never bit" from "never wired"', () => {
    recordLiveEnforceDecision('entry_window', 'single_leg_otm', true, DAY, 'outside', 1, {
      reasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE, book: 'admin',
    });
    recordLiveEnforceDecision('entry_window', 'single_leg_otm', false, DAY, undefined, 2, {
      book: 'admin',
    });
    const row = summarizeLiveEnforceGate(DAY).byGate.find((g) => g.gate === 'entry_window')!;
    expect(row.evaluated).toBe(2);
    expect(row.blocked).toBe(1);
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────
describe('TRA-3942 — the gate is WIRED into the OTM open, first and in both books', () => {
  it('the OTM scan calls it, and `continue`s on the refusal', () => {
    const call = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    expect(call).toBeGreaterThan(-1);
    const block = ENGINE_SRC.slice(call, ENGINE_SRC.indexOf('\n        }\n', call));
    expect(block).toMatch(/if \(otmWindowReject\) \{/);
    // AC2's first counter: the scan's own `rejectionsByGate` bucket, keyed on
    // the SHARED constant so the code the scan counts and the code the ledger
    // records can never drift apart into two spellings of one refusal.
    expect(block).toMatch(/scanRun\.reject\(OTM_ENTRY_WINDOW_CLOSED_CODE\)/);
    expect(block).toMatch(/\n\s+continue;/);
  });

  it('it is ordered ABOVE the universe cut, the delta gates and the cost bar', () => {
    // The ordering IS the instrument (TRA-3504/TRA-3510): anything below the
    // cost bar sees ~0.7% of live nominees, so a gate ordered there publishes a
    // denominator a tighter sibling upstream already ate — the `evaluated: 0`
    // trap TRA-3926 paid for. This gate owns the whole nominee population.
    const window = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    const universe = ENGINE_SRC.indexOf('const otmUniverseReject = this.liveOtmUniverseRejectReason(');
    const costBar = ENGINE_SRC.indexOf("const otmCostReject = this.costAwareGateReject('single_leg_otm'");
    expect(universe).toBeGreaterThan(window);
    expect(costBar).toBeGreaterThan(window);
  });

  it('it is NOT mode-scoped — paper stays a valid mirror of live', () => {
    const body = methodBody(ENGINE_SRC, 'private otmEntryWindowRejectReason(');
    // Every OTHER private reject helper on this class opens with a
    // `mode !== 'live'` / `mode !== 'demo'` early return. This one must not:
    // that early return is exactly how paper and live would diverge.
    expect(body).not.toMatch(/if \(this\.mode !== '(live|demo)'\) return null;/);
    // The live LEDGER write is mode-scoped (the axis is a live-enforce axis);
    // the VERDICT is not.
    expect(body).toMatch(/if \(this\.mode === 'live'\) \{[\s\S]*recordLiveEnforceDecision\(/);
    expect(body).toMatch(/return verdict\.reason;/);
  });

  it('the call site surfaces the refusal on the feed, in both books', () => {
    const call = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    const block = ENGINE_SRC.slice(call, ENGINE_SRC.indexOf('\n        }\n', call));
    // The churn-brake pattern: `signalSkipReason` for BOTH books, and the live
    // twin only when the book is live.
    expect(block).toMatch(/signal\.signalSkipReason = otmWindowReject;/);
    expect(block).toMatch(/if \(this\.mode === 'live'\) signal\.liveSkipReason = otmWindowReject;/);
    expect(block).toMatch(/this\.recentSignals\.unshift\(signal\); this\.emitSignalAlert\(signal\);/);
  });
});

// ── AC4 ─────────────────────────────────────────────────────────────────────
describe('TRA-3942 AC4 — the real-money arm and the row caps are untouched', () => {
  it('the gate reads no arm, no notional cap and no contract ceiling', () => {
    const body = methodBody(ENGINE_SRC, 'private otmEntryWindowRejectReason(');
    for (const forbidden of [
      'isOptionLiveOtmArmed',
      'resolveLiveOptionTestNotionalCapUsd',
      'resolveLiveOptionTestMaxContracts',
      'resolveLiveOptionTestContracts',
      'resolveCanaryCeiling',
      'otmArmed',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('the window module reads nothing but its own env key and the ET clock', () => {
    const src = readFileSync(join(HERE, 'otm-entry-window.ts'), 'utf8');
    const envReads = [...src.matchAll(/env\[([A-Z_]+|'[^']+')\]/g)].map((m) => m[1]);
    expect(new Set(envReads)).toEqual(new Set(['OTM_ENTRY_WINDOWS_VALUE']));
    // One import, and it is the house ET helper — no offset arithmetic against
    // a hard-coded −4/−5 anywhere.
    expect(src).toMatch(/from '\.\/et-clock\.js'/);
    expect(src).not.toMatch(/[^a-zA-Z]-(4|5)\s*\*\s*60/);
  });
});
