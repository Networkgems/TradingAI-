// TRA-1629 (TRA-1623A, parent TRA-1623) — D2 calls-vs-puts directional lean for
// the pre/post-market report.
//
// Assembles a per-name CALL / PUT / NO-TRADE lean (pure §4 `computeDirectionalLean`)
// from inputs we already capture in shadow: the news-catalyst tilt (D1 ledger),
// the PCR contrarian read (pcr-shadow-ledger), the OI quadrant (oi-shadow-ledger),
// and the market-review trend gate. Renders the lean into the report body and
// seeds the strongest names into `ReviewBlock.leaders`.
//
// OBSERVE-ONLY, per the memo: the lean is a REPORT + watchlist annotation. It
// MUST NOT route an order, alter sizing, or touch an exit. Any promotion to live
// direction stays behind QuantTrader's TRA-532 gate. Flag-gated by the same
// `ENABLE_NEWS_CATALYST_WATCHLIST` switch as D1 (default OFF). The name cohort is
// the session's news-catalyst picks (the discovery set from D1) — so D1 and D2
// stay consistent under one flag; broader watchlist coverage can extend later.

import { computeDirectionalLean, type DirectionalLean } from '@trading-app/shared';
import { listNewsCatalystSignals } from './news-catalyst-ledger.js';
import { listPcrShadowSignals } from './pcr-shadow-ledger.js';
import { listOiShadowSignals } from './oi-shadow-ledger.js';
import { etDateKey } from './options-chain-recorder.js';

/** One assembled per-name lean plus its human "Output Contract" fields. */
export interface NameLean {
  symbol: string;
  lean: DirectionalLean;
  /** Rough observe-only notional band scaled by confidence (NOT an order size). */
  notionalBand: string;
  /** One-line bull/bear read. */
  thesis: string;
  /** Invalidation condition (observe-only; conditions, not routed stops). */
  invalidation: string;
}

/** The per-name inputs the lean assembly needs (injected so it stays testable). */
export interface NameLeanInput {
  symbol: string;
  sentimentTilt: 'bullish' | 'bearish' | 'neutral';
  pcrContrarian: 'bullish' | 'bearish' | null;
  oiQuadrant: 'strong' | 'weak' | 'weakening' | null;
  oiPriceDirection: 'up' | 'down' | 'flat' | null;
  trendState: 'up' | 'down' | 'unknown';
  ivRank: number | null;
}

function notionalBandFor(lean: DirectionalLean): string {
  if (lean.verdict === 'NO-TRADE') return '—';
  return lean.band === 'High'
    ? '$500–1,000 (observe)'
    : lean.band === 'Med'
      ? '$250–500 (observe)'
      : '≤ $250 (observe)';
}

function thesisFor(input: NameLeanInput, lean: DirectionalLean): string {
  if (lean.verdict === 'CALL') {
    return `Bullish tilt (${input.sentimentTilt}) with ${input.trendState} trend — calls favoured; ${input.oiQuadrant ?? 'no'} OI read.`;
  }
  if (lean.verdict === 'PUT') {
    return `Bearish tilt (${input.sentimentTilt}) with ${input.trendState} trend — puts favoured; ${input.oiQuadrant ?? 'no'} OI read.`;
  }
  return `Mixed/insufficient signal (net ${lean.directional.toFixed(2)}) — no directional edge; watch only.`;
}

function invalidationFor(input: NameLeanInput, lean: DirectionalLean): string {
  if (lean.verdict === 'CALL') return 'Sentiment tilt flips bearish OR trend gate turns down.';
  if (lean.verdict === 'PUT') return 'Sentiment tilt flips bullish OR trend gate turns up.';
  return 'Re-evaluate on a fresh catalyst headline or a PCR/OI regime change.';
}

/** Assemble one name's lean + Output Contract from its inputs. Pure. */
export function assembleNameLean(input: NameLeanInput): NameLean {
  const lean = computeDirectionalLean({
    sentimentTilt: input.sentimentTilt,
    pcrContrarian: input.pcrContrarian,
    oiQuadrant: input.oiQuadrant,
    oiPriceDirection: input.oiPriceDirection,
    trendState: input.trendState,
    ivRank: input.ivRank,
  });
  return {
    symbol: input.symbol.toUpperCase(),
    lean,
    notionalBand: notionalBandFor(lean),
    thesis: thesisFor(input, lean),
    invalidation: invalidationFor(input, lean),
  };
}

