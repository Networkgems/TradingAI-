// TRA-3944 (parent TRA-3927, board card `a29b2db8`) — the OTM sleeve's
// CONTRACT FLOOR: premium ≥ $0.50 (ask, or mid under a 10% spread), |Δ| ∈
// [0.25, 0.40], DTE ∈ [21, 45] with a HARD refusal at ≤ 7, max 2 contracts per
// entry, max 1 open row per underlying. Refuse the SETUP, never clamp.
//
// ── What is asserted ────────────────────────────────────────────────────────
//  AC1 — each of the four refusal codes (`contract_floor_premium` / `_delta` /
//        `_dte` / `_size`) and one ACCEPT, on the pure predicates. Plus the
//        rule-5 chain form: an empty admissible set refuses with the DOMINANT
//        code, and a chain with one admissible strike hands the selector that
//        strike rather than clamping the nearest one.
//  AC3 — the imported-row audit counts `importedFromTradier` violations and
//        ignores engine-opened rows; it is a counter, not a gate.
//  AC4 — source-level: the arm, the row size and the 2-row cap are not read
//        by the module or by the scan-site block; the chain cut sits ABOVE the
//        selector; the pick cut sits BELOW the window and ABOVE the universe
//        cut; no exit path imports the module.
//  Env — every knob falls back to its own default, an inverted pair voids
//        both halves, and the hard DTE floor is not spellable.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveOtmContractFloor,
  otmContractFloorVerdict,
  otmContractFloorPremium,
  applyOtmContractFloor,
  otmContractFloorOpenRowVerdict,
  capOtmEntryContracts,
  auditOtmContractFloorRows,
  mergeOtmContractFloorImportedAudits,
  otmContractFloorBandIntersects,
  OTM_CONTRACT_FLOOR_DEFAULTS,
  OTM_CONTRACT_FLOOR_PREMIUM_CODE,
  OTM_CONTRACT_FLOOR_DELTA_CODE,
  OTM_CONTRACT_FLOOR_DTE_CODE,
  OTM_CONTRACT_FLOOR_SIZE_CODE,
  OTM_CONTRACT_FLOOR_CODES,
} from './otm-contract-floor.js';
import { OTM_ADMISSIBLE_DELTA_MIN_DEFAULT, OTM_ADMISSIBLE_DELTA_MAX_DEFAULT } from './otm-admissible-strike.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8').replace(/\r\n/g, '\n');
const MODULE_SRC = readFileSync(join(HERE, 'otm-contract-floor.ts'), 'utf8').replace(/\r\n/g, '\n');
const ACCOUNT_SRC = readFileSync(join(HERE, 'options-account.ts'), 'utf8').replace(/\r\n/g, '\n');

const FLOOR = resolveOtmContractFloor({});

/** A contract that clears every rule: $1.20 ask, |Δ| 0.32, 30 DTE. */
const GOOD = { bid: 1.15, ask: 1.2, delta: 0.32, daysToExpiration: 30.4 };

