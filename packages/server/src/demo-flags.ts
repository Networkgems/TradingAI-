// TRA-1008 — file-backed override for non-secret DEMO-sandbox feature flags.
//
// Why this exists: the self-hosted `trading-server` (PG-DEVOPS14) has NO dotenv
// loader — its environment lives only in PM2's saved process env (dump.pm2). The
// PM2 daemon runs in session 0 as SYSTEM, so the fleet (non-admin) user cannot
// reach the daemon pipe (`connect EPERM \\.\pipe\rpc.sock`) to run
// `pm2 restart --update-env` / `pm2 save`. That made it impossible for a
// non-admin operator/agent to set a NEW demo toggle such as
// ENABLE_AUTONOMOUS_DEMO_LOOP without elevation — the exact wall hit on
// TRA-1008 (which blocked TRA-1007's forward-validation of the TRA-1004 loop):
// editing `.env` and admin-restarting re-execs the worker with the SAME saved
// env, so the flag never appeared (`enabled:false`).
//
// This module adds a writable, daemon-free path: a small JSON file under
// DATA_DIR (`demo-flags.json`) whose values are layered OVER process.env when
// resolving demo-loop flags. It is STRICTLY allowlisted to non-secret DEMO
// toggles — secrets (ADMIN_PASSWORD, AUTH_SECRET, TRADIER_*, etc.) are NEVER
// read from this file and continue to live only in the saved process env. The
// file is read on each resolve, so a flip is picked up on the next tick without
// any PM2 / SYSTEM elevation (and survives a non-admin `redeploy --no-build`).

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Non-secret DEMO-sandbox flags an operator may set via `demo-flags.json`.
 * Anything not on this list in the file is ignored — this is the guardrail that
 * keeps the file from ever injecting a secret or a non-demo setting.
 */
