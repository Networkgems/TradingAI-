// TRA-4628 (parent TRA-4621, ruling TRA-4623) — the OTM candidate-ADMISSION tape.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-4623 ran the TRA-461-shaped `minMark × maxSpreadPct` sweep and declined its
// own readout: the pre-registered rule names the ADMITTED-CANDIDATE count as its
// denominator, but the only durable population was traded-and-closed journal rows
// — downstream of the ranker AND the capital gate. Retention measured there is a
// survivorship statistic whose bias sign is UNMEASURABLE without this tape.
// (Desk tape n=79/23 sessions: 3 rows below $0.10 and zero in $0.10–$0.20 — the
// journal cannot say whether the scanner rarely ADMITS cheap contracts or the
// ranker rarely PICKS them.)
//
// So: an append-only row per candidate per RECORDED scan pass, stamped at
// admission-decision time inside `findMispricedOtmContracts` (the engine
// `onAdmission` tap), admitted AND refused, with the FIRST BINDING gate.
// `mark`/`spreadPct` use the scanner's own `(bid+ask)/2` mid — the same
// convention as the TRA-1656 entry stamp — so the tape's axes are directly
// comparable to the journal's.
//
// ── SAMPLING POLICY (load-bearing — see the TRA-4628 constraint) ─────────────
// This surface would otherwise write every scanned contract on every sweep pass.
// Volume is bounded by three rules, every one of them INDEPENDENT of `mark` and
// `spreadPct` (a quote-correlated sample would destroy the exact retention ratio
// being measured) AND — since policy v2 — independent of time-of-day:
//   1. SLOT SAMPLER — the ET day is cut into 30-minute slots. A (book × symbol)
//      pass is recorded iff it is the first `ok` pass of that pair inside the
//      slot AND `fnv1a(book|symbol|etDay|slot) % SAMPLE_MOD[class] === 0`. The
//      selection is decided BEFORE the scan from identity and the clock alone —
//      never from a quote, never from scan order. Unselected passes still scan
//      and trade exactly as before; they are simply not written.
//   2. WHOLE-PASS DROPS ONLY — a pass whose decision count exceeds
//      `MAX_ROWS_PER_PASS` is dropped IN FULL and counted
//      (`oversizedPassesDropped`), never truncated: truncation by chain position
//      correlates with strike and therefore with mark.
//   3. PER-SLOT BUDGET — a (accountClass × ET day × slot) cell holds at most
//      `MAX_ROWS_PER_SLOT[class]` candidate rows. Since policy v3 the budget
//      THINS passes rather than starving symbols — see the next block.
//
// ── RULE 3 THINS, IT DOES NOT STARVE (TRA-4954, policy v3) ──────────────────
// Policy v2 dropped a pass IN FULL once `rowsBySlot[slot] + n > slotBudget`.
// That is first-come eviction, and it has two measured biases (bqb1 2026-10-01,
// raw pull, both classes):
//   - it preferentially discards LARGE passes, because a big pass is likelier to
//     breach the remaining headroom (mean banked 38.2 → mean dropped 50.9 desk;
//     26.1 → 45.2 fixture), and pass size tracks option-chain width, which tracks
//     LIQUIDITY — so the names it drops are the TIGHTEST-SPREAD ones;
//   - once a slot fills, every remaining symbol in it banks ZERO rows. Measured
//     on 2026-10-01: 54 (desk) and 985 (fixture) (slot × symbol) cells presented
//     and banked nothing — SPY/QQQ/TSLA/GOOGL/META 100% dropped on fixture.
// `byBindingReason` is folded over the banked subsample, so under-representing
// tight-spread names biases `max_spread_pct` binding UPWARD — the exact axis the
// TRA-4623 `minMark × maxSpreadPct` readout reads.
//
// v3 replaces whole-pass eviction with an allowance per pass
// ({@link otmAdmissionSlotAllowance}) built from two terms:
//   FLOOR    — every symbol that PRESENTS in a slot is guaranteed
//              `min(FLOOR_ROWS_PER_SYMBOL, floor(budget / expectedSymbols))`
//              rows, held in reserve for symbols that have not presented yet, so
//              arriving late in the slot can no longer cost a symbol its row.
//   SHARE    — the discretionary remainder is split in PROPORTION to pass size
//              (`headroom × n / expectedRemainingRows`). Proportional is the only
//              split under which the SHED FRACTION is independent of pass size;
//              a max-min/equal-rows split would shed strictly more from wide
//              chains, which is the bias being removed (TRA-4954 AC3).
// `expectedSymbols` / `expectedRows` are learned PER (class × slot index) as the
// running max over every day on disk, seeded from the measurement above. They are
// read off identity, the clock and row COUNTS only — never a quote.
//
// 🔴 WHICH rows survive a truncation is chosen by `fnv1a(occSymbol)` rank, NOT by
// chain position. Truncating by chain position correlates with strike and
// therefore with mark — the thing rule 2 exists to avoid. A hash rank is a
// uniform subsample of the chain and is reproducible from the row itself.
//
// A thinned pass writes its banked rows AND a `budgetdrop` row carrying
// `passRows` (the pass's full size), `rows` (what was shed) and `banked` (what
// survived), so the bias stays measurable after the change exactly the way
// TRA-4906 made it measurable before it. `banked: 0` is the v2 whole-drop shape.
//
// ── A DROP IS ITSELF A DURABLE ROW (TRA-4906, ruling TRA-4905) ───────────────
// Rule 3 is the leg that SETS desk volume (the budget saturates almost every RTH
// slot), so how often it bites — and how big the dropped passes were — is the
// measurement that sizes this file. `slotBudgetPassesDropped` alone could never
// answer it: one module-level integer, reset by every boot, published as a
// process total, and rebuilt from NOTHING on hydrate because a dropped pass used
// to write no row. At ~3.3 deploys/day a 6.5h RTH window survives intact well
// under half the time, so "read the scalar during RTH on a boot since the open"
// is not a measurement anyone can schedule. So rule 3 now emits one compact
// `kind: 'budgetdrop'` row per dropped pass carrying its `slot` and its `rows`
// (the pass's size — the DIRECT reading of the size-filtering bias TRA-4905
// could only reach through a paired within-slot test). It rebuilds per slot from
// disk exactly the way `rowsBySlot` does, published as `dropsBySlotEt`. Since
// v3 that row is emitted for a TRUNCATION too, and `rows` means "rows SHED".
// ⚠ A `budgetdrop` row is NOT SAMPLE. It is excluded from `candidateRows`,
// `admitted`, `ranked`, `ordered` and `sessionsWithAdmissions`, and must never be
// counted as a candidate by any reader. Its cost is ~95 B/row, well under
// 150 KB/session against {@link MAX_FILE_BYTES} — not a sizing concern.
//
// ── LINK ROWS: `ranked` IS A SET, `ordered` IS A LOG (TRA-4906) ──────────────
// `ranked` is deduped per `(etDay, slot, accountClass, occSymbol)`. This is
// information-preserving, NOT a throttle: the survivorship join needs the SET of
// nominated contracts, and its candidate leg is itself `(etDay, slot)`-granular,
// so a link finer than slot granularity has nothing finer to join to. Measured
// pre-change on live bqb1 (2026-09-25, build `a158c516`): 4.33x–11.56x
// duplication, with `XLF261030C00056000` written 87 times on 09-24, while the
// count of DISTINCT nominated contracts was falling (872 → 1,023 → 800 over the
// three complete sessions) as raw rows rose. Skips are counted
// (`rankedDuplicatesSkipped`); the set is rebuilt on hydrate, so a mid-session
// boot re-admits at most that session's remainder.
// 🔴 `ordered` is NEVER deduped and NEVER throttled. It reads 0 on every day and
// both classes, so it costs nothing, and an `ordered` row is execution
// provenance — the one thing here that attests a real order.
// ⚠ Policy v1 (f39e939b, live 2026-09-17..18) had a 2h per-pair throttle and a
// first-come 6000-row DAILY budget. On its first session (2026-09-18) the desk
// budget was exhausted by 10:17 ET and the fixture budget within one minute of
// the open, so the whole day's tape was the opening 47 minutes — the widest-
// spread half-hour, and entirely outside `OTM_ENTRY_WINDOWS_ET`. Time-of-day
// correlates with spread, so v1 rows are NOT a quote-independent sample; they
// carry no `samplingPolicy` field and are excluded from the AC4 session count.
// ── CLASSES ARE NEVER POOLED ─────────────────────────────────────────────────
// Every row carries `accountClass` (TRA-2355 classifier, frozen at DECISION
// time — TRA-3715/TRA-3682/TRA-3709). The desk table is the evidence; fixture is
// retention-shape only. The class is stored, not the username (no PII on disk).
//
// ── DURABILITY / RETENTION ───────────────────────────────────────────────────
// JSONL-appended under DATA_DIR (the cost-aware-gate-ledger pattern), rebuilt and
// COMPACTED on boot: rows older than `RETAIN_MS` are dropped, then whole OLDEST
// ET days are pruned until the file fits `MAX_FILE_BYTES`. An evidence archive
// has no backfill — the tape starts accruing at deploy (expected; TRA-4628).
// In-memory state is per-day AGGREGATES plus a small throttle map — bounded, so
// the TRA-4158 RSS ceiling is not in play.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only. NEVER places an order, mutates an account, or feeds any decision
// back into the scan path. No selection parameter is read or changed here. The
// in-memory tally updates first and unconditionally; the disk append is
// best-effort and COUNTED when it fails (`appendErrors`) — a lost row must not
// read identically to a written one (TRA-1681).

import { appendFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import type { OtmAdmissionDecision, OtmAdmissionRefusalReason } from '@trading-app/engine';
import { logger } from './observability/index.js';
import {
  bufferSharedTapeAppend,
  sharedTapeCompactionState,
  sharedTapeRewriteInFlight,
  type SharedTapeCompactionState,
  type SharedTapeSpec,
} from './shared-tape-compaction.js';
import { etDateString } from './scheduler.js';
import { etClockParts } from './et-clock.js';
import {
  classifySpreadCeilingAccount,
  type SpreadCeilingAccountClass,
} from './option-spread-cost.js';

const log = logger.child({ module: 'otm-admission-tape' });

export const OTM_ADMISSION_TAPE_FILENAME = 'otm-admission-tape.jsonl';

/** Registry key for the shared compaction hook (TRA-5038). */
export const OTM_ADMISSION_TAPE = 'otm-admission-tape';

/**
 * Rows written by this build carry this; v1 rows (no field) are open-biased.
 *
 * `2` = the slot sampler with WHOLE-PASS budget eviction (2026-09-19 → 10-02).
 * `3` = the same sampler with THINNING eviction (TRA-4954). A v3 slot is a
 * per-symbol-capped subsample of its own demand where a v2 slot was a
 * first-come prefix of it, so the two must not be pooled inside one readout —
 * filter `samplingPolicy === 3` for anything that reads per-symbol coverage.
 * Both are quote-independent, so `>= 2` remains the correct filter for the
 * TRA-4623 AC4 session count and for any mark/spread retention ratio.
 */
export const OTM_ADMISSION_SAMPLING_POLICY = 3;
/** ET slot width for the sampler (rule 1) and the budget (rule 3). */
const SLOT_MINUTES = 30;
/**
 * Rule-1 modulus per class. Sized off the 2026-09-18 desk tape (192 symbols,
 * ~31 decisions per pass, one universe cycle ≈ 45 min ⇒ ~53k rows/day
 * unsampled): 12 ⇒ ~4.5k desk rows/day ≈ 1.5 MB, so the byte cap holds well
 * over the ≥20 desk sessions AC4 needs. Non-desk classes are retention-shape
 * only and scan far faster (fixture: 113 passes in the first minute), so they
 * are sampled harder.
 */
const SAMPLE_MOD: Record<string, number> = { desk: 12 };
const SAMPLE_MOD_OTHER = 48;
/** Rule-3 per (class × ET day × slot) row budget — a backstop, ~3x desk's expected slot volume. */
const MAX_ROWS_PER_SLOT: Record<string, number> = { desk: 1000 };
const MAX_ROWS_PER_SLOT_OTHER = 200;
/** A pass bigger than this is dropped WHOLE (rule 2 above), never truncated. */
const MAX_ROWS_PER_PASS = 400;
/**
 * TRA-4954 — the per-(slot × symbol) floor. Every symbol that PRESENTS in a slot
 * banks at least this many rows, before any symbol takes a second helping. The
 * effective floor is `min(this, floor(budget / expectedSymbols))`, so a class
 * whose universe cannot fit two rows each (fixture: 94 symbols into 200 rows)
 * degrades to 1 rather than silently re-starving its tail.
 */
const FLOOR_ROWS_PER_SYMBOL = 2;
/**
 * Seed for the per-(class × slot) demand learner, in DISTINCT SYMBOLS per slot.
 * Measured on bqb1 2026-10-01 off the raw pull: desk max 36/slot (mean 28.2),
 * fixture max 94/slot (mean 83.3). Seeded ~33%/17% above the observed max so the
 * floor reserve survives a universe that grows before the learner sees it — the
 * learner only ever raises these, never lowers them.
 */
const SEED_SYMBOLS_PER_SLOT: Record<string, number> = { desk: 48 };
const SEED_SYMBOLS_PER_SLOT_OTHER = 110;
/**
 * COLD-BOOT default for the same learner in PRESENTED ROWS per slot (banked +
 * shed) — the denominator of the proportional share. Measured the same way: desk
 * max 2,048 per slot (range 699–2,048), fixture max 6,834 (range 4,313–6,834).
 *
 * 🔴 The two seeds are floored DIFFERENTLY, on purpose.
 * {@link SEED_SYMBOLS_PER_SLOT} is a FLOOR the learner may only raise: it sizes
 * the reserve that guarantees AC1, and over-reserving costs only
 * `floorRowsPerSymbol × expectedSymbols` rows (96 desk / 110 fixture out of the
 * slot), so conservatism there is nearly free.
 * This one is a DEFAULT used only where that (class × slot) has no history:
 * flooring it at the global max would make a quiet slot thin against a busy
 * slot's demand and under-spend the budget by ~38% (measured in simulation
 * against the 2026-10-01 tape: 7,472 desk rows banked vs 12,119 presented).
 * Per-slot history is far tighter than a global max, and the term is raised to
 * `presented + n` intra-slot anyway, so a slot that blows past its own history
 * self-corrects within itself.
 *
 * ⚠ It is still the running MAX over the days on disk, never a mean or an EWMA.
 * An expectation that UNDER-reads demand empties the discretionary pool part-way
 * through the slot and hands the remainder to whoever scanned FIRST — an
 * order-correlated bias, which is strictly worse than the precision cost of
 * over-reading. A smaller unbiased sample beats a larger biased one for a
 * readout whose whole subject is the bias. (AC1 and AC2 do not depend on this
 * term at all: `share ≤ headroom` holds for any value of it.)
 */
const SEED_ROWS_PER_SLOT: Record<string, number> = { desk: 2100 };
const SEED_ROWS_PER_SLOT_OTHER = 7000;
/**
 * Keep this many ms on disk — comfortably over the ≥20 RTH desk sessions AC4
 * needs. It is deliberately SLACK: at the volume measured on
 * {@link MAX_FILE_BYTES} the byte cap prunes long before 60 days elapse, so
 * this leg has never bound and is here as the floor under a future, thinner
 * sample (where 60 days of thin rows is a strictly better archive than 20
 * sessions of fat ones). Do not cite it as the retention horizon.
 */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;
/**
 * After time compaction, prune whole OLDEST ET days until the file fits this.
 *
 * ── THE NUMBER IS THE AC4 BAR, NOT A ROUND ONE (TRA-4899) ───────────────────
 * This is a RESERVATION against a 973.4 MiB volume that also holds all 68
 * books' close ledgers in 64 MiB (TRA-4156). The previous value, 192 MiB, was
 * 3x that entire ledger budget for one instrumentation tape, so it is sized
 * here off the requirement it exists to serve and nothing else.
 *
 * MEASURED live on bqb1 2026-09-25T03:22Z, build `a158c516`, off
 * `/api/health/otm-admission-tape` `durability` + `byClass[].days[]`:
 *   - 29,956,613 B / 98,575 hydrated rows = **303.9 B/row** (blended; candidate
 *     rows ≈ 357 B, `ranked`/`ordered` link rows ≈ 150 B).
 *   - v2 sessions 09-21/22/23/24 = 20,809 / 21,091 / 18,796 / 23,977 rows
 *     ⇒ mean **6.43 MB/session**, max **7.29 MB/session** (09-24).
 * The AC4 bar (TRA-3927/TRA-4623) is **≥20 desk sessions of RAW rows on disk
 * simultaneously**, and `sessionsWithAdmissions` is itself rebuilt from
 * hydrated days, so a cap below the bar makes the bar unreachable:
 *   20 × 7.29 MB = 145.8 MB is the FLOOR. 144 MiB = 151.0 MB clears it by 3.5%
 *   ⇒ **20.7 worst-case sessions, 23.5 mean-case**. The 48 MiB returned is,
 *   exactly, the whole 68-book `closes/` budget.
 *
 * ⚠ The 60-day {@link RETAIN_MS} does NOT bind first — the comment this
 * replaces claimed it did, and was wrong by its own arithmetic. 60 calendar
 * days ≈ 42 trading sessions ≈ 270 MB at the volume measured above, which is
 * above the old 192 MiB and far above this. **The byte cap is the only leg
 * that has ever bound this file**, which is why it is the whole lever here.
 *
 * ⚠ This cap is applied at BOOT ONLY (see {@link hydrateOtmAdmissionTapeFromDisk}),
 * so it is a compaction target, not a live ceiling. The true reservation is
 * `cap + rate × maxBootInterval`: at the measured 6.43 MB/session and bqb1's
 * longest observed gap between process boots (4.93 days over the 100 deploys
 * 2026-08-26→09-25, an upper bound since watchdog restarts also compact),
 * that is 151.0 + ~22 = **~173 MB worst case on disk**. Do not quote 144 MiB
 * as a hard ceiling.
 *
 * Getting this under the 64 MiB the close ledger lives in needs the SAMPLE to
 * shrink, not the cap: `MAX_ROWS_PER_SLOT.desk` saturates almost every RTH slot
 * (13 slots × 1000 ≈ the 12,168–12,990 rows/session measured), so desk volume
 * is policy-set, not demand-driven. That is TRA-4628's call and is tracked
 * separately — it must not be changed mid-collection without re-registering
 * the readout, because it reweights sessions already banked.
 */
const MAX_FILE_BYTES = 144 * 1024 * 1024;
/** Hard cap on rows a single health-route read may return. */
const MAX_READ_ROWS = 20_000;

/**
 * One admission decision, durable. Every field beyond the identity/axis core is
 * OPTIONAL on the read side — a row written by an older build genuinely lacks it.
 */
export interface OtmAdmissionTapeCandidateRow {
  kind: 'candidate';
  /** Decision time, ms epoch (the scan pass's stamp — all rows of a pass share it). */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /** TRA-2355 class, frozen at decision time. Classes are never pooled. */
  accountClass: SpreadCeilingAccountClass;
  /** Engine mode the scanning book runs in (`demo` / `live`). */
  mode?: string;
  underlying: string;
  occSymbol: string;
  expiry: string;
  strike: number;
  right: string;
  bid: number;
  ask: number;
  /** (bid+ask)/2 — SAME convention as the TRA-1656 entry stamp (see engine tap). */
  mark: number;
  /** (ask−bid)/mark on the mid above. */
  spreadPct: number;
  openInterest: number;
  /** Absent when refused before the greeks stage; may be non-finite → omitted. */
  absDelta?: number;
  admitted: boolean;
  /**
   * FIRST binding gate in the engine's evaluation order (`none` iff admitted).
   * The full-set alternative was considered and rejected: the first-binding
   * convention is what the engine can attest without re-running gates it never
   * reached, and the sweep only needs the surviving axes, which every row
   * carries regardless of where it was refused.
   */
  bindingReason: OtmAdmissionRefusalReason;
  /**
   * Sampling policy that selected this row. ABSENT on v1 rows (the open-biased
   * first-come daily budget — see the policy header); `2` = the slot sampler.
   * A readout MUST filter to `samplingPolicy >= 2`.
   */
  samplingPolicy?: number;
}

/** A nominee (`ranked`) or a final open (`ordered`) — the survivorship links. */
export interface OtmAdmissionTapeLinkRow {
  kind: 'ranked' | 'ordered';
  ts: number;
  etDay: string;
  accountClass: SpreadCeilingAccountClass;
  mode?: string;
  underlying: string;
  occSymbol: string;
}

/**
 * One rule-3 slot-budget drop, durable (TRA-4906). NOT SAMPLE — see the header.
 * Carries its own `slot` rather than leaving it to be re-derived from `ts`, so a
 * later change to {@link SLOT_MINUTES} cannot silently re-bucket banked drops.
 */
export interface OtmAdmissionTapeBudgetDropRow {
  kind: 'budgetdrop';
  ts: number;
  etDay: string;
  accountClass: SpreadCeilingAccountClass;
  /** ET 30-minute slot index the shed rows would have been written into. */
  slot: number;
  underlying: string;
  /**
   * Rows SHED by rule 3. Under v2 this was always the whole pass; under v3
   * (TRA-4954) a pass is usually truncated, so this is `passRows - banked`.
   */
  rows: number;
  /**
   * The pass's FULL size — the size-filter reading, and the only field that
   * survives truncation as a statement about demand. ABSENT on v2 rows, where
   * the pass was dropped whole and `rows` already carried it.
   */
  passRows?: number;
  /**
   * Rows of this pass that DID bank. `0` (or absent, on a v2 row) is the
   * whole-drop shape — the TRA-4954 AC1 reading is "no (slot × symbol) cell has
   * a shed row with `banked: 0` and no candidate rows".
   */
  banked?: number;
}

export type OtmAdmissionTapeRow =
  | OtmAdmissionTapeCandidateRow
  | OtmAdmissionTapeLinkRow
  | OtmAdmissionTapeBudgetDropRow;

/**
 * Rule-3 shedding in one (class × day × slot) cell. `passes` counts passes that
 * shed ANYTHING; `wholeDrops` counts the subset that banked nothing — the v2
 * shape, and the TRA-4954 AC1 alarm. `passRows` is the full size of the shed
 * passes, which is what AC3's size comparison reads.
 */
export interface OtmAdmissionSlotShedCell {
  passes: number;
  rows: number;
  banked: number;
  passRows: number;
  wholeDrops: number;
}

interface ClassDayTally {
  candidateRows: number;
  admitted: number;
  /** Admitted rows selected by policy >= 2 — the only ones AC4 counts. */
  admittedSampled: number;
  /** Candidate rows with no `samplingPolicy` (v1, open-biased). */
  legacyRows: number;
  byBindingReason: Record<string, number>;
  passesRecorded: number;
  ranked: number;
  ordered: number;
  firstTs: number;
  lastTs: number;
  /** Candidate rows per ET 30-minute slot — rule-3 budget AND time coverage. */
  rowsBySlot: Map<number, number>;
  /**
   * Rule-3 slot-budget drops per ET slot, rebuilt from `budgetdrop` rows on
   * hydrate exactly the way {@link rowsBySlot} is (TRA-4906). `passes` = dropped
   * passes, `rows` = candidate rows they would have written. NEVER sample.
   */
  dropsBySlot: Map<number, OtmAdmissionSlotShedCell>;
  /** `${underlying}|${ts}` of the last candidate row — rows of a pass are contiguous. */
  lastPassKey: string;
}

// ── Module state (bounded: aggregates + per-pair slot map, never raw rows) ───
let dataDir: string | null = null;
/** etDay → accountClass → tally. */
const byDay = new Map<string, Map<string, ClassDayTally>>();
/** `${book}|${symbol}` → `${etDay}|${slot}` of the pair's last COMMITTED pass (rule 1). */
const lastSlotByPair = new Map<string, string>();
/**
 * etDay → `${slot}|${accountClass}|${occSymbol}` already written as a `ranked`
 * link (TRA-4906). Holds ONE ET day at a time — see {@link markRankedSeen} — so
 * it is bounded by a single session's nominee set (~1k contracts × 13 RTH slots
 * × classes), which keeps the TRA-4158 RSS ceiling out of play.
 */
const rankedSeen = new Map<string, Set<string>>();
/**
 * TRA-4954 — etDay → `${accountClass}|${slot}` → underlyings that have PRESENTED
 * in that cell (banked or shed). Drives the floor reserve's "how many symbols
 * are still to come" term. Holds ONE ET day at a time, evicted exactly the way
 * {@link rankedSeen} is: hydrate walks days ascending and the live path only
 * ever writes today, so the survivor is always the newest. Bounded by one
 * session's (slots × symbols) — ~48 × 110 per class, so the TRA-4158 RSS
 * ceiling is not in play.
 */
const slotSymbols = new Map<string, Map<string, Set<string>>>();
/**
 * TRA-4954 — `${accountClass}|${slot}` → the learned demand for that slot of the
 * day: the running MAX over every day on disk of distinct symbols and of
 * presented rows. Rebuilt on hydrate through {@link applyRow}, so there is no
 * second learning site to drift from the live one. Bounded by 48 slots × classes.
 */
const slotDemand = new Map<string, SlotDemand>();

/**
 * 🔴 `priorRows` excludes the day currently accruing. The expectation has to be a
 * statement about a WHOLE slot, and today's partial total is not one: feeding it
 * back would make the first pass of a fresh slot the whole expectation, the
 * second pass see "no rows left to come", and the budget go first-come again —
 * the exact bias TRA-4954 removes. `dayRows` accrues today and is folded into
 * `priorRows` when the day rolls over (hydrate walks days ascending, so the fold
 * happens there too, on the same code path).
 */
interface SlotDemand {
  /** Max distinct symbols in this slot over ALL days seen, today included. */
  symbols: number;
  /** Max presented rows over days STRICTLY BEFORE {@link day}. 0 = no history. */
  priorRows: number;
  /** The ET day {@link dayRows} is accruing. */
  day: string;
  /** Presented rows in this slot on {@link day} so far. */
  dayRows: number;
}
let oversizedPassesDropped = 0;
let slotBudgetPassesDropped = 0;
/** Passes TRUNCATED by rule 3 (banked ≥1 row, shed the rest). Process total. */
let slotBudgetPassesThinned = 0;
/** Candidate rows shed by rule 3 since boot, whole drops and truncations alike. */
let slotBudgetRowsShed = 0;
/** `ranked` appends skipped as same-(day,slot,class,contract) duplicates. */
let rankedDuplicatesSkipped = 0;
let unsampledPasses = 0;
let emptyPasses = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;
let hydratedDays = 0;
let hydratedRecords = 0;
/** Approximate on-disk bytes: hydrated size plus every append since boot. */
let fileBytes = 0;

export function otmAdmissionTapePath(dir: string): string {
  return join(dir, OTM_ADMISSION_TAPE_FILENAME);
}

/** Test seam — clears every tally and forgets the data dir. */
export function clearOtmAdmissionTape(): void {
  dataDir = null;
  byDay.clear();
  lastSlotByPair.clear();
  rankedSeen.clear();
  slotSymbols.clear();
  slotDemand.clear();
  oversizedPassesDropped = 0;
  slotBudgetPassesDropped = 0;
  slotBudgetPassesThinned = 0;
  slotBudgetRowsShed = 0;
  rankedDuplicatesSkipped = 0;
  unsampledPasses = 0;
  emptyPasses = 0;
  appendErrors = 0;
  lastAppendError = null;
  hydratedDays = 0;
  hydratedRecords = 0;
  fileBytes = 0;
}

/** ET 30-minute slot index (0–47) of an instant. */
export function otmAdmissionSlot(ms: number): number {
  const { hour, minute } = etClockParts(new Date(ms));
  return Math.floor((hour * 60 + minute) / SLOT_MINUTES);
}

// Hydrate memo: every row of a pass shares one ts, so this almost always hits.
let slotMemoTs = Number.NaN;
let slotMemo = 0;
function slotOf(ms: number): number {
  if (ms !== slotMemoTs) {
    slotMemoTs = ms;
    slotMemo = otmAdmissionSlot(ms);
  }
  return slotMemo;
}

/** 32-bit FNV-1a — a stable, quote-blind hash for the rule-1 sampler. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Rule 1, pure: is this (book × symbol) pair selected in this ET slot?
 * Depends on identity and the clock ONLY — never on a quote, never on scan order.
 */
export function otmAdmissionSlotSelected(
  book: string,
  symbol: string,
  etDay: string,
  slot: number,
  accountClass: string,
): boolean {
  const mod = SAMPLE_MOD[accountClass] ?? SAMPLE_MOD_OTHER;
  return fnv1a(`${book}|${symbol}|${etDay}|${slot}`) % mod === 0;
}

// ── Rule 3 v2: the slot allowance (TRA-4954) ─────────────────────────────────

/** Everything {@link otmAdmissionSlotAllowance} reads. Holds NO quote. */
export interface OtmAdmissionSlotState {
  /** `MAX_ROWS_PER_SLOT[class]` for this cell. */
  budget: number;
  /** Candidate rows already banked in this (class × day × slot). */
  banked: number;
  /** Rows already PRESENTED in it (banked + shed) — the share's denominator. */
  presented: number;
  /** Distinct underlyings that have already presented, EXCLUDING this one when new. */
  symbolsSeen: number;
  /** Is this the symbol's first presentation in this slot? */
  symbolIsNew: boolean;
  /** Learned/seeded distinct symbols for this (class × slot index). */
  expectedSymbols: number;
  /** Learned/seeded presented rows for this (class × slot index). */
  expectedRows: number;
  /** The pass's full size, in candidate rows. */
  passRows: number;
}

/**
 * How many of a pass's rows rule 3 admits. Pure, and deliberately exported: it
 * is the whole eviction policy, and TRA-4954's AC1/AC2 are properties of THIS
 * function, provable without a session of tape.
 *
 * ```
 *   floorK  = min(FLOOR_ROWS_PER_SYMBOL, budget / expectedSymbols)   ≥ 1
 *   reserve = floorK × (symbols expected but not yet presented, incl. this one)
 *   share   = ceil((budget − banked − reserve) × n / rows still expected)
 *   allow   = min(n, max(share, isNew ? floorK : 0), budget − banked)
 * ```
 *
 * Two invariants fall straight out of that, and the tests assert both:
 *   - **AC1 (no starvation).** After admitting a new symbol,
 *     `banked ≤ budget − floorK × unseenAfter`, so the rows reserved for symbols
 *     that have not presented yet are never spendable by the ones that have.
 *     Every symbol presenting in a slot therefore banks ≥ `floorK` ≥ 1 rows —
 *     for as long as the slot's actual symbol count stays inside
 *     `expectedSymbols`, which is why the seeds sit above the measured max AND
 *     the learner only ever raises them.
 *   - **AC2 (the budget is not raised).** `allow ≤ budget − banked` is applied
 *     last and unconditionally, so `sum(rowsBySlot) ≤ budget` per cell exactly
 *     as under v2.
 *
 * `share` is PROPORTIONAL to `n` by construction. That is the AC3 property: the
 * fraction shed does not depend on pass size, so the banked sample no longer
 * filters on chain width. An equal-rows (max-min fair) split would read better
 * on "rows per symbol" and strictly worse here — it sheds more from wide chains
 * by definition — and chain width is the liquidity proxy this tape must not
 * sample on.
 */
export function otmAdmissionSlotAllowance(state: OtmAdmissionSlotState): number {
  const budget = Math.max(0, Math.floor(state.budget));
  const n = Math.max(0, Math.floor(state.passRows));
  if (n === 0 || budget === 0) return 0;
  const banked = Math.max(0, Math.floor(state.banked));
  const remainingBudget = Math.max(0, budget - banked);
  if (remainingBudget === 0) return 0;

  const seen = Math.max(0, Math.floor(state.symbolsSeen));
  // The expectation can never read below what this slot has already shown it —
  // an under-read would hand the tail's reserve to whoever scanned first.
  const expectedSymbols = Math.max(1, state.expectedSymbols, seen + (state.symbolIsNew ? 1 : 0));
  const floorK = Math.max(1, Math.min(FLOOR_ROWS_PER_SYMBOL, Math.floor(budget / expectedSymbols)));
  // Includes THIS symbol while it is still unseen; `guaranteed` is how it draws
  // its own share back out, which is what keeps the invariant exact.
  const unseen = Math.max(0, expectedSymbols - seen);
  const headroom = Math.max(0, budget - banked - floorK * unseen);

  const presented = Math.max(0, Math.floor(state.presented));
  const expectedRows = Math.max(state.expectedRows, presented + n);
  const remainingRows = Math.max(n, expectedRows - presented);
  const share = Math.ceil((headroom * n) / remainingRows);

  // 🔴 MAX, not PLUS. The floor is a FLOOR UNDER the proportional share, not a
  // bonus on top of it. Adding it hands every pass the same +floorK, which is a
  // large relative boost to a tiny pass and a rounding error to a wide one — so
  // small passes stop shedding at all and the shed population skews large again.
  // Measured in simulation over 4 desk sessions: `+` leaves mean shed-pass size
  // +6.3%/+11.2%/+13.5%/+9.6% above the mean pass (2 of 4 outside AC3's ±10%);
  // `max` is what makes the shed fraction flat in pass size. It is also strictly
  // tighter on the budget — the reserve is no longer spent twice.
  const guaranteed = state.symbolIsNew ? floorK : 0;
  return Math.max(0, Math.min(n, Math.max(share, guaranteed), remainingBudget));
}

function slotDemandKey(accountClass: string, slot: number): string {
  return `${accountClass}|${slot}`;
}

/**
 * Learned demand for a (class × slot). `symbols` is floored at its seed (AC1
 * reserve — cheap to over-reserve); `rows` falls back to its seed ONLY where the
 * slot has no history, so a quiet slot thins against its OWN demand and not a
 * busy slot's. See {@link SEED_ROWS_PER_SLOT} for why the two differ.
 */
function demandFor(accountClass: string, slot: number): { symbols: number; rows: number } {
  const seedSymbols = SEED_SYMBOLS_PER_SLOT[accountClass] ?? SEED_SYMBOLS_PER_SLOT_OTHER;
  const seedRows = SEED_ROWS_PER_SLOT[accountClass] ?? SEED_ROWS_PER_SLOT_OTHER;
  const existing = slotDemand.get(slotDemandKey(accountClass, slot));
  if (!existing) return { symbols: seedSymbols, rows: seedRows };
  return {
    symbols: Math.max(existing.symbols, seedSymbols),
    rows: existing.priorRows > 0 ? existing.priorRows : seedRows,
  };
}

/** Underlyings that have presented in one (day × class × slot). Current day only. */
function slotSymbolSet(etDay: string, accountClass: string, slot: number): Set<string> {
  let perDay = slotSymbols.get(etDay);
  if (!perDay) {
    // A previously unseen day evicts every other — see {@link markRankedSeen}.
    slotSymbols.clear();
    perDay = new Map();
    slotSymbols.set(etDay, perDay);
  }
  const key = slotDemandKey(accountClass, slot);
  let set = perDay.get(key);
  if (!set) {
    set = new Set();
    perDay.set(key, set);
  }
  return set;
}

/**
 * Record that `underlying` presented in this cell and raise the learned demand.
 * Called from {@link applyRow} for candidate AND shed rows, so hydrate rebuilds
 * the learner off disk on the SAME path the live append uses.
 */
function noteSlotDemand(
  etDay: string,
  accountClass: string,
  slot: number,
  underlying: string,
  presentedRows: number,
): void {
  const set = slotSymbolSet(etDay, accountClass, slot);
  set.add(underlying);
  const key = slotDemandKey(accountClass, slot);
  // 🔴 Store the OBSERVED maxima, never the seed-floored read from `demandFor` —
  // folding the seed in here would make the `rows` default a permanent floor and
  // silently undo the asymmetry that function exists for.
  const current = slotDemand.get(key);
  if (!current) {
    slotDemand.set(key, { symbols: set.size, priorRows: 0, day: etDay, dayRows: presentedRows });
    return;
  }
  if (current.day !== etDay) {
    current.priorRows = Math.max(current.priorRows, current.dayRows);
    current.day = etDay;
    current.dayRows = 0;
  }
  current.symbols = Math.max(current.symbols, set.size);
  current.dayRows = Math.max(current.dayRows, presentedRows);
}

/** Presented rows (banked + shed) in one (day × class × slot). */
function presentedRowsIn(t: ClassDayTally, slot: number): number {
  return (t.rowsBySlot.get(slot) ?? 0) + (t.dropsBySlot.get(slot)?.rows ?? 0);
}

function tallyFor(etDay: string, accountClass: string): ClassDayTally {
  let classes = byDay.get(etDay);
  if (!classes) {
    classes = new Map();
    byDay.set(etDay, classes);
  }
  let t = classes.get(accountClass);
  if (!t) {
    t = {
      candidateRows: 0,
      admitted: 0,
      admittedSampled: 0,
      legacyRows: 0,
      byBindingReason: {},
      passesRecorded: 0,
      ranked: 0,
      ordered: 0,
      firstTs: 0,
      lastTs: 0,
      rowsBySlot: new Map(),
      dropsBySlot: new Map(),
      lastPassKey: '',
    };
    classes.set(accountClass, t);
  }
  return t;
}

// ── `ranked` link dedup (TRA-4906) ───────────────────────────────────────────
// Deliberately keyed the same way the SURVIVORSHIP JOIN reads: the candidate leg
// is (etDay, slot)-granular, so `(etDay, slot, accountClass, occSymbol)` is the
// finest key that still has something to join to.

function rankedSeenKey(slot: number, accountClass: string, occSymbol: string): string {
  return `${slot}|${accountClass}|${occSymbol}`;
}

function rankedAlreadySeen(etDay: string, slot: number, accountClass: string, occSymbol: string): boolean {
  return rankedSeen.get(etDay)?.has(rankedSeenKey(slot, accountClass, occSymbol)) === true;
}

/**
 * Remember a written `ranked` link. Called from {@link applyRow}, so hydrate
 * rebuilds the set off disk on the SAME code path the live append uses — there
 * is no second marking site to drift.
 *
 * A previously unseen ET day EVICTS every other day: hydrate walks day buckets
 * in ascending order and the live path only ever writes today, so the survivor
 * is always the newest. A backwards day flip would therefore drop the set early;
 * the only cost is a few re-admitted duplicate rows, and it self-heals.
 */
function markRankedSeen(etDay: string, slot: number, accountClass: string, occSymbol: string): void {
  let seen = rankedSeen.get(etDay);
  if (!seen) {
    rankedSeen.clear();
    seen = new Set<string>();
    rankedSeen.set(etDay, seen);
  }
  seen.add(rankedSeenKey(slot, accountClass, occSymbol));
}

function applyRow(row: OtmAdmissionTapeRow): void {
  const t = tallyFor(row.etDay, row.accountClass);
  if (row.kind === 'budgetdrop') {
    // NOT SAMPLE: touches dropsBySlot and the ts bounds only — never
    // candidateRows / admitted / ranked / ordered / passesRecorded, and never
    // rowsBySlot (which is the rule-3 budget's own denominator).
    const cell = t.dropsBySlot.get(row.slot)
      ?? { passes: 0, rows: 0, banked: 0, passRows: 0, wholeDrops: 0 };
    const shed = Number.isFinite(row.rows) ? row.rows : 0;
    // v2 rows carry neither field: the pass was dropped WHOLE, so its full size
    // is `rows` and nothing banked. Reading them any other way would retcon the
    // v2 days into looking like they thinned.
    const banked = typeof row.banked === 'number' && Number.isFinite(row.banked) ? row.banked : 0;
    const passRows = typeof row.passRows === 'number' && Number.isFinite(row.passRows)
      ? row.passRows
      : shed + banked;
    cell.passes += 1;
    cell.rows += shed;
    cell.banked += banked;
    cell.passRows += passRows;
    if (banked <= 0) cell.wholeDrops += 1;
    t.dropsBySlot.set(row.slot, cell);
    noteSlotDemand(row.etDay, row.accountClass, row.slot, row.underlying, presentedRowsIn(t, row.slot));
  } else if (row.kind === 'candidate') {
    t.candidateRows += 1;
    const sampled = typeof row.samplingPolicy === 'number' && row.samplingPolicy >= 2;
    if (!sampled) t.legacyRows += 1;
    if (row.admitted) {
      t.admitted += 1;
      if (sampled) t.admittedSampled += 1;
    }
    t.byBindingReason[row.bindingReason] = (t.byBindingReason[row.bindingReason] ?? 0) + 1;
    const slot = slotOf(row.ts);
    t.rowsBySlot.set(slot, (t.rowsBySlot.get(slot) ?? 0) + 1);
    noteSlotDemand(row.etDay, row.accountClass, slot, row.underlying, presentedRowsIn(t, slot));
    // Rebuilt on hydrate too (v1 read 0 after every reboot).
    const passKey = `${row.underlying}|${row.ts}`;
    if (passKey !== t.lastPassKey) {
      t.lastPassKey = passKey;
      t.passesRecorded += 1;
    }
  } else if (row.kind === 'ranked') {
    t.ranked += 1;
    markRankedSeen(row.etDay, slotOf(row.ts), row.accountClass, row.occSymbol);
  } else {
    t.ordered += 1;
  }
  if (t.firstTs === 0 || row.ts < t.firstTs) t.firstTs = row.ts;
  if (row.ts > t.lastTs) t.lastTs = row.ts;
}

function appendLines(lines: string[]): void {
  if (dataDir == null || lines.length === 0) return;
  // TRA-5038 — the shared periodic compaction rewrites this file mid-session. A chunk
  // written between that rewrite's read and its rename would be erased by the rename,
  // and an erased row reads identically to a row never written (TRA-1681). Buffer
  // instead; the flush comes back through the raw append below, so `appendErrors` and
  // `fileBytes` stay correct.
  const chunk = lines.join('\n') + '\n';
  if (sharedTapeRewriteInFlight(OTM_ADMISSION_TAPE)) {
    if (bufferSharedTapeAppend(OTM_ADMISSION_TAPE, chunk)) return;
  }
  appendOtmAdmissionTapeRawChunk(chunk);
}

/**
 * Append one already-serialized chunk. Split out so the shared compaction hook's
 * buffer flush goes through THIS path, keeping both `appendErrors` and the `fileBytes`
 * counter authoritative — a flush that bypassed it would make a failed flush invisible
 * and leave `fileBytes` short by the flushed bytes.
 */
function appendOtmAdmissionTapeRawChunk(chunk: string): void {
  if (dataDir == null) return;
  const path = otmAdmissionTapePath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, chunk, 'utf8');
    fileBytes += chunk.length;
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('otm-admission-tape append failed', { reason: lastAppendError });
  }
}

