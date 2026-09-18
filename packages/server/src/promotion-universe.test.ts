/**
 * TRA-2392 — universe-gated promotion tests.
 *
 * Tests the conjunction: a widening is allowed only when BOTH ratified AND
 * covered by the granted universe G. Covers the three REFUSE cases and the
 * four regression cases from TRA-3473.
 *
 * TRA-4643 (TRA-4633 AC4) — every conjunction case below grades the REAL gate,
 * `evaluateLiveTransitionGate`, the way promotion-service.test.ts does. The
 * previous revision of this file graded its own hand-written `isWideningAllowed`
 * re-implementation, so it stayed green while the shipped gate had no G writer
 * at all — these tests could not fail. Do not reintroduce a local copy of the
 * gate logic here; if a case cannot be expressed through the real entry point,
 * that is a finding about the gate, not a reason for a stub.
 *
 * ORDER-DEPENDENT: the promotion store is global per strategyId and its
 * decision trail is append-only; the gate reads the LATEST decision's G. The
 * cases run in file order (vitest default) and walk the store through
 * no-record → G={BTC-USD} → G={BTC-USD, ETH-USD, SOL-USD}.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import type { AccountSettings, Position } from '@trading-app/shared';
import { isSymbolUniverseSubset } from '@trading-app/shared';

// DATA_DIR is read at module-eval time inside trade-store / promotion-store, so
// it must be set BEFORE those modules load (same pattern as
// promotion-service.test.ts: dynamic import() inside beforeAll).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'promo-universe-'));
process.env['DATA_DIR'] = DATA_DIR;

const USER = 'universe-user';
const DAY_MS = 24 * 60 * 60 * 1000;

let svc: typeof import('./promotion-service.js');
let store: typeof import('./promotion-store.js');
let tradeStore: typeof import('./trade-store.js');

function paperTrade(pnl: number, i: number): Position {
  return {
    id: `t${i}`,
    symbol: 'BTC-USD',
    side: 'buy',
    signalType: 'dca',
    entryPrice: 100,
    quantity: 1,
    stopLoss: 99,
    takeProfit: 103,
    openedAt: i * DAY_MS,
    closedAt: i * DAY_MS + 3_600_000,
    pnl,
    mode: 'demo',
  };
}

// TRA-1461 — dca is accumulate-class: its Stage-2 leg validates on an OPEN,
// held accumulation, not closed trades.
function dcaAccumulation(fills: number, soakDays: number): Position {
  return {
    id: 'dca-accum-1',
    symbol: 'BTC-USD',
    side: 'buy',
    signalType: 'dca',
    entryPrice: 100,
    quantity: fills,
    stopLoss: 90,
    takeProfit: 0,
    openedAt: Date.now() - soakDays * DAY_MS,
    dcaHold: true,
    dcaFills: fills,
    mode: 'demo',
  };
}

function passingAccumBacktestMetrics(): import('@trading-app/shared').AccumulationBacktestGateMetrics {
  return {
    oosDays: 200,
    deploymentRatio: 0.6,
    valueInvestedMaxDrawdown: 0.2,
    lumpSumMaxDrawdown: 0.4,
    oosReturn: 0.3,
    lumpSumReturn: 0.25,
    cadenceVariantsTested: 3,
    cadenceVariantsConsistent: 3,
    feeAdjustedValueRatio: 1.05,
  };
}

// A settings snapshot whose RESULT runs live crypto auto-trading on `preset`.
// Options stay routed to Tradier Sandbox so the options axis never blocks
// (TRA-4601 grades production unconditionally).
const cryptoLiveOn = (preset: string): AccountSettings =>
  ({
    mode: 'live',
    cryptoAutoTradingEnabledLive: true,
    activeStrategyPreset: preset,
    liveTradierEnvOptions: 'sandbox',
  } as AccountSettings);

const cryptoOff = {
  mode: 'demo',
  cryptoAutoTradingEnabledLive: false,
  activeStrategyPreset: 'crypto_core_live_canary_btc',
} as AccountSettings;

beforeAll(async () => {
  svc = await import('./promotion-service.js');
  store = await import('./promotion-store.js');
  tradeStore = await import('./trade-store.js');

  // Pin the promotion store to THIS file's DATA_DIR. vitest's threads pool
  // shares process.env across worker threads, and the store re-resolves
  // DATA_DIR lazily on every persist/load — so a concurrently-collected test
  // file's module-eval DATA_DIR write can silently redirect this file's store
  // mid-suite, interleaving both files' `dca` records in one store file (the
  // TRA-4690 walk registers/reads the record throughout, which widened the
  // window until the two promotion suites flaked when run in one invocation).
  store.__resetPromotionStoreForTests(join(DATA_DIR, 'promotion-gate.json'));

  // Fully promote `dca` for USER on Stages 1+2 (Stage 3 sign-offs are appended
  // inside the cases below, because WHICH grant is latest is what each case is
  // about). Seeding mirrors promotion-service.test.ts: a closed paper ledger
  // for snapshotPaperMetrics plus the OPEN accumulation Stage 2 gates on.
  const closed = Array.from({ length: 60 }, (_, i) => paperTrade(i % 6 === 0 ? -0.5 : 1.5, i));
  await tradeStore.saveCryptoTradeSnapshot(USER, {
    version: 1,
    savedAt: new Date().toISOString(),
    openPositions: [dcaAccumulation(10, 20)],
    closedPositions: closed,
    demoClosedPositions: closed,
    recentSignals: [],
    account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
  });
  await store.registerAccumulationBacktestVerdict({
    strategyId: 'dca',
    metrics: passingAccumBacktestMetrics(),
    reportId: 'TRA-2392-universe',
    registeredBy: 'qt',
  });
});

describe('TRA-2392 — symbol universe promotion gates', () => {
  describe('isSymbolUniverseSubset', () => {
    it('reads null as ⊤ in BOTH positions', () => {
      // ⊤ ⊆ ⊤ — holding an unbounded universe is not a widening
      expect(isSymbolUniverseSubset(null, null)).toBe(true);

      // ⊤ ⊄ finite — unbounded is NOT a subset of any finite list
      expect(isSymbolUniverseSubset(null, ['BTC-USD'])).toBe(false);

      // finite ⊆ ⊤ — everything is a subset of unbounded
      expect(isSymbolUniverseSubset(['BTC-USD'], null)).toBe(true);
    });

    it('handles finite subset checks correctly', () => {
      expect(isSymbolUniverseSubset(['BTC-USD'], ['BTC-USD', 'ETH-USD'])).toBe(true);
      expect(isSymbolUniverseSubset(['BTC-USD', 'ETH-USD'], ['BTC-USD'])).toBe(false);
      expect(isSymbolUniverseSubset(['BTC-USD'], ['BTC-USD'])).toBe(true);
      expect(isSymbolUniverseSubset([], ['BTC-USD'])).toBe(true);
      expect(isSymbolUniverseSubset([], [])).toBe(true);
    });
  });

  describe('TRA-3473 — granted universe conjunction (ratified AND covered by G), on the REAL gate', () => {
    describe('REFUSE cases (behaviour changes from today)', () => {
      it('case 1: canary→majors with no G on record is REFUSED', async () => {
        // No sign-off has been recorded yet — the decision trail is empty, so
        // the gate reads G as absent, which is fail-closed. The roster delta on
        // this save is EMPTY ({dca} → {dca}), so the universe conjunct is the
        // ONLY thing that can refuse it.
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core_live_majors'),
          cryptoLiveOn('crypto_core_live_canary_btc'),
        );
        expect(gate.allowed).toBe(false);
        expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
        const reasons = gate.blocked[0]?.reasons.join(' ') ?? '';
        expect(reasons).toMatch(/WIDENS the live symbol universe/i);
        expect(reasons).toMatch(/IS on the board-ratified live-crypto list/);
        expect(reasons).toMatch(/no granted universe on record/);
      });

      it('case 3: anything→crypto_core (unbounded) is REFUSED — not ratified, regardless of G', async () => {
        // The ≈395-pair grandfathering this chain exists to close.
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core'),
          cryptoLiveOn('crypto_core_live_canary_btc'),
        );
        expect(gate.allowed).toBe(false);
        expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
        expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/not on the board-ratified live-crypto list/i);
      });

      it('case 2: canary→majors with G={BTC-USD} (too narrow) is REFUSED', async () => {
        // The universe a real DCA Stage-1 registration would carry today.
        // TRA-4690 — E is written by the Stage-1 registration ONLY; the
        // sign-off may not carry it (recordSignoff refuses the key outright).
        await store.registerAccumulationBacktestVerdict({
          strategyId: 'dca',
          metrics: passingAccumBacktestMetrics(),
          reportId: 'TRA-2392-universe-btc-evidence',
          registeredBy: 'qt',
          evidenceUniverse: ['BTC-USD'],
        });
        await store.recordSignoff({
          strategyId: 'dca',
          reviewer: 'QuantTrader',
          backtestMetrics: null,
          paperMetrics: await svc.snapshotPaperMetrics(USER, 'dca'),
          grantedUniverse: ['BTC-USD'],
        });
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core_live_majors'),
          cryptoLiveOn('crypto_core_live_canary_btc'),
        );
        expect(gate.allowed).toBe(false);
        const reasons = gate.blocked[0]?.reasons.join(' ') ?? '';
        expect(reasons).toMatch(/IS on the board-ratified live-crypto list/);
        expect(reasons).toMatch(/Stage-1 evidence does not cover/);
      });

      // TRA-4648 — the measured probe, inverted. Pre-fix, recordSignoff gated
      // G ⊆ E only on the SAME-CALL evidenceUniverse: omitting the key appended
      // an arbitrary grant unchecked, and evaluateLiveTransitionGate then read
      // allowed=true off it (canary→majors approved on BTC-only evidence).
      // Order note: the refusal appends NOTHING and the defaults case below
      // appends G={BTC-USD} — the same latest-G case 2 left — so the file's
      // decision walk (no-record → {BTC-USD} → majors) is unchanged.
      it('TRA-4648: grant with E OMITTED is validated against the Stage-1 record E and REFUSED', async () => {
        // Stage 1 re-registers carrying the evidence universe a real DCA run
        // stamps (case 2 already stamped this E; re-registered here so this
        // case stays self-describing about the record it validates against).
        await store.registerAccumulationBacktestVerdict({
          strategyId: 'dca',
          metrics: passingAccumBacktestMetrics(),
          reportId: 'TRA-4648-record-E',
          registeredBy: 'qt',
          evidenceUniverse: ['BTC-USD'],
        });
        const probe = async () =>
          store.recordSignoff({
            strategyId: 'dca',
            reviewer: 'QuantTrader',
            backtestMetrics: null,
            paperMetrics: await svc.snapshotPaperMetrics(USER, 'dca'),
            grantedUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'], // E omitted
          });
        // AC2 rides on the class: POST /api/promotion/signoff maps
        // PromotionValidationError → 400, so the route surfaces this as a 4xx.
        await expect(probe()).rejects.toThrow(store.PromotionValidationError);
        // …and the message names BOTH universes (the record-E, not "undefined").
        await expect(probe()).rejects.toThrow(
          /grantedUniverse \[BTC-USD, ETH-USD, SOL-USD\] is not a subset of evidenceUniverse \[BTC-USD\]/,
        );
        // Step 3 of the probe is unreachable: the unchecked grant never landed,
        // so the REAL gate still refuses the widening (latest G is case 2's).
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core_live_majors'),
          cryptoLiveOn('crypto_core_live_canary_btc'),
        );
        expect(gate.allowed).toBe(false);
        expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
      });

      it('TRA-4648: sign-off with BOTH universes omitted defaults G to the record E, not undefined', async () => {
        const d = await store.recordSignoff({
          strategyId: 'dca',
          reviewer: 'QuantTrader',
          backtestMetrics: null,
          paperMetrics: await svc.snapshotPaperMetrics(USER, 'dca'),
        });
        // The decision records the EFFECTIVE universes it was validated under.
        expect(d.evidenceUniverse).toEqual(['BTC-USD']);
        expect(d.grantedUniverse).toEqual(['BTC-USD']);
      });

      // TRA-4690 — the SUPPLIED-E mirror of the TRA-4648 omitted-E bypass. The
      // measured probe: record E={BTC-USD}, reviewer supplies E=G=majors on
      // the sign-off itself → pre-fix, the call-E won over the Stage-1 record
      // (`args.evidenceUniverse ?? rec...`), the grant was accepted, the real
      // gate flipped canary→majors to allowed=true, and the audit trail
      // claimed evidence Stage 1 never produced. Refusal appends nothing, so
      // the file's decision walk is unchanged.
      it('TRA-4690: sign-off that SUPPLIES a wider E is REFUSED — the call cannot override the Stage-1 record', async () => {
        const probe = async () =>
          store.recordSignoff({
            strategyId: 'dca',
            reviewer: 'QuantTrader',
            backtestMetrics: null,
            paperMetrics: await svc.snapshotPaperMetrics(USER, 'dca'),
            evidenceUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'], // wider than the record E
            grantedUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
          });
        await expect(probe()).rejects.toThrow(store.PromotionValidationError);
        // …and the refusal NAMES the key, so a caller cannot believe it was honoured.
        await expect(probe()).rejects.toThrow(
          /evidenceUniverse is not accepted on a sign-off — the evidence universe is written by the Stage-1 registration only/,
        );
        // The unchecked grant never landed: the REAL gate still refuses the
        // widening (latest G is the {BTC-USD} default appended above).
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core_live_majors'),
          cryptoLiveOn('crypto_core_live_canary_btc'),
        );
        expect(gate.allowed).toBe(false);
        expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
        // The audit trail cannot claim evidence Stage 1 never produced: the
        // latest decision's E equals the record E, not the supplied one.
        const rec = await store.getStrategyRecord('dca');
        expect(rec?.backtest?.evidenceUniverse).toEqual(['BTC-USD']);
        expect(rec?.decisions.at(-1)?.evidenceUniverse).toEqual(['BTC-USD']);
      });
    });

    describe('MUST STILL PASS (regression guards — TRA-1590 deadlock)', () => {
      it('case 7: canary reachability with G={BTC-USD} (the proof AC2 costs nothing real)', async () => {
        // Start on the canary from OFF with the {BTC-USD} grant recorded in
        // case 2 → ALLOWED. This escalates the crypto axis, so `dca` is graded
        // on full promotion too — which USER passes (Stages 1+2 seeded, sign-off
        // recorded in case 2). Reaching the canary requires exactly the evidence
        // a real Stage-1 run carries, and G defaults to E.
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core_live_canary_btc'),
          cryptoOff,
        );
        expect(gate.allowed).toBe(true);
        expect(gate.blocked).toHaveLength(0);
      });

      it('case 4: majors→canary (narrowing) is ALLOWED — G is irrelevant', async () => {
        // The latest G on record is still {BTC-USD}, which does NOT cover the
        // majors — proving the refusal only fires on a WIDENING.
        const gate = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('crypto_core_live_canary_btc'),
          cryptoLiveOn('crypto_core_live_majors'),
        );
        expect(gate.allowed).toBe(true);
        expect(gate.blocked).toHaveLength(0);
      });

      it('case 5: hold same preset (an unrelated edit) is ALLOWED', async () => {
        const previous = cryptoLiveOn('crypto_core_live_majors');
        const updated = { ...previous, riskPerTrade: 1 } as AccountSettings;
        const gate = await svc.evaluateLiveTransitionGate(USER, updated, previous);
        expect(gate.allowed).toBe(true);
        expect(gate.blocked).toHaveLength(0);
      });

      it('case 6: turning live crypto OFF is ALLOWED, even onto the empty no_trade roster', async () => {
        // De-escalation in both shapes: the axis turned OFF outright…
        const off = await svc.evaluateLiveTransitionGate(
          USER,
          { ...cryptoLiveOn('crypto_core_live_majors'), cryptoAutoTradingEnabledLive: false } as AccountSettings,
          cryptoLiveOn('crypto_core_live_majors'),
        );
        expect(off.allowed).toBe(true);
        expect(off.blocked).toHaveLength(0);

        // …and standing down to the empty universe while the axis stays ON
        // (the TRA-2343 empty-roster refusal is scoped to an ESCALATION).
        const standDown = await svc.evaluateLiveTransitionGate(
          USER,
          cryptoLiveOn('no_trade'),
          cryptoLiveOn('crypto_core_live_majors'),
        );
        expect(standDown.allowed).toBe(true);
        expect(standDown.blocked).toHaveLength(0);
      });
    });

    it('TRA-3473 AC2: ratified AND covered by G → allowed', async () => {
      // The happy path: majors are reached the only legitimate way (TRA-4690) —
      // Stage 1 RE-REGISTERS with the majors evidence, then the reviewer grants
      // G = majors (latest decision wins). The sign-off itself carries no E.
      await store.registerAccumulationBacktestVerdict({
        strategyId: 'dca',
        metrics: passingAccumBacktestMetrics(),
        reportId: 'TRA-2392-universe-majors-evidence',
        registeredBy: 'qt',
        evidenceUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      });
      await store.recordSignoff({
        strategyId: 'dca',
        reviewer: 'QuantTrader',
        backtestMetrics: null,
        paperMetrics: await svc.snapshotPaperMetrics(USER, 'dca'),
        grantedUniverse: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
      });
      const gate = await svc.evaluateLiveTransitionGate(
        USER,
        cryptoLiveOn('crypto_core_live_majors'),
        cryptoLiveOn('crypto_core_live_canary_btc'),
      );
      expect(gate.allowed).toBe(true);
      expect(gate.blocked).toHaveLength(0);
    });
  });
});