export const DEMO_FLAG_ALLOWLIST = [
  'ENABLE_AUTONOMOUS_DEMO_LOOP',
  'AUTONOMOUS_DEMO_LOOP_INTERVAL_MS',
  // TRA-1216 — observe-only perp funding-carry scanner + forward funding-history
  // accrual. Non-secret, read-only, no order path — safe for the file override so
  // a non-admin operator can arm the forward series on the self-hosted host.
  'ENABLE_PERP_FUNDING_CARRY_OBSERVE',
  // TRA-1220 — observe-only crypto regime-filter overlay (ADX/CHOP/ER classifier).
  // Non-secret, read-only, no order path — emits regime labels only. Safe for the
  // file override so a non-admin operator can arm the forward label stream on the
  // self-hosted host.
  'ENABLE_CRYPTO_REGIME_OVERLAY',
  // TRA-1221 — observe-only regime-gated TSMOM crypto scanner. Non-secret,
  // read-only, no order path — emits would-be signals only. Safe for the file
  // override so a non-admin operator can arm the forward capture on the self-hosted
  // host.
  'ENABLE_CRYPTO_REGIME_TSMOM',
  // TRA-1271 - observe-only crypto ignition scanner (strict RVOL>=6 breakout).
  // Non-secret, read-only, ZERO capital / no order path - emits would-be forward
  // records + the would-a-limit-fill instrument only. Safe for the file override
  // so a non-admin operator can arm the demo forward capture on the self-hosted
  // host (this is how we activate demo capture - no PM2/admin).
  'ENABLE_CRYPTO_IGNITION_SCANNER',
  // TRA-1289 (parent TRA-1288 → TRA-955/1242) — demo-only, manifest-exempt,
  // default-OFF paper fill path for the primary swing router `sma200_pullback`
  // so TRA-955 can forward-test signal accuracy. Non-secret DEMO toggle; the
  // router only consults it on the demo branch and the live path stays hard-
  // gated by the TRA-817 capital-gate manifest, so it is structurally incapable
  // of opening real capital. Safe for the file override so a non-admin operator
  // can arm the demo forward-test on the self-hosted host (no PM2/admin).
  'ENABLE_SMA200_DEMO_FORWARD_TEST',
  // TRA-1300 (parent TRA-1290, board confirmation `38a50f39`) — observe-only
  // scale-out (take-profit) ladder overlay. Non-secret, read-only, ZERO capital /
  // no order path — LOGS intended trims into a durable ledger only; the downside
  // is owned by the shipped chandelier + give-back cap. Safe for the file override
  // so a non-admin operator can arm the demo forward capture on the self-hosted
  // host (no PM2/admin).
  'ENABLE_SCALEOUT_LADDER',
  // TRA-1294 (parent TRA-1290, board confirmation `73ef18b0`) — arm the
  // take-profit-early auto-close (PROFIT-side mirror of the give-back cap) on the
  // DEMO book only. STANDALONE flag (not under the EXIT_RISK_RULES_ENABLED
  // master), and the signal-engine only attaches it on the `mode === 'demo'`
  // branch, so the live options path is untouched. On the demo book it auto-
  // closes paper positions once they capture 60% of available profit / max
  // credit. Safe for the file override so a non-admin operator can arm the demo
  // forward evidence on the self-hosted host (no PM2/admin).
  'TAKE_PROFIT_EARLY_ENABLED',
  // TRA-1270 (parent TRA-1250, board confirmation `b032a145`) — the board-approved
  // exit-side loss-control master switch (ATR chandelier + per-trade profit-lock +
  // book give-back cap / session stop). Added so the self-hosted DEMO engine can
  // arm the guard daemon-free (the SYSTEM PM2 daemon is unreachable to the fleet
  // user — the TRA-1008 wall). DEMO-scoped by construction: the signal-engine
  // consults this override ONLY on the `mode !== 'live'` branch — the live book
  // always reads process.env directly, so a demo-flags.json can never weaken the
  // live breaker. On the self-host TRADIER_ENV=sandbox, so the guard only ever
  // flattens/halts the PAPER book.
  'EXIT_RISK_RULES_ENABLED',
  // TRA-1317 (parent TRA-1316, board interaction `7042a614` = demo) — arm DEMO
  // paper routing of the regime-gated TSMOM scanner. STANDALONE flag (not under the
  // ENABLE_CRYPTO_REGIME_TSMOM observe master), and the route book is a dedicated
  // CryptoPaperAccount with NO live path, so arming it can never touch real capital.
  // Routes enter_long/exit_long transitions into the demo book so the crypto
  // dashboard shows movement + accrues forward round-trip evidence. Safe for the
  // file override so a non-admin operator can arm the demo routing on the
  // self-hosted host (no PM2/admin).
  'CRYPTO_REGIME_TSMOM_DEMO_ROUTE_ENABLED',
  // TRA-1407 (parent TRA-1406 "less noise, more quality") — arm the single_leg_otm
  // entry delta floor on the DEMO book. STANDALONE flag (not under the
  // EXIT_RISK_RULES master), and the signal-engine consults it ONLY on the
  // `mode === 'demo'` OTM branch, so it can never alter a live option open. The
  // OTM_DELTA_FLOOR numeric override tunes the floor (default 0.40). Non-secret,
  // demo-only — safe for the file override so the board can flip it daemon-free on
  // the self-hosted host after QuantTrader's forward-validation (no PM2/admin).
  'OTM_DELTA_FLOOR_ENABLED',
  'OTM_DELTA_FLOOR',
  // TRA-1408 (parent TRA-1406 "less noise, more quality") — the per-name churn +
  // same-day-loss brake. STANDALONE flag (not under the EXIT_RISK_RULES master),
  // consulted ONLY on the demo open chokepoints + demo conviction-DCA add loops,
  // so it can never alter a live open or a live add. Caps same-session re-entries
  // per symbol and halts DCA adds into a same-day net-negative name. The
  // CHURN_SAME_SESSION_OPEN_CAP numeric override tunes the cap (default 3).
  // Non-secret, demo-only — safe for the file override so the board can flip it
  // daemon-free on the self-hosted host after QuantTrader forward-validates.
  'ENABLE_CHURN_LOSS_BRAKE',
  'CHURN_SAME_SESSION_OPEN_CAP',
  // TRA-1410 (parent TRA-1406 "less noise, more quality") — the multi-leg
  // (IC / verticals) demo-open PAUSE guard. Every combo the demo book opens
  // closes at exactly $0 (100% scratch) because its synthetic combo symbol is
  // never mark-managed per tick — un-manageable noise until the durable
  // defined-risk exit policy lands. STANDALONE flag consulted ONLY on the demo
  // combo-open chokepoints, so it can never pause a live open. Non-secret,
  // demo-only — safe for the file override so the board can arm the
  // retire-short-term daemon-free on the self-hosted host (no PM2/admin) the
  // moment QuantTrader confirms the $0 closes are dead weight vs a fixable bug.
  'ENABLE_OPTION_MULTILEG_PAUSE',
  // TRA-1409 (parent TRA-1406 "less noise, more quality") — the RV single_leg
  // exit re-tune: require a confirmed N-bar Supertrend flip (QuantTrader variant
  // (a), N=2 — TRA-1415) before the structural `supertrend_flip` exit fires, so
  // RV winners survive to the ma20_close_through cross instead of being chopped
  // to breakeven by single-bar whipsaws. STANDALONE flag (not under the
  // EXIT_RISK_RULES master), consulted ONLY on the demo RV exit branch — it can
  // never alter a live option exit and only ever makes the structural flip fire
  // LESS (risk-side chandelier/give-back/hard-SL keep precedence). The
  // RV_EXIT_RETUNE_CONFIRM_BARS numeric override tunes N (default 2). Non-secret,
  // demo-only — safe for the file override so the board can arm it daemon-free on
  // the self-hosted host after QuantTrader forward-validates (no PM2/admin).
  'RV_EXIT_RETUNE_ENABLED',
  'RV_EXIT_RETUNE_CONFIRM_BARS',
  // TRA-1480 (v2) — winner-protect loss threshold for the RV supertrend_flip
  // exit. Consulted ONLY inside the demo RV branch that already requires
  // RV_EXIT_RETUNE_ENABLED, so it can never touch a live exit. Non-secret,
  // demo-only — allowlisted so the board can arm/re-tune/revert daemon-free on
  // the self-hosted host (bqb1 arms via render.yaml + push).
  'RV_EXIT_FLIP_MIN_LOSS_PCT',
  // TRA-1418 (TRA-1417 build, parent TRA-1406 / TRA-1410 option a) — the DURABLE
  // fix for the 100% $0-scratch combo closes: a per-tick combo net mark + the
  // QuantTrader defined-risk exit policy (TP at 50% of max profit, credit 2× /
  // debit 50% stop clamped to max loss, 21-DTE time-stop). STANDALONE flag (not
  // under the EXIT_RISK_RULES master), consulted ONLY on the demo combo exit
  // branch — hard-gated `mode === 'demo'`, so it can never manage a live combo.
  // Default OFF ⇒ combos keep the legacy skip; non-secret, demo-only — safe for
  // the file override so the board can arm it daemon-free (no PM2/admin) once
  // QuantTrader forward-validates the resolved WIN/LOSS distribution.
  'ENABLE_OPTION_MULTILEG_EXIT',
  // TRA-1435 (parent TRA-1434) — the give-back cap's minimum ARM floor: the
  // book-level give-back cap (Rule 3) currently arms at ANY positive peak, so a
  // +$7 peak that gives back ~$5 inside spread/noise latches a whole-session halt
  // — STRICTER than the sibling 0.5R session-stop. This SUB-flag (gated by the
  // EXIT_RISK_RULES master too) arms a floor: the cap only trips once the day's
  // peak reaches max($25, 0.5R of book equity). OFF preserves today's behavior
  // (caller passes a 0 arm floor). Non-secret, demo-safe — file override lets the
  // board arm it daemon-free (no PM2/admin) after QuantTrader forward-validates.
  'BOOK_GIVEBACK_ARM_FLOOR_ENABLED',
  // TRA-1476 (parent TRA-1471, defense-in-depth with TRA-1408) — the
  // liquidity/quality + per-name churn gate on the DEMO directional "ignition"
  // entry path (that path stacked a thin sub-$5 micro-cap 28× in one morning for
  // -$432.50). SUB-flag layered ON TOP of ENABLE_OPTION_DEMO_DIRECTIONAL — the
  // signal-engine consults it ONLY on the demo directional chokepoint
  // (`evaluateDemoDirectional`, hard-gated `mode === 'demo'`), so a file flip can
  // NEVER alter a live open. The three numeric knobs tune the floors/cap (defaults
  // 5 / 250000 / 3; QuantTrader's locked call is 10 / 300000 / 2). Non-secret,
  // demo-only — allowlisted so the board can re-tune/revert daemon-free on the
  // self-hosted host without a redeploy (bqb1 arms via render.yaml + push).
  'ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE',
  'OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE',
  'OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME',
  'OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME',
] as const;

