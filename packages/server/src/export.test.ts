import { describe, it, expect } from 'vitest';
import type { Position, OptionPosition } from '@trading-app/shared';
import {
  buildExport,
  buildRows,
  applyFilters,
  summarize,
  toCsv,
  toJsonDocument,
  rowFromPosition,
  rowFromOption,
  formatHoldDuration,
  EXPORT_COLUMNS,
  type ExportTradeRow,
} from './export.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

function stock(overrides: Partial<Position> = {}): Position {
  return {
    id: 's1',
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'orb_breakout',
    entryPrice: 100,
    quantity: 10,
    stopLoss: 95,
    takeProfit: 115,
    openedAt: Date.parse('2026-05-01T14:00:00.000Z'),
    closedAt: Date.parse('2026-05-01T16:14:00.000Z'),
    exitPrice: 110,
    pnl: 100,
    exitReason: 'target',
    mode: 'live',
    ...overrides,
  };
}

function crypto(overrides: Partial<Position> = {}): Position {
  return {
    id: 'c1',
    symbol: 'ETH-USD',
    side: 'buy',
    signalType: 'mean_reversion',
    entryPrice: 3000,
    quantity: 0.5,
    stopLoss: 2900,
    takeProfit: 3300,
    openedAt: Date.parse('2026-05-02T10:00:00.000Z'),
    closedAt: Date.parse('2026-05-02T12:00:00.000Z'),
    exitPrice: 3142.5,
    pnl: 71.25,
    exitReason: 'target',
    mode: 'demo',
    ...overrides,
  };
}

function option(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'o1',
    symbol: 'TSLA',
    optionSymbol: 'TSLA260619C00250000',
    optionType: 'call',
    strike: 250,
    expiration: '2026-06-19',
    contracts: 2,
    contractsRemaining: 0,
    premiumPaid: 4,
    currentPremium: 6,
    tp1Premium: 5,
    tp1Hit: true,
    stopLossPremium: 3,
    peakPremium: 6.5,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 240,
    openedAt: Date.parse('2026-05-03T13:30:00.000Z'),
    closedAt: Date.parse('2026-05-03T19:30:00.000Z'),
    pnl: 400,
    signalId: 'sig-o1',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  } as OptionPosition;
}

// ── formatHoldDuration ────────────────────────────────────────────────────────

describe('formatHoldDuration', () => {
  it('formats multi-day spans as days + hours', () => {
    expect(formatHoldDuration(0, 3 * 86_400_000 + 4 * HOUR)).toBe('3d 4h');
  });
  it('formats hour spans as hours + minutes', () => {
    expect(formatHoldDuration(0, 2 * HOUR + 14 * 60_000)).toBe('2h 14m');
  });
  it('formats minute spans as minutes + seconds', () => {
    expect(formatHoldDuration(0, 47 * 60_000 + 9000)).toBe('47m 9s');
  });
  it('formats sub-minute spans as seconds', () => {
    expect(formatHoldDuration(0, 30_000)).toBe('30s');
  });
  it('returns empty string for missing or negative spans', () => {
    expect(formatHoldDuration(undefined, 1000)).toBe('');
    expect(formatHoldDuration(5000, 1000)).toBe('');
  });
});

// ── Row mapping ───────────────────────────────────────────────────────────────

describe('rowFromPosition', () => {
  it('maps every schema field and derives R from the stop distance', () => {
    const row = rowFromPosition(stock(), 'stocks');
    expect(row).toMatchObject({
      symbol: 'AAPL',
      market: 'stocks',
      mode: 'live',
      side: 'buy',
      strategy: 'orb_breakout',
      quantity: 10,
      entry_time: '2026-05-01T14:00:00.000Z',
      entry_price: 100,
      exit_time: '2026-05-01T16:14:00.000Z',
      exit_price: 110,
      exit_reason: 'target',
      gross_pnl_usd: 100,
      fees_usd: 0,
      net_pnl_usd: 100,
      hold_duration: '2h 14m',
    });
    // risk = |100-95| * 10 = 50; R = 100/50 = 2
    expect(row.pnl_r).toBe(2);
  });

  it('defaults a missing mode to demo and yields null R when stop is absent', () => {
    const row = rowFromPosition(
      stock({ mode: undefined, stopLoss: undefined as unknown as number }),
      'stocks',
    );
    expect(row.mode).toBe('demo');
    expect(row.pnl_r).toBeNull();
  });

  it('tags the crypto market and keeps fractional quantity', () => {
    const row = rowFromPosition(crypto(), 'crypto');
    expect(row.market).toBe('crypto');
    expect(row.quantity).toBe(0.5);
    expect(row.net_pnl_usd).toBe(71.25);
  });
});

