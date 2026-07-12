import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  settleWeeklyPcs,
  WEEKLY_PCS_DEFAULTS,
  type WeeklyPcsSignal,
} from '@trading-app/engine';
import type { PromotionTradeSample } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { etDateKey } from './options-chain-recorder.js';

// TRA-1618 (parent TRA-1614) — durable, flag-gated SHADOW ledger for the weekly
// QQQ put-credit-spread forward test.
//
// The engine's `selectWeeklyPcs`/`settleWeeklyPcs` (weekly-pcs-signal.ts) are the
// pure selection + expiry-settlement. This module is the server seam that
// (a) reads the feature flag, (b) records ONE open spread per underlying per
// weekly cycle from a real chain snapshot, (c) settles due spreads to expiry
// against the realized underlying price, and (d) exposes the settled weekly
// trades as promotion-gate paper samples so they accrue into the TRA-532 Stage-2
// leg. NOTHING here routes an order, touches sizing, or influences an exit — it
// is observe-only, $0 live.
//
// SCOPE: the base PCS only. TRA-1617 showed the discretionary martingale
// call-rescue is what drives the strategy's 41:1 tail; a shadow log must never
// silently run a martingale add-on, so the rescue is intentionally NOT emitted
// here. The forward leg therefore pairs with the base-PCS slice of the TRA-1617
// backtest (its per-week `pcsPnl`, tracked separately from `rescuePnl`), NOT the
// blended PCS+rescue series — hence the distinct strategy id below.
//
// Cadence: deduped to ONE open per underlying per weekly cycle (the ET session of
// the Friday entry). A per-tick re-capture would open the same spread dozens of
// times a day, so the first entry of a cycle is the recorded one and later ticks
// that cycle are no-ops. Settlement re-marks each open spread once its expiry has
// passed and freezes the realized R.

