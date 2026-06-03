// TRA-544 (TRA-529 §3.1) — the analyst tier. P1 ships DETERMINISTIC FAKES: each
// analyst derives a schema-valid AnalystReport from the point-in-time inputs
// with simple, transparent math and NO LLM call (zero spend). P2 replaces each
// function body with a prompt routed through `completeJson(llm, …)`; the
// signature and the contract it returns stay identical, so the graph and its
// tests don't change. Numeric outputs honour the §3 bounds (stance ∈ [-1,1],
// confidence ∈ [0,1]).
import type { AnalystReport, Candle } from '@trading-app/shared';
import type { AgentGraphInput } from './types.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

function lastClose(candles: Candle[]): number {
  return candles.length ? candles[candles.length - 1]!.close : 0;
}

/** Fractional return over the last `lookback` bars (newest vs oldest in window). */
function momentum(candles: Candle[], lookback = 10): number {
  if (candles.length < 2) return 0;
  const window = candles.slice(-Math.min(lookback + 1, candles.length));
  const first = window[0]!.close;
  const last = window[window.length - 1]!.close;
  if (first <= 0) return 0;
  return (last - first) / first;
}

/** Support/resistance from the recent window's low/high. */
function keyLevels(candles: Candle[], lookback = 20): { support: number; resistance: number } {
  if (!candles.length) return { support: 0, resistance: 0 };
  const window = candles.slice(-Math.min(lookback, candles.length));
  return {
    support: round(Math.min(...window.map(c => c.low))),
    resistance: round(Math.max(...window.map(c => c.high))),
  };
}

/**
 * Technical analyst — stance from recent price momentum; confidence scales with
 * how much data we have and how decisive the move is. Pure deterministic fake.
 */
export function technicalAnalyst(input: AgentGraphInput): AnalystReport {
  const { candles } = input;
  const mom = momentum(candles);
  // Map a ±10% move to full stance; clamp beyond.
  const stance = round(clamp(mom * 10, -1, 1));
  const dataFactor = clamp(candles.length / 30, 0, 1);
  const confidence = round(clamp(Math.abs(stance) * 0.7 + dataFactor * 0.3, 0, 1));
  const dir = stance > 0.05 ? 'bullish' : stance < -0.05 ? 'bearish' : 'neutral';
  return {
    kind: 'technical',
    stance,
    confidence,
    horizonDays: 5,
    keyLevels: keyLevels(candles),
    drivers: [
      `${(mom * 100).toFixed(2)}% momentum over last ${Math.min(10, Math.max(0, candles.length - 1))} bars`,
      `${candles.length} candles available (data factor ${dataFactor.toFixed(2)})`,
    ],
    notes: `Price action reads ${dir}; last close ${lastClose(candles).toFixed(2)}.`,
  };
}

/**
 * Fundamental analyst — stance from valuation + growth + margin when a
 * point-in-time snapshot is supplied; neutral/low-confidence when it is absent
 * (thin evidence is down-weighted, never fabricated — §3.1). Deterministic fake.
 */
export function fundamentalAnalyst(input: AgentGraphInput): AnalystReport {
  const f = input.fundamentals;
  if (!f) {
    return {
      kind: 'fundamental',
      stance: 0,
      confidence: 0.1,
      horizonDays: 30,
      keyLevels: keyLevels(input.candles),
      drivers: ['no point-in-time fundamentals available — abstaining with low confidence'],
      notes: 'Fundamental data feed not wired until P2; returning a neutral, low-confidence read.',
    };
  }
  let stance = 0;
  const drivers: string[] = [];
  if (typeof f.revenueGrowth === 'number') {
    stance += clamp(f.revenueGrowth * 2, -0.5, 0.5);
    drivers.push(`revenue growth ${(f.revenueGrowth * 100).toFixed(1)}%`);
  }
  if (typeof f.netMargin === 'number') {
    stance += clamp((f.netMargin - 0.1) * 2, -0.3, 0.3);
    drivers.push(`net margin ${(f.netMargin * 100).toFixed(1)}%`);
  }
  if (typeof f.peRatio === 'number') {
    // Cheap (low P/E) nudges bullish; rich nudges bearish, centred on 20.
    stance += clamp((20 - f.peRatio) / 40, -0.3, 0.3);
    drivers.push(`P/E ${f.peRatio.toFixed(1)}`);
  }
  if (drivers.length === 0) drivers.push('fundamentals snapshot present but empty');
  return {
    kind: 'fundamental',
    stance: round(clamp(stance, -1, 1)),
    confidence: round(clamp(0.3 + drivers.length * 0.15, 0, 1)),
    horizonDays: 30,
    keyLevels: keyLevels(input.candles),
    drivers,
    notes: typeof f.nextEarningsInDays === 'number'
      ? `Next earnings in ${f.nextEarningsInDays} day(s).`
      : 'Earnings date unknown.',
  };
}

/**
 * News-sentiment analyst — stance from the average sentiment of point-in-time
 * headlines (only those at/before asOf); neutral/low-confidence when no feed.
 * Deterministic fake.
 */
export function newsSentimentAnalyst(input: AgentGraphInput): AnalystReport {
  const headlines = (input.news ?? []).filter(h => h.timestamp <= input.asOf);
  if (headlines.length === 0) {
    return {
      kind: 'news_sentiment',
      stance: 0,
      confidence: 0.1,
      horizonDays: 3,
      keyLevels: keyLevels(input.candles),
      drivers: ['no point-in-time headlines available — abstaining with low confidence'],
      notes: 'News feed not wired until P2; returning a neutral, low-confidence read.',
    };
  }
  const scored = headlines.filter(h => typeof h.sentiment === 'number');
  const avg = scored.length
    ? scored.reduce((s, h) => s + (h.sentiment ?? 0), 0) / scored.length
    : 0;
  const drivers = headlines.slice(-3).map(
    h => `[${new Date(h.timestamp).toISOString()}] ${h.source}: ${h.headline}`,
  );
  return {
    kind: 'news_sentiment',
    stance: round(clamp(avg, -1, 1)),
    confidence: round(clamp(0.2 + Math.min(scored.length, 5) * 0.12, 0, 1)),
    horizonDays: 3,
    keyLevels: keyLevels(input.candles),
    drivers,
    notes: `${headlines.length} point-in-time headline(s); ${scored.length} pre-scored.`,
  };
}

/** Run the three core analysts (parallel-safe; pure functions, no shared state). */
export function runAnalysts(input: AgentGraphInput): AnalystReport[] {
  return [
    technicalAnalyst(input),
    fundamentalAnalyst(input),
    newsSentimentAnalyst(input),
  ];
}
