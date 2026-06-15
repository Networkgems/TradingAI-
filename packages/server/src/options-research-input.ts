// TRA-599 (TRA-595 C4) — input fusion for the Head of Options Research pass.
//
// The agent layer (`@trading-app/agents`) owns the LLM call and the defined-risk
// / no-day-trading guardrail but is deliberately decoupled from the engine and
// the data stores. This server-side adapter is the seam that fills the gap: it
// runs the real RV + OTM-mispricing scanners over a recorded/live chain
// snapshot and fuses their candidates with the IV-rank, earnings (C1), Fed/FOMC
// + econ (C2) and news-sentiment lanes into the `OptionsResearchInput` the pass
// consumes. Pure over its inputs — the caller injects the per-symbol context so
// it stays trivially testable against a recorded chain-snapshot fixture.
import {
  findRelativeValueOpportunities,
  findMispricedOtmContracts,
  type OptionChainRow,
  type RelativeValueCandidate,
  type OtmMispricingCandidate,
  type RelativeValueScannerOptions,
  type OtmScannerOptions,
} from '@trading-app/engine';
import type {
  OptionsResearchInput,
  OptionsResearchSymbol,
  OptionsScannerCandidate,
} from '@trading-app/agents';
import type { OptionChainSnapshotFile } from './options-chain-recorder.js';

/** Matches the live scanner DTE window (21–60d) / TRA-373 / TRA-595 §3. */
const DEFAULT_MIN_DTE = 21;
const DEFAULT_MAX_DTE = 60;
const DEFAULT_MAX_CANDIDATES_PER_SYMBOL = 8;

/**
 * Point-in-time event + IV context for one symbol, resolved by the caller from
 * the IV-rank source and the C1/C2/sentiment stores. Every field is optional;
 * absent → `null`, and the pass is told it's unknown (no fabricated edge).
 */
export interface SymbolEventContext {
  /** IV-rank 0–100 (current IV's percentile in its trailing 52w range). */
  ivRank?: number | null;
  /** Days to next scheduled earnings (C1). */
  nextEarningsInDays?: number | null;
  /** Days to the next FOMC decision (C2). */
  daysToFOMC?: number | null;
  /** Human-readable nearby macro prints, e.g. ["CPI in 2d"]. */
  macroEventsNearby?: string[];
  /** Recency-weighted aggregate news sentiment −1…+1. */
  newsSentiment?: number | null;
  /** TRA-846 — coarse sector bucket for the diversification guardrail (e.g. "Technology"). */
  sector?: string | null;
}

export interface FuseOptionsResearchOptions {
  /**
   * Resolves point-in-time IV/event context for a symbol. Server callers wire
   * this to `earningsInDaysSync` / `daysToNextFOMCSync` / `eventsNearDateSync`
   * + the news-sentiment scorer; tests inject a stub. Absent → all-null context.
   */
  contextFor?: (symbol: string) => SymbolEventContext;
  /** DTE window for candidates fed to the LLM. Defaults 21–60. */
  minDteDays?: number;
  maxDteDays?: number;
  /** Cap candidates per symbol to keep the prompt (and LLM spend) bounded. Default 8. */
  maxCandidatesPerSymbol?: number;
  /** Clock seam (ms epoch). Defaults to the snapshot's `recordedAt`. */
  now?: number;
  rvOptions?: RelativeValueScannerOptions;
  otmOptions?: OtmScannerOptions;
}

function rvToCandidate(c: RelativeValueCandidate): OptionsScannerCandidate {
  return {
    optionSymbol: c.optionSymbol,
    optionType: c.optionType,
    strike: c.strike,
    expiration: c.expiration,
    daysToExpiration: c.daysToExpiration,
    mark: c.mark,
    ivUsed: c.ivUsed,
    delta: c.delta,
    classification: c.classification,
    mispricingPct: c.mispricingPct,
    source: 'relative_value',
  };
}

function otmToCandidate(c: OtmMispricingCandidate): OptionsScannerCandidate {
  return {
    optionSymbol: c.optionSymbol,
    optionType: c.optionType,
    strike: c.strike,
    expiration: c.expiration,
    daysToExpiration: c.daysToExpiration,
    mark: c.mark,
    ivUsed: c.ivUsed,
    delta: c.delta,
    classification: c.classification,
    mispricingPct: c.mispricingPct,
    source: 'otm_mispricing',
  };
}

/**
 * Fuse a single symbol's chain snapshot into an `OptionsResearchSymbol`:
 * run both scanners, project + de-duplicate candidates (RV preferred — it
 * carries the curve-fitted edge), keep only flagged (non-`fair`) rows inside
 * the DTE window, rank by |mispricing| and cap, then attach the event/IV
 * context. Returns `null` when there's no usable spot or no flagged candidate —
 * nothing for the LLM to research.
 */
export function fuseOptionsResearchSymbol(
  snapshot: OptionChainSnapshotFile,
  opts: FuseOptionsResearchOptions = {},
): OptionsResearchSymbol | null {
  const spot = snapshot.spot;
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;

  const now = opts.now ?? snapshot.recordedAt;
  const minDte = opts.minDteDays ?? DEFAULT_MIN_DTE;
  const maxDte = opts.maxDteDays ?? DEFAULT_MAX_DTE;
  const cap = opts.maxCandidatesPerSymbol ?? DEFAULT_MAX_CANDIDATES_PER_SYMBOL;
  const rows: OptionChainRow[] = snapshot.rows;

  const rv = findRelativeValueOpportunities(rows, spot, { now, ...opts.rvOptions });
  const otm = findMispricedOtmContracts(rows, spot, { now, ...opts.otmOptions });

  // RV first so its richer (curve-fitted) read wins on de-dupe by contract.
  const byContract = new Map<string, OptionsScannerCandidate>();
  for (const c of rv) if (!byContract.has(c.optionSymbol)) byContract.set(c.optionSymbol, rvToCandidate(c));
  for (const c of otm) if (!byContract.has(c.optionSymbol)) byContract.set(c.optionSymbol, otmToCandidate(c));

  const candidates = [...byContract.values()]
    .filter((c) => c.classification !== 'fair')
    .filter((c) => c.daysToExpiration >= minDte && c.daysToExpiration <= maxDte)
    .sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct))
    .slice(0, cap);

  if (candidates.length === 0) return null;

  const ctx = opts.contextFor?.(snapshot.symbol) ?? {};
  return {
    symbol: snapshot.symbol.toUpperCase(),
    spot,
    ivRank: ctx.ivRank ?? null,
    nextEarningsInDays: ctx.nextEarningsInDays ?? null,
    daysToFOMC: ctx.daysToFOMC ?? null,
    macroEventsNearby: ctx.macroEventsNearby ?? [],
    newsSentiment: ctx.newsSentiment ?? null,
    sector: ctx.sector ?? null,
    candidates,
  };
}

/**
 * Fuse a universe of chain snapshots into one `OptionsResearchInput` batch.
 * Symbols with nothing to research are dropped; the result is ready to hand to
 * `runOptionsResearch`.
 */
export function fuseOptionsResearchInput(
  snapshots: readonly OptionChainSnapshotFile[],
  asOf: number,
  opts: FuseOptionsResearchOptions & { maxIdeas?: number } = {},
): OptionsResearchInput {
  const symbols: OptionsResearchSymbol[] = [];
  for (const snap of snapshots) {
    const fused = fuseOptionsResearchSymbol(snap, opts);
    if (fused) symbols.push(fused);
  }
  return {
    asOf,
    symbols,
    ...(opts.maxIdeas != null ? { maxIdeas: opts.maxIdeas } : {}),
  };
}
