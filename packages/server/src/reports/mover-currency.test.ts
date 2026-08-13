// TRA-3390 (impl child of TRA-2628) — the REPORT surfaces, end to end.
//
// `packages/shared/src/quote-currency.test.ts` grades the formatter and the AC4
// verdict in isolation. This file grades the two report renderers the ticket
// names (AC2 sites 1 and 3) plus the ranking invariant (AC3), driving
// `generateEodReport` from a `SymbolState` fixture that actually CONTAINS a
// non-USD row — AC5's "a positive control must contain what it detects".
//
// The fixture rows are the live exemplars measured on bqb1 (build eb1dcf0c8a6f,
// pid 73) on 2026-08-12: `005930.KS` at 255500 KRW and `AZN.L` at 11714 GBp.

import { describe, it, expect } from 'vitest';
import { generateEodReport, formatMoverMarkdownRow, MOVERS_MARKDOWN_HEADING } from './eod-report.js';
import { annotateReportProvenance } from './mover-provenance.js';
import type { EngineState, SymbolState } from '../signal-engine.js';

const now = Date.now();

/** A live KRW row. 255500 with a `$` on it is the defect, verbatim. */
const KS: SymbolState = {
  symbol: '005930.KS', price: 255500, volume: 9_000_000,
  change: -12000, changePct: -4.48, lastUpdated: now, quoteStatus: 'ok', currency: 'KRW',
};
/** A live GBX (pence) row — the one a `.L → GBP` table gets wrong by 100x. */
const LSE: SymbolState = {
  symbol: 'AZN.L', price: 11714, volume: 1_200_000,
  change: 220, changePct: 1.91, lastUpdated: now, quoteStatus: 'ok', currency: 'GBX',
};
/** A USD row, so the guard is graded in BOTH directions. */
const USD_ROW: SymbolState = {
  symbol: 'AAPL', price: 104, volume: 1_000_000,
  change: 4, changePct: 4.0, lastUpdated: now, quoteStatus: 'ok', currency: 'USD',
};
/** A row whose adapter reported no currency at all (the Stooq fallback shape). */
const UNKNOWN_ROW: SymbolState = {
  symbol: 'MSFT', price: 200, volume: 500_000,
  change: -10, changePct: -4.76, lastUpdated: now, quoteStatus: 'ok',
};

function makeEngineState(symbols: SymbolState[]): EngineState {
  return {
    symbols,
    signals: [],
    supertrendShadowSignals: [],
    account: { totalEquity: 25_000, availableCash: 24_000, openPositions: [], dailyPnl: 0 },
    closedPositions: [],
    options: {
      openOptions: [], closedOptions: [], optionsPnl: 0, optionsCash: 25_000, dailyOptionsCount: 0,
    },
    lastTick: now,
    lastScanAt: now,
    tradingHalted: false,
    haltReason: null,
    autoTradingEnabled: true,
    tradingAgentsEnabled: false,
    tradingAgentsGatingEnabled: false,
    tradingAgentsLiveGatingEnabled: false,
    agentRecommendations: [],
    marketOpen: false,
    marketReview: {
      enabled: false, reviewDate: null, regime: null, regimeRationale: null,
      gates: null, gatedStrategies: [],
    },
  } as unknown as EngineState;
}

const reportFor = (symbols: SymbolState[]) => generateEodReport({
  state: makeEngineState(symbols),
  allClosedPositions: [],
  dailySignals: [],
  signalTypeMap: new Map(),
});

// ── AC2 site 1 — `formatMoverMarkdownRow` ────────────────────────────────────
describe('formatMoverMarkdownRow (TRA-3390 AC2)', () => {
  it('does NOT print `$` on a KRW row — the 2026-07-28 regression', () => {
    const row = formatMoverMarkdownRow({ symbol: '000660.KS', price: 1_550_000, changePct: -14.65, currency: 'KRW' });
    expect(row).not.toContain('$');
    expect(row).toContain('KRW');
    // The percentage is untouched: it ranks across currencies (AC3).
    expect(row).toContain('-14.65%');
  });

  it('DOES still print `$` on a USD row', () => {
    const row = formatMoverMarkdownRow({ symbol: 'AAPL', price: 104, changePct: 4, currency: 'USD' });
    expect(row).toContain('$104.00');
  });

  it('prints NO currency symbol at all for an archived row that carries none', () => {
    // Every pre-TRA-3390 stored report lands here. Bare is the honest reading;
    // a `$` would be an assertion the artifact does not support.
    const row = formatMoverMarkdownRow({ symbol: 'AAPL', price: 104, changePct: 4 });
    expect(row).not.toContain('$');
    expect(row).toContain('104.00');
  });
});

