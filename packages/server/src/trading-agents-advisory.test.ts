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
  resolveApexNotionalUsd,
  resolveThinkingEffort,
  resolveTradingAgentsLlm,
  buildNewsHeadlines,
  OPUS_NOTIONAL_ENV_VAR,
  THINKING_EFFORT_ENV_VAR,
} from './trading-agents-advisory.js';
import {
  agentSpendAggregate,
  agentUserSpendStatus,
  isOverUserDailyCap,
  recordAgentSpend,
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

/** Canned LlmClient: analysts→kind, trader→BUY, risk→APPROVE. Bills costPerCall per call.
 *  Records the tier used for each purpose so tests can assert on model-tier routing. */
function cannedLlm(costPerCall: number): LlmClient & { calls: number; tierByPurpose: Record<string, string> } {
  const state = { calls: 0 };
  const client: LlmClient & { calls: number; tierByPurpose: Record<string, string> } = {
    calls: 0,
    tierByPurpose: {},
    async complete(req) {
      state.calls += 1;
      client.calls = state.calls;
      client.tierByPurpose[req.purpose] = req.tier;
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

describe('adviseSymbol — cap hard-stop (acceptance #1, TRA-915 $10)', () => {
  it('stops issuing paid calls once the user reaches the $10/day cap', async () => {
    const llm = cannedLlm(2); // 6 calls/run (4 analysts + trader + risk) → $12.00 per LLM run

    // Run 1: user is under the cap → real LLM path, spend recorded (~$12.00, over the $10 cap).
    const r1 = await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    expect(r1.llmUsed).toBe(true);
    expect(r1.recommendation.costUsd).toBeCloseTo(12.0, 6);
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

describe('adviseSymbol — concurrent cap holds (TRA-1045 R2 TOCTOU)', () => {
  it('admits only the calls that fit under the cap when many run in parallel', async () => {
    const llm = cannedLlm(0.5); // 6 calls/run → $3.00 per real LLM run

    // Seed the user to $9.00 committed — $1.00 of headroom under the $10/day cap, less
    // than even a single run. Pre-fix, every concurrent caller would read $9 < $10 and
    // all fire a paid run (TOCTOU); the atomic reservation must admit just one.
    recordAgentSpend('carol', 9, NOW);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => adviseSymbol(input, { user: 'carol', enabled: true, llm, now: NOW })),
    );

    const paid = results.filter(r => r.llmUsed).length;
    expect(paid).toBe(1); // exactly one in-flight reservation claimed the headroom
    // Committed spend = $9 seed + one $3 run = $12; it never compounded to $9 + 6×$3.
    expect(agentUserSpendStatus('carol', NOW).spentUsd).toBeCloseTo(12, 6);
    expect(isOverUserDailyCap('carol', NOW)).toBe(true);
    // Every denied call still returns a usable deterministic advisory (no throw, $0).
    for (const r of results) {
      expect(r.recommendation.symbol).toBe('AAA');
      if (!r.llmUsed) expect(r.recommendation.costUsd).toBe(0);
    }
  });

  it('reconciles each reservation so headroom is not permanently consumed', async () => {
    const llm = cannedLlm(0.1); // $0.60 per run — well under the cap

    // Three sequential runs for a fresh user each book only their real cost; the
    // in-flight reservations ($2 estimate each) must be released, not leaked.
    await adviseSymbol(input, { user: 'dave', enabled: true, llm, now: NOW });
    await adviseSymbol(input, { user: 'dave', enabled: true, llm, now: NOW });
    await adviseSymbol(input, { user: 'dave', enabled: true, llm, now: NOW });

    // 3 × $0.60 = $1.80 committed, far below the cap — proof reservations net to zero.
    expect(agentUserSpendStatus('dave', NOW).spentUsd).toBeCloseTo(1.8, 6);
    expect(isOverUserDailyCap('dave', NOW)).toBe(false);
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

describe('adviseSymbol — company-wide daily ceiling (TRA-915)', () => {
  it('falls back to the deterministic path once the company ceiling is breached', async () => {
    // Push aggregate spend over the $100 company ceiling via other users first.
    for (let i = 0; i < 12; i++) recordAgentSpend(`bot${i}`, 9, NOW); // $108 aggregate
    const llm = cannedLlm(0.5);
    // Alice is brand-new (well under her own $10 cap) but the company ceiling is hit.
    const r = await adviseSymbol(input, { user: 'alice', enabled: true, llm, now: NOW });
    expect(r.llmUsed).toBe(false);
    expect(r.recommendation.costUsd).toBe(0);
    expect(llm.calls).toBe(0);
  });
});

describe('adviseSymbol — Opus apex-tier on high notional (TRA-915)', () => {
  it('routes the final risk/decision step to apex (Opus) only above the threshold', async () => {
    const llm = cannedLlm(0.01);
    const big = { ...input, notionalUsd: 50_000 };
    await adviseSymbol(big, {
      user: 'alice',
      enabled: true,
      llm,
      now: NOW,
      graphDeps: { apexNotionalUsd: 25_000 },
    });
    // The final risk step escalated; routine screening stayed on fast/strong.
    expect(llm.tierByPurpose['risk-manager']).toBe('apex');
    expect(llm.tierByPurpose['trader']).toBe('strong');
    expect(llm.tierByPurpose['analyst:technical']).toBe('fast');
  });

  it('keeps the routine strong (Sonnet) tier below the threshold', async () => {
    const llm = cannedLlm(0.01);
    const small = { ...input, notionalUsd: 5_000 };
    await adviseSymbol(small, {
      user: 'bob',
      enabled: true,
      llm,
      now: NOW,
      graphDeps: { apexNotionalUsd: 25_000 },
    });
    expect(llm.tierByPurpose['risk-manager']).toBe('strong');
  });

  it('never escalates when no threshold is configured (apex off by default)', async () => {
    const llm = cannedLlm(0.01);
    const big = { ...input, notionalUsd: 1_000_000 };
    await adviseSymbol(big, { user: 'carol', enabled: true, llm, now: NOW, graphDeps: {} });
    expect(llm.tierByPurpose['risk-manager']).toBe('strong');
  });
});

describe('resolveApexNotionalUsd — env threshold (TRA-915)', () => {
  it('parses a positive threshold and rejects empty/invalid/non-positive', () => {
    expect(resolveApexNotionalUsd({ [OPUS_NOTIONAL_ENV_VAR]: '25000' })).toBe(25000);
    expect(resolveApexNotionalUsd({})).toBeUndefined();
    expect(resolveApexNotionalUsd({ [OPUS_NOTIONAL_ENV_VAR]: '' })).toBeUndefined();
    expect(resolveApexNotionalUsd({ [OPUS_NOTIONAL_ENV_VAR]: 'abc' })).toBeUndefined();
    expect(resolveApexNotionalUsd({ [OPUS_NOTIONAL_ENV_VAR]: '0' })).toBeUndefined();
    expect(resolveApexNotionalUsd({ [OPUS_NOTIONAL_ENV_VAR]: '-5' })).toBeUndefined();
  });
});

describe('resolveThinkingEffort — env activation (TRA-1042)', () => {
  it('accepts low/medium/high (case-insensitive) and is off otherwise', () => {
    expect(resolveThinkingEffort({ [THINKING_EFFORT_ENV_VAR]: 'high' })).toBe('high');
    expect(resolveThinkingEffort({ [THINKING_EFFORT_ENV_VAR]: 'MEDIUM' })).toBe('medium');
    expect(resolveThinkingEffort({ [THINKING_EFFORT_ENV_VAR]: ' low ' })).toBe('low');
    expect(resolveThinkingEffort({})).toBeUndefined();
    expect(resolveThinkingEffort({ [THINKING_EFFORT_ENV_VAR]: '' })).toBeUndefined();
    expect(resolveThinkingEffort({ [THINKING_EFFORT_ENV_VAR]: 'max' })).toBeUndefined();
    expect(resolveThinkingEffort({ [THINKING_EFFORT_ENV_VAR]: 'on' })).toBeUndefined();
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

// ── TRA-3514 (TRA-3460 (c) §1) — the backing stamp on the RECOMMENDATION ─────
//
// The pre-existing tests above already assert `AdviseResult.llmUsed`. That field has
// been correct since TRA-747 and was still discarded by the only caller, because it
// lived on a wrapper that gets unwrapped one line later. These tests assert it on the
// object that actually TRAVELS downstream — which is the whole of the fix.
describe('adviseSymbol — stamps llmUsed onto the recommendation itself (TRA-3514)', () => {
  it('stamps true on the LLM path', async () => {
    const llm = cannedLlm(0.001);
    const r = await adviseSymbol(input, { user: 'stamp-a', enabled: true, llm, now: NOW });
    expect(r.llmUsed).toBe(true);
    expect(r.recommendation.llmUsed).toBe(true);
    // The wrapper and the stamped object must never disagree — a consumer reading
    // either one has to reach the same conclusion.
    expect(r.recommendation.llmUsed).toBe(r.llmUsed);
  });

  it('stamps false on the DETERMINISTIC fallback — the read the panel must not trust', async () => {
    // No llm wired at all: the zero-cost graph runs.
    const r = await adviseSymbol(input, { user: 'stamp-b', enabled: true, llm: null, now: NOW });
    expect(r.llmUsed).toBe(false);
    expect(r.recommendation.llmUsed).toBe(false);
    // ⭐ The fallback is NOT an abstention and NOT a throw: it publishes a
    // schema-valid recommendation carrying a real-looking conviction. This assertion
    // IS the defect statement — without the stamp there is nothing on this object to
    // distinguish it from the LLM-backed one above.
    expect(r.recommendation.symbol).toBe('AAA');
    expect(typeof r.recommendation.conviction).toBe('number');
    expect(r.recommendation.costUsd).toBe(0);
  });

  it('stamps false when the banner toggle is OFF', async () => {
    const llm = cannedLlm(0.001);
    const r = await adviseSymbol(input, { user: 'stamp-c', enabled: false, llm, now: NOW });
    expect(r.recommendation.llmUsed).toBe(false);
    expect(llm.calls).toBe(0);
  });

  it('stamps false on the CAP-DENIED tail — the case that arms on the first funded session', async () => {
    const llm = cannedLlm(0.001);
    // Park the user at the cap so `tryReserveAgentSpend` returns null.
    recordAgentSpend('stamp-d', 999, NOW);
    const r = await adviseSymbol(input, { user: 'stamp-d', enabled: true, llm, now: NOW });
    expect(r.llmUsed).toBe(false);
    expect(r.recommendation.llmUsed).toBe(false);
    expect(llm.calls).toBe(0);
  });

  it('costUsd is NOT a usable proxy for the backing (why the field had to be added)', async () => {
    // A real, LLM-backed run that happened to bill $0 stamps `llmUsed: true` while
    // `costUsd` is 0 — identical to the fallback on the cost axis. Anyone tempted to
    // infer backing from cost would read this row backwards.
    const free = cannedLlm(0);
    const r = await adviseSymbol(input, { user: 'stamp-e', enabled: true, llm: free, now: NOW });
    expect(r.recommendation.costUsd).toBe(0);
    expect(r.recommendation.llmUsed).toBe(true);
    expect(free.calls).toBeGreaterThan(0);
  });
});

// ── TRA-3514 Part 3 — the reservation-estimate question, pinned in code ──────
describe('TRA-3514 Part 3 — the $2 default does NOT gate the first reservation', () => {
  it('K is not 0: a serial walk gets real reads until COMMITTED spend reaches the cap', async () => {
    const savedUser = process.env['TRADING_AGENTS_DAILY_USER_USD_CAP'];
    const savedCo = process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'];
    const savedEst = process.env['TRADING_AGENTS_CALL_COST_ESTIMATE_USD'];
    // Reproduce bqb1: $0.50 caps, reservation estimate UNSET (so the $2 default).
    process.env['TRADING_AGENTS_DAILY_USER_USD_CAP'] = '0.50';
    process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'] = '0.50';
    delete process.env['TRADING_AGENTS_CALL_COST_ESTIMATE_USD'];
    try {
      resetAgentSpendForTests();
      // 6 calls/run at $0.01 => $0.06 committed per advised symbol.
      const llm = cannedLlm(0.01);
      const backings: boolean[] = [];
      // SERIAL, exactly as runAdvisorySweep walks it (batchSize 1, awaited).
      for (let i = 0; i < 12; i++) {
        const r = await adviseSymbol(input, { user: 'k', enabled: true, llm, now: NOW });
        backings.push(r.llmUsed);
      }
      const advised = backings.filter(Boolean).length;
      // ⭐ THE ANSWER. If the $2 estimate gated the first reservation, this would be 0.
      // It is not: the guard is an AT-CAP test on booked spend, and the $2 hold is
      // released before the next symbol checks.
      expect(advised).toBeGreaterThan(0);
      // And K is bounded by COMMITTED spend, not by the estimate: $0.50 / $0.06 = 8.
      expect(advised).toBe(9); // symbols 1..9 admitted; the 9th tips the total over $0.50
      expect(backings.slice(advised).every(b => b === false)).toBe(true);
      // The tail is the defect Part 1 makes visible: real recommendations, fake backing.
      expect(backings[11]).toBe(false);
    } finally {
      if (savedUser === undefined) delete process.env['TRADING_AGENTS_DAILY_USER_USD_CAP'];
      else process.env['TRADING_AGENTS_DAILY_USER_USD_CAP'] = savedUser;
      if (savedCo === undefined) delete process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'];
      else process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'] = savedCo;
      if (savedEst !== undefined) process.env['TRADING_AGENTS_CALL_COST_ESTIMATE_USD'] = savedEst;
      resetAgentSpendForTests();
    }
  });

  it('but the $2 default DOES deny every CONCURRENT call at a $0.50 cap', async () => {
    const savedCo = process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'];
    const savedEst = process.env['TRADING_AGENTS_CALL_COST_ESTIMATE_USD'];
    process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'] = '0.50';
    delete process.env['TRADING_AGENTS_CALL_COST_ESTIMATE_USD'];
    try {
      resetAgentSpendForTests();
      const llm = cannedLlm(0.01);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => adviseSymbol(input, { user: 'conc', enabled: true, llm, now: NOW })),
      );
      // Exactly ONE reservation fits: the first books $2.00 of in-flight hold, which is
      // 4x the whole company cap, so every sibling is denied and silently degraded.
      expect(results.filter(r => r.llmUsed).length).toBe(1);
    } finally {
      if (savedCo === undefined) delete process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'];
      else process.env['TRADING_AGENTS_COMPANY_DAILY_USD_CAP'] = savedCo;
      if (savedEst !== undefined) process.env['TRADING_AGENTS_CALL_COST_ESTIMATE_USD'] = savedEst;
      resetAgentSpendForTests();
    }
  });
});
