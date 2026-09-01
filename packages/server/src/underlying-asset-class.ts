/**
 * TRA-4144 (parent TRA-3703, axis 4) — UNDERLYING ASSET CLASS at the options
 * entry path.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * On 2026-08-25 the OTM sleeve opened `ETHA261002C00019000` — a call on the
 * iShares spot-ether ETF — for $128.00 of real money on the production `admin`
 * book (order 143333676, filled at the ask, 37.21% of the $344.00 fleet
 * at-risk). The ratified go-live posture is "Options + Stock, crypto OFF", and
 * NOTHING BREACHED: every control in the entry path did exactly its own job,
 * because every crypto control in this repo is scoped on the crypto MODULE
 * (`ENABLE_CRYPTO_*`, `crypto-feed.ts`, `crypto-engine.ts`) and nothing in the
 * options entry path keys on the underlying's asset class.
 *
 * ⭐⭐⭐ A CONTROL SCOPED ON A VENUE IS BLIND TO THE SAME EXPOSURE ARRIVING
 * THROUGH A WRAPPER. "Crypto OFF" was true of the venue and false of the
 * exposure. This module gives the exposure a byte: a classifier, a census, and
 * an entry-site refusal that ships DISARMED.
 *
 * ── The axis (AC4) ───────────────────────────────────────────────────────────
 * This is an ADMISSION question, evaluated at the ENTRY SITE, per SYMBOL,
 * before the order is placed. Unlike axis 3 (concentration), where the measured
 * quantity DRIFTS after entry as exits move the book, an underlying's asset
 * class is a property of the SYMBOL and does not change while the row is open —
 * so an entry-time check is SUFFICIENT here, and the fold-time census this
 * module also publishes is visibility for the board, not a control. The
 * mirror-image failure the 08-24 axis-3 ruling warned about (entry-time passes,
 * the book drifts, nothing looks again) cannot occur on this axis.
 *
 * ── Never default to permissive (AC1) ────────────────────────────────────────
 * A symbol the classifier cannot place publishes `unknown`, NEVER `equity`. An
 * unknown that reads as the permissive class is exactly the failure this ticket
 * exists to prevent (TRA-3440: the non-finite value landing in the permissive
 * branch). Consequently the ENFORCING mode refuses `unknown` as well as
 * `crypto_proxy_etf`: a denylist that admits what it cannot classify is a
 * denylist a new wrapper walks straight through (ETHA listed 2024-07; a
 * static list frozen that week would have read it `unknown`).
 *
 * ── DISARMED BY DEFAULT (AC3) ────────────────────────────────────────────────
 * ⛔ The refusal ships OFF. The posture call is TRA-3703 Q5 and belongs to the
 * board; today "yes" and "no" are indistinguishable in the deployed bytes,
 * which is the defect — whichever way the board rules, the rule must be
 * WRITABLE in the entry path. `entryPathBehavior` publishes which state is in
 * force (`advisory_no_refusal` | `enforcing`), the same field shape
 * `fleetConcentration` and `canaryCeiling` already use.
 *
 * ── Classifier source (AC1) ──────────────────────────────────────────────────
 * Every classification names its SOURCE. This build ships ONE source,
 * `static_list` — a hand-curated registry below — because it is the only
 * source whose answer is deterministic, offline, and auditable in a diff. A
 * vendor field or an inference tier can be added later; each would carry its
 * own source tag so a row's provenance never has to be guessed.
 *
 * `crypto_adjacent_equity` extends the ticket's minimum vocabulary: COIN /
 * MSTR / the miners are levered crypto exposure wearing a COMMON-STOCK
 * wrapper — the same shape one level down. It is published (so the board can
 * see the exposure) and NOT in the default refused set (so arming the flag
 * enforces exactly the ratified "crypto OFF" reading, no more); widening the
 * refusal to it is a board edit to `REFUSED_ASSET_CLASSES`, one line.
 */

import { underlyingFromOcc } from '@trading-app/engine';
import {
  OPTION_LIVE_OTM_UNIVERSE_VAR,
  resolveLiveOtmUniverse,
  type LiveOtmUniverseSource,
} from './otm-live-universe-flag.js';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export type UnderlyingAssetClass =
  | 'equity'
  | 'equity_etf'
  | 'crypto_proxy_etf'
  | 'crypto_adjacent_equity'
  | 'commodity_etf'
  | 'bond_etf'
  | 'volatility_etp'
  | 'unknown';

/** WHO answered. `none` ⇒ no source could place the symbol ⇒ class `unknown`. */
export type UnderlyingAssetClassSource = 'static_list' | 'none';

export const UNDERLYING_ASSET_CLASS_VOCABULARY: readonly UnderlyingAssetClass[] = [
  'equity',
  'equity_etf',
  'crypto_proxy_etf',
  'crypto_adjacent_equity',
  'commodity_etf',
  'bond_etf',
  'volatility_etp',
  'unknown',
];

// ─── The flag (AC3 — OFF by default) ─────────────────────────────────────────

