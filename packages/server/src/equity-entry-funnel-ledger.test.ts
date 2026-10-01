// TRA-4998 defect A — durable per-ET-day equity entry funnel ledger.
//
// The thing under test is a DISCRIMINATOR, so most of these cases are negative
// controls: for every state the ledger is supposed to name, there is a sibling
// assertion that the state it must NOT be confused with produces a different
// answer. A `zeroedAtStage` that returned the same string for "market was shut" and
// "every candidate was rejected" would pass a happy-path suite and be worthless.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearEquityEntryFunnelLedger,
  equityFunnelLogPath,
  flushEquityEntryFunnelLedger,
  hydrateEquityEntryFunnelFromDisk,
  ledgerRecordAdmitted,
  ledgerRecordCandidate,
  ledgerRecordPassGated,
  ledgerRecordPassIterated,
  ledgerRecordRejected,
  ledgerRecordSymbolEvaluated,
  ledgerRecordSymbolSkipped,
  summarizeEquityEntryFunnelLedger,
} from './equity-entry-funnel-ledger.js';

/**
 * A fixed instant inside RTH on 2026-09-30 — the ET day whose `admitted: 0` cell
 * TRA-4971 could not explain. 2026-09-30T17:00:00Z is 13:00 ET (EDT, UTC-4).
 */
const T = Date.parse('2026-09-30T17:00:00Z');
const ET_DAY = '2026-09-30';
/** Next ET day, same clock time — 2026-10-01 13:00 ET. */
const T_NEXT = Date.parse('2026-10-01T17:00:00Z');

function dayRow(mode: 'demo' | 'live' = 'demo', etDay = ET_DAY) {
  const s = summarizeEquityEntryFunnelLedger();
  return s.byEtDay.find((d) => d.etDay === etDay && d.mode === mode);
}

describe('equity-entry-funnel-ledger — per-ET-day fold', () => {
  beforeEach(() => clearEquityEntryFunnelLedger());

  it('starts with no days at all — an absent day is UNRECORDED, not a row of zeroes', () => {
    const s = summarizeEquityEntryFunnelLedger();
    expect(s.byEtDay).toEqual([]);
    expect(s.etDays).toEqual([]);
    // The whole point of the ticket: a reader must be able to tell "this ledger has
    // nothing for that day" from "that day genuinely admitted nothing".
    expect(dayRow()).toBeUndefined();
  });

  it('buckets by the ET calendar day of the event, not the UTC day', () => {
    // 2026-10-01T02:00:00Z is 2026-09-30 22:00 ET — still the PREVIOUS ET day. The
    // TRA-594 bug (bucketing on the UTC date) would file this under 10-01 and quietly
    // move every post-close event into the next session.
    ledgerRecordPassIterated('demo', 'e1', 21, Date.parse('2026-10-01T02:00:00Z'));
    expect(summarizeEquityEntryFunnelLedger().etDays).toEqual(['2026-09-30']);
  });

  it('the ET-day memo is exact across the midnight boundary', () => {
    // `etDayOf` caches per whole minute. The boundary is the only place a stale cache
    // could file an event under the wrong day, so cross it in both directions within
    // adjacent minutes. 2026-10-01T03:59Z = 09-30 23:59 ET; 04:00Z = 10-01 00:00 ET.
    ledgerRecordPassIterated('demo', 'e1', 1, Date.parse('2026-10-01T03:59:30Z'));
    ledgerRecordPassIterated('demo', 'e1', 1, Date.parse('2026-10-01T04:00:30Z'));
    expect(summarizeEquityEntryFunnelLedger().etDays).toEqual(['2026-09-30', '2026-10-01']);
    expect(dayRow('demo', '2026-09-30')!.passesFired).toBe(1);
    expect(dayRow('demo', '2026-10-01')!.passesFired).toBe(1);
  });

  it('never pools demo and live into one row', () => {
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    ledgerRecordSymbolEvaluated('demo', 'e1', T);
    ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
    ledgerRecordAdmitted('demo', 'e1', T);

    ledgerRecordPassIterated('live', 'L1', 21, T);
    ledgerRecordSymbolEvaluated('live', 'L1', T);

    const demo = dayRow('demo')!;
    const live = dayRow('live')!;
    expect(demo.admitted).toBe(1);
    // A live sleeve that admits nothing holds no risk; summing it into the busy demo
    // book is exactly what would hide that.
    expect(live.admitted).toBe(0);
    expect(live.zeroedAtStage).toBe('no_candidates');
    expect(demo.zeroedAtStage).toBeNull();
  });

  it('pools engines within a mode but keeps a per-engine row beside it', () => {
    // e1 is healthy, e2 is dead. The pooled row ADMITS, so the day is not zeroed —
    // and the dead engine must still be visible, or a single broken engine on an
    // otherwise-working day is invisible.
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    ledgerRecordSymbolEvaluated('demo', 'e1', T);
    ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
    ledgerRecordAdmitted('demo', 'e1', T);
    ledgerRecordPassGated('demo', 'e2', 'market_closed', null, T);

    const d = dayRow()!;
    expect(d.admitted).toBe(1);
    expect(d.zeroedAtStage).toBeNull();
    expect(d.byEngine.map((e) => e.engineId)).toEqual(['e1', 'e2']);
    expect(d.byEngine.find((e) => e.engineId === 'e2')!.zeroedAtStage).toBe('all_passes_gated');
    expect(d.byEngine.find((e) => e.engineId === 'e1')!.zeroedAtStage).toBeNull();
  });
});

