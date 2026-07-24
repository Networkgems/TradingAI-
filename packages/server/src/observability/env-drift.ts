// TRA-2209 (spun out of TRA-2198) — declared-vs-running env drift check.
//
// WHY THIS EXISTS: the TRA-2136 env wipe went SIX DAYS undetected
// (2026-07-22T13:08Z → 2026-07-23T23:09Z). It survived that long because the
// flags that DID survive were enough to make every health surface read healthy,
// and nothing anywhere compared `render.yaml` (declared intent) against what the
// running process actually holds. Twelve declared-ON flags read OFF — four of
// them risk controls — while `/api/health/*` stayed green across the board.
//
// This module is the missing comparison. It is deliberately a PURE function over
// (render.yaml text, running env, seeded-key record) so the whole thing is
// unit-testable without booting a server or touching Render.
//
// ── THE FAILURE THIS FILE MUST NOT REPRODUCE ────────────────────────────────
// The first hand-rolled cut of this check SILENTLY REPORTED ZERO DRIFT.
// `render.yaml` is CRLF, and JS `.` does not match `\r`, so a `/value:\s*(.*)$/`
// capture terminated at the `\r` — or, worse, `$` in non-multiline mode never
// matched at all. The script parsed 78 keys and 0 values, then printed empty
// "all clear" sections. It read EXACTLY like a healthy box.
//
// Two structural defences, both load-bearing:
//   1. Lines are split on /\r?\n/ and each is `.trimEnd()`-ed, so CR can never
//      reach a value capture. `parseRenderYamlEnvVars` is tested against CRLF
//      fixture content with a planted divergence.
//   2. The report counts the INPUT, not just the output, and REFUSES to read ok
//      when the input count is zero. `declaredKeysParsed` alone would NOT have
//      caught the original bug (it read 78, correctly!) — the number that
//      actually separated broken from healthy was `declaredValuesParsed`, which
//      read 0. BOTH are emitted, and BOTH must be > 0 for `parserOk`.
//      cf. TRA-1729: a count derived from the OUTPUT is not a count of the INPUT.
//
// ── TRA-2224: AN EXEMPTION IS NOT A COMPARISON ──────────────────────────────
// The first cut exempted self-healed keys from the drift buckets — correct, they
// are not wipe casualties — but in doing so it stopped COMPARING them at all.
// `selfHealed` then reported a key as a known, benign fragility no matter what
// value the process was running, and six of the ten keys bqb1 self-heals are
// numeric tunables whose maps promise to "match render.yaml exactly".
//
// Absence from every drift bucket is a PASS only if the key was actually
// compared. Self-healed literals are now agreement-checked against the blueprint
// (`selfHealed[].matchesDeclared`) and a disagreement counts into `driftCount`
// via `selfHealedMismatchCount`. Both paths share ONE comparator
// (`compareDeclaredToRunning`) so they cannot answer the same question two ways.
//
// ── NO VALUES, EVER ─────────────────────────────────────────────────────────
// These keys live in the same store as TRADIER_API_TOKEN / AUTH_SECRET. This
// surface is NO-AUTH. It therefore emits KEY NAMES AND STATE LABELS ONLY —
// never a declared value, never a running value, not even for keys that look
// boring. The `EnvDriftEntry` type has no field capable of carrying one.
// (TRA-2163 redaction lesson, applied to the whole surface.)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How a declared key is recorded in the blueprint. */
export type DeclaredKind =
  /** `value: X` — a literal the blueprint asserts. The only kind we compare. */
  | 'literal'
  /** `sync: false` — dashboard-managed, legitimately absent from the blueprint. */
  | 'dashboard'
  /** `generateValue: true` / `fromService:` / `fromDatabase:` — Render-managed. */
  | 'render-managed';

/** One `- key:` entry parsed out of a render.yaml `envVars:` block. */
export interface DeclaredEnvVar {
  key: string;
  kind: DeclaredKind;
  /**
   * The literal from `value:`, present only for `kind: 'literal'`. INTERNAL —
   * used to classify on/off and to compare. It is NEVER copied into a report.
   */
  value?: string;
}