export const OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG =
  'ENABLE_OPTION_ENTRY_ASSET_CLASS_REFUSAL';

/**
 * The classes the ENFORCING mode refuses. `unknown` is in the set by design —
 * see the file header ("never default to permissive"). ⛔ DO NOT add
 * `crypto_adjacent_equity` here without a board ruling; publishing it and
 * refusing it are different postures and only the first is engineering's call.
 */
export const REFUSED_ASSET_CLASSES: readonly UnderlyingAssetClass[] = [
  'crypto_proxy_etf',
  'unknown',
];

/**
 * True iff the entry-site refusal is armed (accepts 1/true/yes/on). Default
 * OFF ⇒ the classifier runs and records on every live candidate and REFUSES
 * NOTHING. Read from the process env only — this is a live-order toggle, never
 * sourced from the demo-flags file override (the `isOptionCostGateLiveEnforceEnabled`
 * convention).
 */
export function isOptionEntryAssetClassRefusalEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export type AssetClassEntryPathBehavior = 'advisory_no_refusal' | 'enforcing';

export function assetClassEntryPathBehavior(
  env: NodeJS.ProcessEnv = process.env,
): AssetClassEntryPathBehavior {
  return isOptionEntryAssetClassRefusalEnabled(env) ? 'enforcing' : 'advisory_no_refusal';
}

// ─── The static registry ─────────────────────────────────────────────────────
// Uppercase roots. A miss is `unknown`, never `equity` — see the file header.

/**
 * Spot / futures / leveraged-and-inverse crypto ETPs. THE CLASS THIS TICKET
 * EXISTS FOR. `ETHA` is the measured row; the rest are its siblings — the
 * board's "crypto OFF" is a statement about all of them alike.
 */
const CRYPTO_PROXY_ETFS = new Set<string>([
  // spot bitcoin
  'IBIT', 'FBTC', 'ARKB', 'BITB', 'BTCO', 'EZBC', 'BRRR', 'HODL', 'GBTC', 'BTC',
  // spot ether
  'ETHA', 'ETHE', 'ETH', 'FETH', 'ETHW', 'ETHV', 'QETH', 'EZET', 'CETH',
  // futures / leveraged / inverse
  'BITO', 'BITI', 'BITX', 'BITU', 'SBIT', 'ETHU', 'ETHD', 'AETH',
  // multi-asset / large-cap baskets
  'GDLC', 'BTCW',
]);

/**
 * Common stocks whose economics are substantially crypto (treasury vehicles,
 * exchanges, miners). Published, NOT refused by default — see the header.
 */
const CRYPTO_ADJACENT_EQUITIES = new Set<string>([
  'COIN', 'MSTR', 'MARA', 'RIOT', 'CLSK', 'HUT', 'BITF', 'HIVE', 'CIFR',
  'WULF', 'IREN', 'CORZ', 'BTBT', 'SMLR', 'GLXY',
]);

const COMMODITY_ETFS = new Set<string>([
  'GLD', 'IAU', 'GLDM', 'SGOL', 'OUNZ', 'AAAU', 'BAR',
  'SLV', 'SIVR', 'PSLV', 'PPLT', 'PALL',
  'USO', 'BNO', 'UCO', 'SCO', 'DBO',
  'UNG', 'BOIL', 'KOLD', 'UNL', 'UGA',
  'DBC', 'PDBC', 'DBA', 'DBB',
  'CORN', 'WEAT', 'SOYB', 'CANE', 'CPER',
  'AGQ', 'ZSL', 'UGL', 'GLL',
]);

const BOND_ETFS = new Set<string>([
  'TLT', 'IEF', 'SHY', 'IEI', 'TLH', 'GOVT', 'AGG', 'BND',
  'HYG', 'JNK', 'LQD', 'EMB', 'MUB', 'TIP',
  'TMF', 'TMV', 'TBT', 'TBF',
]);

const VOLATILITY_ETPS = new Set<string>([
  'VXX', 'VIXY', 'UVXY', 'SVXY', 'UVIX', 'SVIX',
]);

const EQUITY_ETFS = new Set<string>([
  // broad index
  'SPY', 'VOO', 'IVV', 'SPLG', 'QQQ', 'QQQM', 'DIA', 'IWM', 'IWN', 'IWO',
  'VTI', 'RSP', 'MDY', 'VTV', 'VUG', 'SCHD',
  // sector SPDRs + industry
  'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY',
  'SMH', 'SOXX', 'XBI', 'IBB', 'KRE', 'XRT', 'XHB', 'XOP', 'XME', 'ITB',
  'JETS', 'ITA', 'TAN', 'ICLN', 'ARKK', 'ARKG', 'ARKW',
  // miners (equity baskets, NOT the metal itself)
  'GDX', 'GDXJ', 'SIL', 'SILJ', 'URA', 'URNM', 'COPX',
  // international
  'EEM', 'EFA', 'FXI', 'KWEB', 'EWZ', 'EWJ', 'EWW', 'INDA', 'ASHR',
  // leveraged / inverse equity-index
  'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'SPXU', 'UPRO', 'SSO', 'SDS',
  'SOXL', 'SOXS', 'TNA', 'TZA', 'LABU', 'LABD', 'FAS', 'FAZ',
  'UDOW', 'SDOW', 'QLD', 'QID',
]);

