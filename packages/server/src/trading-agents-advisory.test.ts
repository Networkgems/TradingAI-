// TRA-747 (TRA-529 P2) — the advisory orchestration seam. These tests prove all
// four CFO operating conditions end-to-end through the real graph (driven by a
// canned, network-free LlmClient):
//   #1 cap          — spend hard-stops at $2.00/user/day (no further paid calls once reached).
//   #2 advisor-mode — even an APPROVE with a routable signal NEVER routes to capital.
//   #3 kill switches — the banner toggle AND the env credential/kill each cut spend to zero.
//   #4 aggregate    — recorded spend rolls into the daily aggregate readout.
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentGraphInput, LlmClient } from '@trading-app/agents';
import type { Candle, NewsItem } from '@trading-app/shared';
import {
  adviseSymbol,
  resolveTradingAgentsLlm,
  buildNewsHeadlines,
} from './trading-agents-advisory.js';
import {
  agentSpendAggregate,
  agentUserSpendStatus,
  isOverUserDailyCap,
  resetAgentSpendForTests,
} from './agent-spend-store.js';

const NOW = Date.parse('2026-06-09T15:00:00Z');

beforeEach(() => resetAgentSpendForTests());

function candles(n = 30, start = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * 0.8; // rising → BUY
    return { symbol: 'AAA', timestamp: 1_000 + i * 60_000, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1_000 };
  });
}

const input: AgentGraphInput = { symbol: 'AAA', asOf: 5_000_000, candles: candles(), candidateSignal: null };

