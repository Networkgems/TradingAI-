/**
 * TRA-3939 — the two captures, graded on the properties that make them evidence
 * rather than bookkeeping.
 *
 * The three that matter, and each has its own negative control:
 *   • a MISSED day reads as a NAMED GAP, never as an empty day;
 *   • a FAILED read is recorded, and does not un-capture a day that succeeded;
 *   • a day the recorder did not cover END TO END is NOT attested, so the submit
 *     ledger's silence about it cannot become a `desk_placed`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TradierAccountOrder, TradierOrderSubmitEvent } from '@trading-app/engine';
import type { CapturedBrokerOrderRow } from './tra3939-order-provenance-capture.js';
import {
  __resetOrderProvenanceCaptureForTest,
  armEngineSubmitRecorder,
  bootCoversSession,
  brokerOrderCaptureLogPath,
  captureBrokerOrderDay,
  capturedBrokerOrders,
  capturedBrokerOrderRows,
  maskAccountId,
  setOrderProvenanceLegacyAccount,
  UNATTRIBUTED_ACCOUNT,
  censusCapturedOrders,
  engineSubmitLogPath,
  engineSubmittedProductionOrderIds,
  etDayOf,
  recordEngineOrderSubmit,
  setOrderProvenanceCaptureDataDir,
  summarizeBrokerOrderCaptures,
  summarizeEngineSubmitWitness,
} from './tra3939-order-provenance-capture.js';

let dir: string;

/** 2026-08-21 08:00 ET — before the 09:30 session open. */
const BOOT_BEFORE_OPEN = Date.parse('2026-08-21T12:00:00.000Z');
/** 2026-08-21 11:00 ET — mid-session. */
const BOOT_MID_SESSION = Date.parse('2026-08-21T15:00:00.000Z');

function submitEvent(over: Partial<TradierOrderSubmitEvent> = {}): TradierOrderSubmitEvent {
  return {
    orderId: 900001,
    ackStatus: 'ok',
    env: 'production',
    accountId: '6YA00154',
    orderClass: 'option',
    side: 'buy_to_open',
    symbol: 'XLF',
    optionSymbol: 'XLF260925C00057500',
    quantity: 1,
    limitPrice: 1.23,
    submittedAt: Date.parse('2026-08-21T14:00:00.000Z'),
    ...over,
  };
}

function order(over: Partial<TradierAccountOrder> = {}): TradierAccountOrder {
  return {
    id: 900001,
    status: 'filled',
    orderClass: 'option',
    side: 'buy_to_open',
    symbol: 'XLF',
    optionSymbol: 'XLF260925C00057500',
    quantity: 1,
    execQuantity: 1,
    avgFillPrice: 1.23,
    createDate: '2026-08-21T14:00:00.000Z',
    transactionDate: '2026-08-21T14:00:02.000Z',
    tag: null,
    ...over,
  };
}

/**
 * TRA-4009 — an archive row as the census now receives it: the order PLUS the
 * account it was read from. The census can no longer be handed a bare order list,
 * which is the point — a verdict that cannot name its account is the defect.
 */
function src(o: TradierAccountOrder, account = 'admin'): CapturedBrokerOrderRow {
  return { order: o, account, accountIdMasked: maskAccountId('6YA00154'), captureEtDay: etDayOf(Date.parse(o.createDate ?? '2026-08-21T14:00:00.000Z')) };
}

beforeEach(() => {
  __resetOrderProvenanceCaptureForTest();
  dir = mkdtempSync(join(tmpdir(), 'tra3939-'));
  setOrderProvenanceCaptureDataDir(dir);
});

afterEach(() => {
  __resetOrderProvenanceCaptureForTest();
  rmSync(dir, { recursive: true, force: true });
});

// ── half (1): the submit-time id ledger ─────────────────────────────────────

