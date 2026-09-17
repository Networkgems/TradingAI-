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
import { blackScholesPrice, type OptionChainRow } from '@trading-app/engine';
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

/**
 * TRA-895 — a CALM-day chain: every contract is priced exactly at its flat-IV
 * Black-Scholes theo, so neither scanner flags an anomaly (all 'fair'). Liquid
 * (OI 1000, ~2% spread) so the near-ATM seed is eligible. One ~35-DTE expiration.
 */
function calmChainSnapshot(): OptionChainSnapshotFile {
  const spot = 100;
  const sigma = 0.3;
  const exp = '2026-07-13'; // ~35 DTE from ASOF
  const T = (Date.parse(`${exp}T16:00:00-04:00`) - ASOF) / (365 * 86_400_000);
  const rows: OptionChainRow[] = [];
  for (let strike = 85; strike <= 115; strike += 5) {
    for (const optionType of ['call', 'put'] as const) {
      const theo = blackScholesPrice({
        spot,
        strike,
        timeToExpiryYears: T,
        riskFreeRate: 0.045,
        volatility: sigma,
        optionType,
      });
      // Price exactly at theo (flat IV ⇒ scanners see no mispricing). Skip any
      // penny strike so a floor can't manufacture a fake mispricing ratio.
      if (theo < 0.1) continue;
      const mid = theo;
      rows.push({
        optionSymbol: `CALM${exp.replace(/-/g, '')}${optionType[0]!.toUpperCase()}${strike}`,
        underlying: 'CALM',
        optionType,
        strike,
        expiration: exp,
        bid: mid * 0.99,
        ask: mid * 1.01,
        last: mid,
        volume: 500,
        openInterest: 1000,
        midIv: sigma,
        smvVol: sigma,
      });
    }
  }
  return { symbol: 'CALM', spot, recordedAt: ASOF, expirations: [exp], rows };
}

// Event/IV context the server would resolve from the C1/C2/sentiment stores.
const context: Record<string, SymbolEventContext> = {
  AAPL: {
    ivRank: 68,
    // TRA-4644 — the percentile sibling rides the same context lane.
    ivPercentile: 84,
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
    // TRA-4644 — the percentile is carried beside the rank, as its own field.
    expect(fused!.ivPercentile).toBe(84);
    expect(fused!.nextEarningsInDays).toBe(20);
    expect(fused!.daysToFOMC).toBe(9);
    expect(fused!.macroEventsNearby).toEqual(['CPI in 2d']);
  });

  it('returns null when no IV/event context is supplied but still scans (all-null lanes)', () => {
    const fused = fuseOptionsResearchSymbol(loadSnapshot(), { now: ASOF });
    expect(fused).not.toBeNull();
    expect(fused!.ivRank).toBeNull();
    // TRA-4644 — honest null, never 0, when no context supplies a percentile.
    expect(fused!.ivPercentile).toBeNull();
    expect(fused!.newsSentiment).toBeNull();
    expect(fused!.macroEventsNearby).toEqual([]);
  });
});

describe('TRA-895 — ATM seed on calm days (no scanner anomaly)', () => {
  it('seeds near-ATM call + put anchors when no contract is flagged', () => {
    const fused = fuseOptionsResearchSymbol(calmChainSnapshot(), { now: ASOF });
    expect(fused).not.toBeNull();
    expect(fused!.symbol).toBe('CALM');
    // Exactly one near-ATM anchor per side, both honest non-anomalies.
    expect(fused!.candidates).toHaveLength(2);
    expect(new Set(fused!.candidates.map((c) => c.optionType))).toEqual(new Set(['call', 'put']));
    for (const c of fused!.candidates) {
      expect(c.source).toBe('atm_seed');
      expect(c.classification).toBe('fair');
      expect(c.mispricingPct).toBe(0);
      expect(c.daysToExpiration).toBeGreaterThanOrEqual(21);
      expect(c.daysToExpiration).toBeLessThanOrEqual(60);
      // Nearest-ATM strike picked (spot = 100, 5-wide chain → 100).
      expect(c.strike).toBe(100);
      expect(c.mark).toBeGreaterThan(0);
    }
  });

  it('restores anomaly-only behavior when seeding is disabled', () => {
    const fused = fuseOptionsResearchSymbol(calmChainSnapshot(), {
      now: ASOF,
      seedAtmAnchorsWhenEmpty: false,
    });
    expect(fused).toBeNull();
  });

  it('does NOT seed illiquid names (open interest below the floor)', () => {
    const snap = calmChainSnapshot();
    for (const r of snap.rows) r.openInterest = 10; // below the 250 floor
    const fused = fuseOptionsResearchSymbol(snap, { now: ASOF });
    expect(fused).toBeNull();
  });

  it('does not override a genuine scanner anomaly with seeds', () => {
    // The recorded fixture has deliberately-mispriced contracts → real anomalies.
    const fused = fuseOptionsResearchSymbol(loadSnapshot(), { now: ASOF });
    expect(fused).not.toBeNull();
    expect(fused!.candidates.every((c) => c.source !== 'atm_seed')).toBe(true);
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
