// TRA-599 (TRA-595 C4) — input-fusion acceptance test against a RECORDED chain
// snapshot fixture. Proves the end-to-end path the feature actually runs:
// recorded chain → real RV + OTM scanners → fused OptionsResearchInput (with the
// IV-rank / earnings / FOMC / sentiment lanes) → the Head of Options Research
// pass → ranked, defined-risk ideas. The LLM is the network-free StubLlmClient,
// so the test is deterministic and free.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StubLlmClient, runOptionsResearch, isDefinedRiskStrategy } from '@trading-app/agents';
import type { OptionChainSnapshotFile } from './options-chain-recorder.js';
import {
  fuseOptionsResearchInput,
  fuseOptionsResearchSymbol,
  type SymbolEventContext,
} from './options-research-input.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSnapshot(): OptionChainSnapshotFile {
  const path = join(__dirname, '__fixtures__', 'options-chain-snapshot.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as OptionChainSnapshotFile;
}

const ASOF = Date.parse('2026-06-08T13:30:00Z');

// Event/IV context the server would resolve from the C1/C2/sentiment stores.
const context: Record<string, SymbolEventContext> = {
  AAPL: {
    ivRank: 68,
    nextEarningsInDays: 20,
    daysToFOMC: 9,
    macroEventsNearby: ['CPI in 2d'],
    newsSentiment: 0.12,
  },
};

describe('fuseOptionsResearchSymbol (recorded chain snapshot)', () => {
  it('runs the real scanners over the snapshot and surfaces flagged, in-window candidates', () => {
    const fused = fuseOptionsResearchSymbol(loadSnapshot(), {
      now: ASOF,
      contextFor: (s) => context[s] ?? {},
    });
    expect(fused).not.toBeNull();
    expect(fused!.symbol).toBe('AAPL');
    expect(fused!.spot).toBe(195);
    // The two deliberately-mispriced OTM contracts surface; none are `fair`.
    expect(fused!.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of fused!.candidates) {
      expect(c.classification).not.toBe('fair');
      expect(c.daysToExpiration).toBeGreaterThanOrEqual(21);
      expect(c.daysToExpiration).toBeLessThanOrEqual(60);
    }
    // Event/IV lanes are fused through.
    expect(fused!.ivRank).toBe(68);
    expect(fused!.nextEarningsInDays).toBe(20);
    expect(fused!.daysToFOMC).toBe(9);
    expect(fused!.macroEventsNearby).toEqual(['CPI in 2d']);
  });

  it('returns null when no IV/event context is supplied but still scans (all-null lanes)', () => {
    const fused = fuseOptionsResearchSymbol(loadSnapshot(), { now: ASOF });
    expect(fused).not.toBeNull();
    expect(fused!.ivRank).toBeNull();
    expect(fused!.newsSentiment).toBeNull();
    expect(fused!.macroEventsNearby).toEqual([]);
  });
});

describe('fuse → runOptionsResearch (full pipeline)', () => {
  it('produces a ranked list of defined-risk ideas with every required field', async () => {
    const batch = fuseOptionsResearchInput([loadSnapshot()], ASOF, {
      now: ASOF,
      contextFor: (s) => context[s] ?? {},
      maxIdeas: 3,
    });
    expect(batch.symbols).toHaveLength(1);

    // A realistic Head-of-Research response grounded in the fused candidates.
    const llm = new StubLlmClient(() =>
      JSON.stringify({
        ideas: [
          {
            ticker: 'AAPL',
            strategy: 'bear_call_spread',
            thesis: 'OTM 205 call is ~28% rich vs theo with IV-rank 68 — sell the rich call, cap with a higher wing.',
            pop: 0.71,
            maxLossUsd: 300,
            dteDays: 39,
            eventContext: ['earnings in 20d', 'CPI in 2d'],
          },
          {
            ticker: 'AAPL',
            strategy: 'bull_put_spread',
            thesis: 'OTM 185 put is ~28% rich — sell premium with a defined wing below.',
            pop: 0.66,
            maxLossUsd: 350,
            dteDays: 39,
            eventContext: ['earnings in 20d'],
          },
        ],
      }),
    );

    const out = await runOptionsResearch(batch, { llm });
    expect(out.ideas.length).toBeGreaterThanOrEqual(1);
    expect(out.ideas.map((i) => i.rank)).toEqual(out.ideas.map((_, i) => i + 1));
    for (const idea of out.ideas) {
      expect(idea.ticker).toBe('AAPL');
      expect(isDefinedRiskStrategy(idea.strategy)).toBe(true);
      expect(idea.thesis.length).toBeGreaterThan(0);
      expect(idea.pop).toBeGreaterThan(0);
      expect(idea.pop).toBeLessThanOrEqual(1);
      expect(idea.maxLossUsd).toBeGreaterThan(0);
      expect(idea.dteDays).toBeGreaterThanOrEqual(21);
    }
    // One structured call for the whole batch.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.purpose).toBe('options-research');
  });
});
