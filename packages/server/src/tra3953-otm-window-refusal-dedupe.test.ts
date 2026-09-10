// TRA-3953 (parent TRA-3942, grandparent TRA-3927) — the OTM entry-window
// refusal was writing a 60-minute dedupe token, NARROWING the very window the
// gate was built to open.
//
// ── The defect ──────────────────────────────────────────────────────────────
// TRA-3942's reject parks its refused signal in `recentSignals` (the house
// churn-brake pattern, so the refusal is on the feed and not only in the log).
// `recentSignals` is ALSO the dedup ring, and the OTM dedup matched on `type` +
// `optionSymbol` and nothing else. So a refusal wrote a 60-minute ADMISSION
// token for the OCC it refused, and the suppressed re-nomination `continue`s
// before it ever reaches the window check again:
//
//   • first nominated 10:14 ET → first eligible 11:14 → 16 of the morning
//     window's 75 minutes survive;
//   • first nominated 14:59 ET → first eligible 15:59 → the 45-minute
//     afternoon window is missed COMPLETELY for that OCC that day.
//
// ── What is asserted ────────────────────────────────────────────────────────
//  AC1 — refused 10:14 ET, re-nominated 10:16 ET ⇒ ADMITTED.
//  AC2 — refused 14:20 ET ⇒ ADMITTED on the first sweep at/after 15:00 ET.
//  AC3 — every NON-window token keeps the flat hour; a genuine repeat of the
//        same OCC inside the same window still dedupes; and a full session of
//        out-of-window sweeps stays BOUNDED (not ~51 alerts). The bound is the
//        thing the dedup was buying and the fix must not spend it.
//  AC4 — source-level absence: the arm, the row size and the 2-row cap are not
//        read, and the `entry_window.evaluated` ordering is untouched (the
//        tra3942/tra2331 house pattern — line numbers shift, symbols do not).
//  AC5 — the wire field the deploy is graded on exists and is computed, not
//        stored.
//
// The clock instants below are EDT (2026-08-24, the Monday this lands before),
// and every one is re-run in JANUARY as the DST negative control: a fix that
// reached for `t + 45min` or a stored −4 offset passes the summer block and
// fails the winter one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveOtmEntryWindows,
  otmEntryWindowVerdict,
  nextOtmEntryWindowOpenMs,
  otmDedupeSuppressionEndMs,
  OTM_DEDUPE_CHURN_BRAKE_MS,
  OTM_ENTRY_WINDOW_CLOSED_CODE,
  OTM_ENTRY_WINDOWS_DEFAULT,
} from './otm-entry-window.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Normalised to LF: the checkout is CRLF on Windows, and a source-level matcher
// that silently depends on the line ending is green on one box and red on
// another (TRA-3942's note, and it applies verbatim here).
const ENGINE_SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8').replace(/\r\n/g, '\n');

const RULING = resolveOtmEntryWindows({} as NodeJS.ProcessEnv);
const MIN = 60_000;

/** EDT: ET = UTC−4. 2026-08-24 is the Monday the fix is aimed at. */
const edt = (hhmmEt: string): number => {
  const [h, m] = hhmmEt.split(':').map(Number);
  return Date.UTC(2026, 7, 24, h + 4, m, 0, 0);
};
/** EST: ET = UTC−5. 2027-01-11, a Monday, is the winter mirror. */
const est = (hhmmEt: string): number => {
  const [h, m] = hhmmEt.split(':').map(Number);
  return Date.UTC(2027, 0, 11, h + 5, m, 0, 0);
};

/** A ring entry as the window reject writes it (TRA-3942 call site). */
const windowRefusal = (atMs: number) => ({
  timestamp: atMs,
  signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE,
});
/** A ring entry as EVERY OTHER writer on this path leaves it. */
const plainToken = (atMs: number) => ({ timestamp: atMs });

/** Is the OCC's token still suppressing at `nowMs`? — the dedup predicate. */
const suppressed = (
  token: { timestamp: number; signalSkipReasonCode?: string },
  nowMs: number,
  resolution = RULING,
): boolean => nowMs < otmDedupeSuppressionEndMs(token, resolution);

