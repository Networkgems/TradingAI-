import { sectorOf, type Candle } from '@trading-app/shared';

/**
 * TRA-4720 (parent TRA-4413, item 5 of the TRA-4412 swing-OTM spec comparison)
 * — RELATIVE STRENGTH of a name vs SPY / QQQ / its sector ETF, SHADOW-FIRST.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * Nothing on the options path measured a name against the market. Two swing
 * scanners nonetheless CONSUME a `relativeStrength` input that nothing supplied:
 * `momentum-breakout-iv-lag-scanner.ts` gates on `minRelativeStrength: 80` and
 * `post-earnings-iv-crush-scanner.ts` on its continuation/reversal bounds — both
 * only `if (relativeStrength !== undefined)`, so the gates are fail-open by
 * omission, and the momentum scanner stamps a fabricated `relativeStrength ?? 50`
 * into its signal and score. This module is the measurement they were missing.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *   • NOT a gate, NOT a ranking cut, NOT a composite (TRA-4413 explicitly lists
 *     the 0-100 composite with a >=75 cut as not-to-build). It measures and
 *     publishes. The only place a value reaches a decision is the two scanners
 *     above, which ALREADY carry their own thresholds, and only under the flag.
 *   • NO threshold is chosen here (TRA-3392 §6). The lookbacks and the
 *     percentile window below are PRE-REGISTERED constants, fixed before any
 *     reading exists, and stated on TRA-4720 before the first measured row.
 *
 * ── PRE-REGISTERED DEFINITIONS (TRA-4720, 2026-09-18) ────────────────────────
 *   • Spread(L, B) = (close_t / close_{t-L} - 1) - (B_t / B_{t-L} - 1), in
 *     fractional return, over the name's and benchmark's DATE-ALIGNED daily
 *     closes (UTC date of each bar; Yahoo stamps the session open, Tradier
 *     midnight UTC — both land on the session's date). `t` is the latest date
 *     BOTH series hold, so a benchmark one session behind is scored on the
 *     common date, never on mismatched days.
 *   • L ∈ {21, 63} sessions (~1 and ~3 months): the conventional RS horizons,
 *     both inside the 120-bar daily cache (`OTM_DAILY_SERIES_BARS`).
 *   • B ∈ {SPY, QQQ, sector ETF} where sector ETF = SPDR select-sector ETF of
 *     `sectorOf(symbol)` (map below). Unmapped sectors are NOT imputed to SPY.
 *   • `percentile` (the 0-100 scale the scanners consume) = the percentile rank
 *     of TODAY's 63-session spread vs SPY within the SAME name's trailing
 *     rolling 63-session spreads vs SPY over the aligned window (share of the
 *     prior samples strictly below today's, ties count half, ×100). It needs
 *     at least {@link RS_PERCENTILE_MIN_SAMPLES} prior samples; fewer ⇒ null.
 *     A per-name time-series rank, not a cross-sectional universe rank: the
 *     seam scores one nominee at a time and a universe rank over a partially
 *     warm cache would rank against whichever names happened to be cached.
 */

export const OTM_RELATIVE_STRENGTH_SHADOW_FLAG = 'ENABLE_OTM_RELATIVE_STRENGTH_SHADOW';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff RS is computed, stamped, counted and supplied to the scanners. Default OFF. */
export function isOtmRelativeStrengthShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[OTM_RELATIVE_STRENGTH_SHADOW_FLAG]);
}

/** Pre-registered lookbacks, in trading sessions. See the module block. */
export const RS_LOOKBACKS = [21, 63] as const;
export type RsLookback = (typeof RS_LOOKBACKS)[number];

/** Lookback + benchmark behind the 0-100 `percentile`. Pre-registered. */
export const RS_PERCENTILE_LOOKBACK: RsLookback = 63;
/** Prior rolling samples the percentile needs. Pre-registered. */
export const RS_PERCENTILE_MIN_SAMPLES = 20;

/** SPDR select-sector ETF per `sectorOf` bucket. `Index`/`Crypto`/`Other` are unmapped. */
export const SECTOR_ETF_BY_SECTOR: Readonly<Record<string, string>> = {
  Technology: 'XLK',
  'Communication Services': 'XLC',
  'Consumer Discretionary': 'XLY',
  Financials: 'XLF',
};

export const RS_BENCHMARK_LEGS = ['spy', 'qqq', 'sector'] as const;
export type RsBenchmarkLeg = (typeof RS_BENCHMARK_LEGS)[number];

