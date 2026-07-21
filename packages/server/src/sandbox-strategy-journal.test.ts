import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordFromContractResult,
  recordSandboxStrategy,
  longStrategyFor,
  shortStrategyFor,
  summarizeSandboxStrategyJournal,
  hydrateSandboxStrategyJournalFromDisk,
  clearSandboxStrategyJournal,
  sandboxStrategyLogPath,
  SIGNAL_TO_SUBMIT_BUDGET_MS,
  type SandboxStrategyRecord,
} from './sandbox-strategy-journal.js';
import type {
  SmokeContractResult,
  SmokeLegResult,
} from './tradier-sandbox-options-smoke.js';

// TRA-2134 — the DURABLE multi-strategy SANDBOX journal that turns TRA-2130's one-shot
// round-trip route into a standing, graded-able learning program. Proves: pure mapping
// from the TRA-2130 orchestrator output, write-through append, reboot-durable hydrate,
// retention-window compaction, torn-line tolerance, the per-strategy acceptance-unit
// summary (clean round-trips within the <500ms signal→submit budget), and the
// `durability.ephemeral` flag that distinguishes a real /data mount from the in-bundle
// fallback that evaporates on redeploy.

const ET_DAY = '2026-07-21';
const NOW = 1_753_000_000_000; // fixed ms epoch (2025-07 range)

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-strategy-'));
  clearSandboxStrategyJournal();
});
afterEach(() => {
  clearSandboxStrategyJournal();
  rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a leg with a decision quote + timeline dense enough that the mapper derives
 * slippageBps / spreadAtSubmitPct / signalToSubmitMs from real numbers.
 */
function makeLeg(
  side: 'buy' | 'sell',
  opts: {
    bid?: number;
    ask?: number;
    fill?: number | null;
    signalToSubmitMs?: number;
    filled?: boolean;
  } = {},
): SmokeLegResult {
  const bid = opts.bid ?? 1.0;
  const ask = opts.ask ?? 1.1;
  // Mirror buildDecisionQuote: a one-sided quote (bid≤0 or ask≤0) yields a null mid/
  // spread/spreadBps — we do NOT fabricate a mid from a single touch.
  const bothSided = bid > 0 && ask > 0;
  const mid = bothSided ? (bid + ask) / 2 : null;
  const spread = bothSided ? ask - bid : null;
  const spreadBps = spread != null && mid != null ? (spread / mid) * 10_000 : null;
  const fill = opts.fill === undefined ? mid : opts.fill;
  const signalToSubmit = opts.signalToSubmitMs ?? 40;
  const tSignal = NOW;
  const tSubmit = tSignal + signalToSubmit;
  const tAck = tSubmit + 20;
  const filled = opts.filled ?? fill != null;
  const tFill = filled ? tAck + 500 : null;
  const farTouch = side === 'buy' ? ask : bid;
  const fillMinusMid = fill != null && mid != null ? fill - mid : null;
  const fillMinusFarTouch = fill != null ? fill - farTouch : null;
  return {
    side,
    orderId: 111,
    status: filled ? 'filled' : 'pending',
    reason: null,
    avgFillPrice: fill,
    execQuantity: filled ? 1 : null,
    decisionQuote: {
      bid,
      ask,
      mid,
      spread,
      spreadBps,
      quoteTimeMs: tSignal,
      tSignal,
    },
    timeline: { tSignal, tSubmit, tAck, tFill },
    metrics: {
      latencyMs: {
        signalToSubmit,
        submitToAck: 20,
        ackToFill: tFill != null ? tFill - tAck : null,
      },
      slippage: { fillMinusMid, fillMinusFarTouch },
      withinSpread: fill != null ? fill >= bid && fill <= ask : null,
    },
  };
}

function makeResult(
  optionType: 'call' | 'put',
  opts: {
    underlying?: string;
    ok?: boolean;
    entry?: SmokeLegResult;
    exit?: SmokeLegResult;
    withContract?: boolean;
    realized?: number | null;
  } = {},
): SmokeContractResult {
  const entry = opts.entry ?? makeLeg('buy', { fill: 1.06 });
  const exit = opts.exit ?? makeLeg('sell', { fill: 1.04 });
  return {
    ok: opts.ok ?? true,
    optionType,
    underlying: opts.underlying ?? 'SPY',
    realizedRoundTripUsd: opts.realized === undefined ? -2.3 : opts.realized,
    modeledCommissionUsd: 1.3,
    contract: (opts.withContract ?? true)
      ? {
          optionSymbol: 'SPY260724C00500000',
          strike: 500,
          expiration: '2026-07-24',
          dte: 3,
          underlyingRefPrice: 500,
        }
      : undefined,
    entry: opts.withContract === false ? undefined : entry,
    exit: opts.withContract === false ? undefined : exit,
  };
}

// ── recordFromContractResult (pure mapping) ──────────────────────────────────

describe('recordFromContractResult', () => {
  it('maps a full round-trip to a durable record with the acceptance fields per leg', () => {
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.strategy).toBe('long_call');
    expect(rec!.underlying).toBe('SPY');
    expect(rec!.ok).toBe(true);
    expect(rec!.etDay).toBe(ET_DAY);
    expect(rec!.ts).toBe(NOW);
    expect(rec!.realizedRoundTripUsd).toBe(-2.3);
    expect(rec!.legs).toHaveLength(2);

    const entry = rec!.legs[0];
    expect(entry.side).toBe('buy');
    expect(entry.optionSymbol).toBe('SPY260724C00500000');
    expect(entry.signalToSubmitMs).toBe(40);
    expect(entry.requestedPx).toBeCloseTo(1.05, 6); // mid of 1.0/1.1
    expect(entry.fillPx).toBe(1.06);
    // slippageBps = (1.06 - 1.05)/1.05 * 1e4 ≈ 95.24
    expect(entry.slippageBps).toBeCloseTo(95.24, 1);
    // spreadAtSubmitPct = spreadBps/100; spreadBps = 0.1/1.05*1e4 ≈ 952.38 ⇒ ~9.52%
    expect(entry.spreadAtSubmitPct).toBeCloseTo(9.52, 1);
    expect(entry.withinSpread).toBe(true);
  });

  it('returns null when the round-trip never built a contract (no leg to record)', () => {
    const rec = recordFromContractResult(
      'long_put',
      makeResult('put', { withContract: false, ok: false }),
      ET_DAY,
      NOW,
    );
    expect(rec).toBeNull();
  });

  it('records null (not 0) slippage/requestedPx on a one-sided quote', () => {
    const entry = makeLeg('buy', { bid: 0, ask: 1.2, fill: 1.1 });
    const rec = recordFromContractResult(
      'long_call',
      makeResult('call', { entry }),
      ET_DAY,
      NOW,
    );
    // bid=0 ⇒ not two-sided ⇒ mid null ⇒ slippage/requestedPx/spread all null, not 0.
    expect(rec!.legs[0].requestedPx).toBeNull();
    expect(rec!.legs[0].slippageBps).toBeNull();
    expect(rec!.legs[0].spreadAtSubmitPct).toBeNull();
  });
});

describe('longStrategyFor', () => {
  it('maps option type to the single-leg long strategy tag', () => {
    expect(longStrategyFor('call')).toBe('long_call');
    expect(longStrategyFor('put')).toBe('long_put');
  });
});

describe('shortStrategyFor', () => {
  it('maps put to csp and call to covered_call', () => {
    expect(shortStrategyFor('put')).toBe('csp');
    expect(shortStrategyFor('call')).toBe('covered_call');
  });
});

// ── write-through + hydrate durability ───────────────────────────────────────

describe('durable write-through + hydrate', () => {
  it('appends each record as JSONL and rebuilds the series on boot', () => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW); // configure dataDir
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    recordSandboxStrategy(rec);

    const raw = readFileSync(sandboxStrategyLogPath(dir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);

    // Simulate a reboot: clear memory, hydrate from the same dir.
    clearSandboxStrategyJournal();
    const h = hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    expect(h.records).toBe(1);
    expect(h.strategies).toBe(1);
    const summary = summarizeSandboxStrategyJournal();
    expect(summary.totalRecords).toBe(1);
    expect(summary.strategies.long_call.total).toBe(1);
    expect(summary.strategies.long_call.clean).toBe(1);
  });

  it('drops records older than the retention window on boot and compacts the file', () => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    const fresh = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    const stale: SandboxStrategyRecord = {
      ...recordFromContractResult('long_put', makeResult('put'), '2026-01-01', NOW)!,
      ts: NOW - 90 * 24 * 60 * 60 * 1000, // 90d ago, outside the 60d window
    };
    // write both directly to the file, stale first
    writeFileSync(
      sandboxStrategyLogPath(dir),
      JSON.stringify(stale) + '\n' + JSON.stringify(fresh) + '\n',
      'utf8',
    );

    const h = hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    expect(h.records).toBe(1); // stale dropped
    const raw = readFileSync(sandboxStrategyLogPath(dir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1); // file compacted
    expect(raw).toContain('long_call');
    expect(raw).not.toContain('long_put');
  });

  it('tolerates a torn trailing line without aborting the hydrate', () => {
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    writeFileSync(
      sandboxStrategyLogPath(dir),
      JSON.stringify(rec) + '\n' + '{"ts":123,"strat', // torn
      'utf8',
    );
    const h = hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    expect(h.records).toBe(1);
  });

  it('keeps in-memory series updating even with no dataDir configured', () => {
    // clear leaves dataDir null; record should still update memory, skip file IO
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    recordSandboxStrategy(rec);
    expect(summarizeSandboxStrategyJournal().totalRecords).toBe(1);
    expect(existsSync(sandboxStrategyLogPath(dir))).toBe(false);
  });
});

