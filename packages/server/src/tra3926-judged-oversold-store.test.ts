// TRA-3926 (2026-09-04) — THE DURABLE CARRIER FOR JUDGED EXCESS CLOSES.
//
// The detector re-derives from a 30-day tape, so its findings evaporate with
// their evidence: QQQ260911P00545000 (the 2026-08-05 event) crossed the horizon
// on 2026-09-03 and degraded from a full finding to a `no_open_record` blind on
// identical detector bytes; XLF — the fired 2026-08-21 real-money event this
// ticket exists for — follows ~2026-09-19. The store captures judgements at
// serve time and keeps them past the horizon.
//
// Every capture in this file is fed the REAL detector's output on ledger-shaped
// records — never a hand-built census — because a durable carrier written from
// a spy diverges from the alarm it exists to preserve (TRA-3730).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectOversoldEngineCloses } from './tra3926-oversold-close-detector.js';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import {
  captureJudgedOversoldCloses,
  judgedOversoldLogPath,
  readJudgedOversold,
  setJudgedOversoldDataDir,
  summarizeJudgedOversoldCloses,
} from './tra3926-judged-oversold-store.js';

const XLF = 'XLF260925C00057500';
const OPENED_AT = Date.parse('2026-08-20T13:35:30Z');
const DESK_AT = Date.parse('2026-08-20T17:00:00Z');
const CLOSED_AT = Date.parse('2026-08-21T13:48:04Z');

function ledgerRow(over: Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: OPENED_AT,
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    book: null,
    optionSymbol: XLF,
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: 1.08,
    fees: null,
    feeSource: null,
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: 142603071,
    origin: 'fill',
    ...over,
  };
}

/** The 2026-08-21 tape, verbatim — the fired event. */
const THE_EVENT: LiveOptionFillRecord[] = [
  ledgerRow({}),
  ledgerRow({ ts: DESK_AT, contracts: 1, filledPrice: 0.85, orderId: null, origin: 'history_import', sleeve: 'unattributed' }),
  ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 2, filledPrice: 1.01, orderId: 142806015 }),
];

/** The SAME event with the close carrying a chokepoint grant stamp. */
const THE_EVENT_GRANTED: LiveOptionFillRecord[] = [
  THE_EVENT[0]!,
  THE_EVENT[1]!,
  { ...THE_EVENT[2]!, exitGrant: 'desk_add' },
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra3926-judged-'));
  setJudgedOversoldDataDir(dir);
});

