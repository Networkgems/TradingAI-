// TRA-604 (TRA-595 C4b) — the server-side mapper from the C4 engine's
// `OptionsResearchResult` to the exact `OptionsIdeasFeed` contract the C5 panel
// (`AiOptionsIdeasPanel.tsx`) consumes. The panel flips PREVIEW → live with NO
// UI change the moment this returns ideas, so the shape here mirrors the panel's
// locally-declared contract field-for-field.
//
// The engine idea is deliberately minimal (ticker / strategy / thesis / POP /
// max-loss / dte / event-context / rank). The richer fields the payoff sketch
// needs — legs, breakevens, max-profit, net premium, structured event badges —
// are derived HERE from data we already have: the fused per-symbol context
// (spot, IV-rank, event proximity) and the live chain rows (real leg marks). The
// numeric payoff is an honest, chain-priced *sketch* (the panel frames it as a
// "What-If" preview); the thesis/POP/ranking carry the model's actual reasoning.
import type {
  DefinedRiskStrategy,
  CoveredStrategy,
  OptionsResearchResult,
  OptionsResearchInput,
  OptionsResearchSymbol,
  OptionsScannerCandidate,
} from '@trading-app/agents';
import { isCoveredStrategy } from '@trading-app/agents';

/**
 * The long-premium / spread families the ideas feed models and displays. The
 * TRA-1322 covered families (cash_secured_put / covered_call) are defined-risk
 * but sleeve-managed — they are gated out of the ideas pass, never reach this
 * module, and so are excluded from its structure/display maps.
 */
type EmittableStrategy = Exclude<DefinedRiskStrategy, CoveredStrategy>;
import type { OptionChainRow } from '@trading-app/engine';
import { evaluateMultiLegPreTrade, DEFAULT_MAX_LOSS_PCT_CAP, maxLossCapUsd } from '@trading-app/engine';
import type { DayTradingGuardrailConfig } from '@trading-app/shared';

// ── UI contract (mirrors AiOptionsIdeasPanel.tsx) ────────────────────────────
export type EventKind = 'earnings' | 'fomc' | 'cpi' | 'jobs' | 'pce' | 'fed_headline';

export interface IdeaEvent {
  kind: EventKind;
  label: string;
  daysAway: number;
}

export interface IdeaLeg {
  action: 'buy' | 'sell';
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
}

export interface OptionsIdeaView {
  id: string;
  rank: number;
  ticker: string;
  underlyingPrice?: number;
  strategy: string;
  thesis: string;
  pop: number;
  maxLossUsd: number;
  maxProfitUsd: number;
  netUsd: number;
  breakevens: number[];
  ivRank?: number;
  dte: number;
  events: IdeaEvent[];
  /**
   * TRA-846 — catalyst horizon bucket (near/medium/long) the diversification
   * re-rank assigned this idea. Carried so the panel/audit can show the slate is
   * spread across horizons. Optional for back-compat with non-live/preview views.
   */
  catalystHorizon?: 'near' | 'medium' | 'long';
  legs: IdeaLeg[];
  /**
   * TRA-1356 — the number of defined-risk combo lots this idea is sized to. The
   * displayed `maxLossUsd` / `maxProfitUsd` / `netUsd` are the FULL sized totals
   * (per-lot × `contracts`), not a single lot, so a thin $18/lot spread reads as
   * the ~$486 (27-lot) position the open path actually enters rather than a
   * rounding-error single lot. Sizing targets the per-trade cap (TRA-1348
   * governor): the largest whole-lot count whose total max loss still fits under
   * the ceiling, so every enterable spread lands above ~50% of the cap. Only
   * multi-leg defined-risk spreads scale (single-leg longs keep their RV sizing);
   * absent on preview / non-live views (no account equity to size against) and
   * defaults to 1.
   */
  contracts?: number;
  /**
   * TRA-678 (F2) — false when the payoff is a thin-chain fallback placeholder
   * (legs could not be priced off real marks). The forward-test journal carries
   * this so fallback-priced ideas can be excluded from the gate metrics. Optional
   * for back-compat with non-live/preview views that don't model a structure.
   */
  priced?: boolean;
  /**
   * TRA-1121 (TRA-1118 "Flag" policy) — false when this idea's single-lot
   * `maxLossUsd` busts the per-trade max-loss governor ceiling (TRA-1348:
   * `max(equity × cap, min($500, 5% × equity))`) and
   * the open path would reject it. The panel keeps the card visible as research
   * but renders `Paper entry` disabled. Computed through the SAME TRA-912 gate
   * (`evaluateMultiLegPreTrade`) the paper-enter path uses, so the button's
   * enabled state can never disagree with what a click would do. Optional and
   * defaults to `true` for back-compat with preview/non-live views that have no
   * account equity to gate against.
   */
  enterable?: boolean;
  /**
   * TRA-1121 — the gate's reject reason verbatim when `enterable === false`
   * (e.g. `"max loss $2435.00 (9.74%) exceeds per-trade cap $500.00"`), surfaced as
   * the disabled `Paper entry` tooltip. Absent when the idea is enterable.
   */
  entryBlockedReason?: string;
}

