// TRA-4646 — the credit-only mandate / debit-sleeve retirement.
//
// The assertions that matter mirror the TRA-2208 floor's two-sided contract:
//   (a) flag ON really removes the debit sleeve — prompt states the mandate,
//       guardrail drops premium-buying ideas into `rejected` for audit;
//   (b) flag OFF is byte-for-byte the old behaviour — same prompt, same cache
//       key, debit ideas survive untouched.
import { describe, it, expect } from 'vitest';
import { StubLlmClient, type LlmCompletionRequest } from './llm-client.js';
import {
  CREDIT_CLASS_STRATEGIES,
  DEBIT_SLEEVE_RETIREMENT_VAR,
  debitRetirementPromptAddendum,
  isCreditClassStrategy,
  isDebitSleeveRetirementEnabled,
} from './options-debit-retirement.js';
import {
  runOptionsResearch,
  LLM_EMITTABLE_STRATEGIES,
  type OptionsResearchCache,
  type OptionsResearchInput,
  type OptionsResearchSymbol,
} from './options-research.js';

const ASOF = Date.parse('2026-09-17T13:30:00Z');

function symbol(over: Partial<OptionsResearchSymbol> = {}): OptionsResearchSymbol {
  return {
    symbol: 'AAPL',
    spot: 195,
    ivRank: 72,
    nextEarningsInDays: null,
    daysToFOMC: null,
    macroEventsNearby: [],
    newsSentiment: 0.15,
    candidates: [
      {
        optionSymbol: 'AAPL261016P00185000',
        optionType: 'put',
        strike: 185,
        expiration: '2026-10-16',
        daysToExpiration: 29,
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

const creditIdea = {
  ticker: 'AAPL',
  strategy: 'bull_put_spread',
  thesis: 'IV-rank 72 → sell rich put premium with a capped wing.',
  pop: 0.7,
  creditUsd: 110,
  maxLossUsd: 390,
  dteDays: 29,
  eventContext: [],
};

const debitIdea = {
  ticker: 'AAPL',
  strategy: 'bull_call_spread',
  thesis: 'Directional debit spread into strength.',
  pop: 0.55,
  maxLossUsd: 200,
  dteDays: 29,
  eventContext: [],
};

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[DEBIT_SLEEVE_RETIREMENT_VAR];
  if (value === undefined) delete process.env[DEBIT_SLEEVE_RETIREMENT_VAR];
  else process.env[DEBIT_SLEEVE_RETIREMENT_VAR] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[DEBIT_SLEEVE_RETIREMENT_VAR];
    else process.env[DEBIT_SLEEVE_RETIREMENT_VAR] = prev;
  }
}

describe('isDebitSleeveRetirementEnabled / isCreditClassStrategy', () => {
  it('parses the flag with the TRA-2208 idiom and defaults OFF', () => {
    expect(isDebitSleeveRetirementEnabled({})).toBe(false);
    expect(isDebitSleeveRetirementEnabled({ [DEBIT_SLEEVE_RETIREMENT_VAR]: '0' })).toBe(false);
    expect(isDebitSleeveRetirementEnabled({ [DEBIT_SLEEVE_RETIREMENT_VAR]: 'false' })).toBe(false);
    for (const on of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(isDebitSleeveRetirementEnabled({ [DEBIT_SLEEVE_RETIREMENT_VAR]: on })).toBe(true);
    }
  });

  it('partitions the emittable strategy universe exactly: 4 credit families, the rest debit', () => {
    const credit = [...LLM_EMITTABLE_STRATEGIES].filter(isCreditClassStrategy);
    const debit = [...LLM_EMITTABLE_STRATEGIES].filter((s) => !isCreditClassStrategy(s));
    expect(new Set(credit)).toEqual(new Set(CREDIT_CLASS_STRATEGIES));
    expect(new Set(debit)).toEqual(
      new Set(['long_call', 'long_put', 'bull_call_spread', 'bear_put_spread', 'call_calendar', 'put_calendar']),
    );
  });

  it('states every credit id and the discard rule in the prompt addendum', () => {
    const text = debitRetirementPromptAddendum();
    for (const id of CREDIT_CLASS_STRATEGIES) expect(text).toContain(id);
    for (const id of ['long_call', 'long_put', 'bull_call_spread', 'bear_put_spread']) {
      expect(text).toContain(id);
    }
    expect(text).toContain('DISCARDED');
  });
});

describe('runOptionsResearch — retirement OFF is byte-for-byte the old behaviour', () => {
  it('keeps debit ideas and never mentions the mandate in the prompt', async () => {
    await withFlag(undefined, async () => {
      const seen: LlmCompletionRequest[] = [];
      const llm = new StubLlmClient((req) => {
        seen.push(req);
        return JSON.stringify({ ideas: [creditIdea, debitIdea] });
      });
      const out = await runOptionsResearch(input(), { llm });
      expect(out.ideas.map((i) => i.strategy).sort()).toEqual(['bull_call_spread', 'bull_put_spread']);
      const system = seen[0]!.messages.find((m) => m.role === 'system')!.content;
      expect(system).not.toContain('CREDIT-ONLY MANDATE');
    });
  });
});

describe('runOptionsResearch — retirement ON', () => {
  it('states the mandate in the prompt and drops premium-buying ideas into `rejected`', async () => {
    await withFlag('1', async () => {
      const seen: LlmCompletionRequest[] = [];
      const llm = new StubLlmClient((req) => {
        seen.push(req);
        return JSON.stringify({ ideas: [creditIdea, debitIdea] });
      });
      const out = await runOptionsResearch(input(), { llm });
      const system = seen[0]!.messages.find((m) => m.role === 'system')!.content;
      expect(system).toContain('CREDIT-ONLY MANDATE');
      // The credit idea survives; the debit idea is removed AND audited.
      expect(out.ideas.map((i) => i.strategy)).toEqual(['bull_put_spread']);
      expect(out.rejected).toHaveLength(1);
      expect(out.rejected[0]!.idea.strategy).toBe('bull_call_spread');
      expect(out.rejected[0]!.reasons.join(' ')).toContain('off-mandate');
    });
  });

  it('changes the batch cache key so a flag-off slate is never re-served to a flag-on caller', async () => {
    const keys: string[] = [];
    const fakeCache: OptionsResearchCache = {
      get: () => undefined,
      set: (k: string) => {
        keys.push(k);
      },
    };
    const llm = new StubLlmClient(() => JSON.stringify({ ideas: [creditIdea] }));
    await withFlag(undefined, () => runOptionsResearch(input(), { llm, cache: fakeCache }));
    await withFlag('1', () => runOptionsResearch(input(), { llm, cache: fakeCache }));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toContain('creditonly');
    expect(keys[0]).not.toContain('creditonly');
  });
});
