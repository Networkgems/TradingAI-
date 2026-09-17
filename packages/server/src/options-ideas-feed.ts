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
  CatalystHorizon,
  OptionsResearchResult,
  OptionsResearchInput,
  OptionsResearchSymbol,
  OptionsScannerCandidate,
} from '@trading-app/agents';
import { isCoveredStrategy, classifyHorizon, DEFAULT_DIVERSIFICATION } from '@trading-app/agents';

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
import { costEfficiencyRatio, COST_EFFICIENCY_MAX } from './options-cost-model.js';

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
  /** IV RANK 0–100 (`(IV−min)/(max−min)`, trailing 52w). NOT the percentile. */
  ivRank?: number;
  /**
   * TRA-4644 — IV PERCENTILE 0–100 (fraction of trailing sessions with IV
   * strictly below today's), off the SAME store/window as `ivRank`. Two
   * separately-named nullable fields on purpose — never one field whose
   * meaning depends on config. Absent when the store can't support it
   * (honest null upstream, below MIN_IV_SAMPLES). Display/read only;
   * nothing gates on it.
   */
  ivPercentile?: number;
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

/**
 * TRA-3122 — why the feed is what it is, as a machine-readable code.
 *
 * `ok` is the ONLY value that means "the research pass ran to completion". Every
 * other value means the slate was cut short before the ranker could judge
 * anything, and therefore that `ideas: []` carries NO information about the tape.
 */
export type OptionsIdeasAvailabilityCode =
  | 'ok'
  /** The vendor billed-out: `credit balance is too low` (the TRA-3122 outage). */
  | 'llm_credit_exhausted'
  /** The credential is present but the vendor rejected it (401 / invalid key). */
  | 'llm_auth_rejected'
  /** 429 — the credential is being throttled. */
  | 'llm_rate_limited'
  /** 5xx / overloaded — the vendor is down, nothing is wrong on our side. */
  | 'llm_provider_unavailable'
  /** The research pass threw for a reason none of the above classify. */
  | 'llm_call_failed'
  /** No Anthropic credential is configured at all. */
  | 'llm_credential_missing'
  /** The board-approved monthly research budget is spent (TRA-658). */
  | 'spend_cap_reached'
  /** No Tradier options credential to pull chains with. */
  | 'options_credentials_missing'
  /** The watchlist is empty — nothing to scan. */
  | 'watchlist_empty'
  /** Chains were requested but none came back. */
  | 'no_chains';

/**
 * TRA-3122 — the absence state for the ideas feed.
 *
 * The defect this exists to kill: `/api/options/ideas` answers `HTTP 200` with
 * `ideas: []` both when the scanner judged nothing worth trading AND when the
 * LLM vendor refused to serve the research pass. Those two states were
 * pixel-identical to every caller — the only thing separating them was a prose
 * `note`, which no monitor can alarm on and which a human has to think about.
 *
 * So: `availability.state === 'ok'` with `ideas: []` means "we looked, nothing
 * qualified". Anything else means "we never got to look".
 *
 * Monitors: a MISSING `availability` is **UNKNOWN, not ok** — it means the build
 * answering you predates TRA-3122. Treat absent as an alarm, not a pass.
 */
export interface OptionsIdeasAvailability {
  /** `ok` = the research pass completed. `degraded` = it did not run to completion. */
  state: 'ok' | 'degraded';
  code: OptionsIdeasAvailabilityCode;
  /**
   * Who has to act. `provider` is the one that pages someone — it means an
   * external vendor refused us, which no amount of retrying fixes.
   */
  scope: 'none' | 'provider' | 'config' | 'budget' | 'data';
}

/** The healthy availability — the research pass ran and the slate is a judgement. */
export const AVAILABILITY_OK: OptionsIdeasAvailability = {
  state: 'ok',
  code: 'ok',
  scope: 'none',
};

/**
 * TRA-3122 — map a thrown research-pass reason onto a machine-readable code.
 *
 * The reason is the vendor's own error text as it reached us (e.g.
 * `400 {"type":"error","error":{"type":"invalid_request_error","message":"Your
 * credit balance is too low to access the Anthropic API…"}}`). Everything that
 * does not classify lands on `llm_call_failed` — still `degraded`, still
 * `provider` scope, so an unrecognised vendor failure alarms rather than
 * disappearing into the "nothing qualified" bucket.
 */
