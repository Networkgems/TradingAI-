import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runIdeasAutoExecute,
  ideaFingerprint,
  optionsIdeasAutoExecuteHealth,
  resetIdeasAutoExecuteState,
  isIdeaFingerprintSubmitted,
} from './options-ideas-auto-execute.js';
import {
  isOptionIdeasAutoExecuteEnabled,
  resolveOptionIdeasAutoExecuteTopN,
  OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N,
} from './option-exec-flag.js';
import type { OptionsIdeasFeed, OptionsIdeaView, IdeaEntryIntent } from './options-ideas-feed.js';

// TRA-1205 — auto-execute the top-N ranked AI option ideas into the demo paper
// book. These tests prove the selection (top-N enterable, rank-ordered), the
// dedup guard (same fingerprint never enters twice in a session), the demo-only
// gate, that gate-blocked opens are retryable (not fingerprinted), and that the
// health surface reports the flag/top-N/last-run honestly.

const NOW = 1_700_000_000_000;

function intent(over: Partial<IdeaEntryIntent> = {}): IdeaEntryIntent {
  return {
    ticker: 'AAPL',
    optionSymbol: 'AAPL240119C00190000',
    optionType: 'call',
    strike: 190,
    expiration: '2026-08-21',
    mark: 3.2,
    delta: 0.55,
    spot: 188,
    strategy: 'long_call',
    legs: [{ action: 'buy', optionType: 'call', strike: 190, expiration: '2026-08-21' }],
    netUsd: -320,
    maxLossUsd: 320,
    maxProfitUsd: 1200,
    breakevens: [193.2],
    pop: 0.42,
    ...over,
  };
}

function idea(over: Partial<OptionsIdeaView> = {}): OptionsIdeaView {
  return {
    id: 'idea-1',
    rank: 1,
    ticker: 'AAPL',
    strategy: 'Long Call',
    thesis: 't',
    pop: 0.42,
    maxLossUsd: 320,
    maxProfitUsd: 1200,
    netUsd: -320,
    breakevens: [193.2],
    dte: 52,
    events: [],
    legs: [{ action: 'buy', optionType: 'call', strike: 190, expiration: '2026-08-21' }],
    enterable: true,
    ...over,
  };
}

function feedOf(ideas: OptionsIdeaView[]): OptionsIdeasFeed {
  return {
    ideas,
    noDayTrading: { enforced: true, minHoldDays: 1, note: '' },
    generatedAt: NOW,
    source: 'live',
    availability: { state: 'ok', code: 'ok', scope: 'none' },
  };
}

/** Map each idea id → a matching intent so the registry lookup succeeds. */
function intentMapOf(ideas: OptionsIdeaView[]): (id: string) => IdeaEntryIntent | undefined {
  const m = new Map<string, IdeaEntryIntent>();
  for (const i of ideas) {
    m.set(
      i.id,
      intent({ ticker: i.ticker, strategy: 'long_call', expiration: i.legs[0]?.expiration ?? '2026-08-21' }),
    );
  }
  return (id) => m.get(id);
}

beforeEach(() => {
  resetIdeasAutoExecuteState();
});

describe('resolveOptionIdeasAutoExecuteTopN', () => {
  it('defaults to 3 when unset', () => {
    expect(resolveOptionIdeasAutoExecuteTopN({})).toBe(OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N);
    expect(OPTION_IDEAS_AUTO_EXECUTE_DEFAULT_TOP_N).toBe(3);
  });
  it('honours a valid override', () => {
    expect(resolveOptionIdeasAutoExecuteTopN({ OPTION_IDEAS_AUTO_EXECUTE_TOP_N: '5' })).toBe(5);
  });
  it('falls back to the default on a malformed/zero value (never silently disables)', () => {
    expect(resolveOptionIdeasAutoExecuteTopN({ OPTION_IDEAS_AUTO_EXECUTE_TOP_N: '0' })).toBe(3);
    expect(resolveOptionIdeasAutoExecuteTopN({ OPTION_IDEAS_AUTO_EXECUTE_TOP_N: 'abc' })).toBe(3);
    expect(resolveOptionIdeasAutoExecuteTopN({ OPTION_IDEAS_AUTO_EXECUTE_TOP_N: '-2' })).toBe(3);
  });
  it('clamps an over-wide value to the ceiling', () => {
    expect(resolveOptionIdeasAutoExecuteTopN({ OPTION_IDEAS_AUTO_EXECUTE_TOP_N: '999' })).toBe(25);
  });
});