describe('equity-entry-funnel-ledger — zeroedAtStage names the stage and the count', () => {
  beforeEach(() => clearEquityEntryFunnelLedger());

  it('no_passes: the engine never reached the equity path', () => {
    // Only a candidate from the daily SMA-200 router, no deterministic pass at all.
    // `passesFired === 0` must NOT read as a strategy verdict.
    ledgerRecordPassGated('live', 'other', 'market_closed', null, T);
    const d = dayRow('live')!;
    expect(d.zeroedAtStage).toBe('all_passes_gated');

    clearEquityEntryFunnelLedger();
    ledgerRecordRejected('demo', 'e1', 'swing_universe', T);
    const d2 = dayRow()!;
    expect(d2.passesFired).toBe(0);
    expect(d2.zeroedAtStage).toBe('no_passes');
    expect(d2.zeroedCount).toBe(0);
  });

  it('all_passes_gated: names the gate that held every pass, with its count', () => {
    for (let i = 0; i < 27; i += 1) {
      ledgerRecordPassGated('demo', 'e1', 'market_closed', null, T + i * 1000);
    }
    ledgerRecordPassGated('demo', 'e1', 'risk_halted', null, T + 99_000);

    const d = dayRow()!;
    expect(d.passesFired).toBe(28);
    expect(d.passesIterated).toBe(0);
    expect(d.zeroedAtStage).toBe('all_passes_gated');
    expect(d.zeroedCount).toBe(28);
    // The DOMINANT gate, named — not just "something gated it".
    expect(d.zeroedDetail).toEqual({ reason: 'market_closed', count: 27 });
    expect(d.gatedByReason).toEqual({ market_closed: 27, risk_halted: 1 });
  });

  it('records the live-engine sub-cause of strategies_inactive_on_tick, and only for it', () => {
    ledgerRecordPassGated('live', 'L2', 'strategies_inactive_on_tick', 'live_equity_client_missing', T);
    // A stray detail on a DIFFERENT reason must be dropped, never persisted — the two
    // fields can then never disagree on the wire.
    ledgerRecordPassGated('live', 'L2', 'market_closed', 'live_equity_toggle_off', T + 1000);

    const d = dayRow('live')!;
    expect(d.gatedByDetail).toEqual({ live_equity_client_missing: 1 });
  });

  it('no_symbols_evaluated is a DATA verdict, and does not collide with no_candidates', () => {
    // The pass iterated a 21-name universe and every name was skipped before any
    // strategy ran. Indicting the strategy here would be the TRA-1793 false zero.
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    for (let i = 0; i < 18; i += 1) ledgerRecordSymbolSkipped('demo', 'e1', 'stale_feed', T);
    for (let i = 0; i < 3; i += 1) ledgerRecordSymbolSkipped('demo', 'e1', 'insufficient_candles', T);

    const d = dayRow()!;
    expect(d.symbolsEvaluated).toBe(0);
    expect(d.zeroedAtStage).toBe('no_symbols_evaluated');
    expect(d.zeroedCount).toBe(21); // the universe that was swept and lost
    expect(d.zeroedDetail).toEqual({ reason: 'stale_feed', count: 18 });
  });

  it('no_candidates is the STRATEGY verdict — strategies ran on real symbols and were dry', () => {
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    for (let i = 0; i < 19; i += 1) ledgerRecordSymbolEvaluated('demo', 'e1', T);
    ledgerRecordSymbolSkipped('demo', 'e1', 'stale_feed', T);

    const d = dayRow()!;
    expect(d.candidates).toBe(0);
    expect(d.zeroedAtStage).toBe('no_candidates');
    // The count is the symbols that DID reach a strategy — the denominator that makes
    // "dry" a real finding rather than an artifact of an empty sweep.
    expect(d.zeroedCount).toBe(19);
  });

  it('all_candidates_rejected is the CALIBRATION verdict and names the eater', () => {
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    for (let i = 0; i < 21; i += 1) ledgerRecordSymbolEvaluated('demo', 'e1', T);
    for (let i = 0; i < 9; i += 1) {
      ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
      ledgerRecordRejected('demo', 'e1', 'churn_brake', T);
    }
    ledgerRecordCandidate('demo', 'e1', 'sma200-pullback', T);
    ledgerRecordRejected('demo', 'e1', 'sizing_returned_no_position', T);

    const d = dayRow()!;
    expect(d.candidates).toBe(10);
    expect(d.admitted).toBe(0);
    expect(d.zeroedAtStage).toBe('all_candidates_rejected');
    expect(d.zeroedCount).toBe(10);
    expect(d.zeroedDetail).toEqual({ reason: 'churn_brake', count: 9 });
    expect(d.candidatesBySource).toEqual({ deterministic: 9, 'sma200-pullback': 1 });
  });

  it('a single admit clears the verdict — zeroedAtStage is null, not a stage', () => {
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    ledgerRecordSymbolEvaluated('demo', 'e1', T);
    for (let i = 0; i < 40; i += 1) {
      ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
      ledgerRecordRejected('demo', 'e1', 'swing_universe', T);
    }
    ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
    ledgerRecordAdmitted('demo', 'e1', T);

    const d = dayRow()!;
    expect(d.admitted).toBe(1);
    // 40 rejections is a busy day, not a zeroed one. The verdict is about the ZERO.
    expect(d.zeroedAtStage).toBeNull();
    expect(d.zeroedCount).toBeNull();
    expect(d.zeroedDetail).toBeNull();
  });

  it('classifies in funnel order — an earlier blocking stage wins', () => {
    // Every pass gated AND (impossibly, but defensively) some rejects recorded. The
    // gate is the actionable fact; reporting `all_candidates_rejected` would send a
    // reader to tune a guardrail that never ran.
    ledgerRecordPassGated('demo', 'e1', 'market_closed', null, T);
    ledgerRecordCandidate('demo', 'e1', 'sma200-pullback', T);
    ledgerRecordRejected('demo', 'e1', 'market_closed' as never, T);
    expect(dayRow()!.zeroedAtStage).toBe('all_passes_gated');
  });
});

