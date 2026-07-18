// TRA-2028 (parent TRA-1966, spec TRA-2026 acceptance-criteria) — the
// IV-PERCENTILE entry filter on the wheel loop. SHADOW-FIRST, OBSERVE-ONLY.
//
// Premium selling is only positive-EV when you are paid enough for the risk:
// selling insurance when implied vol is CHEAP is systematically negative-EV.
// This filter enforces "sell insurance only when it is expensive" by gating
// CSP/CC `sell_to_open` on the underlying's IV PERCENTILE (the fraction of the
// trailing window whose ATM mid-IV closed below today's — `computeIvPercentile`
// in `iv-rank-store.ts`, computed off the SAME mid-mark surface the engine
// already ranks). Per the TRA-2026 spec the gate keys on the PERCENTILE (more
// robust to a single outlier high/low than IV RANK); both are reported.
//
// Band rules (all thresholds tunable via `resolveWheelIvFilterConfig`):
//   • IVP  < 30  → BLOCK (premium too cheap to sell).
//   • 30 ≤ IVP < 50 → MARGINAL: permitted but flagged and sized down.
//   • 50 ≤ IVP ≤ 90 → PREFERRED entry zone (full size).
//   • IVP  > 90  → EXTREME: requires the TRA-1968 catalyst check — rich IV is
//     usually a KNOWN event (the premium is rich *because* the risk is real, not
//     mispriced). An unhedged binary event inside the option's life BLOCKS the
//     raw sell; a clear check allows it; an UNAVAILABLE check is conservatively
//     blocked (we can't confirm no bomb is ticking).
//
// Fail-loud on a bad mark: the IV MUST come from the engine's ATM mid mark. A
// last-trade/stale mark, or no usable mid IV this pass, stands the entry DOWN
// with a discriminating reason rather than gating on a proxy — inconsistent IV
// inputs invalidate the filter (TRA-2026 hard dependency).
//
// This module is PURE (band logic over already-computed numbers) plus a small
// in-memory ledger that records the decision on EVERY wheel idea (entered AND
// skipped), which backs the entered-vs-skipped-by-decile calibration the gate
// needs and the read-only `GET /api/health/wheel-promotion-gate` surface. It
// suppresses/resizes NOTHING unless `ENABLE_WHEEL_IV_ENTRY_FILTER` is set
// (`isWheelIvEntryFilterEnabled`, option-exec-flag.ts); OFF ⇒ the wheel routes
// byte-for-byte as before while the ledger still accrues. Live promotion stays
// gated on TRA-382.

// ── config ─────────────────────────────────────────────────────────────────────

/** Env override for the hard BLOCK floor (IVP below this never sells). */
export const WHEEL_IV_FILTER_BLOCK_BELOW_VAR = 'WHEEL_IV_FILTER_BLOCK_BELOW_PERCENTILE';
/** Env override for the PREFERRED (full-size) entry floor. */
export const WHEEL_IV_FILTER_PREFERRED_VAR = 'WHEEL_IV_FILTER_PREFERRED_PERCENTILE';
/** Env override for the EXTREME band above which the catalyst check is required. */
export const WHEEL_IV_FILTER_CATALYST_VAR = 'WHEEL_IV_FILTER_CATALYST_PERCENTILE';
/** Env override for the size multiplier applied to a `marginal` (30–50) entry. */
export const WHEEL_IV_FILTER_MARGINAL_SIZE_VAR = 'WHEEL_IV_FILTER_MARGINAL_SIZE_MULT';

/** Starting-hypothesis thresholds from the TRA-2026 acceptance criteria. */
export interface WheelIvFilterConfig {
  /** IVP strictly below this is a hard BLOCK. Default 30. */
  blockBelowPercentile: number;
  /** IVP at/above this is the PREFERRED full-size zone. Default 50. */
  preferredPercentile: number;
  /** IVP strictly above this is EXTREME and requires the catalyst check. Default 90. */
  catalystCheckAbovePercentile: number;
  /** Size multiplier for a `marginal` (blockBelow ≤ IVP < preferred) entry. Default 0.5. */
  marginalSizeMultiplier: number;
}

export const DEFAULT_WHEEL_IV_FILTER_CONFIG: WheelIvFilterConfig = {
  blockBelowPercentile: 30,
  preferredPercentile: 50,
  catalystCheckAbovePercentile: 90,
  marginalSizeMultiplier: 0.5,
};

