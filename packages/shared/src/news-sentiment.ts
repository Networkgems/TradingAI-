// TRA-534 (TRA-530b) — Deterministic news-sentiment scorer + per-symbol
// recency-weighted aggregate.
//
// Both functions are PURE: same (text / news + clock) ⇒ same output, so they
// can be unit-tested with golden fixtures (acceptance #1, #3). The scorer is
// tagged `method: 'lexicon-v1'` and isolated behind {@link scoreNewsSentiment}
// so a model-based scorer (e.g. FinBERT) can replace it later without changing
// the {@link NewsSentiment} / {@link SymbolSentiment} schemas.

import type {
  NewsItem,
  NewsSentiment,
  SymbolSentiment,
  SymbolSentimentHeadline,
} from './index.js';

export const SENTIMENT_METHOD = 'lexicon-v1';

// Label threshold on the per-article score (spec §B: ±0.15).
const LABEL_THRESHOLD = 0.15;
// Per-symbol tilt threshold on netScore (spec §B: ±0.25).
const TILT_THRESHOLD = 0.25;
// Recency half-life for the aggregate (spec §B: 6h).
const HALF_LIFE_HOURS = 6;
// Stale cutoff: newest article older than this ⇒ tilt forced neutral (spec: 12h).
const STALE_MINUTES = 720;
// Minimum mapped articles for a non-neutral tilt (spec §B).
const MIN_ARTICLES_FOR_TILT = 2;
// Title carries 2x the weight of the summary (spec §B).
const TITLE_WEIGHT = 2;
const SUMMARY_WEIGHT = 1;
// Confidence reaches 1.0 once this many lexicon tokens are matched.
const CONFIDENCE_SATURATION = 4;

/**
 * Finance/VADER-style polarity lexicon. Keys are lowercase stems matched as
 * whole tokens; values are polarities in [-1,+1]. Curated for market headlines
 * (earnings, ratings, price action) rather than general English.
 */
