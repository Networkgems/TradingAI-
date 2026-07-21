// TRA-2130 — SANDBOX options (call + put) round-trip smoke instrumentation.
//
// Pure, injectable orchestration for the no-auth SANDBOX-pinned health route
// `POST /api/health/tradier-sandbox/options-smoke-order`. Extends the TRA-2126
// equity smoke route to options: place a long call and a long put in the Tradier
// sandbox (acct VA20296703), close each, and capture the full
// `signal → submit → ack → fill` timeline plus slippage vs the decision quote.
//
// SAFETY (mirrors TRA-2126): this module NEVER resolves credentials or picks an
// env — the caller hands it a `TradierOptionsClient` that is already hard-pinned
// to `'sandbox'`. The guards here (confirm token, qty cap, underlying allow-list)
// are the second line; the resolver + sandbox-only client are the first.
//
// The heavy lifting (validation, expiry/strike selection, latency & slippage
// math) is factored into pure functions so it is unit-testable without a live
// broker or an HTTP harness (see tradier-sandbox-options-smoke.test.ts). The
// round-trip orchestrator takes an injectable clock + sleep so timing is
// deterministic under test.

import {
  TRADIER_TERMINAL_STATUSES,
  type TradierOrderDetail,
} from '@trading-app/engine';
import type {
  TradierOptionsClient,
  TradierOptionsContract,
} from '@trading-app/engine';
import { DEFAULT_COST_MODEL } from './options-cost-model.js';

/** Underlyings the smoke route is allowed to touch — liquid, tight spreads. */
export const OPTIONS_SMOKE_UNDERLYINGS = ['SPY', 'AAPL'] as const;
export type OptionsSmokeUnderlying = (typeof OPTIONS_SMOKE_UNDERLYINGS)[number];

/** Days-to-expiry window for the ATM contract we round-trip. */
export const SMOKE_MIN_DTE = 3;
export const SMOKE_MAX_DTE = 10;

/** Single contract only — no naked short, no size. Hard cap. */
export const SMOKE_OPTION_QTY = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Mandatory caveat carried on every response so no reader mistakes a sandbox
 * fill for a live-execution result.
 */
export const FILL_REALISM = 'SANDBOX_SIMULATED' as const;
export const FILL_REALISM_NOTE =
  'Sandbox fills are broker-simulated; they do NOT model real queue position, real '
  + 'slippage, partial fills under load, or price-window/latency risk. This route validates '
  + 'the plumbing + our internal signalToSubmit latency only — NOT live execution economics.';

// ── request validation ──────────────────────────────────────────────────────

export interface OptionsSmokeRequestOk {
  ok: true;
  underlying: OptionsSmokeUnderlying;
  qty: number;
}
export interface OptionsSmokeRequestErr {
  ok: false;
  status: number;
  error: string;
}
export type OptionsSmokeValidation = OptionsSmokeRequestOk | OptionsSmokeRequestErr;

/**
 * Guard the smoke request body. Mirrors the TRA-2126 equity guard exactly:
 *   • body.confirm must equal the literal "SANDBOX" (reject 400 otherwise);
 *   • underlying must be on the allow-list (SPY / AAPL only);
 *   • qty is hard-capped to 1 — a single contract, long side only. Any qty other
 *     than 1 (including 0, >1, non-integer, or a stray field) is rejected.
 * Returns a typed discriminated union so the route can respond without
 * re-deriving the status code.
 */
export function validateOptionsSmokeRequest(body: unknown): OptionsSmokeValidation {
  const b = (body ?? {}) as { confirm?: unknown; underlying?: unknown; qty?: unknown };
  if (b.confirm !== 'SANDBOX') {
    return {
      ok: false,
      status: 400,
      error: 'Refused: body.confirm must equal "SANDBOX" to place a sandbox options smoke order.',
    };
  }
  const underlying = (typeof b.underlying === 'string' ? b.underlying : '').trim().toUpperCase();
  if (!(OPTIONS_SMOKE_UNDERLYINGS as readonly string[]).includes(underlying)) {
    return {
      ok: false,
      status: 400,
      error:
        `Refused: underlying ${JSON.stringify(b.underlying)} is not on the allow-list `
        + `[${OPTIONS_SMOKE_UNDERLYINGS.join(', ')}].`,
    };
  }
  // qty defaults to the hard cap of 1; any explicit value other than 1 is refused.
  const qty = b.qty === undefined ? SMOKE_OPTION_QTY : Number(b.qty);
  if (qty !== SMOKE_OPTION_QTY) {
    return {
      ok: false,
      status: 400,
      error: `Refused: qty is hard-capped to ${SMOKE_OPTION_QTY} (single contract, long side only).`,
    };
  }
  return { ok: true, underlying: underlying as OptionsSmokeUnderlying, qty: SMOKE_OPTION_QTY };
}

