/**
 * TRA-3805 (measure 3 of TRA-3800) — a per-SYMBOL announcement ledger for the
 * repetitive quote-feed log families.
 *
 * ## The defect this exists to kill
 *
 * `recordTradierUnmatched` already had a dedupe. It was keyed on the **exact
 * membership of one batch** (`sorted.join(',')`), and quotes are fetched in
 * **shards with different membership**. Three consecutive lines from one tick on
 * bqb1, 2026-08-16T18:11Z, 2.3s apart end to end:
 *
 *     18:11:27.4  26/26   … includes SBLX, SELX
 *     18:11:28.9  24/596  the same list MINUS SBLX, SELX
 *     18:11:29.7  14/140  14 names, including ASML.AS — in neither of the other two
 *
 * Three different sets ⇒ three different keys ⇒ `key === lastLoggedKey` never
 * held, *and* each shard overwrote the key the next shard would have matched. The
 * guard was not merely bypassed, it was **thrashing**: it suppresses correctly
 * only when the batches are homogeneous, which is exactly the state it was tested
 * under. Its doc comment promised "one line per boot"; the live tape read ~10.9
 * lines/minute. Both statements were true at once, which is why nobody caught it
 * from the log — a defeated suppression and a working one emit the same *kind* of
 * line, just more of them, and "the same 24 tickers eleven times a minute" reads
 * as "there is no dedupe here at all".
 *
 * ## The fix
 *
 * Key on the **symbol**, not on the set. Each key is announced once per TTL
 * window; a call whose whole key list is already announced emits nothing. Shard
 * composition then stops mattering by construction — there is no set-shaped state
 * left for a re-shard to flip.
 *
 * Two properties are load-bearing and must survive any future edit here:
 *
 * 1. **Full membership stays discoverable** (the TRA-3385 guarantee that made
 *    this class measurable at all). A per-symbol first-sight line preserves it:
 *    the union of the emitted lines IS the membership. A capped "…and 12 more"
 *    summary would not, and a 20-name prefix is precisely what made the
 *    un-servable class invisible before TRA-3385. {@link getSymbolLogSuppressionState}
 *    additionally publishes the live announced set in one read.
 *
 * 2. **The suppression ships a counter** (the standing rule). "Suppressed 11k
 *    lines" and "the emitter died" are both zero log lines otherwise. `calls` is
 *    the discriminator: `calls: 0` means the emitter never ran; `calls > 0,
 *    linesSuppressed: N` means it ran and stayed quiet on purpose. Readers must
 *    assert the block's **presence** — never `?? 0` it, because a deploy that
 *    predates this change omits it entirely, which is a different fact from
 *    "nothing was suppressed".
 */

/**
 * How long an announcement stands before the same key may be announced again.
 *
 * 6h, deliberately the same window as `UNSERVABLE_TTL_MS`: a symbol that is still
 * un-servable when its skip mark is re-probed should be able to say so again, so
 * a box that has been up for days still re-states the membership a few times a
 * day rather than exactly once at boot. Session-forever would make an old process
 * indistinguishable from a dead emitter to anyone reading only the tape (the
 * counter still tells them apart, but the tape should not need the counter).
 */
export const SYMBOL_ANNOUNCE_TTL_MS = 6 * 60 * 60_000;

/**
 * The log families under this ledger. Adding one is deliberate work: each family
 * gets its own announcement space and its own counters, so a quiet stooq cannot
 * be read as a quiet tradier.
 */
export type SymbolLogFamily = 'tradierUnmatched' | 'stooqNonOk';

const FAMILIES: readonly SymbolLogFamily[] = ['tradierUnmatched', 'stooqNonOk'];

interface FamilyState {
  /** key → when it was last announced. Pruned once the TTL lapses. */
  announcedAt: Map<string, number>;
  /**
   * Every key announced since boot, never pruned. Exists ONLY to tell a periodic
   * TTL re-statement apart from a genuinely new un-servable ticker — `announcedAt`
   * cannot, because a pruned key and an unseen key are the same absence.
   */
  everAnnounced: Set<string>;
  /** Times the family was consulted, including calls with nothing to say. */
  calls: number;
  /** Calls that produced a line. */
  linesEmitted: number;
  /** Calls that carried ≥1 key and produced NO line — the suppression working. */
  linesSuppressed: number;
  /** Total keys passed in, across all calls. */
  mentionsSeen: number;
  /** Keys dropped because they were already announced inside the TTL. */
  mentionsSuppressed: number;
  /** Keys announced again after their previous announcement aged past the TTL. */
  reAnnouncements: number;
}

function emptyFamily(): FamilyState {
  return {
    announcedAt: new Map(),
    everAnnounced: new Set(),
    calls: 0,
    linesEmitted: 0,
    linesSuppressed: 0,
    mentionsSeen: 0,
    mentionsSuppressed: 0,
    reAnnouncements: 0,
  };
}