/** Every symbol this module can ask the daily cache for, besides the name. */
export const RS_BENCHMARK_SYMBOLS: readonly string[] = [
  'SPY',
  'QQQ',
  ...Object.values(SECTOR_ETF_BY_SECTOR),
];

/**
 * Low-cardinality per-leg reason codes. `no_name_bars` / `no_benchmark_bars`
 * mean the daily cache had nothing READABLE (absent or stale — the feed's
 * property); `insufficient_overlap` means readable series too short on their
 * common dates for the lookback (the symbol's property). Kept apart for the
 * TRA-4424 reason: a cold cache must never launder into "too short".
 */
export const RS_REASON_CODES = [
  'ok',
  'no_name_bars',
  'no_benchmark_bars',
  'insufficient_overlap',
  'unmapped_sector',
  'benchmark_is_self',
] as const;
export type RsReasonCode = (typeof RS_REASON_CODES)[number];

/** `percentile` adds one code of its own on top of its SPY leg's. */
export const RS_PERCENTILE_CODES = [...RS_REASON_CODES, 'insufficient_history'] as const;
export type RsPercentileCode = (typeof RS_PERCENTILE_CODES)[number];

export interface RsLegReading {
  /** The benchmark ticker, or null when the sector is unmapped. */
  readonly benchmark: string | null;
  readonly code: RsReasonCode;
  /** Common-date bars the leg was scored on (0 when a side was unreadable). */
  readonly alignedBars: number;
  /** Raw spreads (fractional return), per lookback. Null ⇔ that lookback could not be scored. */
  readonly spreads: Readonly<Record<`d${RsLookback}`, number | null>>;
  /** The common date the spread is taken at (YYYY-MM-DD), or null. */
  readonly asOfDate: string | null;
}

export interface RelativeStrengthReading {
  readonly symbol: string;
  readonly sector: string;
  readonly legs: Readonly<Record<RsBenchmarkLeg, RsLegReading>>;
  /** 0-100, per the pre-registered definition. NEVER a placeholder: null when unmeasured. */
  readonly percentile: number | null;
  readonly percentileCode: RsPercentileCode;
}

/** A readable daily series, or `readable: false` for an absent/stale cache read. */
export interface RsSeriesRead {
  readonly bars: readonly Candle[];
  readonly readable: boolean;
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Close by UTC date. Later bars on the same date win (a same-day refresh). */
function closesByDate(bars: readonly Candle[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of bars) {
    if (Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.timestamp)) {
      m.set(dateKey(b.timestamp), b.close);
    }
  }
  return m;
}

/** Aligned [nameClose, benchClose] pairs on common dates, oldest first. */
function align(name: readonly Candle[], bench: readonly Candle[]): { dates: string[]; a: number[]; b: number[] } {
  const na = closesByDate(name);
  const nb = closesByDate(bench);
  const dates = [...na.keys()].filter((d) => nb.has(d)).sort();
  return { dates, a: dates.map((d) => na.get(d)!), b: dates.map((d) => nb.get(d)!) };
}

function spreadAt(a: number[], b: number[], i: number, L: number): number | null {
  if (i - L < 0) return null;
  const s = (a[i] / a[i - L] - 1) - (b[i] / b[i - L] - 1);
  return Number.isFinite(s) ? s : null;
}

function emptySpreads(): Record<`d${RsLookback}`, number | null> {
  return Object.fromEntries(RS_LOOKBACKS.map((L) => [`d${L}`, null])) as Record<`d${RsLookback}`, number | null>;
}

function scoreLeg(
  symbol: string,
  benchmark: string | null,
  name: RsSeriesRead,
  bench: RsSeriesRead | null,
): RsLegReading & { aligned: { a: number[]; b: number[] } | null } {
  const miss = (code: RsReasonCode) => ({
    benchmark, code, alignedBars: 0, spreads: emptySpreads(), asOfDate: null, aligned: null,
  });
  if (benchmark === null) return miss('unmapped_sector');
  if (benchmark === symbol.toUpperCase()) return miss('benchmark_is_self');
  if (!name.readable || name.bars.length === 0) return miss('no_name_bars');
  if (!bench || !bench.readable || bench.bars.length === 0) return miss('no_benchmark_bars');
  const { dates, a, b } = align(name.bars, bench.bars);
  const last = dates.length - 1;
  const spreads = emptySpreads();
  for (const L of RS_LOOKBACKS) spreads[`d${L}`] = spreadAt(a, b, last, L);
  const any = RS_LOOKBACKS.some((L) => spreads[`d${L}`] !== null);
  return {
    benchmark,
    // `ok` ⇔ at least the shortest lookback scored; a null longer lookback is
    // visible as its own null spread.
    code: any ? 'ok' : 'insufficient_overlap',
    alignedBars: dates.length,
    spreads,
    asOfDate: last >= 0 ? dates[last] : null,
    aligned: { a, b },
  };
}