export interface OptionsIdeasFeed {
  ideas: OptionsIdeaView[];
  noDayTrading: { enforced: boolean; minHoldDays: number; note: string };
  generatedAt: number;
  source: 'live' | 'preview' | 'non_live';
  /** Present on the non-live response (no LLM key) so the panel can explain why. */
  note?: string;
}

/** Engine strategy id → human display string the panel renders. */
export const STRATEGY_DISPLAY: Record<EmittableStrategy, string> = {
  long_call: 'Long Call',
  long_put: 'Long Put',
  bull_call_spread: 'Bull Call Spread',
  bear_put_spread: 'Bear Put Spread',
  bull_put_spread: 'Bull Put Spread',
  bear_call_spread: 'Bear Call Spread',
  iron_condor: 'Iron Condor',
  iron_butterfly: 'Iron Butterfly',
  call_calendar: 'Call Calendar',
  put_calendar: 'Put Calendar',
};

/**
 * What `POST …/paper-enter` needs to open the idea on the paper options account.
 *
 * TRA-613 — the intent now carries the FULL modeled defined-risk structure (the
 * same one the panel renders), not just the anchor contract. Single-leg ideas
 * (`long_call` / `long_put`) still route through the existing RV long-only open
 * path off the `anchor*` fields (so they keep SL/TP/trailing + live-mark
 * management); multi-leg ideas (bull put spread, iron condor, debit spread, …)
 * route through the new defined-risk SPREAD combo path off `legs` / `netUsd` /
 * `maxLossUsd` / `maxProfitUsd` / `breakevens`. The C3 order-time DTE guard
 * applies on both paths.
 */
export interface IdeaEntryIntent {
  ticker: string;
  /** Anchor (scanner-surfaced) contract — drives the single-leg long open path. */
  optionSymbol: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
  /** Per-share mark used as the single-leg entry premium. */
  mark: number;
  /** Sign-adjusted Black-Scholes delta from the scanner. */
  delta: number;
  /** Underlying spot at build time (seeds the stale-mark backstop). */
  spot: number;
  strategy: DefinedRiskStrategy;
  /** TRA-613 — the full modeled structure (≥ 2 legs ⇒ defined-risk spread combo). */
  legs: IdeaLeg[];
  /** TRA-613 — net premium at entry, + credit / − debit, USD per 1-lot. */
  netUsd: number;
  /** TRA-613 — capped max loss (capital at risk), USD per 1-lot. */
  maxLossUsd: number;
  /** TRA-613 — capped max profit, USD per 1-lot. */
  maxProfitUsd: number;
  /** TRA-613 — payoff breakeven underlying price(s). */
  breakevens: number[];
  /** TRA-1140 — probability of profit on [0,1] (carried onto the options proposal). */
  pop: number;
  /**
   * TRA-1356 — the sized combo-lot count the feed picked to target the per-trade
   * cap (defined-risk spreads only). The paper open path enters exactly this many
   * lots (still clamped by its own cap + cash trims) so the entered position
   * matches the sized `maxLossUsd` shown on the card. `maxLossUsd` / `netUsd` /
   * `maxProfitUsd` on THIS intent stay PER-LOT (the open path multiplies by the
   * lot count itself); the feed view carries the sized totals. Absent for
   * single-leg longs, which keep their existing RV budget sizing.
   */
  contracts?: number;
}

// ── event badges ─────────────────────────────────────────────────────────────

const MACRO_PATTERNS: Array<{ re: RegExp; kind: EventKind; label: string }> = [
  { re: /\bcpi\b/i, kind: 'cpi', label: 'CPI' },
  { re: /\bpce\b/i, kind: 'pce', label: 'PCE' },
  { re: /\b(jobs|nfp|payrolls?|employment)\b/i, kind: 'jobs', label: 'Jobs' },
];