describe('TRA-3939 submit-time id ledger', () => {
  it('records an acknowledged id at SUBMIT, with no fill anywhere in sight', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    recordEngineOrderSubmit(submitEvent());
    expect([...engineSubmittedProductionOrderIds()]).toEqual([900001]);
  });

  it('AC1 — captures the WALK STEPS a caller never sees, which is the population that would be misread', () => {
    // `submitSmartBuyToOpen` POSTs, waits, CANCELS and re-POSTs up to five times.
    // Its outcome type carries an id only on `filled`/`rejected`; a
    // `walk_exhausted` returns NONE, having minted five real orders that will all
    // appear in `/orders` as `canceled`. Recording only the outcome's id would
    // leave those absent from our set — and a later provenance read would charge
    // every one of them to the desk.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    for (const id of [1001, 1002, 1003, 1004, 1005]) {
      recordEngineOrderSubmit(submitEvent({ orderId: id }));
    }
    expect([...engineSubmittedProductionOrderIds()].sort((a, b) => a - b)).toEqual([
      1001, 1002, 1003, 1004, 1005,
    ]);
  });

  it('SANDBOX ids are recorded but never join a production question', () => {
    // Tradier mints sandbox and production ids from separate spaces with no
    // guarantee of disjointness. A collision would manufacture an `engine_placed`
    // on a contract this account never touched.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    recordEngineOrderSubmit(submitEvent({ orderId: 4242, env: 'sandbox' }));
    expect(engineSubmittedProductionOrderIds().has(4242)).toBe(false);
    expect(summarizeEngineSubmitWitness().orderIds).toBe(1);
    expect(summarizeEngineSubmitWitness().productionOrderIds).toBe(0);
  });

  it('ARMED AND QUIET is distinguishable from NEVER ARMED — the whole safety property', () => {
    // A ledger whose first line is a trade cannot tell these apart, and absence
    // only means something on a day we know we were watching.
    expect(summarizeEngineSubmitWitness().armed).toBe(false);
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    const w = summarizeEngineSubmitWitness();
    expect(w.armed).toBe(true);
    expect(w.orderIds).toBe(0);
    expect(w.armLines).toBe(1);
  });

  it('a corrupt line is COUNTED, never folded into a clean answer', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    recordEngineOrderSubmit(submitEvent());
    const path = engineSubmitLogPath(dir);
    writeFileSync(path, readFileSync(path, 'utf8') + '{not json\n', 'utf8');
    const w = summarizeEngineSubmitWitness();
    expect(w.corruptLines).toBe(1);
    expect(w.orderIds).toBe(1);
  });

  it('never throws when no data dir is configured — the order path must survive it', () => {
    setOrderProvenanceCaptureDataDir(null);
    expect(() => recordEngineOrderSubmit(submitEvent())).not.toThrow();
    expect(summarizeEngineSubmitWitness().lines).toBe(0);
  });
});

// ── half (2): the daily broker order capture ────────────────────────────────

