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
      sleep: async () => {},
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
      sleep: async () => {},
    });
    expect(result.symbols.find((s) => s.symbol === 'AAPL')?.outcome).toBe('error');
    expect(result.symbols.find((s) => s.symbol === 'MSFT')?.outcome).toBe('written');
  });

  // ── TRA-4059 ──────────────────────────────────────────────────────────────

  it('files a broker refusal as feed_error with its status — not as no_expirations', async () => {
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: {
        getExpirations: async () => [],
        getChainSnapshot: async () => [],
        fetchExpirations: async () => ({ ok: false as const, httpStatus: 429, reason: null }),
        fetchChainSnapshot: async () => ({ ok: true as const, httpStatus: 200, value: [] }),
      },
      outDir: tmpRoot,
      now: NOW,
      maxRetries: 0,
    });
    expect(result.symbols[0].outcome).toBe('feed_error');
    expect(result.symbols[0].httpStatus).toBe(429);
    expect(result.outcomeCounts.feed_error).toBe(1);
    expect(result.outcomeCounts.no_expirations).toBe(0);
  });

  it('retries a symbol that did not write and reports the rescue', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await recordOptionChains({
      symbols: ['AAPL', 'MSFT'],
      client: {
        getExpirations: async () => ['2026-06-19'],
        getChainSnapshot: async () => [chainRow(105, 'call')],
        fetchExpirations: async (sym: string) => {
          calls++;
          // AAPL is refused on the first pass only; MSFT always answers.
          if (sym === 'AAPL' && calls <= 1) return { ok: false as const, httpStatus: 429, reason: null };
          return { ok: true as const, httpStatus: 200, value: ['2026-06-19'] };
        },
        fetchChainSnapshot: async () => ({ ok: true as const, httpStatus: 200, value: [chainRow(105, 'call')] }),
      },
      outDir: tmpRoot,
      now: NOW,
      maxRetries: 2,
      retryDelayMs: 1234,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.written).toBe(2);
    expect(result.passes).toBe(2);
    expect(result.rescuedByRetry).toEqual(['AAPL']);
    expect(result.symbols.find((s) => s.symbol === 'AAPL')?.attempts).toBe(2);
    expect(result.symbols.find((s) => s.symbol === 'MSFT')?.attempts).toBe(1);
    expect(sleeps).toEqual([1234]);
    // Retry only re-fetched the pending symbol: 2 first-pass + 1 retry.
    expect(calls).toBe(3);
    expect(existsSync(join(tmpRoot, result.date, 'AAPL.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(tmpRoot, result.date, '_meta.json'), 'utf-8'));
    expect(meta.passes).toBe(2);
    expect(meta.rescuedByRetry).toEqual(['AAPL']);
    expect(meta.wholesaleSkip).toBe(false);
  });

  it('bounds the retry and flags a wholesale skip when nothing ever writes', async () => {
    let calls = 0;
    const result = await recordOptionChains({
      symbols: ['AAPL', 'MSFT', 'NVDA'],
      client: {
        getExpirations: async () => [],
        getChainSnapshot: async () => [],
        fetchExpirations: async () => { calls++; return { ok: false as const, httpStatus: 503, reason: null }; },
        fetchChainSnapshot: async () => ({ ok: true as const, httpStatus: 200, value: [] }),
      },
      outDir: tmpRoot,
      now: NOW,
      maxRetries: 2,
      sleep: async () => {},
    });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.wholesaleSkip).toBe(true);
    expect(result.passes).toBe(3);
    expect(calls).toBe(9);
    expect(result.rescuedByRetry).toEqual([]);
    const meta = JSON.parse(readFileSync(join(tmpRoot, result.date, '_meta.json'), 'utf-8'));
    expect(meta.wholesaleSkip).toBe(true);
    expect(meta.outcomeCounts.feed_error).toBe(3);
  });

  it('does not sleep or re-fetch when the first pass wrote everything', async () => {
    let slept = false;
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: makeClient(),
      outDir: tmpRoot,
      now: NOW,
      sleep: async () => { slept = true; },
    });
    expect(result.passes).toBe(1);
    expect(slept).toBe(false);
    expect(result.wholesaleSkip).toBe(false);
  });

  it('a 2xx with an empty list is still no_expirations (a refusal is the only feed_error)', async () => {
    const result = await recordOptionChains({
      symbols: ['AAPL'],
      client: {
        getExpirations: async () => [],
        getChainSnapshot: async () => [],
        fetchExpirations: async () => ({ ok: true as const, httpStatus: 200, value: [] }),
        fetchChainSnapshot: async () => ({ ok: true as const, httpStatus: 200, value: [] }),
      },
      outDir: tmpRoot,
      now: NOW,
      maxRetries: 0,
    });
    expect(result.symbols[0].outcome).toBe('no_expirations');
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