/** "CPI in 2d" → { kind:'cpi', daysAway:2 }. Returns null when nothing matches. */
function parseMacroEvent(text: string): IdeaEvent | null {
  const days = /in\s+(\d+)\s*d/i.exec(text);
  const daysAway = days ? Number(days[1]) : 0;
  for (const p of MACRO_PATTERNS) {
    if (p.re.test(text)) return { kind: p.kind, label: p.label, daysAway };
  }
  if (/\bfomc\b|\bfed\b/i.test(text)) return { kind: 'fomc', label: 'FOMC', daysAway };
  return null;
}

/**
 * Build the panel's structured event badges from a symbol's fused context:
 * earnings (C1), FOMC (C2), and any nearby macro prints. Sorted soonest-first.
 */
export function buildEventsForSymbol(sym: OptionsResearchSymbol): IdeaEvent[] {
  const events: IdeaEvent[] = [];
  if (sym.nextEarningsInDays != null && sym.nextEarningsInDays >= 0) {
    events.push({ kind: 'earnings', label: 'Earnings', daysAway: sym.nextEarningsInDays });
  }
  if (sym.daysToFOMC != null && sym.daysToFOMC >= 0) {
    events.push({ kind: 'fomc', label: 'FOMC', daysAway: sym.daysToFOMC });
  }
  for (const m of sym.macroEventsNearby) {
    const parsed = parseMacroEvent(m);
    if (parsed) events.push(parsed);
  }
  return events.sort((a, b) => a.daysAway - b.daysAway);
}

// ── chain pricing helpers ────────────────────────────────────────────────────

function rowMid(r: OptionChainRow): number | null {
  if (typeof r.bid === 'number' && typeof r.ask === 'number' && r.bid >= 0 && r.ask > 0) {
    return (r.bid + r.ask) / 2;
  }
  if (typeof r.last === 'number' && r.last > 0) return r.last;
  return null;
}

/** Distinct ascending strikes available for `(optionType, expiration)`. */
function strikesFor(rows: readonly OptionChainRow[], optionType: 'call' | 'put', expiration: string): number[] {
  const set = new Set<number>();
  for (const r of rows) if (r.optionType === optionType && r.expiration === expiration) set.add(r.strike);
  return [...set].sort((a, b) => a - b);
}

/** Median adjacent-strike gap (the contract's strike increment). */
function strikeStep(strikes: number[], spot: number): number {
  if (strikes.length >= 2) {
    const gaps = strikes.slice(1).map((s, i) => s - strikes[i]!).filter((g) => g > 0);
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)]!;
    }
  }
  return Math.max(1, Math.round(spot * 0.025));
}

function nearestStrike(strikes: number[], target: number): number | null {
  if (!strikes.length) return null;
  return strikes.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), strikes[0]!);
}

/**
 * TRA-1360 — nearest chain strike to `target` that is NOT ITM for `ot`
 * (put: strike ≤ spot; call: strike ≥ spot). Returns null when the chain has no
 * such strike on that side, so the caller can fall back to the plain nearest
 * strike. Used to keep a credit vertical's short leg off the ITM side of spot
 * (where its reported POP/credit would be incoherent) while still honoring an
 * ATM/OTM anchor unchanged. ATM (strike == spot) is treated as acceptable — the
 * reported defect is a DEEP-ITM short leg, not a coin-flip ATM one.
 */
function nearestNonItmStrike(
  strikes: number[],
  ot: 'call' | 'put',
  spot: number,
  target: number,
): number | null {
  const nonItm = strikes.filter((s) => (ot === 'put' ? s <= spot : s >= spot));
  return nearestStrike(nonItm, target);
}

function midAt(
  rows: readonly OptionChainRow[],
  optionType: 'call' | 'put',
  expiration: string,
  strike: number,
): number | null {
  const r = rows.find((x) => x.optionType === optionType && x.expiration === expiration && x.strike === strike);
  return r ? rowMid(r) : null;
}

// ── defined-risk structure modeler ───────────────────────────────────────────

export interface ModeledStructure {
  legs: IdeaLeg[];
  breakevens: number[];
  maxLossUsd: number;
  maxProfitUsd: number;
  /** + = net credit received, − = net debit paid (USD per 1-lot). */
  netUsd: number;
  /**
   * TRA-678 (F2) — true iff every leg was priced off a real chain mark. False
   * when the thin-chain fallback fired: the payoff is a placeholder
   * (`netUsd = ±maxLoss`, `maxProfit = maxLoss`) on a *fabricated* basis, not a
   * real mid-fill. The journal carries this flag so the forward-test can EXCLUDE
   * fallback-priced ideas from the gate metrics (a fabricated entry basis would
   * be scored against real later marks otherwise).
   */
  priced: boolean;
}

