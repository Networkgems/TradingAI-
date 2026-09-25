import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  evaluateLiquidityGate,
  DEFAULT_LIQUIDITY_GATE_CONFIG,
  type LiquiditySide,
  type LiquidityGateConfig,
  type LiquidityGateInput,
  type LiquidityGateReason,
  type LiquidityGateResult,
} from '@trading-app/engine';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

// TRA-1967 — SHADOW-FIRST ledger for the pre-trade LIQUIDITY gate.
//
// The engine's `evaluateLiquidityGate` (packages/engine/src/liquidity-gate.ts) is
// PURE decision logic: (side, bid, ask, orderQty, sizes) -> {action, sizeFactor,
// spread/impact bps}. This module is the server-side seam that (a) reads the
// ENABLE_PRE_TRADE_LIQUIDITY_GATE kill switch, (b) runs that pure gate against a
// candidate order at signal time, and (c) appends a well-formed decision row to an
// append-only JSONL ledger.
//
// SHADOW-FIRST, flag-OFF (same governance as TRA-1457's universal pre-trade gate):
// in this first cut the gate ONLY logs allow/downsize/veto + the modeled cost per
// candidate. It does NOT block, downsize, or route any order, and it writes NOTHING
// unless ENABLE_PRE_TRADE_LIQUIDITY_GATE is truthy — so with the flag off (the
// default, and the state on bqb1/prod) there is exactly zero behavior change and an
// empty ledger. Once populated the summary here (veto-rate + downsize-rate +
// modeled-cost distribution per asset class) is what calibrates the thresholds and
// justifies arming a live veto — the realized-slippage KPI (TRA-1967 item 2) is the
// out-of-sample check that the modeled cost this gate charges is real.
//
// Mirrors pre-trade-gate-ledger.ts byte-for-byte in shape: append-only JSONL, folded
// by `id`, one decision per candidate order. A liquidity decision is TERMINAL at
// decision time (the book it saw either cleared or didn't); realized fill quality is
// what the fee/slippage ledgers (live-options-fee-slippage-ledger.ts) measure after.

const log = logger.child({ module: 'pre-trade-liquidity-ledger' });

/**
 * Kill switch. The pipeline appends nothing unless this is truthy, so the gate is
 * OFF by default and a deploy can't start writing (let alone downsizing a live
 * order) without an explicit opt-in. Accepts the usual truthy spellings.
 */
export const PRE_TRADE_LIQUIDITY_FLAG = 'ENABLE_PRE_TRADE_LIQUIDITY_GATE';

export function isPreTradeLiquidityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PRE_TRADE_LIQUIDITY_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'pre-trade-liquidity-decisions.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setPreTradeLiquidityLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Which live path produced the decision (for per-asset-class cuts). */
export type LiquidityGateEngine = 'options' | 'equity' | 'crypto';

/**
 * One evaluated candidate order and the gate's verdict. Carries the raw quote
 * inputs so a reader can re-derive the decision, plus the computed cost detail and
 * the applied config — a row is self-describing.
 */
export interface LiquidityGateDecision {
  /** Stable dedupe key: `${engine}:${symbol}:${side}:${barTs}` (one row/candidate). */
  id: string;
  /** ms-epoch the candidate was evaluated. */
  ts: number;
  symbol: string;
  engine: LiquidityGateEngine;
  side: LiquiditySide;
  bid: number;
  ask: number;
  orderQty: number;
  bidSize: number | null;
  askSize: number | null;
  action: LiquidityGateResult['action'];
  reasons: LiquidityGateReason[];
  spreadCostBps: number | null;
  impactBps: number | null;
  totalCostBps: number | null;
  sizeFactor: number;
  impactMeasured: boolean;
  config: LiquidityGateConfig;
}

/** The fields needed to record a decision (the verdict is computed here). */
export interface LiquidityGateCandidate {
  id: string;
  ts: number;
  symbol: string;
  engine: LiquidityGateEngine;
  input: LiquidityGateInput;
}

type LedgerLine = { kind: 'decision'; rec: LiquidityGateDecision };

/** In-memory folded view: id -> decision. */
let cache: Map<string, LiquidityGateDecision> | null = null;

function foldLine(map: Map<string, LiquidityGateDecision>, line: LedgerLine): void {
  // Deduped by id: the first decision for a candidate wins; a re-fire on the same
  // bar is a no-op, so a per-tick shadow pass can't inflate the sample.
  if (!map.has(line.rec.id)) map.set(line.rec.id, line.rec);
}

