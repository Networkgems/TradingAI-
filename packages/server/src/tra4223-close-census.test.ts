import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradierOrderError } from '@trading-app/engine';
import { SignalEngine } from './signal-engine.js';
import { etDateString } from './scheduler.js';
import {
  PERMISSION_BREAKER_THRESHOLD,
  __resetBrokerSubmitCensusForTest,
  hydrateCensusFromDir,
  recordBrokerCloseEvent,
  recordBrokerFill,
  recordBrokerReject,
  recordBrokerSubmit,
  summarizeBrokerSubmitCensus,
} from './broker-submit-census.js';

/**
 * TRA-4223 — the broker census instrumented ENTRIES ONLY.
 *
 * ## The measured shape every test below is anchored on
 *
 * 2026-08-31, pin `092d087775dc` / pid 52, production Tradier ***0154:
 *
 *   `admin` staged exits on 3 live rows. All 3 `sell_to_close` submits THREW on
 *   a Tradier HTTP 500. All 3 tripped the TRA-450 `close_reject_breaker`,
 *   leaving three real-money rows with breached stops and no working exit.
 *
 * The census cell for that book read:
 *
 *   `observed:false, submitted:0, brokerRejects:0, verdict:"idle"`
 *
 * — byte-identical to a book that placed no orders at all. `recordBrokerSubmit`
 * and `recordBrokerReject` had exactly two call sites, both inside
 * `mirrorLiveOptionOpen`; the close path was never observed.
 *
 * ## What must NOT be the remedy
 *
 * `submissionsRefusedByBreaker` is the TRA-3905 PERMISSION breaker's counter and
 * increments only on `cls === 'permission_blocked'`. `close_reject_breaker` is a
 * different circuit with a different latch and a different remedy. Making one
 * count the other would fuse them and damage TRA-3905's instrument. The last
 * describe block below is the pin on that, and it is the acceptance criterion —
 * not a nice-to-have.
 */
const BOOK = 'admin';
const DAY = '2026-08-31';

const row = (book = BOOK, roster: string[] = [book]) =>
  summarizeBrokerSubmitCensus(DAY, roster).books.find(b => b.book === book)!;

beforeEach(() => {
  __resetBrokerSubmitCensusForTest();
});

describe('AC2 — a book whose only broker activity was N failed exits is not `idle`', () => {
  /** The 2026-08-31 admin shape, exactly: 3 rows, 3 throws, 0 entries. */
  const stageThreeFailedExits = (): void => {
    for (let i = 0; i < 3; i += 1) recordBrokerCloseEvent(BOOK, DAY, 'transport_fault');
  };

  it('THE DEFECT: three failed exits and no entries no longer reads verdict:"idle"', () => {
    stageThreeFailedExits();
    const r = row();
    expect(r.verdict).not.toBe('idle');
    expect(r.verdict).toBe('degraded');
  });

  it('and the cell is observed — the pre-fix reading was `observed:false`', () => {
    stageThreeFailedExits();
    expect(row().observed).toBe(true);
  });

  it('the three throws are counted as transport faults, NOT as submitted (AC1)', () => {
    stageThreeFailedExits();
    const r = row();
    expect(r.closeTransportFaults).toBe(3);
    expect(r.closeSubmitted).toBe(0);
    expect(r.closeFilled).toBe(0);
    // `closeAttempts` is the denominator that makes `idle` mean "did nothing".
    expect(r.closeAttempts).toBe(3);
  });

  it('the ENTRY leg still reads idle — the two legs are reported separately', () => {
    stageThreeFailedExits();
    const r = row();
    expect(r.entryVerdict).toBe('idle');
    expect(r.closeVerdict).toBe('degraded');
    // And the entry-leg pair TRA-3905 publishes is untouched by a close event.
    expect(r.submitted).toBe(0);
    expect(r.filled).toBe(0);
    expect(r.brokerRejects).toBe(0);
  });

  it('NEGATIVE CONTROL: a genuinely quiet book still reads idle', () => {
    const r = row();
    expect(r.observed).toBe(false);
    expect(r.verdict).toBe('idle');
    expect(r.closeAttempts).toBe(0);
    expect(r.closeVerdict).toBe('idle');
  });

  it('the rollup carries the incident fleet-wide', () => {
    stageThreeFailedExits();
    const rollup = summarizeBrokerSubmitCensus(DAY, [BOOK]).rollup;
    expect(rollup.closeAttempts).toBe(3);
    expect(rollup.closeTransportFaults).toBe(3);
    expect(rollup.closeTransportBookCount).toBe(1);
    expect(rollup.closeDegradedBookCount).toBe(1);
    expect(rollup.closeFilled).toBe(0);
  });
});