/**
 * TRA-5038 — what this tape contributes to the ONE shared compaction hook.
 *
 * ⚠ The predicate is `bytes_whole_day`, NOT `age` and NOT plain `bytes`. This tape's
 * binding bound is a 144 MiB BYTE CEILING (its 60-day `RETAIN_MS` never gets reached),
 * and the prune must land on an ET-DAY boundary: consumers divide by SESSIONS, so a
 * partial day biases its own within-day sample toward the afternoon, and a biased day
 * is worse than an absent one. {@link hydrateOtmAdmissionTapeFromDisk} has always
 * pruned whole days for that reason; the periodic pass matches it.
 *
 * The periodic pass deliberately does NOT reuse the hydrate's prune: that one
 * `JSON.parse`s every line and rebuilds the in-memory fold, which is affordable once
 * at boot and is exactly what TRA-5038 AC4 forbids four times a day on the money box
 * (~189k rows here, straight into the TRA-2111 yield-preempt tripwire).
 */
export function otmAdmissionTapeSharedTapeSpec(): SharedTapeSpec {
  return {
    tape: OTM_ADMISSION_TAPE,
    resolvePath: () => (dataDir == null ? null : otmAdmissionTapePath(dataDir)),
    predicate: () => ({ kind: 'bytes_whole_day', maxBytes: MAX_FILE_BYTES }),
    flushLine: appendOtmAdmissionTapeRawChunk,
    // The rewrite reclaims bytes this module counted on the way in; without this the
    // counter would overstate the file by exactly what was just reclaimed.
    onRewrite: (bytesAfter) => {
      fileBytes = bytesAfter;
    },
    note:
      'The largest single reservation in /data (144 MiB hard byte cap, 56.1 MiB observed '
      + '2026-10-02) and the reason TRA-4899 was filed. Boot-only enforcement meant the '
      + 'file also carried up to one boot gap ABOVE the cap; the shared timer bounds that '
      + 'to one interval. Bound is BYTES, pruned by WHOLE ET DAYS.',
  };
}