// ── summary / acceptance unit ────────────────────────────────────────────────

describe('summarizeSandboxStrategyJournal', () => {
  beforeEach(() => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);
  });

  it('counts a clean, in-budget round-trip toward acceptance', () => {
    recordSandboxStrategy(recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal().strategies.long_call;
    expect(s.clean).toBe(1);
    expect(s.cleanWithinLatencyBudget).toBe(1);
    expect(s.acceptanceMet).toBe(true);
    expect(s.maxSignalToSubmitMs).toBe(40);
    expect(s.meanSlippageBps).not.toBeNull();
  });

  it('does NOT count a clean round-trip that blew the latency budget toward acceptance', () => {
    const slow = makeResult('call', {
      entry: makeLeg('buy', { fill: 1.06, signalToSubmitMs: SIGNAL_TO_SUBMIT_BUDGET_MS + 100 }),
      exit: makeLeg('sell', { fill: 1.04 }),
      ok: true,
    });
    recordSandboxStrategy(recordFromContractResult('long_call', slow, ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal().strategies.long_call;
    expect(s.clean).toBe(1);
    expect(s.cleanWithinLatencyBudget).toBe(0);
    expect(s.acceptanceMet).toBe(false); // ran, but no clean+in-budget trip — NOT the same as "absent"
  });

  it('does NOT count a non-clean round-trip toward clean', () => {
    const notFilled = makeResult('put', {
      entry: makeLeg('buy', { fill: null, filled: false }),
      exit: makeLeg('sell', { fill: null, filled: false }),
      ok: false,
    });
    recordSandboxStrategy(recordFromContractResult('long_put', notFilled, ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal().strategies.long_put;
    expect(s.total).toBe(1);
    expect(s.clean).toBe(0);
    expect(s.acceptanceMet).toBe(false);
  });

  it('reports durability.ephemeral true for a fallback dir (no DATA_DIR env)', () => {
    // dir is a tmp path, and DATA_DIR env is unset under vitest ⇒ ephemeral.
    const prev = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    try {
      const d = summarizeSandboxStrategyJournal().durability;
      expect(d.ephemeral).toBe(true);
      expect(d.dataDir).toBe(dir);
    } finally {
      if (prev !== undefined) process.env.DATA_DIR = prev;
    }
  });
});
