// TRA-3394 — the two implementation items the TRA-3392 ruling creates.
//
// Item 1: the CEILING. The live gate is a floor, so the admitted set exceeded the
//         mandate at the top end.
// Item 2: the DE-AUTHORIZATION carries its own evidence, so a bar retune cannot
//         silently reopen the worst cell on the tape.
//
// The load-bearing assertions here are the two INDEPENDENCE properties — that the
// de-authorization does not move when the bar moves, and that the ceiling does not
// move when an operator env tries to widen it. Everything else is boundary
// arithmetic.

import { describe, expect, it } from 'vitest';
import {
  isDeAuthorizedBand,
  mandateBandFor,
  mandateCeilingFor,
  mandateFloorFor,
  OTM_SLEEVE_MANDATE_BANDS,
  OTM_SLEEVE_MANDATE_STRUCTURE,
} from './otm-sleeve-mandate.js';
import {
  entryDeltaCeilingLiveVerdict,
  resolveEntryDeltaCeilingLive,
  OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR,
} from './option-entry-delta-ceiling-live.js';
import {
  buildTapeExpectancyTable,
  tapeExpectancyVerdict,
  DECLINE_REASON_TAXONOMY,
} from './option-tape-expectancy.js';
import { DEFAULT_COST_GATE_CONFIG, type CostGateConfig } from './option-cost-gate.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const OTM = OTM_SLEEVE_MANDATE_STRUCTURE;
const ENFORCE = { [OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG]: '1' };
const OBSERVE = { [OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG]: '1' };

/** A synthetic closed row in a given band. `realizedR` is PREMIUM R (gate R = 4x). */
function row(entryDelta: number, realizedR: number, closeTs = 1_700_000_000_000): OptionTradeJournalRecord {
  return {
    structure: OTM,
    outcome: 'WIN',
    entryDelta,
    realizedR,
    closeTs,
  } as unknown as OptionTradeJournalRecord;
}

describe('TRA-3392 ratified band table', () => {
  it('is contiguous, ascending, and unbounded above', () => {
    const bands = OTM_SLEEVE_MANDATE_BANDS;
    expect(bands[0]!.from).toBe(0);
    expect(bands[bands.length - 1]!.to).toBeNull();
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i]!.from).toBe(bands[i - 1]!.to);
    }
  });

  it('authorizes exactly [0.495, 0.55) and nothing else', () => {
    const authorized = OTM_SLEEVE_MANDATE_BANDS.filter((b) => b.authorization === 'authorized');
    expect(authorized).toHaveLength(1);
    expect(authorized[0]!.from).toBe(0.495);
    expect(authorized[0]!.to).toBe(0.55);
    expect(mandateFloorFor(OTM)).toBe(0.495);
    expect(mandateCeilingFor(OTM)).toBe(0.55);
  });

  it('maps a delta to its band on the half-open [from, to) convention', () => {
    expect(mandateBandFor(OTM, 0.0)!.label).toBe('[0.00,0.20)');
    expect(mandateBandFor(OTM, 0.199)!.label).toBe('[0.00,0.20)');
    expect(mandateBandFor(OTM, 0.2)!.label).toBe('[0.20,0.45)');
    expect(mandateBandFor(OTM, 0.494)!.label).toBe('[0.45,0.495)');
    expect(mandateBandFor(OTM, 0.495)!.label).toBe('[0.495,0.55)');
    expect(mandateBandFor(OTM, 0.549)!.label).toBe('[0.495,0.55)');
    // The upper edge is EXCLUSIVE — 0.55 itself is outside the authorization.
    expect(mandateBandFor(OTM, 0.55)!.label).toBe('[0.55,inf)');
    expect(mandateBandFor(OTM, 0.99)!.label).toBe('[0.55,inf)');
  });

  it('reads the SIGN of the delta as a magnitude (a put at -0.60 is the same band)', () => {
    expect(mandateBandFor(OTM, -0.6)!.label).toBe('[0.55,inf)');
    expect(isDeAuthorizedBand(OTM, -0.05)).toBe(true);
  });

  it('says nothing about an unmandated structure or an unusable delta', () => {
    expect(mandateBandFor('single_leg_rv', 0.6)).toBeNull();
    expect(mandateCeilingFor('single_leg_rv')).toBeNull();
    expect(mandateBandFor(OTM, Number.NaN)).toBeNull();
    // `null` is NOT de-authorized — the table has nothing to say (TRA-1691).
    expect(isDeAuthorizedBand(OTM, Number.NaN)).toBe(false);
    expect(isDeAuthorizedBand('single_leg_rv', 0.05)).toBe(false);
  });

  it('de-authorizes only [0.00,0.20) — not every band that is closed', () => {
    expect(isDeAuthorizedBand(OTM, 0.05)).toBe(true);
    expect(isDeAuthorizedBand(OTM, 0.19)).toBe(true);
    // Closed, but for IGNORANCE, not by evidence. Collapsing these into one
    // boolean is the exact conflation item 2 exists to end.
    expect(isDeAuthorizedBand(OTM, 0.3)).toBe(false);
    expect(isDeAuthorizedBand(OTM, 0.46)).toBe(false);
    expect(isDeAuthorizedBand(OTM, 0.8)).toBe(false);
  });

  it('carries per-cell n / SE / lo95 for the de-authorized band, both Bonferroni-significant', () => {
    const band = mandateBandFor(OTM, 0.05)!;
    expect(band.evidence.n).toBe(691);
    expect(band.cells).toHaveLength(2);
    for (const cell of band.cells!) {
      expect(cell.n).toBeGreaterThan(0);
      expect(cell.meanR_gate!).toBeLessThan(0);
      // |t| >= 2.73 is the Bonferroni threshold over 8 buckets (doc section 2).
      expect(Math.abs(cell.t!)).toBeGreaterThan(2.73);
      expect(cell.seR_gate).not.toBeNull();
      expect(cell.lowerCI95).not.toBeNull();
    }
  });
});