/** Canned LlmClient: analysts→kind, trader→BUY, risk→APPROVE. Bills costPerCall per call. */
function cannedLlm(costPerCall: number): LlmClient & { calls: number } {
  const state = { calls: 0 };
  const client: LlmClient & { calls: number } = {
    calls: 0,
    async complete(req) {
      state.calls += 1;
      client.calls = state.calls;
      const kind = req.purpose.startsWith('analyst:') ? req.purpose.split(':')[1] : null;
      let text: string;
      if (kind) {
        text = JSON.stringify({ kind, stance: 0.6, confidence: 0.7, horizonDays: 5, keyLevels: { support: 90, resistance: 140 }, drivers: ['m'], notes: 'ok' });
      } else if (req.purpose === 'trader') {
        text = JSON.stringify({ action: 'BUY', conviction: 0.7, proposedEntry: 100, proposedStop: 98, proposedTarget: 106, riskRewardRatio: 3, thesis: 't', dissent: 'd' });
      } else {
        text = JSON.stringify({ verdict: 'APPROVE', sizeMultiplier: 0.6, panel: [
          { persona: 'aggressive', sizeMultiplier: 0.6, reasons: ['x'] },
          { persona: 'neutral', sizeMultiplier: 0.5, reasons: ['x'] },
          { persona: 'conservative', sizeMultiplier: 0.3, reasons: ['x'] },
        ], reasons: ['ok'] });
      }
      return { text, costUsd: costPerCall, model: req.tier === 'fast' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6' };
    },
  };
  return client;
}

describe('adviseSymbol — cap hard-stop (acceptance #1)', () => {
  it('stops issuing paid calls once the user reaches the $2/day cap', async () => {
    const llm = cannedLlm(0.5); // 6 calls/run (4 analysts + trader + risk) → $3.00 per LLM run

    // Run 1: user is under the cap → real LLM path, spend recorded (~$3.00).
    const r1 = await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    expect(r1.llmUsed).toBe(true);
    expect(r1.recommendation.costUsd).toBeCloseTo(3.0, 6);
    expect(isOverUserDailyCap('alice', NOW)).toBe(true);
    const spentAfter1 = agentUserSpendStatus('alice', NOW).spentUsd;
    const callsAfter1 = llm.calls;

    // Run 2 & 3: user is now over the cap → deterministic zero-spend fallback.
    const r2 = await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    const r3 = await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    expect(r2.llmUsed).toBe(false);
    expect(r3.llmUsed).toBe(false);
    expect(r2.recommendation.costUsd).toBe(0);
    // No further model calls were made and spend did not grow past the one run.
    expect(llm.calls).toBe(callsAfter1);
    expect(agentUserSpendStatus('alice', NOW).spentUsd).toBe(spentAfter1);
    // The fallback still yields a usable, schema-valid advisory recommendation.
    expect(r2.recommendation.symbol).toBe('AAA');
  });
});

describe('adviseSymbol — advisor-mode invariant (acceptance #2)', () => {
  it('produces an APPROVE recommendation but NEVER routes it to capital', async () => {
    const llm = cannedLlm(0.01);
    const r = await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    // The model APPROVEd and a routable proposedSignal is present as DATA…
    expect(r.recommendation.verdict).toBe('APPROVE');
    expect(r.recommendation.proposedSignal).not.toBeNull();
    // …but the layer routes nothing to capital. This flag is the tested invariant.
    expect(r.routedToCapital).toBe(false);
  });
});

describe('adviseSymbol — kill switches (acceptance #3)', () => {
  it('banner toggle OFF cuts LLM spend to zero', async () => {
    const llm = cannedLlm(0.5);
    const r = await adviseSymbol(input, { user: 'alice', enabled: false, llm, now: NOW });
    expect(r.llmUsed).toBe(false);
    expect(r.recommendation.costUsd).toBe(0);
    expect(llm.calls).toBe(0);
    expect(agentSpendAggregate(NOW).totalUsd).toBe(0);
  });

  it('no LLM client (env kill / no creds) cuts LLM spend to zero', async () => {
    const r = await adviseSymbol(input, { user: 'alice', enabled: true, llm: null, now: NOW });
    expect(r.llmUsed).toBe(false);
    expect(r.recommendation.costUsd).toBe(0);
    expect(agentSpendAggregate(NOW).totalUsd).toBe(0);
  });
});

describe('resolveTradingAgentsLlm — env kill switch (acceptance #3, env side)', () => {
  it('returns null when the explicit kill env is set even with a key present', () => {
    expect(resolveTradingAgentsLlm({ ANTHROPIC_API_KEY: 'sk-test', TRADING_AGENTS_LLM_DISABLED: '1' })).toBeNull();
    expect(resolveTradingAgentsLlm({ ANTHROPIC_API_KEY: 'sk-test', TRADING_AGENTS_LLM_DISABLED: 'true' })).toBeNull();
  });
  it('returns null when no Anthropic credential is configured', () => {
    expect(resolveTradingAgentsLlm({})).toBeNull();
  });
  it('builds a client when a key is present and the kill switch is off', () => {
    expect(resolveTradingAgentsLlm({ ANTHROPIC_API_KEY: 'sk-test' })).not.toBeNull();
    expect(resolveTradingAgentsLlm({ ANTHROPIC_API_KEY: 'sk-test', TRADING_AGENTS_LLM_DISABLED: 'off' })).not.toBeNull();
  });
});

describe('adviseSymbol — aggregate accounting (acceptance #4)', () => {
  it('rolls recorded spend into the daily aggregate across users', async () => {
    const llm = cannedLlm(0.02); // 6 calls → $0.12 per run
    await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    await adviseSymbol(input, { user: 'bob', enabled: true, llm, now: NOW });
    const agg = agentSpendAggregate(NOW);
    expect(agg.userCount).toBe(2);
    expect(agg.totalUsd).toBeCloseTo(0.24, 2);
  });
});

// TRA-795 — the news feed the P1 stub left neutral (analysts.ts:129) is now
// shaped into the news analyst's point-in-time headlines.
describe('buildNewsHeadlines (TRA-795 news feed wiring)', () => {
  const asOf = Date.parse('2026-06-09T16:00:00Z');
  function item(over: Partial<NewsItem> & { title: string; publishedAt: string }): NewsItem {
    return { url: 'http://x', source: 'wire', ...over };
  }
  const cache: NewsItem[] = [
    item({ title: 'Apple crushes earnings', publishedAt: '2026-06-09T15:00:00Z', source: 'wire',
      sentiment: { score: 0.7, label: 'positive', confidence: 0.8, method: 'lexicon-v1' } }),
    item({ title: 'AAPL faces antitrust probe', publishedAt: '2026-06-09T15:30:00Z', source: 'reuters' }),
    item({ title: 'Apple unveils next chip', publishedAt: '2026-06-09T17:00:00Z', source: 'wire' }), // AFTER asOf
    item({ title: 'Tesla recalls vehicles', publishedAt: '2026-06-09T15:10:00Z', source: 'wire' }), // other symbol
  ];

  it('maps only symbol-matching, at/before-asOf articles, newest first', () => {
    const out = buildNewsHeadlines(cache, 'AAPL', asOf);
    expect(out.map(h => h.headline)).toEqual([
      'AAPL faces antitrust probe', // 15:30, newest qualifying
      'Apple crushes earnings',     // 15:00, matches by name alias
    ]);
    // The 17:00 article is dropped (look-ahead); Tesla is a different symbol.
    expect(out.some(h => /next chip/.test(h.headline))).toBe(false);
    expect(out.some(h => /Tesla/.test(h.headline))).toBe(false);
  });

  it('carries the pre-scored sentiment through, omits it when absent', () => {
    const out = buildNewsHeadlines(cache, 'AAPL', asOf);
    const beat = out.find(h => /crushes/.test(h.headline))!;
    const probe = out.find(h => /antitrust/.test(h.headline))!;
    expect(beat.sentiment).toBeCloseTo(0.7, 6);
    expect(probe.sentiment).toBeUndefined();
  });

  it('returns [] when nothing matches (analyst then abstains)', () => {
    expect(buildNewsHeadlines(cache, 'NVDA', asOf)).toEqual([]);
  });
});