describe('TRA-3939 daily broker order capture', () => {
  it('AC2 — records the capture WITH its own etDaysCovered, so a captured day is legible as one', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    const r = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order()],
      capturedAt: Date.parse('2026-08-21T21:00:00.000Z'),
      accountEnv: 'production', account: 'admin',
    });
    expect(r.written).toBe(true);
    expect(r.line!.etDaysCovered).toEqual(['2026-08-21']);
    expect(r.line!.oldestCreateDate).toBe('2026-08-21T14:00:00.000Z');
  });

  it('is idempotent on SUCCESS — an hourly scheduler writes one line per ET day', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    const first = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order()],
      capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    const second = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order()],
      capturedAt: 2,
      accountEnv: 'production', account: 'admin',
    });
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.skippedAlreadyCaptured).toBe(true);
    expect(summarizeBrokerOrderCaptures().lines).toBe(1);
  });

  it('a FAILED read is written as a named blind AND stays retryable inside the window', () => {
    // The retry is the point: a 16:00 ET failure must not forfeit a day the broker
    // is still serving at 17:00 ET.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    const blind = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: null,
      error: 'HTTP 401',
      capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    expect(blind.written).toBe(true);
    expect(blind.line!.read).toBe(false);
    expect(blind.line!.attestation).toBe('blind');
    const retry = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order()],
      capturedAt: 2,
      accountEnv: 'production', account: 'admin',
    });
    expect(retry.written).toBe(true);
    const day = summarizeBrokerOrderCaptures().days.find(d => d.etDay === '2026-08-21')!;
    expect(day.captured).toBe(true);
    expect(day.attempts).toBe(2);
  });

  it('a later BLIND retry cannot un-capture a day that already succeeded', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({ etDay: '2026-08-21', orders: [order()], capturedAt: 1, accountEnv: 'production', account: 'admin' });
    // Force a second line past the idempotence guard by writing it directly — the
    // shape a future caller could produce.
    const path = brokerOrderCaptureLogPath(dir);
    writeFileSync(
      path,
      readFileSync(path, 'utf8')
        + JSON.stringify({
          kind: 'broker_order_capture',
          etDay: '2026-08-21',
          capturedAt: 3,
          read: false,
          error: 'later failure',
          orders: [],
          etDaysCovered: [],
          oldestCreateDate: null,
          newestCreateDate: null,
          attestation: 'blind',
          recorderBootedAt: null,
          submitLedgerLines: 0,
          accountEnv: 'production', account: 'admin',
        })
        + '\n',
      'utf8',
    );
    const day = summarizeBrokerOrderCaptures().days.find(d => d.etDay === '2026-08-21')!;
    expect(day.captured).toBe(true);
    expect(day.orders).toBe(1);
  });

  it('AC2 — A MISSED DAY READS AS A NAMED GAP, NOT AS AN EMPTY ONE', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    // Mon 2026-08-17 and Wed 2026-08-19 captured; Tue 2026-08-18 never ran.
    for (const d of ['2026-08-17', '2026-08-19']) {
      captureBrokerOrderDay({ etDay: d, orders: [], capturedAt: 1, accountEnv: 'production', account: 'admin' });
    }
    const s = summarizeBrokerOrderCaptures();
    expect(s.gapEtDays).toEqual(['2026-08-18']);
    // …and the day we captured with NO orders is a real observation, not a gap.
    expect(s.days.find(d => d.etDay === '2026-08-17')!.captured).toBe(true);
    expect(s.days.find(d => d.etDay === '2026-08-17')!.orders).toBe(0);
  });

  it('weekends are not gaps', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    for (const d of ['2026-08-21', '2026-08-24']) {
      captureBrokerOrderDay({ etDay: d, orders: [], capturedAt: 1, accountEnv: 'production', account: 'admin' });
    }
    expect(summarizeBrokerOrderCaptures().gapEtDays).toEqual([]);
  });

  it('the archive is what widens the broker ONE-DAY window past today', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-20',
      orders: [order({ id: 111, createDate: '2026-08-20T14:00:00.000Z' })],
      capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order({ id: 222 })],
      capturedAt: 2,
      accountEnv: 'production', account: 'admin',
    });
    expect(capturedBrokerOrders().map(o => o.id).sort((a, b) => a - b)).toEqual([111, 222]);
  });

  it('a BLIND day contributes no rows to the archive', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({ etDay: '2026-08-21', orders: null, error: 'boom', capturedAt: 1, accountEnv: 'production', account: 'admin' });
    expect(capturedBrokerOrders()).toEqual([]);
  });
});

// ── the attestation rule: what entitles the ledger to speak about a day ─────

describe('TRA-3939 attestation — the coverage axis behind a desk_placed', () => {
  it('a boot BEFORE the session open covers the day; a mid-session boot does not', () => {
    expect(bootCoversSession(BOOT_BEFORE_OPEN, '2026-08-21')).toBe(true);
    expect(bootCoversSession(BOOT_MID_SESSION, '2026-08-21')).toBe(false);
  });

  it('a boot on an EARLIER day covers it; a boot on a LATER day does not', () => {
    expect(bootCoversSession(Date.parse('2026-08-18T18:00:00.000Z'), '2026-08-21')).toBe(true);
    expect(bootCoversSession(Date.parse('2026-08-24T12:00:00.000Z'), '2026-08-21')).toBe(false);
  });

  it('an UNKNOWN boot fails CLOSED — an attestation we cannot compute is not one we passed', () => {
    expect(bootCoversSession(null, '2026-08-21')).toBe(false);
    expect(bootCoversSession(Number.NaN, '2026-08-21')).toBe(false);
  });

  it('a full-session boot yields an ATTESTED day; the ledger may speak about it', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({ etDay: '2026-08-21', orders: [order()], capturedAt: 1, accountEnv: 'production', account: 'admin' });
    const w = summarizeEngineSubmitWitness();
    expect(w.coveredEtDays).toEqual(['2026-08-21']);
    expect(w.uncoveredCapturedEtDays).toEqual([]);
  });

  it('THE NEGATIVE CONTROL — a mid-session boot captures the day but is NOT attested for it', () => {
    // The orders are saved (half (1) still works and the evidence is preserved),
    // but the box was not resident for the whole window in which an order could
    // have been placed, so its silence about that day is not testimony. Folding
    // this into `attested` is exactly how an empty ledger becomes an accusation.
    armEngineSubmitRecorder({ bootedAt: BOOT_MID_SESSION });
    const r = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order()],
      capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    expect(r.line!.attestation).toBe('partial');
    const w = summarizeEngineSubmitWitness();
    expect(w.coveredEtDays).toEqual([]);
    expect(w.uncoveredCapturedEtDays).toEqual(['2026-08-21']);
    // …and the orders are still there. Attestation gates the INFERENCE, never the capture.
    expect(capturedBrokerOrders()).toHaveLength(1);
  });

  it('a BLIND day is never attested', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({ etDay: '2026-08-21', orders: null, error: 'boom', capturedAt: 1, accountEnv: 'production', account: 'admin' });
    expect(summarizeEngineSubmitWitness().coveredEtDays).toEqual([]);
  });

  it('a day with NO capture at all is never attested — silence is not coverage', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    expect(summarizeEngineSubmitWitness().coveredEtDays).toEqual([]);
  });
});