/** Outcome of parsing a render.yaml blueprint. */
export interface ParsedRenderEnv {
  declared: DeclaredEnvVar[];
  /** Every `- key:` seen inside an `envVars:` block, all kinds. */
  keysParsed: number;
  /** Keys that yielded a literal `value:`. ZERO HERE MEANS A BROKEN PARSER. */
  valuesParsed: number;
  /** Keys skipped as `sync: false` (dashboard-managed). */
  dashboardManaged: number;
  /** Keys skipped as Render-managed (`generateValue` / `fromService` / ...). */
  renderManaged: number;
}

/** Declared/running state label. Carries no value — see NO VALUES, EVER above. */
export type EnvState = 'on' | 'off' | 'set' | 'absent';

/** A single divergence. Key + state labels only; structurally cannot leak a value. */
export interface EnvDriftEntry {
  key: string;
  declared: EnvState;
  running: EnvState;
}

/** A key present in the running env only because a code fallback re-seeded it. */
export interface SelfHealedEntry {
  key: string;
  /** Which self-heal map supplied it, e.g. `RENDER_RATIFIED_DEMO_DEFAULTS`. */
  source: string;
  /** Whether render.yaml also declares it (it should — that is the map's contract). */
  declared: boolean;
  /**
   * TRA-2224 — does the value the process is actually RUNNING agree with the one
   * render.yaml declares? `null` when the blueprint declares no literal to compare
   * against (undeclared, `sync: false`, or Render-managed).
   *
   * WHY THIS FIELD EXISTS: exempting a seeded key from the drift buckets was
   * correct, but the first cut exempted it from being COMPARED AT ALL. Six of the
   * ten keys bqb1 self-heals are NUMERIC tunables (thresholds, caps, confirm-bars),
   * and the maps' own contract is to "make the RUNNING gate match render.yaml
   * exactly". Nothing enforced that. A map constant edited out of step with the
   * blueprint — or a blueprint retuned without the map — would leave the process on
   * a number the blueprint does not declare, and the route would report the key
   * under `selfHealed`, which reads as a KNOWN, BENIGN fragility. Absence from
   * every drift bucket is a PASS only if the key was actually compared.
   */
  matchesDeclared: boolean | null;
}

export interface EnvDriftReport {
  /** false when the parser is broken OR any drift is present. */
  ok: boolean;
  /** false ⇒ the CHECK is broken and the drift lists mean NOTHING. */
  parserOk: boolean;
  /** Human-readable reason when `ok` is false. */
  reason: string | null;
  /** INPUT-side count: every `- key:` seen. 0 ⇒ parser found no blueprint. */
  declaredKeysParsed: number;
  /** INPUT-side count: keys with a literal `value:`. 0 ⇒ the CRLF-class bug. */
  declaredValuesParsed: number;
  declaredDashboardManaged: number;
  declaredRenderManaged: number;
  /**
   * Literal-declared keys compared through the DRIFT BUCKETS (declaredValuesParsed
   * minus self-healed). Self-healed literals are compared too, but for agreement
   * only — see {@link EnvDriftReport.selfHealedMismatchCount}.
   */
  comparedKeys: number;
  /**
   * TRA-2224 — self-healed keys whose RUNNING value contradicts the render.yaml
   * literal (`selfHealed[].matchesDeclared === false`). Counted into `driftCount`
   * but deliberately NOT folded into the three buckets: the failure is "code
   * fallback and blueprint disagree", not "the store was wiped", and conflating
   * them would misdirect the fix.
   */
  selfHealedMismatchCount: number;
  /**
   * Total divergences = the three buckets PLUS `selfHealedMismatchCount`. It is
   * therefore NOT always the sum of the three array lengths — check the count
   * field too before reading a short bucket list as "nothing else wrong".
   */
  driftCount: number;
  /** Declared truthy, running falsy or absent. The TRA-2136 wipe signature. */
  declaredOnButOff: EnvDriftEntry[];
  /** Declared falsy, running truthy. An un-declared arm. */
  declaredOffButOn: EnvDriftEntry[];
  /** Non-boolean literal whose running value differs, or is absent. */
  valueMismatch: EnvDriftEntry[];
  /**
   * NOT drift — a code fallback supplies these. Surfaced anyway because their
   * arm survives only via that fallback and NOT because the env holds it, which
   * is a standing fragility worth seeing (TRA-2198).
   */
  selfHealed: SelfHealedEntry[];
  /** Whether render.yaml was located and read at all. */
  blueprintFound: boolean;
  /** `RENDER` set ⇒ render.yaml is the source of truth for this process. */
  onRender: boolean;
  checkedAt: string;
}