const log = logger.child({ module: 'pcs-shadow-ledger' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Phase-1 kill switch. Off by default so a deploy can't start writing PCS shadow
 * rows (or feeding them into the promotion gate) without an explicit operator
 * opt-in. Accepts the usual truthy spellings.
 */
export const PCS_SHADOW_FLAG = 'ENABLE_PCS_SHADOW';

export function isPcsShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PCS_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Strategy id the forward paper leg accrues under. Distinct from TRA-1617's
 * registered `qqq_weekly_pcs_rescue` because this leg is the BASE PCS (no rescue)
 * — it pairs with that backtest's per-week `pcsPnl` slice. Kept a constant so the
 * promotion-service wiring and the health probe agree on one id.
 */
export const PCS_SHADOW_STRATEGY_ID = 'qqq_weekly_pcs';

/**
 * Underlyings the forward test opens on. QQQ only — the TRA-1614 video and the
 * TRA-1617 backtest are QQQ-specific. Kept a set so the signal-engine wiring
 * skips every other tracked symbol cheaply.
 */
export const PCS_SHADOW_UNDERLYINGS: ReadonlySet<string> = new Set(['QQQ']);

/**
 * Inclusive calendar-DTE band a tracked expiry must fall in to be treated as the
 * "weekly" the strategy sells. The option-shadow selector's tracked expiry is
 * DTE-preferenced (not guaranteed 7DTE), so the entry only fires when the
 * available chain is genuinely a ~weekly expiry — otherwise the forward test
 * would silently swap in a 30–45 DTE spread, a materially different strategy.
 */
export const PCS_ENTRY_DTE_BAND: readonly [number, number] = [3, 10];

/**
 * True when `asof` falls on a Friday in ET — the weekly entry cadence the video
 * sells (open Friday, expire the next Friday). Uses the ET calendar so a late-
 * night-UTC Thursday still reads as Thursday.
 */
export function isWeeklyPcsEntryDay(asof: number): boolean {
  const wd = new Date(asof).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
  return wd === 'Fri';
}

/** What the caller hands the ledger to open one weekly spread. */
export interface PcsEntryInput {
  underlying: string;
  /** ms-epoch of the entry (the Friday open). */
  asof: number;
  /** The selected spread from `selectWeeklyPcs`. */
  signal: WeeklyPcsSignal;
  /** ms-epoch the weekly spread expires (≈ next Friday). */
  expiryMs: number;
}

/** One persisted weekly PCS shadow record (open, then settled in place). */
export interface PcsShadowRecord {
  /** Stable dedupe key: `${underlying}:${cycle}`. */
  id: string;
  /** ET trading day (YYYY-MM-DD) of the entry — the weekly cycle key. */
  cycle: string;
  underlying: string;
  /** ms-epoch of entry. */
  openedAt: number;
  /** ms-epoch the spread expires. */
  expiryMs: number;
  shortStrike: number;
  longStrike: number;
  shortDelta: number;
  /** Per-share net credit received at entry. */
  credit: number;
  width: number;
  /** Defined max loss in $ = (width − credit) × 100 — the R denominator. */
  riskDollars: number;
  entrySpot: number;
  /** 'open' until expiry, then 'settled'. */
  status: 'open' | 'settled';
  // ── settlement (null until settled) ──
  /** ms-epoch settlement was recorded. */
  settledAt: number | null;
  /** Realized underlying price used to settle. */
  settleSpot: number | null;
  /** Realized net P&L in $. */
  pnl: number | null;
  /** Realized R = pnl / riskDollars. */
  R: number | null;
  breached: boolean | null;
  maxLoss: boolean | null;
}

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'pcs-shadow-signals.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the ledger at a temp file. Pass `null` to restore default. */
export function setPcsShadowLedgerFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** In-memory folded view: id -> record (append-only file, latest line wins). */
let cache: Map<string, PcsShadowRecord> | null = null;

async function ensureLoaded(): Promise<Map<string, PcsShadowRecord>> {
  if (cache) return cache;
  const map = new Map<string, PcsShadowRecord>();
  const path = storeFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as PcsShadowRecord;
          if (rec && typeof rec.id === 'string') map.set(rec.id, rec);
        } catch {
          // Skip a single corrupt line rather than losing the whole ledger.
        }
      }
    } catch (err) {
      log.error('failed to read pcs shadow ledger, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the ledger so reads have data right after boot. */
export async function initPcsShadowLedger(): Promise<void> {
  await ensureLoaded();
}

async function appendRecord(rec: PcsShadowRecord): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf-8');
}

/** Result of an entry attempt. */
export interface PcsEntryResult {
  written: boolean;
  reason?: 'flag_off' | 'duplicate';
  record?: PcsShadowRecord;
}

/**
 * Open one weekly PCS into the shadow ledger. Flag-gated and deduped to one open
 * per underlying per weekly cycle (the ET session of the entry). NEVER routes an
 * order. Returns whether a new open row was written.
 */
export async function recordWeeklyPcsEntry(input: PcsEntryInput): Promise<PcsEntryResult> {
  if (!isPcsShadowEnabled()) return { written: false, reason: 'flag_off' };

  const map = await ensureLoaded();
  const cycle = etDateKey(input.asof);
  const id = `${input.underlying}:${cycle}`;
  const existing = map.get(id);
  if (existing) return { written: false, reason: 'duplicate', record: existing };

  const s = input.signal;
  const rec: PcsShadowRecord = {
    id,
    cycle,
    underlying: input.underlying,
    openedAt: input.asof,
    expiryMs: input.expiryMs,
    shortStrike: s.shortStrike,
    longStrike: s.longStrike,
    shortDelta: s.shortDelta,
    credit: s.credit,
    width: s.width,
    riskDollars: s.riskDollars,
    entrySpot: s.entrySpot,
    status: 'open',
    settledAt: null,
    settleSpot: null,
    pnl: null,
    R: null,
    breached: null,
    maxLoss: null,
  };
  map.set(id, rec);
  await appendRecord(rec);
  log.info('pcs shadow entry recorded', {
    id,
    shortStrike: rec.shortStrike,
    longStrike: rec.longStrike,
    credit: rec.credit,
    shortDelta: rec.shortDelta,
  });
  return { written: true, record: rec };
}

/** Reconstruct the engine signal from a stored open record (for settlement). */
function signalOf(rec: PcsShadowRecord): WeeklyPcsSignal {
  return {
    shortStrike: rec.shortStrike,
    longStrike: rec.longStrike,
    shortDelta: rec.shortDelta,
    credit: rec.credit,
    width: rec.width,
    riskDollars: rec.riskDollars,
    entryCommission: 2 * WEEKLY_PCS_DEFAULTS.commissionPerContract,
    entrySpot: rec.entrySpot,
  };
}

/** Result of a settlement sweep. */
export interface PcsSettleResult {
  /** Number of open spreads settled this sweep. */
  settled: number;
  /** The settled records (freshly frozen). */
  records: PcsShadowRecord[];
}

/**
 * Settle every open spread whose expiry has passed, against the current
 * underlying price from `spotAt`. The forward test holds to expiry (no intraday
 * management), so `spotAt(underlying)` supplies the best available realized
 * settlement price for the expired cycle; a null/NaN lookup leaves the spread
 * open to retry next sweep. Flag-gated. NEVER routes an order.
 */
export async function settleDuePcsEntries(
  nowMs: number,
  spotAt: (underlying: string) => number | null | undefined,
): Promise<PcsSettleResult> {
  if (!isPcsShadowEnabled()) return { settled: 0, records: [] };

  const map = await ensureLoaded();
  const out: PcsShadowRecord[] = [];
  for (const rec of map.values()) {
    if (rec.status !== 'open') continue;
    if (rec.expiryMs > nowMs) continue;
    const spot = spotAt(rec.underlying);
    if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) continue;

    const settlement = settleWeeklyPcs(signalOf(rec), spot);
    const settled: PcsShadowRecord = {
      ...rec,
      status: 'settled',
      settledAt: nowMs,
      settleSpot: spot,
      pnl: settlement.pnl,
      R: settlement.R,
      breached: settlement.breached,
      maxLoss: settlement.maxLoss,
    };
    map.set(settled.id, settled);
    await appendRecord(settled);
    out.push(settled);
    log.info('pcs shadow spread settled', {
      id: settled.id,
      settleSpot: spot,
      pnl: settlement.pnl,
      R: settlement.R,
      breached: settlement.breached,
    });
  }
  return { settled: out.length, records: out };
}

