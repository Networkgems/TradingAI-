/**
 * TRA-4158 — name the container that retains the RTH heap, by MEASUREMENT.
 *
 * ## Why this exists
 *
 * bqb1's V8 heap read 352 MB on 2026-08-25 and 1605 MB / 1812 MB (88.6%) at the
 * 2026-08-27T13:26:17Z watchdog trip, 24.5h uptime — and the Render RSS series
 * shows the climb is RTH-shaped (500 MB at 13:30Z -> 2545 MB at 19:30Z) and then
 * FLAT overnight. Flat-overnight is the whole tell: what accumulates is
 * RETAINED, not transient. `render.yaml`'s "RTH heap peaks at ~475 MB" premise,
 * which all three of its memory constants are derived against, is stale by 3x.
 *
 * ## Why a census and not a heap snapshot
 *
 * The filing asked for two `v8.writeHeapSnapshot` reads diffed by retained size
 * per constructor. That instrument answers "what is big", once. It does NOT
 * answer the question the overnight-flat shape actually poses, which is "which
 * container's ENTRY COUNT rises through the session and never comes back down" —
 * and a constructor histogram cannot answer it, because every one of the
 * suspects here is a `Map` of `Array`s of plain objects and they all fold into
 * the same three constructor buckets. It is also the more dangerous instrument
 * on this host: serialising a 1.6 GB heap on a live money-adjacent box, inside a
 * 4 GB cgroup, during a session, is a self-inflicted OOM.
 *
 * So: a cheap ENTRY-COUNT census, sampled on a cadence into a bounded ring, over
 * a full RTH session. The series is the evidence. The snapshot stays available
 * as a follow-up once the census has narrowed the field to one or two names.
 *
 * ## Why it is reflective and not a hand-written field list
 *
 * `SignalEngine` alone declares ~45 own container fields, and one
 * `SignalEngine` + one `CryptoSignalEngine` + two `PnlTracker`s are constructed
 * PER USER (`user-context.ts` `createUserContext`), against 67 users on bqb1 —
 * so every container in that class carries a x67 multiplier. A hand-written list
 * of "the suspects" is exactly the assumption this ticket forbids: it can only
 * ever find a retainer someone already suspected, and it goes stale the first
 * time a field is added. {@link censusObject} walks the target's OWN ENUMERABLE
 * DATA properties instead, so the census is complete by construction and no new
 * cache can hide from it.
 *
 * Accessors are skipped deliberately — a getter on a prototype is not an own
 * property and would not be reached anyway, but an own accessor could run
 * arbitrary code, and a health probe must not have side effects.
 *
 * ## Cost
 *
 * `Map.prototype.size`, `Set.prototype.size` and `Array.prototype.length` are
 * O(1). A shallow census of one engine is therefore O(#fields) — a few hundred
 * property reads. Across 67 contexts x 4 objects that is single-digit
 * milliseconds, which is why it is safe to sample on a timer during RTH.
 *
 * The DEEP census (summing the lengths of array VALUES inside a `Map`) is
 * O(entries) and is opt-in per call. It exists because the interesting
 * distinction for `Map<string, Candle[]>` is whether the map gained KEYS
 * (universe drift) or its existing values grew (an append with no trim), and
 * only the deep number separates those two.
 */

/** What kind of container a reading came from. Anything else is not counted. */
export type ContainerKind = 'map' | 'set' | 'array';

/** One container on one owner object. */
export interface ContainerReading {
  /** The own-property name the container is held under, e.g. `candleCache`. */
  key: string;
  kind: ContainerKind;
  /** `Map.size` / `Set.size` / `Array.length`. Always populated. */
  entries: number;
  /**
   * Σ of the lengths of array-valued entries, when a deep census was asked for
   * AND at least one value is an array. `null` means "not measured" (shallow
   * census) or "no array values" — the two are distinguished by
   * {@link CensusOptions.deep} on the call, not by this field.
   */
  nested: number | null;
}

export interface CensusOptions {
  /**
   * Sum the lengths of array-valued `Map`/`Set`/`Array` members. O(entries).
   * Off by default so the sampled path stays O(#fields).
   */
  deep?: boolean;
  /**
   * Cap on how many entries the deep sum will walk per container before it
   * stops and reports what it has. Guards the probe against being turned into
   * its own latency incident by the very unbounded growth it is hunting.
   */
  deepEntryBudget?: number;
}

const DEFAULT_DEEP_ENTRY_BUDGET = 50_000;

function classify(value: unknown): ContainerKind | null {
  if (Array.isArray(value)) return 'array';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  return null;
}

/**
 * Sum the lengths of array-valued members, up to `budget` members.
 *
 * Returns `null` when nothing in the container is an array — a `Map<string,
 * number>` has no nested dimension and reporting `0` for it would read as "its
 * values are empty arrays", which is a different and false claim.
 */
