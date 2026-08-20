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

  it('an in-band `cheap` outranks an in-band `expensive` that sorts higher', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.51, 'expensive'), cand(0.03), cand(0.52)],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.52);
    expect(got.selection).toBe('in_band');
    expect(got.cheapConsidered).toBe(2);
  });

  // ── TRA-3856: the band-first tiers ──────────────────────────────────────────

  it('TIER 2: no `cheap` in band nominates the strongest `fair` in band', () => {
    // The TRA-3859-measured live shape: every in-band strike classifies `fair`.
    const got = selectAdmissibleOtmCandidate(
      [cand(0.03), cand(0.52, 'fair'), cand(0.50, 'fair')],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.52); // rank order preserved within the tier
    expect(got.selection).toBe('in_band_fair');
    expect(got.cheapInBand).toBe(0);
    expect(got.strikesInBand).toBe(2);
  });

  it('TIER 1 beats TIER 2 even when the fair strike is the stronger read', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.52, 'fair'), cand(0.50, 'cheap')],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.50);
    expect(got.selection).toBe('in_band');
  });

  it('`expensive` is nominated under NO tier — an all-expensive band abstains', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.51, 'expensive'), cand(0.52, 'expensive')],
      { enabled: true, band },
    );
    expect(got.candidate).toBeNull();
    expect(got.selection).toBe('abstain_no_in_band');
    expect(got.strikesInBand).toBe(2);
  });

  it('REGRESSION (TRA-3856): the old fallback chain now ABSTAINS instead of nominating the lottery tail', () => {
    // Exactly the chain shape that produced 766/766 blocked over 08-05→08-19:
    // cheap candidates exist, none in band. The old branch nominated cand(0.03).
    const thin = [cand(0.03), cand(0.11)];
    const got = selectAdmissibleOtmCandidate(thin, { enabled: true, band });
    expect(got.candidate).toBeNull();
    expect(got.selection).toBe('abstain_no_in_band');
    expect(got.cheapConsidered).toBe(2);
    expect(got.cheapInBand).toBe(0);
  });

  it('a non-finite delta fails the band (TRA-1407 predicate parity)', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(Number.NaN), cand(0.51)],
      { enabled: true, band },
    );
    expect(got.candidate!.delta).toBe(0.51);
  });

  // TRA-3856 — the reversibility story CHANGED, on purpose: armed, the selector
  // may now SUPPRESS a nomination the legacy path would have emitted, because
  // that nomination was a guaranteed downstream reject (far-OTM, |Δ| < 0.495 ⇒
  // gross_negative). Disarming the flag still restores legacy byte-for-byte.
  it('DISARMED is untouched by TRA-3856 — the same thin chain still yields the legacy nominee', () => {
    const thin = [cand(0.03), cand(0.11)];
    const got = selectAdmissibleOtmCandidate(thin, { enabled: false, band });
    expect(got.candidate!.delta).toBe(0.03);
    expect(got.selection).toBe('legacy');
  });

  it('an EMPTY chain reports `none` (market data), a surveyed band-empty chain abstains (band)', () => {
    const empty = selectAdmissibleOtmCandidate([], { enabled: true, band });
    expect(empty.candidate).toBeNull();
    expect(empty.selection).toBe('none');
    expect(empty.cheapConsidered).toBe(0);

    const surveyed = selectAdmissibleOtmCandidate([cand(0.5, 'expensive')], { enabled: true, band });
    expect(surveyed.candidate).toBeNull();
    expect(surveyed.selection).toBe('abstain_no_in_band');
  });

  it('echoes the applied band so a verdict needs no re-derivation', () => {
    const custom = { min: 0.4, max: 0.6 };
    expect(selectAdmissibleOtmCandidate(chain, { enabled: true, band: custom }).band).toEqual(custom);
  });
});