const families = new Map<SymbolLogFamily, FamilyState>(FAMILIES.map(f => [f, emptyFamily()]));

function stateOf(family: SymbolLogFamily): FamilyState {
  let s = families.get(family);
  if (!s) {
    s = emptyFamily();
    families.set(family, s);
  }
  return s;
}

/** Drop announcements that have aged past the TTL so the key may be re-announced. */
function prune(state: FamilyState, now: number): void {
  for (const [key, at] of state.announcedAt) {
    if (now - at >= SYMBOL_ANNOUNCE_TTL_MS) state.announcedAt.delete(key);
  }
}

/**
 * Register `keys` against `family` and return the subset that had not been
 * announced inside the TTL window — i.e. exactly the keys this call should name
 * in its log line. An empty return means "say nothing".
 *
 * Duplicate keys inside one call collapse to one announcement, so a caller that
 * passes the same ticker twice cannot double-count itself.
 */
export function announceSymbols(
  family: SymbolLogFamily,
  keys: readonly string[],
  now: number = Date.now(),
): string[] {
  const state = stateOf(family);
  state.calls++;
  state.mentionsSeen += keys.length;
  if (keys.length === 0) return [];

  prune(state, now);
  const fresh: string[] = [];
  const seenThisCall = new Set<string>();
  for (const key of keys) {
    if (seenThisCall.has(key)) {
      state.mentionsSuppressed++;
      continue;
    }
    seenThisCall.add(key);
    if (state.announcedAt.has(key)) {
      state.mentionsSuppressed++;
      continue;
    }
    // Absent from `announcedAt` either because the key was never seen, or because
    // prune() just expired it. `everAnnounced` is what separates the two, which is
    // how a long-lived box's periodic re-statement is told apart from a genuinely
    // new un-servable ticker arriving.
    if (state.everAnnounced.has(key)) state.reAnnouncements++;
    state.everAnnounced.add(key);
    state.announcedAt.set(key, now);
    fresh.push(key);
  }

  if (fresh.length > 0) state.linesEmitted++;
  else state.linesSuppressed++;
  return fresh;
}

/**
 * Single-key form: `true` when this call should log, `false` when the key has
 * already been announced inside the TTL window.
 */
export function announceSymbolOnce(
  family: SymbolLogFamily,
  key: string,
  now: number = Date.now(),
): boolean {
  return announceSymbols(family, [key], now).length > 0;
}

export interface SymbolLogFamilyState {
  /**
   * Times the family was consulted. **Read this first.** `0` means the emitter
   * never ran — which is NOT the same fact as "it ran and had nothing to say".
   */
  calls: number;
  /** Lines actually written to the tape. */
  linesEmitted: number;
  /** Calls that had something to report and were suppressed as already-announced. */
  linesSuppressed: number;
  /** Symbol-mentions passed in overall. */
  mentionsSeen: number;
  /** Symbol-mentions dropped as already-announced — the volume this saved. */
  mentionsSuppressed: number;
  /** Announcements re-made after a TTL window lapsed. */
  reAnnouncements: number;
  /** Keys currently inside their announcement window. */
  announcedCount: number;
  /** FULL sorted membership — never a capped prefix. See property 1 in the header. */
  announcedKeys: string[];
  ttlMs: number;
}

/**
 * The health-route block. **Always emitted**, one entry per family.
 *
 * Keys are family-specific: `tradierUnmatched` announces bare tickers,
 * `stooqNonOk` announces `SYMBOL#<httpStatus>` so that a 404 and a later 429 on
 * the same ticker are separate facts rather than one swallowing the other.
 */
export function getSymbolLogSuppressionState(
  now: number = Date.now(),
): Record<SymbolLogFamily, SymbolLogFamilyState> {
  const out = {} as Record<SymbolLogFamily, SymbolLogFamilyState>;
  for (const family of FAMILIES) {
    const state = stateOf(family);
    prune(state, now);
    out[family] = {
      calls: state.calls,
      linesEmitted: state.linesEmitted,
      linesSuppressed: state.linesSuppressed,
      mentionsSeen: state.mentionsSeen,
      mentionsSuppressed: state.mentionsSuppressed,
      reAnnouncements: state.reAnnouncements,
      announcedCount: state.announcedAt.size,
      announcedKeys: [...state.announcedAt.keys()].sort(),
      ttlMs: SYMBOL_ANNOUNCE_TTL_MS,
    };
  }
  return out;
}

/** Test seam — forget every announcement and zero every counter. */
export function __resetSymbolLogDedupeForTests(): void {
  families.clear();
  for (const f of FAMILIES) families.set(f, emptyFamily());
}
