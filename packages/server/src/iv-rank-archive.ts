import type { ChainDay } from '@trading-app/backtest';
import type { OptionChainRow } from '@trading-app/engine';
import { atmIvFromRows, computeIvRank, MIN_IV_SAMPLES, type IvSample } from './iv-rank-store.js';

// TRA-2206 (TRA-1965) — reconstruct IV-RANK from the recorded option-chain archive.
//
// The problem this exists for. `GET /api/health/options-ideas-decomposition` on
// bqb1 reported `byIvRankBucket.unknown = 35` against a resolved cohort of 43 —
// 81% of the sample carried no IV-rank stamp. That is NOT a probe artifact and it
// is NOT a plumbing bug: the stamping path is complete end-to-end
// (`ivRankSync` → `SymbolEventContext.ivRank` → `OptionsIdeaView.ivRank` →
// `IdeaJournalEntry.ivRank` → `IdeaOutcome.ivRank`). It is null because
// `ivRankSync` itself returned null — the trailing-IV store
// (`iv-rank-store.ts`) held fewer than {@link MIN_IV_SAMPLES} samples in-window
// for that symbol at the moment the idea was surfaced. A cold store honestly
// refuses to rank, and every idea surfaced during the warm-up period is stamped
// `null` forever.
//
// Why that blocks TRA-2005. `evaluateIdeaExpectancy()` applies the IV-rank floor
// as check 3 of 6 and treats unknown as a hard fail, so checks 4 (pricing) and 5
// (E[R] / credit-width) never run on those rows. The expectancy shadow ledger
// would record ~81% `drop` attributed to a MISSING DATA FIELD rather than to a
// bad expectancy — a high drop-rate that reads as "the gate is working" when it
// is measuring nothing. QuantTrader's framing: it would be plumbing.
//
// The reconstruction. The daily chain recorder (`options-chain-recorder.ts`) has
// been writing `<DATA_DIR>/option-chains/<ET-DATE>/<SYMBOL>.json` — full chains
// plus spot — since long before the ideas feed went live. Each partition is a
// point-in-time capture stamped with its OWN capture date, so an at-the-money IV
// derived from partition D is by construction knowable on day D. Ranking an
// idea surfaced on day D against the sub-series `{ day <= D }` therefore uses
// ONLY information available at surface time.
//
// NO LOOK-AHEAD — the property that matters. {@link reconstructIvRankAt} filters
// the series to `day <= onDate` before it computes anything, and the "current
// IV" it ranks is itself drawn from a partition at/before `onDate`. A
// look-ahead-contaminated IV-rank would be strictly WORSE than a null, because
// it would silently poison every IVR-conditioned grade downstream; so when the
// backward-only window cannot support a rank this returns `null` and the row
// stays honestly `unknown`. Nothing here synthesises a value.
//
// This module is pure (no I/O, no clock, no env) — the caller supplies the
// already-loaded `ChainDay[]`. Read-only by construction: it stamps a diagnostic
// field on forward-test outcomes and never writes the journal, never reorders the
// live feed, and wires no capital.

/**
 * Trailing window for the reconstruction, in calendar days. Mirrors the live
 * store's `TRAILING_DAYS` so a reconstructed rank is the SAME statistic the live
 * `ivRankSync` path produces — not a differently-scoped one that would silently
 * shift the meaning of the `ivRank` field.
 */
export const RECONSTRUCTION_TRAILING_DAYS = 366;

// The sample floor binding this module is the store's own — the reconstruction
// deliberately does NOT get a looser one, so a back-filled rank and a live
// `ivRankSync` rank are gated identically. Re-exported so a caller reading the
// reconstruction's terms resolves the floor from here.
export { MIN_IV_SAMPLES };

/**
 * Maximum calendar-day staleness allowed between an idea's surface date and the
 * most recent chain partition at/before it. The recorder does not run on market
 * holidays and can miss a day, so requiring an exact same-day partition would
 * discard reconstructible rows; but ranking against an IV read a fortnight
 * earlier is not "IV at entry". Five days spans a long weekend plus a holiday
 * and no more.
 */
export const MAX_IV_STALENESS_DAYS = 5;

/**
 * Master switch for SEEDING the live trailing-IV store from the chain archive at
 * boot. OFF by default.
 *
 * The retrospective half of TRA-2206 (the decomposition's reconstructed coverage)
 * is read-only and needs no flag. This is the FORWARD half, and it is not
 * read-only: deepening the store makes `ivRankSync` return a number where it
 * previously returned null, which the options-research prompt reads and the
 * (separately gated) wheel IV entry filter would gate on. So it ships dark — a
 * deploy changes nothing until an operator opts in.
 */
export const IV_ARCHIVE_SEED_FLAG = 'ENABLE_IV_RANK_ARCHIVE_SEED';