describe('TRA-3944 AC1 — the four refusal codes and one accept', () => {
  it('ACCEPT: premium ≥ $0.50, |Δ| in band, DTE in band', () => {
    const v = otmContractFloorVerdict(GOOD, FLOOR);
    expect(v.admit).toBe(true);
    expect(v.reasonCode).toBeNull();
    expect(v.failed).toEqual([]);
    expect(v.dte).toBe(30);
    // Spread 0.05/1.175 = 4.3% < 10% ⇒ the MID is the basis.
    expect(v.premiumBasis).toBe('mid');
    expect(v.premium).toBeCloseTo(1.175, 6);
  });

  it('contract_floor_premium: the F5 tape — SPY 816C at $0.08, QQQ 797C at $0.325', () => {
    for (const c of [
      { ...GOOD, bid: 0.07, ask: 0.08 },
      { ...GOOD, bid: 0.3, ask: 0.35 },
    ]) {
      const v = otmContractFloorVerdict(c, FLOOR);
      expect(v.admit).toBe(false);
      expect(v.reasonCode).toBe(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
      expect(v.failed).toEqual([OTM_CONTRACT_FLOOR_PREMIUM_CODE]);
      expect(v.reason).toMatch(/premium floor/);
      expect(v.reason).toMatch(/never clamped/);
    }
  });

  it('contract_floor_premium: a wide spread grades on the ASK, a tight one on the MID', () => {
    // bid 0.40 / ask 0.55: mid 0.475, spread 0.15/0.475 = 31.6% ⇒ ask 0.55 ≥ 0.50 ⇒ ADMIT on ask.
    expect(otmContractFloorPremium({ bid: 0.4, ask: 0.55 })).toEqual({ premium: 0.55, basis: 'ask' });
    // bid 0.47 / ask 0.49: spread 4.2% ⇒ mid 0.48 < 0.50 ⇒ REFUSE (and the ask would not save it either).
    const tight = otmContractFloorVerdict({ ...GOOD, bid: 0.47, ask: 0.49 }, FLOOR);
    expect(tight.reasonCode).toBe(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
    // No usable ask ⇒ fails CLOSED.
    expect(otmContractFloorPremium({ bid: 1, ask: 0 })).toBeNull();
    expect(otmContractFloorVerdict({ ...GOOD, ask: NaN }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
  });

  it('contract_floor_delta: below 0.25, above 0.40, unreadable — puts by |Δ|', () => {
    expect(otmContractFloorVerdict({ ...GOOD, delta: 0.12 }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_DELTA_CODE);
    expect(otmContractFloorVerdict({ ...GOOD, delta: 0.5 }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_DELTA_CODE);
    expect(otmContractFloorVerdict({ ...GOOD, delta: NaN }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_DELTA_CODE);
    // A put at −0.30 is IN band.
    expect(otmContractFloorVerdict({ ...GOOD, delta: -0.3 }, FLOOR).admit).toBe(true);
    // Inclusive edges.
    expect(otmContractFloorVerdict({ ...GOOD, delta: 0.25 }, FLOOR).admit).toBe(true);
    expect(otmContractFloorVerdict({ ...GOOD, delta: 0.4 }, FLOOR).admit).toBe(true);
  });

  it('contract_floor_dte: the PLTR import (4 DTE) is HARD-refused; 20 and 46 are band-refused; 21/45 admit', () => {
    const pltr = otmContractFloorVerdict({ ...GOOD, daysToExpiration: 4.2 }, FLOOR);
    expect(pltr.reasonCode).toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(pltr.reason).toMatch(/HARD floor/);
    // 7.9 floors to 7 ⇒ still hard.
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: 7.9 }, FLOOR).reason).toMatch(/HARD floor/);
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: 20.9 }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: 46 }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: NaN }, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: 21.0 }, FLOOR).admit).toBe(true);
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: 45.7 }, FLOOR).admit).toBe(true);
  });

  it('the HARD DTE floor survives a band retune that would otherwise admit it', () => {
    const widened = resolveOtmContractFloor({ OTM_CONTRACT_FLOOR_DTE_MIN: '2', OTM_CONTRACT_FLOOR_DTE_MAX: '45' });
    expect(widened.dteMin).toBe(2);
    expect(widened.source).toBe('env');
    const v = otmContractFloorVerdict({ ...GOOD, daysToExpiration: 5 }, widened);
    expect(v.reasonCode).toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(v.reason).toMatch(/HARD floor/);
    // ...and 8 DTE inside the widened band admits.
    expect(otmContractFloorVerdict({ ...GOOD, daysToExpiration: 8 }, widened).admit).toBe(true);
  });

  it('contract_floor_size: a second open row on the underlying is refused; the count caps at 2', () => {
    expect(otmContractFloorOpenRowVerdict(0, FLOOR).admit).toBe(true);
    const one = otmContractFloorOpenRowVerdict(1, FLOOR);
    expect(one.admit).toBe(false);
    expect(one.reasonCode).toBe(OTM_CONTRACT_FLOOR_SIZE_CODE);
    // Unreadable count fails CLOSED.
    expect(otmContractFloorOpenRowVerdict(NaN, FLOOR).reasonCode).toBe(OTM_CONTRACT_FLOOR_SIZE_CODE);
    // The F5 4-contract lots become 2.
    expect(capOtmEntryContracts(4, FLOOR)).toBe(2);
    expect(capOtmEntryContracts(2, FLOOR)).toBe(2);
    expect(capOtmEntryContracts(1, FLOOR)).toBe(1);
    expect(capOtmEntryContracts(0, FLOOR)).toBe(0);
    expect(capOtmEntryContracts(NaN, FLOOR)).toBe(0);
    expect(capOtmEntryContracts(1.9, FLOOR)).toBe(1);
  });

  it('a contract wrong on every axis reports ALL of them, first-in-rule-order as the code', () => {
    const v = otmContractFloorVerdict({ bid: 0.05, ask: 0.08, delta: 0.02, daysToExpiration: 3 }, FLOOR);
    expect(v.failed).toEqual([OTM_CONTRACT_FLOOR_PREMIUM_CODE, OTM_CONTRACT_FLOOR_DELTA_CODE, OTM_CONTRACT_FLOOR_DTE_CODE]);
    expect(v.reasonCode).toBe(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
  });
});

