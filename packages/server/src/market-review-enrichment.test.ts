import { describe, it, expect } from 'vitest';
import type { AnalystPlan } from './analyst-agent.js';
import type { SentimentSnapshotFile } from './sentiment-snapshot-recorder.js';
import type { NameLean } from './news-catalyst-lean.js';
import type { SocialSentiment } from '@trading-app/shared';
import {
  renderWatchlistLevelsSection,
  renderSentimentTapeSection,
  renderCallPutLeanSection,
} from './market-review-enrichment.js';

// ── A — Watchlist key levels ─────────────────────────────────────────────────

function plan(watchlist: AnalystPlan['watchlist']): AnalystPlan {
  return {
    date: '2026-07-16',
    generatedAt: 0,
    regime: 'green',
    regimeRationale: 'x',
    gapRisk: false,
    gates: {
      orbLongs: true,
      orbShorts: false,
      meanReversionTilt: false,
      breakoutsEnabled: true,
      sizingMultiplier: 1,
      trendState: 'up',
    },
    watchlist,
  };
}

describe('renderWatchlistLevelsSection (TRA-1970 A)', () => {
  it('renders a health line when the plan is absent (planner off)', () => {
    const md = renderWatchlistLevelsSection(null);
    expect(md).toContain('## Watchlist — Key Levels & Invalidation');
    expect(md).toContain('ENABLE_ANALYST_AGENT');
    expect(md).not.toContain('| Name | Rank |');
  });

  it('renders a health line when the plan watchlist is empty', () => {
    const md = renderWatchlistLevelsSection(plan([]));
    expect(md).toContain('No analyst watchlist');
    expect(md).not.toContain('| Name | Rank |');
  });

  it('renders per-name S/R + invalidation + reversal bracket', () => {
    const md = renderWatchlistLevelsSection(
      plan([
        {
          symbol: 'AAPL',
          rank: 0.82,
          proximityScore: 0,
          reversalScore: 0,
          trendAlignScore: 0,
          support: 210.5,
          resistance: 225.25,
          nearestKeyLevel: 210.5,
          reversal: {
            score: 3,
            confirmed: true,
            side: 'long',
            entry: 211.1,
            stop: 208.4,
            target: 224.0,
            rr: 2.1,
          },
        },
      ]),
    );
    expect(md).toContain('| Name | Rank | Support | Resistance | Key level (invalidation) | Reversal setup |');
    expect(md).toContain('| AAPL | 0.82 | 210.50 | 225.25 | 210.50 |');
    expect(md).toContain('long 211.10→224.00 (stop 208.40) ✓');
  });

  it('shows an em-dash for a name with no reversal setup / missing levels', () => {
    const md = renderWatchlistLevelsSection(
      plan([
        {
          symbol: 'MSFT',
          rank: 0.4,
          proximityScore: 0,
          reversalScore: 0,
          trendAlignScore: 0,
          support: null,
          resistance: null,
          nearestKeyLevel: null,
          reversal: { score: 0, confirmed: false, side: null, entry: null, stop: null, target: null, rr: null },
        },
      ]),
    );
    expect(md).toContain('| MSFT | 0.40 | — | — | — | — |');
  });
});

// ── B — Sentiment tape ───────────────────────────────────────────────────────

function reading(symbol: string, netScore: number, tilt: SocialSentiment['tilt']): SocialSentiment {
  return {
    symbol,
    asOf: '2026-07-16T19:55:00Z',
    window: '24h',
    source: 'stocktwits',
    netScore,
    bullishCount: 3,
    bearishCount: 1,
    taggedCount: 4,
    curatedCount: 1,
    messageCount: 12,
    freshnessMinutes: 8,
    tilt,
  };
}

function snapshot(symbols: SentimentSnapshotFile['symbols']): SentimentSnapshotFile {
  return { date: '2026-07-16', recordedAt: 0, symbols };
}