describe('TRA-3939 AC4 — the per-order census fires the terminal branches on every captured order', () => {
  const ATTESTED = new Set(['2026-08-24']);

  it('an id in the submit ledger is engine_placed on ANY day — a positive match needs no coverage claim', () => {
    const c = censusCapturedOrders({
      orders: [src(order({ id: 1, createDate: '2026-08-21T14:00:00.000Z' }))],
      submittedIds: new Set([1]),
      attestedEtDays: ATTESTED,
    });
    expect(c.orders[0]!.issuer).toBe('engine_placed');
    expect(c.orders[0]!.witness).toBe('submit_ledger');
    expect(c.terminalOrders).toBe(1);
  });

  it('absent from both ledgers on an ATTESTED day is desk_placed; on an unattested day it is a blind', () => {
    const c = censusCapturedOrders({
      orders: [
        src(order({ id: 1, createDate: '2026-08-24T14:00:00.000Z' })),
        src(order({ id: 2, createDate: '2026-08-25T14:00:00.000Z' })),
      ],
      submittedIds: new Set([999]),
      attestedEtDays: ATTESTED,
    });
    expect(c.orders.map(r => r.issuer)).toEqual(['desk_placed', 'blind_no_issuer_witness']);
    expect(c.orders[1]!.witness).toBe('unattested_day');
    expect(c.byDay).toEqual([
      { etDay: '2026-08-24', attested: true, orders: 1, engine_placed: 0, desk_placed: 1, blind_no_issuer_witness: 0 },
      { etDay: '2026-08-25', attested: false, orders: 1, engine_placed: 0, desk_placed: 0, blind_no_issuer_witness: 1 },
    ]);
    expect(c.terminalOrders).toBe(1);
  });

  it('the fill ledger is a second positive witness, ranked below the submit ledger', () => {
    const c = censusCapturedOrders({
      orders: [src(order({ id: 7, createDate: '2026-08-24T14:00:00.000Z' }))],
      submittedIds: new Set(),
      filledIds: new Set([7]),
      attestedEtDays: ATTESTED,
    });
    expect(c.orders[0]!.issuer).toBe('engine_placed');
    expect(c.orders[0]!.witness).toBe('fill_ledger');
  });

  it('NON-OPTION orders are skipped and counted — the ledger hooks the options client, so their absence is not evidence', () => {
    const c = censusCapturedOrders({
      orders: [
        src(order({ id: 1, orderClass: 'equity', optionSymbol: null, createDate: '2026-08-24T14:00:00.000Z' })),
        src(order({ id: 2, createDate: '2026-08-24T14:00:00.000Z' })),
        src(order({ id: 2, createDate: '2026-08-24T14:00:00.000Z' })), // same id captured twice
      ],
      submittedIds: new Set(),
      attestedEtDays: ATTESTED,
    });
    expect(c.skippedNonOption).toBe(1);
    expect(c.orders).toHaveLength(1);
    expect(c.byIssuer.desk_placed).toBe(1);
  });

  it('an UNDATED row is a blind, never a desk_placed — no day, no attestation', () => {
    const c = censusCapturedOrders({
      orders: [src(order({ id: 1, createDate: null }))],
      submittedIds: new Set(),
      attestedEtDays: ATTESTED,
    });
    expect(c.orders[0]!.issuer).toBe('blind_no_issuer_witness');
    expect(c.orders[0]!.witness).toBe('undated');
  });
});

// ── TRA-4009: the archive reaches EVERY production account, or says whose it misses ──

