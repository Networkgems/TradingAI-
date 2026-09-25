import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  evaluatePreTradeGate,
  DEFAULT_PRE_TRADE_GATE_CONFIG,
  type PreTradeDirection,
  type PreTradeGateConfig,
  type PreTradeGateInput,
  type PreTradeGateReason,
  type PreTradeGateResult,
} from '@trading-app/engine';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import { appendBoundedTapeLine } from './data-tape-bounds.js';

// TRA-1457 — SHADOW-FIRST ledger for the universal pre-trade gate.
//
// The engine's `evaluatePreTradeGate` (packages/engine/src/pre-trade-gate.ts) is
// PURE decision logic: (entry, direction, atr, mtfTrend, rvol, target) ->
// {pass, reasons[]}. This module is the server-side seam that (a) reads the
// ENABLE_PRE_TRADE_GATE kill switch, (b) runs that pure gate against a candidate,
// and (c) appends a well-formed decision row to an append-only JSONL ledger.
//
// SHADOW-FIRST, flag-OFF (critical governance, TRA-1456 approval): in this first
// cut the gate ONLY logs pass/fail + rejection reasons per candidate. It does NOT
// block, modify, or route any order, and it writes NOTHING unless
// ENABLE_PRE_TRADE_GATE is truthy — so with the flag off (the default, and the
// state on bqb1/prod while TRA-382 holds) there is exactly zero behavior change
// and an empty ledger. The ledger feeds the SAME A/B methodology as the frozen
// shadow-validation baseline (TRA-789/1245: NO-GO at E[R] -0.047R / 18.5% hit):
// once populated, QuantTrader (bf0ae543) reads the pass-rate + per-reason
// rejection mix here to give a promotion GO/NO-GO.
//
// Mirrors the reversal / option shadow ledgers: append-only JSONL, folded by
// `id`, one decision per candidate-bar. Unlike the reversal ledger there is NO
// forward-outcome resolution here — a gate decision is TERMINAL at decision time
// (it either cleared the gate or it didn't); the FORWARD R of a gated-in
// candidate is what the existing shadow-signal ledgers already measure.

const log = logger.child({ module: 'pre-trade-gate-ledger' });

/**
 * Kill switch. The pipeline appends nothing unless this is truthy, so the gate is
 * OFF by default and a deploy can't start writing without an explicit opt-in
 * (mirrors ENABLE_REVERSAL_SHADOW / ENABLE_OPTION_SHADOW_SELECTOR). Accepts the
 * usual truthy spellings.
 */
export const PRE_TRADE_GATE_FLAG = 'ENABLE_PRE_TRADE_GATE';

export function isPreTradeGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PRE_TRADE_GATE_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'pre-trade-gate-decisions.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setPreTradeGateLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Which engine's candidate stream produced the decision (for per-engine cuts). */
export type PreTradeGateEngine = 'options' | 'equity' | 'crypto';

/**
 * One evaluated candidate and the gate's verdict. Carries the raw inputs so a
 * reader can re-derive the decision, plus the computed R:R / ATR-stop detail and
 * the applied config — a row is self-describing.
 */
export interface PreTradeGateDecision {
  /** Stable dedupe key: `${engine}:${symbol}:${direction}:${barTs}` (one row/bar). */
  id: string;
  /** ms-epoch the candidate was evaluated (the entry bar ts). */
  ts: number;
  symbol: string;
  engine: PreTradeGateEngine;
  direction: PreTradeDirection;
  entry: number;
  atr: number;
  mtfTrend: number;
  rvol: number;
  target: number;
  pass: boolean;
  reasons: PreTradeGateReason[];
  stopDistance: number | null;
  stopPrice: number | null;
  rewardRisk: number | null;
  config: PreTradeGateConfig;
}

/** The fields needed to record a decision (the verdict is computed here). */
export interface PreTradeGateCandidate {
  id: string;
  ts: number;
  symbol: string;
  engine: PreTradeGateEngine;
  input: PreTradeGateInput;
}

type LedgerLine = { kind: 'decision'; rec: PreTradeGateDecision };

/** In-memory folded view: id -> decision. */
let cache: Map<string, PreTradeGateDecision> | null = null;

function foldLine(map: Map<string, PreTradeGateDecision>, line: LedgerLine): void {
  // Deduped by id: the first decision for a candidate-bar wins; a re-fire on the
  // same bar is a no-op, so a per-tick shadow pass can't inflate the sample.
  if (!map.has(line.rec.id)) map.set(line.rec.id, line.rec);
}