describe('AC1 — reached-Tradier and threw-before-Tradier are counted SEPARATELY', () => {
  it('a close the broker accepted counts as submitted, never as a fault', () => {
    recordBrokerCloseEvent(BOOK, DAY, 'submitted');
    recordBrokerCloseEvent(BOOK, DAY, 'filled');
    const r = row();
    expect(r.closeSubmitted).toBe(1);
    expect(r.closeFilled).toBe(1);
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeSubmitThrows).toBe(0);
    expect(r.closeVerdict).toBe('green');
  });

  it('a broker 5xx and a client-side throw land in DIFFERENT buckets (TRA-4226 line)', () => {
    recordBrokerCloseEvent(BOOK, DAY, 'transport_fault');
    recordBrokerCloseEvent(BOOK, DAY, 'submit_throw');
    const r = row();
    expect(r.closeTransportFaults).toBe(1);
    expect(r.closeSubmitThrows).toBe(1);
    // Both are attempts; neither is a submit.
    expect(r.closeAttempts).toBe(2);
    expect(r.closeSubmitted).toBe(0);
  });

  it('a broker refusal and a lapse are separate outcomes (TRA-2984 line)', () => {
    recordBrokerCloseEvent(BOOK, DAY, 'submitted');
    recordBrokerCloseEvent(BOOK, DAY, 'rejected');
    recordBrokerCloseEvent(BOOK, DAY, 'submitted');
    recordBrokerCloseEvent(BOOK, DAY, 'expired');
    const r = row();
    expect(r.closeRejected).toBe(1);
    expect(r.closeExpired).toBe(1);
    expect(r.closeSubmitted).toBe(2);
    expect(r.closeVerdict).toBe('degraded');
  });
});

describe('the verdict is the WORSE of the two legs, not either one alone', () => {
  it('filled entries do NOT mask failed exits', () => {
    recordBrokerSubmit(BOOK, DAY);
    recordBrokerFill(BOOK, DAY);
    recordBrokerSubmit(BOOK, DAY);
    recordBrokerFill(BOOK, DAY);
    for (let i = 0; i < 3; i += 1) recordBrokerCloseEvent(BOOK, DAY, 'transport_fault');
    const r = row();
    expect(r.entryVerdict).toBe('green');
    expect(r.closeVerdict).toBe('degraded');
    // The whole point: 2/2 entries filled must not publish `green` on a book
    // whose three exits all failed.
    expect(r.verdict).toBe('degraded');
  });

  it('failed exits do NOT mask a permission-blocked entry leg — red still wins', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      recordBrokerSubmit(BOOK, DAY);
      recordBrokerReject(BOOK, DAY, 'permission', 'Account is restricted for option trading.');
    }
    recordBrokerCloseEvent(BOOK, DAY, 'transport_fault');
    const r = row();
    expect(r.verdict).toBe('red');
    expect(r.brokerPermissionBlocked).toBe(true);
  });

  it('both legs healthy reads green', () => {
    recordBrokerSubmit(BOOK, DAY);
    recordBrokerFill(BOOK, DAY);
    recordBrokerCloseEvent(BOOK, DAY, 'submitted');
    recordBrokerCloseEvent(BOOK, DAY, 'filled');
    expect(row().verdict).toBe('green');
  });

  it('a close leg that lost one to a 5xx and then filled is green, with the fault still published', () => {
    recordBrokerCloseEvent(BOOK, DAY, 'transport_fault');
    recordBrokerCloseEvent(BOOK, DAY, 'submitted');
    recordBrokerCloseEvent(BOOK, DAY, 'filled');
    const r = row();
    // `degraded` means "filled none"; this day filled one. The fault is readable
    // on its own field rather than by overloading the verdict.
    expect(r.closeVerdict).toBe('green');
    expect(r.closeTransportFaults).toBe(1);
    expect(summarizeBrokerSubmitCensus(DAY, [BOOK]).rollup.closeTransportBookCount).toBe(1);
  });
});

