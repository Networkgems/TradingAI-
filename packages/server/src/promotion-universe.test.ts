/**
 * TRA-2392 — universe-carried promotion records: E (evidence universe, derived,
 * ONE writer: the Stage-1 registration) and G (granted universe, reviewer-
 * supplied, validated G ⊆ E before the append).
 *
 * HISTORY — why this file tests the STORE and not a live-transition gate.
 * The original revision graded the TRA-3473 conjunction (board-ratified AND
 * covered by G) through `evaluateLiveTransitionGate`'s crypto axis
 * (canary→majors→crypto_core walks). TRA-4629 then deleted the crypto engine
 * and with it that whole axis of the gate: there is no crypto universe left to
 * widen, which subsumes the refusal those cases encoded (an axis that does not
 * exist is stronger than a widening that is refused). What SURVIVES the
 * deletion — and is now load-bearing for the options/stocks promotion path,
 * the real-money surface — is the record itself:
 *
 *   • Stage-1 registrations stamp E, refuse null (unbounded) E.
 *   • recordSignoff reads E from the Stage-1 record ONLY (TRA-4648 closed the
 *     omitted-E bypass, TRA-4690 the supplied-E bypass), defaults an omitted G
 *     to E, refuses G ⊄ E, and refuses an explicit grant with no E on record.
 *   • The appended decision records the EFFECTIVE universes it was validated
 *     under, so the audit trail cannot claim evidence Stage 1 never produced.
 *
 * ORDER-DEPENDENT: the promotion store is global per strategyId and its
 * decision trail is append-only; the cases run in file order (vitest default)
 * and walk `dca`'s record through E={BTC-USD} → E=majors.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { isSymbolUniverseSubset } from '@trading-app/shared';

// DATA_DIR is read at module-eval time inside promotion-store, so it must be
// set BEFORE the module loads (same pattern as promotion-service.test.ts:
// dynamic import() inside beforeAll).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'promo-universe-'));
process.env['DATA_DIR'] = DATA_DIR;

const MAJORS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

let store: typeof import('./promotion-store.js');

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

beforeAll(async () => {
  store = await import('./promotion-store.js');

  // Pin the promotion store to THIS file's DATA_DIR. vitest's threads pool
  // shares process.env across worker threads, and the store re-resolves
  // DATA_DIR lazily on every persist/load — so a concurrently-collected test
  // file's module-eval DATA_DIR write can silently redirect this file's store
  // mid-suite, interleaving both files' `dca` records in one store file (the
  // TRA-4690 walk registers/reads the record throughout, which widened the
  // window until the two promotion suites flaked when run in one invocation).
  store.__resetPromotionStoreForTests(join(DATA_DIR, 'promotion-gate.json'));
});

describe('TRA-2392 — symbol universe promotion records', () => {
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

  describe('E — the Stage-1 registration is the ONLY writer', () => {
    it('stamps E on the registration; the record carries it', async () => {
      await store.registerAccumulationBacktestVerdict({
        strategyId: 'dca',
        metrics: passingAccumBacktestMetrics(),
        reportId: 'TRA-2392-universe-btc-evidence',
        registeredBy: 'qt',
        evidenceUniverse: ['BTC-USD'],
      });
      const rec = await store.getStrategyRecord('dca');
      expect(rec?.backtest?.evidenceUniverse).toEqual(['BTC-USD']);
    });

    it('refuses a null (unbounded) E — no backtest can measure a catalog that grows on its own', async () => {
      await expect(
        store.registerAccumulationBacktestVerdict({
          strategyId: 'dca',
          metrics: passingAccumBacktestMetrics(),
          reportId: 'TRA-2392-universe-null-E',
          registeredBy: 'qt',
          evidenceUniverse: null,
        }),
      ).rejects.toThrow(store.PromotionValidationError);
      // …and the refusal did not clobber the registered record.
      const rec = await store.getStrategyRecord('dca');
      expect(rec?.backtest?.evidenceUniverse).toEqual(['BTC-USD']);
    });
  });

  describe('G — reviewer-supplied, validated G ⊆ E before the append', () => {
    // TRA-4648 — the measured probe, inverted. Pre-fix, recordSignoff gated
    // G ⊆ E only on the SAME-CALL evidenceUniverse: omitting the key appended
    // an arbitrary grant unchecked (canary→majors approved on BTC-only
    // evidence). E now comes from the Stage-1 record, never from the call.
    it('TRA-4648: grant with E OMITTED is validated against the Stage-1 record E and REFUSED', async () => {
      const probe = () =>
        store.recordSignoff({
          strategyId: 'dca',
          reviewer: 'QuantTrader',
          backtestMetrics: null,
          paperMetrics: null,
          grantedUniverse: MAJORS, // E omitted; record E is {BTC-USD}
        });
      // AC2 rides on the class: POST /api/promotion/signoff maps
      // PromotionValidationError → 400, so the route surfaces this as a 4xx.
      await expect(probe()).rejects.toThrow(store.PromotionValidationError);
      // …and the message names BOTH universes (the record-E, not "undefined").
      await expect(probe()).rejects.toThrow(
        /grantedUniverse \[BTC-USD, ETH-USD, SOL-USD\] is not a subset of evidenceUniverse \[BTC-USD\]/,
      );
      // The unchecked grant never landed.
      const rec = await store.getStrategyRecord('dca');
      expect(rec?.decisions ?? []).toHaveLength(0);
    });

    it('sign-off with BOTH universes omitted defaults G to the record E, not undefined', async () => {
      const d = await store.recordSignoff({
        strategyId: 'dca',
        reviewer: 'QuantTrader',
        backtestMetrics: null,
        paperMetrics: null,
      });
      // The decision records the EFFECTIVE universes it was validated under.
      expect(d.evidenceUniverse).toEqual(['BTC-USD']);
      expect(d.grantedUniverse).toEqual(['BTC-USD']);
    });

    // TRA-4690 — the SUPPLIED-E mirror of the TRA-4648 omitted-E bypass. The
    // measured probe: record E={BTC-USD}, reviewer supplies E=G=majors on the
    // sign-off itself → pre-fix, the call-E won over the Stage-1 record
    // (`args.evidenceUniverse ?? rec…`), the grant was accepted, and the audit
    // trail claimed evidence Stage 1 never produced.
    it('TRA-4690: sign-off that SUPPLIES a wider E is REFUSED — the call cannot override the Stage-1 record', async () => {
      const probe = () =>
        store.recordSignoff({
          strategyId: 'dca',
          reviewer: 'QuantTrader',
          backtestMetrics: null,
          paperMetrics: null,
          evidenceUniverse: MAJORS, // wider than the record E
          grantedUniverse: MAJORS,
        });
      await expect(probe()).rejects.toThrow(store.PromotionValidationError);
      // …and the refusal NAMES the key, so a caller cannot believe it was honoured.
      await expect(probe()).rejects.toThrow(
        /evidenceUniverse is not accepted on a sign-off — the evidence universe is written by the Stage-1 registration only/,
      );
      // The audit trail cannot claim evidence Stage 1 never produced: the
      // record E and the latest decision's E are both the Stage-1 {BTC-USD}.
      const rec = await store.getStrategyRecord('dca');
      expect(rec?.backtest?.evidenceUniverse).toEqual(['BTC-USD']);
      expect(rec?.decisions.at(-1)?.evidenceUniverse).toEqual(['BTC-USD']);
    });

    it('an explicit grant with NO Stage-1 E on record is REFUSED (fail-closed, not vacuously true)', async () => {
      // A strategy with no registration at all — `undefined` E is neither ⊤
      // nor ∅; reading it as ⊤ would fail OPEN on exactly the legacy records
      // this model retires.
      await expect(
        store.recordSignoff({
          strategyId: 'never-registered',
          reviewer: 'QuantTrader',
          backtestMetrics: null,
          paperMetrics: null,
          grantedUniverse: ['BTC-USD'],
        }),
      ).rejects.toThrow(/cannot grant more than the evidence covered/);
    });

    it('a wider Stage-1 re-registration re-opens the grant: E=majors, G=majors lands and is recorded', async () => {
      // The only legitimate route to a wider grant (TRA-4690): Stage 1
      // RE-REGISTERS with the wider evidence, then the reviewer grants it.
      await store.registerAccumulationBacktestVerdict({
        strategyId: 'dca',
        metrics: passingAccumBacktestMetrics(),
        reportId: 'TRA-2392-universe-majors-evidence',
        registeredBy: 'qt',
        evidenceUniverse: MAJORS,
      });
      const d = await store.recordSignoff({
        strategyId: 'dca',
        reviewer: 'QuantTrader',
        backtestMetrics: null,
        paperMetrics: null,
        grantedUniverse: MAJORS,
      });
      expect(d.evidenceUniverse).toEqual(MAJORS);
      expect(d.grantedUniverse).toEqual(MAJORS);
    });

    it('a reviewer may NARROW below the evidence — G ⊂ E is always allowed', async () => {
      const d = await store.recordSignoff({
        strategyId: 'dca',
        reviewer: 'QuantTrader',
        backtestMetrics: null,
        paperMetrics: null,
        grantedUniverse: ['BTC-USD'], // narrower than E=majors
      });
      expect(d.evidenceUniverse).toEqual(MAJORS);
      expect(d.grantedUniverse).toEqual(['BTC-USD']);
    });

    it('a null (unbounded) G is REFUSED against a finite E — ⊤ ⊄ finite', async () => {
      await expect(
        store.recordSignoff({
          strategyId: 'dca',
          reviewer: 'QuantTrader',
          backtestMetrics: null,
          paperMetrics: null,
          grantedUniverse: null, // an unbounded grant on finite evidence
        }),
      ).rejects.toThrow(
        /grantedUniverse unbounded is not a subset of evidenceUniverse \[BTC-USD, ETH-USD, SOL-USD\]/,
      );
    });
  });
});