// ── The clock helper the whole fix rests on ─────────────────────────────────
describe('TRA-3953 — nextOtmEntryWindowOpenMs', () => {
  it('resolves the NEXT open strictly after the instant, in both windows', () => {
    expect(nextOtmEntryWindowOpenMs(edt('09:30'), RULING)).toBe(edt('10:15'));
    expect(nextOtmEntryWindowOpenMs(edt('10:14'), RULING)).toBe(edt('10:15'));
    // Inside the morning window the next open is the AFTERNOON one — the open
    // it is standing in is behind it, not ahead.
    expect(nextOtmEntryWindowOpenMs(edt('10:20'), RULING)).toBe(edt('15:00'));
    expect(nextOtmEntryWindowOpenMs(edt('14:59'), RULING)).toBe(edt('15:00'));
  });

  it('STRICTLY after — an instant sitting exactly on an open looks past it', () => {
    // Half-open `[start, end)` upstream: 15:00:00 ET is INSIDE the window, so
    // the next OPEN is tomorrow morning, not this instant.
    expect(nextOtmEntryWindowOpenMs(edt('15:00'), RULING)).toBe(
      Date.UTC(2026, 7, 25, 14, 15, 0, 0),
    );
  });

  it('rolls to the next ET calendar day after the last window closes', () => {
    // 2026-08-24 is a Monday, so "tomorrow" is 08-25. This gate does not own
    // the trading calendar (its header says so) — the scan does not run when
    // the market is shut, and the token is long dead by then either way.
    expect(nextOtmEntryWindowOpenMs(edt('16:30'), RULING)).toBe(
      Date.UTC(2026, 7, 25, 14, 15, 0, 0),
    );
    expect(nextOtmEntryWindowOpenMs(edt('23:50'), RULING)).toBe(
      Date.UTC(2026, 7, 25, 14, 15, 0, 0),
    );
  });

  it('NEGATIVE CONTROL — the same ET wall clock in JANUARY is an hour later in UTC', () => {
    // A stored −4, or `open + 45min` arithmetic, passes every EDT case above
    // and fails every line here.
    expect(nextOtmEntryWindowOpenMs(est('09:30'), RULING)).toBe(est('10:15'));
    expect(nextOtmEntryWindowOpenMs(est('14:59'), RULING)).toBe(est('15:00'));
    expect(new Date(est('10:15')).getUTCHours()).toBe(15);
    expect(new Date(edt('10:15')).getUTCHours()).toBe(14);
  });

  it('follows an env override rather than the ruling', () => {
    const override = resolveOtmEntryWindows({
      OTM_ENTRY_WINDOWS_ET: '09:45-10:00,13:00-13:30',
    } as unknown as NodeJS.ProcessEnv);
    expect(override.source).toBe('env');
    expect(nextOtmEntryWindowOpenMs(edt('09:30'), override)).toBe(edt('09:45'));
    expect(nextOtmEntryWindowOpenMs(edt('10:30'), override)).toBe(edt('13:00'));
  });

  it('fails to NULL, never to a guess, on an instant that has no clock', () => {
    expect(nextOtmEntryWindowOpenMs(Number.NaN, RULING)).toBeNull();
    expect(nextOtmEntryWindowOpenMs(new Date(Number.NaN), RULING)).toBeNull();
  });

  it('a `00:00-24:00` widen still yields a real open, never the 24:00 edge', () => {
    const wide = resolveOtmEntryWindows({
      OTM_ENTRY_WINDOWS_ET: '00:00-24:00',
    } as unknown as NodeJS.ProcessEnv);
    const next = nextOtmEntryWindowOpenMs(edt('12:00'), wide);
    // Midnight tomorrow ET — the 24:00 END is not an open and must not be
    // resolved as hour 24 (which would silently roll a day).
    expect(next).toBe(Date.UTC(2026, 7, 25, 4, 0, 0, 0));
  });
});