/**
 * Optionable common stocks the classifier can vouch for. A curated list — a
 * STATIC LIST IS A DETERMINATION, an absence from it is not — covering every
 * name the OTM sleeve has actually traded live (KVYO, TROW, ABCL, NVTS, RIG,
 * SOFI, KO, NOK …) plus the liquid large caps the ~614-name watchlist leans
 * on. A name not listed reads `unknown`, which is the honest answer and the
 * safe one under enforcement; extend the list, never the fallback.
 */
const KNOWN_COMMON_STOCKS = new Set<string>([
  // names on this system's own live tape / tickets
  'KVYO', 'TROW', 'ABCL', 'NVTS', 'RIG', 'SOFI', 'KO', 'NOK',
  // ⭐ THE MEASURED GAP (2026-09-01, CEO's arm precondition). GIS / TFC / MO are
  // in the PRODUCTION `OPTION_LIVE_OTM_UNIVERSE` and classified `unknown`, so
  // arming the refusal would have rejected 3 of the 10 board-ratified live
  // names. BULL (Webull, on the 30d tape) and XYZ (Block, ex-SQ, in the base
  // WATCHLIST) were the same shape one step out. All five are ordinary US
  // common stocks; each line here is a DETERMINATION, not a guess.
  // ⚠️ This patch fixed one build. `gradeAssetClassArmPrecondition` is what
  // keeps the question answered after the next env edit — extend the list when
  // it reports a blocker, and NEVER widen the fallback instead.
  'GIS', 'TFC', 'MO', 'BULL', 'XYZ',
  // mega caps
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AVGO',
  'BRK.B', 'LLY', 'JPM', 'V', 'MA', 'UNH', 'XOM', 'WMT', 'JNJ', 'PG', 'HD',
  'COST', 'ORCL', 'CRM', 'NFLX', 'ADBE', 'AMD', 'INTC', 'QCOM', 'MU', 'TSM',
  // liquid optionable large/mid caps
  'BAC', 'WFC', 'C', 'GS', 'MS', 'SCHW', 'PYPL', 'SQ', 'SHOP', 'UBER',
  'LYFT', 'ABNB', 'DKNG', 'PLTR', 'SNAP', 'PINS', 'ROKU', 'HOOD',
  'F', 'GM', 'T', 'VZ', 'TMUS', 'DIS', 'CMCSA', 'SBUX', 'NKE', 'MCD',
  'PEP', 'PFE', 'MRK', 'BMY', 'ABBV', 'CVS', 'MRNA', 'BNTX',
  'BA', 'CAT', 'DE', 'GE', 'HON', 'LMT', 'RTX', 'UPS', 'FDX', 'DAL',
  'UAL', 'AAL', 'LUV', 'CCL', 'NCLH', 'RCL', 'MAR',
  'CVX', 'COP', 'OXY', 'DVN', 'MRO', 'APA', 'HAL', 'SLB', 'BKR',
  'FCX', 'AA', 'X', 'CLF', 'NUE', 'VALE', 'PBR',
  'NIO', 'XPEV', 'LI', 'RIVN', 'LCID', 'BABA', 'JD', 'PDD', 'BIDU',
  'GME', 'AMC', 'BB', 'SIRI', 'PLUG', 'FCEL', 'CHPT', 'RUN', 'ENPH', 'SEDG',
  'CSCO', 'IBM', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'ASML', 'ARM', 'SMCI',
  'DELL', 'HPQ', 'ZM', 'DOCU', 'CRWD', 'PANW', 'ZS', 'NET', 'DDOG', 'SNOW',
  'MDB', 'TEAM', 'NOW', 'INTU', 'ADSK', 'WDAY', 'TTD', 'SPOT', 'RBLX', 'U',
]);

// ─── The classifier (AC1) ────────────────────────────────────────────────────

export interface UnderlyingAssetClassification {
  /** The underlying the verdict is about (normalized, uppercase). */
  underlying: string | null;
  assetClass: UnderlyingAssetClass;
  /** WHO answered (`none` ⇔ `unknown`). Named per AC1 so provenance is a read. */
  source: UnderlyingAssetClassSource;
}

/**
 * Classify one underlying. PURE, total, and NEVER permissive on a miss:
 * a symbol no list can place is `unknown` / `none`, not `equity`.
 */
