// TRA-4269 (TRA-4523) — the live name-universe gate RECORDS while unrestricted,
// and stamps each such row with what the board's ratified set would have done.
//
// Before this, `OPTION_LIVE_OTM_UNIVERSE=*` returned early and wrote nothing, so
// the board was asked to rule on restoring the allowlist with an entry-side tape
// of zero rows. These tests pin both halves of the contract:
//
//   • the ORDER PATH is unchanged: the method returns non-null only when
//     restricted AND off-list, exactly as before (a, b, c);
//   • the LEDGER now carries the unrestricted population with the
//     counterfactual on every row, publishes the zero rather than omitting it,
//     and round-trips through disk (a, b, d, e); demo records nothing (f).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveEnforceDecision,
  hydrateLiveEnforceGateFromDisk,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  liveEnforceGateLogPath,
} from './live-enforce-gate-ledger.js';
import {
  OPTION_LIVE_OTM_UNIVERSE_VAR,
  OPTION_LIVE_OTM_UNIVERSE_DEFAULT,
  liveOtmRatifiedSetCounterfactual,
} from './otm-live-universe-flag.js';
import { SignalEngine } from './signal-engine.js';

const RATIFIED = OPTION_LIVE_OTM_UNIVERSE_DEFAULT.join(',');
const COUNTERFACTUAL_KEYS = [
  'ratifiedSet',
  'counterfactualEvaluated',
  'wouldBlockUnderRatifiedSet',
  'counterfactualUnderOtherSet',
  'bySymbol',
] as const;

interface UniverseProbe {
  mode: 'demo' | 'live';
  alertUsername: string;
  liveOtmUniverseRejectReason: (symbol: string) => string | null;
}

/**
 * The method under test reads only `mode` and `alertUsername`, so a bare
 * prototype instance is enough, and it keeps the engine constructor's side
 * effects out of a test about one private method.
 */
function probe(mode: 'demo' | 'live', book = 'admin'): UniverseProbe {
  const engine = Object.create(SignalEngine.prototype) as UniverseProbe;
  engine.mode = mode;
  engine.alertUsername = book;
  return engine;
}

