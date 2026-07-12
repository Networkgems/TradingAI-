import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './observability/index.js';
import { buildWalkLimits, derivePricingPath } from './tradier-smart-open.js';
import type { MakerWalkConfig } from './option-maker-config.js';

// TRA-1662 (TRA-1600 A2) — SHADOW maker-chase measurement. Observe-only.
//
// TRA-1647 established that BOTH demo option sleeves are net-negative at their
// own measured taker cross (TRA-1656): the book's P&L is an artifact of demo's
// `demoSlippagePct = 0`. A filter cannot manufacture edge, so the cost-aware bar
// (TRA-1602) can only decline to pay for its absence. Maker-fill routing
// (TRA-1601) is the ONLY lever that can make the option book viable — and its
// stated "60-70% spread recovery" has NEVER been measured: the chase ladder and
// its telemetry both shipped OFF.
//
// This module measures it. It answers the question in two independent ways,
// because they have very different latencies and very different failure modes.
//
// ── (1) The LADDER CEILING — answerable TODAY, no fills required ─────────────
// The recovery a chase earns is fixed by WHERE it rests, not by what happens
// after. For a buy-to-open resting at limit L against a decision-time quote
// (bid0, ask0), with mid0 = (bid0+ask0)/2 and halfSpread = ask0 − mid0:
//
//     raw cross      = ask0 − mid0 = halfSpread   (what crossing NOW costs)
//     realized cross = L − mid0                   (what resting at L costs, if filled)
//     recovery       = 1 − realizedCross / rawCross
//
// `buildWalkLimits` places rung f at `mid + f × (ask − mid)` = `mid + f × halfSpread`
// (and rung 0 at `mid + min(tick, halfSpread)`). Substituting:
//
//     rung f > 0  ⇒  recovery = 1 − f          ← INDEPENDENT OF SPREAD WIDTH
//     rung f = 0  ⇒  recovery = 1 − min(tick, halfSpread) / halfSpread
//
// That first identity is the load-bearing fact of this whole ticket. The default
// ladder is [0, 0.25, 0.5, 0.75, 1.0], so its rungs recover at most
// {1 − tick/hs, 75%, 50%, 25%, 0%}. **A chase that fills anywhere past the second
// rung cannot recover 75%.** Any recovery target above 75% therefore requires the
// chase to fill at rung 0 (`mid + 1¢`) with near-certainty — and rung 0 is the
// LEAST likely rung to fill, being the least aggressive. This turns the unmeasured
// "recovery rate" into a measurable one: the fill rate required at each rung. See
// {@link summarizeLadderCeiling} / {@link requiredFillRate}.
//
// ── (2) The FORWARD SHADOW CHASE — the real fill rate, captured live ─────────
// The ceiling bounds recovery from above but cannot say where a chase actually
// fills. For that we shadow every DEMO option open/close: capture the decision
// quote, build the SAME production ladder (`buildWalkLimits` — not a re-implementation),
// then re-poll the contract's two-sided quote on the engine tick and walk the rungs
// in wall-clock, exactly as a live chase would. Terminal outcomes append to a
// durable JSONL ledger.
//
// Fill rule (buy): a resting limit at L fills iff the observed ASK falls to ≤ L —
// i.e. a seller comes to our price. Sell side is the mirror (observed BID ≥ L).
// We cannot see prints, only the touch, so this UNDER-counts fills: a resting
// order can also be hit by a marketable order without the touch ever moving.
// **The measured fill rate is therefore a LOWER bound and the measured recovery is
// biased AGAINST the lever.** That asymmetry is deliberate — a lever that clears
// its breakeven under this rule clears it for real.
//
// ── The survivorship trap (the thing TRA-1662 is emphatic about) ─────────────
// Recovery averaged over FILLED chases only is survivorship-biased and flatters
// the lever: the orders that rest and fill are disproportionately the ones the
// market ran through. An exhausted chase does not cost zero — it chases to taker
// and pays the ASK AT EXHAUSTION, which can be worse than the ask it declined at
// decision time. So the rollup reports `avgRecoveryPctOnFills` (the biased number,
// labelled as such) and, separately, `avgRecoveryPctAllAttempts` — the expectancy
// over EVERY attempt with the chase-to-taker tail priced in. The second is the
// number the decision turns on; the unfilled leg is reported explicitly.
//
// NOTHING here routes an order, prices a fill, or gates an admission. It reads
// quotes and writes a ledger. No live capital is touched, no board gate applies.