describe('isOptionIdeasAutoExecuteEnabled', () => {
  it('is OFF by default and accepts the usual truthy forms', () => {
    expect(isOptionIdeasAutoExecuteEnabled({})).toBe(false);
    expect(isOptionIdeasAutoExecuteEnabled({ ENABLE_OPTION_IDEAS_AUTO_EXECUTE: 'true' })).toBe(true);
    expect(isOptionIdeasAutoExecuteEnabled({ ENABLE_OPTION_IDEAS_AUTO_EXECUTE: 'on' })).toBe(true);
    expect(isOptionIdeasAutoExecuteEnabled({ ENABLE_OPTION_IDEAS_AUTO_EXECUTE: 'no' })).toBe(false);
  });
});

describe('runIdeasAutoExecute — top-N selection', () => {
  it('enters only the top N enterable ideas, in rank order', () => {
    const ideas = [
      idea({ id: 'a', rank: 1 }),
      idea({ id: 'b', rank: 2, ticker: 'MSFT' }),
      idea({ id: 'c', rank: 3, ticker: 'NVDA' }),
      idea({ id: 'd', rank: 4, ticker: 'TSLA' }),
    ];
    const enter = vi.fn((_intent: IdeaEntryIntent) => ({ id: 'pos' }));
    const summary = runIdeasAutoExecute({
      feed: feedOf(ideas),
      mode: 'demo',
      scope: 'demo-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter,
      now: NOW,
    });
    expect(summary.ran).toBe(true);
    expect(summary.considered).toBe(3);
    expect(summary.submitted).toBe(3);
    expect(enter).toHaveBeenCalledTimes(3);
    // The 4th (TSLA) was never examined.
    expect(enter.mock.calls.map((c) => (c[0] as IdeaEntryIntent).ticker)).toEqual([
      'AAPL',
      'MSFT',
      'NVDA',
    ]);
  });

  it('skips un-enterable ideas and only counts enterable ones toward top N', () => {
    const ideas = [
      idea({ id: 'a', rank: 1, enterable: false }),
      idea({ id: 'b', rank: 2, ticker: 'MSFT', enterable: true }),
      idea({ id: 'c', rank: 3, ticker: 'NVDA', enterable: undefined }),
      idea({ id: 'd', rank: 4, ticker: 'TSLA', enterable: true }),
    ];
    const enter = vi.fn((_intent: IdeaEntryIntent) => ({ id: 'pos' }));
    const summary = runIdeasAutoExecute({
      feed: feedOf(ideas),
      mode: 'demo',
      scope: 'demo-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter,
      now: NOW,
    });
    // Only MSFT + TSLA are enterable (undefined treated as not-enterable).
    expect(summary.submitted).toBe(2);
    expect(enter.mock.calls.map((c) => (c[0] as IdeaEntryIntent).ticker)).toEqual(['MSFT', 'TSLA']);
  });
});