describe('rowFromOption', () => {
  it('uses the OCC symbol, side=buy, premium-basis R, and last mark as exit', () => {
    const row = rowFromOption(option());
    expect(row.symbol).toBe('TSLA260619C00250000');
    expect(row.market).toBe('options');
    expect(row.side).toBe('buy');
    expect(row.quantity).toBe(2);
    expect(row.entry_price).toBe(4);
    expect(row.exit_price).toBe(6);
    expect(row.net_pnl_usd).toBe(400);
    expect(row.hold_duration).toBe('6h 0m');
    // TRA-3989 — `pnl_r` is in the JOURNAL's basis: premium at open = 4 × 2
    // contracts × 100 = 800; R = 400/800 = 0.5. The stop-distance figure this
    // used to publish as `pnl_r` (|4−3| × 2 × 100 = 200; 400/200 = 2) is now
    // `pnl_r_stop_basis`, explicitly labelled.
    expect(row.pnl_r).toBe(0.5);
    expect(row.pnl_r_stop_basis).toBe(2);
    expect(row.pnl_r_basis).toBe('premium');
  });

  it('falls back to the underlying symbol when optionSymbol is absent', () => {
    const row = rowFromOption(option({ optionSymbol: undefined }));
    expect(row.symbol).toBe('TSLA');
  });
});

// ── buildRows / filters ───────────────────────────────────────────────────────

describe('buildRows', () => {
  it('concatenates stocks, crypto, then options in order', () => {
    const rows = buildRows({
      stocksClosed: [stock()],
      cryptoClosed: [crypto()],
      optionsClosed: [option()],
    });
    expect(rows.map(r => r.market)).toEqual(['stocks', 'crypto', 'options']);
  });

  it('tolerates empty / missing buckets', () => {
    expect(buildRows({})).toEqual([]);
  });
});

describe('applyFilters', () => {
  const rows = buildRows({
    stocksClosed: [stock()], // live, exit 2026-05-01
    cryptoClosed: [crypto()], // demo, exit 2026-05-02
    optionsClosed: [option()], // live, exit 2026-05-03
  });

  it('filters by mode', () => {
    const out = applyFilters(rows, { modes: ['demo'] });
    expect(out.map(r => r.market)).toEqual(['crypto']);
  });

  it('filters by market', () => {
    const out = applyFilters(rows, { markets: ['stocks', 'options'] });
    expect(out.map(r => r.market)).toEqual(['stocks', 'options']);
  });

  it('filters by inclusive from/to on exit time', () => {
    const out = applyFilters(rows, {
      from: Date.parse('2026-05-02T00:00:00.000Z'),
      to: Date.parse('2026-05-02T23:59:59.999Z'),
    });
    expect(out.map(r => r.market)).toEqual(['crypto']);
  });

  it('treats empty filter arrays as no-op (returns all)', () => {
    expect(applyFilters(rows, { modes: [], markets: [] })).toHaveLength(3);
  });

  it('combines mode + market + date filters', () => {
    const out = applyFilters(rows, {
      modes: ['live'],
      markets: ['options'],
      from: Date.parse('2026-05-01T00:00:00.000Z'),
    });
    expect(out.map(r => r.market)).toEqual(['options']);
  });
});

// ── summary ───────────────────────────────────────────────────────────────────