const CONTRACT = 100;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Model a defined-risk structure for one idea from the anchor contract + the
 * live chain. Prices each leg off real chain marks where available; when a leg
 * can't be priced (thin chain), falls back to the engine's `maxLossUsdFallback`
 * with a 1:1 reward placeholder so the panel still renders sensibly. All dollar
 * figures are per 1-lot (×100). A long call's upside is genuinely unbounded, so
 * its max profit is a sketch cap (2× the debit) — the payoff preview is a
 * What-If sketch, not a guarantee. A long put's upside is BOUNDED at
 * (strike − debit)×100 (underlying → 0); it's capped at the lesser of that true
 * max and the same 2×-debit sketch.
 */
export function modelStructure(
  strategy: EmittableStrategy,
  anchor: OptionsScannerCandidate,
  spot: number,
  rows: readonly OptionChainRow[],
  maxLossUsdFallback: number,
): ModeledStructure {
  const exp = anchor.expiration;
  const callStrikes = strikesFor(rows, 'call', exp);
  const putStrikes = strikesFor(rows, 'put', exp);
  const step = strikeStep(anchor.optionType === 'put' ? putStrikes : callStrikes, spot);

  // Credit-class strategies carry a + net; debit-class a − net.
  const isCredit =
    strategy === 'bull_put_spread' ||
    strategy === 'bear_call_spread' ||
    strategy === 'iron_condor' ||
    strategy === 'iron_butterfly';

  const fallback = (legs: IdeaLeg[], breakevens: number[]): ModeledStructure => {
    const maxLoss = Math.max(1, Math.round(maxLossUsdFallback));
    return {
      legs,
      breakevens: breakevens.map(r2),
      maxLossUsd: maxLoss,
      maxProfitUsd: maxLoss, // 1:1 placeholder when we can't price the legs
      netUsd: isCredit ? maxLoss : -maxLoss,
      priced: false, // TRA-678 (F2) — fabricated basis; excluded from forward-test
    };
  };

  const leg = (action: 'buy' | 'sell', optionType: 'call' | 'put', strike: number): IdeaLeg => ({
    action,
    optionType,
    strike,
    expiration: exp,
  });

  switch (strategy) {
    case 'long_call':
    case 'long_put': {
      const ot = strategy === 'long_call' ? 'call' : 'put';
      const k = nearestStrike(ot === 'call' ? callStrikes : putStrikes, anchor.strike) ?? anchor.strike;
      const debit = midAt(rows, ot, exp, k) ?? anchor.mark;
      if (!(debit > 0)) return fallback([leg('buy', ot, k)], [k]);
      const be = ot === 'call' ? k + debit : k - debit;
      // Call upside is genuinely unbounded → 2×-debit sketch cap. Put upside is
      // bounded at (strike − debit)×100, so cap at the lesser of the sketch and
      // that true max rather than mislabeling it "unbounded".
      const maxProfitUsd =
        ot === 'put'
          ? r2(Math.min(debit * 2, Math.max(0, k - debit)) * CONTRACT)
          : r2(debit * CONTRACT * 2);
      return {
        legs: [leg('buy', ot, k)],
        breakevens: [r2(be)],
        maxLossUsd: r2(debit * CONTRACT),
        maxProfitUsd,
        netUsd: r2(-debit * CONTRACT),
        priced: true,
      };
    }
    case 'bull_call_spread':
    case 'bear_put_spread': {
      const ot = strategy === 'bull_call_spread' ? 'call' : 'put';
      const strikes = ot === 'call' ? callStrikes : putStrikes;
      const kLong = nearestStrike(strikes, anchor.strike) ?? anchor.strike;
      const kShort = ot === 'call' ? kLong + step : kLong - step;
      const longMid = midAt(rows, ot, exp, kLong);
      const shortMid = midAt(rows, ot, exp, kShort);
      const width = Math.abs(kShort - kLong);
      const legs = [leg('buy', ot, kLong), leg('sell', ot, kShort)];
      if (longMid == null || shortMid == null) return fallback(legs, [kLong]);
      const debit = Math.max(0.01, longMid - shortMid);
      const be = ot === 'call' ? kLong + debit : kLong - debit;
      return {
        legs,
        breakevens: [r2(be)],
        maxLossUsd: r2(debit * CONTRACT),
        maxProfitUsd: r2(Math.max(0, width - debit) * CONTRACT),
        netUsd: r2(-debit * CONTRACT),
        priced: true,
      };
    }
    case 'bull_put_spread':
    case 'bear_call_spread': {
      const ot = strategy === 'bull_put_spread' ? 'put' : 'call';
      const strikes = ot === 'put' ? putStrikes : callStrikes;
      // TRA-1360 — a credit vertical's SHORT leg must be OTM (put below spot,
      // call above spot): the whole premise is that the underlying has to travel
      // THROUGH the short strike to lose, which is exactly what a > 0.5 POP and a
      // credit < width describe. The scanner anchor is picked by |mispricing|
      // across ALL of a symbol's candidates, so it can land deep ITM or on the
      // wrong side of spot (the live 2026-07-06 MSFT 270/275 deep-ITM bear call
      // vs spot 386). Clamp the short-leg target to the OTM side of spot, then
      // snap to the nearest strictly-OTM chain strike, so the rendered legs are
      // coherent with the reported POP/credit instead of pricing an ITM spread
      // as if it were OTM. An already-OTM anchor is honored unchanged.
      const otmTarget = ot === 'put' ? Math.min(anchor.strike, spot) : Math.max(anchor.strike, spot);
      const kShort =
        nearestNonItmStrike(strikes, ot, spot, otmTarget) ??
        nearestStrike(strikes, otmTarget) ??
        anchor.strike;
      const kLong = ot === 'put' ? kShort - step : kShort + step;
      const shortMid = midAt(rows, ot, exp, kShort);
      const longMid = midAt(rows, ot, exp, kLong);
      const width = Math.abs(kShort - kLong);
      const legs = [leg('sell', ot, kShort), leg('buy', ot, kLong)];
      if (shortMid == null || longMid == null) return fallback(legs, [kShort]);
      const credit = Math.max(0.01, shortMid - longMid);
      const be = ot === 'put' ? kShort - credit : kShort + credit;
      return {
        legs,
        breakevens: [r2(be)],
        maxLossUsd: r2(Math.max(0, width - credit) * CONTRACT),
        maxProfitUsd: r2(credit * CONTRACT),
        netUsd: r2(credit * CONTRACT),
        priced: true,
      };
    }
    case 'iron_condor':
    case 'iron_butterfly': {
      const center =
        strategy === 'iron_butterfly'
          ? nearestStrike(callStrikes, spot) ?? spot
          : null;
      const kPutShort =
        center ?? nearestStrike(putStrikes, spot - step) ?? Math.round(spot - step);
      const kCallShort =
        center ?? nearestStrike(callStrikes, spot + step) ?? Math.round(spot + step);
      // Snap the long wings to the chain (same as the shorts) so a listing
      // increment that differs from the median `step` doesn't push the wing onto
      // an unlisted strike — which would null out `midAt` and silently drop the
      // whole condor to the 1:1 fallback sketch.
      const kPutLong = nearestStrike(putStrikes, kPutShort - step) ?? kPutShort - step;
      const kCallLong = nearestStrike(callStrikes, kCallShort + step) ?? kCallShort + step;
      const legs = [
        leg('sell', 'put', kPutShort),
        leg('buy', 'put', kPutLong),
        leg('sell', 'call', kCallShort),
        leg('buy', 'call', kCallLong),
      ];
      const ps = midAt(rows, 'put', exp, kPutShort);
      const pl = midAt(rows, 'put', exp, kPutLong);
      const cs = midAt(rows, 'call', exp, kCallShort);
      const cl = midAt(rows, 'call', exp, kCallLong);
      if (ps == null || pl == null || cs == null || cl == null) {
        return fallback(legs, [kPutShort, kCallShort]);
      }
      const credit = Math.max(0.01, ps - pl + cs - cl);
      const width = Math.max(kCallLong - kCallShort, kPutShort - kPutLong);
      return {
        legs,
        breakevens: [r2(kPutShort - credit), r2(kCallShort + credit)],
        maxLossUsd: r2(Math.max(0, width - credit) * CONTRACT),
        maxProfitUsd: r2(credit * CONTRACT),
        netUsd: r2(credit * CONTRACT),
        priced: true,
      };
    }
    case 'call_calendar':
    case 'put_calendar': {
      // Calendars span two expirations; the scanners surface single-expiration
      // candidates, so we represent the near leg and fall back to the engine's
      // defined max-loss (the net debit) with a ~1:1 sketch.
      const ot = strategy === 'call_calendar' ? 'call' : 'put';
      const k = nearestStrike(ot === 'call' ? callStrikes : putStrikes, anchor.strike) ?? anchor.strike;
      return fallback([leg('buy', ot, k)], [k]);
    }
  }
}

