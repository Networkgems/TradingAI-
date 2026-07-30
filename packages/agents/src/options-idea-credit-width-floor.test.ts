// TRA-2208 — the hard credit/width floor + short-strike delta band.
//
// The assertions that matter are the two the Lead Quant's directive turns on:
//   (a) the floor REALLY removes the below-floor credit book (flag on), and
//   (b) flag OFF is byte-for-byte the old behaviour — same prompt, same cache key,
//       same emitted record shape, no ledger.
// Plus the arithmetic that the whole diagnosis rests on: a 0.03 credit/width book
// earns 0.03/0.97 = +0.031R per win, so the ratio identity has to be exact.
import { describe, it, expect } from 'vitest';
import { StubLlmClient, type LlmCompletionRequest } from './llm-client.js';
import {
  creditWidthRatioOf,
  evaluateCreditWidthFloor,
  evaluateIdeasCreditWidthFloor,
  resolveCreditWidthFloorConfig,
  DEFAULT_CREDIT_WIDTH_FLOOR,
  DEFAULT_SHORT_DELTA_MIN,
  DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
  CREDIT_WIDTH_FLOOR_ENABLE_VAR,
} from './options-idea-credit-width-floor.js';
import {
  runOptionsResearch,
  validateOptionsIdeaBatch,
  type OptionsResearchInput,
  type OptionsResearchSymbol,
} from './options-research.js';

const ASOF = Date.parse('2026-06-08T13:30:00Z');
const FLAG = CREDIT_WIDTH_FLOOR_ENABLE_VAR;

function symbol(over: Partial<OptionsResearchSymbol> = {}): OptionsResearchSymbol {
  return {
    symbol: 'AAPL',
    spot: 195,
    ivRank: 72,
    nextEarningsInDays: 18,
    daysToFOMC: 9,
    macroEventsNearby: [],
    newsSentiment: 0.15,
    candidates: [
      {
        optionSymbol: 'AAPL260717P00185000',
        optionType: 'put',
        strike: 185,
        expiration: '2026-07-17',
        daysToExpiration: 39,
        mark: 3.1,
        ivUsed: 0.33,
        delta: -0.28,
        classification: 'expensive',
        mispricingPct: 0.14,
        source: 'relative_value',
      },
    ],
    ...over,
  };
}

function input(over: Partial<OptionsResearchInput> = {}): OptionsResearchInput {
  return { asOf: ASOF, symbols: [symbol()], maxIdeas: 5, ...over };
}

/** A credit vertical collecting `credit` of a `width` (both per 1-lot, USD). */
function creditIdea(credit: number, width: number, over: Record<string, unknown> = {}) {
  return {
    ticker: 'AAPL',
    strategy: 'bull_put_spread',
    thesis: 'IV-rank 72 → sell rich put premium with a capped wing; 39 DTE clears the floor.',
    pop: 0.7,
    creditUsd: credit,
    maxLossUsd: width - credit,
    dteDays: 39,
    eventContext: [],
    ...over,
  };
}