// ── expiry / strike selection (pure) ────────────────────────────────────────

/**
 * Pick the nearest expiration whose DTE is within [SMOKE_MIN_DTE, SMOKE_MAX_DTE]
 * from `nowMs`. DTE is computed against the expiry's UTC midnight (Tradier
 * reports `YYYY-MM-DD`), matching the option-client convention. Returns the
 * earliest qualifying expiry, or `null` when none falls in the window (e.g. only
 * 0-DTE or LEAPS available).
 */
export function selectSmokeExpiry(expirations: readonly string[], nowMs: number): string | null {
  const qualifying = expirations
    .map((date) => ({ date, t: Date.parse(`${date}T00:00:00Z`) }))
    .filter((e) => Number.isFinite(e.t))
    .map((e) => ({ date: e.date, dte: (e.t - nowMs) / MS_PER_DAY }))
    .filter((e) => e.dte >= SMOKE_MIN_DTE && e.dte <= SMOKE_MAX_DTE)
    .sort((a, b) => a.dte - b.dte);
  return qualifying.length > 0 ? qualifying[0].date : null;
}

/**
 * Pick the contract of `optionType` whose strike is closest to `underlyingPrice`
 * (ATM). Ties break toward the lower strike (stable reduce). Returns `null` when
 * no contract of that type exists in the chain.
 */
export function selectAtmContract(
  chain: readonly TradierOptionsContract[],
  underlyingPrice: number,
  optionType: 'call' | 'put',
): TradierOptionsContract | null {
  const matching = chain.filter((c) => c.option_type === optionType);
  if (matching.length === 0) return null;
  return matching.reduce((best, c) =>
    Math.abs(c.strike - underlyingPrice) < Math.abs(best.strike - underlyingPrice) ? c : best,
  );
}

// ── decision quote + latency / slippage math (pure) ─────────────────────────

export interface DecisionQuote {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  spreadBps: number | null;
  quoteTimeMs: number | null;
  /** Wall-clock ms when we snapped the quote — `t_signal` for the following leg. */
  tSignal: number;
}

/**
 * Build a decision-quote snapshot from a raw bid/ask/last triple. `mid` is
 * `(bid+ask)/2` when both sides are positive, else `null` (we do NOT fabricate a
 * mid from `last` — a one-sided quote can't anchor slippage). `spreadBps` is
 * `spread / mid * 10_000`.
 */
export function buildDecisionQuote(
  raw: { bid?: number; ask?: number; last?: number; quoteTimeMs?: number },
  tSignal: number,
): DecisionQuote {
  const bid = typeof raw.bid === 'number' && Number.isFinite(raw.bid) ? raw.bid : null;
  const ask = typeof raw.ask === 'number' && Number.isFinite(raw.ask) ? raw.ask : null;
  const bothSided = bid != null && ask != null && bid > 0 && ask > 0;
  const mid = bothSided ? (bid + ask) / 2 : null;
  const spread = bothSided ? ask - bid : null;
  const spreadBps = spread != null && mid != null && mid > 0 ? (spread / mid) * 10_000 : null;
  return {
    bid,
    ask,
    mid,
    spread,
    spreadBps,
    quoteTimeMs:
      typeof raw.quoteTimeMs === 'number' && Number.isFinite(raw.quoteTimeMs) ? raw.quoteTimeMs : null,
    tSignal,
  };
}

/**
 * Reference price used to pick the ATM strike: mid when two-sided, else `last`
 * (a fallback the strike selection can tolerate but slippage cannot). Returns
 * `null` when neither is usable.
 */
export function referencePrice(raw: { bid?: number; ask?: number; last?: number }): number | null {
  const bid = typeof raw.bid === 'number' && Number.isFinite(raw.bid) ? raw.bid : null;
  const ask = typeof raw.ask === 'number' && Number.isFinite(raw.ask) ? raw.ask : null;
  if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = typeof raw.last === 'number' && Number.isFinite(raw.last) ? raw.last : null;
  return last != null && last > 0 ? last : null;
}