afterEach(() => {
  setJudgedOversoldDataDir(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-3926 — judged-oversold durable capture', () => {
  it('captures the served finding, keyed and legible', () => {
    const census = detectOversoldEngineCloses(THE_EVENT);
    expect(census.status).toBe('oversold'); // precondition, not the subject
    const capture = captureJudgedOversoldCloses(census, CLOSED_AT + 60_000);
    expect(capture).toEqual({ appended: 1, unchanged: 0, appendErrors: 0 });
    const summary = summarizeJudgedOversoldCloses(census);
    expect(summary.closes).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      optionSymbol: XLF,
      orderId: 142806015,
      ts: CLOSED_AT,
      judgement: 'finding',
      grant: null,
      soldContracts: 2,
      engineOpenContracts: 1,
      excessContracts: 1,
      attempts: 1,
      onLiveTape: true,
    });
  });

  it('is idempotent on content: re-serving the same judgement appends nothing', () => {
    const census = detectOversoldEngineCloses(THE_EVENT);
    captureJudgedOversoldCloses(census, CLOSED_AT + 60_000);
    const second = captureJudgedOversoldCloses(census, CLOSED_AT + 120_000);
    expect(second).toEqual({ appended: 0, unchanged: 1, appendErrors: 0 });
    expect(readJudgedOversold()).toHaveLength(1);
  });

  it('a CHANGED judgement is appended as history, not overwritten — the RIG shape', () => {
    // RIG 143384264 for real: ACCUSED on `092d0877`, GRANTED via the anchor on
    // `328d9659`. The store must show both statements and fold to the latest.
    captureJudgedOversoldCloses(detectOversoldEngineCloses(THE_EVENT), CLOSED_AT + 60_000);
    const granted = detectOversoldEngineCloses(THE_EVENT_GRANTED);
    expect(granted.grantedCloses).toHaveLength(1); // precondition
    const capture = captureJudgedOversoldCloses(granted, CLOSED_AT + 120_000);
    expect(capture).toEqual({ appended: 1, unchanged: 0, appendErrors: 0 });
    const summary = summarizeJudgedOversoldCloses(granted);
    expect(summary.lines).toBe(2);
    expect(summary.closes).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      judgement: 'granted',
      grant: 'desk_add',
      grantSource: 'record',
      attempts: 2,
      firstJudgedAt: CLOSED_AT + 60_000,
      lastJudgedAt: CLOSED_AT + 120_000,
    });
  });

  it('testimony SURVIVES the tape horizon, and says it is no longer corroborated', () => {
    // The evaporation this store exists for: capture while the evidence is
    // live, then summarize against the census an aged-out tape produces.
    captureJudgedOversoldCloses(detectOversoldEngineCloses(THE_EVENT), CLOSED_AT + 60_000);
    const agedOut = detectOversoldEngineCloses([]);
    expect(agedOut.status).toBe('vacuous'); // precondition
    const summary = summarizeJudgedOversoldCloses(agedOut);
    expect(summary.closes).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      optionSymbol: XLF,
      judgement: 'finding',
      onLiveTape: false,
    });
  });

  it('cannot manufacture testimony: a clean or vacuous census writes nothing', () => {
    // A store that grows on a quiet tape is a fabricated-alarm door — the dual
    // of the deleted alarm (TRA-3881).
    const clean = detectOversoldEngineCloses([
      ledgerRow({}),
      ledgerRow({ ts: OPENED_AT + 1_000, contracts: 1, filledPrice: 0.85, orderId: 142603072 }),
      ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 2, filledPrice: 1.01, orderId: 142806015 }),
    ]);
    expect(clean.status).toBe('clean'); // precondition
    expect(captureJudgedOversoldCloses(clean)).toEqual({ appended: 0, unchanged: 0, appendErrors: 0 });
    expect(captureJudgedOversoldCloses(detectOversoldEngineCloses([]))).toEqual({
      appended: 0,
      unchanged: 0,
      appendErrors: 0,
    });
    expect(readJudgedOversold()).toEqual([]);
  });

  it('a BLIND close is not captured — an unanswered question is not testimony', () => {
    const blind = detectOversoldEngineCloses([
      ledgerRow({ ts: DESK_AT, contracts: 4, filledPrice: 0.85, orderId: null, origin: 'history_import', sleeve: 'unattributed' }),
      ledgerRow({ ts: CLOSED_AT, etDay: '2026-08-21', side: 'sell_to_close', contracts: 4, filledPrice: 1.01, orderId: 142806015 }),
    ]);
    expect(blind.blindCloses).toHaveLength(1); // precondition
    expect(captureJudgedOversoldCloses(blind)).toEqual({ appended: 0, unchanged: 0, appendErrors: 0 });
  });

  it('with no DATA_DIR the capture is a counted no-op and the summary says EPHEMERAL', () => {
    setJudgedOversoldDataDir(null);
    const census = detectOversoldEngineCloses(THE_EVENT);
    expect(captureJudgedOversoldCloses(census)).toEqual({ appended: 0, unchanged: 0, appendErrors: 0 });
    const summary = summarizeJudgedOversoldCloses(census);
    expect(summary).toMatchObject({ dataDir: null, ephemeral: true, closes: 0 });
  });

  it('survives a corrupt line without folding it into a clean answer', () => {
    const census = detectOversoldEngineCloses(THE_EVENT);
    captureJudgedOversoldCloses(census, CLOSED_AT + 60_000);
    const path = judgedOversoldLogPath(dir);
    const withGarbage = readFileSync(path, 'utf8') + '{not json\n';
    writeFileSync(path, withGarbage, 'utf8');
    const summary = summarizeJudgedOversoldCloses(census);
    expect(summary.closes).toBe(1);
    expect(summary.rows[0]!.judgement).toBe('finding');
  });
});
