import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { OptionsRiskBreaker } from '@trading-app/engine';
import { DailyRiskGovernor, SignalEngine } from './signal-engine.js';
// TRA-3086 — the option sleeve's throttle composes at the SIZING site, so the
// composition guards read the sizing seam, not `runAutopilot`.
import {
  RISK_THROTTLE_SIZING_FLAG,
  OPTIONS_RISK_THROTTLE_SIZING_FLAG,
  isOptionsRiskThrottleSizingArmed,
  snapshotRiskThrottleSizing,
  resetRiskThrottleSizingForTests,
  type RiskThrottleSizingPath,
} from './risk-throttle-sizing.js';

/**
 * TRA-2331 / TRA-2878 / TRA-3086 — the autopilot throttle is EQUITY-fed, and the
 * options sleeve now has a throttle stage of its own that composes with it.
 *
 * ── The finding (TRA-2331) ────────────────────────────────────────────────────
 *
 * TRA-2331 grades the risk-autopilot's tighten-only throttle where it trims a
 * ticket, and its graded cohort is the DEMO OPTION book (post-cliff demo desk
 * rows). After 7 gradeable sessions the cohort held 29 opens and `n(T) = 0` —
 * the governor never read below 1.0 at a single one of them.
 *
 * That reads like "the throttle is calibrated wide and conditions were calm".
 * It is not. Three of the autopilot's four throttle triggers CANNOT be driven
 * by the book being graded:
 *
 *   loss_streak     ← `consecutiveLosses` ─┐
 *   daily_drawdown  ← `dailyPnl`           ┴─ both mutated ONLY by
 *                                             `DailyRiskGovernor.recordTrade`,
 *                                             whose every call site is EQUITY.
 *   regime_shift    ← `marketReviewGatesEnabled`, an explicit opt-in that
 *                     defaults FALSE (`resolveMarketReviewGatesEnabled`).
 *   edge_decay      ← the demo option journal — the ONE options-fed trigger —
 *                     and it needs >= 30 recent AND >= 30 baseline closed
 *                     trades for a SINGLE strategy before it can fire at all.
 *
 * Option closes are recorded against `optionsBreaker` (`OptionsRiskBreaker`), a
 * separate sleeve breaker that never reaches `evaluateRiskAutopilot`. The
 * signal-engine comment at the options exit pass says so in as many words:
 * "halt the OPTIONS sleeve independently of the equity governor".
 *
 * ── What shipped (TRA-3086, on the TRA-2878 ruling) ───────────────────────────
 *
 * The ruling did NOT fold option closes into the equity governor. `recordTrade`
 * is still equity-only at all five sites, and `runAutopilot` still receives no
 * options input — a raw loss-COUNT is the wrong ESTIMATOR for a fat-tailed,
 * theta-bleeding book, not merely the wrong wire (TRA-1023). The two books' HALT
 * paths stay decoupled.
 *
 * Instead the OPTIONS sleeve got the throttle stage it never had.
 * `OptionsRiskBreaker.riskThrottle()` bands its own `cumulativeR` and sleeve
 * drawdown strictly BELOW its existing −2R/−5% halt, and the engine composes
 * `min(equityThrottle, optionThrottle)` at the SIZING site — downstream of the
 * autopilot, at the option chokepoints only. So the wiring these tests pin is
 * unchanged in the direction TRA-2331's premise depended on, and extended in one
 * the premise did not cover.
 *
 * The consequence for `n(T)`: a graded option open no longer needs the EQUITY
 * book to be exactly two consecutive losses deep before it can carry a sub-1
 * term. It carries one whenever the OPTION sleeve is in its own band — the book
 * the ticket is actually drawn from. The option leg ships DARK behind
 * `OPTIONS_RISK_THROTTLE_SIZING_ENABLED` (the band's numbers are placeholders
 * pending QuantTrader's calibration), so today it moves the DECIDED term and the
 * `optionWouldTrims` counter while applying nothing.
 *
 * These tests pin that wiring in BOTH directions. If a `WIRING:` test fails, the
 * decoupling changed and TRA-2331's premise must be re-derived before any `n(T)`
 * is read as a measurement. If a `COMPOSITION:` test fails, the option sleeve's
 * throttle stopped reaching the option sizing path and `n(T)` is back to being
 * structurally starved.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The WIRING assertions below are regex over source, so they must themselves be
// mutation-tested — a guard that cannot fail reads exactly like a passing one.
// This seam lets the harness point at a MUTATED COPY in scratch instead of
// editing the real (and shared) signal-engine.ts. Unset in normal runs.
const ENGINE_PATH = process.env.TRA2331_ENGINE_SRC || path.join(HERE, 'signal-engine.ts');
const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf8');

/** Text of the first argument of a call, given the index of its opening paren. */
function firstArg(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i).trim();
    } else if (ch === ',' && depth === 1) return src.slice(openParen + 1, i).trim();
  }
  return '';
}