export function classifyUnderlyingAssetClass(
  underlying: string | null | undefined,
): UnderlyingAssetClassification {
  const raw = typeof underlying === 'string' ? underlying.trim().toUpperCase() : '';
  if (raw === '') return { underlying: null, assetClass: 'unknown', source: 'none' };
  // Ordered most-specific-first: the crypto wrappers are the class this module
  // exists for, so a symbol that somehow appeared on two lists must resolve to
  // the RESTRICTIVE reading, never the permissive one.
  if (CRYPTO_PROXY_ETFS.has(raw)) return { underlying: raw, assetClass: 'crypto_proxy_etf', source: 'static_list' };
  if (CRYPTO_ADJACENT_EQUITIES.has(raw)) return { underlying: raw, assetClass: 'crypto_adjacent_equity', source: 'static_list' };
  if (COMMODITY_ETFS.has(raw)) return { underlying: raw, assetClass: 'commodity_etf', source: 'static_list' };
  if (BOND_ETFS.has(raw)) return { underlying: raw, assetClass: 'bond_etf', source: 'static_list' };
  if (VOLATILITY_ETPS.has(raw)) return { underlying: raw, assetClass: 'volatility_etp', source: 'static_list' };
  if (EQUITY_ETFS.has(raw)) return { underlying: raw, assetClass: 'equity_etf', source: 'static_list' };
  if (KNOWN_COMMON_STOCKS.has(raw)) return { underlying: raw, assetClass: 'equity', source: 'static_list' };
  return { underlying: raw, assetClass: 'unknown', source: 'none' };
}

/** Classify an OCC option symbol by its root (`ETHA261002C00019000` → `ETHA`). */
export function classifyOccUnderlyingAssetClass(
  occ: string | null | undefined,
): UnderlyingAssetClassification {
  if (typeof occ !== 'string' || occ.trim() === '') {
    return { underlying: null, assetClass: 'unknown', source: 'none' };
  }
  return classifyUnderlyingAssetClass(underlyingFromOcc(occ.trim().toUpperCase()));
}

/**
 * The ENTRY-SITE verdict (AC3/AC4). `null` ⇒ admit. A reason ⇒ the order site
 * must refuse, and the reason discloses the class, the source, the flag and
 * the ruling context, because a refusal a desk cannot attribute is the
 * TRA-3216 shape.
 */