export interface EvaluateEnvDriftOptions {
  /** Raw render.yaml text, or null when the blueprint could not be read. */
  blueprint: string | null;
  /** The running process's own view of its env. */
  runningEnv: NodeJS.ProcessEnv;
  /**
   * Keys the boot self-heal seeded into `process.env`, mapped to the map that
   * supplied them. RECORDED AT BOOT, not inferred: after seeding, a seeded key is
   * indistinguishable from a Render-supplied one by inspection alone, so asking
   * the self-heal functions again at route time returns {} and would misreport
   * every seeded key as healthy env. cf. `getSeededEnvKeys()` in demo-flags.ts.
   */
  seededKeys: Readonly<Record<string, string>>;
  now?: () => number;
}

/**
 * IMPURE. Locate and read `render.yaml`, walking up from this module toward the
 * repo root (compiled, this file sits at `<repo>/packages/server/dist/
 * observability/`, so the root is 4 levels up; from source it is 4 as well).
 * `RENDER_BLUEPRINT_PATH` overrides for ops/self-host layouts.
 *
 * Returns null when the blueprint cannot be read — which {@link evaluateEnvDrift}
 * turns into `ok:false, parserOk:false`, NOT into a clean box. A drift check that
 * cannot see the declared side must say so, loudly; that is the whole lesson of
 * this ticket.
 */
export function loadRenderBlueprint(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env['RENDER_BLUEPRINT_PATH']?.trim();
  const candidates: string[] = [];
  if (override) candidates.push(override);

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop <= 6; hop += 1) {
    candidates.push(join(dir, 'render.yaml'));
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // keep walking — an unreadable candidate is not an error until all fail
    }
  }
  return null;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

/**
 * Classify a raw env string as on/off, or null when it is not boolean-shaped
 * (e.g. `20.19.0`, `/data`, `587`). Case-insensitive, whitespace-tolerant.
 */
export function classifyBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

/** Strip one layer of matching YAML quotes: `"1"` → `1`, `'true'` → `true`. */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Result of comparing one declared literal against the running process. */
interface Agreement {
  /** True ⇒ the running process honours the declaration. */
  agrees: boolean;
  /** Label for the running side; carries no value (see NO VALUES, EVER). */
  runningState: EnvState;
}

/**
 * THE ONE COMPARATOR. Both the drift buckets and the self-healed agreement check
 * route through this, so the two accounts cannot answer the same question
 * differently — a second, hand-rolled comparator for the self-heal path was the
 * obvious way to write TRA-2224's fix and the obvious way to reintroduce its bug.
 *
 * Boolean-shaped declarations compare INTENT ("true" == "1"); anything else is an
 * exact string compare after unquoting. Note the asymmetry, which is deliberate and
 * matches the pre-TRA-2224 behaviour exactly: an ABSENT key contradicts a declared
 * ON and a declared literal, but satisfies a declared OFF — absent and off are the
 * same posture for a boolean, and flagging them apart would fire on every flag the
 * blueprint deliberately leaves unset.
 */
function compareDeclaredToRunning(declaredValue: string, rawRunning: string | undefined): Agreement {
  const runningPresent = typeof rawRunning === 'string' && rawRunning.trim() !== '';
  const declaredBool = classifyBool(declaredValue);

  if (declaredBool !== null) {
    const armed = runningPresent && classifyBool(rawRunning!) === true;
    return {
      agrees: declaredBool === armed,
      runningState: runningPresent ? (armed ? 'on' : 'off') : 'absent',
    };
  }

  if (!runningPresent) return { agrees: false, runningState: 'absent' };
  return { agrees: unquote(rawRunning!) === declaredValue, runningState: 'set' };
}