describe('AC3 — `submissionsRefusedByBreaker` still counts ONLY the permission breaker', () => {
  it('REGRESSION PIN: close_reject_breaker events do not increment it', () => {
    // Every close outcome the exit path can produce, including the exact
    // 2026-08-31 sequence that tripped `close_reject_breaker` three times.
    for (const event of [
      'submitted',
      'filled',
      'rejected',
      'expired',
      'transport_fault',
      'submit_throw',
    ] as const) {
      for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD + 1; i += 1) {
        recordBrokerCloseEvent(BOOK, DAY, event);
      }
    }
    const r = row();
    expect(r.submissionsRefusedByBreaker).toBe(0);
    // …and the permission circuit itself is entirely untouched.
    expect(r.brokerPermissionBlocked).toBe(false);
    expect(r.brokerPermissionBlockedSince).toBeNull();
    expect(r.brokerPermissionBlockedReason).toBeNull();
    expect(r.consecutivePermissionRejects).toBe(0);
    expect(r.permissionRejects).toBe(0);
    expect(r.rejects.permission).toBe(0);
    expect(r.rejects.transport).toBe(0);
    expect(r.preSubmitAborts).toBe(0);
  });

  it('the permission breaker still trips and still counts its OWN refusals', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      recordBrokerSubmit(BOOK, DAY);
      recordBrokerReject(BOOK, DAY, 'permission', 'Account is restricted for option trading.');
    }
    recordBrokerReject(BOOK, DAY, 'permission_blocked', 'halted');
    expect(row().submissionsRefusedByBreaker).toBe(1);
  });

  it('a close FILL does not reset the permission run', () => {
    // A close filling proves the account may SELL what it already holds; it is
    // not proof it may OPEN options, which is what the run measures.
    recordBrokerReject(BOOK, DAY, 'permission', 'restricted');
    recordBrokerCloseEvent(BOOK, DAY, 'filled');
    expect(row().consecutivePermissionRejects).toBe(1);
  });
});

/**
 * TRA-4223 — THE WIRING PROOF, and it is not optional.
 *
 * Everything above grades the census MODULE. A module that counts perfectly and
 * is never called is exactly the defect this ticket is about, one layer in — and
 * this repo has shipped that shape before (TRA-3730: a repair read `clean` with
 * its write path never run). So these drive the REAL `submitStagedOptionExits`
 * against a stub Tradier client and assert on the census the engine wrote.
 *
 * The fixture is the 2026-08-31 admin shape: three staged exits, three
 * `sellContractsLimit` calls, all three throwing Tradier's HTTP 500.
 */
describe('AC2 (end to end) — the 2026-08-31 admin shape through the real engine seam', () => {
  const TODAY = etDateString(new Date());

  interface ExitStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
    sellContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    getOrderStatus: ReturnType<typeof vi.fn>;
  }

  const makeStub = (): ExitStub => ({
    getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'X', bid: 0.98, ask: 1.02 }),
    sellContractsLimit: vi.fn().mockResolvedValue({ id: 901, status: 'pending' }),
    sellContracts: vi.fn().mockResolvedValue({ id: 902, status: 'pending' }),
    waitForOrderTerminalStatus: vi.fn().mockResolvedValue(null),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
    getOrderStatus: vi.fn().mockResolvedValue({ id: 901, status: 'canceled', exec_quantity: 0 }),
  });

  const setup = (stub: ExitStub) => {
    const engine = new SignalEngine();
    const priv = engine as unknown as { tradierLiveClient: unknown; alertUsername: string | null };
    priv.tradierLiveClient = stub;
    // The census key. Same field the ENTRY seam reads, which is what makes the
    // two legs land on one row.
    priv.alertUsername = BOOK;
    return (
      engine as unknown as {
        submitStagedOptionExits: (s: unknown[]) => Promise<void>;
      }
    ).submitStagedOptionExits.bind(engine);
  };

  const stagedExit = (id: string, optionSymbol: string) =>
    ({
      id,
      symbol: optionSymbol.slice(0, 3),
      optionSymbol,
      pendingExit: {
        tradierOrderId: '',
        qty: 1,
        limitPrice: 1.5,
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'limit',
      },
    }) as unknown;

  /** Tradier's own 2026-08-31 fault, as the order client raises it. */
  const tradier500 = () =>
    new TradierOrderError(
      'Tradier order failed (500): An error occurred while communicating with the backend.',
      'transport',
      500,
    );

  const todayRow = () => summarizeBrokerSubmitCensus(TODAY, [BOOK]).books.find(b => b.book === BOOK)!;

  it('three staged exits, three Tradier 500s: the census reads 3 transport faults, NOT idle', async () => {
    const stub = makeStub();
    stub.sellContractsLimit.mockRejectedValue(tradier500());
    const submit = setup(stub);

    await submit([
      stagedExit('row-1', 'RIG260918C00004000'),
      stagedExit('row-2', 'SOFI260918C00030000'),
      stagedExit('row-3', 'NVTS260918C00008000'),
    ]);

    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(3);
    const r = todayRow();
    // The reading the box gave on 2026-08-31 was `verdict:"idle"`, submitted 0.
    expect(r.verdict).toBe('degraded');
    expect(r.observed).toBe(true);
    expect(r.closeTransportFaults).toBe(3);
    expect(r.closeAttempts).toBe(3);
    expect(r.closeSubmitted).toBe(0);
    // AC3, through the real path: the permission breaker's counter is untouched.
    expect(r.submissionsRefusedByBreaker).toBe(0);
    expect(r.brokerPermissionBlocked).toBe(false);
    // And the entry leg is genuinely idle — 0 entries that day, correctly said.
    expect(r.entryVerdict).toBe('idle');
    expect(r.submitted).toBe(0);
  });

  it('a submit the broker ACCEPTS counts as submitted, not as a fault', async () => {
    const stub = makeStub();
    const submit = setup(stub);
    await submit([stagedExit('row-1', 'RIG260918C00004000')]);
    const r = todayRow();
    expect(r.closeSubmitted).toBe(1);
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeSubmitThrows).toBe(0);
  });

  it('a NON-transport throw lands in `submit_throw`, not `transport_fault`', async () => {
    const stub = makeStub();
    stub.sellContractsLimit.mockRejectedValue(
      new TradierOrderError('Tradier order rejected: bad payload', 'malformed'),
    );
    const submit = setup(stub);
    await submit([stagedExit('row-1', 'RIG260918C00004000')]);
    const r = todayRow();
    expect(r.closeSubmitThrows).toBe(1);
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeVerdict).toBe('degraded');
  });

  it('a terminal FILL on the submit tick is counted on the close leg', async () => {
    const stub = makeStub();
    stub.waitForOrderTerminalStatus.mockResolvedValue({
      id: 901,
      status: 'filled',
      avg_fill_price: 1.0,
      exec_quantity: 1,
    });
    const submit = setup(stub);
    await submit([stagedExit('row-1', 'RIG260918C00004000')]);
    const r = todayRow();
    expect(r.closeSubmitted).toBe(1);
    expect(r.closeFilled).toBe(1);
    expect(r.closeVerdict).toBe('green');
  });

  it('a terminal broker REJECT is counted, and an EXPIRY is counted separately', async () => {
    const stub = makeStub();
    stub.waitForOrderTerminalStatus.mockResolvedValueOnce({
      id: 901,
      status: 'rejected',
      reason_description: 'not closing a long position',
      exec_quantity: 0,
    });
    stub.waitForOrderTerminalStatus.mockResolvedValueOnce({
      id: 902,
      status: 'expired',
      exec_quantity: 0,
    });
    const submit = setup(stub);
    await submit([stagedExit('row-1', 'RIG260918C00004000')]);
    await submit([stagedExit('row-2', 'SOFI260918C00030000')]);
    const r = todayRow();
    expect(r.closeRejected).toBe(1);
    expect(r.closeExpired).toBe(1);
    expect(r.closeSubmitted).toBe(2);
    expect(r.closeFilled).toBe(0);
    expect(r.closeVerdict).toBe('degraded');
  });

  it('NEGATIVE CONTROL: no staged exits leaves the day untouched', async () => {
    const submit = setup(makeStub());
    await submit([]);
    const r = todayRow();
    expect(r.observed).toBe(false);
    expect(r.verdict).toBe('idle');
  });
});

