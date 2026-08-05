import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DailyRiskGovernor } from './signal-engine.js';

/**
 * TRA-2331 — why `n(T) = 0` is STRUCTURAL, not a fact about market conditions.
 *
 * This issue grades the risk-autopilot's tighten-only throttle where it trims a
 * ticket, and its graded cohort is the DEMO OPTION book (post-cliff demo desk
 * rows). After 7 gradeable sessions the cohort holds 29 opens and `n(T) = 0` —
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
 * So an option loss streak moves nothing the autopilot reads. The only way a
 * graded option open gets trimmed is if the EQUITY book happens to be exactly
 * two consecutive losses deep, on the same ET day, at the moment the option
 * entry fires — a window narrow enough that `n(T) = 0` is the expected reading
 * rather than an informative one.
 *
 * These tests pin that wiring. If one FAILS, the wiring changed and this
 * issue's premise must be re-derived before any `n(T)` is read as a measurement.
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