const ENVVARS_RE = /^(\s*)envVars:\s*$/;
const KEY_RE = /^\s*-\s+key:\s*(\S+)\s*$/;
const VALUE_RE = /^\s*value:\s*(.*)$/;
const SYNC_FALSE_RE = /^\s*sync:\s*false\s*$/i;
const RENDER_MANAGED_RE = /^\s*(generateValue|fromService|fromDatabase|fromGroup):/;

/**
 * Parse every `- key:` under every `envVars:` block of a render.yaml blueprint.
 *
 * CRLF-SAFE BY CONSTRUCTION: splits on /\r?\n/ and trims trailing whitespace off
 * every line before any regex runs, so a stray `\r` can never end up inside a
 * captured value or defeat an end-anchor. This is the exact bug the ticket was
 * written around — see the header. Do not "simplify" this to a single multiline
 * regex over the raw text.
 *
 * Scoped to `envVars:` blocks (tracked by indentation) rather than grepping the
 * whole file for `- key:`, so an unrelated list elsewhere in the blueprint can
 * never inflate the input count and make a broken parse look well-fed.
 */
export function parseRenderYamlEnvVars(text: string): ParsedRenderEnv {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());

  const declared: DeclaredEnvVar[] = [];
  let inEnvVars = false;
  let envVarsIndent = 0;
  let current: DeclaredEnvVar | null = null;

  const flush = (): void => {
    if (current) declared.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const envVarsMatch = ENVVARS_RE.exec(line);
    if (envVarsMatch) {
      flush();
      inEnvVars = true;
      envVarsIndent = envVarsMatch[1]!.length;
      continue;
    }

    if (!inEnvVars) continue;

    // Leaving the block: any content at or left of `envVars:`' own indentation.
    const indent = line.length - line.trimStart().length;
    if (indent <= envVarsIndent) {
      flush();
      inEnvVars = false;
      continue;
    }

    const keyMatch = KEY_RE.exec(line);
    if (keyMatch) {
      flush();
      // Default to render-managed: an entry whose directive we never see is NOT
      // a literal, so it is never compared. Fail closed, not into a false drift.
      current = { key: keyMatch[1]!, kind: 'render-managed' };
      continue;
    }

    if (!current) continue;

    const valueMatch = VALUE_RE.exec(line);
    if (valueMatch) {
      current.kind = 'literal';
      current.value = unquote(valueMatch[1]!);
      continue;
    }
    if (SYNC_FALSE_RE.test(line)) {
      current.kind = 'dashboard';
      continue;
    }
    if (RENDER_MANAGED_RE.test(line)) {
      current.kind = 'render-managed';
      continue;
    }
  }
  flush();

  return {
    declared,
    keysParsed: declared.length,
    valuesParsed: declared.filter((d) => d.kind === 'literal').length,
    dashboardManaged: declared.filter((d) => d.kind === 'dashboard').length,
    renderManaged: declared.filter((d) => d.kind === 'render-managed').length,
  };
}

/**
 * Compare declared intent against the running process. Pure — no fs, no clock
 * beyond the injectable `now`, no process.env read of its own.
 */