function sumNested(
  container: Map<unknown, unknown> | Set<unknown> | unknown[],
  budget: number,
): number | null {
  const values: Iterable<unknown> = container instanceof Map ? container.values() : container;
  let total = 0;
  let sawArray = false;
  let walked = 0;
  for (const v of values) {
    if (walked >= budget) break;
    walked += 1;
    if (Array.isArray(v)) {
      sawArray = true;
      total += v.length;
    }
  }
  return sawArray ? total : null;
}

/**
 * Census every own enumerable DATA property of `target` that holds a Map, Set or
 * Array. Sorted by `entries` descending so the head of the list is the answer.
 *
 * Non-container fields are omitted rather than reported as zero: a census whose
 * rows are mostly `entries: 0` scalars buries the signal, and the count of
 * fields is not what is being measured.
 */
export function censusObject(target: object, opts: CensusOptions = {}): ContainerReading[] {
  const budget = opts.deepEntryBudget ?? DEFAULT_DEEP_ENTRY_BUDGET;
  const rows: ContainerReading[] = [];
  for (const key of Object.keys(target)) {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    // An own accessor could run arbitrary code; a health probe must not.
    if (!desc || !('value' in desc)) continue;
    const kind = classify(desc.value);
    if (!kind) continue;
    const container = desc.value as Map<unknown, unknown> | Set<unknown> | unknown[];
    const entries = kind === 'array' ? (container as unknown[]).length : (container as Map<unknown, unknown>).size;
    rows.push({
      key,
      kind,
      entries,
      nested: opts.deep ? sumNested(container, budget) : null,
    });
  }
  rows.sort((a, b) => b.entries - a.entries || a.key.localeCompare(b.key));
  return rows;
}

/** One object handed to the fold, tagged with the CLASS it belongs to. */
export interface CensusSubject {
  /**
   * The class the object belongs to — `signalEngine`, `cryptoEngine`,
   * `pnlTracker`, … NOT the username. The per-user identity is deliberately not
   * carried: this is a memory instrument, and 67 usernames on an unauthenticated
   * health route is a tenant disclosure for no measurement gain. `owners` and
   * `maxEntries` carry everything the fold needs.
   */
  klass: string;
  target: object;
}

/** One container name, folded across every owner of its class. */
export interface RetainerRow {
  /** `<klass>.<key>`, e.g. `signalEngine.candleCache`. */
  name: string;
  kind: ContainerKind;
  /** How many owner objects of this class actually carried the field. */
  owners: number;
  /** Σ `entries` across owners — the fleet-level number. */
  entries: number;
  /** The single worst owner. A fleet total of 6700 over 67 owners is a very
   * different defect from the same total concentrated in one. */
  maxEntries: number;
  /** Σ `nested` across owners, or `null` when no owner reported one. */
  nested: number | null;
}

/**
 * Fold per-object readings into one row per `<klass>.<key>`, sorted by fleet
 * `entries` descending.
 */
export function foldCensus(subjects: readonly CensusSubject[], opts: CensusOptions = {}): RetainerRow[] {
  const byName = new Map<string, RetainerRow>();
  for (const subject of subjects) {
    for (const reading of censusObject(subject.target, opts)) {
      const name = `${subject.klass}.${reading.key}`;
      const existing = byName.get(name);
      if (!existing) {
        byName.set(name, {
          name,
          kind: reading.kind,
          owners: 1,
          entries: reading.entries,
          maxEntries: reading.entries,
          nested: reading.nested,
        });
        continue;
      }
      existing.owners += 1;
      existing.entries += reading.entries;
      if (reading.entries > existing.maxEntries) existing.maxEntries = reading.entries;
      if (reading.nested !== null) existing.nested = (existing.nested ?? 0) + reading.nested;
    }
  }
  return [...byName.values()].sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name));
}

/** One sample in the tape: memory levels plus the census that explains them. */
export interface HeapCensusSample {
  atMs: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
  arrayBuffersMB: number;
  /** How many owner objects were censused (all classes). */
  subjects: number;
  /** Fleet `entries` per retainer name. Only names present at this sample. */
  counts: Record<string, number>;
  /** Wall time the census itself cost, so the instrument can be graded too. */
  elapsedMs: number;
}

/** The growth verdict for one retainer across the whole tape. */
export interface RetainerTrend {
  name: string;
  first: number;
  last: number;
  peak: number;
  delta: number;
  /**
   * `last / first`, or `null` when `first` is 0 — a ratio against zero is
   * infinite for a container that gained its FIRST entry, which is not growth
   * worth ranking. Rank on `delta`; read `ratio` as colour.
   */
  ratio: number | null;
}

/**
 * The growth verdict for one retainer since BOOT, immune to ring eviction.
 *
 * Exists because `trends()` is computed off the ring, and the ring holds 24 h:
 * on 2026-09-08 a monitor wake landed ~89 h late (armed 09-04T19:45Z, delivered
 * 09-08T12:52Z — the platform scheduler going dark is a measured recurring
 * event, TRA-4141) and the live boot was 92.6 h old, so every census sample
 * covering the boot's only RTH session had been evicted. `trends()` answered
 * for a closed-market Sunday→Monday window while claiming nothing about what
 * it could no longer see. These aggregates are updated at record() time and
 * never evicted, so a late reader still gets "what grew since birth" — at the
 * cost of losing the shape between first and peak, which the ring still
 * carries whenever the read is on time.
 */
