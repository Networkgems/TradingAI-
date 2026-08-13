// TRA-3486 — `mirrorLiveOptionOpen` reported SUCCESS for an order it never placed.
//
// ── The defect ─────────────────────────────────────────────────────────────
//
// The head of the shared live-entry broker seam was one guard covering three
// unrelated conditions:
//
//     if (!this.tradierLiveClient || !opened.optionSymbol || !(opened.contracts > 0))
//       return true;
//
// `true` is the caller's "mirrored" verdict. So a null `tradierLiveClient`
// submitted NOTHING and reported success, and all three callers then ran past
// `if (!mirrored) continue;` into `emitOptionFillAlert(...)` — a FILL alert for an
// order that never reached a broker — `signal.mode = 'live'`, and a paper position
// left sitting in `openOptions` with its journal row at `outcome:'OPEN'`,
// `mode:'live'`.
//
// ── Why TRA-3472 did not already cover it ──────────────────────────────────
//
// `a4ed77a2` retracts the journal OPEN on every VOID branch. This path never
// reached a void branch — there was nothing to retract it from. The row was not
// stranded by a failed retraction; it was never a candidate for one.
//
// ── Reachability ───────────────────────────────────────────────────────────
//
// A null `tradierLiveClient` under `mode === 'live'` is the TRA-2693 bistable
// window (a mid-pass `mode` flip). The EXIT side already needed
// `reapAbandonedStagedExits` (TRA-2819) for exactly this window, where the submit
// half "returned early on a null `tradierLiveClient`". The entry side reported
// success instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { SignalEngine } from './signal-engine.js';
import type { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  getOptionTradeVoids,
} from './option-trade-journal.js';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const OCC = 'SO260918C00092500';

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-3486',
    symbol: 'SO',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.725,
    stopLoss: 1.29,
    takeProfit: 2.6,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 92.5,
    expiration: '2026-09-18',
    mark: 1.725,
    theo: 2.2,
    mispricingPct: -0.21,
    delta: 0.22,
    ...overrides,
  };
}

const OTM_SETUP = {
  ivRank: null,
  trend: 'sideways' as const,
  sentiment: null,
  entryDelta: 0.22,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: null,
};

type EngineInternals = {
  mode: 'demo' | 'live';
  tradierLiveClient: unknown;
  readonly optionsAccount: PaperOptionsAccount;
  mirrorLiveOptionOpen: (
    opened: OptionPosition,
    surfaceLiveSkip: (reason: string) => void,
    opts?: { sleeve?: string; walk?: unknown },
  ) => Promise<boolean>;
};

/**
 * A live-mode engine with NO broker client — the TRA-2693 window itself — and a
 * live paper option already on its book, journal row already queued, exactly as
 * the three callers hand it to the seam.
 */
function liveEngineWithNoBrokerClient(): {
  engine: SignalEngine;
  internals: EngineInternals;
  position: OptionPosition;
} {
  const engine = new SignalEngine(undefined, undefined, undefined);
  const internals = engine as unknown as EngineInternals;
  internals.mode = 'live';
  internals.tradierLiveClient = null;

  const position = internals.optionsAccount.openOptionFromCandidate(
    buildSignal(), 'live', undefined, 88.2, OTM_SETUP, 2,
  );
  expect(position).not.toBeNull();
  return { engine, internals, position: position! };
}