describe('TRA-4009 — the capture is per (ET day, ACCOUNT)', () => {
  const KNOWN = { knownAccounts: ['admin', 'v0nni'] };

  it('THE DEFECT, as a negative control — the day key alone let one book suppress its sibling', () => {
    // Pre-TRA-4009 the idempotence key was `etDay`. admin captured first, the day
    // then read "already captured", and v0nni's read never happened — while the
    // surface reported the day covered. The key is now `(etDay, account)`.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    const a = captureBrokerOrderDay({
      etDay: '2026-08-24',
      orders: [order({ id: 143032832 })],
      capturedAt: 1,
      accountEnv: 'production',
      account: 'admin',
      accountId: '6YA00154',
    });
    const v = captureBrokerOrderDay({
      etDay: '2026-08-24',
      orders: [order({ id: 143021643 })],
      capturedAt: 2,
      accountEnv: 'production',
      account: 'v0nni',
      accountId: '6YB09876',
    });
    expect(a.written).toBe(true);
    // The line the old key refused to write. This is the whole ticket.
    expect(v.written).toBe(true);
    expect(v.skippedAlreadyCaptured).toBe(false);
    // …and re-running the SAME account is still idempotent.
    const again = captureBrokerOrderDay({
      etDay: '2026-08-24',
      orders: [order({ id: 143021643 })],
      capturedAt: 3,
      accountEnv: 'production',
      account: 'v0nni',
    });
    expect(again.written).toBe(false);
    expect(again.skippedAlreadyCaptured).toBe(true);
  });

  it('AC2 — the archive UNIONS the per-account captures; the day key alone discarded the sibling', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: [order({ id: 143032832 })], capturedAt: 1,
      accountEnv: 'production', account: 'admin', accountId: '6YA00154',
    });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: [order({ id: 143021643 })], capturedAt: 2,
      accountEnv: 'production', account: 'v0nni', accountId: '6YB09876',
    });
    expect(capturedBrokerOrders().map(o => o.id).sort((a, b) => a - b)).toEqual([143021643, 143032832]);
    const rows = capturedBrokerOrderRows();
    expect(rows.find(r => r.order.id === 143021643)!.account).toBe('v0nni');
    expect(rows.find(r => r.order.id === 143021643)!.accountIdMasked).toBe('***9876');
    expect(rows.find(r => r.order.id === 143032832)!.account).toBe('admin');
  });

  it('AC2 — every census row names the account it was read from', () => {
    const c = censusCapturedOrders({
      orders: [
        src(order({ id: 143032832, createDate: '2026-08-24T14:44:34.000Z' }), 'admin'),
        src(order({ id: 143021643, createDate: '2026-08-24T14:25:07.000Z' }), 'v0nni'),
      ],
      submittedIds: new Set([143032832, 143021643]),
      attestedEtDays: new Set(['2026-08-24']),
    });
    expect(c.orders.map(r => r.account)).toEqual(['v0nni', 'admin']);
    expect(c.byAccount.map(a => [a.account, a.orders, a.terminalOrders])).toEqual([
      ['admin', 1, 1],
      ['v0nni', 1, 1],
    ]);
    expect(c.idsSeenOnMultipleAccounts).toBe(0);
  });

  it('a broker-global id served by TWO accounts is COUNTED, never silently merged', () => {
    // Tradier ids are broker-global, so this can only mean two books resolved the
    // same brokerage account. An invariant nobody measures is a hope.
    const c = censusCapturedOrders({
      orders: [
        src(order({ id: 5, createDate: '2026-08-24T14:00:00.000Z' }), 'admin'),
        src(order({ id: 5, createDate: '2026-08-24T14:00:00.000Z' }), 'v0nni'),
      ],
      submittedIds: new Set([5]),
      attestedEtDays: new Set(['2026-08-24']),
    });
    expect(c.orders).toHaveLength(1);
    expect(c.idsSeenOnMultipleAccounts).toBe(1);
  });

  it('AC1 — a day captured for admin and NOT for v0nni is a named gap on v0nni, never a captured day', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: [order()], capturedAt: 1,
      accountEnv: 'production', account: 'admin', accountId: '6YA00154',
    });
    const s = summarizeBrokerOrderCaptures(KNOWN);
    const day = s.days.find(d => d.etDay === '2026-08-24')!;
    // Some book answered…
    expect(day.captured).toBe(true);
    // …but the FLEET did not, and the missing book is NAMED.
    expect(day.fleetCaptured).toBe(false);
    expect(day.capturedAccounts).toEqual(['admin']);
    expect(day.missingAccounts).toEqual(['v0nni']);
    expect(s.fleetCapturedEtDays).toEqual([]);
    expect(s.accounts.find(a => a.account === 'v0nni')!.missingEtDays).toEqual(['2026-08-24']);
    expect(s.accountGapEtDays).toEqual([{ account: 'v0nni', etDays: ['2026-08-24'] }]);
  });

  it('AC1 — an account that has NEVER been captured is still named, which a disk-only roster cannot do', () => {
    // This is the live shape: 14 contiguous admin days, zero v0nni lines. Without
    // the caller's roster, v0nni is not in the data and the surface reads clean.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: [order()], capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    expect(summarizeBrokerOrderCaptures().knownAccounts).toEqual(['admin']);
    const withRoster = summarizeBrokerOrderCaptures(KNOWN);
    expect(withRoster.knownAccounts).toEqual(['admin', 'v0nni']);
    const v = withRoster.accounts.find(a => a.account === 'v0nni')!;
    expect(v.lines).toBe(0);
    expect(v.firstEtDay).toBeNull();
    expect(v.missingEtDays).toEqual(['2026-08-24']);
  });

  it('AC1 — a fully captured day IS a fleet day, and each account keeps its own attestation', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    for (const account of ['admin', 'v0nni']) {
      captureBrokerOrderDay({
        etDay: '2026-08-24', orders: [order()], capturedAt: 1,
        accountEnv: 'production', account, accountId: `6Y-${account}`,
      });
    }
    const s = summarizeBrokerOrderCaptures(KNOWN);
    expect(s.fleetCapturedEtDays).toEqual(['2026-08-24']);
    expect(s.days[0]!.missingAccounts).toEqual([]);
    expect(s.accounts.map(a => a.attestedEtDays)).toEqual([['2026-08-24'], ['2026-08-24']]);
    expect(s.accountGapEtDays).toEqual([]);
  });

  it('AC5 — one account failing and the other succeeding leaves TWO independent lines, not one verdict', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: [order()], capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: null, error: 'HTTP 401', capturedAt: 2,
      accountEnv: 'production', account: 'v0nni',
    });
    const s = summarizeBrokerOrderCaptures(KNOWN);
    const admin = s.accounts.find(a => a.account === 'admin')!;
    const v0nni = s.accounts.find(a => a.account === 'v0nni')!;
    expect(admin.days[0]!.captured).toBe(true);
    expect(admin.days[0]!.attestation).toBe('full');
    expect(v0nni.days[0]!.captured).toBe(false);
    expect(v0nni.days[0]!.attestation).toBe('blind');
    expect(v0nni.days[0]!.lastError).toBe('HTTP 401');
    // The fleet row refuses to call the day covered, and says whose read is missing.
    expect(s.days[0]!.fleetCaptured).toBe(false);
    expect(s.days[0]!.missingAccounts).toEqual(['v0nni']);
  });

  it('THE TWO FOLDS ARE NOT THE SAME FOLD — attestation is UNION (process), reach is INTERSECTION (archive)', () => {
    // admin read cleanly on a full-session boot; v0nni's read failed. The RECORDER
    // was demonstrably resident all day — that is what admin's capture proves — so
    // the day stays attested and the submit ledger may still speak about it. But we
    // do NOT hold v0nni's orders, so the day is not fleet-captured. Collapsing these
    // into one field either retracts residency we proved or claims reach we lack.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: [order()], capturedAt: 1,
      accountEnv: 'production', account: 'admin',
    });
    captureBrokerOrderDay({
      etDay: '2026-08-24', orders: null, error: 'HTTP 500', capturedAt: 2,
      accountEnv: 'production', account: 'v0nni',
    });
    const s = summarizeBrokerOrderCaptures(KNOWN);
    expect(s.attestedEtDays).toEqual(['2026-08-24']);
    expect(s.fleetCapturedEtDays).toEqual([]);
    expect(summarizeEngineSubmitWitness().coveredEtDays).toEqual(['2026-08-24']);
  });

  it('UNSTAMPED legacy lines attribute to the caller-declared account, and to NOBODY without one', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    // A pre-TRA-4009 line: no `account` on the record at all.
    writeFileSync(
      brokerOrderCaptureLogPath(dir),
      JSON.stringify({
        kind: 'broker_order_capture',
        etDay: '2026-08-21',
        capturedAt: 1,
        read: true,
        error: null,
        orders: [order()],
        etDaysCovered: ['2026-08-21'],
        oldestCreateDate: '2026-08-21T14:00:00.000Z',
        newestCreateDate: '2026-08-21T14:00:00.000Z',
        attestation: 'full',
        recorderBootedAt: BOOT_BEFORE_OPEN,
        submitLedgerLines: 1,
        accountEnv: 'production',
      }) + '\n',
      'utf8',
    );
    // Undeclared: visible, joined to nobody, never folded into a real book.
    expect(summarizeBrokerOrderCaptures().knownAccounts).toEqual([UNATTRIBUTED_ACCOUNT]);
    expect(capturedBrokerOrderRows()[0]!.account).toBe(UNATTRIBUTED_ACCOUNT);
    // Declared by the layer that holds the fact — the boot resolves the operator.
    setOrderProvenanceLegacyAccount('admin');
    expect(summarizeBrokerOrderCaptures().knownAccounts).toEqual(['admin']);
    expect(capturedBrokerOrderRows()[0]!.account).toBe('admin');
    expect(summarizeBrokerOrderCaptures({ knownAccounts: ['admin'] }).fleetCapturedEtDays).toEqual([
      '2026-08-21',
    ]);
  });

  it('maskAccountId publishes enough to tell two books apart and not enough to be an account number', () => {
    expect(maskAccountId('6YA00154')).toBe('***0154');
    expect(maskAccountId('12')).toBe('***');
    expect(maskAccountId('')).toBeNull();
    expect(maskAccountId(null)).toBeNull();
  });
});