export interface BootRetainerTrend {
  name: string;
  /** Entries at the first sample that carried this name (sampler runs at boot). */
  first: number;
  firstAtMs: number;
  /** Entries at the most recent sample (0 = released — the shape we WANT). */
  last: number;
  peak: number;
  peakAtMs: number;
  delta: number;
  /** `last / first`, or `null` when `first` is 0. Rank on `delta`. */
  ratio: number | null;
}

const BYTES_PER_MB = 1024 * 1024;

function toMB(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/**
 * A BOUNDED ring of census samples.
 *
 * Bounded on purpose and worth saying out loud: the defect class this instrument
 * hunts is "a ring or cache that is not bounded", and an unbounded tape would be
 * a new instance of it. At the 300 s default cadence, 288 slots is 24 h — one
 * full session plus the overnight flat that proves retention, which is exactly
 * the window the grade needs and not one sample more.
 */
export class HeapCensusTape {
  private readonly samples: HeapCensusSample[] = [];
  /** Boot-scoped first/peak per name — never evicted. Bounded by #names (~56). */
  private readonly bootStats = new Map<
    string,
    { first: number; firstAtMs: number; peak: number; peakAtMs: number }
  >();
  private lastCounts: Record<string, number> = {};
  private lastAtMs = 0;

  constructor(private readonly capacity = 288) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`HeapCensusTape capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Take one census of `subjects` and append it. Returns the sample taken. */
  record(subjects: readonly CensusSubject[], nowMs: number, opts: CensusOptions = {}): HeapCensusSample {
    const startedAt = Date.now();
    const rows = foldCensus(subjects, opts);
    const mem = process.memoryUsage();
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.name] = row.entries;
    const sample: HeapCensusSample = {
      atMs: nowMs,
      heapUsedMB: toMB(mem.heapUsed),
      heapTotalMB: toMB(mem.heapTotal),
      rssMB: toMB(mem.rss),
      externalMB: toMB(mem.external),
      arrayBuffersMB: toMB(mem.arrayBuffers),
      subjects: subjects.length,
      counts,
      elapsedMs: Date.now() - startedAt,
    };
    this.samples.push(sample);
    while (this.samples.length > this.capacity) this.samples.shift();
    for (const [name, entries] of Object.entries(counts)) {
      const stat = this.bootStats.get(name);
      if (!stat) {
        this.bootStats.set(name, { first: entries, firstAtMs: nowMs, peak: entries, peakAtMs: nowMs });
      } else if (entries > stat.peak) {
        stat.peak = entries;
        stat.peakAtMs = nowMs;
      }
    }
    this.lastCounts = counts;
    this.lastAtMs = nowMs;
    return sample;
  }

  /** Chronological copy of the ring. */
  snapshot(): HeapCensusSample[] {
    return [...this.samples];
  }

  get length(): number {
    return this.samples.length;
  }

  /**
   * Rank retainers by how much they GREW across the tape.
   *
   * A name absent from the first sample but present later is treated as
   * `first = 0`: it appeared, which is growth. A name absent from the last
   * sample is treated as `last = 0`: it was released, which is the shape we
   * WANT and must be allowed to score negative rather than be dropped.
   */
  trends(): RetainerTrend[] {
    if (this.samples.length === 0) return [];
    const firstSample = this.samples[0];
    const lastSample = this.samples[this.samples.length - 1];
    const names = new Set<string>();
    for (const s of this.samples) for (const n of Object.keys(s.counts)) names.add(n);
    const out: RetainerTrend[] = [];
    for (const name of names) {
      const first = firstSample.counts[name] ?? 0;
      const last = lastSample.counts[name] ?? 0;
      let peak = 0;
      for (const s of this.samples) {
        const v = s.counts[name] ?? 0;
        if (v > peak) peak = v;
      }
      out.push({
        name,
        first,
        last,
        peak,
        delta: last - first,
        ratio: first > 0 ? Math.round((last / first) * 100) / 100 : null,
      });
    }
    return out.sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));
  }

  /**
   * Rank retainers by growth since BOOT, off the never-evicted aggregates.
   *
   * `first`/`peak` come from {@link bootStats}; `last` comes from the most
   * recent sample, with a name absent there scored `last = 0` (released) for
   * the same reason `trends()` does. When the ring has not yet wrapped this
   * agrees with `trends()` by construction; when it has, this is the only one
   * of the two still telling the truth about the boot.
   */
  bootTrends(): BootRetainerTrend[] {
    const out: BootRetainerTrend[] = [];
    for (const [name, stat] of this.bootStats) {
      const last = this.lastCounts[name] ?? 0;
      out.push({
        name,
        first: stat.first,
        firstAtMs: stat.firstAtMs,
        last,
        peak: stat.peak,
        peakAtMs: stat.peakAtMs,
        delta: last - stat.first,
        ratio: stat.first > 0 ? Math.round((last / stat.first) * 100) / 100 : null,
      });
    }
    return out.sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));
  }
}