// ── AC1 ─────────────────────────────────────────────────────────────────────
describe('TRA-3953 AC1 — refused 10:14 ET, re-nominated 10:16 ET is ADMITTED', () => {
  const token = windowRefusal(edt('10:14'));

  it('SUBJECT — the 10:16 sweep is not swallowed by `recent_duplicate`', () => {
    expect(suppressed(token, edt('10:16'))).toBe(false);
  });

  it('the token dies AT the open, to the minute — not 60 minutes later', () => {
    expect(otmDedupeSuppressionEndMs(token, RULING)).toBe(edt('10:15'));
    // What the defect did: `10:14 + 60min`.
    expect(otmDedupeSuppressionEndMs(token, RULING)).toBeLessThan(
      token.timestamp + OTM_DEDUPE_CHURN_BRAKE_MS,
    );
  });

  it('NEGATIVE CONTROL — the pre-fix predicate WOULD have swallowed it', () => {
    // The flat hour, spelled out. This is the line that has to move.
    expect(edt('10:16') - token.timestamp).toBeLessThan(OTM_DEDUPE_CHURN_BRAKE_MS);
  });

  it('it stays suppressed for the 60 seconds BEFORE the open — the brake is not disarmed', () => {
    expect(suppressed(token, edt('10:14') + 30_000)).toBe(true);
    expect(suppressed(token, edt('10:15') - 1)).toBe(true);
    expect(suppressed(token, edt('10:15'))).toBe(false);
  });

  it('and the window really is OPEN at 10:16, so admission is not vacuous', () => {
    expect(otmEntryWindowVerdict(edt('10:16'), RULING).open).toBe(true);
    expect(otmEntryWindowVerdict(edt('10:14'), RULING).open).toBe(false);
  });

  it('DST MIRROR — identical in January', () => {
    const winter = windowRefusal(est('10:14'));
    expect(otmDedupeSuppressionEndMs(winter, RULING)).toBe(est('10:15'));
    expect(suppressed(winter, est('10:16'))).toBe(false);
  });
});

// ── AC2 ─────────────────────────────────────────────────────────────────────
describe('TRA-3953 AC2 — refused 14:20 ET is ADMITTED on the first sweep at/after 15:00 ET', () => {
  const token = windowRefusal(edt('14:20'));

  it('SUBJECT — 15:00 ET, the first sweep of the afternoon window', () => {
    expect(suppressed(token, edt('15:00'))).toBe(false);
    expect(otmEntryWindowVerdict(edt('15:00'), RULING).open).toBe(true);
  });

  it('the pre-fix token would have run to 15:20 — a third of the window', () => {
    expect(token.timestamp + OTM_DEDUPE_CHURN_BRAKE_MS).toBe(edt('15:20'));
    expect(otmDedupeSuppressionEndMs(token, RULING)).toBe(edt('15:00'));
  });

  it('THE WORST CASE the filing names — 14:59 ET lost the WHOLE window', () => {
    const late = windowRefusal(edt('14:59'));
    // Pre-fix: eligible 15:59, and the window shuts at 15:45. Zero minutes.
    expect(late.timestamp + OTM_DEDUPE_CHURN_BRAKE_MS).toBe(edt('15:59'));
    expect(otmEntryWindowVerdict(edt('15:59'), RULING).open).toBe(false);
    // Post-fix: eligible at 15:00, with all 45 minutes intact.
    expect(otmDedupeSuppressionEndMs(late, RULING)).toBe(edt('15:00'));
    expect(suppressed(late, edt('15:00'))).toBe(false);
  });

  it('every minute of 14:15–15:00 ET recovers its full window', () => {
    // The filing's quantified band, half-open at 15:00 — at 15:00 itself the
    // window is OPEN, so there is no refusal to hold a token. One assertion per
    // minute, because the failure it replaces was also a per-minute one.
    for (let m = 0; m < 45; m += 1) {
      const at = edt('14:15') + m * MIN;
      const t = windowRefusal(at);
      expect(otmDedupeSuppressionEndMs(t, RULING), `14:15+${m}`).toBe(edt('15:00'));
      expect(suppressed(t, edt('15:00')), `14:15+${m}`).toBe(false);
    }
  });

  it('DST MIRROR — identical in January', () => {
    const winter = windowRefusal(est('14:20'));
    expect(otmDedupeSuppressionEndMs(winter, RULING)).toBe(est('15:00'));
    expect(suppressed(winter, est('15:00'))).toBe(false);
  });
});