// ── coherence guard (TRA-1360) ───────────────────────────────────────────────

/**
 * TRA-1360 — reject a modeled idea whose reported POP is inconsistent with where
 * its legs actually sit versus spot. The canonical failure (live 2026-07-06) was
 * a deep-ITM MSFT bear call (sell 270C / buy 275C, spot 386) rendered with
 * POP 0.72 and a near-full-width credit — numbers that describe a comfortably
 * OTM spread, not the ITM legs shown.
 *
 * The invariant for a credit vertical: a > 0.5 POP is only possible when the
 * SHORT leg is OTM, because the underlying must move THROUGH the short strike for
 * the position to lose. A short leg at or through spot (call ≤ spot, put ≥ spot)
 * is ~certain max loss, so a POP > 0.5 there is incoherent by construction.
 * TRA-1360's strike-selection fix keeps credit shorts OTM, so this guard is
 * defense-in-depth: any future path (thin chain, mis-mapped anchor) that still
 * produces an ITM-short credit spread with a high POP is dropped, never rendered.
 *
 * Scoped to the two credit verticals (bull_put / bear_call). Debit verticals and
 * the four-leg condor/butterfly straddle spot by construction and are not the
 * reported defect; returning `true` for them avoids false drops.
 */
export function ideaPopPlacementCoherent(
  strategy: EmittableStrategy,
  structure: ModeledStructure,
  spot: number,
  pop: number,
): boolean {
  const isCreditVertical = strategy === 'bull_put_spread' || strategy === 'bear_call_spread';
  if (!isCreditVertical) return true;
  const short = structure.legs.find((l) => l.action === 'sell');
  if (!short) return true;
  // ITM short leg = the option already has intrinsic value (call strike < spot,
  // put strike > spot). ATM (strike == spot) is treated as not-ITM, matching the
  // strike-selection boundary — the reported defect is a DEEP-ITM short leg.
  const shortItm = short.optionType === 'call' ? short.strike < spot : short.strike > spot;
  // A credit spread with an ITM short leg is ~certain max loss; a POP above a
  // coin-flip contradicts that placement.
  return !shortItm || pop <= 0.5;
}