// ── TRA-3619: the pre-classification band count ──────────────────────────────
//
// `cheapInBand: 0` on an abstaining row is JOINTLY caused, and the two causes
// call for opposite actions:
//
//   State A — the chain holds no strike in the band at all. The band edges are
//             the question; no selection policy can conjure a strike.
//   State B — the chain holds in-band strikes and none was nominable (since
//             TRA-3856 that means ALL of them classified `expensive`; before it,
//             the cheapness screen ran first and dropped `fair` ones too).
//
// Every test below is a discrimination test: same `cheapInBand`, different world.
describe('strikesInBand — the pre-classification band count (TRA-3619)', () => {
  it('STATE B: an in-band strike no tier can nominate is still COUNTED', () => {
    // 0.51 is inside [0.495, 0.55) but classified `expensive` — excluded from
    // every tier. TRA-3856 note: the `fair` 0.52 that used to be dropped by the
    // cheapness screen is now the TIER-2 nominee, so state B requires the whole
    // band to be `expensive`.
    const got = selectAdmissibleOtmCandidate(
      [cand(0.03), cand(0.51, 'expensive'), cand(0.62, 'fair')],
      { enabled: true, band },
    );
    expect(got.selection).toBe('abstain_no_in_band');
    expect(got.cheapInBand).toBe(0);       // what the deployed surface shows...
    expect(got.strikesInBand).toBe(1);     // ...and what it could not show.
    expect(got.strikesConsidered).toBe(3);
  });

  it('STATE A: a chain with no in-band strike reads ZERO on both counts', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.03), cand(0.11, 'expensive'), cand(0.62, 'fair')],
      { enabled: true, band },
    );
    expect(got.selection).toBe('abstain_no_in_band');
    expect(got.cheapInBand).toBe(0);
    expect(got.strikesInBand).toBe(0);
    expect(got.strikesConsidered).toBe(3);
  });

  it('the two states are INDISTINGUISHABLE without it — same selection, same cheapInBand', () => {
    const stateB = selectAdmissibleOtmCandidate(
      [cand(0.03), cand(0.51, 'expensive')], { enabled: true, band },
    );
    const stateA = selectAdmissibleOtmCandidate(
      [cand(0.03), cand(0.11, 'expensive')], { enabled: true, band },
    );
    // Every previously-published field agrees...
    expect(stateB.selection).toBe(stateA.selection);
    expect(stateB.cheapConsidered).toBe(stateA.cheapConsidered);
    expect(stateB.cheapInBand).toBe(stateA.cheapInBand);
    expect(stateB.strikesConsidered).toBe(stateA.strikesConsidered);
    // ...and exactly one field separates them.
    expect(stateB.strikesInBand).not.toBe(stateA.strikesInBand);
  });

  it('counts the band over ALL classifications, so it is >= cheapInBand always', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.499), cand(0.51, 'expensive'), cand(0.54)],
      { enabled: true, band },
    );
    expect(got.selection).toBe('in_band');
    expect(got.cheapInBand).toBe(2);
    expect(got.strikesInBand).toBe(3);
  });

  it('uses the SAME band predicate as cheapInBand — edges and magnitude included', () => {
    // Lower edge inclusive, upper edge exclusive, puts by magnitude, non-finite out.
    const got = selectAdmissibleOtmCandidate(
      [cand(0.495, 'fair'), cand(0.55, 'fair'), cand(-0.52, 'fair'), cand(Number.NaN, 'fair')],
      { enabled: true, band },
    );
    expect(got.strikesInBand).toBe(2); // 0.495 and -0.52; 0.55 and NaN excluded
    expect(got.selection).toBe('in_band_fair'); // TRA-3856 tier 2 nominates here
    expect(got.candidate!.delta).toBe(0.495);
  });

  it('an abstaining chain still reports the shape, so a thin chain is not a silent zero', () => {
    const got = selectAdmissibleOtmCandidate([cand(0.51, 'expensive')], { enabled: true, band });
    expect(got.candidate).toBeNull();
    expect(got.selection).toBe('abstain_no_in_band');
    expect(got.cheapConsidered).toBe(0);
    expect(got.strikesConsidered).toBe(1);
    expect(got.strikesInBand).toBe(1);
  });

  it('DISARMED reports 0 in band — the band was never consulted (cheapInBand parity)', () => {
    const got = selectAdmissibleOtmCandidate(
      [cand(0.03), cand(0.51, 'expensive')], { enabled: false, band },
    );
    expect(got.selection).toBe('legacy');
    // Same convention as `cheapInBand`, and `legacy` is its own axis key, so this
    // 0 can never be pooled with an armed branch's measured 0.
    expect(got.strikesInBand).toBe(0);
    // The denominator is still honest: the chain size does not depend on the flag.
    expect(got.strikesConsidered).toBe(2);
  });

  it('the nominee is exactly the TRA-3856 tier rule — counts perturb nothing', () => {
    // The recorder discipline, asserted rather than asserted-of: the counts must
    // not perturb selection or candidate on any branch. The oracle is the tier
    // rule itself: in-band cheap, else in-band fair, else null (never a
    // far-OTM fallback).
    for (const c of [
      [cand(0.04), cand(0.51)],
      [cand(0.04), cand(0.51, 'expensive')],
      [cand(0.04), cand(0.52, 'fair')],
      [cand(0.04)],
      [] as ReturnType<typeof cand>[],
    ]) {
      const got = selectAdmissibleOtmCandidate(c, { enabled: true, band });
      const inBand = c.filter((x) => Math.abs(x.delta) >= band.min && Math.abs(x.delta) < band.max);
      const expected = inBand.find((x) => x.classification === 'cheap')
        ?? inBand.find((x) => x.classification === 'fair')
        ?? null;
      expect(got.candidate).toBe(expected);
    }
  });
});

