// TRA-2336 — the carrier that must be POSITIVELY set before a boot can arm LIVE
// (real-money) Coinbase crypto auto-trading for the pinned operator.
//
// WHY THIS EXISTS. `shouldBootArmLiveCrypto` (TRA-1340) had three conditions:
// operator pin, `mode === 'live'`, and resolvable Coinbase creds. Two of them are
// permanently satisfied on bqb1 (the pin is `admin`; the operator carries per-user
// Coinbase keys), so `mode` was the whole interlock — and `mode` is not an
// independent variable. `createUserContext` runs the TRA-713/1411/1482/1652 EQUITY
// boot-arm immediately above the crypto one, on the SAME `settings` object, and
// that block FORCE-PERSISTS `settings.mode = 'live'` whenever
// `TRADIER_ENV === 'production'`. The crypto arm's own doc comment says as much:
// "Runs AFTER the equity boot-arm so `settings.mode` is already `live`".
//
// Net effect before this flag: setting `TRADIER_ENV=production` — the single
// ratified go-live arming step, deferred under TRA-2163 and owned by TRA-1648 —
// also armed live crypto auto-trading, in the same boot, with no crypto decision
// taken by anyone. Go-live week was ratified **Options + Stock, crypto OFF**
// (TRA-1575), and TRA-314 says keep live crypto off. The TRA-1340 grant
// (interaction `4caaa410`) predates both and was still executing as written.
//
// WHY IT IS ITS OWN FLAG AND NOT `CRYPTO_ENGINE_ENABLED`. Reusing that one looks
// tidy and is the trap: TRA-1580 documents `CRYPTO_ENGINE_ENABLED=1` as the
// no-code-change way to re-enable the crypto *data* engine post-launch. Hanging a
// real-money arm off it would convert an engine switch into a funding switch —
// the operator who flips it to get crypto charts back would arm live trading and
// have no reason to expect it. Two hazards, two names:
//
//   CRYPTO_ENGINE_ENABLED=1  → the crypto signal engine ticks (data sweep). No real money.
//   LIVE_CRYPTO_BOOT_ARM=1   → a boot may arm REAL-MONEY live crypto auto-trading.
//
// DEFAULT OFF, and the default is COMPILED — an absent key disarms, exactly like
// the crypto engine flag. This flag does not disable live crypto; it only removes
// the *automatic* arm. The deliberate paths are unchanged and still gated by the
// TRA-532 promotion gate: `POST /api/crypto/trading/start` (mode=live) and an
// admin-authenticated `PUT /api/account/settings`.

export const LIVE_CRYPTO_BOOT_ARM_FLAG = 'LIVE_CRYPTO_BOOT_ARM';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff a boot is permitted to arm LIVE Coinbase crypto auto-trading for the
 * pinned operator (accepts 1/true/yes/on). OFF by default, so no equity-side
 * arming step can chain into a crypto arm.
 */
export function isLiveCryptoBootArmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[LIVE_CRYPTO_BOOT_ARM_FLAG]);
}