// ── AC3 ─────────────────────────────────────────────────────────────────────
describe('TRA-3953 AC3 — the churn-brake is NOT disarmed', () => {
  it('a NON-window token keeps the flat 60 minutes, unchanged', () => {
    // `live_universe`, the delta ceiling/floor and the cost bar all park their
    // reject in the same ring with no `signalSkipReasonCode`. Those refuse a
    // candidate that was never tradeable, so nothing about it changes inside
    // the hour and the token must not shorten.
    for (const at of [edt('09:30'), edt('10:14'), edt('14:20'), edt('14:59')]) {
      const t = plainToken(at);
      expect(otmDedupeSuppressionEndMs(t, RULING)).toBe(at + OTM_DEDUPE_CHURN_BRAKE_MS);
      // …including straight THROUGH a window open, which is the whole point of
      // the split: 14:59 + 60min = 15:59 for a universe reject, 15:00 for a
      // window one.
      expect(suppressed(t, at + 59 * MIN)).toBe(true);
      expect(suppressed(t, at + 60 * MIN)).toBe(false);
    }
  });

  it('an UNRELATED code is not the window code, and gets the flat hour', () => {
    const t = { timestamp: edt('14:20'), signalSkipReasonCode: 'entry_window_clock_unreadable' };
    expect(otmDedupeSuppressionEndMs(t, RULING)).toBe(edt('15:20'));
  });

  it('a genuine repeat of the SAME OCC INSIDE the same window still dedupes for 60 min', () => {
    // The admitted signal carries no code, so the sweep 5 minutes later is
    // swallowed exactly as it was before this ticket. This is the assertion
    // that stops the fix from re-spamming the feed inside a window.
    const admitted = plainToken(edt('10:20'));
    for (let m = 5; m <= 55; m += 5) {
      expect(suppressed(admitted, edt('10:20') + m * MIN), `+${m}m`).toBe(true);
    }
    expect(suppressed(admitted, edt('10:20') + 60 * MIN)).toBe(false);
  });

  it('BOUND — one OCC held out-of-window for a full session is not ~51 alerts', () => {
    // Replay the real cadence: `OTM_SCAN_INTERVAL_MS = 5 * 60_000`, 09:30→16:00
    // ET, the OCC winning the `|mispricingPct|` ranking on every sweep. Windows
    // that never open, so EVERY sweep is a window refusal and the bound is
    // measured on the axis the filing named.
    const shut = resolveOtmEntryWindows({
      OTM_ENTRY_WINDOWS_ET: '03:00-03:30',
    } as unknown as NodeJS.ProcessEnv);
    let alerts = 0;
    let token: { timestamp: number; signalSkipReasonCode?: string } | null = null;
    let sweeps = 0;
    for (let at = edt('09:30'); at <= edt('16:00'); at += 5 * MIN) {
      sweeps += 1;
      if (token && suppressed(token, at, shut)) continue;
      alerts += 1;
      token = windowRefusal(at);
    }
    expect(sweeps).toBe(79);
    // Pre-fix this was ~7 (one per hour) and the un-braked count is 79. The fix
    // must not move it: a window that never opens caps the token at the flat
    // hour, because `min(t+60, nextOpen)` is `t+60` when the next open is
    // tomorrow.
    expect(alerts).toBe(7);
    expect(alerts).toBeLessThan(sweeps / 5);
  });

  it('BOUND — and with the REAL windows the session stays in single digits', () => {
    // Same replay against the board's ruling. Refusals now expire at each open,
    // so the OCC is admitted three times and refused a handful of times — the
    // brake is spending its budget on admissions instead of on refusals, which
    // is exactly the trade this ticket is.
    let refusals = 0;
    let admissions = 0;
    let token: { timestamp: number; signalSkipReasonCode?: string } | null = null;
    for (let at = edt('09:30'); at <= edt('16:00'); at += 5 * MIN) {
      if (token && suppressed(token, at)) continue;
      if (otmEntryWindowVerdict(at, RULING).open) {
        admissions += 1;
        token = plainToken(at);
      } else {
        refusals += 1;
        token = windowRefusal(at);
      }
    }
    expect(admissions).toBeGreaterThan(0);
    expect(refusals).toBeLessThan(10);
    expect(refusals + admissions).toBeLessThan(15);
  });

  it('an unreadable clock buys TODAY’S behaviour, not a disarmed dedup', () => {
    // `nextOtmEntryWindowOpenMs` returns null and the token falls back to the
    // full hour. Fail-closed in the direction that matters here: the expensive
    // failure of a broken clock is 51 alerts a sweep, not one missed entry.
    const t = { timestamp: Number.NaN, signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE };
    expect(Number.isNaN(otmDedupeSuppressionEndMs(t, RULING))).toBe(true);
    // NaN compares false against everything, so the predicate reads NOT
    // suppressed — a signal with no timestamp cannot hold a token, and it
    // cannot manufacture an infinite one either.
    expect(suppressed(t, edt('10:16'))).toBe(false);
  });
});