export function assetClassRefusalReason(
  underlying: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { classification: UnderlyingAssetClassification; reason: string | null } {
  const classification = classifyUnderlyingAssetClass(underlying);
  if (!isOptionEntryAssetClassRefusalEnabled(env)) return { classification, reason: null };
  if (!REFUSED_ASSET_CLASSES.includes(classification.assetClass)) return { classification, reason: null };
  const why = classification.assetClass === 'unknown'
    ? 'no classifier source could place this symbol, and an unknown must never be admitted as the permissive class (TRA-3440)'
    : 'a call on a crypto wrapper is levered crypto exposure and the ratified posture is "Options + Stock, crypto OFF"';
  return {
    classification,
    reason:
      `live OTM asset-class refusal (TRA-4144): ${classification.underlying ?? '(no symbol)'} classifies `
      + `${classification.assetClass} (source ${classification.source}) — ${why} `
      + `[${OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG} armed; refused classes: ${REFUSED_ASSET_CLASSES.join(', ')}; `
      + `posture ruling: TRA-3703 Q5]`,
  };
}

// ─── The ARM PRECONDITION (CEO, 2026-09-01) ──────────────────────────────────
/**
 * ⭐⭐⭐ WHAT DOES THIS GATE EMIT ON THE **MODAL** WORLD?
 *
 * The CEO gated the `ENABLE_OPTION_ENTRY_ASSET_CLASS_REFUSAL` env write on one
 * measurement: if ordinary equities fall through to `unknown`, then refusing
 * `unknown` does not refuse crypto wrappers — IT REFUSES THE SLEEVE, and we
 * ship a full stop-trade believing we shipped a narrow carve-out.
 *
 * Measured 2026-09-01 against the shipped classifier: **3 of the 10 names in
 * the production `OPTION_LIVE_OTM_UNIVERSE` classify `unknown`** — GIS, TFC and
 * MO, three plain common stocks — so on that build arming the flag would have
 * refused 30% of the live sleeve's universe. The fear was not hypothetical.
 * (The registry gap is closed below; this instrument is why we know.)
 *
 * ── Why a list patch is NOT the fix ──────────────────────────────────────────
 * `OPTION_LIVE_OTM_UNIVERSE` is an **env var**. The board can add a name to it
 * without a deploy, and the day it does, that name classifies `unknown` and —
 * under an armed refusal — is silently refused, with nothing saying so. A
 * one-time registry patch answers the question for one build; it cannot keep
 * answering it. So the answer ships as a **standing read**, folded from the
 * SAME resolver the gate itself calls (`resolveLiveOtmUniverse`), never from a
 * copy of the list — an instrument that can disagree with its gate is not an
 * instrument.
 *
 * ⚠️ `restricted === false` (the `*` / `ALL` sentinel) makes the population the
 * runtime-accumulated ~614-name watchlist, which no fold here can enumerate.
 * That is published as `coverage: null` / precondition NOT satisfied — an
 * unmeasurable denominator is never a pass ("a criterion that cannot fail on
 * this run's data is not a pass").
 */
export interface AssetClassArmPrecondition {
  /** Mirrors the gate's own resolution — provenance, not a re-derivation. */
  universeVar: string;
  universeSource: LiveOtmUniverseSource;
  universeRaw: string | null;
  /** FALSE ⇒ `*`/`ALL` ⇒ the population is unbounded and cannot be graded here. */
  universeRestricted: boolean;
  /** Every allowlisted name with its class. Empty iff the universe is unbounded. */
  symbols: Array<{
    underlying: string;
    assetClass: UnderlyingAssetClass;
    source: UnderlyingAssetClassSource;
    /** Would the ENFORCING mode refuse this name, as `REFUSED_ASSET_CLASSES` stands? */
    wouldRefuse: boolean;
  }>;
  evaluated: number;
  /**
   * THE COLLATERAL DAMAGE. Allowlisted names the classifier cannot place — each
   * one refused, wrongly, the moment the flag is armed. This list is the whole
   * difference between a narrow carve-out and an accidental kill switch.
   */
  unknownUnderlyings: string[];
  unknownCount: number;
  /**
   * THE DELIVERABLE. Allowlisted names refused ON PURPOSE (a crypto wrapper the
   * board ratified out). Kept separate from `unknownUnderlyings` because an
   * intended refusal must never read as a defect, nor a defect as a feature.
   */
  intendedRefusals: string[];
  /** Share of the allowlist the classifier can place. `null` ⇔ unbounded universe. */
  coverage: number | null;
  /** ⛔ THE GATE ON THE ENV WRITE. */
  satisfied: boolean;
  blockers: string[];
  statement: string;
}

/**
 * Grade the arm precondition. PURE over `env`. Answers, for the universe THIS
 * process would actually enforce against: how many allowlisted names would the
 * armed refusal reject, and which of those rejections are the point vs the cost.
 */
export function gradeAssetClassArmPrecondition(
  env: NodeJS.ProcessEnv = process.env,
): AssetClassArmPrecondition {
  const resolution = resolveLiveOtmUniverse(env);
  const symbols: AssetClassArmPrecondition['symbols'] = [];
  const unknownUnderlyings: string[] = [];
  const intendedRefusals: string[] = [];

  for (const sym of resolution.symbols) {
    const c = classifyUnderlyingAssetClass(sym);
    const wouldRefuse = REFUSED_ASSET_CLASSES.includes(c.assetClass);
    symbols.push({
      underlying: c.underlying ?? sym,
      assetClass: c.assetClass,
      source: c.source,
      wouldRefuse,
    });
    if (c.assetClass === 'unknown') unknownUnderlyings.push(c.underlying ?? sym);
    else if (wouldRefuse) intendedRefusals.push(c.underlying ?? sym);
  }

  const evaluated = symbols.length;
  const blockers: string[] = [];
  if (!resolution.restricted) {
    blockers.push(
      `${OPTION_LIVE_OTM_UNIVERSE_VAR} is UNRESTRICTED (${resolution.raw ?? '*'}) — the live population is `
      + 'the runtime-accumulated watchlist (~614 names on bqb1), which this fold cannot enumerate, so the '
      + 'share of it that classifies `unknown` is UNMEASURED. Arming the refusal against an unmeasurable '
      + 'denominator is a stop-trade of unknown size.',
    );
  } else if (evaluated === 0) {
    blockers.push('the resolved allowlist is empty — nothing to grade, which is not the same as a pass.');
  }
  if (unknownUnderlyings.length > 0) {
    blockers.push(
      `${String(unknownUnderlyings.length)} of ${String(evaluated)} allowlisted underlying(s) classify `
      + `\`unknown\` and would be REFUSED IN ERROR when armed: ${unknownUnderlyings.join(', ')}. `
      + 'Add each to the static registry (a determination, per name) — never widen the fallback.',
    );
  }

  const coverage = resolution.restricted && evaluated > 0
    ? Math.round(((evaluated - unknownUnderlyings.length) / evaluated) * 10000) / 10000
    : null;
  const satisfied = blockers.length === 0;

  return {
    universeVar: OPTION_LIVE_OTM_UNIVERSE_VAR,
    universeSource: resolution.source,
    universeRaw: resolution.raw,
    universeRestricted: resolution.restricted,
    symbols,
    evaluated,
    unknownUnderlyings,
    unknownCount: unknownUnderlyings.length,
    intendedRefusals,
    coverage,
    satisfied,
    blockers,
    statement: satisfied
      ? `SAFE TO ARM: all ${String(evaluated)} name(s) in the live OTM allowlist classify, `
        + `${String(intendedRefusals.length)} refused on purpose `
        + `(${intendedRefusals.join(', ') || 'none'}), 0 refused in error. Arming `
        + `${OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG} enforces the ratified "crypto OFF" and narrows the `
        + 'tradeable universe by nothing else.'
      : `⛔ NOT SAFE TO ARM: ${blockers.join(' ')} Arming ${OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG} today `
        + 'would refuse names the board has ratified as tradeable — a stop-trade wearing a carve-out\'s name.',
  };
}

// ─── Entry-site census (AC1 — "every candidate evaluated at the entry site") ─
// In-memory, since boot, EPHEMERAL — disclosed as such on the wire. The durable
// twin is the `underlying_asset_class` gate in the live-enforce ledger; this
// census exists because that ledger's admits do not retain the CLASS.

interface EntrySiteEval {
  ts: number;
  underlying: string | null;
  assetClass: UnderlyingAssetClass;
  source: UnderlyingAssetClassSource;
  refused: boolean;
  book: string | null;
}

const MAX_RECENT_EVALS = 50;
const entrySiteEvals: EntrySiteEval[] = [];
const entrySiteByClass = new Map<UnderlyingAssetClass, { evaluated: number; refused: number }>();
let entrySiteEvaluated = 0;
let entrySiteRefused = 0;

export function recordEntrySiteAssetClassEvaluation(
  classification: UnderlyingAssetClassification,
  refused: boolean,
  book: string | null,
  now: number = Date.now(),
): void {
  entrySiteEvaluated += 1;
  if (refused) entrySiteRefused += 1;
  let c = entrySiteByClass.get(classification.assetClass);
  if (c === undefined) {
    c = { evaluated: 0, refused: 0 };
    entrySiteByClass.set(classification.assetClass, c);
  }
  c.evaluated += 1;
  if (refused) c.refused += 1;
  entrySiteEvals.unshift({
    ts: now,
    underlying: classification.underlying,
    assetClass: classification.assetClass,
    source: classification.source,
    refused,
    book,
  });
  if (entrySiteEvals.length > MAX_RECENT_EVALS) entrySiteEvals.pop();
}

/** Test seam. */
export function clearEntrySiteAssetClassCensus(): void {
  entrySiteEvals.length = 0;
  entrySiteByClass.clear();
  entrySiteEvaluated = 0;
  entrySiteRefused = 0;
}

// ─── The health census (AC1 + AC2) ───────────────────────────────────────────

/** One open live options row, as the position provider offers it. */
export interface AssetClassOpenRowInput {
  /** The underlying. */
  symbol: string | null;
  /** The OCC, when single-leg. */
  optionSymbol: string | null;
  atRiskUsd: number;
  priced: boolean;
}

/**
 * One book's offering — structurally compatible with
 * `FleetConcentrationBookRow` (TRA-3979), so the route can hand ONE snapshot to
 * both graders. `positions: null` is a BLIND book (it could not enumerate its
 * rows): counted, and it forces `censusIsLowerBound` — a book nobody can read
 * must never read as a book holding no crypto.
 */
export interface AssetClassOpenBookInput {
  book: string | null;
  positions: readonly AssetClassOpenRowInput[] | null;
}

/** One retained-tape fill, as the fee/slippage ledger offers it. */
export interface AssetClassTapeFillInput {
  optionSymbol: string;
  side: 'buy_to_open' | 'sell_to_close';
  contracts: number;
  filledPrice: number | null;
  book: string | null;
}

export interface AssetClassBucket {
  assetClass: UnderlyingAssetClass;
  rows: number;
  atRiskUsd: number;
  /** `null` ⇒ the denominator is 0 (a share of nothing is not a small share). */
  shareOfAtRisk: number | null;
  underlyings: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ClassAccum {
  rows: number;
  usd: number;
  underlyings: Set<string>;
}

function bumpClass(
  into: Map<UnderlyingAssetClass, ClassAccum>,
  cls: UnderlyingAssetClass,
  usd: number,
  underlying: string | null,
): void {
  let a = into.get(cls);
  if (a === undefined) {
    a = { rows: 0, usd: 0, underlyings: new Set<string>() };
    into.set(cls, a);
  }
  a.rows += 1;
  a.usd += usd;
  if (underlying !== null) a.underlyings.add(underlying);
}

function finishClasses(
  accs: Map<UnderlyingAssetClass, ClassAccum>,
  denominator: number,
): AssetClassBucket[] {
  const out: AssetClassBucket[] = [];
  for (const [assetClass, a] of accs) {
    out.push({
      assetClass,
      rows: a.rows,
      atRiskUsd: round2(a.usd),
      shareOfAtRisk: denominator > 0 ? Math.round((a.usd / denominator) * 10000) / 10000 : null,
      underlyings: Array.from(a.underlyings).sort(),
    });
  }
  out.sort((x, y) => (y.atRiskUsd - x.atRiskUsd)
    || (x.assetClass < y.assetClass ? -1 : x.assetClass > y.assetClass ? 1 : 0));
  return out;
}

export interface UnderlyingAssetClassHealth {
  /** AC3 — which state the entry path is in, stated on the wire. */
  entryPathBehavior: AssetClassEntryPathBehavior;
  refuses: boolean;
  flag: string;
  refusedClasses: readonly UnderlyingAssetClass[];
  vocabulary: readonly UnderlyingAssetClass[];
  /** The sources this build ships. Per-row `source` names which one answered. */
  classifierSources: readonly UnderlyingAssetClassSource[];
  /** AC1 — the invariant, stated where a grader can read it. */
  unknownNeverReadsAsEquity: true;
  /** AC4 — which axis this control sits on and why entry-time-only suffices. */
  axis: string;
  /**
   * ⛔ THE ARM PRECONDITION (CEO 2026-09-01). What the gate emits on the MODAL
   * world, re-measured every fold against the live allowlist. Read this before
   * writing the env var — `satisfied: false` means arming is a stop-trade.
   */
  armPrecondition: AssetClassArmPrecondition;
  openRows: {
    status: 'unwired' | 'empty' | 'measured';
    rows: Array<{
      book: string | null;
      underlying: string | null;
      optionSymbol: string | null;
      assetClass: UnderlyingAssetClass;
      source: UnderlyingAssetClassSource;
      atRiskUsd: number;
    }>;
    byClass: AssetClassBucket[];
    fleetAtRiskUsd: number;
    unknownRows: number;
    unpricedRows: number;
    /** Books that could not enumerate their rows. Forces the lower bound. */
    blindBooks: string[];
    /** ⚠ `true` ⇒ every figure above is a LOWER bound on the class's exposure. */
    censusIsLowerBound: boolean;
  };
  tape: {
    status: 'unwired' | 'empty' | 'measured';
    opens: number;
    byClass: AssetClassBucket[];
    openPremiumUsd: number;
    unknownOpens: number;
    unpricedOpens: number;
    censusIsLowerBound: boolean;
    note: string;
  };
  entrySite: {
    evaluated: number;
    refused: number;
    byClass: Array<{
      assetClass: UnderlyingAssetClass;
      evaluated: number;
      refused: number;
    }>;
    recent: EntrySiteEval[];
    /** Since-boot, in-memory. The durable twin is gate `underlying_asset_class`. */
    durability: 'ephemeral_since_boot';
  };
  reason: string;
}

/**
 * Fold the census (AC1 + AC2). PURE over its inputs plus the entry-site
 * counters. `openRows === null` / `tapeFills === null` ⇒ that half is
 * `'unwired'` — the provider is absent on this build — never an empty
 * measurement.
 */
export function gradeUnderlyingAssetClassHealth(
  openBooks: readonly AssetClassOpenBookInput[] | null,
  tapeFills: readonly AssetClassTapeFillInput[] | null,
  env: NodeJS.ProcessEnv = process.env,
): UnderlyingAssetClassHealth {
  const behavior = assetClassEntryPathBehavior(env);

  // ── open live rows (AC2a) ──────────────────────────────────────────────────
  const openByClass = new Map<UnderlyingAssetClass, ClassAccum>();
  const openRowsOut: UnderlyingAssetClassHealth['openRows']['rows'] = [];
  const blindBooks: string[] = [];
  let openAtRisk = 0;
  let openUnknown = 0;
  let openUnpriced = 0;
  if (openBooks !== null) {
    for (const b of openBooks) {
      const label = b.book !== null && b.book !== '' ? b.book : '(unnamed)';
      if (b.positions === null) {
        // A book that cannot be read is not a book holding no crypto.
        blindBooks.push(label);
        continue;
      }
      for (const row of b.positions) {
        const cls = row.symbol !== null && row.symbol !== ''
          ? classifyUnderlyingAssetClass(row.symbol)
          : classifyOccUnderlyingAssetClass(row.optionSymbol);
        // `Number.isFinite`, not `<= 0` — a NaN at-risk must land with the
        // unpriced, never in the sum (the TRA-3486 poison).
        const usable = row.priced === true && Number.isFinite(row.atRiskUsd) && row.atRiskUsd >= 0;
        const usd = usable ? row.atRiskUsd : 0;
        if (!usable) openUnpriced += 1;
        if (cls.assetClass === 'unknown') openUnknown += 1;
        openAtRisk += usd;
        openRowsOut.push({
          book: b.book,
          underlying: cls.underlying,
          optionSymbol: row.optionSymbol,
          assetClass: cls.assetClass,
          source: cls.source,
          atRiskUsd: round2(usd),
        });
        bumpClass(openByClass, cls.assetClass, usd, cls.underlying);
      }
    }
  }
  const openStatus: 'unwired' | 'empty' | 'measured' =
    openBooks === null ? 'unwired' : openRowsOut.length > 0 ? 'measured' : 'empty';

  // ── retained tape (AC2b) ───────────────────────────────────────────────────
  const tapeByClass = new Map<UnderlyingAssetClass, ClassAccum>();
  let tapeOpens = 0;
  let tapePremium = 0;
  let tapeUnknown = 0;
  let tapeUnpriced = 0;
  if (tapeFills !== null) {
    for (const f of tapeFills) {
      if (f.side !== 'buy_to_open') continue;
      tapeOpens += 1;
      const cls = classifyOccUnderlyingAssetClass(f.optionSymbol);
      if (cls.assetClass === 'unknown') tapeUnknown += 1;
      const priced = Number.isFinite(f.filledPrice) && (f.filledPrice as number) > 0
        && Number.isFinite(f.contracts) && f.contracts > 0;
      const usd = priced ? (f.filledPrice as number) * 100 * f.contracts : 0;
      if (!priced) tapeUnpriced += 1;
      tapePremium += usd;
      bumpClass(tapeByClass, cls.assetClass, usd, cls.underlying);
    }
  }
  const tapeStatus: 'unwired' | 'empty' | 'measured' =
    tapeFills === null ? 'unwired' : tapeOpens > 0 ? 'measured' : 'empty';

  // ── entry site ─────────────────────────────────────────────────────────────
  const entryByClass: UnderlyingAssetClassHealth['entrySite']['byClass'] = [];
  for (const [assetClass, c] of entrySiteByClass) {
    entryByClass.push({ assetClass, evaluated: c.evaluated, refused: c.refused });
  }
  entryByClass.sort((x, y) => (y.evaluated - x.evaluated)
    || (x.assetClass < y.assetClass ? -1 : x.assetClass > y.assetClass ? 1 : 0));

  const armPrecondition = gradeAssetClassArmPrecondition(env);

  const openBuckets = finishClasses(openByClass, openAtRisk);
  const tapeBuckets = finishClasses(tapeByClass, tapePremium);
  const crypto = (b: AssetClassBucket[]): AssetClassBucket | undefined =>
    b.find((x) => x.assetClass === 'crypto_proxy_etf');

  const reason =
    `underlying asset class ${behavior === 'enforcing' ? 'ENFORCING' : 'ADVISORY — refuses nothing'} `
    + `(${OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG} ${isOptionEntryAssetClassRefusalEnabled(env) ? 'on' : 'off'}); `
    + `open rows ${openStatus}: ${String(openRowsOut.length)} row(s), $${round2(openAtRisk).toFixed(2)} at risk`
    + `, crypto_proxy_etf $${(crypto(openBuckets)?.atRiskUsd ?? 0).toFixed(2)}`
    + (openUnknown > 0 ? `, ${String(openUnknown)} unknown ⇒ LOWER BOUND` : '')
    + `; tape ${tapeStatus}: ${String(tapeOpens)} open fill(s), $${round2(tapePremium).toFixed(2)} premium`
    + `, crypto_proxy_etf $${(crypto(tapeBuckets)?.atRiskUsd ?? 0).toFixed(2)}`
    + (tapeUnknown > 0 ? `, ${String(tapeUnknown)} unknown ⇒ LOWER BOUND` : '')
    + `; entry site ${String(entrySiteEvaluated)} evaluated / ${String(entrySiteRefused)} refused since boot`
    + `; ARM PRECONDITION ${armPrecondition.satisfied ? 'SATISFIED' : 'NOT SATISFIED'}`
    + ` (live allowlist ${String(armPrecondition.evaluated)} name(s), `
    + `${String(armPrecondition.unknownCount)} unknown ⇒ would be refused IN ERROR)`;

  return {
    entryPathBehavior: behavior,
    refuses: behavior === 'enforcing',
    flag: OPTION_ENTRY_ASSET_CLASS_REFUSAL_FLAG,
    refusedClasses: REFUSED_ASSET_CLASSES,
    vocabulary: UNDERLYING_ASSET_CLASS_VOCABULARY,
    classifierSources: ['static_list'],
    unknownNeverReadsAsEquity: true,
    axis:
      'ADMISSION (TRA-3703 axis 4) — evaluated at the entry site, per symbol, before the order is '
      + 'placed. An underlying\'s asset class is a property of the SYMBOL and cannot drift after '
      + 'entry (unlike axis-3 concentration), so an entry-time check is sufficient and this '
      + 'fold-time census is visibility, not control.',
    armPrecondition,
    openRows: {
      status: openStatus,
      rows: openRowsOut,
      byClass: openBuckets,
      fleetAtRiskUsd: round2(openAtRisk),
      unknownRows: openUnknown,
      unpricedRows: openUnpriced,
      blindBooks: blindBooks.slice().sort(),
      censusIsLowerBound: openUnknown > 0 || openUnpriced > 0 || blindBooks.length > 0,
    },
    tape: {
      status: tapeStatus,
      opens: tapeOpens,
      byClass: tapeBuckets,
      openPremiumUsd: round2(tapePremium),
      unknownOpens: tapeUnknown,
      unpricedOpens: tapeUnpriced,
      censusIsLowerBound: tapeUnknown > 0 || tapeUnpriced > 0,
      note:
        'buy_to_open fills in the retained fee/slippage tape; premium = filledPrice × 100 × '
        + 'contracts. Historical backfill beyond the retained tape is out of scope (TRA-4144).',
    },
    entrySite: {
      evaluated: entrySiteEvaluated,
      refused: entrySiteRefused,
      byClass: entryByClass,
      recent: entrySiteEvals.slice(),
      durability: 'ephemeral_since_boot',
    },
    reason,
  };
}