export interface LegTimeline {
  tSignal: number;
  tSubmit: number;
  tAck: number;
  /** `null` when the leg never reached a terminal status within the poll window. */
  tFill: number | null;
}

export interface LegMetrics {
  latencyMs: {
    signalToSubmit: number;
    submitToAck: number;
    /** Includes the broker poll cadence — an UPPER bound on true fill latency. */
    ackToFill: number | null;
  };
  slippage: {
    /** `fill − mid` — paid-up when > 0 for a buy, received-less when < 0 for a sell. */
    fillMinusMid: number | null;
    /** `fill − farTouch` (ask for a buy, bid for a sell). */
    fillMinusFarTouch: number | null;
  };
  /** Fill inside `[bid, ask]` at the decision quote. `null` when unprovable. */
  withinSpread: boolean | null;
}

/**
 * Compute the latency + slippage instrumentation for one leg. Pure: all timing
 * and prices are passed in. `side` decides which touch is the "far touch" a
 * marketable order pays up to (ask when buying, bid when selling).
 */
export function computeLegMetrics(
  side: 'buy' | 'sell',
  quote: DecisionQuote,
  timeline: LegTimeline,
  avgFillPrice: number | null,
): LegMetrics {
  const farTouch = side === 'buy' ? quote.ask : quote.bid;
  const fill = typeof avgFillPrice === 'number' && Number.isFinite(avgFillPrice) ? avgFillPrice : null;
  return {
    latencyMs: {
      signalToSubmit: timeline.tSubmit - timeline.tSignal,
      submitToAck: timeline.tAck - timeline.tSubmit,
      ackToFill: timeline.tFill != null ? timeline.tFill - timeline.tAck : null,
    },
    slippage: {
      fillMinusMid: fill != null && quote.mid != null ? fill - quote.mid : null,
      fillMinusFarTouch: fill != null && farTouch != null ? fill - farTouch : null,
    },
    withinSpread:
      fill != null && quote.bid != null && quote.ask != null
        ? fill >= quote.bid && fill <= quote.ask
        : null,
  };
}

/**
 * Modeled commission for a `qty`-lot round trip (entry + exit), from the shared
 * cost model. We charge ONLY commission here — the realized slippage is already
 * captured empirically in the entry/exit fill prices, so adding the model's
 * half-spread would double-count it.
 */
export function modeledRoundTripCommissionUsd(qty: number): number {
  const SIDES = 2; // entry + exit
  return DEFAULT_COST_MODEL.commissionPerContract * SIDES * qty;
}

// ── round-trip orchestration ────────────────────────────────────────────────

export interface SmokeLegResult {
  side: 'buy' | 'sell';
  orderId: number | null;
  status: string | null;
  reason: string | null;
  avgFillPrice: number | null;
  execQuantity: number | null;
  decisionQuote: DecisionQuote;
  timeline: LegTimeline;
  metrics: LegMetrics;
}

export interface SmokeContractResult {
  ok: boolean;
  optionType: 'call' | 'put';
  underlying: string;
  error?: string;
  contract?: {
    optionSymbol: string;
    strike: number;
    expiration: string;
    dte: number;
    underlyingRefPrice: number;
  };
  entry?: SmokeLegResult;
  exit?: SmokeLegResult;
  /** `(exitFill − entryFill) × 100 × qty − modeledCommission`. `null` if a fill is missing. */
  realizedRoundTripUsd: number | null;
  modeledCommissionUsd: number;
}

export interface SmokeDeps {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Poll window handed to waitForOrderTerminalStatus for each leg. */
  waitOptions?: { timeoutMs?: number; intervalMs?: number };
}

const DEFAULT_WAIT = { timeoutMs: 12_000, intervalMs: 750 };

async function snapQuote(
  client: TradierOptionsClient,
  optionSymbol: string,
  clock: () => number,
): Promise<DecisionQuote> {
  const raw = await client.getOptionQuote(optionSymbol);
  return buildDecisionQuote(raw ?? {}, clock());
}