export interface OtmAdmissionPassContext {
  /** Underlying symbol being scanned. */
  symbol: string;
  /** The book's username — classified here, NEVER written to disk. */
  book: string | null | undefined;
  /** Engine mode (`demo` / `live`). */
  mode: string;
  now?: number;
}

export interface OtmAdmissionPassRecorder {
  /** Hand this to the engine as `OtmScannerOptions.onAdmission`. */
  onAdmission: (decision: OtmAdmissionDecision) => void;
  /**
   * Call ONLY after the scan returned `reason: 'ok'` — commits the collected
   * rows (or counts a whole-pass drop) and consumes the pair's ET slot. A pass
   * abandoned without commit (breaker, no chain, fetch error) costs nothing.
   */
  commit: () => void;
}

/**
 * Begin a recorded scan pass, or return `null` when rule 1 does not select this
 * (symbol × book) pass — the caller then scans exactly as before, untaped.
 * Nothing here reads or alters any selection parameter (observe-only).
 */
export function beginOtmAdmissionPass(ctx: OtmAdmissionPassContext): OtmAdmissionPassRecorder | null {
  const now = ctx.now ?? Date.now();
  const book = ctx.book ?? '';
  const key = `${book}|${ctx.symbol}`;
  const accountClass = classifySpreadCeilingAccount(ctx.book ?? undefined);
  const etDay = etDateString(new Date(now));
  const slot = otmAdmissionSlot(now);
  const slotKey = `${etDay}|${slot}`;
  if (
    lastSlotByPair.get(key) === slotKey
    || !otmAdmissionSlotSelected(book, ctx.symbol, etDay, slot, accountClass)
  ) {
    unsampledPasses += 1;
    return null;
  }
  const decisions: OtmAdmissionDecision[] = [];
  return {
    onAdmission: (d) => {
      // Buffer capped at MAX_ROWS_PER_PASS + 1 so a pathological chain cannot
      // grow an unbounded array (TRA-4158); the one extra slot is what lets
      // commit() see "oversized" and drop the pass WHOLE.
      if (decisions.length <= MAX_ROWS_PER_PASS) decisions.push(d);
    },
    commit: () => {
      lastSlotByPair.set(key, slotKey);
      if (decisions.length === 0) {
        emptyPasses += 1;
        return;
      }
      if (decisions.length > MAX_ROWS_PER_PASS) {
        oversizedPassesDropped += 1;
        return;
      }
      const t = tallyFor(etDay, accountClass);
      const slotBudget = MAX_ROWS_PER_SLOT[accountClass] ?? MAX_ROWS_PER_SLOT_OTHER;
      const demand = demandFor(accountClass, slot);
      const presentedSymbols = slotSymbolSet(etDay, accountClass, slot);
      const passUnderlying = decisions[0]!.underlying;
      // Rule 3 (TRA-4954): how many of this pass's rows the slot admits. The
      // allowance is computed from row COUNTS and identity only — no quote, and
      // no scan order, reaches it.
      const allow = otmAdmissionSlotAllowance({
        budget: slotBudget,
        banked: t.rowsBySlot.get(slot) ?? 0,
        presented: presentedRowsIn(t, slot),
        symbolsSeen: presentedSymbols.size - (presentedSymbols.has(passUnderlying) ? 1 : 0),
        symbolIsNew: !presentedSymbols.has(passUnderlying),
        expectedSymbols: demand.symbols,
        expectedRows: demand.rows,
        passRows: decisions.length,
      });
      const shed = decisions.length - allow;
      /**
       * WHICH rows survive a truncation. 🔴 Hash rank over `occSymbol`, never
       * chain position: a prefix/suffix of the chain correlates with strike and
       * therefore with mark, which would make the tape's own axes a function of
       * its sampling — the defect rule 2 refuses truncation to avoid. An fnv1a
       * rank is a uniform subsample of the chain, blind to every quote field,
       * and reproducible from the banked row alone.
       */
      const kept = allow >= decisions.length
        ? decisions
        : [...decisions]
          .map((d, i) => ({ d, i, h: fnv1a(d.occSymbol) }))
          .sort((a, b) => (a.h - b.h) || (a.i - b.i))
          .slice(0, allow)
          .sort((a, b) => a.i - b.i)
          .map((e) => e.d);
      if (shed > 0) {
        // The counters are process totals and are KEPT (cited elsewhere); the row
        // is what makes the count per-slot and boot-durable (TRA-4906). Not
        // sample — `applyRow` routes it to `dropsBySlot` only.
        if (allow === 0) slotBudgetPassesDropped += 1;
        else slotBudgetPassesThinned += 1;
        slotBudgetRowsShed += shed;
        const dropRow: OtmAdmissionTapeBudgetDropRow = {
          kind: 'budgetdrop',
          ts: now,
          etDay,
          accountClass,
          slot,
          underlying: passUnderlying,
          rows: shed,
          passRows: decisions.length,
          banked: allow,
        };
        applyRow(dropRow);
        appendLines([JSON.stringify(dropRow)]);
        if (allow === 0) return;
      }
      const lines: string[] = [];
      for (const d of kept) {
        const row: OtmAdmissionTapeCandidateRow = {
          kind: 'candidate',
          ts: now,
          etDay,
          accountClass,
          mode: ctx.mode,
          underlying: d.underlying,
          occSymbol: d.occSymbol,
          expiry: d.expiry,
          strike: d.strike,
          right: d.right,
          bid: d.bid,
          ask: d.ask,
          mark: d.mark,
          spreadPct: d.spreadPct,
          openInterest: d.openInterest,
          ...(typeof d.absDelta === 'number' && Number.isFinite(d.absDelta) ? { absDelta: d.absDelta } : {}),
          admitted: d.admitted,
          bindingReason: d.bindingReason,
          samplingPolicy: OTM_ADMISSION_SAMPLING_POLICY,
        };
        applyRow(row);
        lines.push(JSON.stringify(row));
      }
      appendLines(lines);
    },
  };
}