async function ensureLoaded(): Promise<Map<string, PreTradeGateDecision>> {
  if (cache) return cache;
  const map = new Map<string, PreTradeGateDecision>();
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
      log.error('failed to read pre-trade-gate ledger, starting empty', {
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
export async function initPreTradeGateLedger(): Promise<void> {
  await ensureLoaded();
}

/**
 * Evaluate a candidate through the pure gate and, WHEN THE FLAG IS ON, append a
 * decision row. Returns the gate result regardless (so a caller can log/assert
 * even with the flag off) — but with the flag off NOTHING is written and there is
 * no behavior change. Deduped by `id`: a candidate that re-fires on the same bar
 * is a no-op. Fire-and-forget safe: never throws on a bad candidate, and the
 * pure gate is total.
 *
 * `config` defaults to the board-approved cuts; pass an override to A/B a
 * different RVOL / R:R / ATR-k (e.g. QuantTrader's 1.5 RVOL promotion cut).
 */
export async function recordPreTradeGateDecision(
  candidate: PreTradeGateCandidate,
  config: PreTradeGateConfig = DEFAULT_PRE_TRADE_GATE_CONFIG,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ result: PreTradeGateResult; recorded: boolean }> {
  const result = evaluatePreTradeGate(candidate.input, config);
  if (!isPreTradeGateEnabled(env)) return { result, recorded: false };

  const map = await ensureLoaded();
  if (map.has(candidate.id)) return { result, recorded: false };

  const rec: PreTradeGateDecision = {
    id: candidate.id,
    ts: candidate.ts,
    symbol: candidate.symbol,
    engine: candidate.engine,
    direction: candidate.input.direction,
    entry: candidate.input.entry,
    atr: candidate.input.atr,
    mtfTrend: candidate.input.mtfTrend,
    rvol: candidate.input.rvol,
    target: candidate.input.target,
    pass: result.pass,
    reasons: result.reasons,
    stopDistance: result.stopDistance,
    stopPrice: result.stopPrice,
    rewardRisk: result.rewardRisk,
    config: result.config,
  };
  map.set(rec.id, rec);
  await appendLine({ kind: 'decision', rec });
  log.info('pre-trade gate decision recorded', {
    id: rec.id, engine: rec.engine, pass: rec.pass, reasons: rec.reasons,
  });
  return { result, recorded: true };
}

/** Recorded decisions, ascending by ts, optionally windowed by `ts`. */
export async function listPreTradeGateDecisions(
  opts: { from?: number; to?: number } = {},
): Promise<PreTradeGateDecision[]> {
  const map = await ensureLoaded();
  const { from, to } = opts;
  return [...map.values()]
    .filter((r) => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to))
    .sort((a, b) => a.ts - b.ts);
}

/** Pass-rate + per-reason rejection counts over a set of decisions. */
export interface PreTradeGateSummary {
  total: number;
  passed: number;
  failed: number;
  /** passed / total; null on an empty ledger. */
  passRate: number | null;
  /** Count of decisions that cited each reason (a failed row can cite several). */
  reasonCounts: Record<PreTradeGateReason, number>;
  /** Per-engine total/pass split, so QuantTrader can slice by candidate stream. */
  byEngine: Record<PreTradeGateEngine, { total: number; passed: number }>;
}

const ALL_REASONS: PreTradeGateReason[] = [
  'MTF_MISALIGNED',
  'RVOL_BELOW_THRESHOLD',
  'RR_BELOW_MIN',
  'ATR_STOP_MISSING',
];

const ALL_ENGINES: PreTradeGateEngine[] = ['options', 'equity', 'crypto'];

/**
 * Aggregate decisions into the pass-rate + per-reason rejection breakdown the
 * TRA-1457 health probe exposes. This is the core artifact QuantTrader validates:
 * how selective the gate is (pass-rate) and WHY it rejects (reason mix), feeding
 * the same A/B methodology as the frozen NO-GO shadow baseline (TRA-789/1245).
 */
export function preTradeGateSummary(rows: PreTradeGateDecision[]): PreTradeGateSummary {
  const reasonCounts = Object.fromEntries(ALL_REASONS.map((r) => [r, 0])) as Record<
    PreTradeGateReason,
    number
  >;
  const byEngine = Object.fromEntries(
    ALL_ENGINES.map((e) => [e, { total: 0, passed: 0 }]),
  ) as Record<PreTradeGateEngine, { total: number; passed: number }>;

  let passed = 0;
  for (const r of rows) {
    if (r.pass) passed++;
    for (const reason of r.reasons) reasonCounts[reason]++;
    const eng = byEngine[r.engine];
    if (eng) {
      eng.total++;
      if (r.pass) eng.passed++;
    }
  }
  const total = rows.length;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total > 0 ? passed / total : null,
    reasonCounts,
    byEngine,
  };
}