/** The sector ETF for a symbol, or null when its sector is unmapped. */
export function sectorEtfOf(symbol: string): string | null {
  return SECTOR_ETF_BY_SECTOR[sectorOf(symbol)] ?? null;
}

/**
 * Score one name. Pure: series in, reading out. `readSeries` is asked for the
 * name and each benchmark ticker; the caller decides which cache read backs it
 * (the seam counts its reads, the card sink must not).
 */
export function computeRelativeStrength(
  symbol: string,
  readSeries: (symbol: string) => RsSeriesRead,
): RelativeStrengthReading {
  const sym = symbol.toUpperCase();
  const name = readSeries(sym);
  const sectorEtf = sectorEtfOf(sym);
  const spy = scoreLeg(sym, 'SPY', name, readSeries('SPY'));
  const qqq = scoreLeg(sym, 'QQQ', name, readSeries('QQQ'));
  const sector = scoreLeg(sym, sectorEtf, name, sectorEtf ? readSeries(sectorEtf) : null);

  let percentile: number | null = null;
  let percentileCode: RsPercentileCode = spy.code;
  if (spy.code === 'ok') {
    percentileCode = 'insufficient_history';
    const L = RS_PERCENTILE_LOOKBACK;
    const { a, b } = spy.aligned!;
    const last = a.length - 1;
    const today = spreadAt(a, b, last, L);
    const prior: number[] = [];
    for (let i = L; i < last; i += 1) {
      const s = spreadAt(a, b, i, L);
      if (s !== null) prior.push(s);
    }
    if (today !== null && prior.length >= RS_PERCENTILE_MIN_SAMPLES) {
      const below = prior.filter((s) => s < today).length;
      const ties = prior.filter((s) => s === today).length;
      percentile = ((below + ties / 2) / prior.length) * 100;
      percentileCode = 'ok';
    }
  }

  const strip = ({ aligned: _aligned, ...leg }: RsLegReading & { aligned: unknown }): RsLegReading => leg;
  return {
    symbol: sym,
    sector: sectorOf(sym),
    legs: { spy: strip(spy), qqq: strip(qqq), sector: strip(sector) },
    percentile,
    percentileCode,
  };
}

/**
 * The value handed to a scanner's `relativeStrength` input: the measured
 * percentile, or `undefined` when unmeasured — NEVER 50. `undefined` keeps the
 * scanner exactly where it is today for that symbol (its gate skipped).
 */
export function scannerRelativeStrength(reading: RelativeStrengthReading): number | undefined {
  return reading.percentile ?? undefined;
}

/**
 * Append the benchmark tickers to a daily-refresh universe WHEN THE FLAG IS ON.
 * Flag OFF returns the SAME array (byte-identical refresh universe).
 */
export function withRelativeStrengthBenchmarks(
  symbols: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isOtmRelativeStrengthShadowEnabled(env)) return symbols;
  const have = new Set(symbols.map((s) => s.toUpperCase()));
  const extra = RS_BENCHMARK_SYMBOLS.filter((s) => !have.has(s));
  return extra.length === 0 ? symbols : [...symbols, ...extra];
}

// ─── Counters ────────────────────────────────────────────────────────────────
// SINCE-BOOT, in-memory (the TRA-4639 rule: a shadow instrument is attributable
// to the build that wrote it). Two populations, never pooled:
//   • `nomination`, per book — the OTM nominee seam (setup_confirmation), so
//     `evaluated` tracks that seam call-for-call by construction.
//   • `scanner` — the demo swing pass, where the value is SUPPLIED to the two
//     scanners: `supplied` vs `withheld` (⇒ `undefined`, gate skipped) by code.

export type RsBook = 'live' | 'demo';

type CodeCounts<C extends string> = Record<C, number>;

function zeros<C extends string>(vocab: readonly C[]): CodeCounts<C> {
  return Object.fromEntries(vocab.map((c) => [c, 0])) as CodeCounts<C>;
}

interface PopulationCounters {
  evaluated: number;
  byLeg: Record<RsBenchmarkLeg, CodeCounts<RsReasonCode>>;
  byPercentile: CodeCounts<RsPercentileCode>;
  lastEvaluatedAt: number | null;
  lastSymbol: string | null;
}

