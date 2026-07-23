// TRA-2163 (P0 credential leak) — `TRADIER_ENV` is meant to hold a secrets-free
// env LABEL (`production` | `sandbox`). No-auth `/api/health/*` surfaces echo it
// back so ops can confirm routing (`serviceTradierEnv`, `bootEnv.TRADIER_ENV`).
// If the Render var is ever mis-set to the *token* value (as happened on bqb1),
// echoing the raw string publishes a live brokerage credential on a public
// endpoint. These helpers are the single choke point: emit the value ONLY when
// it is a recognized label, and otherwise a fixed redaction marker — so a
// mis-set value can never leak, while `isRecognizedTradierEnvLabel` still lets
// diagnostics flag the misconfiguration.

const RECOGNIZED_TRADIER_ENV_LABELS = new Set(['production', 'sandbox']);

/** True only when `raw` (trimmed) is a known `TRADIER_ENV` label. */
export function isRecognizedTradierEnvLabel(raw: string | undefined): boolean {
  return RECOGNIZED_TRADIER_ENV_LABELS.has((raw ?? '').trim());
}

/**
 * Safe-to-publish rendering of a `TRADIER_ENV` value for no-auth diagnostics.
 * Returns `null` when unset/empty, the literal label when recognized, and a
 * fixed redaction marker for anything else (never the raw value).
 */
export function redactTradierEnvLabel(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (v.length === 0) return null;
  return isRecognizedTradierEnvLabel(v) ? v : '<redacted:unrecognized-value>';
}
