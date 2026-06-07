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
  OptionsResearchResult,
  OptionsResearchInput,
  OptionsResearchSymbol,
  OptionsScannerCandidate,
} from '@trading-app/agents';
import type { OptionChainRow } from '@trading-app/engine';
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
  legs: IdeaLeg[];
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
export const STRATEGY_DISPLAY: Record<DefinedRiskStrategy, string> = {
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
}

const CONTRACT = 100;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Model a defined-risk structure for one idea from the anchor contract + the
 * live chain. Prices each leg off real chain marks where available; when a leg
 * can't be priced (thin chain), falls back to the engine's `maxLossUsdFallback`
 * with a 1:1 reward placeholder so the panel still renders sensibly. All dollar
 * figures are per 1-lot (×100). For genuinely unbounded long singles the max
 * profit is a sketch cap (2× the debit) — the payoff preview is a What-If
 * sketch, not a guarantee.
 */
export function modelStructure(
  strategy: DefinedRiskStrategy,
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
      return {
        legs: [leg('buy', ot, k)],
        breakevens: [r2(be)],
        maxLossUsd: r2(debit * CONTRACT),
        maxProfitUsd: r2(debit * CONTRACT * 2), // sketch cap (unbounded upside)
        netUsd: r2(-debit * CONTRACT),
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
      };
    }
    case 'bull_put_spread':
    case 'bear_call_spread': {
      const ot = strategy === 'bull_put_spread' ? 'put' : 'call';
      const strikes = ot === 'put' ? putStrikes : callStrikes;
      const kShort = nearestStrike(strikes, anchor.strike) ?? anchor.strike;
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
      const kPutLong = kPutShort - step;
      const kCallLong = kCallShort + step;
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
}

export interface BuiltFeed {
  feed: OptionsIdeasFeed;
  /** idea id → entry intent, for POST …/paper-enter. */
  intents: Map<string, IdeaEntryIntent>;
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
  const { research, input, rowsBySymbol, guardrail, generatedAt } = args;
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

    const structure = modelStructure(idea.strategy, anchor, sym.spot, rows, idea.maxLossUsd);
    const id = `live-${ticker.toLowerCase()}-${idea.strategy}-${idea.rank}`;

    ideas.push({
      id,
      rank: idea.rank,
      ticker,
      underlyingPrice: sym.spot,
      strategy: STRATEGY_DISPLAY[idea.strategy],
      thesis: idea.thesis,
      pop: idea.pop,
      maxLossUsd: structure.maxLossUsd,
      maxProfitUsd: structure.maxProfitUsd,
      netUsd: structure.netUsd,
      breakevens: structure.breakevens,
      ...(sym.ivRank != null ? { ivRank: sym.ivRank } : {}),
      dte: idea.dteDays,
      events: buildEventsForSymbol(sym),
      legs: structure.legs,
    });

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