describe('durability — the close leg survives the snapshot round trip (TRA-3937/TRA-3917)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4223-'));
  });
  afterEach(() => {
    __resetBrokerSubmitCensusForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-through persists the close counters and hydrate reads them back', () => {
    hydrateCensusFromDir(dir); // arms write-through
    for (let i = 0; i < 3; i += 1) recordBrokerCloseEvent(BOOK, DAY, 'transport_fault');
    const onDisk = JSON.parse(
      readFileSync(join(dir, 'broker-census', `${DAY}.json`), 'utf-8'),
    ) as Record<string, { closeTransportFaults?: number }>;
    expect(onDisk[BOOK]!.closeTransportFaults).toBe(3);

    __resetBrokerSubmitCensusForTest();
    hydrateCensusFromDir(dir);
    const r = row();
    expect(r.closeTransportFaults).toBe(3);
    expect(r.verdict).toBe('degraded');
  });

  it('MIGRATION: a snapshot written BEFORE this ticket hydrates to a zeroed close leg, never NaN', () => {
    // The pre-TRA-4223 serialization, verbatim — no close keys at all.
    mkdirSync(join(dir, 'broker-census'), { recursive: true });
    writeFileSync(
      join(dir, 'broker-census', `${DAY}.json`),
      JSON.stringify({
        [BOOK]: {
          submitted: 2,
          filled: 2,
          rejects: {},
          brokerRejects: 0,
          preSubmitAborts: 0,
          consecutivePermission: 0,
          blockedSince: null,
          blockedReason: null,
          refusedByBreaker: 0,
          alerted: false,
        },
      }),
    );
    hydrateCensusFromDir(dir);
    const r = row();
    expect(r.closeAttempts).toBe(0);
    expect(r.closeSubmitted).toBe(0);
    expect(r.closeFilled).toBe(0);
    expect(r.closeTransportFaults).toBe(0);
    expect(Number.isNaN(r.closeAttempts)).toBe(false);
    // An old snapshot must grade exactly as it did before: entries only.
    expect(r.verdict).toBe('green');
    expect(summarizeBrokerSubmitCensus(DAY, [BOOK]).rollup.closeAttempts).toBe(0);
  });
});