describe('TRA-3939 etDayOf', () => {
  it('folds a UTC instant onto its ET calendar day, including across the boundary', () => {
    // 2026-08-22T03:00Z is still 2026-08-21 in ET (23:00 EDT) — the exact rollover
    // the broker's one-day window turns on.
    expect(etDayOf(Date.parse('2026-08-22T03:00:00.000Z'))).toBe('2026-08-21');
    expect(etDayOf(Date.parse('2026-08-22T04:30:00.000Z'))).toBe('2026-08-22');
  });
});

// â”€â”€ TRA-4009 follow-on: a FORCED mid-session capture must not seal the day â”€â”€â”€â”€â”€â”€
//
// `runBrokerOrderDayCapture({force:true})` bypasses the 16:00 ET window so the day a
// change ships can still be captured before the ET rollover erases the broker's
// one-day window. That forced read is a real read of a PREFIX of the day. Two
// separate gates keyed on "already captured successfully" â€” this module's
// idempotence and the caller's fleet early-out â€” would both treat that prefix as the
// day being done, and the post-close capture that would have held the rest never
// runs. The orders placed after the forced read are then lost permanently, because
// the broker window does not reopen.

describe('TRA-4009 â€” a pre-close capture is evidence, but never seals the ET day', () => {
  const KNOWN_ = { knownAccounts: ['admin', 'v0nni'] };
  /** 2026-08-21 11:00 ET â€” mid-session, before the 16:00 close. */
  const MID_SESSION = Date.parse('2026-08-21T15:00:00.000Z');
  /** 2026-08-21 17:00 ET â€” after the close. */
  const POST_CLOSE = Date.parse('2026-08-21T21:00:00.000Z');

  it('POSITIVE CONTROL â€” a forced mid-session read does NOT block the post-close capture', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    // 11:00 ET: the operator forces a capture. One order has been placed so far.
    const forced = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order({ id: 143021643 })],
      capturedAt: MID_SESSION,
      accountEnv: 'production',
      account: 'admin',
    });
    expect(forced.written).toBe(true);
    // 17:00 ET: the hourly hook runs. Two more orders were placed after the force.
    // Under the old key this returned written:false / skippedAlreadyCaptured:true
    // and orders 143032832 + 143196771 were never archived at all.
    const sealed = captureBrokerOrderDay({
      etDay: '2026-08-21',
      orders: [order({ id: 143021643 }), order({ id: 143032832 }), order({ id: 143196771 })],
      capturedAt: POST_CLOSE,
      accountEnv: 'production',
      account: 'admin',
    });
    expect(sealed.written).toBe(true);
    expect(sealed.skippedAlreadyCaptured).toBe(false);

    // The reader supersedes: the LAST successful read is the authority, because the
    // broker's list for a day only accumulates.
    const day = summarizeBrokerOrderCaptures(KNOWN_).days.find(d => d.etDay === '2026-08-21')!;
    expect(day.orders).toBe(3);
    expect(day.attempts).toBe(2);
    expect(day.fleetSealed).toBe(false); // v0nni is still owed a read
    // â€¦and all three orders are reachable, not just the prefix.
    expect(capturedBrokerOrders().map(o => o.id).sort((a, b) => a - b)).toEqual([
      143021643, 143032832, 143196771,
    ]);
  });

  it('is STILL idempotent once sealed â€” the hourly scheduler writes one line per (day, account)', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    const first = captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: POST_CLOSE,
      accountEnv: 'production', account: 'admin',
    });
    const second = captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: POST_CLOSE + 3_600_000,
      accountEnv: 'production', account: 'admin',
    });
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.skippedAlreadyCaptured).toBe(true);
  });

  it('a pre-close-only day reads PROVISIONAL and is NOT fleetSealed â€” so the caller re-reads it', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    // Both books captured mid-session. `fleetCaptured` is satisfied â€” every known
    // account answered â€” and that is exactly the reading that is not good enough.
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: MID_SESSION,
      accountEnv: 'production', account: 'admin',
    });
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: MID_SESSION,
      accountEnv: 'production', account: 'v0nni',
    });
    const s = summarizeBrokerOrderCaptures(KNOWN_);
    const day = s.days.find(d => d.etDay === '2026-08-21')!;
    expect(day.captured).toBe(true);
    expect(day.fleetCaptured).toBe(true); // the permissive readingâ€¦
    expect(day.fleetSealed).toBe(false); // â€¦and the one the early-out now uses
    expect(day.provisionalAccounts).toEqual(['admin', 'v0nni']);
    expect(s.fleetCapturedEtDays).toEqual(['2026-08-21']);
    expect(s.fleetSealedEtDays).toEqual([]);
  });

  it('names WHICH book is provisional â€” one sealed, one prefix, never one folded verdict (AC5)', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: POST_CLOSE,
      accountEnv: 'production', account: 'admin',
    });
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: MID_SESSION,
      accountEnv: 'production', account: 'v0nni',
    });
    const s = summarizeBrokerOrderCaptures(KNOWN_);
    const day = s.days.find(d => d.etDay === '2026-08-21')!;
    expect(day.fleetCaptured).toBe(true);
    expect(day.fleetSealed).toBe(false);
    // The named half. A count could not tell this from "nobody captured".
    expect(day.provisionalAccounts).toEqual(['v0nni']);
    expect(s.accounts.find(a => a.account === 'v0nni')!.provisionalEtDays).toEqual(['2026-08-21']);
    expect(s.accounts.find(a => a.account === 'admin')!.provisionalEtDays).toEqual([]);
  });

  it('a sealed read supersedes a pre-close one, but a later BLIND retry still cannot un-capture', () => {
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: MID_SESSION,
      accountEnv: 'production', account: 'admin',
    });
    const blind = captureBrokerOrderDay({
      etDay: '2026-08-21', orders: null, error: 'HTTP 401', capturedAt: POST_CLOSE,
      accountEnv: 'production', account: 'admin',
    });
    expect(blind.written).toBe(true);
    const day = summarizeBrokerOrderCaptures(KNOWN_).days.find(d => d.etDay === '2026-08-21')!;
    expect(day.captured).toBe(true); // the successful prefix still stands
    expect(day.orders).toBe(1);
    expect(day.provisional).toBe(true); // â€¦and the day is still owed a sealed read
    expect(day.lastError).toBe('HTTP 401');
  });

  it('attestation folds by UNION across attempts â€” a post-restart re-read cannot retract `full`', () => {
    // The superseding read is chosen for ORDER COUNTS. Attestation is a claim about
    // the recorder's residency, which a full-session line already proved; a later
    // capture taken after a mid-day restart is `partial` and must not downgrade it.
    armEngineSubmitRecorder({ bootedAt: BOOT_BEFORE_OPEN });
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order()], capturedAt: MID_SESSION,
      accountEnv: 'production', account: 'admin',
    });
    armEngineSubmitRecorder({ bootedAt: Date.parse('2026-08-21T18:00:00.000Z') }); // rebooted mid-session
    captureBrokerOrderDay({
      etDay: '2026-08-21', orders: [order(), order({ id: 2 })], capturedAt: POST_CLOSE,
      accountEnv: 'production', account: 'admin',
    });
    const day = summarizeBrokerOrderCaptures(KNOWN_).days.find(d => d.etDay === '2026-08-21')!;
    expect(day.orders).toBe(2); // superseded
    expect(day.attestation).toBe('full'); // but not retracted
  });
});

