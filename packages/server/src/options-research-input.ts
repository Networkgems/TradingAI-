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
  blackScholesDelta,
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

// ── TRA-895 ATM-seed defaults ────────────────────────────────────────────────
// When neither scanner flags a mispricing, seed near-ATM anchors on LIQUID names
// so the research pass can still propose event/IV-driven defined-risk ideas on
// calm days (board decision on TRA-895: un-gate the AI Options Ideas generator).
// Liquidity thresholds mirror the dashboard RV gate the board referenced
// (OI ≥ 250, spread ≤ 10%) so we only seed genuinely tradeable contracts.
/**
 * TRA-895 — whether the ATM-seed un-gate is on by default. The live feed
 * (`buildIdeasFeed`) calls the fusion without overriding the option, so this is
 * the deployed behavior; the health probe surfaces it so the demo watcher can
 * confirm the ungated build is live in one read.
 */
export const ATM_SEED_ENABLED_BY_DEFAULT = true;
const DEFAULT_SEED_MIN_OPEN_INTEREST = 250;
const DEFAULT_SEED_MAX_SPREAD_PCT = 0.1;
const DEFAULT_SEED_MIN_MARK = 0.1;
/** Annualized risk-free rate for the seed delta (matches the scanners' BS default). */
const SEED_RISK_FREE_RATE = 0.045;
/** Target DTE the seed expiration is chosen closest to — the medium-horizon midpoint. */
const SEED_TARGET_DTE = 35;

/**
 * Point-in-time event + IV context for one symbol, resolved by the caller from
 * the IV-rank source and the C1/C2/sentiment stores. Every field is optional;
 * absent → `null`, and the pass is told it's unknown (no fabricated edge).
 */
