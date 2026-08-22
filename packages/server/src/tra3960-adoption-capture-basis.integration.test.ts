import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaperOptionsAccount } from './options-account.js';
import {
  recordLiveOptionFill,
  clearLiveOptionsFeeSlippageLedger,
} from './live-options-fee-slippage-ledger.js';
import {
  __resetOrderProvenanceCaptureForTest,
  armEngineSubmitRecorder,
  captureBrokerOrderDay,
  recordEngineOrderSubmit,
  setOrderProvenanceCaptureDataDir,
  summarizeEngineSubmitWitness,
} from './tra3939-order-provenance-capture.js';
import type { OptionPosition } from '@trading-app/shared';
import type { TradierAccountOrder, TradierOpenOptionPosition } from '@trading-app/engine';

// TRA-3960 — the capture store wired in as the adoption basis source, driven
// END-TO-END through `reconcileTradierPositions` with a REAL capture file on
// disk (the TRA-3939 writer, not a mock), so the seam this ticket is about —
// planner ← `capturedBrokerOrders()` / `summarizeEngineSubmitWitness()` — is the
// thing under test.
//
// Live shape: BAC 260925C63, engine 1 ct @ 1.65 (order 142603649), desk added
// 1 ct @ 1.17 (order 142769192) on 2026-08-20. Broker reports 2 ct / $282.

const BAC = 'BAC260925C00063000';
const NOW = Date.parse('2026-08-20T23:38:00Z');
const OPENED = Date.parse('2026-08-20T13:37:00Z');
const DESK_FILL_AT = '2026-08-20T19:36:00.000Z';
const ENGINE_ORDER = 142603649;
const DESK_ORDER = 142769192;

let dir: string;

function bacBroker(premiumPaid: number, contracts = 2): TradierOpenOptionPosition {
  return { underlying: 'BAC', optionType: 'call', strike: 63, expiration: '2026-09-25', contracts, premiumPaid, acquiredAt: OPENED, optionSymbol: BAC };
}

function captured(over: Partial<TradierAccountOrder> = {}): TradierAccountOrder {
  return {
    id: DESK_ORDER, status: 'filled', orderClass: 'option', side: 'buy_to_open', symbol: 'BAC',
    optionSymbol: BAC, quantity: 1, execQuantity: 1, avgFillPrice: 1.17,
    createDate: DESK_FILL_AT, transactionDate: DESK_FILL_AT, tag: null, ...over,
  };
}

function engineRow(): OptionPosition {
  return {
    id: 'bac-engine', symbol: 'BAC', optionSymbol: BAC, optionType: 'call', strike: 63, expiration: '2026-09-25',
    contracts: 1, contractsRemaining: 1, premiumPaid: 1.65, currentPremium: 1.08, tp1Premium: 2.475, tp1Hit: false,
    stopLossPremium: 1.32, peakPremium: 1.65, trailingActive: false, trailingStopPremium: 1.98,
    underlyingEntryPrice: 63, openedAt: OPENED, signalId: 'sig-bac', signalType: 'otm_mispricing', mode: 'live', tradierEnv: 'production',
  } as OptionPosition;
}

function freshAccount(): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
  acct.importSnapshot({ openOptions: [engineRow()], closedOptions: [], optionsPnl: 0, dailyCount: 0, currentDayKey: '2026-08-20', cash: 1_035.94, equity: 1_035.94 });
  return acct;
}

/** Arm the recorder BEFORE the 08-20 open so the day attests `full`, then capture. */
function seedCapture(orders: TradierAccountOrder[], opts: { bootBeforeOpen?: boolean } = {}): void {
  const boot = opts.bootBeforeOpen === false
    ? Date.parse('2026-08-20T15:00:00Z') // 11:00 ET — mid-session ⇒ `partial`
    : Date.parse('2026-08-20T11:00:00Z'); // 07:00 ET — pre-open ⇒ `full`
  armEngineSubmitRecorder({ bootedAt: boot, commit: 'test' });
  recordEngineOrderSubmit({
    orderId: ENGINE_ORDER, ackStatus: 'ok', env: 'production', accountId: 'acct', orderClass: 'option',
    side: 'buy_to_open', symbol: 'BAC', optionSymbol: BAC, quantity: 1, limitPrice: 1.65, submittedAt: OPENED,
  });
  const res = captureBrokerOrderDay({ etDay: '2026-08-20', orders, capturedAt: NOW - 60_000, accountEnv: 'production' });
  expect(res.written).toBe(true);
}