const LEXICON: Readonly<Record<string, number>> = {
  // --- strong positive ---
  soar: 0.9, soars: 0.9, soared: 0.9, soaring: 0.9,
  surge: 0.85, surges: 0.85, surged: 0.85, surging: 0.85,
  skyrocket: 0.9, skyrockets: 0.9, skyrocketed: 0.9,
  rally: 0.7, rallies: 0.7, rallied: 0.7,
  jump: 0.6, jumps: 0.6, jumped: 0.6, jumping: 0.6,
  soared_high: 0.9,
  record: 0.6, records: 0.5, 'all-time': 0.6,
  beat: 0.65, beats: 0.65, beating: 0.6, outperform: 0.7, outperforms: 0.7, outperformed: 0.7,
  upgrade: 0.7, upgrades: 0.7, upgraded: 0.7,
  bullish: 0.8, breakout: 0.6, breakouts: 0.6,
  gain: 0.5, gains: 0.5, gained: 0.5, gaining: 0.5,
  rise: 0.45, rises: 0.45, rose: 0.45, rising: 0.45,
  climb: 0.5, climbs: 0.5, climbed: 0.5, climbing: 0.5,
  profit: 0.5, profits: 0.5, profitable: 0.6,
  growth: 0.45, grow: 0.4, grows: 0.4, growing: 0.45,
  strong: 0.55, stronger: 0.6, strength: 0.55, robust: 0.6, solid: 0.5,
  boost: 0.55, boosts: 0.55, boosted: 0.55,
  optimistic: 0.6, optimism: 0.6, confidence: 0.45, confident: 0.5,
  win: 0.55, wins: 0.55, winning: 0.55, won: 0.5,
  success: 0.6, successful: 0.6, milestone: 0.5,
  approve: 0.55, approved: 0.55, approval: 0.55,
  buy: 0.4, buybacks: 0.5, buyback: 0.5, dividend: 0.4, dividends: 0.4,
  expand: 0.4, expands: 0.4, expansion: 0.45,
  positive: 0.5, top: 0.4, tops: 0.5, topped: 0.5,
  high: 0.35, higher: 0.45, highs: 0.4,
  // --- strong negative ---
  plunge: -0.9, plunges: -0.9, plunged: -0.9, plunging: -0.9,
  crash: -0.9, crashes: -0.9, crashed: -0.9, crashing: -0.9,
  plummet: -0.9, plummets: -0.9, plummeted: -0.9,
  tumble: -0.75, tumbles: -0.75, tumbled: -0.75, tumbling: -0.75,
  slump: -0.7, slumps: -0.7, slumped: -0.7,
  sink: -0.65, sinks: -0.65, sank: -0.65, sinking: -0.65,
  drop: -0.55, drops: -0.55, dropped: -0.55, dropping: -0.55,
  fall: -0.55, falls: -0.55, fell: -0.55, falling: -0.55,
  decline: -0.55, declines: -0.55, declined: -0.55, declining: -0.55,
  slide: -0.55, slides: -0.55, slid: -0.55, sliding: -0.55,
  miss: -0.65, misses: -0.65, missed: -0.65, missing: -0.5,
  downgrade: -0.75, downgrades: -0.75, downgraded: -0.75,
  bearish: -0.8, selloff: -0.7, 'sell-off': -0.7,
  loss: -0.6, losses: -0.6, lose: -0.55, loses: -0.55, lost: -0.55, losing: -0.6,
  weak: -0.55, weaker: -0.6, weakness: -0.6, soft: -0.4, sluggish: -0.6,
  cut: -0.5, cuts: -0.5, slashes: -0.7, slashed: -0.7, slash: -0.7,
  warn: -0.6, warns: -0.6, warning: -0.6, warned: -0.6,
  fear: -0.6, fears: -0.6, concern: -0.5, concerns: -0.5, worried: -0.55, worry: -0.55,
  risk: -0.4, risks: -0.4, risky: -0.5,
  lawsuit: -0.6, lawsuits: -0.6, fraud: -0.85, probe: -0.6, investigation: -0.6,
  bankruptcy: -1.0, bankrupt: -1.0, default: -0.7, defaults: -0.7,
  recall: -0.55, recalls: -0.55, layoff: -0.7, layoffs: -0.7,
  negative: -0.5, low: -0.3, lower: -0.45, lows: -0.4, down: -0.35,
  disappoint: -0.65, disappoints: -0.65, disappointing: -0.65, disappointed: -0.65,
  struggle: -0.6, struggles: -0.6, struggling: -0.6,
  halt: -0.55, halts: -0.55, halted: -0.55,
  pressure: -0.4, headwind: -0.55, headwinds: -0.55,
  // --- TRA-597: Fed / monetary-policy tone (risk-asset orientation) ---
  // Easier policy / lower rates read bullish for risk assets; tighter policy /
  // higher rates and hot inflation read bearish. Terms are scored from the
  // equity/crypto-holder's perspective so they compose with the lexicon above.
  dovish: 0.7, easing: 0.55, accommodative: 0.55, stimulus: 0.5,
  hawkish: -0.7, tightening: -0.55, restrictive: -0.5,
  disinflation: 0.5, cooling: 0.35, 'soft-landing': 0.5,
  hot: -0.4, 'sticky': -0.45, 'hotter-than-expected': -0.6, accelerating: -0.35,
  hike: -0.45, hikes: -0.45, hiked: -0.45,
  // (note: "cut"/"cuts" already score negative above for the corporate sense
  // — earnings cuts, guidance cuts — so a literal "rate cut" nets out roughly
  // neutral rather than falsely bullish, which is the conservative read.)
};

// Negators flip the polarity of a nearby lexicon token (dampened, VADER-style).
const NEGATORS: ReadonlySet<string> = new Set([
  'not', 'no', "n't", 'never', 'without', 'fails', 'fail', 'failed', 'failing',
  'cannot', "can't", "won't", "doesn't", "didn't", "isn't", "wasn't", 'less',
]);
const NEGATION_WINDOW = 3; // tokens to look back for a negator
const NEGATION_DAMPING = -0.6; // flipped + softened

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // keep intra-word hyphens/apostrophes (all-time, sell-off, n't) as tokens
    .replace(/[^a-z0-9'-]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Accumulate weighted polarity over one text span. */
function scoreSpan(
  text: string | undefined,
  weight: number,
  acc: { weighted: number; weightSum: number; matched: number },
): void {
  if (!text) return;
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const base = LEXICON[tokens[i]];
    if (base === undefined) continue;
    let polarity = base;
    for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) {
      if (NEGATORS.has(tokens[j])) {
        polarity = base * NEGATION_DAMPING;
        break;
      }
    }
    acc.weighted += polarity * weight;
    acc.weightSum += weight;
    acc.matched += 1;
  }
}