/**
 * TRA-2134 Tier-1 — run ONE contract's SHORT round trip:
 * sell_to_open (collect credit) → wait terminal → buy_to_close (pay debit back).
 *
 * This is the sandbox smoke for cash-secured put (CSP) or covered call: we
 * immediately buy the short back so there is zero possibility of assignment. The
 * metrics shape is identical to the long round trip so the journal can store and
 * grade both without branching.
 *
 * On the `side` field the legs are *reversed* from the long trip:
 *   entry = 'sell' (sell_to_open), exit = 'buy' (buy_to_close).
 *
 * Slippage semantics flip accordingly: on a sell entry the far touch is the BID
 * (we receive less than mid if we pay up to the bid), and `computeLegMetrics` with
 * `side='sell'` already handles that — no caller change needed.
 *
 * Same safety contract as the long trip: never throws for expected "can't build the
 * trip" reasons; a broker/network error propagates to the route's catch.
 */
export async function runShortContractRoundTrip(
  client: TradierOptionsClient,
  underlying: string,
  optionType: 'call' | 'put',
  qty: number,
  deps: SmokeDeps,
): Promise<SmokeContractResult> {
  const { clock, sleep } = deps;
  const waitOptions = deps.waitOptions ?? DEFAULT_WAIT;
  const modeledCommissionUsd = modeledRoundTripCommissionUsd(qty);
  const base: SmokeContractResult = {
    ok: false,
    optionType,
    underlying,
    realizedRoundTripUsd: null,
    modeledCommissionUsd,
  };

  const nowForExpiry = clock();
  const expirations = await client.getExpirations(underlying);
  const expiration = selectSmokeExpiry(expirations, nowForExpiry);
  if (!expiration) {
    return {
      ...base,
      error: `No expiration within [${SMOKE_MIN_DTE}, ${SMOKE_MAX_DTE}] DTE for ${underlying}.`,
    };
  }

  const underlyingRaw = await client.getOptionQuote(underlying);
  const underlyingRefPrice = referencePrice(underlyingRaw ?? {});
  if (underlyingRefPrice == null) {
    return { ...base, error: `No usable underlying reference price for ${underlying}.` };
  }

  const chain = await client.getChain(underlying, expiration);
  const contract = selectAtmContract(chain, underlyingRefPrice, optionType);
  if (!contract) {
    return {
      ...base,
      error: `No ${optionType} contract in the ${underlying} ${expiration} chain.`,
    };
  }

  const dte = (Date.parse(`${expiration}T00:00:00Z`) - nowForExpiry) / MS_PER_DAY;
  const contractInfo = {
    optionSymbol: contract.optionSymbol,
    strike: contract.strike,
    expiration,
    dte: Math.round(dte * 100) / 100,
    underlyingRefPrice,
  };

  const runLeg = async (side: 'buy' | 'sell'): Promise<SmokeLegResult> => {
    const decisionQuote = await snapQuote(client, contract.optionSymbol, clock);
    const tSubmit = clock();
    const order =
      side === 'sell'
        ? await client.sellToOpenContracts(contract.optionSymbol, qty) // sell_to_open entry
        : await client.buyToCloseContracts(contract.optionSymbol, qty); // buy_to_close exit
    const tAck = clock();
    const final: TradierOrderDetail | null = await client.waitForOrderTerminalStatus(order.id, {
      ...waitOptions,
      sleep,
    });
    const isTerminal = final != null && TRADIER_TERMINAL_STATUSES.has(final.status);
    const tFill = isTerminal ? clock() : null;
    const avgFillPrice =
      final != null && typeof final.avg_fill_price === 'number' && Number.isFinite(final.avg_fill_price)
        ? final.avg_fill_price
        : null;
    const timeline: LegTimeline = { tSignal: decisionQuote.tSignal, tSubmit, tAck, tFill };
    return {
      side,
      orderId: order.id,
      status: final?.status ?? order.status ?? null,
      reason: final?.reason_description ?? null,
      avgFillPrice,
      execQuantity:
        final != null && typeof final.exec_quantity === 'number' ? final.exec_quantity : null,
      decisionQuote,
      timeline,
      metrics: computeLegMetrics(side, decisionQuote, timeline, avgFillPrice),
    };
  };

  // entry = sell_to_open, exit = buy_to_close (the reverse of the long trip)
  const entry = await runLeg('sell');
  const exit = await runLeg('buy');

  // For a short round-trip the credit received is the ENTRY fill and the debit paid is
  // the EXIT fill — realized P&L = (entryFill - exitFill) × 100 × qty - commission.
  const realizedRoundTripUsd =
    entry.avgFillPrice != null && exit.avgFillPrice != null
      ? (entry.avgFillPrice - exit.avgFillPrice) * 100 * qty - modeledCommissionUsd
      : null;

  return {
    ...base,
    ok:
      entry.status === 'filled'
      && exit.status === 'filled'
      && entry.avgFillPrice != null
      && exit.avgFillPrice != null,
    contract: contractInfo,
    entry,
    exit,
    realizedRoundTripUsd,
    modeledCommissionUsd,
  };
}