describe('TRA-2331 — the autopilot throttle is fed by the EQUITY book only', () => {
  it('BEHAVIOUR: exactly 2 equity losses drive the throttle to 0.5 (the trim window)', () => {
    const now = new Date('2026-08-04T18:00:00Z');
    const gov = new DailyRiskGovernor(() => now);

    // One loss is not enough — `lossStreakThrottleAt` is halt-1 = 2.
    gov.recordTrade(-100, 100_000);
    expect(gov.runAutopilot({ managedEquity: 100_000 }).riskThrottle).toBe(1);

    // Two: the throttle arms. THIS is the only state in which a graded option
    // open can be stamped with a sub-1 multiplier.
    gov.recordTrade(-100, 100_000);
    const armed = gov.runAutopilot({ managedEquity: 100_000 });
    expect(armed.riskThrottle).toBe(0.5);
    expect(armed.halt).toBe(false);

    // Three: HALT. New entries are blocked outright, so nothing gets stamped
    // with a trim at all — the trim window is exactly the 2-loss state and
    // closes again on the third loss.
    gov.recordTrade(-100, 100_000);
    expect(gov.runAutopilot({ managedEquity: 100_000 }).halt).toBe(true);
  });

  it('BEHAVIOUR: a win resets the streak, so the trim window does not persist', () => {
    const now = new Date('2026-08-04T18:00:00Z');
    const gov = new DailyRiskGovernor(() => now);
    gov.recordTrade(-100, 100_000);
    gov.recordTrade(-100, 100_000);
    expect(gov.runAutopilot({ managedEquity: 100_000 }).riskThrottle).toBe(0.5);

    gov.recordTrade(+100, 100_000);
    expect(gov.runAutopilot({ managedEquity: 100_000 }).riskThrottle).toBe(1);
  });

  it('BEHAVIOUR: the governor is the ONLY source of consecutiveLosses/dailyPnl', () => {
    // A governor that is never fed reports full size no matter what else the
    // engine did this session. This is what makes the call-site inventory below
    // load-bearing: the trigger is exactly as wide as `recordTrade`'s callers.
    const now = new Date('2026-08-04T18:00:00Z');
    const gov = new DailyRiskGovernor(() => now);
    const d = gov.runAutopilot({ managedEquity: 100_000 });
    expect(d.riskThrottle).toBe(1);
    expect(d.actions).toHaveLength(0);
  });

  it('WIRING: every riskGovernor.recordTrade records an EQUITY P&L, never an option', () => {
    const sites = [...ENGINE_SRC.matchAll(/this\.riskGovernor\.recordTrade\(/g)].map(
      (m) => (m.index ?? 0) + m[0].length - 1,
    );

    // Guard the guard: if the symbol is renamed away, an empty match set would
    // otherwise pass this test vacuously.
    expect(sites.length).toBeGreaterThan(0);

    for (const open of sites) {
      // The discriminator is the P&L ARGUMENT, not the surrounding neighbourhood.
      // `this.account.getState().totalEquity` supplies the equity DENOMINATOR on
      // options paths too, so any "is there equity nearby" heuristic passes on a
      // miswired option close. What cannot be faked is which close object's pnl
      // is being handed to the equity governor.
      const pnlArg = firstArg(ENGINE_SRC, open);
      expect(pnlArg.length).toBeGreaterThan(0);
      expect(pnlArg).not.toMatch(/\bopt\b|optsClosed|openOptions|optionsAccount/);
    }
  });

  it('WIRING: option closes feed optionsBreaker.recordClose, never the governor', () => {
    const sites = [...ENGINE_SRC.matchAll(/this\.optionsBreaker\.recordClose\(/g)].map((m) => m.index ?? 0);
    expect(sites.length).toBeGreaterThan(0);

    for (const at of sites) {
      // Scope to the ENCLOSING LOOP, not a character window: `flattenOnBookHalt`
      // legitimately runs an equity loop (which DOES call recordTrade) directly
      // above its options loop, so a byte-distance window would flag that as a
      // violation when the two loops are correctly separate.
      const loopStart = ENGINE_SRC.lastIndexOf('for (', at);
      expect(loopStart).toBeGreaterThan(-1);
      const loop = ENGINE_SRC.slice(loopStart, at);

      // The loop iterates an options-book close set.
      expect(/optsClosed|openOptions/.test(loop)).toBe(true);
      // And nothing in it records the close against the equity governor.
      expect(loop).not.toMatch(/this\.riskGovernor\.recordTrade\(/);
    }
  });

  it('WIRING: optionsBreaker state never reaches runAutopilot', () => {
    // `runAutopilot` receives ONLY these external signals; consecutiveLosses and
    // dailyPnl come from the governor's own equity-fed counters. If an options
    // signal is ever added here, this issue's `n(T)` premise changes.
    const call = ENGINE_SRC.slice(ENGINE_SRC.indexOf('this.riskGovernor.runAutopilot({'));
    const args = call.slice(0, call.indexOf('});') + 1);
    expect(args).not.toMatch(/optionsBreaker/);
    expect(args).not.toMatch(/optionsAccount/);
    // The one options-derived input is the edge-decay list, and it arrives via
    // the journal fold rather than the sleeve breaker.
    expect(args).toMatch(/decayingStrategies/);
  });
});

// ── TRA-3086 ────────────────────────────────────────────────────────────────
//
// The two guards above that pin the DECOUPLING are regexes over source, and a
// regex guard that can no longer match anything passes silently. The helpers
// below re-express those same two predicates as pure functions of a source
// string so they can be run against a MUTATED copy and shown to FAIL.
//
// This complements the `TRA2331_ENGINE_SRC` env seam rather than replacing it:
// that seam repoints `ENGINE_SRC` (and therefore every assertion in this file)
// at a scratch copy for a whole run, which is the right tool for auditing the
// suite from outside. These run the mutation in-process, on every ordinary CI
// run, so the guards cannot quietly rot between audits.

/** Violating `recordTrade` sites: those handed an OPTION close's P&L. */
function recordTradeSitesTakingOptionPnl(src: string): string[] {
  const opens = [...src.matchAll(/this\.riskGovernor\.recordTrade\(/g)].map(
    (m) => (m.index ?? 0) + m[0].length - 1,
  );
  return opens
    .map((open) => firstArg(src, open))
    .filter((arg) => arg.length === 0 || /\bopt\b|optsClosed|openOptions|optionsAccount/.test(arg));
}

/** True when the `runAutopilot` call is handed any options-sleeve signal. */
function runAutopilotTakesOptionsInput(src: string): boolean {
  const at = src.indexOf('this.riskGovernor.runAutopilot({');
  if (at < 0) return false;
  const call = src.slice(at);
  const args = call.slice(0, call.indexOf('});') + 1);
  return /optionsBreaker|optionsAccount/.test(args);
}

describe('MUTATION: the source-regex guards can actually fail', () => {
  it('the recordTrade guard flags an option P&L handed to the equity governor', () => {
    // Clean on the real source — the same claim the untouched WIRING test makes,
    // corroborated independently rather than restated.
    expect(recordTradeSitesTakingOptionPnl(ENGINE_SRC)).toEqual([]);

    // …and it FAILS on the exact miswiring TRA-2878 ruled against. Note the
    // mutant keeps equity vocabulary in the neighbourhood (`totalEquity` is the
    // real denominator on option paths too), so only a guard reading the P&L
    // ARGUMENT catches it — a proximity heuristic would pass this.
    const mutant = `
      const sleeveEquity = this.account.getState().totalEquity;
      for (const opt of optsClosed) {
        this.riskGovernor.recordTrade(opt.pnl ?? 0, sleeveEquity);
      }`;
    expect(recordTradeSitesTakingOptionPnl(mutant)).toHaveLength(1);
  });

  it('the recordTrade guard is not vacuous — an empty match set is caught', () => {
    // The failure mode the `sites.length > 0` assertion in the WIRING test
    // exists for: rename the symbol and the guard passes over a file it never
    // read. The count assertion is the part doing the work, so pin that it
    // separates the two cases.
    const renamed = ENGINE_SRC.replace(/this\.riskGovernor\.recordTrade\(/g, 'this.equityGov.record(');
    expect([...ENGINE_SRC.matchAll(/this\.riskGovernor\.recordTrade\(/g)].length).toBeGreaterThan(0);
    expect([...renamed.matchAll(/this\.riskGovernor\.recordTrade\(/g)].length).toBe(0);
    expect(recordTradeSitesTakingOptionPnl(renamed)).toEqual([]); // …passes vacuously
  });

  it('the runAutopilot guard flags an options signal added to the arg block', () => {
    expect(runAutopilotTakesOptionsInput(ENGINE_SRC)).toBe(false);
    const mutant = `this.riskGovernor.runAutopilot({
      managedEquity,
      decayingStrategies,
      optionsBreaker: this.optionsBreaker.snapshot(),
    });`;
    expect(runAutopilotTakesOptionsInput(mutant)).toBe(true);
  });
});

// ── TRA-3086 — the option sleeve's OWN throttle stage, composed at the sizing
//    site. This is the half TRA-2331's `n(T)` premise did not cover.
describe('COMPOSITION: the OPTION sleeve throttles its own tickets (TRA-3086)', () => {
  const OPTION_PATH: RiskThrottleSizingPath = 'options_single_leg';

  beforeEach(() => {
    resetRiskThrottleSizingForTests();
    delete process.env[RISK_THROTTLE_SIZING_FLAG];
    delete process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG];
  });

  afterEach(() => {
    delete process.env[RISK_THROTTLE_SIZING_FLAG];
    delete process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG];
  });

  /** Put the sleeve INSIDE its throttle band (−1.1R) but well short of its halt (−2R). */
  function sleeveIntoBand(engine: SignalEngine): void {
    const breaker = (engine as unknown as { _optionsBreakerForTests(): OptionsRiskBreaker })
      ._optionsBreakerForTests();
    breaker.recordClose({ pnl: -220, riskUsd: 200 }, 25_000);
    expect(breaker.isHalted()).toBe(false); // the band, not the halt
    expect(breaker.riskThrottle()).toBe(0.5);
  }

  function throttleEquity(engine: SignalEngine, throttle: number): void {
    (engine as unknown as { riskGovernor: DailyRiskGovernor }).riskGovernor.applyAutopilotDecision({
      halt: false, haltReason: null, feedStale: false, feedStaleReason: null,
      riskThrottle: throttle,
      actions: [{ kind: 'throttle', trigger: 'loss_streak', reason: 'test', throttleMultiplier: throttle }],
    });
  }

  const applied = (engine: SignalEngine, p: RiskThrottleSizingPath): number =>
    (engine as unknown as { _riskThrottleTermForTests(p: RiskThrottleSizingPath): number })
      ._riskThrottleTermForTests(p);
  const decided = (engine: SignalEngine, p: RiskThrottleSizingPath): number =>
    (engine as unknown as { _riskThrottleDecidedTermForTests(p: RiskThrottleSizingPath): number })
      ._riskThrottleDecidedTermForTests(p);
  const size = (engine: SignalEngine, p: RiskThrottleSizingPath): number =>
    (engine as unknown as { _riskSizingMultiplierForTests(p: RiskThrottleSizingPath): number })
      ._riskSizingMultiplierForTests(p);

  it('THE FIX: an option loss streak now moves the option path, with the equity book calm', () => {
    // The pre-TRA-3086 reading of this exact state was 1.0 on every term — the
    // structural `n(T) = 0`. The equity governor is untouched at 1.0 throughout.
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    expect(decided(engine, OPTION_PATH)).toBe(1); // control: calm sleeve, calm book

    sleeveIntoBand(engine);
    expect(engine.getRiskThrottle()).toBe(1); // the EQUITY governor never moved
    expect(decided(engine, OPTION_PATH)).toBe(0.5); // …and the option term did
  });

  it('DARK: the option leg decides a trim but applies nothing until its own flag arms', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo'; // equity leg armed for option paths
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    sleeveIntoBand(engine);

    expect(applied(engine, OPTION_PATH)).toBe(1); // nothing applied…
    expect(decided(engine, OPTION_PATH)).toBe(0.5); // …but the counterfactual is live
    expect(size(engine, OPTION_PATH)).toBe(1); // sizing byte-for-byte unchanged

    const stats = snapshotRiskThrottleSizing().byPath[OPTION_PATH]!;
    expect(stats).toMatchObject({
      consults: 1,
      trims: 0, // applied: dark, as it must be
      wouldTrims: 1, // composed counterfactual moved…
      optionWouldTrims: 1, // …and it is ATTRIBUTED to the sleeve, not the governor
      minOptionWouldMultiplier: 0.5,
      optionArmed: false,
      lastOptionThrottle: 0.5,
    });
    expect(snapshotRiskThrottleSizing().optionsArmed).toBe(false);
    expect(snapshotRiskThrottleSizing().totalOptionWouldTrims).toBe(1);
  });

  it('ARMED: with its flag on, the option term reaches the sized quantity', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG] = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    sleeveIntoBand(engine);

    expect(applied(engine, OPTION_PATH)).toBe(0.5);
    expect(size(engine, OPTION_PATH)).toBe(0.5);
    expect(snapshotRiskThrottleSizing().byPath[OPTION_PATH]).toMatchObject({
      trims: 1, minMultiplier: 0.5, optionArmed: true,
    });
  });

  it('the option flag is OFF by default and off for an unrecognised value', () => {
    // Fail-closed, matching `riskThrottleSizingScope`. A dark stage that armed
    // itself on a stray env value would apply an UNRATIFIED band to live sizing.
    expect(isOptionsRiskThrottleSizingArmed({})).toBe(false);
    for (const v of ['0', 'false', 'off', '', 'demo', 'all', 'maybe']) {
      expect(isOptionsRiskThrottleSizingArmed({ [OPTIONS_RISK_THROTTLE_SIZING_FLAG]: v })).toBe(false);
    }
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isOptionsRiskThrottleSizingArmed({ [OPTIONS_RISK_THROTTLE_SIZING_FLAG]: v })).toBe(true);
    }
  });

  it('SCOPED: an options-sleeve drawdown never trims an EQUITY ticket', () => {
    // TRA-2878's incoherence run backwards. If this fails, the two books' risk
    // paths have been re-coupled — the thing TRA-1023 decoupled on purpose.
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG] = '1'; // armed as hard as it goes
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    sleeveIntoBand(engine);

    for (const p of ['equity_demo', 'equity_live', 'equity_live_mirror', 'equity_cap_estimate'] as const) {
      expect(decided(engine, p)).toBe(1);
      expect(applied(engine, p)).toBe(1);
    }
    // …and the registry says the option leg did not even apply there, which is a
    // different statement from "it applied and read 1".
    size(engine, 'equity_demo');
    expect(snapshotRiskThrottleSizing().byPath.equity_demo).toMatchObject({
      optionWouldTrims: 0, lastOptionThrottle: null,
    });
    // The option path, consulted from the same engine in the same state, moved.
    size(engine, OPTION_PATH);
    expect(snapshotRiskThrottleSizing().byPath[OPTION_PATH]!.optionWouldTrims).toBe(1);
  });

  it('COMPOSES AS min(equity, option) — tighten-only, whichever book is worse', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG] = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    sleeveIntoBand(engine); // option leg = 0.5

    // Equity looser than option ⇒ the option leg wins.
    throttleEquity(engine, 0.8);
    expect(applied(engine, OPTION_PATH)).toBe(0.5);
    // Equity tighter than option ⇒ the equity leg wins. Neither can loosen the
    // other: composing a second governor can only ever pull the product down.
    throttleEquity(engine, 0.25);
    expect(applied(engine, OPTION_PATH)).toBe(0.25);
    expect(decided(engine, OPTION_PATH)).toBe(0.25);
    // And the equity path still sees the equity term alone.
    expect(applied(engine, 'equity_demo')).toBe(0.25);
  });

  it('the STAMPED term is the term that was APPLIED — TRA-2331 partitions on it', () => {
    // The drift that would be invisible: a stamp computed from the equity leg
    // alone would put a 1 on a ticket the option leg had just halved, and
    // `riskThrottleMultiplier < 1` would grade a value that was never applied.
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG] = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    sleeveIntoBand(engine);

    const stamp = (engine as unknown as {
      _riskThrottleStampForTests(p: RiskThrottleSizingPath): {
        riskThrottleMultiplier: number; riskThrottleDecided: number;
        riskThrottleSizingPath: RiskThrottleSizingPath;
      };
    })._riskThrottleStampForTests(OPTION_PATH);

    expect(stamp.riskThrottleMultiplier).toBe(0.5);
    expect(stamp.riskThrottleMultiplier).toBe(size(engine, OPTION_PATH));
    expect(stamp.riskThrottleDecided).toBe(0.5);
    expect(stamp.riskThrottleSizingPath).toBe(OPTION_PATH);
  });

  it('a HALTED sleeve still reports a trimmed term, never a looser one', () => {
    // Monotone in loss. A `halted ⇒ 1` shortcut would make the worst state the
    // sleeve can reach read as the calmest one.
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    process.env[OPTIONS_RISK_THROTTLE_SIZING_FLAG] = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    const breaker = (engine as unknown as { _optionsBreakerForTests(): OptionsRiskBreaker })
      ._optionsBreakerForTests();
    breaker.recordClose({ pnl: -200, riskUsd: 200 }, 25_000);
    breaker.recordClose({ pnl: -200, riskUsd: 200 }, 25_000);
    expect(breaker.isHalted()).toBe(true);
    expect(applied(engine, OPTION_PATH)).toBe(0.5);
  });
});