function recordLink(kind: 'ranked' | 'ordered', ctx: OtmAdmissionPassContext, occSymbol: string): void {
  const now = ctx.now ?? Date.now();
  const etDay = etDateString(new Date(now));
  const accountClass = classifySpreadCeilingAccount(ctx.book ?? undefined);
  if (kind === 'ranked' && rankedAlreadySeen(etDay, slotOf(now), accountClass, occSymbol)) {
    // Already on disk for this (day, slot, class, contract) — the join reads the
    // SET of nominees, so a second row carries no information (TRA-4906).
    rankedDuplicatesSkipped += 1;
    return;
  }
  const row: OtmAdmissionTapeLinkRow = {
    kind,
    ts: now,
    etDay,
    accountClass,
    mode: ctx.mode,
    underlying: ctx.symbol,
    occSymbol,
  };
  applyRow(row);
  appendLines([JSON.stringify(row)]);
}

/**
 * The selector nominated this contract (it was RANKED first). DEDUPED per
 * `(etDay, slot, accountClass, occSymbol)` — information-preserving, not a
 * throttle; see the header. Never quote-dependent: the key holds no quote.
 */
export function recordOtmAdmissionRanked(ctx: OtmAdmissionPassContext, occSymbol: string): void {
  recordLink('ranked', ctx, occSymbol);
}