export function classifyResearchFailure(reason: string): OptionsIdeasAvailability {
  const r = reason.toLowerCase();
  const code: OptionsIdeasAvailabilityCode = /credit balance is too low|insufficient (credit|quota)|billing/.test(r)
    ? 'llm_credit_exhausted'
    : /401|authentication_error|invalid x-api-key|permission_error|403/.test(r)
      ? 'llm_auth_rejected'
      : /429|rate_limit/.test(r)
        ? 'llm_rate_limited'
        : /\b5\d\d\b|overloaded|api_error|service unavailable/.test(r)
          ? 'llm_provider_unavailable'
          : 'llm_call_failed';
  return { state: 'degraded', code, scope: 'provider' };
}

export interface OptionsIdeasFeed {
  ideas: OptionsIdeaView[];
  noDayTrading: { enforced: boolean; minHoldDays: number; note: string };
  generatedAt: number;
  source: 'live' | 'preview' | 'non_live';
  /** Present on the non-live response (no LLM key) so the panel can explain why. */
  note?: string;
  /**
   * TRA-3122 — REQUIRED. The absence state described above. Required (not
   * optional) so every construction site has to state which of the two empty
   * feeds it is building, rather than defaulting into "healthy".
   */
  availability: OptionsIdeasAvailability;
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
      // TRA-1363 — extend the TRA-1360 not-ITM clamp to DEBIT verticals. The
      // anchor (max |mispricing| across ALL of a symbol's candidates) can land
      // deep ITM, which for a debit spread is a degenerate structure: both legs
      // are already ~fully valued, so you pay ~full width for ~zero reward (live
      // NVDA buy 90C/sell 95C at spot 196.9 → maxProfit $5 vs maxLoss $495, a
      // near-guaranteed loss) while POP/thesis describe an OTM directional bet.
      // Clamp the LONG leg to the not-ITM side of spot (call ≥ spot, put ≤ spot)
      // then snap to the chain, so the vertical is a genuine at/OTM directional
      // structure with sane reward:risk. An already-ATM/OTM anchor is honored.
      const notItmTarget = ot === 'call' ? Math.max(anchor.strike, spot) : Math.min(anchor.strike, spot);
      const kLong =
        nearestNonItmStrike(strikes, ot, spot, notItmTarget) ??
        nearestStrike(strikes, notItmTarget) ??
        anchor.strike;
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
 * TRA-1366 — the minimum cost ratio (`maxLoss / (maxLoss + maxProfit)` =
 * `debit / width`) a DEBIT vertical carrying a > 0.5 POP must clear to be
 * coherent. The cost ratio is the breakeven win-rate the structure prices in:
 * paying a tiny fraction of the width (a deep-OTM long leg) implies a near-zero
 * win rate, so a reported POP above a coin-flip is internally contradictory. A
 * deep-OTM debit spread whose per-lot loss rounds to a few dollars is then scaled
 * by the TRA-1356 cap-sizing into hundreds of lots and an absurd max-profit
 * display (live 2026-07-06T18:07Z: bear put buy 175P / sell 170P vs spot 416 —
 * ~$2/lot loss, ~$498/lot profit, 250 lots, POP 0.75). 0.25 cleanly separates a
 * legitimate at/OTM directional debit (cost ratio ~0.4) from the deep-OTM
 * lottery (cost ratio < 0.05).
 */
export const MIN_DEBIT_COST_RATIO = 0.25;

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
 * Scoped to the two credit verticals (bull_put / bear_call) and — since TRA-1363
 * — the two debit verticals (bull_call / bear_put). The four-leg condor/butterfly
 * straddle spot by construction and are not the reported defect; returning `true`
 * for them avoids false drops.
 */
export function ideaPopPlacementCoherent(
  strategy: EmittableStrategy,
  structure: ModeledStructure,
  spot: number,
  pop: number,
): boolean {
  const isCreditVertical = strategy === 'bull_put_spread' || strategy === 'bear_call_spread';
  if (isCreditVertical) {
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
  // TRA-1363 — debit verticals. A directional debit spread only makes sense as an
  // at/OTM structure the underlying has room to run into. When BOTH legs are ITM
  // it is the degenerate deep-ITM structure the ticket flags: the spread is
  // already ~fully valued, so it pays ~full width for ~zero reward (live NVDA buy
  // 90C/sell 95C at spot 196.9 → maxProfit $5 vs maxLoss $495) — incoherent with a
  // priced, enterable, > 0.5-POP directional idea. A merely ITM long paired with
  // an OTM short is a legitimate conservative spread and is NOT dropped. The
  // strike-selection clamp above already keeps both legs not-ITM, so this is
  // defense-in-depth for any residual path (thin chain, mis-mapped anchor).
  const isDebitVertical = strategy === 'bull_call_spread' || strategy === 'bear_put_spread';
  if (!isDebitVertical) return true;
  const legItm = (l: IdeaLeg): boolean => (l.optionType === 'call' ? l.strike < spot : l.strike > spot);
  const allLegsItm = structure.legs.length >= 2 && structure.legs.every(legItm);
  if (allLegsItm) return false;
  // TRA-1366 — the mirror-image defect: a deep-OTM debit vertical. The TRA-1363
  // clamp keeps the long leg out of the ITM side but does not bound how far OTM a
  // mispricing anchor can land, so a long leg far below/above spot (live bear put
  // 175P/170P vs spot 416) renders a near-worthless spread — tiny debit, ~full
  // width of "profit" — that the reported POP > 0.5 contradicts and the TRA-1356
  // cap-sizing amplifies into a hundreds-of-lots, six-figure-max-profit card.
  // Reject on the structure's own arithmetic: paying under MIN_DEBIT_COST_RATIO of
  // the width for a better-than-coin-flip claim is a free-money inconsistency.
  const denom = structure.maxLossUsd + structure.maxProfitUsd;
  const costRatio = denom > 0 ? structure.maxLossUsd / denom : 1;
  if (pop > 0.5 && costRatio < MIN_DEBIT_COST_RATIO) return false;
  return true;
}

// ── thesis reconciliation (TRA-1363) ─────────────────────────────────────────

/**
 * Deterministic, strike-free rationale per strategy — the single source of truth
 * for a card's strikes/expiration is its reconciled `legs` array (rendered
 * authoritatively in the panel's legs row), so this describes the structure's
 * direction/edge without naming any specific strike or date.
 */
const STRUCTURE_RATIONALE: Record<EmittableStrategy, string> = {
  long_call: 'Directional defined-risk long call — upside exposure with loss capped at the debit paid.',
  long_put: 'Directional defined-risk long put — downside exposure with loss capped at the debit paid.',
  bull_call_spread:
    'Bullish defined-risk debit spread — profits as the underlying rises toward the short call by expiry, loss capped at the net debit.',
  bear_put_spread:
    'Bearish defined-risk debit spread — profits as the underlying falls toward the short put by expiry, loss capped at the net debit.',
  bull_put_spread:
    'Bullish defined-risk credit spread — collects net premium and profits while the underlying holds above the short put through expiry.',
  bear_call_spread:
    'Bearish defined-risk credit spread — collects net premium and profits while the underlying stays below the short call through expiry.',
  iron_condor:
    'Neutral defined-risk credit structure — collects premium and profits while the underlying stays between the short strikes through expiry.',
  iron_butterfly:
    'Neutral defined-risk credit structure — collects premium and profits if the underlying pins near the short strikes at expiry.',
  call_calendar:
    'Defined-risk call calendar — profits from time-decay / IV differential between the near and far expirations.',
  put_calendar:
    'Defined-risk put calendar — profits from time-decay / IV differential between the near and far expirations.',
};

// A strike token: a number immediately trailed by a call/put marker (185C,
// 172.5P, "220 puts"). The leading digit is required so a bare "call"/"put" word
// or "bull call spread" is never scrubbed.
const STRIKE_TOKEN = String.raw`\$?\d+(?:\.\d+)?\s*(?:c|p|calls?|puts?)\b`;
// An expiration token: US numeric month/day (8/21, 8/7/26 — month 1-12, day 1-31,
// so ratios like "50/50" are NOT dates) or ISO (2026-07-31), optionally introduced
// by exp / expiring / for / on / dated.
const DATE_TOKEN =
  String.raw`(?:\b(?:exp(?:iration|iry|\.)?|expiring|expires?|dated|for|on)\s+)?` +
  String.raw`(?:(?:1[0-2]|0?[1-9])/(?:3[01]|[12]?\d)(?:/\d{2,4})?|\d{4}-\d{2}-\d{2})\b`;
// A leg phrase: an optional action verb + a strike token + an optional trailing
// expiration. The optional verb also sweeps up standalone strike mentions.
const LEG_PHRASE = new RegExp(
  String.raw`\b(?:(?:buy|sell|buying|selling|bought|sold|long|short|write|writing|wrote)\s+(?:the\s+)?)?` +
    `(?:${STRIKE_TOKEN})` +
    String.raw`(?:\s+${DATE_TOKEN})?`,
  'gi',
);
const STANDALONE_DATE = new RegExp(DATE_TOKEN, 'gi');
// TRA-1368 — a DTE / option-tenor figure the LLM keyed to its INTENDED
// expiration (e.g. "46-DTE OTM calls", "46-day spread"). The executed legs carry
// the authoritative expiration (and the card shows the derived `dte`), so — like
// the strike/date specifics above — strip the prose figure rather than let a
// stale "46-DTE" contradict a 25-DTE leg. Matches "<N>DTE" / "<N> DTE" /
// "<N>-DTE" (DTE is unambiguously an option tenor) and the hyphenated
// "<N>-day(s)" tenor idiom; a bare spaced "in 3 days" catalyst reference (no
// hyphen, no DTE) is deliberately NOT matched so real catalyst timing survives.
const DTE_TOKEN = String.raw`\b\d+(?:[- ]?DTE|-days?)\b`;
const STANDALONE_DTE = new RegExp(DTE_TOKEN, 'gi');

/** Collapse the whitespace / orphan-punctuation artifacts a scrub leaves behind. */
function tidyProse(s: string): string {
  return s
    .replace(/\s+\/\s+/g, ' ') // orphan slashes (spaces both sides) from removed multi-leg runs
    .replace(/\s+([,;.:])/g, '$1') // space before punctuation
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1') // collapse punctuation runs
    .replace(/(^|[.;])\s*[,;:]+/g, '$1') // orphan punctuation after a break
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:./-]+/, '') // trim leading junk
    .replace(/[\s,;:]+$/, '') // trim trailing separators
    .trim();
}