describe('equity-entry-funnel-ledger — durability', () => {
  let dir: string;

  beforeEach(() => {
    clearEquityEntryFunnelLedger();
    dir = mkdtempSync(join(tmpdir(), 'tra4998-funnel-'));
  });
  afterEach(() => {
    clearEquityEntryFunnelLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives a reboot — the defect this ticket exists to fix', () => {
    hydrateEquityEntryFunnelFromDisk(dir, T);
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    for (let i = 0; i < 21; i += 1) ledgerRecordSymbolEvaluated('demo', 'e1', T);
    for (let i = 0; i < 5; i += 1) {
      ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
      ledgerRecordRejected('demo', 'e1', 'churn_brake', T);
    }
    flushEquityEntryFunnelLedger(T);

    // The reboot: every in-memory counter is gone, exactly as it is on bqb1 ~6x/day.
    clearEquityEntryFunnelLedger();
    expect(summarizeEquityEntryFunnelLedger().byEtDay).toEqual([]);

    const h = hydrateEquityEntryFunnelFromDisk(dir, T + 60_000);
    expect(h.days).toBe(1);
    const d = dayRow()!;
    expect(d.candidates).toBe(5);
    expect(d.symbolsEvaluated).toBe(21);
    expect(d.zeroedAtStage).toBe('all_candidates_rejected');
    expect(d.zeroedDetail).toEqual({ reason: 'churn_brake', count: 5 });
    // Durability PROVENANCE, not just a non-empty fold: a `retained` block populated
    // by this uptime's own events reads identically to a hydrated one (TRA-1681).
    expect(summarizeEquityEntryFunnelLedger().durability.hydratedRecords).toBeGreaterThan(0);
  });

  it('hydrates LAST-WINS per (etDay, mode, engine) — snapshots supersede, never sum', () => {
    const path = equityFunnelLogPath(dir);
    const base = { etDay: ET_DAY, mode: 'demo', engineId: 'e1' };
    writeFileSync(
      path,
      [
        JSON.stringify({ ...base, ts: T, passesFired: 1, passesIterated: 1, candidates: 2, admitted: 0 }),
        JSON.stringify({ ...base, ts: T + 1000, passesFired: 9, passesIterated: 9, candidates: 7, admitted: 1 }),
      ].join('\n') + '\n',
      'utf8',
    );
    hydrateEquityEntryFunnelFromDisk(dir, T + 2000);
    const d = dayRow()!;
    // 7, not 9: the later snapshot REPLACES the earlier. Summing cumulative snapshots
    // is the failure mode this encoding exists to make impossible.
    expect(d.candidates).toBe(7);
    expect(d.passesFired).toBe(9);
    expect(d.admitted).toBe(1);
  });

  it('orders last-wins by ts, so a reordered file cannot resurrect an older snapshot', () => {
    const path = equityFunnelLogPath(dir);
    const base = { etDay: ET_DAY, mode: 'demo', engineId: 'e1' };
    writeFileSync(
      path,
      [
        JSON.stringify({ ...base, ts: T + 5000, candidates: 50 }),
        JSON.stringify({ ...base, ts: T + 1000, candidates: 3 }), // older, written later
      ].join('\n') + '\n',
      'utf8',
    );
    hydrateEquityEntryFunnelFromDisk(dir, T + 9000);
    expect(dayRow()!.candidates).toBe(50);
  });

  it('drops records outside the retention window and compacts the file', () => {
    const path = equityFunnelLogPath(dir);
    const old = T - 40 * 24 * 60 * 60 * 1000; // 40 days back — outside the 30-day window
    writeFileSync(
      path,
      [
        JSON.stringify({ etDay: '2026-08-21', mode: 'demo', engineId: 'e1', ts: old, candidates: 999 }),
        JSON.stringify({ etDay: ET_DAY, mode: 'demo', engineId: 'e1', ts: T, candidates: 4 }),
      ].join('\n') + '\n',
      'utf8',
    );
    hydrateEquityEntryFunnelFromDisk(dir, T);
    expect(summarizeEquityEntryFunnelLedger().etDays).toEqual([ET_DAY]);
    // Compacted on disk, not merely filtered in memory.
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).etDay).toBe(ET_DAY);
  });

  it('skips torn and malformed lines rather than throwing', () => {
    const path = equityFunnelLogPath(dir);
    writeFileSync(
      path,
      [
        '{"not json',
        JSON.stringify({ etDay: ET_DAY, mode: 'nonsense', engineId: 'e1', ts: T, candidates: 5 }),
        JSON.stringify({ etDay: '', mode: 'demo', engineId: 'e1', ts: T, candidates: 5 }),
        JSON.stringify({ etDay: ET_DAY, mode: 'demo', engineId: 'e1', ts: T, candidates: 6 }),
      ].join('\n') + '\n',
      'utf8',
    );
    expect(() => hydrateEquityEntryFunnelFromDisk(dir, T)).not.toThrow();
    expect(dayRow()!.candidates).toBe(6);
  });

  it('keeps a reason bucket this build does not recognise', () => {
    // A rolled-back binary must not silently restate a retained day as cleaner than
    // it was by dropping a forward-written reason out of the totals.
    const path = equityFunnelLogPath(dir);
    writeFileSync(
      path,
      JSON.stringify({
        etDay: ET_DAY, mode: 'demo', engineId: 'e1', ts: T,
        passesFired: 1, passesIterated: 1, symbolsEvaluated: 3, candidates: 2,
        rejectedByReason: { some_future_guardrail: 2 },
      }) + '\n',
      'utf8',
    );
    hydrateEquityEntryFunnelFromDisk(dir, T);
    const d = dayRow()!;
    expect(d.zeroedAtStage).toBe('all_candidates_rejected');
    expect(d.zeroedDetail).toEqual({ reason: 'some_future_guardrail', count: 2 });
  });

  it('force-flushes the previous ET day when the day rolls', () => {
    hydrateEquityEntryFunnelFromDisk(dir, T);
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    ledgerRecordSymbolEvaluated('demo', 'e1', T);
    // No explicit flush: the debounce would normally hold these. Touching the NEXT ET
    // day must push the closing session to disk — the end of the day is precisely what
    // a post-close review reads, and after the close no later tick comes to flush it.
    ledgerRecordPassIterated('demo', 'e1', 21, T_NEXT);

    clearEquityEntryFunnelLedger();
    hydrateEquityEntryFunnelFromDisk(dir, T_NEXT);
    const prior = dayRow('demo', ET_DAY);
    expect(prior).toBeDefined();
    expect(prior!.symbolsEvaluated).toBe(1);
  });

  it('flushes an admit immediately, without waiting out the debounce', () => {
    hydrateEquityEntryFunnelFromDisk(dir, T);
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    ledgerRecordCandidate('demo', 'e1', 'deterministic', T);
    ledgerRecordAdmitted('demo', 'e1', T);
    // No flushEquityEntryFunnelLedger() call. An admit is rare and load-bearing: losing
    // one to the debounce would flip the day's verdict to a named zero stage.
    clearEquityEntryFunnelLedger();
    hydrateEquityEntryFunnelFromDisk(dir, T + 1000);
    expect(dayRow()!.admitted).toBe(1);
    expect(dayRow()!.zeroedAtStage).toBeNull();
  });

  it('reports memory-only as ephemeral with a null dataDir', () => {
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    const dur = summarizeEquityEntryFunnelLedger().durability;
    expect(dur.dataDir).toBeNull();
    expect(dur.ephemeral).toBe(true);
    expect(dur.hydratedRecords).toBe(0);
    // The counters still work in memory — there is just nothing durable, and the
    // block says so rather than looking like a healthy retained read.
    expect(dayRow()!.passesFired).toBe(1);
  });

  it('writes nothing when no dir is configured and does not throw', () => {
    ledgerRecordPassIterated('demo', 'e1', 21, T);
    flushEquityEntryFunnelLedger(T);
    expect(existsSync(equityFunnelLogPath(dir))).toBe(false);
  });
});