/**
 * A final open went through for this contract (it was ORDERED).
 * 🔴 UNCONDITIONAL — never deduped, never throttled, never budgeted. This row is
 * execution provenance (TRA-4906 AC4); it reads 0 on every day and both classes,
 * so it costs nothing, and losing one loses the attestation that an order existed.
 */
export function recordOtmAdmissionOrdered(ctx: OtmAdmissionPassContext, occSymbol: string): void {
  recordLink('ordered', ctx, occSymbol);
}

export interface OtmAdmissionTapeHydration {
  days: number;
  records: number;
}

function parseRow(trimmed: string): OtmAdmissionTapeRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null; // torn/partial line — skip, never abort the hydrate
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts)) return null;
  if (typeof rec.etDay !== 'string' || rec.etDay === '') return null;
  if (rec.kind === 'ranked' || rec.kind === 'ordered') {
    if (typeof rec.occSymbol !== 'string') return null;
    return rec as unknown as OtmAdmissionTapeLinkRow;
  }
  if (rec.kind === 'budgetdrop') {
    // `slot` is the row's whole point and is required. `rows` is read leniently:
    // a drop with an unreadable size is still a drop, and losing the PASS count
    // would understate rule-3's bite — the opposite of why the row exists.
    if (typeof rec.slot !== 'number' || !Number.isFinite(rec.slot)) return null;
    return {
      ...(rec as unknown as OtmAdmissionTapeBudgetDropRow),
      rows: typeof rec.rows === 'number' && Number.isFinite(rec.rows) ? rec.rows : 0,
    };
  }
  if (rec.kind !== 'candidate') return null;
  if (typeof rec.occSymbol !== 'string' || typeof rec.admitted !== 'boolean') return null;
  if (typeof rec.bindingReason !== 'string') return null;
  return rec as unknown as OtmAdmissionTapeCandidateRow;
}

/**
 * Rebuild the aggregates from disk on boot and remember `dir` for appends.
 * Idempotent (clears first). Rows older than {@link RETAIN_MS} are dropped and
 * the file is COMPACTED to the kept lines; then whole OLDEST ET days are pruned
 * until the byte size fits {@link MAX_FILE_BYTES}. Best-effort throughout.
 */