/** Run the pass with the floor flag set, always restoring the previous value. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

describe('creditWidthRatioOf', () => {
  it('is credit ÷ (credit + maxLoss), so the ×100 multipliers cancel', () => {
    // The bqb1 book: 3% of width. 0.03/(0.03+0.97) = 0.03 exactly.
    expect(creditWidthRatioOf(3, 97)).toBeCloseTo(0.03, 10);
    expect(creditWidthRatioOf(100, 400)).toBeCloseTo(0.2, 10);
  });
  it('is null — never a fabricated 0 — when the idea is not priced', () => {
    expect(creditWidthRatioOf(undefined, 400)).toBeNull();
    expect(creditWidthRatioOf(0, 400)).toBeNull();
    expect(creditWidthRatioOf(100, 0)).toBeNull();
    expect(creditWidthRatioOf(Number.NaN, 400)).toBeNull();
  });
});

describe('evaluateCreditWidthFloor', () => {
  it('rejects the measured bqb1 book (credit/width 0.03) against the 0.20 floor', () => {
    const r = evaluateCreditWidthFloor({ strategy: 'bull_put_spread', creditUsd: 3, maxLossUsd: 97 });
    expect(r.verdict).toBe('reject');
    expect(r.admit).toBe(false);
    expect(r.creditWidthRatio).toBeCloseTo(0.03, 10);
    expect(r.floor).toBe(DEFAULT_CREDIT_WIDTH_FLOOR);
    expect(r.reasons[0]).toContain('< floor 0.20');
  });

  it('admits a credit vertical exactly at the floor (the bar is ≥, not >)', () => {
    const r = evaluateCreditWidthFloor({ strategy: 'bull_put_spread', creditUsd: 100, maxLossUsd: 400 });
    expect(r.verdict).toBe('pass');
    expect(r.creditWidthRatio).toBeCloseTo(0.2, 10);
  });

  it('rejects an unpriced credit vertical — the floor cannot be verified', () => {
    const r = evaluateCreditWidthFloor({ strategy: 'bear_call_spread', maxLossUsd: 400 });
    expect(r.verdict).toBe('unpriced');
    expect(r.admit).toBe(false);
    expect(r.creditWidthRatio).toBeNull();
  });

  it('leaves debit / long-premium families alone (out of scope, always admitted)', () => {
    for (const strategy of ['long_call', 'long_put', 'bull_call_spread', 'call_calendar']) {
      const r = evaluateCreditWidthFloor({ strategy, maxLossUsd: 400 });
      expect(r.verdict).toBe('not_credit');
      expect(r.admit).toBe(true);
      expect(r.reasons).toEqual([]);
    }
  });

  it('records the short-leg delta band without ever gating on it', () => {
    const below = evaluateCreditWidthFloor({
      strategy: 'bull_put_spread',
      creditUsd: 100,
      maxLossUsd: 400,
      shortDelta: -0.08, // sign-adjusted put delta; the band reads |delta|
    });
    expect(below.shortDelta).toBeCloseTo(0.08, 10);
    expect(below.shortDeltaInBand).toBe(false);
    // Out of band, but the credit clears the floor → still admitted. The band is a
    // prompt contract, not a deterministic reject.
    expect(below.verdict).toBe('pass');

    const inBand = evaluateCreditWidthFloor({
      strategy: 'bull_put_spread',
      creditUsd: 100,
      maxLossUsd: 400,
      shortDelta: -0.25,
    });
    expect(inBand.shortDeltaInBand).toBe(true);

    const silent = evaluateCreditWidthFloor({
      strategy: 'bull_put_spread',
      creditUsd: 100,
      maxLossUsd: 400,
    });
    expect(silent.shortDelta).toBeNull();
    expect(silent.shortDeltaInBand).toBeNull(); // unknown, never "out of band"
  });
});

describe('evaluateIdeasCreditWidthFloor', () => {
  it('reports the survival rate over the CREDIT book, with unpriced in the denominator', () => {
    const shadow = evaluateIdeasCreditWidthFloor(
      [
        { ticker: 'AAPL', strategy: 'bull_put_spread', creditUsd: 100, maxLossUsd: 400 }, // 0.20 pass
        { ticker: 'MSFT', strategy: 'bull_put_spread', creditUsd: 3, maxLossUsd: 97 }, // 0.03 reject
        { ticker: 'NVDA', strategy: 'bear_call_spread', maxLossUsd: 400 }, // unpriced
        { ticker: 'TSLA', strategy: 'long_call', maxLossUsd: 400 }, // out of scope
      ],
      DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
    );
    expect(shadow.counts).toEqual({ total: 4, credit: 3, pass: 1, reject: 1, unpriced: 1, notCredit: 1 });
    expect(shadow.survivalRate).toBeCloseTo(1 / 3, 10);
    expect(shadow.stats.priced).toBe(2);
    expect(shadow.stats.minCreditWidth).toBeCloseTo(0.03, 10);
    expect(shadow.stats.maxCreditWidth).toBeCloseTo(0.2, 10);
  });

  it('reports a null survival rate — not 0, not 1 — when no credit idea was proposed', () => {
    const shadow = evaluateIdeasCreditWidthFloor(
      [{ ticker: 'TSLA', strategy: 'long_call', maxLossUsd: 400 }],
      DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
    );
    expect(shadow.survivalRate).toBeNull();
    expect(shadow.stats.meanCreditWidth).toBeNull();
  });
});

describe('resolveCreditWidthFloorConfig', () => {
  it('is null unless the flag is explicitly truthy', () => {
    expect(resolveCreditWidthFloorConfig({})).toBeNull();
    expect(resolveCreditWidthFloorConfig({ [FLAG]: '0' })).toBeNull();
    expect(resolveCreditWidthFloorConfig({ [FLAG]: 'false' })).toBeNull();
    for (const on of ['1', 'true', 'yes', 'on', 'ON']) {
      expect(resolveCreditWidthFloorConfig({ [FLAG]: on })).not.toBeNull();
    }
  });

  it('takes env overrides, and discards an inverted delta band wholesale', () => {
    const tuned = resolveCreditWidthFloorConfig({
      [FLAG]: '1',
      OPTIONS_IDEA_CREDIT_WIDTH_MIN: '0.28',
      OPTIONS_IDEA_SHORT_DELTA_MIN: '0.15',
      OPTIONS_IDEA_SHORT_DELTA_MAX: '0.35',
    });
    expect(tuned).toEqual({ minCreditWidth: 0.28, shortDeltaMin: 0.15, shortDeltaMax: 0.35 });

    // min > max would be stated to the model as an unsatisfiable contract.
    const inverted = resolveCreditWidthFloorConfig({
      [FLAG]: '1',
      OPTIONS_IDEA_SHORT_DELTA_MIN: '0.4',
      OPTIONS_IDEA_SHORT_DELTA_MAX: '0.1',
    });
    expect(inverted).toEqual(DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG);

    // Malformed / out-of-range → reference default, never a thrown parse.
    const junk = resolveCreditWidthFloorConfig({ [FLAG]: '1', OPTIONS_IDEA_CREDIT_WIDTH_MIN: 'wat' });
    expect(junk!.minCreditWidth).toBe(DEFAULT_CREDIT_WIDTH_FLOOR);
  });

  // TRA-2217. The floor is not an independent number: `c = credit/(credit+maxLoss)`
  // IS the short-leg delta by no-arbitrage, so the floor is the band's lower edge.
  // Asserted against the band constant, never restated as a literal — a restated
  // 0.2 here would pass while the two constants silently drifted apart.
  it('derives the floor from the delta band rather than restating it', () => {
    expect(DEFAULT_CREDIT_WIDTH_FLOOR).toBe(DEFAULT_SHORT_DELTA_MIN);
  });

  // …and the identity has to hold at RESOLVE time too. An operator who raises the
  // band bottom and leaves the floor var unset must get the raised floor, not the
  // stale module constant — that env path is where the drift would come back.
  it('floors at the RESOLVED band bottom when only the band is overridden', () => {
    const banded = resolveCreditWidthFloorConfig({
      [FLAG]: '1',
      OPTIONS_IDEA_SHORT_DELTA_MIN: '0.25',
    });
    expect(banded!.minCreditWidth).toBe(0.25);
    expect(banded!.shortDeltaMin).toBe(0.25);
  });
});

describe('validateOptionsIdeaBatch — shortDelta', () => {
  const base = creditIdea(100, 500);
  it('accepts an absent or in-range shortDelta', () => {
    expect(validateOptionsIdeaBatch({ ideas: [base] })).toEqual([]);
    expect(validateOptionsIdeaBatch({ ideas: [{ ...base, shortDelta: 0.25 }] })).toEqual([]);
    expect(validateOptionsIdeaBatch({ ideas: [{ ...base, shortDelta: -0.25 }] })).toEqual([]);
  });
  it('flags a shortDelta outside [-1,1] — that is a misunderstood field, not a decline', () => {
    const errs = validateOptionsIdeaBatch({ ideas: [{ ...base, shortDelta: 28 }] });
    expect(errs.some((e) => e.includes('shortDelta'))).toBe(true);
  });
});

describe('runOptionsResearch — floor OFF is byte-for-byte the old behaviour', () => {
  it('leaves the prompt, the slate and the record untouched, and emits no ledger', async () => {
    await withFlag(undefined, async () => {
      const seen: LlmCompletionRequest[] = [];
      const llm = new StubLlmClient((req) => {
        seen.push(req);
        // The 0.03 book — the exact case the floor exists to remove.
        return JSON.stringify({ ideas: [creditIdea(3, 100)] });
      });
      const out = await runOptionsResearch(input(), { llm });

      expect(out.ideas).toHaveLength(1); // NOT thinned
      expect(out.creditWidthFloorShadow).toBeUndefined();
      // No stamped ratio / delta — the emitted record keeps its old shape exactly.
      expect(Object.keys(out.ideas[0]!)).not.toContain('creditWidthRatio');
      expect(Object.keys(out.ideas[0]!)).not.toContain('shortDelta');
      // The prompt never mentions the floor or the band.
      const system = seen[0]!.messages.find((m) => m.role === 'system')!.content;
      expect(system).not.toContain('PREMIUM FLOOR');
      expect(system).not.toContain('shortDelta');
    });
  });
});

describe('runOptionsResearch — floor ON', () => {
  it('states the floor and the delta band in the prompt', async () => {
    await withFlag('1', async () => {
      const seen: LlmCompletionRequest[] = [];
      const llm = new StubLlmClient((req) => {
        seen.push(req);
        return JSON.stringify({ ideas: [creditIdea(100, 500, { shortDelta: 0.25 })] });
      });
      await runOptionsResearch(input(), { llm });
      const system = seen[0]!.messages.find((m) => m.role === 'system')!.content;
      expect(system).toContain('CREDIT-VERTICAL PREMIUM FLOOR');
      expect(system).toContain('>= 0.20');
      expect(system).toContain('0.20–0.30 delta');
      expect(system).toContain('DO NOT optimise for POP');
    });
  });

  it('REMOVES the below-floor credit book from the slate and audits the removal', async () => {
    await withFlag('1', async () => {
      const llm = new StubLlmClient(() => JSON.stringify({ ideas: [creditIdea(3, 100)] }));
      const out = await runOptionsResearch(input(), { llm });

      expect(out.ideas).toHaveLength(0); // an empty slate is a valid, informative result
      expect(out.rejected).toHaveLength(1);
      expect(out.rejected[0]!.reasons.join(' ')).toContain('credit/width 0.030 < floor 0.20');
    });
  });

  it('emits the PRE-floor ledger over what the model PROPOSED, not what survived', async () => {
    await withFlag('1', async () => {
      const llm = new StubLlmClient(() =>
        JSON.stringify({
          ideas: [
            creditIdea(100, 500, { shortDelta: 0.25 }), // 0.20 → survives
            creditIdea(3, 100, { ticker: 'AAPL', shortDelta: 0.05 }), // 0.03 → removed
          ],
        }),
      );
      const out = await runOptionsResearch(input(), { llm });

      // Slate holds only the survivor…
      expect(out.ideas).toHaveLength(1);
      // …but the ledger holds BOTH, which is the only way the survival rate is knowable.
      const shadow = out.creditWidthFloorShadow!;
      expect(shadow.counts.credit).toBe(2);
      expect(shadow.counts.pass).toBe(1);
      expect(shadow.counts.reject).toBe(1);
      expect(shadow.survivalRate).toBeCloseTo(0.5, 10);
      expect(shadow.stats.deltaReported).toBe(2);
      expect(shadow.stats.deltaInBand).toBe(1);
    });
  });

  it('stamps creditWidthRatio + shortDelta on the surviving record', async () => {
    await withFlag('1', async () => {
      const llm = new StubLlmClient(() =>
        JSON.stringify({ ideas: [creditIdea(100, 500, { shortDelta: -0.25 })] }),
      );
      const out = await runOptionsResearch(input(), { llm });
      expect(out.ideas[0]!.creditWidthRatio).toBeCloseTo(0.2, 10);
      expect(out.ideas[0]!.shortDelta).toBeCloseTo(0.25, 10); // |delta|
    });
  });

  it('busts the batch cache, so a pre-floor slate is never re-served to a floored caller', async () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: (k: string) => store.get(k) as never,
      set: (k: string, v: unknown) => void store.set(k, v),
    };
    const llm = new StubLlmClient(() => JSON.stringify({ ideas: [creditIdea(3, 100)] }));

    await withFlag(undefined, () => runOptionsResearch(input(), { llm, cache }));
    await withFlag('1', () => runOptionsResearch(input(), { llm, cache }));
    expect(store.size).toBe(2);

    // …and the flag-off key is unchanged, so an off run still hits its own entry.
    const before = llm.requests.length;
    await withFlag(undefined, () => runOptionsResearch(input(), { llm, cache }));
    expect(llm.requests.length).toBe(before);
  });
});