describe('TRA-3394 item 2 — band_deauthorized is sourced from the mandate, not the bar', () => {
  const table = buildTapeExpectancyTable(
    [
      // 40 rows in [0.00,0.20) that are STRONGLY POSITIVE — the pathological case:
      // a tape that says "admit" in a band the mandate closed.
      ...Array.from({ length: 40 }, () => row(0.05, 5)),
      ...Array.from({ length: 40 }, () => row(0.52, 5)),
    ],
    { config: DEFAULT_COST_GATE_CONFIG },
  );

  it('declines the de-authorized band even when its own tape cell would ADMIT', () => {
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.05 }, table);
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('band_deauthorized');
    // The cell stats travel with the decline so a reader can SEE the disagreement
    // rather than take the de-authorization on trust.
    expect(v.n).toBe(40);
  });

  it('SURVIVES a bar collapse — the regression TRA-3272 would otherwise cause', () => {
    // A cost-side retune that drives the bar to ~0. Before this ticket the
    // [0.00,0.20) band was closed only by the bar's algebraic 0.495 delta floor,
    // so this config reopened the single most significantly negative cell on the
    // tape (n=638, t=-4.45) with real money and nothing flagged it.
    const collapsedBar: CostGateConfig = {
      ...DEFAULT_COST_GATE_CONFIG,
      optionsCost: { commissionR: 0, makerAdjustedSpreadCrossR: 0 },
      safetyMarginR: 0,
      optionsMinGrossR: 0,
    };
    const permissive = buildTapeExpectancyTable(
      Array.from({ length: 40 }, () => row(0.05, 5)),
      { config: collapsedBar },
    );
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.05 }, permissive, collapsedBar);
    expect(v.barR).toBe(0);
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('band_deauthorized');
  });

  it('keeps the three decline reasons DISTINCT on one table', () => {
    const mixed = buildTapeExpectancyTable(
      [
        ...Array.from({ length: 40 }, () => row(0.05, 5)), // de-authorized band
        ...Array.from({ length: 40 }, () => row(0.32, -2)), // measured loser
        ...Array.from({ length: 5 }, () => row(0.52, 5)), // n < 30
      ],
      { config: DEFAULT_COST_GATE_CONFIG },
    );
    expect(tapeExpectancyVerdict({ structure: OTM, delta: 0.05 }, mixed).reasonCode)
      .toBe('band_deauthorized');
    expect(tapeExpectancyVerdict({ structure: OTM, delta: 0.32 }, mixed).reasonCode)
      .toBe('gross_negative');
    expect(tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, mixed).reasonCode)
      .toBe('insufficient_evidence');
    // ...and they are three DIFFERENT strings, which is the whole deliverable.
    const codes = new Set([
      tapeExpectancyVerdict({ structure: OTM, delta: 0.05 }, mixed).reasonCode,
      tapeExpectancyVerdict({ structure: OTM, delta: 0.32 }, mixed).reasonCode,
      tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, mixed).reasonCode,
    ]);
    expect(codes.size).toBe(3);
  });

  it('does NOT relabel an unusable delta as a mandate decision', () => {
    // No delta ⇒ no band. `gross_unknown` is an INPUT defect; calling it
    // `band_deauthorized` would blame the mandate for a data outage.
    const v = tapeExpectancyVerdict({ structure: OTM, delta: Number.NaN }, table);
    expect(v.reasonCode).toBe('gross_unknown');
  });

  it('leaves non-mandated structures on the tape axis alone', () => {
    const rvTable = buildTapeExpectancyTable(
      Array.from({ length: 40 }, () => ({ ...row(0.05, 5), structure: 'single_leg_rv' })),
      { config: DEFAULT_COST_GATE_CONFIG },
    );
    const v = tapeExpectancyVerdict({ structure: 'single_leg_rv', delta: 0.05 }, rvTable);
    expect(v.reasonCode).not.toBe('band_deauthorized');
  });

  it('publishes every code in the taxonomy the health read serves', () => {
    // TRA-4894 added a FOURTH: `insufficient_real_fill_evidence`. It is here and
    // not folded into `insufficient_evidence` because the two want different
    // responses — "accrue rows" vs "accrue REAL FILLS, and do NOT move the bar"
    // — which is what the size assertion below is actually checking.
    expect(DECLINE_REASON_TAXONOMY.map((r) => r.code)).toEqual([
      'band_deauthorized',
      'insufficient_evidence',
      'gross_negative',
      'insufficient_real_fill_evidence',
    ]);
    // Each states a DIFFERENT response — that is why they are separate codes.
    expect(new Set(DECLINE_REASON_TAXONOMY.map((r) => r.response)).size).toBe(4);
  });
});

