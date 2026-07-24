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
  /** Literal-declared keys actually compared (declaredValuesParsed minus self-healed). */
  comparedKeys: number;
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
  for (const [key, source] of Object.entries(opts.seededKeys)) {
    selfHealed.push({ key, source, declared: declaredKeys.has(key) });
  }
  selfHealed.sort((a, b) => a.key.localeCompare(b.key));

  let comparedKeys = 0;
  for (const entry of parsed.declared) {
    if (entry.kind !== 'literal' || entry.value === undefined) continue;
    // A self-healed key IS present in the running env, but only because the code
    // put it there. Classifying it as healthy would be a lie and classifying it
    // as drift would be a false alarm — so it gets its own bucket and is not
    // compared at all.
    if (Object.prototype.hasOwnProperty.call(opts.seededKeys, entry.key)) continue;

    comparedKeys += 1;

    const rawRunning = opts.runningEnv[entry.key];
    const runningPresent = typeof rawRunning === 'string' && rawRunning.trim() !== '';
    const declaredBool = classifyBool(entry.value);

    if (declaredBool !== null) {
      // Boolean-shaped: compare INTENT, not spelling. render.yaml says "true"
      // where a self-heal map says '1'; both mean armed and neither is drift.
      const runningBool = runningPresent ? classifyBool(rawRunning!) : false;
      if (declaredBool && runningBool !== true) {
        declaredOnButOff.push({
          key: entry.key,
          declared: 'on',
          running: runningPresent ? 'off' : 'absent',
        });
      } else if (!declaredBool && runningBool === true) {
        declaredOffButOn.push({ key: entry.key, declared: 'off', running: 'on' });
      }
      continue;
    }

    // Non-boolean literal (versions, paths, numeric tunables): exact compare
    // after unquoting. Absent counts as a mismatch, flagged as such.
    if (!runningPresent) {
      valueMismatch.push({ key: entry.key, declared: 'set', running: 'absent' });
    } else if (unquote(rawRunning!) !== entry.value) {
      valueMismatch.push({ key: entry.key, declared: 'set', running: 'set' });
    }
  }

  const driftCount = declaredOnButOff.length + declaredOffButOn.length + valueMismatch.length;

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