/**
 * Score a single news item's tone. Deterministic; `method: 'lexicon-v1'`.
 * Returns a neutral, zero-confidence result when no lexicon tokens match.
 */
export function scoreNewsSentiment(
  item: Pick<NewsItem, 'title' | 'summary'>,
): NewsSentiment {
  const acc = { weighted: 0, weightSum: 0, matched: 0 };
  scoreSpan(item.title, TITLE_WEIGHT, acc);
  scoreSpan(item.summary, SUMMARY_WEIGHT, acc);

  const score = acc.weightSum > 0 ? clamp(acc.weighted / acc.weightSum, -1, 1) : 0;
  const label: NewsSentiment['label'] =
    score >= LABEL_THRESHOLD ? 'positive' : score <= -LABEL_THRESHOLD ? 'negative' : 'neutral';
  const confidence = clamp(acc.matched / CONFIDENCE_SATURATION, 0, 1);

  return { score: round(score), label, confidence: round(confidence), method: SENTIMENT_METHOD };
}

/** Ensure an item carries sentiment, scoring it on the fly if absent. */
function sentimentOf(item: NewsItem): NewsSentiment {
  return item.sentiment ?? scoreNewsSentiment(item);
}

function recencyWeight(ageMinutes: number): number {
  const ageHours = Math.max(0, ageMinutes) / 60;
  return Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
}

/**
 * True when a news item mentions `symbol` — either the ticker as a whole token
 * (case-insensitive, word-boundary) or any provided company-name alias as a
 * substring (length ≥ 3, to avoid noise).
 */