export function hydrateOtmAdmissionTapeFromDisk(dir: string, now: number = Date.now()): OtmAdmissionTapeHydration {
  clearOtmAdmissionTape();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(otmAdmissionTapePath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  /** etDay → kept lines, insertion-ordered (JSONL is append-only ⇒ ts-ordered). */
  const keptByDay = new Map<string, string[]>();
  let totalBytes = 0;
  let droppedByTime = 0;
  let nonEmptyLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    nonEmptyLines += 1;
    const rec = parseRow(trimmed);
    if (rec == null) continue;
    if (rec.ts < cutoff) {
      droppedByTime += 1;
      continue;
    }
    const clean = JSON.stringify(rec);
    let bucket = keptByDay.get(rec.etDay);
    if (!bucket) {
      bucket = [];
      keptByDay.set(rec.etDay, bucket);
    }
    bucket.push(clean);
    totalBytes += clean.length + 1;
  }

  // Byte-cap prune: WHOLE oldest ET days only (a partial day would bias its own
  // within-day sample toward the afternoon, and a biased day is worse than an
  // absent one for a per-session denominator).
  const days = [...keptByDay.keys()].sort();
  let prunedDays = 0;
  while (totalBytes > MAX_FILE_BYTES && days.length > 1) {
    const oldest = days.shift()!;
    const lines = keptByDay.get(oldest)!;
    for (const l of lines) totalBytes -= l.length + 1;
    keptByDay.delete(oldest);
    prunedDays += 1;
  }

  let records = 0;
  const keptLines: string[] = [];
  for (const day of days) {
    for (const line of keptByDay.get(day)!) {
      const rec = parseRow(line);
      if (rec == null) continue;
      applyRow(rec);
      keptLines.push(line);
      records += 1;
    }
  }

  if (records < nonEmptyLines) {
    const path = otmAdmissionTapePath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, keptLines.length > 0 ? keptLines.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('otm-admission-tape compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (droppedByTime > 0 || prunedDays > 0) {
    log.info('otm-admission-tape compacted', { droppedByTime, prunedDays, kept: records });
  }

  hydratedDays = byDay.size;
  hydratedRecords = records;
  fileBytes = totalBytes;
  return { days: byDay.size, records };
}

// ── Health summary ────────────────────────────────────────────────────────────

export interface OtmAdmissionTapeClassDaySummary {
  etDay: string;
  candidateRows: number;
  admitted: number;
  /** Refusal/admit split by FIRST binding gate (`none` = admitted). */
  byBindingReason: Record<string, number>;
  passesRecorded: number;
  ranked: number;
  ordered: number;
  /** Admitted rows selected by sampling policy >= 2 (what AC4 counts). OPTIONAL: older builds lack it. */
  admittedSampled?: number;
  /** Candidate rows with no `samplingPolicy` — v1, open-biased; exclude from any readout. */
  legacyRows?: number;
  /** Candidate rows per ET 30-minute slot, `HH:MM` slot start → rows. The time-coverage check. */
  rowsBySlotEt?: Record<string, number>;
  /**
   * Rule-3 shedding per ET slot, `HH:MM` slot start → the shed cell
   * (TRA-4906/TRA-4905 AC1, extended by TRA-4954). Rebuilt from durable
   * `budgetdrop` rows, so it SURVIVES A BOOT — read it post-close from any boot.
   * `{}` means rule 3 never bit that day/class.
   *
   * `passes` = passes that shed anything · `rows` = rows shed · `banked` = rows
   * of those same passes that survived · `passRows` = their full size ·
   * `wholeDrops` = the subset that banked NOTHING.
   * ⚠ `wholeDrops` is NOT by itself the TRA-4954 AC1 alarm. Several BOOKS of one
   * class can scan the same underlying in one slot, and the second such pass
   * legitimately banks 0 once the symbol already holds its floor — measured in
   * simulation at 286/1,665 fixture passes with AC1 still clean. AC1 is a
   * statement about (slot × SYMBOL) coverage, so it is read off the raw pull:
   * no `(slot, underlying)` may hold a `budgetdrop` row and no candidate rows.
   * On v2 days `wholeDrops == passes` by construction — that IS the defect
   * TRA-4954 fixed, not a regression.
   * ⚠ NOT SAMPLE: these rows are in no other count on this surface.
   */
  dropsBySlotEt?: Record<string, OtmAdmissionSlotShedCell>;
  /**
   * Distinct underlyings that PRESENTED per ET slot (banked or shed) — the AC1
   * denominator. Present for TODAY'S day only: the set it is counted from holds
   * one ET day at a time (RSS), so an older day reads `undefined`, never `0`.
   */
  symbolsPresentedBySlotEt?: Record<string, number>;
  firstTs?: number;
  lastTs: number;
}

export interface OtmAdmissionTapeClassSummary {
  accountClass: string;
  /**
   * Distinct ET days holding ≥1 ADMITTED candidate row selected by sampling
   * policy >= 2 — the AC4 session unit. v1 (open-biased) days never count.
   */
  sessionsWithAdmissions: number;
  /** Days whose admitted rows are ALL v1 — shown, never counted. */
  legacySessions?: number;
  candidateRows: number;
  admitted: number;
  ranked: number;
  ordered: number;
  days: OtmAdmissionTapeClassDaySummary[];
}

export interface OtmAdmissionTapeSummary {
  /** Classes are NEVER pooled (TRA-3715/TRA-3682/TRA-3709) — one entry per class seen. */
  byClass: OtmAdmissionTapeClassSummary[];
  /** The AC4 gate readout: desk-class ET days holding ≥1 admitted candidate row. */
  deskSessionsWithAdmissions: number;
  policy: {
    samplingPolicy: number;
    slotMinutes: number;
    sampleModDesk: number;
    sampleModOther: number;
    maxRowsPerPass: number;
    maxRowsPerSlotDesk: number;
    maxRowsPerSlotOther: number;
    /** TRA-4954 — the per-(slot × symbol) floor rule 3 reserves before thinning. */
    floorRowsPerSymbol: number;
    /**
     * TRA-4954 — the learned demand rule 3 sizes the floor reserve and the
     * proportional share from: `class|slotIndex` → the EFFECTIVE values an
     * allowance in that slot would read right now (`symbols` floored at its
     * seed, `rows` = the max over days strictly before today, falling back to
     * its seed where there is none). Published so a grader can reproduce an
     * allowance off this route without reading source.
     */
    slotDemand: Record<string, { symbols: number; rows: number }>;
    retainDays: number;
    maxFileBytes: number;
    /** The independence statement, published so a grader need not read source. */
    sampling: string;
  };
  counters: {
    unsampledPasses: number;
    oversizedPassesDropped: number;
    /**
     * PROCESS TOTAL since boot — kept because it is cited elsewhere, but it is
     * NOT the AC1 readout: use `byClass[].days[].dropsBySlotEt`, which is
     * per-slot and survives a restart.
     */
    slotBudgetPassesDropped: number;
    /**
     * TRA-4954 — passes rule 3 TRUNCATED (banked ≥1 row, shed the rest). Process
     * total. On a v3 build this carries essentially all of rule 3's bite.
     * `slotBudgetPassesDropped` counts the whole-drop residue, which is NOT in
     * itself an AC1 failure — see `dropsBySlotEt`.
     */
    slotBudgetPassesThinned: number;
    /** TRA-4954 — candidate rows shed by rule 3 since boot (drops + truncations). */
    slotBudgetRowsShed: number;
    /** `ranked` appends skipped as duplicates (TRA-4906). Process total. */
    rankedDuplicatesSkipped: number;
    emptyPasses: number;
  };
  durability: {
    dataDirConfigured: boolean;
    appendErrors: number;
    lastAppendError: string | null;
    hydratedDays: number;
    hydratedRecords: number;
    /**
     * Approximate file size — pruning whole oldest days starts at `policy.maxFileBytes`.
     * Counted on the way in and re-based off `stat` after a shared-hook rewrite
     * (TRA-5038), so it no longer overstates the file by whatever a compaction
     * reclaimed.
     */
    fileBytes: number;
  };
  /**
   * TRA-5038 AC3 — the shared compaction hook as this tape sees it.
   *
   * ⚠ READ `sharedCompaction.hookState`, NOT `timerPasses`. `timer_not_armed` is the
   * alarm, and it is the state in which every other field in this payload still reads
   * healthy. This tape's predicate is `bytes_whole_day`: its bound is the 144 MiB
   * ceiling, not its 60-day retention, so its span carries no `cutoff`.
   */
  sharedCompaction: SharedTapeCompactionState;
}

function slotLabel(slot: number): string {
  const m = slot * SLOT_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function summarizeOtmAdmissionTape(): OtmAdmissionTapeSummary {
  const classes = new Map<string, OtmAdmissionTapeClassSummary>();
  for (const [etDay, perClass] of byDay) {
    for (const [accountClass, t] of perClass) {
      let c = classes.get(accountClass);
      if (!c) {
        c = {
          accountClass,
          sessionsWithAdmissions: 0,
          legacySessions: 0,
          candidateRows: 0,
          admitted: 0,
          ranked: 0,
          ordered: 0,
          days: [],
        };
        classes.set(accountClass, c);
      }
      c.candidateRows += t.candidateRows;
      c.admitted += t.admitted;
      c.ranked += t.ranked;
      c.ordered += t.ordered;
      if (t.admittedSampled > 0) c.sessionsWithAdmissions += 1;
      else if (t.admitted > 0) c.legacySessions = (c.legacySessions ?? 0) + 1;
      const rowsBySlotEt: Record<string, number> = {};
      for (const slot of [...t.rowsBySlot.keys()].sort((a, b) => a - b)) {
        rowsBySlotEt[slotLabel(slot)] = t.rowsBySlot.get(slot)!;
      }
      const dropsBySlotEt: Record<string, OtmAdmissionSlotShedCell> = {};
      for (const slot of [...t.dropsBySlot.keys()].sort((a, b) => a - b)) {
        dropsBySlotEt[slotLabel(slot)] = { ...t.dropsBySlot.get(slot)! };
      }
      // Only the newest day's symbol sets are retained (RSS) — omit the field
      // entirely for the others rather than publish a 0 that reads as "none".
      const perDaySymbols = slotSymbols.get(etDay);
      const symbolsPresentedBySlotEt: Record<string, number> = {};
      if (perDaySymbols) {
        const prefix = `${accountClass}|`;
        for (const [key, set] of perDaySymbols) {
          if (!key.startsWith(prefix)) continue;
          const slot = Number(key.slice(prefix.length));
          if (Number.isFinite(slot)) symbolsPresentedBySlotEt[slotLabel(slot)] = set.size;
        }
      }
      c.days.push({
        etDay,
        candidateRows: t.candidateRows,
        admitted: t.admitted,
        admittedSampled: t.admittedSampled,
        legacyRows: t.legacyRows,
        byBindingReason: { ...t.byBindingReason },
        passesRecorded: t.passesRecorded,
        ranked: t.ranked,
        ordered: t.ordered,
        rowsBySlotEt,
        dropsBySlotEt,
        ...(perDaySymbols ? { symbolsPresentedBySlotEt } : {}),
        firstTs: t.firstTs,
        lastTs: t.lastTs,
      });
    }
  }
  const byClass = [...classes.values()].sort((a, b) => a.accountClass.localeCompare(b.accountClass));
  for (const c of byClass) c.days.sort((a, b) => a.etDay.localeCompare(b.etDay));
  return {
    byClass,
    deskSessionsWithAdmissions: classes.get('desk')?.sessionsWithAdmissions ?? 0,
    policy: {
      samplingPolicy: OTM_ADMISSION_SAMPLING_POLICY,
      slotMinutes: SLOT_MINUTES,
      sampleModDesk: SAMPLE_MOD.desk,
      sampleModOther: SAMPLE_MOD_OTHER,
      maxRowsPerPass: MAX_ROWS_PER_PASS,
      maxRowsPerSlotDesk: MAX_ROWS_PER_SLOT.desk,
      maxRowsPerSlotOther: MAX_ROWS_PER_SLOT_OTHER,
      floorRowsPerSymbol: FLOOR_ROWS_PER_SYMBOL,
      slotDemand: Object.fromEntries(
        [...slotDemand.keys()].sort().map((k) => {
          const sep = k.lastIndexOf('|');
          return [k, demandFor(k.slice(0, sep), Number(k.slice(sep + 1)))] as const;
        }),
      ),
      retainDays: Math.round(RETAIN_MS / (24 * 60 * 60 * 1000)),
      maxFileBytes: MAX_FILE_BYTES,
      sampling:
        'v3 slot sampler: first ok pass per (book×symbol) per ET 30-min slot, selected by fnv1a(book|symbol|etDay|slot) % sampleMod — decided from identity and clock before the scan, independent of mark, spreadPct, scan order and time-of-day. Rule 3 (the per-(class×day×slot) row budget) THINS rather than starves since policy v3 (TRA-4954): every symbol that presents in a slot is reserved min(floorRowsPerSymbol, budget/expectedSymbols) >= 1 rows, and the discretionary remainder is split in PROPORTION to pass size, so the shed FRACTION does not depend on chain width. Which rows survive a truncation is fnv1a(occSymbol) rank — NEVER chain position, which correlates with strike and therefore with mark. v2 days (2026-09-19..2026-10-01) dropped whole passes first-come instead: on those days a slot is a first-come PREFIX of its demand and 54 (desk) / 985 (fixture) (slot×symbol) cells banked zero rows, biasing max_spread_pct binding upward — filter samplingPolicy === 3 for any per-symbol coverage readout; >= 2 remains correct for AC4 sessions and for mark/spread retention. Rows without samplingPolicy are v1 (open-biased) and excluded from sessionsWithAdmissions. Rule 2 is unchanged: a pass over maxRowsPerPass is still dropped WHOLE, never truncated. Every shed pass writes a durable kind:budgetdrop row carrying slot, underlying, rows (SHED), passRows (full size) and banked (survivors) — read days[].dropsBySlotEt, which is per-slot and survives a boot; counters.slotBudget* are only process totals. wholeDrops > 0 on a v3 day is NOT by itself the AC1 alarm: several BOOKS of one class can scan the same underlying in one slot, and the second such pass legitimately banks 0 once that symbol already holds its floor (measured 286/1665 fixture passes with AC1 clean). AC1 is (slot x SYMBOL) coverage and is read off the raw pull — no (slot, underlying) may hold a budgetdrop row and zero candidate rows; days[].symbolsPresentedBySlotEt is its denominator. On v2 days wholeDrops == passes by construction, which IS the defect, not a regression. budgetdrop rows are NOT sample: they are in no candidateRows/admitted/ranked/ordered/sessionsWithAdmissions count. kind:ranked links are deduped per (etDay, slot, accountClass, occSymbol) — information-preserving, since the candidate leg of the survivorship join is itself (etDay, slot)-granular; skips are counted as rankedDuplicatesSkipped, and pre-2026-09-25 days hold the un-deduped multiset. kind:ordered is UNCONDITIONAL — never deduped, never throttled, never budgeted (execution provenance).',
    },
    counters: {
      unsampledPasses,
      oversizedPassesDropped,
      slotBudgetPassesDropped,
      slotBudgetPassesThinned,
      slotBudgetRowsShed,
      rankedDuplicatesSkipped,
      emptyPasses,
    },
    durability: {
      dataDirConfigured: dataDir != null,
      appendErrors,
      lastAppendError,
      hydratedDays,
      hydratedRecords,
      fileBytes,
    },
    // TRA-5038 AC3 — compaction outcome + an ARM-DERIVED `hookState`. Read `hookState`,
    // not `timerPasses`: `timer_not_armed` is the alarm and every other field here
    // still reads healthy in that state. `span.fill` reports whether the 144 MiB
    // ceiling is binding yet — for this tape that is a CAP question, not a retention
    // one, so there is no `cutoff` on its span.
    sharedCompaction: sharedTapeCompactionState(OTM_ADMISSION_TAPE),
  };
}

export interface OtmAdmissionTapeRowFilter {
  etDay?: string;
  accountClass?: string;
  /**
   * Row `kind` to keep (`candidate` / `ranked` / `ordered` / `budgetdrop`).
   *
   * TRA-4628 (measured 2026-10-02): a (day × class) slice is NOT guaranteed to
   * fit {@link MAX_READ_ROWS} — desk 2026-09-24 holds 12,168 candidate + 9,216
   * `ranked` rows = 21,384, and the unfiltered read of it returned 20,000 with
   * `truncated: true`, clipping 524 candidate rows off the FILE TAIL, i.e. the
   * day's LAST ET slots. A time-of-day-biased clip is precisely the v1-sampler
   * defect this tape was rebuilt to escape, so the sweep's own axes must never
   * depend on a reader noticing a flag. Filtering to `candidate` drops the link
   * rows the sweep does not read and brings every measured day under the cap;
   * {@link OtmAdmissionTapeRowFilter.offset} is the general answer for a slice
   * that is over the cap on its own.
   */
  kind?: string;
  /**
   * Matching rows to SKIP before collecting — the paging cursor. Pass back the
   * `nextOffset` of the previous read; file order is append-only and stable, so
   * paging a day that is not being appended to (any CLOSED session) is exact.
   */
  offset?: number;
  /** Hard-capped at {@link MAX_READ_ROWS} regardless of the requested value. */
  limit?: number;
}

/**
 * Stream-read raw rows off disk for the export path (the TRA-4623 sweep re-run).
 * readline over a stream, never `readFileSync` — the file may be tens of MB and
 * this route must not spike RSS against the TRA-4158 ceiling.
 *
 * `truncated` means MORE MATCHING ROWS EXIST, not that the read failed: resume
 * at `nextOffset` (null exactly when the slice was exhausted). A caller that
 * reads one page and ignores both fields is reading a prefix of its filter.
 */
export async function readOtmAdmissionTapeRows(
  filter: OtmAdmissionTapeRowFilter = {},
): Promise<{
  rows: OtmAdmissionTapeRow[];
  truncated: boolean;
  offset: number;
  nextOffset: number | null;
}> {
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  if (dataDir == null) return { rows: [], truncated: false, offset, nextOffset: null };
  const limit = Math.min(Math.max(1, filter.limit ?? MAX_READ_ROWS), MAX_READ_ROWS);
  const rows: OtmAdmissionTapeRow[] = [];
  let truncated = false;
  /** Matching rows seen, including the ones `offset` skipped. */
  let matched = 0;
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(otmAdmissionTapePath(dataDir), { encoding: 'utf8' });
  } catch {
    return { rows: [], truncated: false, offset, nextOffset: null };
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const rec = parseRow(trimmed);
      if (rec == null) continue;
      if (filter.etDay !== undefined && rec.etDay !== filter.etDay) continue;
      if (filter.accountClass !== undefined && rec.accountClass !== filter.accountClass) continue;
      if (filter.kind !== undefined && rec.kind !== filter.kind) continue;
      matched += 1;
      if (matched <= offset) continue;
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(rec);
    }
  } catch (err) {
    // A missing file (first boot) or a read error yields what was collected —
    // the route's durability block is where a reader learns to distrust it.
    log.warn('otm-admission-tape read failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    rl.close();
    stream.destroy();
  }
  return { rows, truncated, offset, nextOffset: truncated ? offset + rows.length : null };
}