const log = logger.child({ module: 'option-maker-shadow' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Kill switch — no shadow chase is opened or recorded unless this is truthy. OFF by default. */
export const OPTION_MAKER_SHADOW_FLAG = 'ENABLE_OPTION_MAKER_SHADOW';

export function isOptionMakerShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_MAKER_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) LADDER CEILING — pure geometry. No fills, no data, answerable today.
// ─────────────────────────────────────────────────────────────────────────────

/** The recovery a single rung earns IF it fills, plus the limit that produced it. */
export interface RungRecovery {
  /** 0-indexed rung in the materialised ladder. */
  rung: number;
  /** The resting limit price (per share). */
  limitUsd: number;
  /** What resting here costs vs the decision mid, per share. Positive = cost. */
  realizedCrossUsd: number;
  /**
   * `1 − realizedCross / rawCross`. 1.0 = rested at the mid (paid nothing to
   * cross); 0.0 = paid the full half-spread (no better than crossing now);
   * NEGATIVE = a cross-tick rung that pays MORE than the ask.
   */
  recoveryPct: number;
}

/**
 * The ladder's recovery ceiling for a given decision quote — what each rung earns
 * if it fills. Pure function of the quote geometry and the ladder config; requires
 * no fill data whatsoever, which is why it is answerable before any telemetry
 * accrues.
 *
 * Returns `null` for an unusable / one-sided quote (no mid to triangulate ⇒ every
 * rung is the ask ⇒ recovery is identically 0 and the concept is vacuous).
 */
export function ladderRungRecoveries(
  quote: { bid: number; ask: number },
  config: MakerWalkConfig,
): RungRecovery[] | null {
  const path = derivePricingPath({ symbol: '', bid: quote.bid, ask: quote.ask });
  if (path.kind !== 'mid') return null;
  const mid = (path.bid + path.ask) / 2;
  const rawCross = path.ask - mid; // = halfSpread
  if (!(rawCross > 0)) return null; // zero-width book: nothing to recover

  return buildWalkLimits(path, config).map((limitUsd, rung) => {
    const realizedCrossUsd = limitUsd - mid;
    return {
      rung,
      limitUsd,
      realizedCrossUsd,
      recoveryPct: 1 - realizedCrossUsd / rawCross,
    };
  });
}

/**
 * Invert the unknown. Given a rung's recovery-if-filled and the recovery earned
 * when the chase instead exhausts to taker, what fill rate at that rung is needed
 * to hit `targetRecovery` in expectation?
 *
 *     target = p · rungRecovery + (1 − p) · tailRecovery
 *     ⇒  p = (target − tailRecovery) / (rungRecovery − tailRecovery)
 *
 * `tailRecovery` is 0 under the CHARITABLE assumption that an exhausted chase
 * re-crosses at the same ask it declined (no adverse drift). Real tails are worse
 * — the ask runs away from an unfilled buy — so a negative `tailRecovery` raises
 * the required fill rate. Feeding 0 deliberately stacks the deck FOR the lever:
 * a required fill rate that is already implausible at `tailRecovery = 0` is
 * implausible, full stop.
 *
 * Returns `null` when the target is unreachable at this rung even with a 100%
 * fill (`target > rungRecovery`) — the geometric-impossibility case, which is the
 * one that matters for `single_leg_otm`.
 */
export function requiredFillRate(
  targetRecovery: number,
  rungRecovery: number,
  tailRecovery = 0,
): number | null {
  if (![targetRecovery, rungRecovery, tailRecovery].every((v) => Number.isFinite(v))) return null;
  if (rungRecovery <= tailRecovery) return null; // resting here is no better than crossing
  const p = (targetRecovery - tailRecovery) / (rungRecovery - tailRecovery);
  if (p > 1) return null; // unreachable even at a 100% fill — geometrically impossible
  return Math.max(0, p);
}

/** Per-rung ceiling roll-up for one sleeve, against that sleeve's breakeven target. */
export interface LadderCeilingRung {
  rung: number;
  /** Mean recovery this rung earns across the sampled quotes, if it fills. */
  avgRecoveryPctIfFilled: number;
  /**
   * Fill rate required AT THIS RUNG to reach the sleeve's breakeven recovery,
   * under the charitable zero-slip tail. `null` = unreachable even at a 100% fill.
   */
  requiredFillRateForBreakeven: number | null;
}

export interface LadderCeiling {
  structure: string;
  /** Quotes sampled (usable, two-sided, inside the sleeve's spread ceiling). */
  n: number;
  /** Mean half-spread in TICKS — the only quote statistic rung 0's recovery depends on. */
  avgHalfSpreadTicks: number;
  /** The breakeven maker recovery this sleeve must clear (TRA-1662's inversion). */
  breakevenRecoveryPct: number;
  /**
   * The best recovery the ladder can possibly earn: its most passive rung, filled
   * with certainty, with no tail. Nothing this ladder does can beat this.
   *
   * NOTE this is the max OVER rungs, not rung 0. `buildWalkLimits` places rung 0
   * at `mid + min(tick, halfSpread)` and rung 1 at `mid + 0.25 × halfSpread`, so
   * on a book tighter than 4 ticks of half-spread the tick-bias step is the MORE
   * aggressive of the two and the ladder is non-monotonic.
   */
  maxAchievableRecoveryPct: number;
  /**
   * `true` iff even the ceiling above falls short of breakeven ⇒ NO fill rate,
   * however generous, can make this sleeve pay for its own spread under this ladder.
   */
  breakevenGeometricallyImpossible: boolean;
  rungs: LadderCeilingRung[];
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Fold a set of decision-time quotes for ONE sleeve into its ladder ceiling: the
 * mean recovery each rung earns if filled, and the fill rate each rung would need
 * to carry the sleeve to `breakevenRecoveryPct`.
 *
 * This is the TODAY answer. It needs only quotes (which we have, 316k recorded
 * chain rows behind TRA-1656) — never a fill.
 */
export function summarizeLadderCeiling(
  structure: string,
  quotes: ReadonlyArray<{ bid: number; ask: number }>,
  config: MakerWalkConfig,
  breakevenRecoveryPct: number,
): LadderCeiling | null {
  const perQuote = quotes
    .map((q) => ladderRungRecoveries(q, config))
    .filter((r): r is RungRecovery[] => r !== null);
  if (perQuote.length === 0) return null;

  // Fold, never spread: `Math.max(...xs)` blows the call stack once the sample
  // runs to six figures, and this folds over the whole recorded chain store.
  const rungCount = perQuote.reduce((m, r) => Math.max(m, r.length), 0);
  const halfSpreadTicks = quotes
    .map((q) => (q.ask - q.bid) / 2 / config.tickSize)
    .filter((v) => Number.isFinite(v) && v > 0);

  const rungs: LadderCeilingRung[] = [];
  for (let rung = 0; rung < rungCount; rung += 1) {
    const recs = perQuote
      .map((r) => r[rung]?.recoveryPct)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (recs.length === 0) continue;
    const avgRecoveryPctIfFilled = mean(recs);
    rungs.push({
      rung,
      avgRecoveryPctIfFilled,
      requiredFillRateForBreakeven: requiredFillRate(breakevenRecoveryPct, avgRecoveryPctIfFilled),
    });
  }

  const maxAchievableRecoveryPct = rungs.reduce(
    (m, r) => Math.max(m, r.avgRecoveryPctIfFilled),
    Number.NEGATIVE_INFINITY,
  );
  return {
    structure,
    n: perQuote.length,
    avgHalfSpreadTicks: mean(halfSpreadTicks),
    breakevenRecoveryPct,
    maxAchievableRecoveryPct,
    breakevenGeometricallyImpossible: breakevenRecoveryPct > maxAchievableRecoveryPct,
    rungs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) FORWARD SHADOW CHASE — the state machine.
// ─────────────────────────────────────────────────────────────────────────────

export type ShadowSide = 'open' | 'close';

/** Terminal outcome of a shadow chase. */
export type ShadowResult =
  | 'filled' // a rung's resting limit was reached by the opposing touch
  | 'exhausted_to_taker' // ladder ran out; crossed at the prevailing touch
  | 'abandoned'; // never resolved (engine restart / quotes went dark)

/** An in-flight shadow chase. Held in memory only; terminal events are durable. */
export interface ShadowChaseState {
  id: string;
  side: ShadowSide;
  structure: string;
  mode: 'demo' | 'live';
  /** Underlying + expiration are needed to re-poll the chain the OCC lives on. */
  symbol: string;
  expiration: string;
  optionSymbol: string;
  contracts: number;
  startedAt: number;
  /** Decision-time quote — the baseline every recovery number is measured against. */
  decisionBid: number;
  decisionAsk: number;
  decisionMid: number;
  /** `ask0 − mid0` (buy) / `mid0 − bid0` (sell). The raw cross we are trying to beat. */
  rawCrossUsd: number;
  /** The production ladder, materialised once from the decision quote. */
  limits: readonly number[];
  stepWaitMs: number;
  /** How many times we managed to re-poll a quote — the honesty check on the tick. */
  polls: number;
}

/** A completed shadow chase. One JSONL row. */
export interface ShadowChaseEvent {
  ts: number;
  side: ShadowSide;
  structure: string;
  mode: 'demo' | 'live';
  optionSymbol: string;
  result: ShadowResult;
  /** Rung that filled (0-indexed); omitted unless `result === 'filled'`. */
  rung?: number;
  /** The cross we would have paid by crossing at decision time, per share. */
  rawCrossUsd: number;
  /** What the chase ACTUALLY cost vs the decision mid, per share. Positive = cost. */
  realizedCrossUsd: number;
  /** `1 − realizedCross / rawCross`. Negative when the tail paid more than crossing. */
  recoveryPct: number;
  /** Same, in dollars over the whole order. */
  realizedCrossTotalUsd: number;
  timeToFillMs?: number;
  polls: number;
}

let seq = 0;
function nextId(ts: number): string {
  seq += 1;
  return `sc_${ts}_${seq}`;
}

/**
 * Open a shadow chase against the decision-time quote. Returns `null` when the
 * quote is one-sided / unusable (no mid ⇒ a maker chase is meaningless: every
 * rung is the ask) or the raw cross is zero (nothing to recover) — such opens
 * DROP OUT of the denominator rather than being counted as free recoveries.
 *
 * Mirrors the production ladder exactly by calling `buildWalkLimits`, so the
 * measurement can never drift from the routing it is measuring.
 */
export function beginShadowChase(
  input: {
    side: ShadowSide;
    structure: string;
    mode: 'demo' | 'live';
    symbol: string;
    expiration: string;
    optionSymbol: string;
    contracts: number;
    bid: number;
    ask: number;
  },
  config: MakerWalkConfig,
  nowTs: number,
): ShadowChaseState | null {
  const path = derivePricingPath({ symbol: input.optionSymbol, bid: input.bid, ask: input.ask });
  if (path.kind !== 'mid') return null;
  const decisionMid = (path.bid + path.ask) / 2;
  const rawCrossUsd = (path.ask - path.bid) / 2;
  if (!(rawCrossUsd > 0)) return null;

  // The buy ladder walks mid→ask. A sell-to-close is its mirror image: it walks
  // mid→bid, resting BELOW the mid by the same fractions. Reflect the buy limits
  // through the mid rather than re-deriving them, so both sides are provably the
  // same ladder and a change to `buildWalkLimits` can never desync the close side.
  const buyLimits = buildWalkLimits(path, config);
  const limits =
    input.side === 'open' ? buyLimits : buyLimits.map((l) => decisionMid - (l - decisionMid));

  return {
    id: nextId(nowTs),
    side: input.side,
    structure: input.structure,
    mode: input.mode,
    symbol: input.symbol,
    expiration: input.expiration,
    optionSymbol: input.optionSymbol,
    contracts: input.contracts,
    startedAt: nowTs,
    decisionBid: path.bid,
    decisionAsk: path.ask,
    decisionMid,
    rawCrossUsd,
    limits,
    stepWaitMs: config.stepWaitMs,
    polls: 0,
  };
}

/** The rung a chase is resting on at `nowTs`; `null` once the ladder is exhausted. */
export function activeRung(state: ShadowChaseState, nowTs: number): number | null {
  const elapsed = Math.max(0, nowTs - state.startedAt);
  const idx = Math.floor(elapsed / state.stepWaitMs);
  return idx >= state.limits.length ? null : idx;
}

function toEvent(
  state: ShadowChaseState,
  nowTs: number,
  result: ShadowResult,
  realizedCrossUsd: number,
  rung?: number,
): ShadowChaseEvent {
  return {
    ts: nowTs,
    side: state.side,
    structure: state.structure,
    mode: state.mode,
    optionSymbol: state.optionSymbol,
    result,
    ...(rung !== undefined ? { rung } : {}),
    rawCrossUsd: state.rawCrossUsd,
    realizedCrossUsd,
    recoveryPct: 1 - realizedCrossUsd / state.rawCrossUsd,
    realizedCrossTotalUsd: realizedCrossUsd * state.contracts * 100,
    ...(result === 'filled' ? { timeToFillMs: nowTs - state.startedAt } : {}),
    polls: state.polls,
  };
}

/**
 * Advance one shadow chase against a freshly-polled two-sided quote.
 *
 * Fill rule — a resting BUY at limit L fills iff the observed ASK ≤ L (a seller
 * has come to our price); a resting SELL fills iff the observed BID ≥ L. We see
 * the touch, not the tape, so an order that is hit without the touch moving is
 * NOT counted: fills are UNDER-counted and recovery is biased against the lever.
 *
 * When the ladder is exhausted the chase does not end free — it chases to taker
 * and pays the PREVAILING touch (`ask` for a buy), which is what prices the
 * adverse-selection tail: if the market ran away, this is worse than the cross we
 * declined at decision time and `recoveryPct` goes negative.
 *
 * Returns the terminal event, or `null` while the chase is still resting.
 */
export function advanceShadowChase(
  state: ShadowChaseState,
  quote: { bid: number; ask: number },
  nowTs: number,
): ShadowChaseEvent | null {
  const bid = Number.isFinite(quote.bid) ? quote.bid : 0;
  const ask = Number.isFinite(quote.ask) ? quote.ask : 0;
  state.polls += 1;

  const rung = activeRung(state, nowTs);

  if (rung === null) {
    // Ladder exhausted → chase to taker at the PREVAILING touch. A buy pays the
    // ask; a sell hits the bid. An unusable touch means we cannot price the tail,
    // so the chase is abandoned rather than booked at a flattering zero.
    if (state.side === 'open') {
      if (!(ask > 0)) return toEvent(state, nowTs, 'abandoned', state.rawCrossUsd);
      return toEvent(state, nowTs, 'exhausted_to_taker', ask - state.decisionMid);
    }
    if (!(bid > 0)) return toEvent(state, nowTs, 'abandoned', state.rawCrossUsd);
    return toEvent(state, nowTs, 'exhausted_to_taker', state.decisionMid - bid);
  }

  const limit = state.limits[rung] as number;
  if (state.side === 'open') {
    if (ask > 0 && ask <= limit) {
      // The touch came to us. We rest at `limit`, so that is what we pay — never
      // the (better) prevailing ask, which would credit the chase with price
      // improvement a resting limit order does not receive.
      return toEvent(state, nowTs, 'filled', limit - state.decisionMid, rung);
    }
    return null;
  }
  if (bid > 0 && bid >= limit) {
    return toEvent(state, nowTs, 'filled', state.decisionMid - limit, rung);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable ledger — append-only JSONL, mirrors option-maker-fill-ledger.ts.
// ─────────────────────────────────────────────────────────────────────────────

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'option-maker-shadow.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setOptionMakerShadowFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

let cache: ShadowChaseEvent[] | null = null;

async function ensureLoaded(): Promise<ShadowChaseEvent[]> {
  if (cache) return cache;
  const events: ShadowChaseEvent[] = [];
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as ShadowChaseEvent);
        } catch {
          // Skip a single corrupt line rather than losing the ledger.
        }
      }
    } catch (err) {
      log.error('failed to read shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = events;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initOptionMakerShadowLedger(): Promise<void> {
  await ensureLoaded();
}

/**
 * Record one terminal shadow chase. No-op (false) when the measurement is off.
 *
 * `enabled` is THREADED IN, not read from `process.env`. The flag is a demo flag:
 * it can be armed from `demo-flags.json` alone, which the engine sees (it resolves
 * the demo-flag env) but `process.env` does not. A ledger that re-checked
 * `process.env` here would silently drop every chase the engine legitimately
 * started from a file-only arm — telemetry that looks armed and writes nothing.
 * The caller gates once, at the point the chase begins, and that decision carries.
 */
export async function recordShadowChase(
  event: ShadowChaseEvent,
  enabled = isOptionMakerShadowEnabled(),
): Promise<boolean> {
  if (!enabled) return false;
  if (!Number.isFinite(event.recoveryPct)) return false; // never poison the rollup
  const events = await ensureLoaded();
  events.push(event);
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf-8');
  return true;
}

export interface ShadowFilter {
  mode?: 'demo' | 'live';
  side?: ShadowSide;
  structure?: string;
  sinceTs?: number;
}

export async function listShadowChases(filter: ShadowFilter = {}): Promise<ShadowChaseEvent[]> {
  const events = await ensureLoaded();
  return events.filter(
    (e) =>
      (filter.mode === undefined || e.mode === filter.mode) &&
      (filter.side === undefined || e.side === filter.side) &&
      (filter.structure === undefined || e.structure === filter.structure) &&
      (filter.sinceTs === undefined || e.ts >= filter.sinceTs),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollup — survivorship-honest by construction.
// ─────────────────────────────────────────────────────────────────────────────

/** The unfilled leg, reported explicitly because it is where the lever dies. */
export interface ShadowTailStat {
  /** Chases that exhausted the ladder and had to chase to taker. */
  count: number;
  /**
   * Mean recovery over ONLY the exhausted chases. ~0 when the touch didn't move;
   * NEGATIVE when the market ran away and the tail paid more than crossing at
   * decision time would have.
   */
  avgRecoveryPct: number | null;
  /**
   * Mean EXCESS cost of the tail vs simply crossing at decision time, per share.
   * Positive = the chase actively made things worse. This is adverse selection,
   * priced.
   */
  avgExcessVsImmediateCrossUsd: number | null;
}

export interface ShadowStructureStat {
  structure: string;
  side: ShadowSide;
  /** Every chase — the honest denominator. */
  attempts: number;
  fills: number;
  /** fills ÷ attempts. LOWER bound (touch-only fill rule). */
  makerFillRate: number;
  /**
   * ⚠ SURVIVORSHIP-BIASED. Mean recovery over FILLED chases only — the number
   * TRA-1662 explicitly says is NOT the one to decide on. Reported so the bias is
   * visible next to the honest number, never instead of it.
   */
  avgRecoveryPctOnFills: number | null;
  /**
   * ★ THE NUMBER. Expectancy over EVERY attempt, with the chase-to-taker tail
   * priced in. This is what a maker-routed sleeve would actually recover.
   */
  avgRecoveryPctAllAttempts: number | null;
  /** Distribution over all attempts — the tail matters, not just the mean. */
  p10RecoveryPct: number | null;
  p25RecoveryPct: number | null;
  p50RecoveryPct: number | null;
  p75RecoveryPct: number | null;
  p90RecoveryPct: number | null;
  /** Mean rung that filled — how far down the ladder the fills actually land. */
  avgFillRung: number | null;
  tail: ShadowTailStat;
}

function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] as number;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo] as number;
  if (lo === hi) return loV;
  return loV + ((sorted[hi] as number) - loV) * (idx - lo);
}

function meanOrNull(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Fold shadow chases into the per-(structure, side) recovery rollup. Pure.
 *
 * `abandoned` chases are EXCLUDED from every statistic: they are a measurement
 * failure (quotes went dark / engine restarted mid-chase), not an economic
 * outcome, and counting them either way would corrupt the fill rate.
 */
export function summarizeShadowRecovery(events: readonly ShadowChaseEvent[]): ShadowStructureStat[] {
  const groups = new Map<string, ShadowChaseEvent[]>();
  for (const e of events) {
    if (e.result === 'abandoned') continue;
    const key = `${e.structure}|${e.side}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(e);
    groups.set(key, bucket);
  }

  const out: ShadowStructureStat[] = [];
  for (const [key, rows] of groups) {
    const [structure, side] = key.split('|') as [string, ShadowSide];
    const fills = rows.filter((e) => e.result === 'filled');
    const tail = rows.filter((e) => e.result === 'exhausted_to_taker');
    const allRecoveries = rows.map((e) => e.recoveryPct).sort((a, b) => a - b);

    out.push({
      structure,
      side,
      attempts: rows.length,
      fills: fills.length,
      makerFillRate: rows.length > 0 ? fills.length / rows.length : 0,
      avgRecoveryPctOnFills: meanOrNull(fills.map((e) => e.recoveryPct)),
      avgRecoveryPctAllAttempts: meanOrNull(rows.map((e) => e.recoveryPct)),
      p10RecoveryPct: quantile(allRecoveries, 0.1),
      p25RecoveryPct: quantile(allRecoveries, 0.25),
      p50RecoveryPct: quantile(allRecoveries, 0.5),
      p75RecoveryPct: quantile(allRecoveries, 0.75),
      p90RecoveryPct: quantile(allRecoveries, 0.9),
      avgFillRung: meanOrNull(
        fills.map((e) => e.rung).filter((v): v is number => typeof v === 'number'),
      ),
      tail: {
        count: tail.length,
        avgRecoveryPct: meanOrNull(tail.map((e) => e.recoveryPct)),
        avgExcessVsImmediateCrossUsd: meanOrNull(
          tail.map((e) => e.realizedCrossUsd - e.rawCrossUsd),
        ),
      },
    });
  }
  return out.sort((a, b) => `${a.structure}|${a.side}`.localeCompare(`${b.structure}|${b.side}`));
}

/**
 * TRA-1662's breakeven maker recovery per sleeve — the recovery each sleeve must
 * clear for its realised GROSS edge to survive its own MEASURED taker cross
 * (TRA-1656). Derived in the TRA-1662 escalation from n=1,110 / n=1,025 demo
 * closes against the 316k-row chain measurement:
 *
 *   single_leg_rv : gross +2.77% of premium vs 4.00% round-trip cross ⇒ ≥ 30.8%
 *   single_leg_otm: gross +1.55% of premium vs 5.88% round-trip cross ⇒ ≥ 73.6%
 *
 * A sleeve whose measured `avgRecoveryPctAllAttempts` lands below its entry here
 * does not cover its own spread and cannot be promoted on maker routing.
 */
export const BREAKEVEN_MAKER_RECOVERY: Readonly<Record<string, number>> = {
  single_leg_rv: 0.308,
  single_leg_otm: 0.736,
};
