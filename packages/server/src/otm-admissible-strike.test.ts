import { describe, it, expect } from 'vitest';
import {
  isOtmAdmissibleStrikeEnabled,
  resolveAdmissibleBand,
  selectAdmissibleOtmCandidate,
  OTM_ADMISSIBLE_DELTA_MIN_DEFAULT,
  OTM_ADMISSIBLE_DELTA_MAX_DEFAULT,
} from './otm-admissible-strike.js';

const band = { min: OTM_ADMISSIBLE_DELTA_MIN_DEFAULT, max: OTM_ADMISSIBLE_DELTA_MAX_DEFAULT };

/** Rank order = scanner order (sorted by |mispricingPct| descending). */
const cand = (delta: number, classification = 'cheap') => ({ delta, classification });

describe('flag + band resolution (TRA-3401)', () => {
  it('is OFF by default and armed only for truthy values', () => {
    expect(isOtmAdmissibleStrikeEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isOtmAdmissibleStrikeEnabled({ ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT: v })).toBe(true);
    }
    for (const v of ['0', 'false', '', 'maybe']) {
      expect(isOtmAdmissibleStrikeEnabled({ ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT: v })).toBe(false);
    }
  });

  it('defaults to the TRA-3392 ratified band [0.495, 0.55)', () => {
    expect(resolveAdmissibleBand({})).toEqual({ min: 0.495, max: 0.55 });
  });

  it('honours explicit edges and rejects malformed ones', () => {
    expect(resolveAdmissibleBand({ OTM_ADMISSIBLE_DELTA_MIN: '0.50' }).min).toBe(0.5);
    expect(resolveAdmissibleBand({ OTM_ADMISSIBLE_DELTA_MAX: '0.60' }).max).toBe(0.6);
    for (const bad of ['abc', '', '0', '1', '-0.2', '3']) {
      expect(resolveAdmissibleBand({ OTM_ADMISSIBLE_DELTA_MIN: bad }).min)
        .toBe(OTM_ADMISSIBLE_DELTA_MIN_DEFAULT);
    }
  });

  it('falls back to BOTH defaults on an inverted band rather than admitting nothing', () => {
    expect(resolveAdmissibleBand({
      OTM_ADMISSIBLE_DELTA_MIN: '0.80',
      OTM_ADMISSIBLE_DELTA_MAX: '0.20',
    })).toEqual({ min: 0.495, max: 0.55 });
  });
});

describe('selectAdmissibleOtmCandidate (TRA-3401)', () => {
  // The live shape: the scanner's top read is a far-OTM lottery strike, and a
  // near-ATM cheap candidate sits further down the SAME chain. Under the legacy
  // find, the bar rejects the nominee `gross_negative` and the symbol is lost.
  const chain = [cand(0.04), cand(0.18), cand(0.51), cand(0.62)];

  it('DISARMED is byte-identical to the legacy find()', () => {
    const legacy = chain.find((c) => c.classification === 'cheap');
    const got = selectAdmissibleOtmCandidate(chain, { enabled: false, band });
    expect(got.candidate).toBe(legacy);
    expect(got.candidate!.delta).toBe(0.04);
    expect(got.selection).toBe('legacy');
  });

  it('ARMED nominates the in-band strike instead of the lottery tail', () => {
    const got = selectAdmissibleOtmCandidate(chain, { enabled: true, band });
    expect(got.candidate!.delta).toBe(0.51);
    expect(got.selection).toBe('in_band');
    expect(got.cheapConsidered).toBe(4);
    expect(got.cheapInBand).toBe(1);
  });

  it('the nominated delta actually clears the cost bar the legacy pick fails', () => {
    // The shipped estimator: grossR = 3|d| - 1, admitted iff >= 0.485R.
    const grossR = (d: number) => 3 * Math.abs(d) - 1;
    const legacy = selectAdmissibleOtmCandidate(chain, { enabled: false, band }).candidate!;
    const armed = selectAdmissibleOtmCandidate(chain, { enabled: true, band }).candidate!;
    expect(grossR(legacy.delta)).toBeLessThan(0); // `gross_negative`
    expect(grossR(armed.delta)).toBeGreaterThanOrEqual(0.485); // admitted
  });

  it('preserves mispricing rank order WITHIN the band', () => {
    // Two admissible strikes; the earlier one is the stronger mispricing read.
    const got = selectAdmissibleOtmCandidate(
      [cand(0.02), cand(0.499), cand(0.54)],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.499);
    expect(got.cheapInBand).toBe(2);
  });

  it('excludes the upper edge (0.55 is TRA-1670 loss-tail territory)', () => {
    const got = selectAdmissibleOtmCandidate([cand(0.55), cand(0.549)], { enabled: true, band });
    expect(got.candidate!.delta).toBe(0.549);
    expect(got.cheapInBand).toBe(1);
  });

  it('includes the lower edge (0.495 is exactly the bar)', () => {
    const got = selectAdmissibleOtmCandidate([cand(0.02), cand(0.495)], { enabled: true, band });
    expect(got.candidate!.delta).toBe(0.495);
  });

  it('treats puts by MAGNITUDE, not sign', () => {
    const got = selectAdmissibleOtmCandidate([cand(-0.03), cand(-0.52)], { enabled: true, band });
    expect(got.candidate!.delta).toBe(-0.52);
    expect(got.selection).toBe('in_band');
  });

  it('ignores non-cheap classifications on both paths', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.51, 'expensive'), cand(0.03), cand(0.52)],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.52);
    expect(got.cheapConsidered).toBe(2);
  });

  it('a non-finite delta fails the band (TRA-1407 predicate parity)', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(Number.NaN), cand(0.51)],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.51);
  });

  // The safety property that makes arming this reversible: the flag can only ADD
  // admissible nominations. It never suppresses a signal the legacy path emitted.
  it('ARMED with nothing in band keeps the legacy nominee and SAYS so', () => {
    const thin = [cand(0.03), cand(0.11)];
    const got = selectAdmissibleOtmCandidate(thin, { enabled: true, band });
    expect(got.candidate!.delta).toBe(0.03);
    expect(got.candidate).toBe(selectAdmissibleOtmCandidate(thin, { enabled: false, band }).candidate);
    expect(got.selection).toBe('fallback_top_mispricing');
    expect(got.cheapInBand).toBe(0);
  });

  it('an empty / no-cheap chain reports `none`, not a silent drop', () => {
    for (const c of [[], [cand(0.5, 'expensive')]]) {
      const got = selectAdmissibleOtmCandidate(c, { enabled: true, band });
      expect(got.candidate).toBeNull();
      expect(got.selection).toBe('none');
      expect(got.cheapConsidered).toBe(0);
    }
  });

  it('echoes the applied band so a verdict needs no re-derivation', () => {
    const custom = { min: 0.4, max: 0.6 };
    expect(selectAdmissibleOtmCandidate(chain, { enabled: true, band: custom }).band).toEqual(custom);
  });
});