describe('runIdeasAutoExecute — dedup guard', () => {
  it('does not re-enter the same fingerprint on a second run (cached feed re-poll)', () => {
    const ideas = [idea({ id: 'a', rank: 1 })];
    const enter = vi.fn(() => ({ id: 'pos' }));
    const args = {
      feed: feedOf(ideas),
      mode: 'demo' as const,
      scope: 'demo-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter,
      now: NOW,
    };
    const first = runIdeasAutoExecute(args);
    expect(first.submitted).toBe(1);
    const second = runIdeasAutoExecute(args);
    expect(second.submitted).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it('scopes the dedup per user (two demo books can each enter the same idea)', () => {
    const ideas = [idea({ id: 'a', rank: 1 })];
    const enter = vi.fn(() => ({ id: 'pos' }));
    const base = { feed: feedOf(ideas), mode: 'demo' as const, topN: 3, getIntent: intentMapOf(ideas), enter, now: NOW };
    runIdeasAutoExecute({ ...base, scope: 'user-1' });
    const other = runIdeasAutoExecute({ ...base, scope: 'user-2' });
    expect(other.submitted).toBe(1);
    expect(enter).toHaveBeenCalledTimes(2);
  });
});

describe('runIdeasAutoExecute — demo-only gate', () => {
  it('never enters on a non-demo book and reports the skip reason', () => {
    const ideas = [idea({ id: 'a', rank: 1 })];
    const enter = vi.fn(() => ({ id: 'pos' }));
    const summary = runIdeasAutoExecute({
      feed: feedOf(ideas),
      mode: 'live',
      scope: 'live-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter,
      now: NOW,
    });
    expect(summary.ran).toBe(false);
    expect(summary.skippedReason).toBe('not_demo');
    expect(enter).not.toHaveBeenCalled();
  });
});

describe('runIdeasAutoExecute — gate-blocked opens stay retryable', () => {
  it('does NOT fingerprint a refused open, so the next cycle can retry it', () => {
    const ideas = [idea({ id: 'a', rank: 1 })];
    let allow = false;
    const enter = vi.fn(() => (allow ? { id: 'pos' } : null));
    const args = {
      feed: feedOf(ideas),
      mode: 'demo' as const,
      scope: 'demo-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter,
      now: NOW,
    };
    const first = runIdeasAutoExecute(args);
    expect(first.submitted).toBe(0);
    expect(first.failed).toBe(1);
    const fp = ideaFingerprint('demo-user', intent());
    expect(isIdeaFingerprintSubmitted(fp)).toBe(false);
    // Now the gate clears — the retry succeeds.
    allow = true;
    const second = runIdeasAutoExecute(args);
    expect(second.submitted).toBe(1);
    expect(isIdeaFingerprintSubmitted(fp)).toBe(true);
  });

  it('swallows a thrown open and counts it as failed (feed read never breaks)', () => {
    const ideas = [idea({ id: 'a', rank: 1 })];
    const enter = vi.fn(() => {
      throw new Error('cap reached');
    });
    const summary = runIdeasAutoExecute({
      feed: feedOf(ideas),
      mode: 'demo',
      scope: 'demo-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter,
      now: NOW,
    });
    expect(summary.submitted).toBe(0);
    expect(summary.failed).toBe(1);
  });

  it('counts ideas whose intent expired from the registry', () => {
    const ideas = [idea({ id: 'a', rank: 1 })];
    const enter = vi.fn(() => ({ id: 'pos' }));
    const summary = runIdeasAutoExecute({
      feed: feedOf(ideas),
      mode: 'demo',
      scope: 'demo-user',
      topN: 3,
      getIntent: () => undefined,
      enter,
      now: NOW,
    });
    expect(summary.skippedNoIntent).toBe(1);
    expect(enter).not.toHaveBeenCalled();
  });
});

describe('optionsIdeasAutoExecuteHealth', () => {
  it('reports a null last-run before any cycle, with flag/top-N mirrored from env', () => {
    const h = optionsIdeasAutoExecuteHealth({ ENABLE_OPTION_IDEAS_AUTO_EXECUTE: '1', OPTION_IDEAS_AUTO_EXECUTE_TOP_N: '4' });
    expect(h.enabled).toBe(true);
    expect(h.topN).toBe(4);
    expect(h.sessionSubmitted).toBe(0);
    expect(h.dedupTracked).toBe(0);
    expect(h.lastRun).toBeNull();
  });

  it('reports last-run counts + lifetime submit total after a cycle', () => {
    const ideas = [idea({ id: 'a', rank: 1 }), idea({ id: 'b', rank: 2, ticker: 'MSFT' })];
    runIdeasAutoExecute({
      feed: feedOf(ideas),
      mode: 'demo',
      scope: 'demo-user',
      topN: 3,
      getIntent: intentMapOf(ideas),
      enter: () => ({ id: 'pos' }),
      now: NOW,
    });
    const h = optionsIdeasAutoExecuteHealth({});
    expect(h.enabled).toBe(false); // mirrors the (unset) env, independent of the run
    expect(h.sessionSubmitted).toBe(2);
    expect(h.dedupTracked).toBe(2);
    expect(h.lastRun).not.toBeNull();
    expect(h.lastRun?.ran).toBe(true);
    expect(h.lastRun?.submitted).toBe(2);
    expect(h.lastRun?.mode).toBe('demo');
    expect(h.lastRun?.at).toBe(new Date(NOW).toISOString());
  });
});