// ── AC2 site 3 — the read-time provenance banner ──────────────────────────────
describe('mover-provenance read-time banner (TRA-3390 AC2)', () => {
  // The banner is rendered into the MARKDOWN surface, so the fixture has to be a
  // report-shaped document with a locatable movers table — annotating a report
  // whose `markdown` is empty produces no note at all and the assertion would be
  // vacuously satisfied in the "no `$`" direction. (That is exactly why the USD
  // control below is in this describe block: it fails loudly on an empty banner.)
  const bannerFor = (movers: Array<{ symbol: string; price: number; changePct: number; currency?: string }>) => {
    const markdown = [
      '# Daily EOD Report — 2026-07-28',
      '',
      MOVERS_MARKDOWN_HEADING,
      '| Symbol | Price | Change % |',
      '|--------|-------|----------|',
      ...movers.map(formatMoverMarkdownRow),
      '',
      '## Next Section',
    ].join('\n');
    const annotated = annotateReportProvenance({ top5Movers: movers, markdown }, 'testbuild');
    return `${annotated.markdown}\n${JSON.stringify(annotated.moversProvenance)}`;
  };

  it('does not re-print a KRW level with its own `$`', () => {
    // A suspect row is the one the banner names, so the fixture must BE suspect
    // (r >= 2) or the cell is never rendered and the test proves nothing.
    const out = bannerFor([{ symbol: '005930.KS', price: 255500, changePct: 900, currency: 'KRW' }]);
    expect(out).not.toContain('$255,500.00');
    expect(out).toContain('255,500.00 KRW');
  });

  it('still prints `$` when the suppressed row is USD', () => {
    const out = bannerFor([{ symbol: 'FGMC', price: 8.3, changePct: 900, currency: 'USD' }]);
    expect(out).toContain('$8.30');
  });
});

// ── AC1 / AC3 — the currency travels, and the ranking does not change ─────────
describe('generateEodReport with foreign listings (TRA-3390 AC1 + AC3)', () => {
  it('carries the SymbolState currency onto the mover row', () => {
    const report = reportFor([KS, LSE, USD_ROW, UNKNOWN_ROW]);
    const byId = new Map(report.top5Movers.map(m => [m.symbol, m]));
    expect(byId.get('005930.KS')?.currency).toBe('KRW');
    expect(byId.get('AZN.L')?.currency).toBe('GBX');
    expect(byId.get('AAPL')?.currency).toBe('USD');
    // And the unknown row stays unknown — NOT backfilled to USD.
    expect(byId.get('MSFT')?.currency).toBeUndefined();
  });

  it('AC3 — foreign listings STILL rank, and still rank on |changePct|', () => {
    // The fix must not be a quiet exclusion of foreign rows from the table. A
    // local-currency percentage is comparable across listings; only the level
    // is not. `005930.KS` at -4.48% must outrank `AZN.L` at +1.91%.
    const report = reportFor([KS, LSE, USD_ROW, UNKNOWN_ROW]);
    const symbols = report.top5Movers.map(m => m.symbol);
    expect(symbols).toContain('005930.KS');
    expect(symbols).toContain('AZN.L');
    expect(symbols.indexOf('005930.KS')).toBeLessThan(symbols.indexOf('AZN.L'));
  });

  it('the rendered markdown table shows the KRW row WITHOUT `$` and the USD row WITH it', () => {
    const report = reportFor([KS, USD_ROW]);
    const table = report.markdown.slice(report.markdown.indexOf(MOVERS_MARKDOWN_HEADING));
    const krwLine = table.split('\n').find(l => l.includes('005930.KS'));
    const usdLine = table.split('\n').find(l => l.includes('AAPL'));
    expect(krwLine, 'the KRW row must be present — AC3 forbids dropping it').toBeDefined();
    expect(krwLine).not.toContain('$');
    expect(krwLine).toContain('KRW');
    // The other direction, on the same table, in the same assertion block: a
    // renderer that simply stopped printing money would pass the line above.
    expect(usdLine).toContain('$104.00');
  });
});
