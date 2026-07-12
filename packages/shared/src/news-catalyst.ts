// TRA-1629 (TRA-1623A, parent TRA-1623) — News-catalyst signal spec, pure core.
//
// QuantTrader's strategy memo (repo `TRA-1623-news-screener-strategy.md`, §4) is
// the authority for the two scores implemented here:
//
//   • D1 `computeCatalystScore` — turns the free Yahoo news we already ingest
//     into a *discovery* score, so the smart watchlist can surface the day's
//     catalyst names instead of only annotating names it was already watching.
//   • D2 `computeDirectionalLean` — a per-name CALL / PUT / NO-TRADE lean built
//     from sentiment tilt + PCR contrarian + OI quadrant + trend state, for the
//     pre/post-market report. Observe-only: it annotates, it never routes.
//
// Both functions are PURE (same inputs ⇒ same output) so they can be unit-tested
// with golden fixtures and stay provider-agnostic — a premium news/positioning
// feed can supply the same numeric inputs in a board-gated Phase 2 without
// touching a consumer. NOTHING here reads I/O, routes an order, or sizes a
// position; the durable shadow ledger + the live wiring live in the server.

/** Scorer identifier, tagged onto every catalyst score + ledger row. */
export const NEWS_CATALYST_METHOD = 'news-catalyst-v1';

// ── D1: catalyst discovery score ─────────────────────────────────────────────

/** Freshness gate: the newest mapped headline must be ≤ this to be a *today* catalyst (§4: ≤6h). */
export const CATALYST_FRESHNESS_MAX_MINUTES = 6 * 60;

/** rvol z-score is clamped to [0, this] before normalising to [0,1] (§4). */
export const CATALYST_RVOL_Z_CLAMP = 3;
/** |gap %| is clamped to [0, this] before normalising to [0,1] (§4). */
export const CATALYST_GAP_CLAMP_PCT = 8;
/** headline density saturates at this many distinct fresh headlines (§4). */
export const CATALYST_HEADLINE_SATURATION = 4;

/** Earnings within this many sessions demotes the name (post-earnings IV-crush risk, §4). */
export const CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS = 1;

/** Tag stamped on a name demoted for imminent earnings. */
export const EARNINGS_IV_CRUSH_TAG = 'EARNINGS_IV_CRUSH_RISK';

export interface CatalystScoreInput {
  /** Recency-weighted per-symbol news `netScore` in [-1,+1] (`aggregateSymbolSentiment`). */
  netScore: number;
  /** Gated per-symbol tilt — `sentimentMag` only counts when this is non-neutral (§4). */
  tilt: 'bullish' | 'bearish' | 'neutral';
  /** z-score of today's relative volume vs the trailing 20d (raw; clamped internally). */
  rvolZ: number;
  /** Open-vs-prior-close gap, signed percent (e.g. `+4.2` for +4.2%). */
  gapPct: number;
  /** Count of distinct fresh (<6h) mapped headlines — the density input. */
  freshHeadlineCount: number;
  /** Age of the newest mapped headline, in minutes — the freshness gate input. */
  freshnessMinutes: number;
  /** Sessions until the name's next earnings event, or `null` when uncovered/none. */
  earningsInDays?: number | null;
}

/** The four normalised [0,1] components that fed the weighted score. */
export interface CatalystScoreComponents {
  /** |netScore|, zeroed when the tilt is neutral. */
  sentimentMag: number;
  /** clamp(rvolZ, 0, 3) / 3. */
  rvolZ: number;
  /** clamp(|gapPct|, 0, 8) / 8. */
  gapMag: number;
  /** min(freshHeadlineCount, 4) / 4. */
  headlineDensity: number;
}