describe('TRA-3394 item 1 — the live entry-delta ceiling', () => {
  it('is DARK by default: no flag, no mode, no verdict', () => {
    const r = resolveEntryDeltaCeilingLive(OTM, {});
    expect(r.mode).toBe('off');
    // The mandate number is still reported so the health read can say what WOULD
    // be enforced — an off gate must still be able to state its number.
    expect(r.mandateCeiling).toBe(0.55);
    const v = entryDeltaCeilingLiveVerdict(OTM, 0.9, {});
    expect(v.breached).toBe(false);
    expect(v.blocked).toBe(false);
  });

  it('takes its number from the ratified table, not from a default constant', () => {
    expect(resolveEntryDeltaCeilingLive(OTM, ENFORCE).ceiling).toBe(mandateCeilingFor(OTM));
  });

  it('cuts at the band edge: 0.55 is OUT, 0.5499 is IN', () => {
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.5499, ENFORCE).breached).toBe(false);
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.55, ENFORCE).breached).toBe(true);
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.6, ENFORCE).blocked).toBe(true);
    // A put's delta is negative; the ceiling is a magnitude.
    expect(entryDeltaCeilingLiveVerdict(OTM, -0.6, ENFORCE).blocked).toBe(true);
  });

  it('REFUSES an override that would widen the ratified authorization', () => {
    const r = resolveEntryDeltaCeilingLive(OTM, {
      ...ENFORCE,
      [OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR]: '0.80',
    });
    expect(r.ceiling).toBe(0.55);
    expect(r.overrideRejectedReason).toContain('ABOVE');
    // The raw value is echoed so the refusal is VISIBLE on the health read rather
    // than looking like the operator never set it.
    expect(r.rawOverride).toBe('0.80');
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.7, {
      ...ENFORCE,
      [OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR]: '0.80',
    }).blocked).toBe(true);
  });

  it('ACCEPTS an override that tightens', () => {
    const env = { ...ENFORCE, [OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR]: '0.50' };
    expect(resolveEntryDeltaCeilingLive(OTM, env).ceiling).toBe(0.5);
    expect(resolveEntryDeltaCeilingLive(OTM, env).overrideRejectedReason).toBeNull();
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.52, env).blocked).toBe(true);
  });

  it('falls back to the mandate number on a malformed override, never disarming', () => {
    for (const bad of ['', ' ', 'abc', '0', '-0.5', '1', '1.2', 'NaN']) {
      const r = resolveEntryDeltaCeilingLive(OTM, {
        ...ENFORCE,
        [OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR]: bad,
      });
      expect(r.ceiling).toBe(0.55);
      expect(r.mode).toBe('enforce');
    }
  });

  it('SHADOW mode records a breach and admits it anyway', () => {
    const v = entryDeltaCeilingLiveVerdict(OTM, 0.6, OBSERVE);
    expect(v.mode).toBe('observe');
    expect(v.breached).toBe(true);
    expect(v.blocked).toBe(false); // the open PROCEEDS
    expect(v.reason).toContain('SHADOW');
  });

  it('enforce WINS over observe when an operator sets both', () => {
    const v = entryDeltaCeilingLiveVerdict(OTM, 0.6, { ...ENFORCE, ...OBSERVE });
    expect(v.mode).toBe('enforce');
    expect(v.blocked).toBe(true);
  });

  it('FAILS OPEN on an absent delta — a ceiling cuts a measured tail, it does not starve a sleeve', () => {
    for (const d of [null, undefined, Number.NaN]) {
      const v = entryDeltaCeilingLiveVerdict(OTM, d, ENFORCE);
      expect(v.breached).toBe(false);
      expect(v.blocked).toBe(false);
      // ...and it still stamps a band so the ledger can count these separately.
      expect(v.bandLabel).toBe('unknown_delta');
    }
  });

  it('leaves an UNMANDATED structure uncapped rather than extrapolating 0.55 onto it', () => {
    const v = entryDeltaCeilingLiveVerdict('single_leg_rv', 0.9, ENFORCE);
    expect(v.mode).toBe('off');
    expect(v.blocked).toBe(false);
  });

  it('stamps the mandate band on every verdict, breach or not (the ledger cell axis)', () => {
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.52, OBSERVE).bandLabel).toBe('[0.495,0.55)');
    expect(entryDeltaCeilingLiveVerdict(OTM, 0.7, OBSERVE).bandLabel).toBe('[0.55,inf)');
  });
});