export const DEMO_FLAGS_FILENAME = 'demo-flags.json';

/**
 * TRA-1481 — board-ratified DEMO brakes that MUST be armed on the demo book but go
 * DARK on bqb1/Render because the Render *blueprint env-sync is OFF*: a code
 * autoDeploy ships new code but does NOT re-sync env from render.yaml (TRA-1289), so
 * a `value` added to render.yaml AFTER the last manual blueprint sync never reaches
 * the running process. `GET /api/health/churn-brake` proved this — `armed:false` on
 * `d91b59a` despite render.yaml declaring `ENABLE_CHURN_LOSS_BRAKE: "1"` since
 * `1e55e5c`, and the Render key needed for a blueprint sync is blocked (TRA-969).
 *
 * Each entry is a flag the board ALREADY RATIFIED `=1` in render.yaml for the demo
 * book, whose value is that ratified arm. {@link renderRatifiedDemoDefaults} seeds
 * these into the boot env ON RENDER ONLY, and only when the flag is set by NEITHER
 * process.env NOR the demo-flags.json file — so the ratified arm self-heals across
 * the env-sync gap and every redeploy, while an explicit operator/board value (env,
 * or a demo-flags.json write via `/api/admin/demo-flags` — including a deliberate
 * `=0` disarm, which wins because the file layers OVER env) is ALWAYS preserved. The
 * flags' own defaults stay OFF (their unit contracts are untouched); this only
 * re-delivers a render.yaml value the blueprint sync failed to apply.
 *
 * STRICT admission for an entry: (1) board-ratified `=1` in render.yaml, (2)
 * demo-only / structurally incapable of touching live capital, (3) pure
 * risk-reducing. Remove an entry the moment the board de-ratifies the flag.
 */