export interface SymbolEventContext {
  /**
   * IV RANK 0–100: `(IV − min) / (max − min)` over the trailing 52w window.
   * NOT the percentile — the old wording here said "percentile", which is the
   * exact conflation TRA-4644 exists to keep out of this surface.
   */
  ivRank?: number | null;
  /**
   * TRA-4644 — IV PERCENTILE 0–100: the fraction of trailing sessions whose IV
   * closed strictly BELOW today's (`ivPercentileSync`). Same store, same window
   * and same mid-mark ATM-IV series as `ivRank`; honest `null` below
   * MIN_IV_SAMPLES, never 0. A separate field on purpose — the two statistics
   * must never share a name or a config-dependent meaning.
   */
  ivPercentile?: number | null;
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
  /**
   * TRA-895 — when both scanners flag nothing for a symbol, seed near-ATM call +
   * put anchors on liquid contracts so the research pass still sees the name and
   * can propose event/IV-driven defined-risk ideas on calm days. Defaults `true`
   * (the board un-gated the AI Options Ideas generator). Set `false` to restore
   * the old selective behavior (anomaly-only).
   */
  seedAtmAnchorsWhenEmpty?: boolean;
  /** Min open interest for a contract to be seed-eligible (default 250). */
  seedMinOpenInterest?: number;
  /** Max (ask − bid)/mid for a contract to be seed-eligible (default 0.10). */
  seedMaxSpreadPct?: number;
  /** Min mid quote for a seed contract — drop penny strikes (default 0.10). */
  seedMinMark?: number;
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

function rowMid(r: OptionChainRow): number | null {
  if (typeof r.bid === 'number' && typeof r.ask === 'number' && r.bid >= 0 && r.ask > 0) {
    return (r.bid + r.ask) / 2;
  }
  if (typeof r.last === 'number' && r.last > 0) return r.last;
  return null;
}

function rowSpreadPct(r: OptionChainRow, mid: number): number | null {
  if (typeof r.bid !== 'number' || typeof r.ask !== 'number' || r.ask <= 0 || mid <= 0) return null;
  return (r.ask - r.bid) / mid;
}

/**
 * TRA-895 — seed near-ATM call + put anchors for a symbol with no flagged
 * scanner candidate, so the research pass still sees a liquid name on calm days.
 *
 * Picks the single in-window expiration closest to {@link SEED_TARGET_DTE}, then
 * the liquid (OI / spread / mark thresholds) contract nearest ATM for each side.
 * Seeds are honest non-anomalies: `classification: 'fair'`, `mispricingPct: 0`,
 * `source: 'atm_seed'` — the model is instructed not to claim a mispricing edge
 * from them and to lean on IV-rank / event proximity instead. Returns [] when no
 * liquid near-ATM contract exists (thin name → still nothing to research).
 */
function buildAtmSeedCandidates(
  rows: readonly OptionChainRow[],
  spot: number,
  now: number,
  minDte: number,
  maxDte: number,
  opts: FuseOptionsResearchOptions,
): OptionsScannerCandidate[] {
  const minOi = opts.seedMinOpenInterest ?? DEFAULT_SEED_MIN_OPEN_INTEREST;
  const maxSpread = opts.seedMaxSpreadPct ?? DEFAULT_SEED_MAX_SPREAD_PCT;
  const minMark = opts.seedMinMark ?? DEFAULT_SEED_MIN_MARK;

  // DTE per expiration (anchored to the 16:00 ET close, like the scanners).
  const dteOf = (iso: string): number => {
    const target = Date.parse(`${iso}T16:00:00-04:00`);
    if (!Number.isFinite(target)) return -1;
    return Math.round((target - now) / 86_400_000);
  };

  // Pick the in-window expiration whose DTE is closest to the target horizon.
  const expirations = [...new Set(rows.map((r) => r.expiration))]
    .map((iso) => ({ iso, dte: dteOf(iso) }))
    .filter((e) => e.dte >= minDte && e.dte <= maxDte);
  if (!expirations.length) return [];
  expirations.sort((a, b) => Math.abs(a.dte - SEED_TARGET_DTE) - Math.abs(b.dte - SEED_TARGET_DTE));
  const { iso: exp, dte } = expirations[0]!;

  const seedFor = (optionType: 'call' | 'put'): OptionsScannerCandidate | null => {
    let best: { row: OptionChainRow; mark: number; dist: number } | null = null;
    for (const r of rows) {
      if (r.optionType !== optionType || r.expiration !== exp) continue;
      if (typeof r.openInterest !== 'number' || r.openInterest < minOi) continue;
      const mark = rowMid(r);
      if (mark == null || mark < minMark) continue;
      const spread = rowSpreadPct(r, mark);
      if (spread == null || spread > maxSpread) continue;
      const dist = Math.abs(r.strike - spot);
      if (!best || dist < best.dist) best = { row: r, mark, dist };
    }
    if (!best) return null;
    const iv = best.row.smvVol ?? best.row.midIv ?? 0;
    const delta =
      iv > 0
        ? blackScholesDelta({
            spot,
            strike: best.row.strike,
            timeToExpiryYears: dte / 365,
            riskFreeRate: SEED_RISK_FREE_RATE,
            volatility: iv,
            optionType,
          })
        : 0;
    return {
      optionSymbol: best.row.optionSymbol,
      optionType,
      strike: best.row.strike,
      expiration: exp,
      daysToExpiration: dte,
      mark: best.mark,
      ivUsed: iv,
      delta,
      classification: 'fair',
      mispricingPct: 0,
      source: 'atm_seed',
    };
  };

  return [seedFor('call'), seedFor('put')].filter((c): c is OptionsScannerCandidate => c != null);
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

  // TRA-895 — no statistical anomaly today? Seed near-ATM anchors on this liquid
  // name so the research pass still sees it and can propose event/IV-driven
  // defined-risk ideas (board un-gated the AI Options Ideas generator). Disabled
  // → restores the old anomaly-only behavior (symbol dropped on calm days).
  if (candidates.length === 0) {
    const seedEnabled = opts.seedAtmAnchorsWhenEmpty ?? ATM_SEED_ENABLED_BY_DEFAULT;
    if (!seedEnabled) return null;
    const seeded = buildAtmSeedCandidates(rows, spot, now, minDte, maxDte, opts);
    if (seeded.length === 0) return null;
    candidates.push(...seeded);
  }

  const ctx = opts.contextFor?.(snapshot.symbol) ?? {};
  return {
    symbol: snapshot.symbol.toUpperCase(),
    spot,
    ivRank: ctx.ivRank ?? null,
    // TRA-4644 — the percentile rides beside the rank down the whole fused
    // path. Read-only carrier: the research pass's prompt payload and batch
    // key are explicit projections that do NOT include it (deliberate — the
    // model must not see a field nothing is allowed to gate on yet).
    ivPercentile: ctx.ivPercentile ?? null,
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