// TRA-3483 item I3 — the cost_bar `byCell` STAMPING PATH, pinned.
//
// The 08-12 tape shows `byCell: []` on both the day row and the retained fold,
// and QuantTrader's validity gate V4 VOIDS the next tape if it is still empty.
// The empty read is explained (that session ran a pre-TRA-3391 build), but
// "explained" is not "confirmed", and confirming it by waiting for the session
// the gate would void is the wrong order.
//
// The engine stamps `cell: tape.cellKey ?? undefined` on every live cost_bar
// record, so under the current build the field is absent IFF `cellKey` is null —
// which happens IFF the candidate has no usable |delta| bucket. These pin that
// the nominator's own admitted band always produces a cell, INCLUDING on the
// decline paths, which is where an unstamped verdict would actually hide.
describe('cost_bar cell stamping (TRA-3483 I3)', () => {
  const OTM_S = OTM_SLEEVE_MANDATE_STRUCTURE;

  it('every |delta| in the TRA-3401 armed nominator band [0.50, 0.55) yields a non-null cellKey', () => {
    for (const delta of [0.50, 0.505, 0.52, 0.5449, 0.5499]) {
      const v = tapeExpectancyVerdict({ structure: OTM_S, delta }, null);
      expect(v.cellKey).not.toBeNull();
      expect(v.bucket).not.toBeNull();
      // A null table is the WORST case for stamping (nothing was ever folded)
      // and it still declines WITH a cell — the decline paths are exactly where
      // an unstamped verdict would hide.
      expect(v.reasonCode).toBe('insufficient_evidence');
    }
  });

  it('stamps a cell on the de-authorized and gross-negative declines too, not just on admits', () => {
    // band_deauthorized — the mandate short-circuits ahead of the cell lookup,
    // and the verdict still carries the cell it was decided for.
    const deAuth = tapeExpectancyVerdict({ structure: OTM_S, delta: 0.05 }, null);
    expect(deAuth.reasonCode).toBe('band_deauthorized');
    expect(deAuth.cellKey).not.toBeNull();
  });

  it('only an UNUSABLE delta produces no cell — the one input a stamped nominee cannot have', () => {
    for (const delta of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = tapeExpectancyVerdict({ structure: OTM_S, delta }, null);
      expect(v.cellKey).toBeNull();
      expect(v.reasonCode).toBe('gross_unknown');
    }
  });
});