describe('TRA-4269 — the universe gate records while unrestricted, with the ratified-set counterfactual', () => {
  let dir: string;
  let savedUniverse: string | undefined;

  beforeEach(() => {
    savedUniverse = process.env[OPTION_LIVE_OTM_UNIVERSE_VAR];
    delete process.env[OPTION_LIVE_OTM_UNIVERSE_VAR];
    dir = mkdtempSync(join(tmpdir(), 'tra4269-'));
    clearLiveEnforceGateLedger();
    // Configures the append target, so every recorded row also reaches disk.
    hydrateLiveEnforceGateFromDisk(dir);
  });

  afterEach(() => {
    if (savedUniverse === undefined) delete process.env[OPTION_LIVE_OTM_UNIVERSE_VAR];
    else process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = savedUniverse;
    clearLiveEnforceGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  const diskRows = (): Record<string, unknown>[] => {
    const path = liveEnforceGateLogPath(dir);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const retainedUniverse = () =>
    summarizeLiveEnforceGate('1970-01-01').retained.byGate.find((g) => g.gate === 'universe')!;

  it('(a) `*` + an off-set name (TTD): returns null, records blocked:false, would-block TRUE', () => {
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = '*';

    expect(probe('live').liveOtmUniverseRejectReason('TTD')).toBeNull();

    const rows = diskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gate: 'universe',
      scope: 'TTD',
      blocked: false,
      book: 'admin',
      wouldBlockUnderRatifiedSet: true,
      ratifiedSet: RATIFIED,
    });
    // An admit carries no refusal: nothing was refused.
    expect(rows[0]).not.toHaveProperty('reason');
    expect(rows[0]).not.toHaveProperty('reasonCode');

    const u = retainedUniverse();
    expect(u).toMatchObject({
      evaluated: 1,
      blocked: 0,
      blockRate: 0,
      counterfactualEvaluated: 1,
      wouldBlockUnderRatifiedSet: 1,
      counterfactualUnderOtherSet: 0,
    });
    expect(u.bySymbol).toEqual([{ symbol: 'TTD', evaluated: 1, inRatifiedSet: false }]);
  });

  it('(b) `*` + an in-set name (AAPL): recorded and stamped would-block FALSE, explicitly', () => {
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = '*';
    const engine = probe('live');

    expect(engine.liveOtmUniverseRejectReason('AAPL')).toBeNull();
    const [aapl] = diskRows();
    // An explicit `false`, never an absent key. An absent key is what a
    // pre-field or restricted row looks like, and the two must not be the same bytes.
    expect(aapl).toHaveProperty('wouldBlockUnderRatifiedSet', false);
    expect(aapl).toHaveProperty('ratifiedSet', RATIFIED);
    expect(aapl.blocked).toBe(false);

    // N of M, in these names: two TTD entries off the set, one AAPL on it.
    expect(engine.liveOtmUniverseRejectReason('TTD')).toBeNull();
    expect(engine.liveOtmUniverseRejectReason('TTD')).toBeNull();
    const u = retainedUniverse();
    expect(u).toMatchObject({ evaluated: 3, blocked: 0, counterfactualEvaluated: 3, wouldBlockUnderRatifiedSet: 2 });
    expect(u.bySymbol).toEqual([
      { symbol: 'TTD', evaluated: 2, inRatifiedSet: false },
      { symbol: 'AAPL', evaluated: 1, inRatifiedSet: true },
    ]);
  });

  it('(c) restricted list: same return, same `blocked`, and NO counterfactual field', () => {
    // Default (unset) = the ratified five. The reason string is byte-for-byte
    // the pre-TRA-4269 one: the call site at `if (otmUniverseReject)` refuses
    // exactly what it refused before.
    const engine = probe('live');
    expect(engine.liveOtmUniverseRejectReason('TTD')).toBe(
      'live OTM universe (TRA-3216): TTD is not on the live underlying allowlist '
        + '[AAPL,SPY,QQQ,PLTR,TSLA] (source default)',
    );
    expect(engine.liveOtmUniverseRejectReason('AAPL')).toBeNull();

    // An operator list: KVYO admitted, TTD refused against THAT list.
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = 'kvyo, IWM';
    expect(engine.liveOtmUniverseRejectReason('KVYO')).toBeNull();
    expect(engine.liveOtmUniverseRejectReason('TTD')).toBe(
      'live OTM universe (TRA-3216): TTD is not on the live underlying allowlist [KVYO,IWM] (source env)',
    );

    const rows = diskRows();
    expect(rows.map((r) => [r.scope, r.blocked, r.reasonCode ?? null])).toEqual([
      ['TTD', true, 'not_in_universe'],
      ['AAPL', false, null],
      ['KVYO', false, null],
      ['TTD', true, 'not_in_universe'],
    ]);
    for (const r of rows) {
      expect(r).not.toHaveProperty('wouldBlockUnderRatifiedSet');
      expect(r).not.toHaveProperty('ratifiedSet');
    }

    // Restricted rows sit in `evaluated`, never in M: the fold keeps the two
    // populations apart and still publishes the zero.
    const u = retainedUniverse();
    expect(u).toMatchObject({ evaluated: 4, blocked: 2, counterfactualEvaluated: 0, wouldBlockUnderRatifiedSet: 0 });
    expect(u.bySymbol).toEqual([]);
  });

  it('(d) the fold at n=0 publishes 0 / [] on universe, and null on every other gate', () => {
    const s = summarizeLiveEnforceGate('2026-09-10');
    for (const view of [s.byGate, s.retained.byGate]) {
      const u = view.find((g) => g.gate === 'universe')!;
      expect(u).toMatchObject({
        evaluated: 0,
        ratifiedSet: [...OPTION_LIVE_OTM_UNIVERSE_DEFAULT],
        counterfactualEvaluated: 0,
        wouldBlockUnderRatifiedSet: 0,
        counterfactualUnderOtherSet: 0,
        bySymbol: [],
      });
      for (const g of view.filter((x) => x.gate !== 'universe')) {
        for (const k of COUNTERFACTUAL_KEYS) expect(g[k], `${g.gate}.${k}`).toBeNull();
      }
    }
  });

  it('(e) the disk hydrate round-trips the field, drops a malformed half, and flags a row stamped under another set', () => {
    const path = liveEnforceGateLogPath(dir);
    const t0 = Date.now();
    recordLiveEnforceDecision('universe', 'TTD', false, '2026-09-09', undefined, t0, {
      book: 'admin',
      ratifiedSetCounterfactual: { wouldBlock: true, ratifiedSet: RATIFIED },
    });
    recordLiveEnforceDecision('universe', 'SPY', false, '2026-09-10', undefined, t0 + 1, {
      book: 'admin',
      ratifiedSetCounterfactual: { wouldBlock: false, ratifiedSet: RATIFIED },
    });
    // A stamp offered on another gate is dropped on the WRITE path too.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, '2026-09-10', undefined, t0 + 2, {
      ratifiedSetCounterfactual: { wouldBlock: true, ratifiedSet: RATIFIED },
    });
    expect(diskRows()[2]).not.toHaveProperty('wouldBlockUnderRatifiedSet');

    const extra = [
      // Stamped under an OLDER definition of the set.
      { ts: t0 + 3, etDay: '2026-09-10', gate: 'universe', scope: 'TSLA', blocked: false, wouldBlockUnderRatifiedSet: true, ratifiedSet: 'AAPL,SPY' },
      // A malformed half: the row survives, the stamp does not.
      { ts: t0 + 4, etDay: '2026-09-10', gate: 'universe', scope: 'NVDA', blocked: false, wouldBlockUnderRatifiedSet: 'yes', ratifiedSet: RATIFIED },
      // A set with no verdict: likewise.
      { ts: t0 + 5, etDay: '2026-09-10', gate: 'universe', scope: 'AMD', blocked: false, ratifiedSet: RATIFIED },
    ];
    writeFileSync(path, readFileSync(path, 'utf8') + extra.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, t0 + 10);
    expect(h.records).toBe(6);

    const u = retainedUniverse();
    // 5 universe rows; 3 carry a usable stamp (TTD, SPY, TSLA); NVDA and AMD do not.
    expect(u).toMatchObject({
      evaluated: 5,
      blocked: 0,
      counterfactualEvaluated: 3,
      wouldBlockUnderRatifiedSet: 2,
      counterfactualUnderOtherSet: 1,
    });
    expect(u.bySymbol).toEqual([
      { symbol: 'SPY', evaluated: 1, inRatifiedSet: true },
      { symbol: 'TSLA', evaluated: 1, inRatifiedSet: false },
      { symbol: 'TTD', evaluated: 1, inRatifiedSet: false },
    ]);
    // The retained merge copies and never aliases, so a second read gives the same numbers.
    expect(retainedUniverse()).toMatchObject({ counterfactualEvaluated: 3, wouldBlockUnderRatifiedSet: 2 });

    // The per-day view carries it too.
    const day = summarizeLiveEnforceGate('2026-09-09').byGate.find((g) => g.gate === 'universe')!;
    expect(day).toMatchObject({ evaluated: 1, counterfactualEvaluated: 1, wouldBlockUnderRatifiedSet: 1 });

    // The compacted file keeps the good stamps and drops the malformed ones.
    // Compaction happens only when a line is DROPPED, so the on-disk lines here
    // are still the originals; re-hydrate reads the same fold again.
    clearLiveEnforceGateLedger();
    hydrateLiveEnforceGateFromDisk(dir, t0 + 10);
    expect(retainedUniverse()).toMatchObject({ counterfactualEvaluated: 3, counterfactualUnderOtherSet: 1 });
  });

  it('(f) mode != live: nothing recorded, whatever the universe', () => {
    for (const raw of ['*', undefined]) {
      if (raw === undefined) delete process.env[OPTION_LIVE_OTM_UNIVERSE_VAR];
      else process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = raw;
      expect(probe('demo').liveOtmUniverseRejectReason('TTD')).toBeNull();
      expect(probe('demo').liveOtmUniverseRejectReason('AAPL')).toBeNull();
    }
    expect(summarizeLiveEnforceGate('1970-01-01').decisionsRecorded).toBe(0);
    expect(diskRows()).toEqual([]);
  });

  it('the counterfactual reads the COMPILED ratified set, never the env', () => {
    // A restricted env list that happens to include TTD must not redefine what
    // "the ratified set would have refused" means.
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = 'TTD';
    expect(liveOtmRatifiedSetCounterfactual('TTD')).toEqual({ ratifiedSet: RATIFIED, wouldBlock: true });
    expect(liveOtmRatifiedSetCounterfactual('aapl')).toEqual({ ratifiedSet: RATIFIED, wouldBlock: false });
    // A blank symbol cannot prove membership, so it fails closed as it does on the live list.
    expect(liveOtmRatifiedSetCounterfactual('')).toEqual({ ratifiedSet: RATIFIED, wouldBlock: true });
  });
});