/** All persisted PCS shadow records, ascending by entry time. */
export async function listPcsShadowSignals(): Promise<PcsShadowRecord[]> {
  const map = await ensureLoaded();
  return [...map.values()].sort((a, b) => a.openedAt - b.openedAt);
}

/**
 * The SETTLED weekly trades mapped to promotion-gate paper samples, for the
 * forward Stage-2 leg. Empty unless the flag is on and the requested strategy is
 * this ledger's base-PCS id. The gate reads R as `pnl / (|entryPrice − stopLoss|
 * × quantity)`, so we encode the spread's defined risk directly: entryPrice =
 * width, stopLoss = credit, quantity = 100 ⇒ riskAmount = (width − credit) × 100
 * = `riskDollars`, giving R = pnl / riskDollars — the same R the settlement
 * computed. Only closed (settled) cycles contribute.
 */
export async function collectPcsShadowPaperSamples(
  strategyId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PromotionTradeSample[]> {
  if (!isPcsShadowEnabled(env)) return [];
  if (strategyId !== PCS_SHADOW_STRATEGY_ID) return [];

  const map = await ensureLoaded();
  const samples: PromotionTradeSample[] = [];
  for (const rec of map.values()) {
    if (rec.status !== 'settled' || rec.pnl == null) continue;
    samples.push({
      pnl: rec.pnl,
      entryPrice: rec.width,
      stopLoss: rec.credit,
      quantity: 100,
      openedAt: rec.openedAt,
      closedAt: rec.settledAt ?? undefined,
    });
  }
  return samples;
}

/**
 * Count of settled cycles carrying a realized P&L — the promotion denominator for
 * QuantTrader's Stage-2 shadow-window check. Open (unsettled) cycles don't count.
 */
export function settledSignalCount(records: readonly PcsShadowRecord[]): number {
  return records.filter((r) => r.status === 'settled' && typeof r.pnl === 'number').length;
}