// ── feed assembly ─────────────────────────────────────────────────────────────

/** Pick the anchor (highest |mispricing|) candidate for a symbol. */
function anchorCandidate(sym: OptionsResearchSymbol): OptionsScannerCandidate | null {
  if (!sym.candidates.length) return null;
  return [...sym.candidates].sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct))[0]!;
}

export interface BuildFeedArgs {
  research: OptionsResearchResult;
  input: OptionsResearchInput;
  /** Live chain rows per UPPER-CASE symbol (for leg pricing). */
  rowsBySymbol: Map<string, OptionChainRow[]>;
  guardrail: DayTradingGuardrailConfig;
  generatedAt: number;
  /**
   * TRA-1121 — the paper-options book equity to pre-flight each idea's
   * single-lot max loss against (the SAME `equity` the open path's TRA-912 gate
   * reads). When omitted (preview / non-live builds with no account), every idea
   * is left `enterable: true` for back-compat — the open path's own gate still
   * protects live entries.
   */
  accountEquityUsd?: number;
  /**
   * TRA-1121 — per-trade max-loss cap as a fraction of equity. Defaults to
   * {@link DEFAULT_MAX_LOSS_PCT_CAP} (2%), matching the open-path gate default.
   * The TRA-1348 $500 absolute floor + 5%-equity clamp apply on top via the gate.
   */
  maxLossPctCap?: number;
}

export interface BuiltFeed {
  feed: OptionsIdeasFeed;
  /** idea id → entry intent, for POST …/paper-enter. */
  intents: Map<string, IdeaEntryIntent>;
}

/**
 * TRA-1356 — how many defined-risk combo lots to size a spread idea to so its
 * capital-at-risk targets the per-trade risk cap instead of a single, often
 * trivially-thin, lot.
 *
 * A defined-risk spread has a bounded loss, so the honest way to "target a
 * consistent fraction of the risk cap" is to open the largest whole-lot count
 * whose TOTAL max loss still fits under the TRA-1348 governor ceiling
 * (`capUsd`). Flooring lands every enterable idea in `(capUsd − maxLossPerLot,
 * capUsd]`; because a single lot must already fit the cap to be enterable, that
 * range is always above 50% of the cap — which closes the capital-efficiency
 * gap where a $18/lot spread counted as "enterable" while risking a rounding
 * error on a $25k book.
 *
 * Scaling contract COUNT (not strike width) keeps the per-lot risk/reward
 * intact — POP, credit-to-max-loss, and breakevens are unchanged, only the size
 * scales — so a wider position can never silently degrade the idea's edge.
 *
 * Returns >= 1. A single lot that already busts the cap returns 1 and is caught
 * by the same pre-trade gate that flags it un-enterable, exactly as before.
 */