// ── TRA-3870: the small-account budget preference ────────────────────────────
//
// The board's 2026-08-19 posture: entries $100–$300, $500 max total. Without a
// budget the strongest in-band read (an $800–$1,819 SPY/QQQ contract on the
// measured live chains) permanently shadows a fundable in-band strike further
// down the SAME chain, and sizing returns 0 contracts forever — the screen/gate
// no-intersection zero, one wall later.
describe('maxEntryUsd — funding-aware nomination within a tier (TRA-3870)', () => {
  const priced = (delta: number, ask: number, classification = 'fair') =>
    ({ delta, classification, ask });

  it('prefers the strongest FUNDABLE in-band read over a stronger unfundable one', () => {
    // Rank order: $9.19 SPY-shaped contract first (stronger mispricing), $2.50
    // KHC-shaped one second. Budget $300 ⇒ nominate the $2.50 (=$250 notional).
    const got = selectAdmissibleOtmCandidate(
      [priced(0.51, 9.19), priced(0.52, 2.5)],
      { enabled: true, band, maxEntryUsd: 300 },
    );
    expect(got.candidate!.ask).toBe(2.5);
    expect(got.selection).toBe('in_band_fair');
    expect(got.fundableInBand).toBe(1);
  });

  it('preserves rank order AMONG fundable candidates', () => {
    const got = selectAdmissibleOtmCandidate(
      [priced(0.51, 9.19), priced(0.52, 2.5), priced(0.50, 1.2)],
      { enabled: true, band, maxEntryUsd: 300 },
    );
    expect(got.candidate!.ask).toBe(2.5); // the earlier (stronger) fundable read
    expect(got.fundableInBand).toBe(2);
  });

  it('applies the preference INSIDE each tier — a fundable `fair` never outranks tier-1 `cheap`', () => {
    const got = selectAdmissibleOtmCandidate(
      [priced(0.52, 2.5, 'fair'), priced(0.51, 9.19, 'cheap')],
      { enabled: true, band, maxEntryUsd: 300 },
    );
    // Tier 1 wins even though its only member is unfundable; the funding
    // refusal downstream stays on the ledger where it is visible.
    expect(got.candidate!.classification).toBe('cheap');
    expect(got.selection).toBe('in_band');
  });

  it('nothing fundable ⇒ the tier top pick is still nominated (refusal stays visible), fundableInBand 0', () => {
    const got = selectAdmissibleOtmCandidate(
      [priced(0.51, 9.19), priced(0.52, 12.0)],
      { enabled: true, band, maxEntryUsd: 300 },
    );
    expect(got.candidate!.ask).toBe(9.19);
    expect(got.fundableInBand).toBe(0);
  });

  it('exactly-at-budget fits (<=, matching the sizing rule), one cent over does not', () => {
    const got = selectAdmissibleOtmCandidate(
      [priced(0.51, 3.01), priced(0.52, 3.0)],
      { enabled: true, band, maxEntryUsd: 300 },
    );
    expect(got.candidate!.ask).toBe(3.0);
    expect(got.fundableInBand).toBe(1);
  });

  it('an unpriced/zero ask cannot prove it fits — it fails the preference, not the nomination', () => {
    const got = selectAdmissibleOtmCandidate(
      [priced(0.51, 0), priced(0.52, 2.5)],
      { enabled: true, band, maxEntryUsd: 300 },
    );
    expect(got.candidate!.ask).toBe(2.5);
    expect(got.fundableInBand).toBe(1);
  });

  it('no budget ⇒ behaviour byte-identical to pre-TRA-3870, fundableInBand null (absent ≠ 0)', () => {
    for (const maxEntryUsd of [undefined, null, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const got = selectAdmissibleOtmCandidate(
        [priced(0.51, 9.19), priced(0.52, 2.5)],
        { enabled: true, band, maxEntryUsd: maxEntryUsd as number | null | undefined },
      );
      expect(got.candidate!.ask).toBe(9.19); // rank order, budget never consulted
      expect(got.fundableInBand).toBeNull();
    }
  });

  it('DISARMED ignores the budget entirely — legacy stays byte-identical', () => {
    const got = selectAdmissibleOtmCandidate(
      [priced(0.03, 9.19, 'cheap'), priced(0.52, 2.5, 'cheap')],
      { enabled: false, band, maxEntryUsd: 300 },
    );
    expect(got.candidate!.delta).toBe(0.03);
    expect(got.selection).toBe('legacy');
    expect(got.fundableInBand).toBeNull();
  });
});