function deskRow(acct: PaperOptionsAccount): OptionPosition {
  const row = acct.getState().openOptions.find(o => o.optionSymbol === BAC && o.adoptionAuthority === 'desk_add');
  expect(row).toBeDefined();
  return row!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), 'tra3960-'));
  __resetOrderProvenanceCaptureForTest();
  setOrderProvenanceCaptureDataDir(dir);
  clearLiveOptionsFeeSlippageLedger();
  recordLiveOptionFill({
    ts: OPENED, etDay: '2026-08-20', sleeve: 'single_leg_otm', optionSymbol: BAC,
    side: 'buy_to_open', contracts: 1, submittedLimit: 1.65, askAtSubmit: 1.65,
    midAtSubmit: 1.63, filledPrice: 1.65, fees: null, orderId: ENGINE_ORDER,
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearLiveOptionsFeeSlippageLedger();
  __resetOrderProvenanceCaptureForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-3960 — adoption reads the TRA-3939 capture store as its basis source', () => {
  it('prices the desk lot off the captured fill BY ORDER ID, stamps the row, counts it, and writes the durable line', () => {
    // Both orders of the day are in the capture — the engine's and the desk's —
    // and they are the SAME SHAPE. The engine's is excluded by id.
    seedCapture([
      captured({ id: ENGINE_ORDER, avgFillPrice: 1.65, createDate: new Date(OPENED).toISOString() }),
      captured(),
    ]);
    expect(summarizeEngineSubmitWitness().coveredEtDays).toEqual(['2026-08-20']);

    const acct = freshAccount();
    // Broker blend DRIFTED from the exact residual: 2 ct @ 1.425 ⇒ residual 1.20.
    // The capture says the desk paid 1.17. The order id wins over the arithmetic.
    acct.reconcileTradierPositions([bacBroker(1.425)], 'live');

    const desk = deskRow(acct);
    expect(desk.premiumPaid).toBeCloseTo(1.17, 10);
    expect(desk.stopLossPremium).toBeCloseTo(0.936, 10);
    expect(desk.deskAddBasis).toMatchObject({ source: 'capture_fill', orderIds: [DESK_ORDER] });
    expect(desk.deskAddBasis!.residualPremiumPaid).toBeCloseTo(1.2, 10);

    const report = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.mintedTotal).toBe(1);
    expect(report.mintedFromCaptureTotal).toBe(1);
    expect(report.mintedFromResidualTotal).toBe(0);
    expect(report.adopted[0]).toMatchObject({ basisSource: 'capture_fill', basisOrderIds: [DESK_ORDER] });

    // The durable line: source names the capture, provenance carries the id.
    const census = acct.getEngineBasisRestatementCensus();
    const line = census.restatements.find(r => r.source === 'desk_lot_mint_capture_fill');
    expect(line).toBeDefined();
    expect(line!.premiumPaidBefore).toBeCloseTo(1.425, 10); // the blend it would have worn
    expect(line!.premiumPaidAfter).toBeCloseTo(1.17, 10);
    expect(line!.provenance).toContain(String(DESK_ORDER));
    // …and it is counted in NONE of the sweep's counters: a mint moves nothing.
    expect(census.restated).toBe(0);
    expect(census.repaired).toBe(0);
    expect(census.operatorRestated).toBe(0);
  });

  it('the LIVE shape (mid-session boot ⇒ day `partial`) is still priced, and STAMPED partial', () => {
    seedCapture([captured()], { bootBeforeOpen: false });
    expect(summarizeEngineSubmitWitness().coveredEtDays).toEqual([]);
    expect(summarizeEngineSubmitWitness().uncoveredCapturedEtDays).toEqual(['2026-08-20']);

    const acct = freshAccount();
    acct.reconcileTradierPositions([bacBroker(1.425)], 'live');

    const desk = deskRow(acct);
    expect(desk.premiumPaid).toBeCloseTo(1.17, 10);
    expect(desk.deskAddBasis).toMatchObject({ source: 'capture_fill', orderIds: [DESK_ORDER], attestation: 'partial' });
    const report = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.adopted[0]!.basisAttestation).toBe('partial');
    const line = acct.getEngineBasisRestatementCensus().restatements.find(r => r.source === 'desk_lot_mint_capture_fill');
    expect(line!.provenance).toContain('witness partial');
  });

  it("NEGATIVE CONTROL — a desk round-trip from BEFORE the engine's episode does not price this one", () => {
    // The desk bought 1 ct last week (and sold it); the capture holds that buy.
    // The residual today is a different contract and must not wear last week's price.
    const lastWeek = '2026-08-13T15:00:00.000Z';
    seedCapture([captured({ id: 142700001, avgFillPrice: 0.99, createDate: lastWeek, transactionDate: lastWeek })]);

    const acct = freshAccount();
    acct.reconcileTradierPositions([bacBroker(1.41)], 'live');

    const desk = deskRow(acct);
    expect(desk.premiumPaid).toBeCloseTo(1.17, 10);
    expect(desk.deskAddBasis).toMatchObject({ source: 'residual_identity', orderIds: [] });
    const report = acct.liveLotAdoptionReport({ brokerMirroring: true });
    expect(report.mintedFromCaptureTotal).toBe(0);
    expect(report.mintedFromResidualTotal).toBe(1);
    const line = acct.getEngineBasisRestatementCensus().restatements.find(r => r.source === 'desk_lot_mint_residual');
    expect(line!.provenance).toContain('outside_episode');
  });

  it('NEGATIVE CONTROL — an UNCONFIGURED store reads capture_absent, not "consulted and empty"', () => {
    setOrderProvenanceCaptureDataDir(null);
    const acct = freshAccount();
    acct.reconcileTradierPositions([bacBroker(1.41)], 'live');
    const line = acct.getEngineBasisRestatementCensus().restatements.find(r => r.source === 'desk_lot_mint_residual');
    expect(line!.provenance).toContain('capture_absent');
  });

  it('the capture-sourced basis SURVIVES the 30s reconcile and a snapshot round-trip', () => {
    seedCapture([captured()]);
    const acct = freshAccount();
    acct.reconcileTradierPositions([bacBroker(1.41)], 'live');
    for (let i = 0; i < 5; i++) acct.reconcileTradierPositions([bacBroker(1.41)], 'live');
    expect(deskRow(acct).deskAddBasis!.source).toBe('capture_fill');

    const snap = acct.exportSnapshot();
    const again = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
    again.importSnapshot(snap);
    expect(deskRow(again).deskAddBasis).toMatchObject({ source: 'capture_fill', orderIds: [DESK_ORDER] });
    again.reconcileTradierPositions([bacBroker(1.41)], 'live');
    expect(again.getState().openOptions.filter(o => o.optionSymbol === BAC)).toHaveLength(2);
    expect(again.liveLotAdoptionReport({ brokerMirroring: true }).mintedTotal).toBe(0); // idempotent: re-derived, not re-minted
  });
});