describe('TRA-3944 rule 5 — the chain form refuses the SETUP, never clamps', () => {
  it('nothing admissible ⇒ refusal with the DOMINANT code, counts per code, ties to rule order', () => {
    const chain = applyOtmContractFloor([
      { bid: 0.05, ask: 0.08, delta: 0.3, daysToExpiration: 30 }, // premium
      { bid: 0.1, ask: 0.12, delta: 0.3, daysToExpiration: 30 }, // premium
      { ...GOOD, delta: 0.1 }, // delta
      { ...GOOD, daysToExpiration: 3 }, // dte (hard)
    ], FLOOR);
    expect(chain.admissible).toEqual([]);
    expect(chain.considered).toBe(4);
    expect(chain.removedByCode[OTM_CONTRACT_FLOOR_PREMIUM_CODE]).toBe(2);
    expect(chain.removedByCode[OTM_CONTRACT_FLOOR_DELTA_CODE]).toBe(1);
    expect(chain.removedByCode[OTM_CONTRACT_FLOOR_DTE_CODE]).toBe(1);
    expect(chain.refusalCode).toBe(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
    expect(chain.reason).toMatch(/none of 4 chain candidate/);
    expect(chain.reason).toMatch(/never clamped to the nearest contract/);
    // Tie (1 delta, 1 dte) ⇒ rule order picks delta.
    const tie = applyOtmContractFloor([{ ...GOOD, delta: 0.1 }, { ...GOOD, daysToExpiration: 3 }], FLOOR);
    expect(tie.refusalCode).toBe(OTM_CONTRACT_FLOOR_DELTA_CODE);
  });

  it('one admissible strike down the chain ⇒ that strike, in rank order, and NOT the nearer miss', () => {
    const near = { ...GOOD, ask: 0.49, bid: 0.48 }; // a one-cent miss — the clamp temptation
    const far = { ...GOOD, ask: 0.9, bid: 0.85 };
    const chain = applyOtmContractFloor([near, far], FLOOR);
    expect(chain.refusalCode).toBeNull();
    expect(chain.admissible).toEqual([far]);
    expect(chain.removedByCode[OTM_CONTRACT_FLOOR_PREMIUM_CODE]).toBe(1);
  });

  it('an EMPTY chain is not a floor refusal (that is `no_candidates` upstream)', () => {
    const chain = applyOtmContractFloor([], FLOOR);
    expect(chain.refusalCode).toBeNull();
    expect(chain.reason).toBeNull();
  });
});

describe('TRA-3944 AC3 — imported rows are AUDITED, not gated', () => {
  const openedAt = Date.parse('2026-08-17T14:00:00Z');
  const rows = [
    // The PLTR import: bought 08-17 for 260821 (4 DTE), $0.90, 4 contracts.
    { symbol: 'PLTR', optionSymbol: 'PLTR260821C00170000', expiration: '2026-08-21', contracts: 4, premiumPaid: 0.9, mode: 'live', importedFromTradier: true, openedAt },
    // An imported row that is CLEAN on every rule it can measure (no delta ⇒ not a delta violation).
    { symbol: 'BAC', optionSymbol: 'BAC260918C00050000', expiration: '2026-09-18', contracts: 1, premiumPaid: 1.17, mode: 'live', importedFromTradier: true, openedAt },
    // An ENGINE-opened row that violates everything — NOT audited here.
    { symbol: 'SPY', optionSymbol: 'SPY260821C00816000', expiration: '2026-08-21', contracts: 4, premiumPaid: 0.08, mode: 'live', entryDelta: 0.03, openedAt },
  ];

  it('counts the PLTR import under dte + size, leaves BAC clean, ignores the engine row', () => {
    const audit = auditOtmContractFloorRows(rows, FLOOR);
    expect(audit.importedOpenRows).toBe(2);
    expect(audit.importedViolatingRows).toBe(1);
    expect(audit.byCode[OTM_CONTRACT_FLOOR_DTE_CODE]).toBe(1);
    expect(audit.byCode[OTM_CONTRACT_FLOOR_SIZE_CODE]).toBe(1);
    expect(audit.byCode[OTM_CONTRACT_FLOOR_PREMIUM_CODE]).toBe(0);
    expect(audit.byCode[OTM_CONTRACT_FLOOR_DELTA_CODE]).toBe(0);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]).toMatchObject({ symbol: 'PLTR', dteAtOpen: 4, contracts: 4, absDelta: null });
    expect(audit.violations[0].violates).toEqual([OTM_CONTRACT_FLOOR_DTE_CODE, OTM_CONTRACT_FLOOR_SIZE_CODE]);
  });

  it('folds across books', () => {
    const a = auditOtmContractFloorRows(rows, FLOOR);
    const merged = mergeOtmContractFloorImportedAudits([a, a]);
    expect(merged.importedOpenRows).toBe(4);
    expect(merged.importedViolatingRows).toBe(2);
    expect(merged.byCode[OTM_CONTRACT_FLOOR_DTE_CODE]).toBe(2);
  });

  it('the module has no gate surface for imported rows — the audit never returns a refusal', () => {
    expect(MODULE_SRC).not.toMatch(/importedFromTradier[^\n]*reasonCode/);
    // And the scan-site rule-4 count is about the NAME: imported rows count as exposure.
    const at = ACCOUNT_SRC.indexOf('openRowsForUnderlying(symbol: string, mode: AccountMode): number');
    expect(at).toBeGreaterThan(-1);
    expect(ACCOUNT_SRC.slice(at, at + 400)).not.toMatch(/importedFromTradier/);
  });
});

