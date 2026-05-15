import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OptionChainRow } from '@trading-app/engine';
import { recordOptionChains, etDateKey } from './options-chain-recorder.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'chain-recorder-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function chainRow(strike: number, optionType: 'call' | 'put'): OptionChainRow {
  return {
    optionSymbol: `AAPL260619${optionType === 'call' ? 'C' : 'P'}00${strike}000`,
    underlying: 'AAPL',
    optionType,
    strike,
    expiration: '2026-06-19',
    bid: 1.0,
    ask: 1.2,
    last: 1.1,
    volume: 100,
    openInterest: 500,
    midIv: 0.3,
  };
}

/** Mock Tradier client — `now` is 2026-05-15, so 2026-06-19 is ~35 DTE (in window). */
function makeClient(over: {
  expirations?: string[];
  chain?: OptionChainRow[];
  throwOnChain?: boolean;
} = {}) {
  return {
    getExpirations: async () => over.expirations ?? ['2026-06-19'],
    getChainSnapshot: async () => {
      if (over.throwOnChain) throw new Error('tradier 429');
      return over.chain ?? [chainRow(105, 'call'), chainRow(95, 'put')];
    },
  };
}

const NOW = () => Date.parse('2026-05-15T19:55:00Z');

describe('recordOptionChains', () => {
  it('writes a per-symbol snapshot file partitioned by ET date', async () => {
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: makeClient(),
      outDir: tmpRoot,
      now: NOW,
    });

    expect(result.symbols[0].outcome).toBe('written');
    expect(result.symbols[0].rowsRecorded).toBe(2);

    const file = join(tmpRoot, result.date, 'AAPL.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.symbol).toBe('AAPL');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.expirations).toEqual(['2026-06-19']);
  });

  it('writes a _meta.json run summary', async () => {
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: makeClient(),
      outDir: tmpRoot,
      now: NOW,
    });
    const meta = JSON.parse(readFileSync(join(tmpRoot, result.date, '_meta.json'), 'utf-8'));
    expect(meta.written).toBe(1);
    expect(meta.symbolCount).toBe(1);
  });

  it('skips a symbol with no expirations inside the DTE window', async () => {
    // Only an expiration ~400 days out — outside the default 14–35 day window.
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: makeClient({ expirations: ['2027-07-16'] }),
      outDir: tmpRoot,
      now: NOW,
    });
    expect(result.symbols[0].outcome).toBe('no_expirations');
    expect(existsSync(join(tmpRoot, result.date, 'AAPL.json'))).toBe(false);
  });

  it('isolates a per-symbol error without aborting the sweep', async () => {
    const result = await recordOptionChains({
      symbols: ['AAPL', 'MSFT'],
      client: {
        getExpirations: async (sym: string) =>
          sym === 'AAPL' ? Promise.reject(new Error('boom')) : ['2026-06-19'],
        getChainSnapshot: async () => [chainRow(105, 'call')],
      },
      outDir: tmpRoot,
      now: NOW,
    });
    expect(result.symbols.find((s) => s.symbol === 'AAPL')?.outcome).toBe('error');
    expect(result.symbols.find((s) => s.symbol === 'MSFT')?.outcome).toBe('written');
  });

  it('stamps a spot price when a resolver is supplied', async () => {
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: makeClient(),
      outDir: tmpRoot,
      fetchSpot: async () => 187.5,
      now: NOW,
    });
    const parsed = JSON.parse(readFileSync(join(tmpRoot, result.date, 'AAPL.json'), 'utf-8'));
    expect(parsed.spot).toBe(187.5);
  });
});

describe('etDateKey', () => {
  it('formats a timestamp as an ET YYYY-MM-DD partition key', () => {
    expect(etDateKey(Date.parse('2026-05-15T19:55:00Z'))).toBe('2026-05-15');
  });
});