export interface CatalystScore {
  /** Weighted composite in [0,1]: 0.45·sentimentMag + 0.30·rvolZ + 0.15·gapMag + 0.10·headlineDensity. */
  score: number;
  components: CatalystScoreComponents;
  /** True ↔ the newest mapped headline is within the freshness window (a *today* catalyst). */
  fresh: boolean;
  /** True ↔ demoted for imminent earnings — eligible to score but NOT auto-added (§4). */
  demoted: boolean;
  /** Advisory tags (e.g. {@link EARNINGS_IV_CRUSH_TAG}). */
  tags: string[];
  method: string;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * D1 catalyst score per memo §4. Each raw input is normalised to [0,1] first so
 * the four weights (0.45 / 0.30 / 0.15 / 0.10) sum to a bounded [0,1] composite;
 * `sentimentMag` only contributes when the tilt is non-neutral. Sets `fresh`
 * from the ≤6h freshness gate and `demoted` when earnings land within one
 * session (still scored so the shadow ledger sees it, but not auto-added).
 */
export function computeCatalystScore(input: CatalystScoreInput): CatalystScore {
  const sentimentMag = input.tilt === 'neutral' ? 0 : clamp(Math.abs(input.netScore), 0, 1);
  const rvolZ = clamp(input.rvolZ, 0, CATALYST_RVOL_Z_CLAMP) / CATALYST_RVOL_Z_CLAMP;
  const gapMag = clamp(Math.abs(input.gapPct), 0, CATALYST_GAP_CLAMP_PCT) / CATALYST_GAP_CLAMP_PCT;
  const headlineDensity =
    clamp(input.freshHeadlineCount, 0, CATALYST_HEADLINE_SATURATION) / CATALYST_HEADLINE_SATURATION;

  const components: CatalystScoreComponents = {
    sentimentMag: round(sentimentMag),
    rvolZ: round(rvolZ),
    gapMag: round(gapMag),
    headlineDensity: round(headlineDensity),
  };

  const score = round(
    0.45 * sentimentMag + 0.3 * rvolZ + 0.15 * gapMag + 0.1 * headlineDensity,
  );

  const fresh =
    Number.isFinite(input.freshnessMinutes) &&
    input.freshnessMinutes <= CATALYST_FRESHNESS_MAX_MINUTES;

  const tags: string[] = [];
  const demoted =
    input.earningsInDays != null &&
    input.earningsInDays <= CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS;
  if (demoted) tags.push(EARNINGS_IV_CRUSH_TAG);

  return { score, components, fresh, demoted, tags, method: NEWS_CATALYST_METHOD };
}

// ── D2: calls-vs-puts directional lean ───────────────────────────────────────

/** Directional verdict bucket. */
export type LeanVerdict = 'CALL' | 'PUT' | 'NO-TRADE';
/** Confidence band the 1–10 score maps into. */
export type LeanBand = 'Low' | 'Med' | 'High';
/** IV-Rank overlay STRUCTURE hint (not a direction): defined-risk spread vs long single-leg. */
export type LeanStructure = 'spread' | 'single-leg' | 'either';

/** CALL when `directional ≥ +0.25`, PUT when `≤ −0.25` (§4). */
export const LEAN_CALL_THRESHOLD = 0.25;
export const LEAN_PUT_THRESHOLD = -0.25;
/** IV-Rank ≥ this → prefer spreads; ≤ the low mark → long single-leg is cheaper (§4). */
export const LEAN_IVR_SPREAD_AT = 50;
export const LEAN_IVR_SINGLE_LEG_AT = 25;

export interface DirectionalLeanInput {
  /** Per-name news tilt (`getSymbolSentiment`). */
  sentimentTilt: 'bullish' | 'bearish' | 'neutral';
  /**
   * PCR contrarian read (`computePutCallRatio().contrarian`): heavy put flow
   * (bearish regime) is a contrarian *bullish* tell, hence already sign-flipped
   * upstream. `null` in the neutral band / illiquid chain.
   */
  pcrContrarian: 'bullish' | 'bearish' | null;
  /** OI 4-quadrant read (`classifyOiQuadrant().quadrant`). `null` when indeterminate. */
  oiQuadrant: 'strong' | 'weak' | 'weakening' | null;
  /** Price leg of the OI read — signs the dampened `weakening` (unwind) quadrant. */
  oiPriceDirection?: 'up' | 'down' | 'flat' | null;
  /** Market-review trend gate (`gates.trendState`) — the tie-breaker. */
  trendState: 'up' | 'down' | 'unknown';
  /** IV-Rank [0,100] for the STRUCTURE overlay, or `null` when unknown. */
  ivRank?: number | null;
}

/** The four signed [-1,+1] inputs that fed the directional blend. */
export interface DirectionalLeanComponents {
  sentimentTilt: number;
  pcrContrarian: number;
  oiQuadrant: number;
  trendState: number;
}

export interface DirectionalLean {
  verdict: LeanVerdict;
  /** Weighted blend in [-1,+1]: +calls / −puts. */
  directional: number;
  /** 1–10 = scaled |directional| × input agreement. */
  confidence: number;
  band: LeanBand;
  /** How many of the non-zero inputs agree in sign with the net direction. */
  agreement: { agree: number; total: number };
  /** IV-Rank STRUCTURE overlay — spread vs single-leg. Direction is unaffected. */
  structure: LeanStructure;
  components: DirectionalLeanComponents;
  method: string;
}

function tiltToSign(t: 'bullish' | 'bearish' | 'neutral'): number {
  return t === 'bullish' ? 1 : t === 'bearish' ? -1 : 0;
}

function oiToSign(
  quadrant: 'strong' | 'weak' | 'weakening' | null,
  priceDir: 'up' | 'down' | 'flat' | null | undefined,
): number {
  // price↑&OI↑ (long buildup) = +1; price↓&OI↑ (short buildup) = −1; unwinds dampened (§4).
  if (quadrant === 'strong') return 1;
  if (quadrant === 'weak') return -1;
  if (quadrant === 'weakening') {
    return priceDir === 'up' ? 0.5 : priceDir === 'down' ? -0.5 : 0;
  }
  return 0;
}

function bandOf(confidence: number): LeanBand {
  return confidence >= 7 ? 'High' : confidence >= 4 ? 'Med' : 'Low';
}

function structureOf(ivRank: number | null | undefined): LeanStructure {
  if (ivRank == null || !Number.isFinite(ivRank)) return 'either';
  if (ivRank >= LEAN_IVR_SPREAD_AT) return 'spread';
  if (ivRank <= LEAN_IVR_SINGLE_LEG_AT) return 'single-leg';
  return 'either';
}

/**
 * D2 per-name calls-vs-puts lean per memo §4:
 *   directional = 0.40·sentimentTilt + 0.25·pcrContrarian + 0.25·oiQuadrant + 0.10·trendState
 * bucketed to CALL/PUT/NO-TRADE at ±0.25. Confidence (1–10) scales |directional|
 * by how many of the four inputs agree in sign with the net direction. The
 * IV-Rank overlay only picks the STRUCTURE (spread vs single-leg) — it never
 * moves the direction. Observe-only: the caller renders/annotates, never routes.
 */
export function computeDirectionalLean(input: DirectionalLeanInput): DirectionalLean {
  const sentimentTilt = tiltToSign(input.sentimentTilt);
  const pcrContrarian = input.pcrContrarian == null ? 0 : tiltToSign(input.pcrContrarian);
  const oiQuadrant = oiToSign(input.oiQuadrant, input.oiPriceDirection);
  const trendState = input.trendState === 'up' ? 1 : input.trendState === 'down' ? -1 : 0;

  const contributions = [
    { weight: 0.4, sign: sentimentTilt },
    { weight: 0.25, sign: pcrContrarian },
    { weight: 0.25, sign: oiQuadrant },
    { weight: 0.1, sign: trendState },
  ];
  const directional = round(
    contributions.reduce((acc, c) => acc + c.weight * c.sign, 0),
  );

  const verdict: LeanVerdict =
    directional >= LEAN_CALL_THRESHOLD ? 'CALL' : directional <= LEAN_PUT_THRESHOLD ? 'PUT' : 'NO-TRADE';

  const netSign = Math.sign(directional);
  const nonZero = contributions.filter((c) => c.sign !== 0);
  const agree = netSign === 0 ? 0 : nonZero.filter((c) => Math.sign(c.sign) === netSign).length;
  const total = nonZero.length;

  const confidence =
    directional === 0
      ? 1
      : clamp(Math.round(Math.abs(directional) * agree * 2.5), 1, 10);

  return {
    verdict,
    directional,
    confidence,
    band: bandOf(confidence),
    agreement: { agree, total },
    structure: structureOf(input.ivRank),
    components: {
      sentimentTilt: round(sentimentTilt),
      pcrContrarian: round(pcrContrarian),
      oiQuadrant: round(oiQuadrant),
      trendState: round(trendState),
    },
    method: NEWS_CATALYST_METHOD,
  };
}
