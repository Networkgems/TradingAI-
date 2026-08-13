// TRA-3390 (impl child of TRA-2628) — the quote-currency vocabulary.
//
// ── The defect this exists to kill ───────────────────────────────────────────
// The 2026-07-28 EOD report printed
//
//     | 000660.KS | $1,550,000.00 | -14.65% |
//
// for a KRW quote. Sixteen of the 670 live universe rows carry a foreign-exchange
// suffix, every renderer prefixed `$`, and nothing anywhere in the tree carried
// the currency the number was actually denominated in.
//
// ── The two rules, and why they are rules and not defaults ───────────────────
//
// 1. **THE CURRENCY COMES FROM THE ADAPTER'S RESPONSE, NEVER FROM THE TICKER.**
//    A suffix table is the same class of error as the bug. `AZN.L` does not
//    return GBP — it returns **GBp / GBX, pence** — so a `.L → GBP` table is
//    wrong by 100x on a real live row. The exemplars measured on 2026-08-12
//    (build eb1dcf0c8a6f, pid 73) are the fixtures below.
//
// 2. **UNKNOWN IS NOT USD.** A row whose adapter did not answer renders with NO
//    symbol at all. Defaulting the absent case to USD reproduces the exact
//    defect for every row the adapter was silent on, and does it silently —
//    which is strictly worse than the loud version that got filed.
//
// The formatter here is deliberately NOT `Intl.NumberFormat(..., {style:'currency'})`:
// `Intl` has no notion of GBp/GBX (it would render `GBX` as an unknown code or
// throw), and its per-currency default fraction digits would quietly re-round a
// KRW level. We want the number VERBATIM with an unambiguous unit beside it.

/**
 * A quote currency as this codebase carries it: an ISO-4217 code (`USD`, `KRW`,
 * `EUR`, `TWD`, `DKK`, `SEK`) **or** the pseudo-code `GBX` for the London pence
 * quotation. Always the output of {@link normalizeQuoteCurrency}; never a raw
 * adapter string.
 */
export type QuoteCurrency = string;

/** The pence pseudo-code. Yahoo emits `GBp`; LSE convention also writes `GBX`. */
export const PENCE_CURRENCY = 'GBX';

/**
 * Canonicalize a currency string as an adapter reported it.
 *
 * ⚠️ **THE `GBp` / `GBP` DISTINCTION IS CASE-SENSITIVE AND LOAD-BEARING.** Yahoo
 * returns the literal string `GBp` (lowercase `p`) for London listings quoted in
 * **pence**, and `GBP` (uppercase) for the rare listing quoted in **pounds**.
 * They differ by a factor of 100. A naive `.toUpperCase()` collapses them and
 * re-introduces the 100x error this module exists to prevent, so the pence test
 * runs BEFORE any case folding and matches only the exact `GBp` spelling (plus
 * `GBX`/`GBx`, which is unambiguous in any case).
 *
 * Returns `undefined` for anything that is not a recognizable code — absent,
 * empty, non-string, or not three letters. `undefined` means "unknown", and
 * every consumer must treat unknown as "print no symbol" / "refuse to size",
 * never as USD.
 */
export function normalizeQuoteCurrency(raw: unknown): QuoteCurrency | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Pence FIRST, and case-sensitively on the `GBp` spelling. See the warning above.
  if (trimmed === 'GBp' || trimmed === 'GBX' || trimmed === 'GBx') return PENCE_CURRENCY;
  if (!/^[A-Za-z]{3}$/.test(trimmed)) return undefined;
  return trimmed.toUpperCase();
}

/** True only for the code that the USD book is actually denominated in. */
export function isUsdQuote(currency: QuoteCurrency | undefined): boolean {
  return currency === 'USD';
}

/**
 * Group a bare number the way every existing renderer already does
 * (`en-US`, fixed 2dp by default) so this change moves the UNIT, not the digits.
 */
