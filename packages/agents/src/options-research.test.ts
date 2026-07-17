// TRA-599 (TRA-595 C4) — the Head of Options Research pass. Covered with the
// network-free StubLlmClient: structured-output validation + retry, the
// defined-risk + no-day-trading guardrail (every RETURNED idea clears it even
// when the model misbehaves), deterministic ranking, the $0 short-circuit, and
// per-batch caching.
import { describe, it, expect } from 'vitest';
import { StubLlmClient, type LlmCompletionRequest } from './llm-client.js';
import {
  runOptionsResearch,
  optionsResearchBatchKey,
  validateOptionsIdeaBatch,
  isDefinedRiskStrategy,
  isCoveredStrategy,
  LLM_EMITTABLE_STRATEGIES,
  DEFAULT_OPTIONS_GUARDRAIL,
  type OptionsResearchInput,
  type OptionsResearchSymbol,
  type OptionsResearchResult,
  type OptionsResearchCache,
} from './options-research.js';

const ASOF = Date.parse('2026-06-08T13:30:00Z');

function symbol(over: Partial<OptionsResearchSymbol> = {}): OptionsResearchSymbol {
  return {
    symbol: 'AAPL',
    spot: 195,
    ivRank: 72,
    nextEarningsInDays: 18,
    daysToFOMC: 9,
    macroEventsNearby: ['CPI in 2d'],
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

/** A schema-valid, defined-risk, guardrail-clearing idea for AAPL. */
function goodIdea(over: Record<string, unknown> = {}) {
  return {
    ticker: 'AAPL',
    strategy: 'bull_put_spread',
    thesis: 'IV-rank 72 → sell rich put premium with a capped wing; 39 DTE clears the floor.',
    pop: 0.7,
    maxLossUsd: 320,
    dteDays: 39,
    eventContext: ['earnings in 18d'],
    ...over,
  };
}

function memCache(): OptionsResearchCache & { store: Map<string, OptionsResearchResult> } {
  const store = new Map<string, OptionsResearchResult>();
  return { store, get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
}

describe('validateOptionsIdeaBatch', () => {
  it('accepts a well-formed batch', () => {
    expect(validateOptionsIdeaBatch({ ideas: [goodIdea()] })).toEqual([]);
  });
  it('flags out-of-range POP and non-positive max-loss', () => {
    const errs = validateOptionsIdeaBatch({ ideas: [goodIdea({ pop: 1.4, maxLossUsd: 0 })] });
    expect(errs.some((e) => /pop/.test(e))).toBe(true);
    expect(errs.some((e) => /maxLossUsd/.test(e))).toBe(true);
  });
  it('requires the ideas array', () => {
    expect(validateOptionsIdeaBatch({})).toEqual(['"ideas" must be an array']);
  });
});

describe('isDefinedRiskStrategy', () => {
  it('admits capped-loss structures and rejects naked/short legs', () => {
    expect(isDefinedRiskStrategy('iron_condor')).toBe(true);
    expect(isDefinedRiskStrategy('long_call')).toBe(true);
    expect(isDefinedRiskStrategy('naked_put')).toBe(false);
    expect(isDefinedRiskStrategy('short_strangle')).toBe(false);
  });

  // TRA-1322 item 5 — the CSP + covered-call pair is defined-risk by COLLATERAL
  // (covered, not naked). The classifier must treat both as defined-risk.
  it('treats the wheel/put-write covered legs as defined-risk (not naked)', () => {
    expect(isDefinedRiskStrategy('cash_secured_put')).toBe(true);
    expect(isDefinedRiskStrategy('covered_call')).toBe(true);
    expect(isCoveredStrategy('cash_secured_put')).toBe(true);
    expect(isCoveredStrategy('covered_call')).toBe(true);
    // ...but a genuinely naked short is still rejected.
    expect(isCoveredStrategy('naked_put')).toBe(false);
    expect(isDefinedRiskStrategy('naked_call')).toBe(false);
  });

  it('keeps covered legs out of the LLM-emittable allowlist', () => {
    // covered structures are sleeve-managed, never proposed by the ideas pass
    expect(LLM_EMITTABLE_STRATEGIES.has('cash_secured_put')).toBe(false);
    expect(LLM_EMITTABLE_STRATEGIES.has('covered_call')).toBe(false);
    expect(LLM_EMITTABLE_STRATEGIES.has('bull_put_spread')).toBe(true);
  });
});

describe('runOptionsResearch', () => {
  it('returns ranked, defined-risk ideas with all required fields', async () => {
    const llm = new StubLlmClient(() => JSON.stringify({ ideas: [goodIdea()] }));
    const out = await runOptionsResearch(input(), { llm });

    expect(out.ideas).toHaveLength(1);
    const idea = out.ideas[0]!;
    expect(idea).toMatchObject({ ticker: 'AAPL', strategy: 'bull_put_spread', rank: 1 });
    expect(idea.pop).toBeGreaterThan(0);
    expect(idea.pop).toBeLessThanOrEqual(1);
    expect(idea.maxLossUsd).toBeGreaterThan(0);
    expect(isDefinedRiskStrategy(idea.strategy)).toBe(true);
    expect(out.attempts).toBe(1);
    expect(out.cached).toBe(false);
    // One structured call per batch.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.purpose).toBe('options-research');
  });

  it('drops undefined-risk, sub-DTE and off-universe ideas; keeps only clean ones', async () => {
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea(), // keep
          goodIdea({ strategy: 'naked_put', maxLossUsd: 999 }), // not defined-risk
          goodIdea({ dteDays: 3 }), // day-trade guardrail
          goodIdea({ ticker: 'TSLA' }), // off-universe
        ],
      }),
    );
    const out = await runOptionsResearch(input(), { llm });
    expect(out.ideas).toHaveLength(1);
    expect(out.ideas[0]!.strategy).toBe('bull_put_spread');
    expect(out.rejected).toHaveLength(3);
    const reasonBlob = out.rejected.flatMap((r) => r.reasons).join(' ');
    expect(reasonBlob).toMatch(/not defined-risk/);
    expect(reasonBlob).toMatch(/day-trade guardrail/);
    expect(reasonBlob).toMatch(/not in universe/);
  });

  // TRA-1322 item 5 — covered legs are defined-risk but sleeve-managed: even
  // though the classifier now admits them, the ideas pass must NOT surface a
  // covered_call / cash_secured_put into the (paper-only) ideas → paper-enter
  // path (PaperOptionsAccount can't book a short leg).
  it('rejects covered legs from the LLM ideas feed even though they are defined-risk', async () => {
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea(), // keep
          goodIdea({ strategy: 'covered_call', dteDays: 45 }),
          goodIdea({ strategy: 'cash_secured_put', dteDays: 45 }),
        ],
      }),
    );
    const out = await runOptionsResearch(input(), { llm });
    expect(out.ideas).toHaveLength(1);
    expect(out.ideas[0]!.strategy).toBe('bull_put_spread');
    const reasonBlob = out.rejected.flatMap((r) => r.reasons).join(' ');
    expect(reasonBlob).toMatch(/sleeve-managed/);
    // and it was NOT rejected as "not defined-risk" — the classifier admits it
    expect(reasonBlob).not.toMatch(/covered_call" is not defined-risk/);
  });

  // TRA-598 (C3) acceptance — a 0DTE idea must never be surfaced.
  it('rejects a 0DTE idea at idea generation', async () => {
    const llm = new StubLlmClient(() =>
      JSON.stringify({ ideas: [goodIdea({ dteDays: 0 })] }),
    );
    const out = await runOptionsResearch(input(), { llm });
    expect(out.ideas).toHaveLength(0);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reasons.join(' ')).toMatch(/day-trade guardrail/);
  });

  // TRA-1974 (D3) — event-IV "sell the crush". A net-long-vega debit single-leg
  // (long_call / long_put) proposed on a name with a catalyst INSIDE its expiry
  // and elevated IV (ivRank >= 50) is dropped deterministically post-model, so a
  // defined-risk CREDIT structure surfaces for that name instead.
  describe('sell-the-crush event-IV rule', () => {
    // ivRank 72, earnings in 18d — inside a 39-DTE expiry.
    const crush = () => symbol({ ivRank: 72, nextEarningsInDays: 18, daysToFOMC: null });

    it('DoD: a would-be long-premium debit pre-earnings surfaces as a credit structure instead', async () => {
      const llm = new StubLlmClient(() =>
        JSON.stringify({
          ideas: [
            goodIdea({ strategy: 'long_call', dteDays: 39, maxLossUsd: 250, pop: 0.55 }), // crushed → drop
            goodIdea({ strategy: 'bull_put_spread', dteDays: 39, maxLossUsd: 320, pop: 0.7 }), // credit → keep
          ],
        }),
      );
      const out = await runOptionsResearch(input({ symbols: [crush()] }), { llm });
      expect(out.ideas.map((i) => i.strategy)).toEqual(['bull_put_spread']);
      const reasonBlob = out.rejected.flatMap((r) => r.reasons).join(' ');
      expect(reasonBlob).toMatch(/sell-the-crush/);
      expect(reasonBlob).toMatch(/earnings in 18d/);
    });

    it('drops long_put too, not just long_call', async () => {
      const llm = new StubLlmClient(() =>
        JSON.stringify({ ideas: [goodIdea({ strategy: 'long_put', dteDays: 39 })] }),
      );
      const out = await runOptionsResearch(input({ symbols: [crush()] }), { llm });
      expect(out.ideas).toHaveLength(0);
      expect(out.rejected[0]!.reasons.join(' ')).toMatch(/sell-the-crush/);
    });

    it('KEEPS a long single-leg when the catalyst sits OUTSIDE the chosen expiry', async () => {
      // Earnings 45d out, idea expires in 39d → the crush lands after expiry.
      const llm = new StubLlmClient(() =>
        JSON.stringify({ ideas: [goodIdea({ strategy: 'long_call', dteDays: 39 })] }),
      );
      const sym = symbol({ ivRank: 72, nextEarningsInDays: 45, daysToFOMC: null });
      const out = await runOptionsResearch(input({ symbols: [sym] }), { llm });
      expect(out.ideas.map((i) => i.strategy)).toEqual(['long_call']);
    });

    it('KEEPS a long single-leg when IV-rank is below the elevated threshold', async () => {
      const llm = new StubLlmClient(() =>
        JSON.stringify({ ideas: [goodIdea({ strategy: 'long_call', dteDays: 39 })] }),
      );
      const sym = symbol({ ivRank: 40, nextEarningsInDays: 5, daysToFOMC: null });
      const out = await runOptionsResearch(input({ symbols: [sym] }), { llm });
      expect(out.ideas.map((i) => i.strategy)).toEqual(['long_call']);
    });

    it('fires on an FOMC-inside catalyst when earnings is absent (secondary trigger)', async () => {
      const llm = new StubLlmClient(() =>
        JSON.stringify({ ideas: [goodIdea({ strategy: 'long_call', dteDays: 30 })] }),
      );
      const sym = symbol({ ivRank: 60, nextEarningsInDays: null, daysToFOMC: 6 });
      const out = await runOptionsResearch(input({ symbols: [sym] }), { llm });
      expect(out.ideas).toHaveLength(0);
      expect(out.rejected[0]!.reasons.join(' ')).toMatch(/FOMC in 6d/);
    });

    it('never drops a credit / spread structure on a sell-the-crush name', async () => {
      // FOMC-based crush (no earnings key) so the TRA-846 earnings de-dupe does not
      // collapse the two same-ticker survivors — this test isolates the D3 drop.
      const fomcCrush = symbol({ ivRank: 72, nextEarningsInDays: null, daysToFOMC: 6 });
      const llm = new StubLlmClient(() =>
        JSON.stringify({
          ideas: [
            goodIdea({ strategy: 'bear_call_spread', dteDays: 39, pop: 0.68 }),
            goodIdea({ strategy: 'iron_condor', dteDays: 39, pop: 0.6 }),
          ],
        }),
      );
      const out = await runOptionsResearch(input({ symbols: [fomcCrush] }), { llm });
      expect(out.ideas.map((i) => i.strategy).sort()).toEqual(['bear_call_spread', 'iron_condor']);
      expect(out.rejected).toHaveLength(0);
    });
  });

  it('every returned idea is defined-risk and clears the guardrail', async () => {
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea({ strategy: 'iron_condor', dteDays: 45 }),
          goodIdea({ strategy: 'short_call', dteDays: 45 }),
          goodIdea({ strategy: 'long_put', dteDays: 21 }),
        ],
      }),
    );
    // No catalyst on the symbol so neither the TRA-846 earnings de-dupe nor the
    // TRA-1974 sell-the-crush drop fires — this test is about the HARD guardrail.
    const out = await runOptionsResearch(
      input({ maxIdeas: 10, symbols: [symbol({ nextEarningsInDays: null, daysToFOMC: null })] }),
      { llm },
    );
    for (const idea of out.ideas) {
      expect(isDefinedRiskStrategy(idea.strategy)).toBe(true);
      expect(idea.dteDays).toBeGreaterThanOrEqual(DEFAULT_OPTIONS_GUARDRAIL.minDteDays);
    }
    expect(out.ideas.map((i) => i.strategy).sort()).toEqual(['iron_condor', 'long_put']);
  });

  it('ranks best-first by POP then smaller max-loss, truncating to maxIdeas', async () => {
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea({ strategy: 'long_call', pop: 0.55, maxLossUsd: 200 }),
          goodIdea({ strategy: 'iron_condor', pop: 0.8, maxLossUsd: 400 }),
          goodIdea({ strategy: 'bull_put_spread', pop: 0.8, maxLossUsd: 150 }),
        ],
      }),
    );
    // No catalyst → no de-dupe and no sell-the-crush drop; same (unknown) sector so
    // the per-sector cap (2) admits the top-2 by score, exercising pure ranking.
    const out = await runOptionsResearch(
      input({ maxIdeas: 2, symbols: [symbol({ nextEarningsInDays: null, daysToFOMC: null })] }),
      { llm },
    );
    expect(out.ideas).toHaveLength(2);
    // 0.8/150 beats 0.8/400 beats 0.55/200; top-2 kept.
    expect(out.ideas.map((i) => i.strategy)).toEqual(['bull_put_spread', 'iron_condor']);
    expect(out.ideas.map((i) => i.rank)).toEqual([1, 2]);
  });

  // ── TRA-846 diversification guardrail ──────────────────────────────────────
  it('de-dupes multiple ideas riding the same earnings event, keeping the best', async () => {
    // The default AAPL symbol has earnings in 18d; two AAPL ideas both ride it.
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea({ strategy: 'iron_condor', pop: 0.6, maxLossUsd: 400 }),
          goodIdea({ strategy: 'bull_put_spread', pop: 0.78, maxLossUsd: 300 }), // best
        ],
      }),
    );
    const out = await runOptionsResearch(input({ maxIdeas: 5 }), { llm });
    expect(out.ideas).toHaveLength(1);
    expect(out.ideas[0]!.strategy).toBe('bull_put_spread');
    expect(out.rejected.some((r) => r.reasons.join(' ').includes('earnings event'))).toBe(true);
  });

  it('spreads the slate across catalyst horizons over raw score', async () => {
    // ZNEAR: earnings in 3d (near). ZLONG: no catalyst, long-dated (long).
    const symbols: OptionsResearchSymbol[] = [
      symbol({ symbol: 'ZNEAR', nextEarningsInDays: 3, daysToFOMC: null, candidates: symbol().candidates }),
      symbol({ symbol: 'ZLONG', nextEarningsInDays: null, daysToFOMC: null, candidates: symbol().candidates }),
    ];
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea({ ticker: 'ZNEAR', strategy: 'iron_condor', pop: 0.85, maxLossUsd: 200 }), // best, near
          goodIdea({ ticker: 'ZLONG', strategy: 'long_call', pop: 0.6, maxLossUsd: 200 }), // long
        ],
      }),
    );
    const out = await runOptionsResearch(input({ maxIdeas: 2, symbols }), { llm });
    expect(out.ideas.map((i) => i.catalystHorizon).sort()).toEqual(['long', 'near']);
    expect(out.ideas[0]!.ticker).toBe('ZNEAR'); // best score still ranks first
  });

  it('caps ideas per sector when sectors are supplied', async () => {
    const symbols: OptionsResearchSymbol[] = [
      symbol({ symbol: 'TEC1', sector: 'Technology', nextEarningsInDays: null, daysToFOMC: null, candidates: symbol().candidates }),
      symbol({ symbol: 'TEC2', sector: 'Technology', nextEarningsInDays: null, daysToFOMC: null, candidates: symbol().candidates }),
      symbol({ symbol: 'TEC3', sector: 'Technology', nextEarningsInDays: null, daysToFOMC: null, candidates: symbol().candidates }),
      symbol({ symbol: 'FIN1', sector: 'Financials', nextEarningsInDays: null, daysToFOMC: null, candidates: symbol().candidates }),
    ];
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          goodIdea({ ticker: 'TEC1', strategy: 'long_call', pop: 0.9, maxLossUsd: 200 }),
          goodIdea({ ticker: 'TEC2', strategy: 'long_call', pop: 0.88, maxLossUsd: 200 }),
          goodIdea({ ticker: 'TEC3', strategy: 'long_call', pop: 0.86, maxLossUsd: 200 }),
          goodIdea({ ticker: 'FIN1', strategy: 'long_call', pop: 0.5, maxLossUsd: 200 }),
        ],
      }),
    );
    const out = await runOptionsResearch(input({ maxIdeas: 3, symbols }), { llm });
    const tech = out.ideas.filter((i) => ['TEC1', 'TEC2', 'TEC3'].includes(i.ticker));
    expect(tech).toHaveLength(2); // per-sector cap = 2
    // The lower-scored Financials idea is pulled in for sector spread.
    expect(out.ideas.map((i) => i.ticker)).toContain('FIN1');
  });

  it('retries on a schema-invalid batch then succeeds', async () => {
    const llm = new StubLlmClient((_r: LlmCompletionRequest, i: number) =>
      i === 0
        ? JSON.stringify({ ideas: [goodIdea({ pop: 7 })] }) // bad POP
        : JSON.stringify({ ideas: [goodIdea()] }),
    );
    const out = await runOptionsResearch(input(), { llm });
    expect(out.attempts).toBe(2);
    expect(out.ideas).toHaveLength(1);
    expect(llm.requests[1]!.messages.some((m) => /pop/.test(m.content))).toBe(true);
  });

  it('short-circuits to $0 with no candidates — never calls the model', async () => {
    const llm = new StubLlmClient(() => {
      throw new Error('LLM must not be called when there is nothing to research');
    });
    const out = await runOptionsResearch(
      input({ symbols: [symbol({ candidates: [] })] }),
      { llm },
    );
    expect(out.ideas).toEqual([]);
    expect(out.costUsd).toBe(0);
    expect(out.attempts).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('serves an identical batch from cache without a second LLM call', async () => {
    const llm = new StubLlmClient(() => JSON.stringify({ ideas: [goodIdea()] }));
    const cache = memCache();
    const first = await runOptionsResearch(input(), { llm, cache });
    expect(first.cached).toBe(false);
    expect(llm.requests).toHaveLength(1);

    const second = await runOptionsResearch(input(), { llm, cache });
    expect(second.cached).toBe(true);
    expect(second.ideas).toEqual(first.ideas);
    expect(llm.requests).toHaveLength(1); // no new call
  });
});

describe('optionsResearchBatchKey', () => {
  it('is stable for identical inputs and busts when the spot moves', () => {
    const a = optionsResearchBatchKey(input());
    const b = optionsResearchBatchKey(input());
    expect(a).toBe(b);
    const moved = optionsResearchBatchKey(input({ symbols: [symbol({ spot: 210 })] }));
    expect(moved).not.toBe(a);
  });
  it('busts when the guardrail tightens', () => {
    const base = optionsResearchBatchKey(input());
    const tighter = optionsResearchBatchKey(
      input({ guardrail: { ...DEFAULT_OPTIONS_GUARDRAIL, minDteDays: 30 } }),
    );
    expect(tighter).not.toBe(base);
  });
});
