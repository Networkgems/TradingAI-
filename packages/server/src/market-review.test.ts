import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Candle, MarketReview } from '@trading-app/shared';
import {
  classifyMarketRegime,
  deriveGates,
  normalizeTnx,
  simpleMa,
  listMarketReviews,
  getLatestMarketReview,
  __resetMarketReviewStoreForTests,
  type RegimeInputs,
} from './market-review.js';

// ── pure helpers ─────────────────────────────────────────────────────────────

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    symbol: '^GSPC',
    timestamp: i * 86_400_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
  }));
}

describe('normalizeTnx', () => {
  it('passes through a plain percent yield', () => {
    expect(normalizeTnx(4.31)).toBeCloseTo(4.31);
  });
  it('divides the legacy ×10 convention back to a percent', () => {
    expect(normalizeTnx(42.5)).toBeCloseTo(4.25);
  });
  it('returns null for null / non-finite input', () => {
    expect(normalizeTnx(null)).toBeNull();
    expect(normalizeTnx(Number.NaN)).toBeNull();
  });
});

describe('simpleMa', () => {
  it('averages the last `period` closes', () => {
    expect(simpleMa(candles([1, 2, 3, 4, 5]), 5)).toBeCloseTo(3);
    expect(simpleMa(candles([1, 2, 3, 4, 10]), 2)).toBeCloseTo(7);
  });
  it('returns null when there is not enough history', () => {
    expect(simpleMa(candles([1, 2, 3]), 20)).toBeNull();
  });
});

// ── regime classification ───────────────────────────────────────────────────

describe('classifyMarketRegime', () => {
  it('GREEN when SPX above 20-DMA, low VIX, rates contained', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 13.5, tnx: 4.1 };
    expect(classifyMarketRegime(inputs).regime).toBe('green');
  });

  it('RED when SPX is below its 20-DMA (downtrend)', () => {
    const inputs: RegimeInputs = { spx: 5000, spxMa20: 5100, vix: 13, tnx: 4.0 };
    const { regime, rationale } = classifyMarketRegime(inputs);
    expect(regime).toBe('red');
    expect(rationale).toMatch(/downtrend/i);
  });

  it('RED when VIX > 22 even with an uptrend', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 28, tnx: 4.0 };
    expect(classifyMarketRegime(inputs).regime).toBe('red');
  });

  it('YELLOW when VIX is in the 16–22 mean-reversion band', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 19, tnx: 4.0 };
    expect(classifyMarketRegime(inputs).regime).toBe('yellow');
  });

  it('YELLOW when the 10Y yield is above 4.50%', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 13, tnx: 4.7 };
    expect(classifyMarketRegime(inputs).regime).toBe('yellow');
  });

  it('YELLOW (cautious) when the SPX trend feed is unavailable', () => {
    const inputs: RegimeInputs = { spx: null, spxMa20: null, vix: 13, tnx: 4.0 };
    const { regime, rationale } = classifyMarketRegime(inputs);
    expect(regime).toBe('yellow');
    expect(rationale).toMatch(/unavailable/i);
  });
});

// ── strategy gates ──────────────────────────────────────────────────────────

describe('deriveGates', () => {
  it('GREEN tape: ORB longs on, breakouts on, full sizing', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 13, tnx: 4.0 };
    const gates = deriveGates('green', inputs);
    expect(gates.orbLongs).toBe(true);
    expect(gates.orbShorts).toBe(false);
    expect(gates.breakoutsEnabled).toBe(true);
    expect(gates.sizingMultiplier).toBe(1.0);
  });

  it('RED downtrend: ORB longs off, ORB shorts on, sizing halved', () => {
    const inputs: RegimeInputs = { spx: 5000, spxMa20: 5100, vix: 13, tnx: 4.0 };
    const gates = deriveGates('red', inputs);
    expect(gates.orbLongs).toBe(false);
    expect(gates.orbShorts).toBe(true);
    expect(gates.sizingMultiplier).toBe(0.5);
  });

  it('high VIX disables breakouts and ORB longs', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 28, tnx: 4.0 };
    const gates = deriveGates('red', inputs);
    expect(gates.breakoutsEnabled).toBe(false);
    expect(gates.orbLongs).toBe(false);
  });

  it('mean-reversion tilt turns on inside the 16–22 VIX band', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 19, tnx: 4.0 };
    expect(deriveGates('yellow', inputs).meanReversionTilt).toBe(true);
  });

  it('10Y above 4.50% caps sizing at 0.5 even in a YELLOW regime', () => {
    const inputs: RegimeInputs = { spx: 5200, spxMa20: 5100, vix: 13, tnx: 4.7 };
    expect(deriveGates('yellow', inputs).sizingMultiplier).toBe(0.5);
  });
});

// ── store round-trip ────────────────────────────────────────────────────────

describe('market-review store', () => {
  let tmpRoot: string;
  let storePath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'market-review-test-'));
    storePath = join(tmpRoot, 'market-review.json');
    __resetMarketReviewStoreForTests(storePath);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetMarketReviewStoreForTests(null);
  });

  function review(kind: 'premarket' | 'postmarket', generatedAt: string): MarketReview {
    return {
      id: `${kind}-${generatedAt.slice(0, 10)}`,
      kind,
      date: generatedAt.slice(0, 10),
      generatedAt,
      regime: 'green',
      regimeRationale: 'test',
      indexes: [],
      gates: {
        orbLongs: true,
        orbShorts: false,
        meanReversionTilt: false,
        breakoutsEnabled: true,
        sizingMultiplier: 1,
      },
      source: 'auto',
    };
  }

  it('lists reviews newest-first and scopes getLatest by kind', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        reviews: [
          review('premarket', '2026-05-15T13:00:00.000Z'),
          review('postmarket', '2026-05-16T01:00:00.000Z'),
          review('premarket', '2026-05-16T13:00:00.000Z'),
        ],
      }),
    );

    const list = await listMarketReviews();
    expect(list.map(r => r.generatedAt)).toEqual([
      '2026-05-16T13:00:00.000Z',
      '2026-05-16T01:00:00.000Z',
      '2026-05-15T13:00:00.000Z',
    ]);

    expect((await getLatestMarketReview())?.generatedAt).toBe('2026-05-16T13:00:00.000Z');
    expect((await getLatestMarketReview('postmarket'))?.kind).toBe('postmarket');
    expect((await getLatestMarketReview('premarket'))?.generatedAt).toBe(
      '2026-05-16T13:00:00.000Z',
    );
  });

  it('returns null when no review has been generated yet', async () => {
    expect(await getLatestMarketReview()).toBeNull();
  });
});