export const RENDER_RATIFIED_DEMO_DEFAULTS: Readonly<Record<string, string>> = {
  // TRA-1408 / TRA-1481 — per-name churn + same-day-loss brake. render.yaml `=1`
  // since `1e55e5c`; consulted ONLY on the demo branches (churnOpenCapVerdict bails
  // on `mode==='live'`; the DCA-halt branches are demo-only), so it can never alter
  // a live open or add. Board-ratified demo arm.
  ENABLE_CHURN_LOSS_BRAKE: '1',
  // TRA-1493 (parent TRA-1476/TRA-1486) — the demo directional liquidity/quality +
  // per-name churn gate. render.yaml ratified `ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE:"1"`
  // + the 10 / 300000 / 2 thresholds (QuantTrader's locked TRA-1476 call), but they
  // were added AFTER the last manual blueprint sync so they stayed DARK on the
  // e32727a autoDeploy (`/api/health/directional-quality-gate` → armed:false,
  // maxOpensPerName:3 = the code default) — the exact TRA-1289 env-sync gap the churn
  // brake hit. DEMO-only by construction: the gate is inert unless the demo
  // directional path (ENABLE_OPTION_DEMO_DIRECTIONAL, already synced) is itself on,
  // and the signal-engine consults it ONLY on the demo chokepoint (`mode==='demo'`,
  // never mirrored to Tradier), so seeding it can NEVER touch a live open — it only
  // ever makes the demo directional path open LESS. Pure risk-reducing: each seeded
  // value is STRICTER than the code default (price 10>5, $-vol 300k>250k, cap 2<3).
  // Seeding the numeric thresholds alongside the flag makes the RUNNING gate match
  // render.yaml exactly (esp. the max-2/name/ET-day the TRA-1492 accept criteria
  // require) and self-heal every redeploy. Board-ratified demo arm.
  ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '1',
  OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: '10',
  OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '300000',
  OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '2',
};

/**
 * TRA-1481 — resolve which {@link RENDER_RATIFIED_DEMO_DEFAULTS} entries should be
 * seeded into the boot env. Returns entries ONLY when running on Render
 * (`env.RENDER` set — render.yaml is the source of truth there; the self-host, which
 * has no blueprint, is never touched) AND the flag is absent from BOTH `env` and the
 * existing `<dataDir>/demo-flags.json`, so an explicit value from either source is
 * never overridden. The caller applies the result to `process.env` at boot. Pure
 * (no side effects) so it is unit-testable with a fake env.
 */