describe('summarize', () => {
  it('totals P&L, counts, and win-rate over the rows', () => {
    const rows = buildRows({
      stocksClosed: [stock({ pnl: 100 }), stock({ id: 's2', pnl: -40 })],
      cryptoClosed: [crypto({ pnl: 60 })],
    });
    const s = summarize(rows, {});
    expect(s.count).toBe(3);
    expect(s.totals.net_pnl_usd).toBe(120);
    expect(s.totals.gross_pnl_usd).toBe(120);
    expect(s.totals.fees_usd).toBe(0);
    // 2 of 3 positive
    expect(s.win_rate).toBeCloseTo(0.6667, 4);
  });

  it('echoes filters and is zero-safe on an empty set', () => {
    const filters = { modes: ['live' as const] };
    const s = summarize([], filters);
    expect(s.count).toBe(0);
    expect(s.win_rate).toBe(0);
    expect(s.filters).toBe(filters);
  });
});

// ── CSV ───────────────────────────────────────────────────────────────────────

describe('toCsv', () => {
  it('emits the exact §2.3 header, plus TRA-3989\'s `pnl_r_stop_basis` appended LAST', () => {
    const csv = toCsv([]);
    // The sixteen §2.3 columns keep their ordinals; the seventeenth is the
    // relabelled stop-distance R (TRA-3989 AC3).
    expect(csv.split('\r\n')[0]).toBe(
      'symbol,market,mode,side,strategy,quantity,entry_time,entry_price,exit_time,exit_price,exit_reason,gross_pnl_usd,fees_usd,net_pnl_usd,pnl_r,hold_duration,pnl_r_stop_basis',
    );
    expect(EXPORT_COLUMNS).toHaveLength(17);
    expect(EXPORT_COLUMNS[16]).toBe('pnl_r_stop_basis');
  });

  it('renders a data row with all columns populated', () => {
    const csv = toCsv([rowFromPosition(stock(), 'stocks')]);
    const dataLine = csv.split('\r\n')[1];
    // An equity row's risk unit IS the stop distance, so the last column repeats
    // `pnl_r` (2) rather than reading blank.
    expect(dataLine).toBe(
      'AAPL,stocks,live,buy,orb_breakout,10,2026-05-01T14:00:00.000Z,100,2026-05-01T16:14:00.000Z,110,target,100,0,100,2,2h 14m,2',
    );
  });

  it('quotes and escapes cells containing commas or quotes', () => {
    const row: ExportTradeRow = {
      ...rowFromPosition(stock(), 'stocks'),
      strategy: 'breakout, "fast"',
    };
    const dataLine = toCsv([row]).split('\r\n')[1];
    expect(dataLine).toContain('"breakout, ""fast"""');
  });

  it('renders nulls as empty cells', () => {
    const row = rowFromPosition(
      stock({ pnl: undefined, exitPrice: undefined, stopLoss: undefined as unknown as number }),
      'stocks',
    );
    const dataLine = toCsv([row]).split('\r\n')[1];
    // exit_price, gross, net, pnl_r all empty
    expect(dataLine).toContain(',,'); // adjacent empties exist
    expect(row.net_pnl_usd).toBeNull();
  });
});

// ── JSON document + end-to-end ────────────────────────────────────────────────

describe('toJsonDocument / buildExport', () => {
  it('wraps a summary header around the trade array', () => {
    const rows = buildRows({ stocksClosed: [stock()] });
    const doc = toJsonDocument(rows, { markets: ['stocks'] });
    expect(doc.trades).toHaveLength(1);
    expect(doc.summary.count).toBe(1);
    expect(doc.summary.filters.markets).toEqual(['stocks']);
  });

  it('buildExport filters then summarizes consistently', () => {
    const { rows, summary } = buildExport(
      {
        stocksClosed: [stock()],
        cryptoClosed: [crypto()],
        optionsClosed: [option()],
      },
      { modes: ['live'] },
    );
    // stock (live) + option (live)
    expect(rows).toHaveLength(2);
    expect(summary.count).toBe(2);
    expect(summary.totals.net_pnl_usd).toBe(500);
  });
});