describe('renderSentimentTapeSection (TRA-1970 B)', () => {
  it('renders a COLD red flag when no snapshot exists', () => {
    const md = renderSentimentTapeSection(null, '2026-07-16');
    expect(md).toContain('## Sentiment Tape — StockTwits + News');
    expect(md).toContain('🔴');
    expect(md).toContain('COLD');
    expect(md).toContain('2026-07-16');
    expect(md).toContain('TRA-1969');
  });

  it('renders a COLD flag when every row is no_data (feed blocked)', () => {
    const md = renderSentimentTapeSection(
      snapshot([
        { symbol: 'AAPL', outcome: 'no_data', sentiment: null },
        { symbol: 'MSFT', outcome: 'no_data', sentiment: null },
      ]),
    );
    expect(md).toContain('Feed COLD');
    expect(md).toContain('0/2');
    expect(md).not.toContain('| Name | Tilt |');
  });

  it('renders the tape + a health line for recorded rows, flagging cold ones', () => {
    const md = renderSentimentTapeSection(
      snapshot([
        { symbol: 'AAPL', outcome: 'recorded', sentiment: reading('AAPL', 0.42, 'bullish') },
        { symbol: 'NVDA', outcome: 'no_data', sentiment: null },
        { symbol: 'TSLA', outcome: 'error', sentiment: null, errorMessage: 'boom' },
      ]),
    );
    expect(md).toContain('🟡'); // mixed health
    expect(md).toContain('1 read · 1 cold · 1 error of 3');
    expect(md).toContain('| Name | Tilt | Net | Msgs | Curated | Freshness |');
    expect(md).toContain('| AAPL | 🟢 bull | 0.42 | 12 | 1 ✓ | 8m |');
    // cold / errored names are not invented into the table
    expect(md).not.toContain('| NVDA |');
    expect(md).not.toContain('| TSLA |');
  });

  it('shows a green health line when every requested name recorded', () => {
    const md = renderSentimentTapeSection(
      snapshot([{ symbol: 'AAPL', outcome: 'recorded', sentiment: reading('AAPL', -0.3, 'bearish') }]),
    );
    expect(md).toContain('🟢 Health');
    expect(md).toContain('| AAPL | 🔴 bear |');
  });
});

// ── C — Calls-vs-puts lean (always-on) ───────────────────────────────────────

function lean(symbol: string, verdict: NameLean['lean']['verdict']): NameLean {
  return {
    symbol,
    lean: {
      verdict,
      directional: verdict === 'CALL' ? 0.6 : verdict === 'PUT' ? -0.6 : 0.05,
      confidence: 7,
      band: 'Med',
      structure: 'either',
      agreement: { agree: 2, total: 3 },
      components: { sentimentTilt: 0.2, pcrContrarian: 0.1, oiQuadrant: 0.2, trendState: 0.1 },
      method: 'v1',
    },
    notionalBand: '$250–500 (observe)',
    thesis: 'x',
    invalidation: 'y',
  };
}

describe('renderCallPutLeanSection (TRA-1970 C, always-on)', () => {
  it('renders the flag-off health line when the discovery source is off', () => {
    const md = renderCallPutLeanSection([], { discoveryEnabled: false });
    expect(md).toContain('## Catalyst Watchlist — Calls vs Puts');
    expect(md).toContain('ENABLE_NEWS_CATALYST_WATCHLIST');
    expect(md).toContain('unavailable');
  });

  it('renders a distinct "no edge" line when discovery is on but produced nothing', () => {
    const md = renderCallPutLeanSection([], { discoveryEnabled: true });
    expect(md).toContain('No directional lean this session');
    expect(md).not.toContain('ENABLE_NEWS_CATALYST_WATCHLIST');
  });

  it('renders the lean table when leans exist (delegates to renderLeanMarkdown)', () => {
    const md = renderCallPutLeanSection([lean('AAPL', 'CALL'), lean('TSLA', 'PUT')], {
      discoveryEnabled: true,
    });
    expect(md).toContain('## Catalyst Watchlist — Calls vs Puts');
    expect(md).toContain('| Name | Lean | Conf | Structure | Notional | Thesis | Invalidation |');
    expect(md).toContain('| AAPL | CALL |');
    expect(md).toContain('| TSLA | PUT |');
  });
});