export function renderRatifiedDemoDefaults(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!env.RENDER) return {}; // Render-only: render.yaml governs env there
  const file = loadDemoFlagFile(dataDir);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(RENDER_RATIFIED_DEMO_DEFAULTS)) {
    const inEnv = typeof env[key] === 'string' && env[key]!.trim() !== '';
    const inFile = Object.prototype.hasOwnProperty.call(file, key);
    if (!inEnv && !inFile) out[key] = value;
  }
  return out;
}

/**
 * Read allowlisted demo flags from `<dataDir>/demo-flags.json`. Returns an empty
 * object when the file is absent or malformed — the default, zero-override path.
 * Values are coerced to strings so they slot straight into a `ProcessEnv`.
 */
export function loadDemoFlagFile(dataDir: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, DEMO_FLAGS_FILENAME), 'utf8');
  } catch {
    return {}; // absent file ⇒ no overrides
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // malformed JSON ⇒ ignore rather than crash the loop
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const key of DEMO_FLAG_ALLOWLIST) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = String(v);
  }
  return out;
}

/**
 * Effective env for demo-loop flag resolution: `baseEnv` (process.env by
 * default) with allowlisted `demo-flags.json` values layered on top. The FILE
 * WINS so an operator's local override is authoritative — it is the only
 * writable switch a non-admin agent has on this host. Pass the result to
 * `isAutonomousDemoLoopEnabled` / `getAutonomousDemoStatus` / the schedule.
 */
export function resolveDemoFlagEnv(
  dataDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const file = loadDemoFlagFile(dataDir);
  if (Object.keys(file).length === 0) return baseEnv;
  return { ...baseEnv, ...file };
}

/**
 * Result of a {@link writeDemoFlagFile} call: the resulting on-disk map plus a
 * per-key disposition so the caller can audit-log exactly what changed.
 */
export interface WriteDemoFlagResult {
  /** The full demo-flags.json map after the merge (allowlisted keys only). */
  flags: Record<string, string>;
  /** Keys set/updated to a value. */
  applied: string[];
  /** Keys removed (revert to process.env / code default). */
  removed: string[];
  /** Keys ignored because they are NOT on the allowlist (never written). */
  rejected: string[];
}

/**
 * TRA-1481 — merge `updates` into `<dataDir>/demo-flags.json` and write it back,
 * so a NON-secret DEMO flag can be armed on a RUNNING service that has no shell
 * and no PM2/blueprint access (the bqb1/Render gap: render.yaml env additions
 * stay DARK until a MANUAL Render blueprint sync, which a non-admin agent cannot
 * trigger — while a code autoDeploy does NOT re-sync env). This is the HTTP-side
 * mirror of the file the self-hosted operator edits by hand.
 *
 * Read-merge-write: keys the caller does not mention are preserved. A key whose
 * value is `null` is REMOVED (so a flag can be reverted to its env/default). The
 * merge is STRICTLY allowlist-bounded — a non-allowlisted key (any secret, any
 * non-demo setting) is IGNORED and returned in `rejected`, never written — so
 * this path is structurally incapable of injecting a secret or touching a live
 * setting. Values are coerced to strings so the file round-trips through
 * {@link loadDemoFlagFile}. Throws only when `dataDir` is unwritable.
 */
export function writeDemoFlagFile(
  dataDir: string,
  updates: Record<string, string | number | boolean | null>,
): WriteDemoFlagResult {
  const allow = new Set<string>(DEMO_FLAG_ALLOWLIST);
  const next: Record<string, string> = { ...loadDemoFlagFile(dataDir) };
  const applied: string[] = [];
  const removed: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!allow.has(key)) {
      rejected.push(key); // secret / non-demo key — never touch the file for it
      continue;
    }
    if (value === null) {
      delete next[key];
      removed.push(key);
      continue;
    }
    next[key] = String(value);
    applied.push(key);
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, DEMO_FLAGS_FILENAME), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { flags: next, applied, removed, rejected };
}