/** Assemble leans for a set of per-name inputs, ranked by |directional| desc. Pure. */
export function assembleNameLeans(inputs: readonly NameLeanInput[]): NameLean[] {
  return inputs
    .map(assembleNameLean)
    .sort((a, b) => Math.abs(b.lean.directional) - Math.abs(a.lean.directional));
}

/**
 * The strongest directional names (CALL/PUT only, NO-TRADE excluded), UPPERCASE,
 * capped — for seeding into `ReviewBlock.leaders`.
 */
export function strongestLeaders(leans: readonly NameLean[], cap = 8): string[] {
  return leans
    .filter((l) => l.lean.verdict !== 'NO-TRADE')
    .slice(0, cap)
    .map((l) => l.symbol);
}

/** Render the "Catalyst Watchlist — Calls vs Puts" markdown section. Pure. */
export function renderLeanMarkdown(leans: readonly NameLean[]): string {
  const lines: string[] = [];
  lines.push('## Catalyst Watchlist — Calls vs Puts');
  lines.push('');
  lines.push(
    '> TRA-1629 (observe-only). Per-name lean from news-sentiment tilt + PCR' +
      ' contrarian + OI quadrant + trend gate. Annotation only — routes no order.',
  );
  lines.push('');
  if (leans.length === 0) {
    lines.push('_No catalyst names with a lean this session._');
    return lines.join('\n');
  }
  lines.push('| Name | Lean | Conf | Structure | Notional | Thesis | Invalidation |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const l of leans) {
    lines.push(
      `| ${l.symbol} | ${l.lean.verdict} | ${l.lean.confidence}/10 (${l.lean.band}) | ` +
        `${l.lean.structure} | ${l.notionalBand} | ${l.thesis} | ${l.invalidation} |`,
    );
  }
  return lines.join('\n');
}

/** Latest row per key, keyed by an id accessor, over records ascending by asof. */
function latestByKey<T extends { asof: number }>(
  records: readonly T[],
  keyOf: (r: T) => string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of records) {
    const k = keyOf(r).toUpperCase();
    const prev = map.get(k);
    if (!prev || r.asof >= prev.asof) map.set(k, r);
  }
  return map;
}

/**
 * Default live provider: build the session's per-name lean inputs by joining the
 * D1 catalyst picks (today's CHOSEN rows) with the latest PCR + OI shadow reads
 * per underlying and the review's trend gate. Returns `[]` when D1 has not
 * produced catalyst picks for the session yet (e.g. this review fired before the
 * pre-market watchlist build) — the lean section then renders empty rather than
 * inventing names. IV-Rank is left `null` in Phase-1 (structure defaults to
 * `either`); a later pass can wire the IV/RV engine in.
 */
export async function buildSessionLeanInputs(
  trendState: 'up' | 'down' | 'unknown',
  now: number = Date.now(),
): Promise<NameLeanInput[]> {
  const session = etDateKey(now);
  const catalystRows = await listNewsCatalystSignals();
  const chosenToday = catalystRows.filter((r) => r.session === session && r.chosen);
  if (chosenToday.length === 0) return [];

  const pcrLatest = latestByKey(await listPcrShadowSignals(), (r) => r.underlying);
  const oiLatest = latestByKey(await listOiShadowSignals(), (r) => r.underlying);

  return chosenToday.map((row) => {
    const sym = row.symbol.toUpperCase();
    const pcr = pcrLatest.get(sym);
    const oi = oiLatest.get(sym);
    return {
      symbol: sym,
      sentimentTilt: row.sentimentTilt,
      pcrContrarian: pcr?.contrarian ?? null,
      oiQuadrant: oi?.quadrant ?? null,
      oiPriceDirection: oi?.priceDirection ?? null,
      trendState,
      ivRank: null,
    };
  });
}