function parsePercentile(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

function parseFraction(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

/**
 * Resolve the filter config from env, each knob falling back to the shipped
 * default so an unset/malformed value preserves the reference behaviour. If a
 * fat-finger env inverts the band order (block ≥ preferred, or preferred ≥
 * catalyst), the offending pair falls back to defaults as a UNIT so the bands
 * never cross. Pure.
 */
export function resolveWheelIvFilterConfig(
  env: NodeJS.ProcessEnv = process.env,
): WheelIvFilterConfig {
  let blockBelowPercentile =
    parsePercentile(env[WHEEL_IV_FILTER_BLOCK_BELOW_VAR]) ??
    DEFAULT_WHEEL_IV_FILTER_CONFIG.blockBelowPercentile;
  let preferredPercentile =
    parsePercentile(env[WHEEL_IV_FILTER_PREFERRED_VAR]) ??
    DEFAULT_WHEEL_IV_FILTER_CONFIG.preferredPercentile;
  let catalystCheckAbovePercentile =
    parsePercentile(env[WHEEL_IV_FILTER_CATALYST_VAR]) ??
    DEFAULT_WHEEL_IV_FILTER_CONFIG.catalystCheckAbovePercentile;
  const marginalSizeMultiplier =
    parseFraction(env[WHEEL_IV_FILTER_MARGINAL_SIZE_VAR]) ??
    DEFAULT_WHEEL_IV_FILTER_CONFIG.marginalSizeMultiplier;

  // Bands must be strictly ordered block < preferred ≤ catalyst; a crossed pair
  // is a config error — revert the whole triplet to defaults rather than build a
  // band with an empty interior.
  if (!(blockBelowPercentile < preferredPercentile && preferredPercentile <= catalystCheckAbovePercentile)) {
    blockBelowPercentile = DEFAULT_WHEEL_IV_FILTER_CONFIG.blockBelowPercentile;
    preferredPercentile = DEFAULT_WHEEL_IV_FILTER_CONFIG.preferredPercentile;
    catalystCheckAbovePercentile = DEFAULT_WHEEL_IV_FILTER_CONFIG.catalystCheckAbovePercentile;
  }

  return {
    blockBelowPercentile,
    preferredPercentile,
    catalystCheckAbovePercentile,
    marginalSizeMultiplier,
  };
}

// ── decision ─────────────────────────────────────────────────────────────────

/** Which wheel leg the decision governs. */
export type WheelIvLeg = 'csp' | 'cc';

/** The IVP band a decision fell into (or `unknown` when it couldn't be evaluated). */
export type WheelIvBand = 'block' | 'marginal' | 'preferred' | 'extreme' | 'unknown';

/** What the filter would do to the write when ENFORCING. */
export type WheelIvAction = 'enter' | 'enter_marginal' | 'skip';

export interface WheelIvEntryDecision {
  /** The action the filter would take if enforcing. `enter_marginal` = sized-down entry. */
  action: WheelIvAction;
  band: WheelIvBand;
  /** Position-size multiplier the filter would apply (1 full, marginal fraction, 0 skip). */
  sizeMultiplier: number;
  /** IV RANK at entry (reported for calibration; the gate keys on percentile). */
  ivRank: number | null;
  /** IV PERCENTILE at entry — the gated metric. */
  ivPercentile: number | null;
  /** True iff the IVP fell in the EXTREME band and needed the TRA-1968 catalyst check. */
  requiresCatalystCheck: boolean;
  /** Catalyst-check result when it ran: true clear / false event-present / null unavailable. */
  catalystClear: boolean | null;
  /** True iff the mark was stale/last-trade (fail-loud) rather than the engine's mid. */
  markStale: boolean;
  /** Discriminating reason string for the ledger / diagnosis surface. */
  reason: string;
}

/** Which mark produced `ivPercentile`/`ivRank`. Anything but `mid` fails loud. */
export type WheelIvMarkKind = 'mid' | 'last_trade' | 'stale' | 'unknown';

export interface WheelIvEntryInput {
  symbol: string;
  /** IV RANK from `ivRankSync` (mid-mark surface), or null on a thin store. */
  ivRank: number | null;
  /** IV PERCENTILE from `ivPercentileSync` (mid-mark surface), or null on a thin store. */
  ivPercentile: number | null;
  /**
   * Which mark the ATM IV came from. The engine's `atmIvFromRows` returns only
   * mid-derived IV (smvVol/midIv), so the live wiring passes `mid` on a non-null
   * IV and `stale` when no usable mid IV was available this pass. A caller that
   * ever wires a last-trade proxy passes `last_trade`, which is failed loud.
   */
  markKind: WheelIvMarkKind;
  /**
   * TRA-1968 catalyst-check result for the EXTREME (IVP > 90) band:
   *   • true  → an unhedged binary event sits inside the option's life (BLOCK)
   *   • false → the catalyst check ran and is clear (allow)
   *   • null  → the catalyst check was unavailable (conservative BLOCK)
   * Ignored below the extreme band.
   */
  hasBinaryEventInLife: boolean | null;
  config?: WheelIvFilterConfig;
}

/**
 * Evaluate the IV-percentile entry filter for one wheel write. PURE — pure band
 * logic over the already-computed IV rank/percentile; the caller reads those off
 * the shared IV store so both marks come from one mid surface. Returns the
 * decision (action + size multiplier + band + reason) the ledger records and the
 * enforcing path (flag-on) consults; it never mutates state.
 */
export function evaluateWheelIvEntry(input: WheelIvEntryInput): WheelIvEntryDecision {
  const cfg = input.config ?? DEFAULT_WHEEL_IV_FILTER_CONFIG;
  const ivRank = input.ivRank;
  const ivPercentile = input.ivPercentile;

  const base = {
    ivRank,
    ivPercentile,
    requiresCatalystCheck: false,
    catalystClear: null as boolean | null,
    markStale: false,
  };

  // ── fail-loud: the IV must be a fresh MID mark ─────────────────────────────
  if (input.markKind === 'last_trade' || input.markKind === 'stale') {
    return {
      ...base,
      action: 'skip',
      band: 'unknown',
      sizeMultiplier: 0,
      markStale: true,
      reason: 'stale_or_last_trade_mark',
    };
  }
  if (input.markKind !== 'mid' || ivPercentile == null || !Number.isFinite(ivPercentile)) {
    // No usable mid IV, or a thin store that can't yield a real percentile — an
    // honest unknown. A premium seller that cannot confirm IV is expensive does
    // not sell; stand the entry down (observe-only records it for calibration).
    return {
      ...base,
      action: 'skip',
      band: 'unknown',
      sizeMultiplier: 0,
      reason: input.markKind !== 'mid' ? 'no_mid_iv_mark' : 'insufficient_iv_history',
    };
  }

  const p = ivPercentile;

  // ── BLOCK: premium too cheap ───────────────────────────────────────────────
  if (p < cfg.blockBelowPercentile) {
    return { ...base, action: 'skip', band: 'block', sizeMultiplier: 0, reason: 'ivp_below_floor' };
  }

  // ── EXTREME: rich IV needs the catalyst check ──────────────────────────────
  if (p > cfg.catalystCheckAbovePercentile) {
    if (input.hasBinaryEventInLife === true) {
      return {
        ...base,
        action: 'skip',
        band: 'extreme',
        sizeMultiplier: 0,
        requiresCatalystCheck: true,
        catalystClear: false,
        reason: 'ivp_extreme_binary_event_block',
      };
    }
    if (input.hasBinaryEventInLife === false) {
      return {
        ...base,
        action: 'enter',
        band: 'extreme',
        sizeMultiplier: 1,
        requiresCatalystCheck: true,
        catalystClear: true,
        reason: 'ivp_extreme_catalyst_clear',
      };
    }
    // Catalyst check unavailable — can't confirm no unhedged event: conservative block.
    return {
      ...base,
      action: 'skip',
      band: 'extreme',
      sizeMultiplier: 0,
      requiresCatalystCheck: true,
      catalystClear: null,
      reason: 'ivp_extreme_catalyst_unknown',
    };
  }

  // ── PREFERRED: full-size sell zone ─────────────────────────────────────────
  if (p >= cfg.preferredPercentile) {
    return { ...base, action: 'enter', band: 'preferred', sizeMultiplier: 1, reason: 'ivp_preferred' };
  }

  // ── MARGINAL: blockBelow ≤ IVP < preferred → sized down ────────────────────
  return {
    ...base,
    action: 'enter_marginal',
    band: 'marginal',
    sizeMultiplier: cfg.marginalSizeMultiplier,
    reason: 'ivp_marginal_sized_down',
  };
}

// ── in-memory shadow ledger (backs GET /api/health/wheel-promotion-gate) ──────

interface RecordedWheelIvDecision {
  symbol: string;
  leg: WheelIvLeg;
  decision: WheelIvEntryDecision;
  recordedAt: number;
}

/** Cap on retained decisions so the ledger can't grow unbounded over a long run. */
const MAX_LEDGER_ENTRIES = 512;
/** Decisions older than this are swept on read (observe-only telemetry, not trades). */
const LEDGER_TTL_MS = 24 * 60 * 60_000;

const ledger: RecordedWheelIvDecision[] = [];

/**
 * Record one wheel IV-entry decision (entered AND skipped) for calibration.
 * Observe-only — callers evaluate the filter on every wheel idea regardless of
 * the enforcement flag, so the entered-vs-skipped-by-decile readout accrues from
 * the moment the wheel routing runs. Bounded FIFO.
 */
export function recordWheelIvDecision(
  symbol: string,
  leg: WheelIvLeg,
  decision: WheelIvEntryDecision,
  now: number = Date.now(),
): void {
  ledger.push({ symbol: symbol.trim().toUpperCase(), leg, decision, recordedAt: now });
  while (ledger.length > MAX_LEDGER_ENTRIES) ledger.shift();
}

/** Test seam — drop every recorded decision. */
export function clearWheelIvDecisions(): void {
  ledger.length = 0;
}

/** One IVP decile bucket: entered vs skipped counts for calibration. */
export interface WheelIvDecileBucket {
  /** Decile index 0–9 (`0` = IVP 0–<10, `9` = IVP 90–100), or -1 for `unknown`. */
  decile: number;
  /** Human label, e.g. `"90-100"` or `"unknown"`. */
  label: string;
  entered: number;
  /** Of `entered`, how many were sized-down `marginal`. */
  marginal: number;
  skipped: number;
}

export interface WheelIvEntrySummary {
  enabled: boolean;
  total: number;
  entered: number;
  marginal: number;
  skipped: number;
  /** Skips attributable to a stale/last-trade mark (fail-loud) — a data-quality signal. */
  staleMarkSkips: number;
  /** Entered/skipped split by IVP decile — the Part-A acceptance readout. */
  byDecile: WheelIvDecileBucket[];
  note: string;
}

const SUMMARY_NOTE =
  'TRA-2028 wheel IV-percentile entry filter. Observe-only unless ENABLE_WHEEL_IV_ENTRY_FILTER ' +
  'is set: the decision is ledgered on every wheel idea (entered AND skipped) but suppresses/resizes ' +
  'nothing while the flag is off. `byDecile` is the Part-A acceptance readout (entered-vs-skipped by ' +
  'IVP decile); the entered-set cost-net R-expectancy vs the unfiltered set is measured on the resolved ' +
  'forward book (see the wheel-promotion-gate report), NOT here. IVP is computed off the engine ATM ' +
  'mid-IV surface; a stale/last-trade mark is failed loud (counted in `staleMarkSkips`).';

function decileOf(ivp: number | null): { decile: number; label: string } {
  if (ivp == null || !Number.isFinite(ivp)) return { decile: -1, label: 'unknown' };
  const d = Math.min(9, Math.max(0, Math.floor(ivp / 10)));
  return { decile: d, label: `${d * 10}-${d === 9 ? 100 : d * 10 + 10}` };
}

/**
 * Fold the ledger into the read-only calibration summary, dropping entries past
 * the TTL. `enabled` mirrors the enforcement flag so a reader can tell whether
 * the counts reflect observe-only or enforcing behaviour. Pure beyond the
 * injected clock.
 */
export function summarizeWheelIvEntries(
  enabled: boolean,
  now: number = Date.now(),
): WheelIvEntrySummary {
  // Sweep expired entries.
  for (let i = ledger.length - 1; i >= 0; i--) {
    if (now - ledger[i]!.recordedAt >= LEDGER_TTL_MS) ledger.splice(i, 1);
  }

  const buckets = new Map<number, WheelIvDecileBucket>();
  const bucketFor = (decile: number, label: string): WheelIvDecileBucket => {
    let b = buckets.get(decile);
    if (!b) {
      b = { decile, label, entered: 0, marginal: 0, skipped: 0 };
      buckets.set(decile, b);
    }
    return b;
  };

  let entered = 0;
  let marginal = 0;
  let skipped = 0;
  let staleMarkSkips = 0;

  for (const rec of ledger) {
    const d = rec.decision;
    const { decile, label } = decileOf(d.ivPercentile);
    const b = bucketFor(decile, label);
    if (d.action === 'skip') {
      skipped++;
      b.skipped++;
      if (d.markStale) staleMarkSkips++;
    } else {
      entered++;
      b.entered++;
      if (d.action === 'enter_marginal') {
        marginal++;
        b.marginal++;
      }
    }
  }

  const byDecile = [...buckets.values()].sort((a, b) => a.decile - b.decile);

  return {
    enabled,
    total: ledger.length,
    entered,
    marginal,
    skipped,
    staleMarkSkips,
    byDecile,
    note: SUMMARY_NOTE,
  };
}
