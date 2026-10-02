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

// ── TRA-5024 — the live per-entry cap, graded as a VERDICT, not a grep ──────
//
// The rule being guarded is a capital bound on the live OTM sleeve: the
// per-entry contract cap must be applied **AFTER** the canary sizing, never
// INSTEAD of it. `cap(size(...))` bounds a sized count; `cap(maxContracts)`
// throws the sizing away and can hand the book MORE contracts than the canary
// ask-notional fit allows.
//
// Two separate failures have now been paid for on this one assertion:
//   • TRA-3401 (`c8488569`) renamed the receiving binding `testContracts` →
//     `sizedTestContracts`. A literal `indexOf` of the binding name returned
//     -1 and the test read `expected -1 to be greater than -1` — RED for a
//     week while the bound itself survived byte-identical.
//   • That red SHORT-CIRCUITED the account-side assertion two lines below it,
//     so the second open site's cap went unchecked the whole time. One blind
//     anchor hid a further invariant. (TRA-5024, found while shipping
//     TRA-4990.)
//
// So this helper separates the two outcomes the old grep conflated:
//   • anchors gone entirely  ⇒ **THROWS** (`BLIND:`). "I could not check" must
//     not share an outcome with "I checked and the cap moved".
//   • anchors present        ⇒ a named verdict, including the two WRONG shapes,
//     so the negative controls below can assert the predicate reports exactly
//     the defect that was planted.
const LIVE_SIZING_CALL = 'resolveLiveOptionTestContracts(askLimit, notionalCap, maxContracts)';
const CAP_CALL = 'capOtmEntryContracts(';

type LiveCapVerdict =
  /** `cap(size(...), otmFloor)` — the invariant. */
  | 'cap_wraps_sizing'
  /** The cap is called, but not on the sized count — the capital defect. */
  | 'cap_instead_of_sizing'
  /** Sizing is called and never capped — the other capital defect. */
  | 'sizing_uncapped';

/** Balanced-paren argument text of the call whose `(` ends at `openParenEnd`. */
function callArgText(src: string, openParenEnd: number): string | null {
  let depth = 1;
  for (let i = openParenEnd; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenEnd, i);
    }
  }
  return null;
}

/** Split an argument list on TOP-LEVEL commas only. */
function splitTopLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  // Whitespace-normalised: the call is wrapped across four physical lines in
  // the engine, and TRA-3953 was defeated by exactly that line break.
  return out.map((a) => a.replace(/\s+/g, ' ').trim()).filter((a) => a.length > 0);
}

/**
 * Grade how the live canary count is capped.
 *
 * @throws if BOTH anchors are absent — the region was restructured past what
 *   this predicate can read, which is BLIND, not a verdict.
 */
function liveOtmCapNesting(source: string): { verdict: LiveCapVerdict; binding: string } {
  const sizingAt = source.indexOf(LIVE_SIZING_CALL);
  const capAt = source.indexOf(CAP_CALL);
  if (sizingAt < 0 && capAt < 0) {
    throw new Error(
      'BLIND: neither the canary sizing call nor the per-entry cap call is present in '
      + 'signal-engine.ts. This predicate cannot grade whether the cap wraps the sizing — '
      + 're-anchor it. Do NOT read this as the cap having been removed.',
    );
  }
  // The binding that receives the capped count, for the one-shot clamp check.
  const bindingAt = capAt >= 0 ? source.lastIndexOf('const ', capAt) : -1;
  const binding = bindingAt >= 0
    ? (/^const (\w+)/.exec(source.slice(bindingAt, bindingAt + 80))?.[1] ?? '')
    : '';

  // Does ANY `capOtmEntryContracts(` take the sizing call as its FIRST argument?
  for (let at = source.indexOf(CAP_CALL); at >= 0; at = source.indexOf(CAP_CALL, at + 1)) {
    const args = callArgText(source, at + CAP_CALL.length);
    if (args === null) continue;
    const parts = splitTopLevelArgs(args);
    if (parts[0] === LIVE_SIZING_CALL) {
      // ...and bounded by the floor, not by some looser ceiling.
      if (parts[1] !== 'otmFloor') {
        throw new Error(
          `BLIND: the cap wraps the sizing but its bound argument reads \`${parts[1]}\`, `
          + 'not `otmFloor`. The shape this predicate grades has changed — re-anchor it.',
        );
      }
      const b = source.lastIndexOf('const ', at);
      return {
        verdict: 'cap_wraps_sizing',
        binding: b >= 0 ? (/^const (\w+)/.exec(source.slice(b, b + 80))?.[1] ?? binding) : binding,
      };
    }
  }
  if (capAt >= 0) return { verdict: 'cap_instead_of_sizing', binding };
  return { verdict: 'sizing_uncapped', binding };
}