/**
 * TRA-1363 — the LLM `OptionsIdea.thesis` names the strikes/expiration the model
 * *intended* (its anchor), but the executed legs are reconciled server-side
 * (TRA-1360 not-ITM clamp, chain snapping, and this ticket's debit clamp), so the
 * prose can name strikes/dates that diverge from the legs the card actually shows
 * (live COIN bear call: thesis "Sell 170C 8/21" vs executed sell 172.5C / buy
 * 177.5C exp 7/31). The panel already renders the reconciled legs + expiration
 * authoritatively, so the thesis only needs the model's qualitative rationale.
 *
 * Strip the strike/expiration SPECIFICS (and their leg-action clause), plus any
 * DTE / option-tenor figure (TRA-1368: "46-DTE OTM calls" on a 25-DTE leg), from
 * the prose so it can never contradict the executed legs; the model's real
 * reasoning (IV-rank, events, support levels) survives untouched. When scrubbing
 * leaves nothing substantive — a thesis that was only a leg recital — fall back
 * to a deterministic, strike-free structure description. Either way the single
 * source of truth for strikes/expiration/DTE stays the reconciled `legs` array
 * (and the derived `dte`).
 */
export function reconcileThesis(thesis: string, strategy: EmittableStrategy): string {
  const scrubbed = tidyProse(
    (thesis ?? '').replace(LEG_PHRASE, ' ').replace(STANDALONE_DATE, ' ').replace(STANDALONE_DTE, ' '),
  );
  // "Substantive" = enough letters left to be a real rationale, not a comma-and-
  // conjunction husk of a removed leg recital.
  const substantive = scrubbed.replace(/[^a-z]/gi, '').length >= 12;
  if (!substantive) return STRUCTURE_RATIONALE[strategy];
  const capped = scrubbed.charAt(0).toUpperCase() + scrubbed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

// ── feed assembly ─────────────────────────────────────────────────────────────

/**
 * TRA-1368 — whole calendar days from the feed's generation DATE to the executed
 * leg's expiration, the SINGLE SOURCE OF TRUTH for the card's `dte`. The LLM's
 * `idea.dteDays` is keyed to the expiration the model *intended*; the executed
 * legs use the anchor/reconciled expiration, which the server-side clamps/snaps
 * (TRA-1360/1363) can push onto a different chain — leaving the model's DTE (and
 * the thesis "<N>-DTE" figure + catalyst horizon it drives) contradicting the
 * legs the card renders.
 *
 * Counted DATE-to-DATE at UTC midnight (not from the intraday `generatedAt`
 * instant) so it matches the engine/LLM convention: 2026-07-31 is 25 days from a
 * 2026-07-06 generation regardless of the hour it ran. Returns 0 on an
 * unparseable expiration rather than a nonsense negative/`NaN` DTE.
 */
const DAY_MS = 86_400_000;
export function dteFromExpiration(expiration: string, generatedAt: number): number {
  const expMs = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(expMs)) return 0;
  const genDateMs = Math.floor(generatedAt / DAY_MS) * DAY_MS;
  return Math.max(0, Math.round((expMs - genDateMs) / DAY_MS));
}

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