function emptyPopulation(): PopulationCounters {
  return {
    evaluated: 0,
    byLeg: { spy: zeros(RS_REASON_CODES), qqq: zeros(RS_REASON_CODES), sector: zeros(RS_REASON_CODES) },
    byPercentile: zeros(RS_PERCENTILE_CODES),
    lastEvaluatedAt: null,
    lastSymbol: null,
  };
}

let nomination: Record<RsBook, PopulationCounters> = { live: emptyPopulation(), demo: emptyPopulation() };
let scanner = { ...emptyPopulation(), supplied: 0, withheld: 0 };
let sinceMs = Date.now();

/** Test seam. */
export function resetOtmRelativeStrengthCountersForTest(): void {
  nomination = { live: emptyPopulation(), demo: emptyPopulation() };
  scanner = { ...emptyPopulation(), supplied: 0, withheld: 0 };
  sinceMs = Date.now();
}

function fold(c: PopulationCounters, r: RelativeStrengthReading, nowMs: number): void {
  c.evaluated += 1;
  for (const leg of RS_BENCHMARK_LEGS) c.byLeg[leg][r.legs[leg].code] += 1;
  c.byPercentile[r.percentileCode] += 1;
  c.lastEvaluatedAt = nowMs;
  c.lastSymbol = r.symbol;
}

/** Fold one OTM-nominee reading. Called by the seam, never by a route or the card sink. */
export function recordOtmRelativeStrength(book: RsBook, r: RelativeStrengthReading, nowMs: number = Date.now()): void {
  fold(nomination[book], r, nowMs);
}

/** Fold one swing-scanner supply. */
export function recordScannerRelativeStrength(r: RelativeStrengthReading, nowMs: number = Date.now()): void {
  fold(scanner, r, nowMs);
  if (r.percentile !== null) scanner.supplied += 1;
  else scanner.withheld += 1;
}

function dense<C extends string>(vocab: readonly C[], by: CodeCounts<C>): { code: C; count: number }[] {
  return vocab.map((code) => ({ code, count: by[code] }));
}

function view(c: PopulationCounters) {
  return {
    evaluated: c.evaluated,
    byLeg: {
      spy: dense(RS_REASON_CODES, c.byLeg.spy),
      qqq: dense(RS_REASON_CODES, c.byLeg.qqq),
      sector: dense(RS_REASON_CODES, c.byLeg.sector),
    },
    percentile: dense(RS_PERCENTILE_CODES, c.byPercentile),
    lastEvaluatedAt: c.lastEvaluatedAt === null ? null : new Date(c.lastEvaluatedAt).toISOString(),
    lastSymbol: c.lastSymbol,
  };
}

export function otmRelativeStrengthHealth(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[OTM_RELATIVE_STRENGTH_SHADOW_FLAG];
  const enabled = isOtmRelativeStrengthShadowEnabled(env);
  return {
    flag: OTM_RELATIVE_STRENGTH_SHADOW_FLAG,
    enabled,
    /** The raw env string, so a typo'd arm attempt is visible (UNKNOWN IS NOT OFF). */
    raw: raw ?? null,
    /** ⚠️ SINCE-BOOT. A restart zeroes every count below. */
    sinceMs,
    definition: {
      lookbacksSessions: [...RS_LOOKBACKS],
      benchmarks: RS_BENCHMARK_SYMBOLS,
      percentile: `rank of today's ${RS_PERCENTILE_LOOKBACK}-session spread vs SPY within the name's own trailing `
        + `rolling spreads; >= ${RS_PERCENTILE_MIN_SAMPLES} prior samples`,
      preRegistered: 'TRA-4720 (module block of otm-relative-strength.ts)',
    },
    nomination: { live: view(nomination.live), demo: view(nomination.demo) },
    scanner: { ...view(scanner), supplied: scanner.supplied, withheld: scanner.withheld },
    note: enabled
      ? 'SHADOW ONLY: measured and published, never gates or ranks. `nomination` = the OTM nominee seam '
        + '(setup_confirmation population); `scanner` = the demo swing pass, where `supplied` readings reach '
        + 'the momentum/post-earnings scanners and `withheld` ones pass undefined (gate skipped, as before). '
        + 'An off flag and an unreached seam both read 0/0.'
      : `DARK: set ${OTM_RELATIVE_STRENGTH_SHADOW_FLAG}=1 to record. Counters are structurally zero and the `
        + 'scanners receive undefined exactly as before TRA-4720.',
  };
}