describe('TRA-3944 env — each knob falls back alone, inverted pairs void both halves, hard floor not spellable', () => {
  it('defaults are the board ruling', () => {
    expect(FLOOR).toMatchObject({
      premiumMin: 0.5, deltaMin: 0.25, deltaMax: 0.4, dteMin: 21, dteMax: 45, dteHardFloor: 7,
      maxContractsPerEntry: 2, maxOpenRowsPerUnderlying: 1, source: 'default', invalidKeys: [],
    });
    expect(OTM_CONTRACT_FLOOR_CODES).toEqual([
      'contract_floor_premium', 'contract_floor_delta', 'contract_floor_dte', 'contract_floor_size',
    ]);
  });

  it('a malformed knob is loud (env_invalid + the key) and falls back to ITS default only', () => {
    const r = resolveOtmContractFloor({ OTM_CONTRACT_FLOOR_PREMIUM_MIN: 'abc', OTM_CONTRACT_FLOOR_MAX_CONTRACTS: '3' });
    expect(r.source).toBe('env_invalid');
    expect(r.invalidKeys).toEqual(['OTM_CONTRACT_FLOOR_PREMIUM_MIN']);
    expect(r.premiumMin).toBe(0.5);
    expect(r.maxContractsPerEntry).toBe(3);
  });

  it('an inverted delta pair voids BOTH halves', () => {
    const r = resolveOtmContractFloor({ OTM_CONTRACT_FLOOR_DELTA_MIN: '0.5', OTM_CONTRACT_FLOOR_DELTA_MAX: '0.3' });
    expect(r.deltaMin).toBe(0.25);
    expect(r.deltaMax).toBe(0.4);
    expect(r.source).toBe('env_invalid');
    expect(r.invalidKeys).toEqual(['OTM_CONTRACT_FLOOR_DELTA_MIN', 'OTM_CONTRACT_FLOOR_DELTA_MAX']);
  });

  it('the hard DTE floor and the 1-open-row rule have no env key', () => {
    expect(MODULE_SRC).not.toMatch(/OTM_CONTRACT_FLOOR_DTE_HARD/);
    expect(MODULE_SRC).not.toMatch(/OTM_CONTRACT_FLOOR_MAX_OPEN_ROWS/);
    const r = resolveOtmContractFloor({ OTM_CONTRACT_FLOOR_DTE_HARD_FLOOR: '0', OTM_CONTRACT_FLOOR_MAX_OPEN_ROWS: '9' });
    expect(r.dteHardFloor).toBe(OTM_CONTRACT_FLOOR_DEFAULTS.dteHardFloor);
    expect(r.maxOpenRowsPerUnderlying).toBe(1);
  });
});