/**
 * TRA-1361 — minimum notional for a single-leg long-option (debit) idea,
 * expressed as a fraction of the per-trade risk cap. Unlike a defined-risk
 * spread, a single-leg long is deliberately NOT upsized toward the cap
 * ({@link sizeSpreadContractsToCap} only scales multi-leg lots): long premium is
 * a low-POP / high-theta bet, so scaling it up just multiplies expected decay.
 * The real failure mode is the opposite — a trivially-thin long debit (e.g. a
 * $6.50 max loss against a $500 cap ≈ 1.3%) sits below the actionable noise
 * floor and clutters the feed without moving the P&L needle. Any single-leg long
 * whose debit (its max loss) is below this fraction of the cap is suppressed.
 */
export const MIN_LONG_NOTIONAL_PCT_OF_CAP = 0.15;

/** The single-leg long-debit strategies the {@link MIN_LONG_NOTIONAL_PCT_OF_CAP} floor applies to. */
function isSingleLegLong(strategy: EmittableStrategy): boolean {
  return strategy === 'long_call' || strategy === 'long_put';
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
  // TRA-1368 — the SAME diversification policy the research pass ran under (it
  // reads `input.diversification`, defaulting to DEFAULT_DIVERSIFICATION), so the
  // horizon we re-derive against the executed leg DTE below uses the identical
  // near/medium bucket thresholds the ranker did.
  const diversification = input.diversification ?? DEFAULT_DIVERSIFICATION;
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

    // TRA-1991 — cost-efficiency gate (net-R fix). Drop any defined-risk structure
    // whose modeled round-trip cost (F1) would consume more than COST_EFFICIENCY_MAX
    // of its defined max-loss. These are the penny-wide, high-credit spreads whose
    // fixed ~$10–21 retail round-trip cost dwarfs a ~$13–25 risk denominator, so
    // their live NET R is structurally negative regardless of a marginally-positive
    // gross edge (measured −0.63 net vs +0.20 gross on bqb1, 2026-07-17). The ratio
    // is LOT-INVARIANT (cost and max-loss both scale with contracts), so evaluate on
    // the PER-LOT max-loss BEFORE sizing. Registers no idea and no intent, so an
    // uneconomic card never renders and can't be entered. Recommendation/surfacing-
    // only; live execution stays gated by TRA-1965 → TRA-532 + human sign-off.
    const costRatio = costEfficiencyRatio(structure.legs.length, structure.maxLossUsd);
    if (costRatio != null && costRatio > COST_EFFICIENCY_MAX) continue;

    // TRA-1368 — derive the DTE + catalyst horizon from the EXECUTED legs, not the
    // model's intended `idea.dteDays`. The legs are the single source of truth for
    // the time axis (as they already are for strikes/POP post TRA-1360/1363); the
    // model's DTE can diverge once the server clamps/snaps the legs onto a different
    // expiration chain, leaving a "46-DTE"/long-horizon narrative on a 25-DTE spread.
    // All legs of a modeled structure share one expiration (calendars collapse to
    // their near leg), so legs[0] is representative; fall back to the anchor exp.
    const legExpiration = structure.legs[0]?.expiration ?? anchor.expiration;
    const legDte = dteFromExpiration(legExpiration, generatedAt);
    // Re-bucket the horizon against the actual leg DTE: an option can't reach a
    // catalyst beyond its own expiration, so classifyHorizon's min(catalyst, dte)
    // caps the displayed horizon at the position's real life (long → medium when
    // the intended 46-DTE collapses to a 25-DTE leg with no nearer catalyst).
    const catalystHorizon: CatalystHorizon = classifyHorizon(sym, legDte, diversification);

    const id = `live-${ticker.toLowerCase()}-${idea.strategy}-${idea.rank}`;

    // TRA-1356 — size defined-risk spreads toward the per-trade cap so an idea's
    // capital-at-risk is a consistent fraction of the risk budget instead of a
    // single trivially-thin lot. Only multi-leg defined-risk structures scale
    // here (single-leg longs keep the RV sizing on their own open path), and
    // only when we have an account equity to measure the cap against. The lot
    // count rides on the view + intent so the entered position matches the card.
    const isMultiLeg = structure.legs.length >= 2;

    // The per-trade risk cap (TRA-1348 governor) drives both the TRA-1361
    // min-notional floor below and the TRA-1356 spread sizing; compute it once
    // when we have an account equity to measure it against.
    const capUsd = gateEnterability
      ? maxLossCapUsd(accountEquityUsd as number, maxLossPctCap ?? DEFAULT_MAX_LOSS_PCT_CAP)
      : undefined;

    // TRA-1361 — minimum-notional display floor for single-leg long-option
    // (debit) ideas. Drop any long call/put whose debit (its max loss) sits below
    // MIN_LONG_NOTIONAL_PCT_OF_CAP of the per-trade cap: it's below the actionable
    // noise floor and only clutters the feed. Do NOT resize it upward — long
    // premium scaled to the cap just multiplies expected decay (see the constant
    // doc). Registers no idea and no intent, so a sub-floor card never renders and
    // can't be entered. Multi-leg spreads keep the TRA-1356 sizing behavior.
    if (capUsd != null && isSingleLegLong(idea.strategy) && structure.maxLossUsd < capUsd * MIN_LONG_NOTIONAL_PCT_OF_CAP) {
      continue;
    }

    let contracts = 1;
    if (gateEnterability && isMultiLeg) {
      contracts = sizeSpreadContractsToCap(structure.maxLossUsd, capUsd as number);
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
      if (!structure.priced) {
        // TRA-1367 — a priced:false structure is the thin-chain FALLBACK: its legs
        // could not be priced off real chain marks, so the payoff is a fabricated
        // 1:1 placeholder (netUsd = ±maxLoss), not a real fill basis. Such an idea
        // must never be enterable — entering would open a position on a fabricated
        // basis. Flag it non-enterable with a reason and register no intent (the
        // `if (!enterable) continue` below), so the card renders as research but
        // `Paper entry` is disabled and a direct POST 404s.
        enterable = false;
        entryBlockedReason = 'structure could not be priced off live chain marks — refresh the feed';
      } else {
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
    }

    ideas.push({
      id,
      rank: idea.rank,
      ticker,
      underlyingPrice: sym.spot,
      strategy: STRATEGY_DISPLAY[idea.strategy],
      // TRA-1363 — reconcile the thesis prose against the executed legs: strip any
      // strike/expiration the LLM named from its intended anchor (which the
      // server-side clamps/snapping have since diverged from) so the card's thesis
      // can never contradict the legs row it renders beside. The legs array is the
      // single source of truth for strikes/expiration.
      thesis: reconcileThesis(idea.thesis, idea.strategy),
      pop: idea.pop,
      maxLossUsd: sizedMaxLossUsd,
      maxProfitUsd: sizedMaxProfitUsd,
      netUsd: sizedNetUsd,
      breakevens: structure.breakevens,
      ...(sym.ivRank != null ? { ivRank: sym.ivRank } : {}),
      // TRA-4644 — the percentile sibling, published beside the rank wherever
      // the rank already reaches the read surface. Independent presence: a
      // flat trailing window nulls the rank while the percentile still holds.
      ...(sym.ivPercentile != null ? { ivPercentile: sym.ivPercentile } : {}),
      // TRA-1368 — DTE + horizon derived from the executed leg expiration (the
      // single source of truth for the time axis), not the model's intended DTE.
      dte: legDte,
      events: buildEventsForSymbol(sym),
      catalystHorizon,
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
      // TRA-3122 — reached only after the research pass returned a result, so an
      // empty `ideas` here really is "nothing qualified".
      availability: AVAILABILITY_OK,
    },
    intents,
  };
}