// ⚠️ TRA-5024 — SCOPE OF THIS REPAIR, so nobody reads it as broader coverage
// than it is. Every assertion in this `describe` is a SOURCE GREP, and they all
// share the staleness class that produced TRA-4422, TRA-5021 and TRA-5024: a
// literal pinned to a name someone may legitimately rename, invisible to
// `check:deploy-build` because `tsc -b --force` type-checks test files without
// running them.
//
//   RE-ANCHORED by TRA-5024 (now BLIND-on-missing-anchor, with controls):
//     • the live per-entry cap / canary-sizing nesting      → 4 `it`s + controls
//     • the TRA-3401 one-shot grant clamp                   → newly guarded;
//       it had NO assertion at all before this ticket
//
//   RE-VERIFIED ONLY (ran green at `f4f84d3c`, 24/24; literals left as-is,
//   NOT hardened — they remain rename-fragile):
//     • 'the module reads none of the arm, …'   — negative greps; a rename makes
//       these pass VACUOUSLY rather than fail. Weakest of the four.
//     • 'CHAIN cut sits ABOVE the selector…'    — ordering; does guard each
//       anchor with `toBeGreaterThan(-1)`, so it fails RED, never silently.
//     • 'the refusal is stamped with the LOW-CARDINALITY code…' — the `pick`
//       index is NOT guarded before being used as a slice bound; a moved anchor
//       slices from -1 and the `toContain`s fail for the wrong reason.
//     • 'no exit path imports the module'       — importer roster; already
//       repaired once (TRA-4422) and will rot again on the next new importer.
//
// No capital behaviour is in scope here: the bound itself is correct and was
// verified unchanged. This is a guard repair only.
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
    // TRA-4745 added the positional `sym` argument; the ordering this test
    // guards is unchanged.
    const costBar = ENGINE_SRC.indexOf("const otmCostReject = this.costAwareGateReject('single_leg_otm', sym, {");
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

  // ── TRA-5024 — split from ONE `it` into four. ──────────────────────────────
  // These four assertions were a single `it` whose FIRST line was a stale
  // binding-name grep. When it returned -1 the `it` aborted, and the three
  // assertions below it — including the account-side cap, the second open
  // site's only guard — never ran at all. A short-circuit code is evidence
  // only about the assertions that ran BEFORE it. Splitting them means one
  // blind anchor can no longer hide the others; each site is now independently
  // reported in the same run.

  it('ENGINE: the per-entry cap WRAPS the canary sizing (applied AFTER it, not instead of it)', () => {
    // Throws `BLIND:` rather than going red if the anchors are gone — see
    // `liveOtmCapNesting`. A red here means the CAPITAL BOUND moved.
    expect(liveOtmCapNesting(ENGINE_SRC).verdict).toBe('cap_wraps_sizing');
  });

  it('ENGINE: the TRA-3401 one-shot grant clamp is a TIGHTENING on top of the capped count', () => {
    // A grant-capped count must not be able to pass as an un-capped one: the
    // `Math.min(1, …)` clamp has to take the ALREADY-CAPPED binding as its
    // operand, and the non-grant arm has to be that same binding. If the clamp
    // were layered on the RAW sizing instead, the grant path would be tight
    // (1 contract) while the ordinary path silently lost the floor bound.
    const { verdict, binding } = liveOtmCapNesting(ENGINE_SRC);
    expect(verdict).toBe('cap_wraps_sizing');
    expect(binding, 'BLIND: could not read the binding that receives the capped count').toBeTruthy();
    const clampAt = ENGINE_SRC.indexOf('oneShotGrantPending');
    if (clampAt < 0) {
      throw new Error('BLIND: `oneShotGrantPending` (TRA-3401) is absent from signal-engine.ts — the one-shot clamp cannot be graded here.');
    }
    // Statement-scoped and whitespace-normalised: the ternary is wrapped across
    // three physical lines, so a single-line slice reads a bare fragment.
    const stmtStart = ENGINE_SRC.lastIndexOf('const ', ENGINE_SRC.indexOf('? Math.min(1,'));
    const stmt = ENGINE_SRC.slice(stmtStart, ENGINE_SRC.indexOf(';', stmtStart) + 1).replace(/\s+/g, ' ');
    expect(stmt).toBe(
      `const testContracts = oneShotGrantPending ? Math.min(1, ${binding}) : ${binding};`,
    );
  });

  it('ACCOUNT: the cap is applied as min(), after sizing and after the bounded override', () => {
    // Independent of the engine-side greps above — this is the assertion the
    // old short-circuit suppressed, and it is the only guard on the second
    // open site (`OptionsAccount.otmSizedContracts`, extracted by TRA-4990).
    expect(ACCOUNT_SRC).toContain('capOtmEntryContracts(throttled, { maxContractsPerEntry: maxContracts })');
  });

  it('both open sites carry the per-entry cap', () => {
    expect(ENGINE_SRC).toContain('otmFloor.maxContractsPerEntry,');
  });

  it('NEGATIVE CONTROL — the predicate reports the cap applied INSTEAD of the sizing, and an UNCAPPED sizing', () => {
    // Plant each wrong shape on a synthetic source and assert the repaired
    // predicate names exactly that defect. A repaired census that cannot go
    // red is the same silent green it replaced.
    //
    // (1) the capital defect: the cap is called, but on the raw ops ceiling —
    //     the canary ask-notional fit is thrown away, so the book can be handed
    //     more contracts than the notional cap allows.
    const capInsteadOfSizing = `
          const sizedTestContracts = capOtmEntryContracts(maxContracts, otmFloor);
    `.replace(/\r\n/g, '\n');
    expect(liveOtmCapNesting(capInsteadOfSizing).verdict).toBe('cap_instead_of_sizing');

    // (2) the other direction: sized, never capped — the per-entry floor bound
    //     is simply absent.
    const sizingUncapped = `
          const sizedTestContracts = ${LIVE_SIZING_CALL};
    `.replace(/\r\n/g, '\n');
    expect(liveOtmCapNesting(sizingUncapped).verdict).toBe('sizing_uncapped');

    // (3) BLIND, not red: both anchors gone ⇒ throws, and says so by name.
    expect(() => liveOtmCapNesting('const x = 1;\n')).toThrow(/^BLIND: neither the canary sizing call/);

    // (4) BLIND: the cap wraps the sizing but the bound argument is not the floor.
    expect(() => liveOtmCapNesting(
      `const sizedTestContracts = capOtmEntryContracts(${LIVE_SIZING_CALL}, someOtherCeiling);`,
    )).toThrow(/^BLIND: the cap wraps the sizing but its bound argument/);

    // (5) POSITIVE control — the real shape, reconstructed, grades clean. Proves
    //     (1)–(4) are not passing merely because the helper rejects everything.
    expect(liveOtmCapNesting(
      `const sizedTestContracts = capOtmEntryContracts(\n  ${LIVE_SIZING_CALL},\n  otmFloor,\n);`,
    )).toEqual({ verdict: 'cap_wraps_sizing', binding: 'sizedTestContracts' });
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