describe('TRA-3944 — the conflict with the armed selector band is PUBLISHED, not resolved', () => {
  it('the board floor band [0.25, 0.40] does not intersect the selector default [0.495, 0.55)', () => {
    expect(otmContractFloorBandIntersects(FLOOR, {
      min: OTM_ADMISSIBLE_DELTA_MIN_DEFAULT, max: OTM_ADMISSIBLE_DELTA_MAX_DEFAULT,
    })).toBe(false);
    expect(otmContractFloorBandIntersects(FLOOR, { min: 0.3, max: 0.5 })).toBe(true);
    expect(otmContractFloorBandIntersects(FLOOR, { min: 0.4, max: 0.5 })).toBe(true); // floor max inclusive
    expect(otmContractFloorBandIntersects(FLOOR, { min: 0.1, max: 0.25 })).toBe(false); // selector max exclusive
  });
});

describe('TRA-3944 AC4 — source-level: arm / row size / 2-row cap untouched; ordering; no exit surface', () => {
  it('the module reads none of the arm, the row size or the 2-row cap', () => {
    for (const sym of [
      'isOptionLiveOtmArmed', 'otmArmed', 'ENABLE_OPTION_LIVE_OTM', 'OPTION_LIVE_TEST_UNTIL',
      'resolveLiveOptionTestNotionalCapUsd', 'resolveLiveOptionTestMaxContracts', 'MAX_OPEN_ROWS', 'tradierLiveOptionsEnabled',
    ]) {
      expect(MODULE_SRC.includes(sym), sym).toBe(false);
    }
  });

  it('CHAIN cut sits ABOVE the selector; PICK cut sits BELOW the window and ABOVE the universe cut', () => {
    const chain = ENGINE_SRC.indexOf('const otmFloorChain = applyOtmContractFloor(result.candidates, otmFloor);');
    const selector = ENGINE_SRC.indexOf('const otmPick = selectAdmissibleOtmCandidate(otmFloorChain.admissible, {');
    const window = ENGINE_SRC.indexOf('const otmWindowReject = this.otmEntryWindowRejectReason(nominator);');
    const pick = ENGINE_SRC.indexOf('const otmFloorPick = this.otmContractFloorPickRejectReason(');
    const universe = ENGINE_SRC.indexOf('const otmUniverseReject = this.liveOtmUniverseRejectReason(sym, nominator);');
    const costBar = ENGINE_SRC.indexOf("const otmCostReject = this.costAwareGateReject('single_leg_otm', {");
    for (const i of [chain, selector, window, pick, universe, costBar]) expect(i).toBeGreaterThan(-1);
    expect(chain).toBeLessThan(selector);
    expect(selector).toBeLessThan(window);
    expect(window).toBeLessThan(pick);
    expect(pick).toBeLessThan(universe);
    expect(universe).toBeLessThan(costBar);
    // The selector no longer sees the raw chain.
    expect(ENGINE_SRC.includes('selectAdmissibleOtmCandidate(result.candidates')).toBe(false);
  });

  it('the refusal is stamped with the LOW-CARDINALITY code on the signal and on the scan-run counter', () => {
    const pick = ENGINE_SRC.indexOf('const otmFloorPick = this.otmContractFloorPickRejectReason(');
    const block = ENGINE_SRC.slice(pick, ENGINE_SRC.indexOf('\n        }\n', pick));
    expect(block).toContain('signal.signalSkipReasonCode = otmFloorPick.code;');
    expect(block).toContain('scanRun.reject(otmFloorPick.code);');
    // The reject call must sit AFTER the chain survey and BEFORE the selector
    // consult. Located by ordered indexOf rather than a brace-bounded slice:
    // TRA-4642 legitimately inserted its demoter block (its own `}` included)
    // between the survey and the refusal, which made any "up to the next
    // `}` at this indent" window end early and miss the line it was proving.
    const chain = ENGINE_SRC.indexOf('const otmFloorChain = applyOtmContractFloor(result.candidates, otmFloor);');
    const chainReject = ENGINE_SRC.indexOf('scanRun.reject(otmFloorChain.refusalCode);', chain);
    const selectorConsult = ENGINE_SRC.indexOf('selectAdmissibleOtmCandidate(otmFloorChain.admissible', chain);
    expect(chainReject).toBeGreaterThan(chain);
    expect(selectorConsult).toBeGreaterThan(chainReject);
  });

  it('both open sites carry the per-entry cap; the live count is capped AFTER the canary sizing, not instead of it', () => {
    expect(ENGINE_SRC).toContain('otmFloor.maxContractsPerEntry,');
    const live = ENGINE_SRC.indexOf('const testContracts = capOtmEntryContracts(');
    expect(live).toBeGreaterThan(-1);
    expect(ENGINE_SRC.slice(live, live + 200)).toContain('resolveLiveOptionTestContracts(askLimit, notionalCap, maxContracts)');
    // The account applies the cap as min(), after sizing and after the bounded override.
    expect(ACCOUNT_SRC).toContain("capOtmEntryContracts(throttled, { maxContractsPerEntry: maxContracts })");
  });

  it('no exit path imports the module', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const importers = files.filter((f) => readFileSync(join(HERE, f), 'utf8').includes("from './otm-contract-floor.js'"));
    // ⚠️ REPAIRED 2026-09-09 (TRA-4422): RED on `main` since `morning-brief.ts`
    // (TRA-3688, 09-04) began importing the module. It calls
    // `resolveOtmContractFloor(env)` to REPORT the floor in the brief — a read,
    // no verdict, no close — so the invariant (NO EXIT PATH REACHES THE FLOOR)
    // held; the literal was stale. Invisible because `check:deploy-build` runs
    // `tsc -b --force`, which type-checks test files without running them.
    expect(importers.sort()).toEqual([
      'index.ts', 'morning-brief.ts', 'options-account.ts', 'signal-engine.ts',
    ]);
    // And inside the engine, no `checkExits`-side call.
    const exitsAt = ENGINE_SRC.indexOf('runOptionsExitPass');
    expect(exitsAt).toBeGreaterThan(-1);
    expect(MODULE_SRC).not.toMatch(/checkExits|closeOption|sell_to_close/);
  });
});
