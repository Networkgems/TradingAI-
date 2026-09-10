import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import type { SetupTaxonomyDefinition } from '@trading-app/engine';
import {
  resolveSetupTaxonomyMode,
  resolveSetupTaxonomySetups,
  evaluateOtmSetupGate,
  setupTaxonomyHealth,
  scanWindowOpenMsSince,
  SETUP_CONFIRMATION_EXPECT_ROWS_AFTER_OPEN_MS,
  SETUP_CONFIRMATION_SCAN_WINDOW_MAX_LOOKBACK_MS,
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

// ─── THE SEAM, source-level (TRA-4422 §4) ────────────────────────────────────
// The tra2331/tra3218/tra3942 house pattern: line numbers shift, symbols do
// not. A predicate that is correct and unreached is the vacuous pass this repo
// keeps paying for — and for THIS gate it is worse than vacuous, because an
// unreached recorder publishes `evaluated: 0`, which is the exact reading the
// instrument exists to make impossible.
describe('TRA-4422 — the gate is WIRED into the OTM open, in the load-bearing position', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  // Normalised to LF: the checkout is CRLF on Windows, and a source-level
  // matcher that silently depends on the line ending is a grader that is green
  // on one developer's box and red on another's.
  const SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8').replace(/\r\n/g, '\n');
  const CALL = 'const setupDecision = this.otmSetupTaxonomyDecision(';

  it('the OTM scan calls it', () => {
    expect(SRC.indexOf(CALL)).toBeGreaterThan(-1);
    expect(SRC).toContain('private otmSetupTaxonomyDecision(');
    expect(SRC).toContain("from './otm-setup-gate.js'");
  });

  // ⛔ THE PLACEMENT IS THE INSTRUMENT. Both bounds are load-bearing and they
  // fail in opposite directions, so both are asserted.
  it('is ordered BELOW the nominator and ABOVE `entry_window`', () => {
    const call = SRC.indexOf(CALL);
    const nominator = SRC.indexOf('const otmPick = selectAdmissibleOtmCandidate(');
    const window = SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    const costBar = SRC.indexOf("const otmCostReject = this.costAwareGateReject('single_leg_otm'");

    // Above the nominator there is no nominee to stamp — nothing to score and
    // nothing to record.
    expect(call).toBeGreaterThan(nominator);

    // ⛔ BELOW `entry_window` THE DENOMINATOR IS STRUCTURALLY ZERO. The TRA-4217
    // hold pins the entry window to 03:00-03:01 ET, which cannot intersect RTH
    // (refusals were 607/607 on 09-02 and 671/671 on 09-03). A gate ordered
    // under it would be BORN reading `evaluated: 0` — indistinguishable from
    // never having been wired in, which is the failure this item exists to
    // detect. The design doc said only "above `cost_bar`"; that is necessary
    // and NOT sufficient, and this assertion is the difference.
    expect(window).toBeGreaterThan(call);
    expect(costBar).toBeGreaterThan(call);
  });

  it('nothing sits between it and `entry_window`, so the two denominators are EQUAL', () => {
    const call = SRC.indexOf(CALL);
    const window = SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(');
    // `setup_confirmation.evaluated === entry_window.evaluated` is a checkable
    // invariant on /api/health/live-enforce-gates ONLY while no other `continue`
    // can fire between them. A new refusal slipped in here would silently break
    // the equality — and the equality is how an operator tells "the recorder
    // stopped" from "the sleeve went quiet".
    const between = SRC.slice(call, window);
    const guard = between.slice(between.indexOf('if (setupDecision.blocked) {'));
    const tail = guard.slice(guard.indexOf('\n        }\n'));
    expect(tail).not.toMatch(/\bcontinue;/);
    expect(tail).not.toMatch(/scanRun\.reject\(/);
  });

  // ⛔ OBSERVE IS THE SHIPPED DEFAULT AND THE CALL SITE MUST NOT ASSUME IT.
  // The refusal branch is WIRED, not stubbed: a mode flag that reads `enforce`
  // and does nothing is the same class of lie this instrument was built to
  // catch, and a branch that cannot execute cannot be a negative control.
  it('wires a REAL refusal for enforce, surfaced on the feed and in `scanRun`', () => {
    const call = SRC.indexOf(CALL);
    const block = SRC.slice(call, SRC.indexOf('\n        }\n', call));
    expect(block).toMatch(/if \(setupDecision\.blocked\) \{/);
    expect(block).toMatch(/signal\.signalSkipReason = /);
    expect(block).toMatch(/signal\.signalSkipReasonCode = /);
    // TRA-4529 — the feed write (unshift + alert + cap) is one helper now.
    expect(block).toMatch(/this\.pushRecentSignal\(signal\);/);
    expect(block).toMatch(/scanRun\.reject\(/);
    expect(block).toMatch(/\n\s+continue;/);
  });

  // The recorder writes on BOTH verdicts. Only the admits supply `evaluated`,
  // and without a denominator "never had to bite" and "never wired in" are the
  // same JSON — which is the whole thesis of this item.
  it('records on BOTH verdicts, on the shared gate key, live-scoped like its siblings', () => {
    const at = SRC.indexOf('private otmSetupTaxonomyDecision(');
    const body = SRC.slice(at, SRC.indexOf('\n  }\n', at));
    // Recorded OUTSIDE any `blocked` guard — the call is unconditional within
    // the live branch.
    expect(body).toMatch(/if \(this\.mode === 'live'\) \{[\s\S]*recordLiveEnforceDecision\(/);
    // ⛔ AND NOTHING CONDITIONAL SITS BETWEEN THE TWO. Recording only the
    // refusals is the single most common way this gate could be wrong and stay
    // green: `evaluated` would then equal `blocked` forever, the denominator
    // would be gone, and "the taxonomy never had to bite" would once again be
    // unreadable — which is the entire defect this item was filed against. The
    // regex above alone does NOT catch that; this does.
    const anchor = "if (this.mode === 'live') {";
    const live = body.slice(body.indexOf(anchor) + anchor.length);
    const preamble = live.slice(0, live.indexOf('recordLiveEnforceDecision('));
    expect(preamble).not.toMatch(/\bif \(/);
    expect(preamble).not.toMatch(/\breturn\b/);
    expect(body).toMatch(/'setup_confirmation',\s*\n\s*'single_leg_otm',\s*\n\s*decision\.blocked,/);
    // No early return that would skip scoring — the verdict is computed on both
    // branches, which is what buys the admit/refuse counterfactual.
    expect(body).not.toMatch(/if \(this\.mode !== 'live'\) return/);
    // ⛔ A cold cache becomes an EMPTY SERIES, which the taxonomy reads as
    // `series_unreadable`. It must never be laundered into `no_setup_matched`.
    //
    // ⚠️ UPDATED BY TRA-4424. This used to pin `this.shadowCandleCache.get(sym)
    // ?? []` — the 5-MINUTE cache, ~6.15 trading days deep, against a taxonomy
    // of multi-day theses. The emptiness property is unchanged and still
    // asserted; the SERIES is now the daily one, and that swap is graded
    // behaviourally in `tra4424-otm-daily-series.test.ts` rather than only here.
    expect(body).toMatch(/const daily = readOtmDailySeries\(sym\);/);
    expect(body).toMatch(/series: daily\.bars,/);
    // ⛔ AND THE 5-MINUTE CACHE IS GONE FROM THIS SEAM. Asserting the daily read
    // is PRESENT does not assert the intraday one is ABSENT, and a seam that
    // fetched both and scored the wrong one would pass the line above.
    expect(body).not.toMatch(/shadowCandleCache/);
  });
});

/**
 * TRA-4422 Finding 3 — the escalation term behind `crossCheck`.
 *
 * The guard shipped in Finding 2 told the reader to escalate when the box had
 * been up for hours with `comparable` still false. Out of hours that rule is
 * false BY CONSTRUCTION: the scan is gated on `isStockMarketOpen()`, so no row
 * can be written and `comparable` cannot turn true however long the box runs.
 * These controls pin the discriminator that separates the two.
 */
describe('setup_confirmation cross-check: in-window time, not uptime (TRA-4422 Finding 3)', () => {
  // 2026-09-09 is a Wednesday; EDT, so RTH is 13:30Z-20:00Z.
  const RTH_MID = Date.parse('2026-09-09T14:00:00Z');
  const CLOSE = Date.parse('2026-09-09T20:00:00Z');

  it('THE INCIDENT, REPRODUCED: booted after the close, hours of uptime, zero in-window time', () => {
    // The real 2026-09-09 reading: boot 21:08:11Z, read 23:03Z, uptime 1.93h.
    const start = Date.parse('2026-09-09T21:08:11.359Z');
    const now = Date.parse('2026-09-09T23:03:00.000Z');
    const w = scanWindowOpenMsSince(start, now);
    expect(now - start).toBeGreaterThan(90 * 60_000); // hours of WALL-CLOCK uptime...
    expect(w.openMsSinceStart).toBe(0);               // ...and no opportunity at all.
    expect(w.marketOpenNow).toBe(false);
    // ⛔ The whole point: this must NOT escalate.
    expect(w.expectRows).toBe(false);
  });

  it('NEGATIVE CONTROL: in-window uptime past the threshold DOES escalate', () => {
    // A guard that never opens would suppress a real "sleeve is not scanning"
    // alarm forever and read exactly like a healthy box.
    const w = scanWindowOpenMsSince(RTH_MID, RTH_MID + 40 * 60_000);
    expect(w.marketOpenNow).toBe(true);
    expect(w.openMsSinceStart).toBe(40 * 60_000);
    expect(w.expectRows).toBe(true);
  });

  it('inside the session but below the threshold does not escalate yet', () => {
    const w = scanWindowOpenMsSince(RTH_MID, RTH_MID + 6 * 60_000);
    expect(w.marketOpenNow).toBe(true);
    expect(w.openMsSinceStart).toBe(6 * 60_000);
    expect(w.expectRows).toBe(false);
  });

  it('integrates only the in-window part of a span that straddles the close', () => {
    // Boot 15 minutes before the close, read an hour after it: exactly 15
    // minutes of opportunity, which is the threshold boundary.
    const w = scanWindowOpenMsSince(CLOSE - 15 * 60_000, CLOSE + 60 * 60_000);
    expect(w.openMsSinceStart).toBe(15 * 60_000);
    expect(w.marketOpenNow).toBe(false);
    expect(w.expectRows).toBe(true); // >= threshold, inclusive
  });

  it('a whole weekend of uptime accrues zero in-window time', () => {
    const sat = Date.parse('2026-09-12T15:00:00Z');
    const sun = Date.parse('2026-09-13T15:00:00Z');
    const w = scanWindowOpenMsSince(sat, sun);
    expect(sun - sat).toBe(24 * 60 * 60_000);
    expect(w.openMsSinceStart).toBe(0);
    expect(w.expectRows).toBe(false);
  });

  it('degenerate spans are zero, never negative, and never escalate', () => {
    expect(scanWindowOpenMsSince(RTH_MID, RTH_MID).openMsSinceStart).toBe(0);
    expect(scanWindowOpenMsSince(RTH_MID + 60_000, RTH_MID).expectRows).toBe(false);
    expect(scanWindowOpenMsSince(Number.NaN, RTH_MID).expectRows).toBe(false);
    expect(scanWindowOpenMsSince(RTH_MID, Number.NaN).expectRows).toBe(false);
  });

  it('reports truncation rather than silently understating a very old process', () => {
    const now = Date.parse('2026-09-09T18:00:00Z');
    const w = scanWindowOpenMsSince(now - SETUP_CONFIRMATION_SCAN_WINDOW_MAX_LOOKBACK_MS - 60_000, now);
    expect(w.truncated).toBe(true);
    expect(w.openMsSinceStart).toBeGreaterThan(0);
  });

  it('the threshold stays tied to the scan cadence it was derived from', () => {
    // ⛔ `OTM_SCAN_INTERVAL_MS` cannot be imported (signal-engine imports THIS
    // module), so the tie is asserted against the source. If someone retunes the
    // sweep cadence, this fails rather than leaving the threshold stale.
    const HERE2 = dirname(fileURLToPath(import.meta.url));
    const engineSrc = readFileSync(join(HERE2, 'signal-engine.ts'), 'utf8');
    const m = /const OTM_SCAN_INTERVAL_MS = (\d+) \* 60_000;/.exec(engineSrc);
    expect(m).not.toBeNull();
    const cadenceMs = Number(m![1]) * 60_000;
    expect(SETUP_CONFIRMATION_EXPECT_ROWS_AFTER_OPEN_MS).toBe(3 * cadenceMs);
  });
});