async function ensureLoaded(): Promise<Map<string, LiquidityGateDecision>> {
  if (cache) return cache;
  const map = new Map<string, LiquidityGateDecision>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          foldLine(map, JSON.parse(trimmed) as LedgerLine);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read pre-trade-liquidity ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

async function appendLine(line: LedgerLine): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendBoundedTapeLine(path, `${JSON.stringify(line)}\n`);
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initPreTradeLiquidityLedger(): Promise<void> {
  await ensureLoaded();
}

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Evaluate a candidate through the pure liquidity gate and, WHEN THE FLAG IS ON,
 * append a decision row. Returns the gate result regardless (so a caller can
 * log/assert even with the flag off) — but with the flag off NOTHING is written and
 * there is no behavior change. Deduped by `id`. Never throws on a bad candidate:
 * the pure gate is total.
 *
 * `config` defaults to the seed cuts; pass an override to A/B a per-asset-class
 * ceiling once the shadow data justifies one.
 */
export async function recordLiquidityGateDecision(
  candidate: LiquidityGateCandidate,
  config: LiquidityGateConfig = DEFAULT_LIQUIDITY_GATE_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ result: LiquidityGateResult; recorded: boolean }> {
  const result = evaluateLiquidityGate(candidate.input, config);
  if (!isPreTradeLiquidityEnabled(env)) return { result, recorded: false };

  const map = await ensureLoaded();
  if (map.has(candidate.id)) return { result, recorded: false };

  const rec: LiquidityGateDecision = {
    id: candidate.id,
    ts: candidate.ts,
    symbol: candidate.symbol,
    engine: candidate.engine,
    side: candidate.input.side,
    bid: candidate.input.bid,
    ask: candidate.input.ask,
    orderQty: candidate.input.orderQty,
    bidSize: finiteOrNull(candidate.input.bidSize),
    askSize: finiteOrNull(candidate.input.askSize),
    action: result.action,
    reasons: result.reasons,
    spreadCostBps: result.spreadCostBps,
    impactBps: result.impactBps,
    totalCostBps: result.totalCostBps,
    sizeFactor: result.sizeFactor,
    impactMeasured: result.impactMeasured,
    config: result.config,
  };
  map.set(rec.id, rec);
  await appendLine({ kind: 'decision', rec });
  log.info('pre-trade liquidity decision recorded', {
    id: rec.id, engine: rec.engine, action: rec.action, totalCostBps: rec.totalCostBps,
  });
  return { result, recorded: true };
}

/** Recorded decisions, ascending by ts, optionally windowed by `ts`. */
export async function listLiquidityGateDecisions(
  opts: { from?: number; to?: number } = {},
): Promise<LiquidityGateDecision[]> {
  const map = await ensureLoaded();
  const { from, to } = opts;
  return [...map.values()]
    .filter((r) => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to))
    .sort((a, b) => a.ts - b.ts);
}

/** Action-mix + per-reason + modeled-cost stats over a set of decisions. */
export interface LiquidityGateSummary {
  total: number;
  allowed: number;
  downsized: number;
  vetoed: number;
  /** vetoed / total; null on an empty ledger. */
  vetoRate: number | null;
  /** (downsized + vetoed) / total — how often the gate WOULD have intervened. */
  interventionRate: number | null;
  /** Count of decisions that cited each reason. */
  reasonCounts: Record<LiquidityGateReason, number>;
  /** Mean modeled total cost (bps) over rows with a measured total. Null when none. */
  meanTotalCostBps: number | null;
  /** Median modeled total cost (bps). Null when none measured. */
  medianTotalCostBps: number | null;
  /** Per-engine action split, so a reader can slice by asset class. */
  byEngine: Record<LiquidityGateEngine, { total: number; allowed: number; downsized: number; vetoed: number }>;
}

const ALL_REASONS: LiquidityGateReason[] = [
  'UNUSABLE_QUOTE',
  'SPREAD_TOO_WIDE',
  'THIN_BOOK_DOWNSIZE',
  'THIN_BOOK_VETO',
];

const ALL_ENGINES: LiquidityGateEngine[] = ['options', 'equity', 'crypto'];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Aggregate decisions into the action-mix + per-reason + modeled-cost breakdown the
 * health probe exposes. This is what QuantTrader / the board read to decide whether
 * the modeled cost is worth arming a live veto, and it feeds the same calibration
 * loop as the realized-slippage KPI (TRA-1967 item 2).
 */
export function liquidityGateSummary(rows: LiquidityGateDecision[]): LiquidityGateSummary {
  const reasonCounts = Object.fromEntries(ALL_REASONS.map((r) => [r, 0])) as Record<
    LiquidityGateReason,
    number
  >;
  const byEngine = Object.fromEntries(
    ALL_ENGINES.map((e) => [e, { total: 0, allowed: 0, downsized: 0, vetoed: 0 }]),
  ) as LiquidityGateSummary['byEngine'];

  let allowed = 0;
  let downsized = 0;
  let vetoed = 0;
  const costs: number[] = [];
  for (const r of rows) {
    if (r.action === 'allow') allowed++;
    else if (r.action === 'downsize') downsized++;
    else vetoed++;
    for (const reason of r.reasons) reasonCounts[reason]++;
    if (r.totalCostBps !== null && Number.isFinite(r.totalCostBps)) costs.push(r.totalCostBps);
    const eng = byEngine[r.engine];
    if (eng) {
      eng.total++;
      if (r.action === 'allow') eng.allowed++;
      else if (r.action === 'downsize') eng.downsized++;
      else eng.vetoed++;
    }
  }
  const total = rows.length;
  const meanTotalCostBps = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
  return {
    total,
    allowed,
    downsized,
    vetoed,
    vetoRate: total > 0 ? vetoed / total : null,
    interventionRate: total > 0 ? (downsized + vetoed) / total : null,
    reasonCounts,
    meanTotalCostBps,
    medianTotalCostBps: median(costs),
    byEngine,
  };
}