/** Runs the seam the way every caller does, with a spy on the skip surface. */
async function mirror(
  internals: EngineInternals,
  position: OptionPosition,
): Promise<{ mirrored: boolean; skips: string[] }> {
  const skips: string[] = [];
  const mirrored = await internals.mirrorLiveOptionOpen.call(
    internals,
    position,
    (reason: string) => { skips.push(reason); },
    { sleeve: 'single_leg_otm' },
  );
  return { mirrored, skips };
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra3486-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-3486 — a live open with no broker client is a FAILURE, not a mirror', () => {
  // THE reported defect. On the pre-fix build this returns `true`, and every
  // assertion after it fails: the caller would have emitted a fill alert.
  it('returns false so the caller skips the fill', async () => {
    const { internals, position } = liveEngineWithNoBrokerClient();
    const { mirrored } = await mirror(internals, position);
    expect(mirrored).toBe(false);
  });

  it('voids the paper position instead of leaving it unbacked on the live book', async () => {
    const { internals, position } = liveEngineWithNoBrokerClient();

    // Positive control: the position this test claims to remove has to be on the
    // book first, or the assertion below passes against an empty book.
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(1);

    await mirror(internals, position);
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(0);
  });

  // The whole point of routing through `tradierVoid`: TRA-3472's retraction now
  // covers this branch for free. Before the fix there was no void to hang it on.
  it('retracts the journal OPEN row, which TRA-3472 could not reach from here', async () => {
    const { internals, position } = liveEngineWithNoBrokerClient();

    await internals.optionsAccount.flushOptionTradeJournal();
    const before = await listOptionTradeJournal();
    expect(before).toHaveLength(1);
    expect(before[0]!.outcome).toBe('OPEN');
    expect(before[0]!.mode).toBe('live');
    expect(before[0]!.optionSymbol).toBe(OCC);

    await mirror(internals, position);
    // `tradierVoid` fires the retraction as `flush().then(record)`, so drain it.
    await internals.optionsAccount.flushOptionTradeJournal();
    await vi.waitFor(async () => {
      expect(await listOptionTradeJournal()).toHaveLength(0);
    });
  });

  // The retraction deletes the row, so the void ledger is the only durable trace
  // of WHICH abort fired. A branch that voids without naming itself is
  // indistinguishable on `/api/health/option-journal` from one that never ran.
  it('names the TRA-2693 window in the durable void witness and on the dashboard', async () => {
    const { internals, position } = liveEngineWithNoBrokerClient();
    await internals.optionsAccount.flushOptionTradeJournal();

    // Negative control: no voids before the call.
    expect(getOptionTradeVoids().total).toBe(0);

    const { skips } = await mirror(internals, position);
    await internals.optionsAccount.flushOptionTradeJournal();

    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain('no live Tradier options client');

    await vi.waitFor(() => {
      const voids = getOptionTradeVoids();
      expect(voids.total).toBe(1);
      expect(voids.applied).toBe(1);
      expect(voids.live).toBe(1);
      expect(voids.recent[0]).toMatchObject({
        id: position.id,
        applied: true,
        mode: 'live',
        optionSymbol: OCC,
      });
      expect(voids.recent[0]!.reason).toContain('TRA-2693');
    });
  });
});

describe('TRA-3486 — the other two conditions are failures on a live book too', () => {
  // Unreachable from the three callers today (both signal types declare
  // `optionSymbol: string`), but if it ever arrived the position would be not
  // just unbacked but UNCLOSABLE: every live exit path keys on `optionSymbol`.
  it('voids a live open carrying no option symbol', async () => {
    const { internals, position } = liveEngineWithNoBrokerClient();
    internals.tradierLiveClient = { /* present, so this is not the client branch */ };
    const noSymbol = { ...position, optionSymbol: undefined };

    const { mirrored, skips } = await mirror(internals, noSymbol);
    expect(mirrored).toBe(false);
    expect(skips[0]).toContain('no option symbol');
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(0);
  });

  // The live-reachable half of the contract-count condition. `contracts <= 0` is
  // already refused inside both account constructors — but NaN is not: `NaN <= 0`
  // is false, so the position gets created, and `!(NaN > 0)` is true, so the old
  // guard called it MIRRORED. (Cash is already NaN by the time we get here, from
  // the open's own `contracts * costPerContract`; the void does not introduce
  // that.)
  it('voids a live open whose contract count is NaN, which the account does not refuse', async () => {
    const nan = Number.NaN as number;
    expect(nan <= 0).toBe(false);  // `if (contracts <= 0) return null` does NOT refuse it
    expect(nan > 0).toBe(false);   // ...and `!(contracts > 0)` caught it as benign "nothing to mirror"

    const { internals, position } = liveEngineWithNoBrokerClient();
    internals.tradierLiveClient = {};
    const nanContracts = { ...position, contracts: NaN };

    const { mirrored, skips } = await mirror(internals, nanContracts);
    expect(mirrored).toBe(false);
    expect(skips[0]).toContain('non-positive contract count');
    expect(internals.optionsAccount.getStateForMode('live').openOptions).toHaveLength(0);
  });
});

describe('TRA-3486 — the demo book keeps the permissive branch', () => {
  // The guard that matters more than the fix. Voiding a demo open would be a
  // regression invented by this ticket: a demo book has no broker leg to mirror,
  // so "no client" is not a failure there. No caller reaches this today (all
  // three are inside `mode === 'live'`); it exists so a future one cannot
  // re-open the hole from the other side.
  it('leaves a demo open untouched when there is no broker client', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    const internals = engine as unknown as EngineInternals;
    internals.mode = 'demo';
    internals.tradierLiveClient = null;

    const position = internals.optionsAccount.openOptionFromCandidate(
      buildSignal(), 'demo', undefined, 88.2, OTM_SETUP, 2,
    );
    expect(position).not.toBeNull();
    await internals.optionsAccount.flushOptionTradeJournal();

    const { mirrored, skips } = await mirror(internals, position!);
    expect(mirrored).toBe(true);
    expect(skips).toHaveLength(0);
    expect(internals.optionsAccount.getStateForMode('demo').openOptions).toHaveLength(1);

    // ...and nothing was retracted.
    await internals.optionsAccount.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(1);
    expect(getOptionTradeVoids().total).toBe(0);
  });
});