// ── The wiring: a correct predicate that is unreached is a vacuous pass ─────
describe('TRA-3953 — the predicate is WIRED into the OTM dedup', () => {
  it('the OTM dedup reads the per-token end, not a flat hour literal', () => {
    const at = ENGINE_SRC.indexOf('const otmDedupeWindows = resolveOtmEntryWindows(process.env);');
    expect(at).toBeGreaterThan(-1);
    const block = ENGINE_SRC.slice(at, ENGINE_SRC.indexOf('recent_duplicate', at) + 40);
    expect(block).toMatch(/nowMs < otmDedupeSuppressionEndMs\(s, otmDedupeWindows\)/);
    expect(block).toMatch(/scanRun\.reject\('recent_duplicate'\)/);
    // The literal the fix replaces must be gone from THIS dedup. The other
    // three `recentDup` sites on this class are different scans and keep theirs.
    expect(block).not.toMatch(/Date\.now\(\) - s\.timestamp < 60 \* 60_000/);
  });

  it('the window reject STAMPS the code the predicate keys on', () => {
    const call = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    expect(call).toBeGreaterThan(-1);
    const block = ENGINE_SRC.slice(call, ENGINE_SRC.indexOf('\n        }\n', call));
    expect(block).toMatch(/signal\.signalSkipReasonCode = OTM_ENTRY_WINDOW_CLOSED_CODE;/);
    // TRA-3942's write is untouched — prose for the feed, code for the machine.
    expect(block).toMatch(/signal\.signalSkipReason = otmWindowReject;/);
    expect(block).toMatch(/if \(this\.mode === 'live'\) signal\.liveSkipReason = otmWindowReject;/);
  });

  it('the STAMP is upstream of the ring write, so the token is never uncoded', () => {
    const call = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    const block = ENGINE_SRC.slice(call, ENGINE_SRC.indexOf('\n        }\n', call));
    const stamp = block.indexOf('signal.signalSkipReasonCode =');
    // TRA-4529 — the ring write goes through the one helper.
    const unshift = block.indexOf('this.pushRecentSignal(signal)');
    expect(stamp).toBeGreaterThan(-1);
    expect(unshift).toBeGreaterThan(stamp);
  });

  it('NO OTHER writer stamps the WINDOW code — one producer, so the key stays unambiguous', () => {
    // TRA-3944 added a second writer of the FIELD (the contract-floor codes,
    // `contract_floor_*`), which is fine: the dedup keys on the VALUE, and the
    // invariant this guards is that `entry_window_closed` has exactly one
    // producer. Assert that, not the field's writer count.
    const windowStamps = [...ENGINE_SRC.matchAll(/signalSkipReasonCode\s*=\s*OTM_ENTRY_WINDOW_CLOSED_CODE/g)];
    expect(windowStamps).toHaveLength(1);
    const allStamps = [...ENGINE_SRC.matchAll(/signalSkipReasonCode\s*=/g)];
    for (const m of allStamps) {
      const line = ENGINE_SRC.slice(m.index!, ENGINE_SRC.indexOf('\n', m.index!));
      // Every other writer stamps a NAMED code from another module, never a literal.
      // TRA-4422 added a THIRD writer (the setup taxonomy), and it joins this
      // roster rather than being exempted from it: `skipReasonCode` is resolved
      // inside `otm-setup-gate.ts`, which owns the vocabulary, precisely so this
      // line stays a named read. A census a new writer can slip past silently is
      // not a census.
      expect(line).toMatch(/= (OTM_ENTRY_WINDOW_CLOSED_CODE|otmFloorPick\.code|setupDecision\.skipReasonCode);/);
    }
  });
});