function groupedNumber(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Render a **per-symbol market level** (a quote price, a signal entry/stop/target)
 * with the unit it is actually denominated in.
 *
 *   - `USD`      → `$1,234.56`      (unchanged from every pre-TRA-3390 renderer)
 *   - `KRW`      → `255,500.00 KRW`
 *   - `GBX`      → `11,714.00 GBX`  (pence — NOT converted to pounds)
 *   - unknown    → `1,234.56`       (bare, NO symbol — rule 2 above)
 *   - non-finite → `—`
 *
 * Non-USD codes are rendered as a trailing ISO code rather than a locale symbol
 * on purpose: `₩`/`kr` are ambiguous across markets (DKK, SEK and NOK all print
 * `kr`), and the whole point of the ticket is that the reader must be able to
 * tell which market a level belongs to.
 *
 * Currency conversion is explicitly NOT performed here. A converted number is a
 * different datum with its own FX-rate provenance; this renders the quote as
 * quoted.
 */
export function formatQuoteLevel(
  value: number | null | undefined,
  currency: QuoteCurrency | undefined,
  opts?: { decimals?: number; signed?: boolean },
): string {
  const decimals = opts?.decimals ?? 2;
  if (value == null || !Number.isFinite(value) || Math.abs(value) >= 1e15) return '—';
  const signed = opts?.signed === true;
  const sign = signed ? (value >= 0 ? '+' : '-') : value < 0 ? '-' : '';
  const magnitude = groupedNumber(Math.abs(value), decimals);
  if (isUsdQuote(currency)) return `${sign}$${magnitude}`;
  if (currency === undefined) return `${sign}${magnitude}`;
  return `${sign}${magnitude} ${currency}`;
}

/**
 * TRA-3390 AC4 — **may this symbol produce a sizeable entry against the book?**
 *
 * ── The decision, encoded ────────────────────────────────────────────────────
 * **NO.** A non-USD-quoted instrument may not open a position, in either mode.
 *
 * The books (`stockLongValue`, `totalEquity`, `availableCash`, every risk
 * denominator computed off them) are USD scalars with no FX layer anywhere in
 * the tree. Sizing a EUR entry against them does not produce a mislabelled
 * number — it produces a **wrong book total**, and every downstream risk gate
 * that divides by equity then grades against a number that is wrong by the FX
 * rate. That is strictly worse than the rendering defect this ticket was filed
 * on, and it is the half that gets forgotten if only the `$` is fixed.
 *
 * This is a refusal, not a conversion. Admitting foreign listings requires an
 * FX-rate source with its own provenance and staleness policy, per-currency
 * exposure accounting, and a decision about which currency the risk budget is
 * denominated in. That is a separate piece of work, not a line in a guard.
 *
 * Today's containment is unrelated and incidental: the one live foreign `buy`
 * (`ENR.DE`, EUR, `mode: "live"`) is held only by
 * `display-only: sma200_pullback is not registered in the TRA-817 capital-gate
 * manifest`, which disappears the moment a *registered* strategy fires on one of
 * the 16 foreign rows. This guard is the one that is actually about currency.
 *
 * ── Why the unknown case refuses too, and why the suffix appears here ────────
 * `unknown` is refused, but only when the symbol *also* carries a foreign-listing
 * suffix. That split keeps two properties at once:
 *
 *   - It cannot mislabel a value. The suffix is used ONLY to decide whether to
 *     REFUSE — never to assert what currency a number is in. Rule 1 forbids the
 *     latter because a wrong guess prints a wrong number; a wrong guess here can
 *     only decline to trade a symbol, which is recoverable and loud.
 *   - It does not take the book dark. Plain US tickers served by a source that
 *     carries no currency at all (Stooq) keep behaving exactly as they do today.
 *
 * @returns `allowed: true` with no reason, or `allowed: false` with a reason
 *          string suitable for `signal.signalSkipReason`.
 */
export function quoteCurrencySizingVerdict(input: {
  symbol: string;
  currency: QuoteCurrency | undefined;
}): { allowed: true } | { allowed: false; reason: string } {
  const currency = input.currency;
  if (isUsdQuote(currency)) return { allowed: true };
  if (currency !== undefined) {
    return {
      allowed: false,
      reason:
        `non-USD quote currency (${currency}): the book is a USD scalar with no FX layer, `
        + `so sizing this entry would put a foreign notional into stockLongValue/totalEquity (TRA-3390 AC4)`,
    };
  }
  if (hasForeignListingSuffix(input.symbol)) {
    return {
      allowed: false,
      reason:
        `unknown quote currency on a foreign-suffixed listing (${input.symbol}): refusing to size rather than `
        + `assume USD (TRA-3390 AC4)`,
    };
  }
  return { allowed: true };
}

/**
 * Does this ticker carry an exchange suffix that marks it as a non-US listing?
 *
 * ⚠️ **REFUSAL INPUT ONLY.** This must never be used to decide what currency a
 * number is in — see the `GBp` note at the top of the file, and
 * {@link quoteCurrencySizingVerdict} for why the asymmetry is safe in this one
 * direction. It is deliberately unexported-by-intent (exported only so the
 * two-directional AC5 controls can grade it directly).
 *
 * ANY dot suffix matches, including single letters, and that is deliberate.
 * `AZN.L` (London) and `BRK.B` (a US class share) are both a root plus one
 * letter, so no suffix-length rule can separate them — and getting `.L` wrong is
 * precisely the failure mode the ticket names. Rather than build the table that
 * gets it wrong, this over-refuses: a `BRK.B` row whose adapter reported no
 * currency at all is declined. That costs nothing in practice (Tradier answers
 * for US class shares, so they carry `USD` and never reach this branch) and the
 * error direction is a refusal, which is loud and recoverable.
 *
 * `-USD` crypto pairs (`BTC-USD`) use a hyphen, not a dot, so they do not match.
 */
export function hasForeignListingSuffix(symbol: string): boolean {
  if (typeof symbol !== 'string') return false;
  return /^[A-Z0-9]{1,8}\.[A-Z]{1,4}$/.test(symbol.trim().toUpperCase());
}