export function sizeSpreadContractsToCap(maxLossPerLotUsd: number, capUsd: number): number {
  if (!Number.isFinite(maxLossPerLotUsd) || maxLossPerLotUsd <= 0) return 1;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return 1;
  return Math.max(1, Math.floor(capUsd / maxLossPerLotUsd));
}

/** The C3 "no day trading" status block, surfaced verbatim to the panel. */
export function noDayTradingBlock(guardrail: DayTradingGuardrailConfig): OptionsIdeasFeed['noDayTrading'] {
  return {
    enforced: guardrail.blockSameSessionRoundTrip,
    minHoldDays: 2,
    note:
      `No day trading: 0DTE and same-session open+close are blocked; ideas target a ` +
      `${guardrail.minIdeaDteDays}–60 DTE swing window with an order-time ` +
      `${guardrail.minEntryDteDays}-day DTE floor.`,
  };
}

/**
 * Map the engine's research result to the panel feed. Each engine idea is keyed
 * to its symbol's fused context (spot / IV-rank / events) and anchor contract;
 * the structure modeler fills the payoff fields. Ideas whose symbol has no
 * anchor candidate are dropped (nothing to enter / price against).
 */
export function buildOptionsIdeasFeed(args: BuildFeedArgs): BuiltFeed {
  const { research, input, rowsBySymbol, guardrail, generatedAt, accountEquityUsd, maxLossPctCap } = args;
  // TRA-1121 — only gate enterability when we actually have an account equity to
  // measure the per-trade cap against. Preview / non-live builds pass none, and
  // every idea stays `enterable` (the open path's own gate still protects them).
  const gateEnterability = typeof accountEquityUsd === 'number' && Number.isFinite(accountEquityUsd);
  const symByTicker = new Map<string, OptionsResearchSymbol>();
  for (const s of input.symbols) symByTicker.set(s.symbol.toUpperCase(), s);

  const ideas: OptionsIdeaView[] = [];
  const intents = new Map<string, IdeaEntryIntent>();

  for (const idea of research.ideas) {
    const ticker = idea.ticker.toUpperCase();
    const sym = symByTicker.get(ticker);
    if (!sym) continue;
    const anchor = anchorCandidate(sym);
    if (!anchor) continue;
    const rows = rowsBySymbol.get(ticker) ?? [];

    // TRA-1322 defensive belt-and-suspenders: covered legs are gated out of the
    // ideas pass upstream and should never arrive here; if one ever did, skip it
    // rather than model/display a sleeve-managed short leg. Also narrows
    // idea.strategy to EmittableStrategy for the structure/display maps below.
    if (isCoveredStrategy(idea.strategy)) continue;

    const structure = modelStructure(idea.strategy, anchor, sym.spot, rows, idea.maxLossUsd);

    // TRA-1360 — coherence guard: drop any idea whose reported POP contradicts
    // where its modeled legs sit vs spot (a deep-ITM credit spread can't carry a
    // > 0.5 POP). Registers no idea and no intent, so an incoherent card never
    // renders and can't be entered. Belt-and-suspenders to the strike-selection
    // fix above, which already keeps credit shorts OTM.
    if (!ideaPopPlacementCoherent(idea.strategy, structure, sym.spot, idea.pop)) continue;

    const id = `live-${ticker.toLowerCase()}-${idea.strategy}-${idea.rank}`;

    // TRA-1356 — size defined-risk spreads toward the per-trade cap so an idea's
    // capital-at-risk is a consistent fraction of the risk budget instead of a
    // single trivially-thin lot. Only multi-leg defined-risk structures scale
    // here (single-leg longs keep the RV sizing on their own open path), and
    // only when we have an account equity to measure the cap against. The lot
    // count rides on the view + intent so the entered position matches the card.
    const isMultiLeg = structure.legs.length >= 2;
    let contracts = 1;
    if (gateEnterability && isMultiLeg) {
      const capUsd = maxLossCapUsd(
        accountEquityUsd as number,
        maxLossPctCap ?? DEFAULT_MAX_LOSS_PCT_CAP,
      );
      contracts = sizeSpreadContractsToCap(structure.maxLossUsd, capUsd);
    }
    // Sized totals for display: per-lot × lot count. Per-lot figures on the
    // intent stay per-lot (the open path multiplies by the lot count itself).
    const sizedMaxLossUsd = r2(structure.maxLossUsd * contracts);
    const sizedMaxProfitUsd = r2(structure.maxProfitUsd * contracts);
    const sizedNetUsd = r2(structure.netUsd * contracts);

    // TRA-1121 (TRA-1118 "Flag") / TRA-1356 — run the structure's SIZED max loss
    // through the SAME pre-trade gate the paper-enter path uses (per-lot max loss
    // × the sized lot count). A defined-risk combo can't be fractionally trimmed,
    // so if the sized position busts the cap the open path hard-rejects it; the
    // feed must flag it (not filter, not re-derive the inequality) so the panel
    // disables `Paper entry` with the gate's verbatim reason. Because the lot
    // count is floored to the cap, an enterable spread is always admitted; a
    // single lot that already busts the cap stays flagged exactly as before.
    // Skipped when no account equity was threaded.
    let enterable = true;
    let entryBlockedReason: string | undefined;
    if (gateEnterability) {
      const verdict = evaluateMultiLegPreTrade({
        accountEquity: accountEquityUsd as number,
        // The paper book has no live broker hold to mirror — same as the open
        // path; the per-trade max-loss cap is the binding feed constraint.
        optionBuyingPower: null,
        maxLossPerLot: structure.maxLossUsd,
        contracts,
        ...(maxLossPctCap != null ? { maxLossPctCap } : {}),
      });
      if (!verdict.allowed) {
        enterable = false;
        entryBlockedReason = verdict.reason;
      }
    }

    ideas.push({
      id,
      rank: idea.rank,
      ticker,
      underlyingPrice: sym.spot,
      strategy: STRATEGY_DISPLAY[idea.strategy],
      thesis: idea.thesis,
      pop: idea.pop,
      maxLossUsd: sizedMaxLossUsd,
      maxProfitUsd: sizedMaxProfitUsd,
      netUsd: sizedNetUsd,
      breakevens: structure.breakevens,
      ...(sym.ivRank != null ? { ivRank: sym.ivRank } : {}),
      dte: idea.dteDays,
      events: buildEventsForSymbol(sym),
      catalystHorizon: idea.catalystHorizon,
      legs: structure.legs,
      // TRA-1356 — surface the sized lot count only when we actually sized a
      // multi-leg spread against account equity (preview / single-leg omit it).
      ...(gateEnterability && isMultiLeg ? { contracts } : {}),
      priced: structure.priced,
      // Only stamp enterability when we actually gated (back-compat: preview /
      // non-live views omit it and the panel treats the idea as enterable).
      ...(gateEnterability ? { enterable } : {}),
      ...(entryBlockedReason ? { entryBlockedReason } : {}),
    });

    // TRA-1121 — guard the entry intent: an un-enterable idea registers NO
    // intent, so even a stale panel click on a (disabled) button or a direct
    // POST …/paper-enter is rejected as "idea not found" rather than reaching
    // the open path. The button is the user-facing guard; this is defense in
    // depth so the feed flag and the entry surface can't drift.
    if (!enterable) continue;

    intents.set(id, {
      ticker,
      optionSymbol: anchor.optionSymbol,
      optionType: anchor.optionType,
      strike: anchor.strike,
      expiration: anchor.expiration,
      mark: anchor.mark,
      delta: anchor.delta,
      spot: sym.spot,
      strategy: idea.strategy,
      // TRA-613 — carry the full modeled structure so paper-enter can open the
      // real defined-risk spread (not just the anchor leg).
      legs: structure.legs,
      netUsd: structure.netUsd,
      maxLossUsd: structure.maxLossUsd,
      maxProfitUsd: structure.maxProfitUsd,
      breakevens: structure.breakevens,
      pop: idea.pop,
      // TRA-1356 — carry the sized lot count so the paper open path enters the
      // same size the card shows. Per-lot payoff fields above stay per-lot; the
      // open path multiplies by this count (clamped by its own cap + cash).
      ...(gateEnterability && isMultiLeg ? { contracts } : {}),
    });
  }

  ideas.sort((a, b) => a.rank - b.rank);
  return {
    feed: {
      ideas,
      noDayTrading: noDayTradingBlock(guardrail),
      generatedAt,
      source: 'live',
    },
    intents,
  };
}
