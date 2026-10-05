/**
 * TRA-4944 — OBSERVE-ONLY census of the exit quote's relative spread at the
 * option exit seam. Pure: no env, no I/O, no clock.
 *
 * Ruled 2026-10-04 (card `cca69ed8`, CEO under TRA-5122): shadow first, name no
 * level. This module therefore has NO threshold and refuses nothing; it only
 * accrues the histogram the level will be chosen from. `noQuote` is counted
 * apart from every spread bucket so an unmeasured exit can never read as a
 * tight one (q2a: measure, do not refuse).
 */

/** Upper edges (exclusive) of the relative-spread buckets; a final open bucket follows. */
export const EXIT_SPREAD_BUCKET_EDGES: readonly number[] = [0.025, 0.05, 0.1, 0.2, 0.4];

/** Reasons that must never be deferred by any future guard (design doc §4.2). */
const FORCED_REASONS: ReadonlySet<string> = new Set(['sl_catastrophic', 'sl_daily_close']);

export interface ExitSpreadShadowCell {
  /** Exits observed at the seam for this sleeve × mode × reason. */
  n: number;
  /** Of `n`, exits with no usable two-sided quote (⛔ never in a bucket). */
  noQuote: number;
  /** Of `noQuote`, exits priced off a `delta_backstop` model mark. */
  noQuoteDeltaBackstop: number;
  /** Counts per bucket; length EXIT_SPREAD_BUCKET_EDGES.length + 1. Sums to `n - noQuote`. */
  hist: number[];
  /** Largest relative spread seen; null when no quote-bearing exit. */
  maxSpread: number | null;
  /** True for reasons a guard may never defer. */
  forced: boolean;
}

export interface ExitSpreadShadowSnapshot {
  bucketEdges: readonly number[];
  evaluated: number;
  cells: Record<string, ExitSpreadShadowCell>;
}

export class ExitSpreadShadow {
  private evaluated = 0;
  private readonly cells = new Map<string, ExitSpreadShadowCell>();

  observe(args: {
    sleeve: string;
    mode: string;
    reason: string;
    quote: { bid: number; ask: number } | null;
    markSource: string | null;
  }): void {
    const key = `${args.sleeve}|${args.mode}|${args.reason}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        n: 0,
        noQuote: 0,
        noQuoteDeltaBackstop: 0,
        hist: new Array(EXIT_SPREAD_BUCKET_EDGES.length + 1).fill(0),
        maxSpread: null,
        forced: FORCED_REASONS.has(args.reason),
      };
      this.cells.set(key, cell);
    }
    this.evaluated += 1;
    cell.n += 1;
    const q = args.quote;
    const mid = q ? (q.bid + q.ask) / 2 : 0;
    if (!q || !Number.isFinite(mid) || mid <= 0 || q.ask < q.bid) {
      cell.noQuote += 1;
      if (args.markSource === 'delta_backstop') cell.noQuoteDeltaBackstop += 1;
      return;
    }
    const spread = (q.ask - q.bid) / mid;
    let i = EXIT_SPREAD_BUCKET_EDGES.findIndex((e) => spread < e);
    if (i < 0) i = EXIT_SPREAD_BUCKET_EDGES.length;
    cell.hist[i]! += 1;
    if (cell.maxSpread === null || spread > cell.maxSpread) cell.maxSpread = spread;
  }

  snapshot(): ExitSpreadShadowSnapshot {
    const cells: Record<string, ExitSpreadShadowCell> = {};
    for (const [k, v] of this.cells) cells[k] = { ...v, hist: [...v.hist] };
    return { bucketEdges: EXIT_SPREAD_BUCKET_EDGES, evaluated: this.evaluated, cells };
  }
}

/** Fold several snapshots (both broker envs / all user contexts). Pure. */
export function mergeExitSpreadShadow(snaps: ExitSpreadShadowSnapshot[]): ExitSpreadShadowSnapshot {
  const cells: Record<string, ExitSpreadShadowCell> = {};
  let evaluated = 0;
  for (const s of snaps) {
    evaluated += s.evaluated;
    for (const [k, v] of Object.entries(s.cells)) {
      const c = cells[k];
      if (!c) {
        cells[k] = { ...v, hist: [...v.hist] };
        continue;
      }
      c.n += v.n;
      c.noQuote += v.noQuote;
      c.noQuoteDeltaBackstop += v.noQuoteDeltaBackstop;
      c.hist = c.hist.map((x, i) => x + (v.hist[i] ?? 0));
      if (v.maxSpread !== null && (c.maxSpread === null || v.maxSpread > c.maxSpread)) c.maxSpread = v.maxSpread;
    }
  }
  return { bucketEdges: EXIT_SPREAD_BUCKET_EDGES, evaluated, cells };
}