export function newsMentionsSymbol(
  item: Pick<NewsItem, 'title' | 'summary'>,
  symbol: string,
  names: readonly string[] = [],
): boolean {
  const hay = `${item.title ?? ''} ${item.summary ?? ''}`;
  const lower = hay.toLowerCase();
  const ticker = symbol.toUpperCase();
  // Whole-token ticker match (handles BRK.B, BTC-USD via escaped dots/dashes).
  const tickerRe = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(ticker)}([^A-Za-z0-9]|$)`);
  if (tickerRe.test(hay.toUpperCase())) return true;
  for (const name of names) {
    const n = name.trim().toLowerCase();
    if (n.length >= 3 && lower.includes(n)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface AggregateOptions {
  symbol: string;
  /** Company-name aliases to also match (the ticker is matched automatically). */
  names?: readonly string[];
  news: readonly NewsItem[];
  /** Wall clock in epoch ms — pass `Date.now()` at the call site (keeps this pure). */
  now: number;
}

/**
 * Build the per-symbol {@link SymbolSentiment} aggregate: recency-weighted mean
 * (half-life 6h) of mapped-article scores, with the spec's tilt gating
 * (articleCount ≥ 2, freshness ≤ 12h). Pure given `now`.
 */
export function aggregateSymbolSentiment(opts: AggregateOptions): SymbolSentiment {
  const { symbol, names = [], news, now } = opts;
  const asOf = new Date(now).toISOString();

  const mapped = news
    .filter(n => newsMentionsSymbol(n, symbol, names))
    .map(n => {
      const ageMinutes = Math.max(0, (now - Date.parse(n.publishedAt)) / 60000);
      const sent = sentimentOf(n);
      return { item: n, sent, ageMinutes, weight: recencyWeight(ageMinutes) };
    });

  if (mapped.length === 0) {
    return {
      symbol, asOf, window: '24h',
      netScore: 0, articleCount: 0, freshnessMinutes: 0,
      tilt: 'neutral', topHeadlines: [],
    };
  }

  let weighted = 0;
  let weightSum = 0;
  for (const m of mapped) {
    weighted += m.sent.score * m.weight;
    weightSum += m.weight;
  }
  const netScore = weightSum > 0 ? round(clamp(weighted / weightSum, -1, 1)) : 0;

  const freshnessMinutes = Math.round(Math.min(...mapped.map(m => m.ageMinutes)));

  const topHeadlines: SymbolSentimentHeadline[] = [...mapped]
    .sort((a, b) => Math.abs(b.sent.score) * b.weight - Math.abs(a.sent.score) * a.weight)
    .slice(0, 3)
    .map(m => ({
      title: m.item.title,
      source: m.item.source,
      score: m.sent.score,
      publishedAt: m.item.publishedAt,
    }));

  let tilt: SymbolSentiment['tilt'] =
    netScore >= TILT_THRESHOLD ? 'bullish' : netScore <= -TILT_THRESHOLD ? 'bearish' : 'neutral';
  if (mapped.length < MIN_ARTICLES_FOR_TILT || freshnessMinutes > STALE_MINUTES) {
    tilt = 'neutral';
  }

  return {
    symbol, asOf, window: '24h',
    netScore, articleCount: mapped.length, freshnessMinutes, tilt, topHeadlines,
  };
}

/**
 * Company-name aliases for the equities watchlist, used to map headlines that
 * name the company without the ticker. Additive — symbols absent here still map
 * by ticker. Keep lowercase, distinctive substrings only.
 */
export const EQUITY_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  AAPL: ['apple'],
  MSFT: ['microsoft'],
  NVDA: ['nvidia'],
  GOOGL: ['google', 'alphabet'],
  AMZN: ['amazon'],
  META: ['meta platforms', 'facebook', 'instagram'],
  TSLA: ['tesla'],
  AMD: ['advanced micro'],
  NFLX: ['netflix'],
  ORCL: ['oracle'],
  INTC: ['intel'],
  QCOM: ['qualcomm'],
  AVGO: ['broadcom'],
  CRM: ['salesforce'],
  ADBE: ['adobe'],
  PYPL: ['paypal'],
  XYZ: ['block inc', 'block,'],
  SHOP: ['shopify'],
  COIN: ['coinbase'],
  MSTR: ['microstrategy', 'strategy inc'],
  SPY: ['s&p 500', 's&p500'],
  QQQ: ['nasdaq 100', 'nasdaq-100'],
  IWM: ['russell 2000'],
  DIA: ['dow jones'],
  XLF: ['financial sector'],
};

export function nameAliasesFor(symbol: string): readonly string[] {
  return EQUITY_NAME_ALIASES[symbol.toUpperCase()] ?? [];
}

// ── TRA-597 (TRA-595 C2): Fed / macro headline lane ──────────────────────────
//
// Macro and Fed-policy headlines (FOMC, Powell, CPI, jobs, PCE) don't name a
// single ticker, so the per-symbol aggregator above never picks them up. This
// lane routes them into the *same* recency-weighted scorer under a synthetic
// "MACRO" symbol, so Fed/macro tone contributes to the sentiment aggregate the
// engine and the LLM research pass already consume — just request the MACRO
// symbol (or call {@link aggregateFedSentiment}). The new Fed/monetary-policy
// lexicon terms above give these headlines a meaningful polarity.

/** Synthetic symbol the Fed/macro lane aggregates under. */
export const FED_MACRO_SYMBOL = 'MACRO';

/**
 * Distinctive macro/Fed phrases used to map a headline into the Fed lane via the
 * existing {@link newsMentionsSymbol} alias path. Lowercase substrings, ≥3 chars.
 */
export const FED_MACRO_ALIASES: readonly string[] = [
  'fed', 'federal reserve', 'fomc', 'powell', 'rate decision', 'interest rate',
  'rate cut', 'rate hike', 'monetary policy', 'central bank', 'jerome powell',
  'cpi', 'inflation', 'consumer price', 'pce', 'jobs report', 'nonfarm',
  'payrolls', 'unemployment', 'jobless', 'basis points', 'rate path',
];

/**
 * Aggregate Fed/macro headlines into a {@link SymbolSentiment} under the
 * {@link FED_MACRO_SYMBOL} synthetic symbol — the Fed-headline lane feeding the
 * news-sentiment scorer. Pure given `now`; a thin wrapper over
 * {@link aggregateSymbolSentiment} so the recency-weighting, tilt-gating and
 * top-headline logic are shared with the per-equity path.
 */
export function aggregateFedSentiment(news: readonly NewsItem[], now: number): SymbolSentiment {
  return aggregateSymbolSentiment({
    symbol: FED_MACRO_SYMBOL,
    names: FED_MACRO_ALIASES,
    news,
    now,
  });
}