// ── AC4 ─────────────────────────────────────────────────────────────────────
describe('TRA-3953 AC4 — the arm, the caps and the denominator are untouched', () => {
  const SRC = readFileSync(join(HERE, 'otm-entry-window.ts'), 'utf8');

  it('the window module still reads nothing but its own env key and the ET clock', () => {
    const envReads = [...SRC.matchAll(/env\[([A-Z_]+|'[^']+')\]/g)].map((m) => m[1]);
    expect(new Set(envReads)).toEqual(new Set(['OTM_ENTRY_WINDOWS_VALUE']));
    expect(SRC).toMatch(/from '\.\/et-clock\.js'/);
    // No offset constant crept in with the next-open arithmetic. This is the
    // line the DST mirror above is the behavioural twin of.
    expect(SRC).not.toMatch(/[^a-zA-Z]-(4|5)\s*\*\s*60/);
    // …and exactly one import statement, still.
    expect([...SRC.matchAll(/^import /gm)]).toHaveLength(1);
  });

  it('neither new function reads an arm, a notional cap or a contract ceiling', () => {
    const from = SRC.indexOf('export function nextOtmEntryWindowOpenMs(');
    const to = SRC.indexOf('export function otmEntryWindowsUtcAt(');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = SRC.slice(from, to);
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

  it('the window definitions themselves are byte-for-byte the board ruling', () => {
    expect(OTM_ENTRY_WINDOWS_DEFAULT).toEqual([
      { startMin: 615, endMin: 690 },
      { startMin: 900, endMin: 945 },
    ]);
    expect(RULING.source).toBe('default');
  });

  it('`entry_window.evaluated` still counts the WHOLE nominee population', () => {
    // The ordering IS the denominator (TRA-3942's note, TRA-3926's trap). The
    // dedup sits ABOVE the window and always did; this ticket changes WHICH
    // tokens it holds, not where it sits. A dedup pushed BELOW the window would
    // "fix" AC1 by making the window evaluate a population the brake already
    // ate — the exact `evaluated: 0` failure `fleet_reachable_bound` paid for.
    const dedup = ENGINE_SRC.indexOf('const otmDedupeWindows = resolveOtmEntryWindows(process.env);');
    const window = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    const universe = ENGINE_SRC.indexOf('const otmUniverseReject = this.liveOtmUniverseRejectReason(');
    const costBar = ENGINE_SRC.indexOf("const otmCostReject = this.costAwareGateReject('single_leg_otm'");
    expect(dedup).toBeGreaterThan(-1);
    expect(window).toBeGreaterThan(dedup);
    expect(universe).toBeGreaterThan(window);
    expect(costBar).toBeGreaterThan(window);
  });

  it('the refusal still records its ledger row and its daily-signal row', () => {
    const call = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    const block = ENGINE_SRC.slice(call, ENGINE_SRC.indexOf('\n        }\n', call));
    expect(block).toMatch(/this\.dailySignals\.push\(/);
    expect(block).toMatch(/scanRun\.reject\(OTM_ENTRY_WINDOW_CLOSED_CODE\)/);
  });
});

// ── AC5 ─────────────────────────────────────────────────────────────────────
describe('TRA-3953 AC5 — the fix is READABLE ON THE WIRE', () => {
  const INDEX_SRC = readFileSync(join(HERE, 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('`/api/health/options-live` publishes the refusal-dedupe posture', () => {
    const at = INDEX_SRC.indexOf('refusalDedupe: (() => {');
    expect(at).toBeGreaterThan(-1);
    const block = INDEX_SRC.slice(at, INDEX_SRC.indexOf('})(),', at));
    expect(block).toMatch(/issue: 'TRA-3953'/);
    expect(block).toMatch(/windowRefusalExpiresAtNextOpen: true as const/);
    expect(block).toMatch(/nextWindowOpenUtc/);
    expect(block).toMatch(/churnBrakeMs: OTM_DEDUPE_CHURN_BRAKE_MS/);
  });

  it('it sits INSIDE the `otmEntryWindows` block, on the same resolution the gate uses', () => {
    // A posture field computed off a second, independently-resolved copy of the
    // windows can disagree with the gate and still read green.
    const block = INDEX_SRC.indexOf('otmEntryWindows: (() => {');
    const refusal = INDEX_SRC.indexOf('refusalDedupe: (() => {');
    expect(refusal).toBeGreaterThan(block);
    expect(INDEX_SRC.slice(refusal, refusal + 400)).toMatch(
      /nextOtmEntryWindowOpenMs\(now, resolution\)/,
    );
  });

  it('`nextWindowOpenUtc` is COMPUTED, so a January read moves and a stored one would not', () => {
    const summer = nextOtmEntryWindowOpenMs(edt('09:30'), RULING);
    const winter = nextOtmEntryWindowOpenMs(est('09:30'), RULING);
    expect(new Date(summer!).toISOString()).toBe('2026-08-24T14:15:00.000Z');
    expect(new Date(winter!).toISOString()).toBe('2027-01-11T15:15:00.000Z');
  });
});