/** True when the archive seed is armed. Opt-in allowlist, matching the sibling flags. */
export function isIvArchiveSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[IV_ARCHIVE_SEED_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Provenance of an outcome's IV-rank — how the value on the row was obtained. */
export type IvRankSource =
  /** Stamped live at surface time by `ivRankSync` (the journal carried it). */
  | 'journal'
  /** Re-derived here from the chain archive using only `day <= surfacedDate`. */
  | 'reconstructed'
  /** Neither available — the row is honestly unknown. */
  | 'unknown';

function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Derive a per-symbol at-the-money IV series from the recorded chain archive.
 * One sample per (symbol, partition date), ascending by date, keyed by the
 * partition's own ET date — so a sample's `day` is the day the data was captured
 * and can never be later than the information it encodes.
 *
 * Spot resolution mirrors the forward-test's `snapshotSpot`: the recorded `spot`
 * when the recorder had a quote feed, else an estimate off the chain itself. A
 * partition with no usable spot or no row carrying an IV yields no sample for
 * that symbol/day — an absent sample, never a fabricated one.
 */
export function buildIvSeriesFromChains(
  chainDays: readonly ChainDay[],
  estimateSpot: (rows: readonly OptionChainRow[]) => number | null,
): Map<string, IvSample[]> {
  const out = new Map<string, IvSample[]>();
  for (const day of chainDays) {
    for (const [symbol, snap] of day.bySymbol) {
      const spot =
        typeof snap.spot === 'number' && Number.isFinite(snap.spot) && snap.spot > 0
          ? snap.spot
          : estimateSpot(snap.rows);
      if (spot == null) continue;
      const iv = atmIvFromRows(snap.rows, spot);
      if (iv == null) continue;
      const key = symbol.toUpperCase();
      const arr = out.get(key) ?? [];
      arr.push({ day: day.date, iv });
      out.set(key, arr);
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => a.day.localeCompare(b.day));
  return out;
}

/** Why a reconstruction attempt produced no value — the diagnostic half of the answer. */
export type ReconstructionMiss =
  /** The archive holds no IV samples at all for this ticker. */
  | 'no_archive_coverage'
  /** Samples exist, but none at/before the surface date (idea predates the archive). */
  | 'no_sample_at_or_before'
  /** The nearest backward sample is older than {@link MAX_IV_STALENESS_DAYS}. */
  | 'stale_iv'
  /** Backward window holds fewer than {@link MIN_IV_SAMPLES} samples, or is flat. */
  | 'insufficient_history';

export interface ReconstructionResult {
  ivRank: number | null;
  /** Set only when `ivRank` is null — why the backward-only window couldn't support one. */
  miss: ReconstructionMiss | null;
  /** Samples in the backward window that fed the computation (0 when it never ran). */
  windowSamples: number;
}

/**
 * Reconstruct the IV-rank a symbol had on `onDate`, using ONLY samples dated at
 * or before `onDate`. The ranked "current IV" is the newest such sample (subject
 * to {@link MAX_IV_STALENESS_DAYS}), and the reference window is the trailing
 * {@link RECONSTRUCTION_TRAILING_DAYS} of samples ending at that same point.
 *
 * The `day <= onDate` filter is applied FIRST, to both the current-IV pick and
 * the window, which is what makes the output free of look-ahead. Returns a
 * `miss` reason instead of a value whenever the honest answer is "not knowable
 * from what was recorded by then".
 *
 * The sample floor is {@link MIN_IV_SAMPLES} and is NOT overridable: it is
 * enforced inside {@link computeIvRank}, so the same "don't rank a cold window"
 * discipline binds the reconstruction and the live `ivRankSync` read identically.
 */
export function reconstructIvRankAt(
  samples: readonly IvSample[],
  onDate: string,
  opts: { maxStalenessDays?: number; trailingDays?: number } = {},
): ReconstructionResult {
  const maxStaleness = opts.maxStalenessDays ?? MAX_IV_STALENESS_DAYS;
  const trailingDays = opts.trailingDays ?? RECONSTRUCTION_TRAILING_DAYS;

  if (samples.length === 0) return { ivRank: null, miss: 'no_archive_coverage', windowSamples: 0 };

  // Backward-only: everything downstream of this line sees no day after `onDate`.
  const backward = samples.filter((s) => s.day <= onDate);
  if (backward.length === 0) {
    return { ivRank: null, miss: 'no_sample_at_or_before', windowSamples: 0 };
  }

  const current = backward[backward.length - 1] as IvSample;
  if (daysBetweenDates(current.day, onDate) > maxStaleness) {
    return { ivRank: null, miss: 'stale_iv', windowSamples: 0 };
  }

  // Trailing window ends at the current sample's day, not at `onDate`, so the
  // window and the ranked value share one reference frame.
  const cutoffMs = Date.parse(`${current.day}T00:00:00Z`) - trailingDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  const window = backward.filter((s) => s.day >= cutoff);

  const rank = computeIvRank(window, current.iv);
  if (rank == null) {
    return { ivRank: null, miss: 'insufficient_history', windowSamples: window.length };
  }
  return { ivRank: rank, miss: null, windowSamples: window.length };
}