/**
 * Run ONE contract's long round trip: buy_to_open → wait terminal → sell_to_close
 * → wait terminal, capturing the decision quote + timeline for each leg. Never
 * throws for an expected "couldn't build the trip" reason (no expiry in window,
 * no chain, no ref price) — those return `{ ok:false, error }` so the sibling
 * contract still runs. A broker/network throw propagates to the route's catch.
 */
export async function runContractRoundTrip(
  client: TradierOptionsClient,
  underlying: string,
  optionType: 'call' | 'put',
  qty: number,
  deps: SmokeDeps,
): Promise<SmokeContractResult> {
  const { clock, sleep } = deps;
  const waitOptions = deps.waitOptions ?? DEFAULT_WAIT;
  const modeledCommissionUsd = modeledRoundTripCommissionUsd(qty);
  const base: SmokeContractResult = {
    ok: false,
    optionType,
    underlying,
    realizedRoundTripUsd: null,
    modeledCommissionUsd,
  };

  const nowForExpiry = clock();
  const expirations = await client.getExpirations(underlying);
  const expiration = selectSmokeExpiry(expirations, nowForExpiry);
  if (!expiration) {
    return { ...base, error: `No expiration within [${SMOKE_MIN_DTE}, ${SMOKE_MAX_DTE}] DTE for ${underlying}.` };
  }

  const underlyingRaw = await client.getOptionQuote(underlying);
  const underlyingRefPrice = referencePrice(underlyingRaw ?? {});
  if (underlyingRefPrice == null) {
    return { ...base, error: `No usable underlying reference price for ${underlying}.` };
  }

  const chain = await client.getChain(underlying, expiration);
  const contract = selectAtmContract(chain, underlyingRefPrice, optionType);
  if (!contract) {
    return { ...base, error: `No ${optionType} contract in the ${underlying} ${expiration} chain.` };
  }

  const dte = (Date.parse(`${expiration}T00:00:00Z`) - nowForExpiry) / MS_PER_DAY;
  const contractInfo = {
    optionSymbol: contract.optionSymbol,
    strike: contract.strike,
    expiration,
    dte: Math.round(dte * 100) / 100,
    underlyingRefPrice,
  };

  const runLeg = async (side: 'buy' | 'sell'): Promise<SmokeLegResult> => {
    const decisionQuote = await snapQuote(client, contract.optionSymbol, clock);
    const tSubmit = clock();
    const order =
      side === 'buy'
        ? await client.buyContracts(contract.optionSymbol, qty)
        : await client.sellContracts(contract.optionSymbol, qty);
    const tAck = clock();
    const final: TradierOrderDetail | null = await client.waitForOrderTerminalStatus(order.id, {
      ...waitOptions,
      sleep,
    });
    const isTerminal = final != null && TRADIER_TERMINAL_STATUSES.has(final.status);
    const tFill = isTerminal ? clock() : null;
    const avgFillPrice =
      final != null && typeof final.avg_fill_price === 'number' && Number.isFinite(final.avg_fill_price)
        ? final.avg_fill_price
        : null;
    const timeline: LegTimeline = { tSignal: decisionQuote.tSignal, tSubmit, tAck, tFill };
    return {
      side,
      orderId: order.id,
      status: final?.status ?? order.status ?? null,
      reason: final?.reason_description ?? null,
      avgFillPrice,
      execQuantity:
        final != null && typeof final.exec_quantity === 'number' ? final.exec_quantity : null,
      decisionQuote,
      timeline,
      metrics: computeLegMetrics(side, decisionQuote, timeline, avgFillPrice),
    };
  };

  const entry = await runLeg('buy');
  const exit = await runLeg('sell');

  const realizedRoundTripUsd =
    entry.avgFillPrice != null && exit.avgFillPrice != null
      ? (exit.avgFillPrice - entry.avgFillPrice) * 100 * qty - modeledCommissionUsd
      : null;

  return {
    ...base,
    ok:
      entry.status === 'filled'
      && exit.status === 'filled'
      && entry.avgFillPrice != null
      && exit.avgFillPrice != null,
    contract: contractInfo,
    entry,
    exit,
    realizedRoundTripUsd,
    modeledCommissionUsd,
  };
}