export function evaluateEnvDrift(opts: EvaluateEnvDriftOptions): EnvDriftReport {
  const now = opts.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  const onRender = Boolean(opts.runningEnv['RENDER']);

  if (opts.blueprint === null) {
    return {
      ok: false,
      parserOk: false,
      reason: 'render.yaml not found — the drift check has no declared side to compare against',
      declaredKeysParsed: 0,
      declaredValuesParsed: 0,
      declaredDashboardManaged: 0,
      declaredRenderManaged: 0,
      comparedKeys: 0,
      selfHealedMismatchCount: 0,
      driftCount: 0,
      declaredOnButOff: [],
      declaredOffButOn: [],
      valueMismatch: [],
      selfHealed: [],
      blueprintFound: false,
      onRender,
      checkedAt,
    };
  }

  const parsed = parseRenderYamlEnvVars(opts.blueprint);

  const declaredOnButOff: EnvDriftEntry[] = [];
  const declaredOffButOn: EnvDriftEntry[] = [];
  const valueMismatch: EnvDriftEntry[] = [];
  const selfHealed: SelfHealedEntry[] = [];

  const declaredKeys = new Set(parsed.declared.map((d) => d.key));
  // Literals only — a `sync: false` / Render-managed entry declares no value to
  // compare against, so its agreement is `null`, never a fabricated `true`.
  const declaredLiterals = new Map(
    parsed.declared
      .filter((d) => d.kind === 'literal' && d.value !== undefined)
      .map((d) => [d.key, d.value!] as const),
  );

  for (const [key, source] of Object.entries(opts.seededKeys)) {
    const declaredValue = declaredLiterals.get(key);
    // TRA-2224 — compare against the value the process is RUNNING, not against the
    // self-heal map constant. If anything mutated the key after the boot seed, the
    // running value is the one that governs behaviour and the only one worth
    // grading; reading the map back would just assert the map equals itself.
    const matchesDeclared =
      declaredValue === undefined
        ? null
        : compareDeclaredToRunning(declaredValue, opts.runningEnv[key]).agrees;
    selfHealed.push({ key, source, declared: declaredKeys.has(key), matchesDeclared });
  }
  selfHealed.sort((a, b) => a.key.localeCompare(b.key));
  const selfHealedMismatchCount = selfHealed.filter((s) => s.matchesDeclared === false).length;

  let comparedKeys = 0;
  for (const entry of parsed.declared) {
    if (entry.kind !== 'literal' || entry.value === undefined) continue;
    // A self-healed key IS present in the running env, but only because the code
    // put it there. Classifying it as healthy would be a lie and classifying it
    // as drift would be a false alarm — so it gets its own bucket and is not
    // compared at all.
    if (Object.prototype.hasOwnProperty.call(opts.seededKeys, entry.key)) continue;

    comparedKeys += 1;

    const cmp = compareDeclaredToRunning(entry.value, opts.runningEnv[entry.key]);
    if (cmp.agrees) continue;

    // Boolean-shaped declarations sort into the on/off buckets (the TRA-2136 wipe
    // signature); everything else — versions, paths, numeric tunables — is a value
    // mismatch. Same verdict either way, different bucket, because the two point at
    // different fixes.
    const declaredBool = classifyBool(entry.value);
    if (declaredBool === true) {
      declaredOnButOff.push({ key: entry.key, declared: 'on', running: cmp.runningState });
    } else if (declaredBool === false) {
      declaredOffButOn.push({ key: entry.key, declared: 'off', running: 'on' });
    } else {
      valueMismatch.push({ key: entry.key, declared: 'set', running: cmp.runningState });
    }
  }

  const driftCount =
    declaredOnButOff.length +
    declaredOffButOn.length +
    valueMismatch.length +
    selfHealedMismatchCount;

  // THE INPUT-SIDE GUARD. `declaredKeysParsed > 0` alone is NOT sufficient: the
  // original CRLF bug parsed 78 keys and 0 values and printed a clean box. The
  // count that SEPARATES broken from healthy is the VALUE count (TRA-2075).
  const parserOk = parsed.keysParsed > 0 && parsed.valuesParsed > 0;

  let reason: string | null = null;
  if (!parserOk) {
    reason =
      parsed.keysParsed === 0
        ? 'parser matched no env keys in render.yaml — driftCount:0 here means BROKEN, not clean'
        : `parser matched ${parsed.keysParsed} keys but 0 literal values — BROKEN parse (CRLF-class bug), driftCount:0 is meaningless`;
  } else if (driftCount > 0) {
    reason = `${driftCount} declared env key(s) diverge from the running process`;
    if (selfHealedMismatchCount > 0) {
      // Name this separately: it is the one drift class NOT fixed by an env upsert.
      reason += ` (${selfHealedMismatchCount} of them self-healed to a value render.yaml does not declare — reconcile the code fallback map, not the store)`;
    }
  }

  return {
    ok: parserOk && driftCount === 0,
    parserOk,
    reason,
    declaredKeysParsed: parsed.keysParsed,
    declaredValuesParsed: parsed.valuesParsed,
    declaredDashboardManaged: parsed.dashboardManaged,
    declaredRenderManaged: parsed.renderManaged,
    comparedKeys,
    selfHealedMismatchCount,
    driftCount,
    declaredOnButOff,
    declaredOffButOn,
    valueMismatch,
    selfHealed,
    blueprintFound: true,
    onRender,
    checkedAt,
  };
}
