// TRA-419 — pure string/number utilities extracted from App.tsx.
// No JSX or React imports allowed in this file.
import { isMoveSuspect, formatQuoteLevel, type QuoteMoveRow } from '@trading-app/shared';

// TRA-318 follow-up: defend against null/undefined/NaN/non-finite numeric
// fields arriving from the API (e.g. `Number.POSITIVE_INFINITY` reconciled
// from a broker holding gets serialized to `null` over the wire).
// Without this guard the formatters threw and crashed the Positions tab to
// a white screen.
export function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtDollar(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  // TRA-424 — negative deltas dropped their sign: `Math.abs(n)` strips it and
  // the negative branch prepended '' instead of '-', so a −$0.19 change
  // rendered as "$0.19" (red, but no minus). The explicit '-' is required
  // here because fmt() receives Math.abs(n) and never sees the sign.
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${fmt(Math.abs(n))}`;
}

export function fmtPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${fmt(n, 2)}%`;
}

// TRA-372 — compact signed-integer percent for the signal-card Target/Stop
// chips: "+50%" / "−25%" (proper U+2212 minus). Returns '—' on sentinel input.
export function fmtSignedIntPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (rounded === 0) return '0%';
  return rounded > 0 ? `+${rounded}%` : `−${Math.abs(rounded)}%`;
}

// Dollar-prefixed price for un-signed columns (entry, stop, target, cost).
// Returns "—" alone (no leading "$") when the value is missing/sentinel.
export function fmtPrice(n: number | null | undefined, decimals = 2) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  return `$${fmt(n, decimals)}`;
}

/**
 * TRA-3390 (impl child of TRA-2628) — a **per-symbol market level** (quote price,
 * signal entry/stop/target) rendered in the currency it is actually quoted in.
 *
 * ── When to use this instead of `fmtPrice` / `fmtDollar` ─────────────────────
 * Use it whenever the number is a price OF A SYMBOL. `fmtPrice`/`fmtDollar` stay
 * correct — and stay in use — for BOOK quantities: P&L, equity, cash, position
 * notionals. Those are USD by construction and are kept that way by the AC4
 * entry guard, which refuses to open a position on a non-USD-quoted instrument,
 * so no foreign notional can enter the book in the first place.
 *
 * Delegates to the shared `formatQuoteLevel` so the desktop and the server EOD
 * report cannot drift on the same row. `undefined` currency renders bare — the
 * absent case is UNKNOWN, never USD.
 */
export function fmtQuoteLevel(
  n: number | null | undefined,
  currency: string | undefined,
  opts?: { decimals?: number; signed?: boolean },
) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  return formatQuoteLevel(n, currency, opts);
}

export function timeAgo(ts: number) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

/**
 * Human-readable label for the watchlist "Updated" column. Surfaces upstream
 * provider state so a rate-limited or down quote source shows actionable text
 * instead of a perpetual "Loading…" spinner.
 */
export function quoteStatusLabel(s: QuoteRow, moveUnreliable: boolean = isQuoteMoveUnreliable(s)): string {
  // TRA-2610 — freshness and plausibility are two facts and this cell has to be
  // able to say BOTH. Previously `'suspect'` and `'unavailable'` were values of one
  // field, so the label could only ever report whichever write landed last — and on
  // FGMC that was "Quote unavailable", with no hint that the +110.66% beside it was
  // fabricated. Compose instead: freshness inside the parens, the move verdict in
  // front of it.
  const freshness = (): string => {
    if (s.quoteStatus === 'rate_limited') return 'Quote unavailable — provider rate-limited';
    if (s.quoteStatus === 'unavailable') return 'Quote unavailable';
    // TRA-418 — `'stale'` marks a quote that aged past the freshness threshold
    // (feed down). Surface it distinctly from a healthy "x ago" timestamp.
    if (s.quoteStatus === 'stale') return 'Quote stale — feed delayed';
    if (s.lastUpdated === 0) return 'Loading…';
    return timeAgo(s.lastUpdated);
  };
  // TRA-2379/TRA-2610 — the published session move is not believable. Name that
  // first, so nobody reads a fabricated move as merely a delayed feed. The caller
  // may pass the verdict explicitly so the badge and the label can never
  // disagree with each other on the same row.
  if (moveUnreliable) return `Change % unreliable — bad prev close (${freshness()})`;
  return freshness();
}

export type QuoteStatus = 'ok' | 'rate_limited' | 'unavailable' | 'stale';

/** The row fields the two quote-status helpers read. */
type QuoteRow = { lastUpdated: number; quoteStatus?: QuoteStatus } & QuoteMoveRow;

/**
 * TRA-2379 — true when this row's session move is implausible.
 *
 * The raw `change` / `changePct` are still present on the row (decision 1: flag,
 * never clamp); callers use this to render them degraded and to keep them out of
 * a CHANGE % sort, rather than to hide them.
 *
 * TRA-2610 — delegates to the shared `isMoveSuspect`, which reads the dedicated
 * `moveSuspect` field AND re-executes the plausibility rule on the numbers the row
 * publishes. It used to test `quoteStatus === 'suspect'`, which a later failed fetch
 * erased — so the UI stopped badging exactly the thin, badly-quoted rows most likely
 * to be fabricated.
 *
 * TRA-3243 — WHICH PROPOSITION THIS CONSUMER NEEDS: **P-session**, via the shared
 * `isMoveSuspect`. The badge and the CHANGE % sort resolver are both verdicts on the
 * DENOMINATOR (`impliedPrevClose`), and a numerator that mean-reverts back under the
 * ratio bar re-derives nothing about the denominator — so P-now would make the badge
 * blink off mid-session on an unchanged suspect prev close (WXM 08-11: badged at
 * +106.78%, unbadged at +98.38%, same session, same implied prev). Use
 * `isMoveSuspectNow` only where the question really is "is the move implausible at
 * this instant"; no UI surface asks that.
 */
export function isQuoteMoveUnreliable(s: QuoteMoveRow): boolean {
  return isMoveSuspect(s);
}

export function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// TRA-372 — parse a YYYY-MM-DD option-expiration string as a local-date
// (avoids the UTC interpretation new Date('2026-05-29') would give and the
// off-by-one display on Pacific timezones).
export function parseExpirationDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// TRA-372 — "May 29, 2026" for the signal card. Returns '' if unparseable so
// the caller can short-circuit rendering.
export function formatExpirationFull(iso: string | undefined | null): string {
  const d = parseExpirationDate(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// TRA-372 — compact "May 29" (or "May 29, 2027" off-year) for the table cell.
export function formatExpirationShort(iso: string | undefined | null): string {
  const d = parseExpirationDate(iso);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

// TRA-372 — integer days from a reference timestamp to a yyyy-mm-dd expiration.
// Floors to the calendar-day boundary so "fires at 3pm, expires same day" reads
// as 0d, not −0d.
export function daysToExpiration(iso: string | undefined | null, fromTs: number): number | null {
  const exp = parseExpirationDate(iso);
  if (!exp) return null;
  const from = new Date(fromTs);
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const ms = exp.getTime() - fromDay.getTime();
  return Math.round(ms / 86_400_000);
}

export function signalLabel(type: string) {
  switch (type) {
    case 'orb_breakout': return 'ORB';
    case 'reversal': return 'Reversal';
    case 'macd_cross': return 'MACD';      // legacy positions still on disk
    case 'macd_trend': return 'MACD Trend';
    case 'bb_fade': return 'BB Fade';
    case 'ichimoku': return 'Ichimoku';
    case 'scalping': return 'Scalping';
    case 'swing_trade': return 'Swing';
    case 'dca': return 'DCA';
    case 'relative_value': return 'Relative Value';
    case 'otm_mispricing': return 'OTM Mispricing';
    case 'tradier_import': return 'Tradier Import';
    case 'sma200_pullback': return 'Pullback → 200';
    case 'sma200_reclaim': return '200-SMA Reclaim';
    default: return type;
  }
}

export function exitReasonLabel(reason?: string) {
  switch (reason) {
    case 'stop': return 'Stop';
    case 'target': return 'Target';
    case 'time_stop': return 'Time';
    case 'trailing': return 'Trail';
    case 'rsi_alt_exit': return 'RSI exit';
    case 'tsmom_band_exit': return 'Momentum exit'; // TRA-821 — tsmom_majors long-or-flat band exit
    default: return reason ?? '—';
  }
}

export function researchKindLabel(kind?: string) {
  switch (kind) {
    case 'premarket': return 'Pre-Market';
    case 'postmarket': return 'Post-Market';
    case 'weekly_review': return 'Weekly Review';
    default: return null;
  }
}

/**
 * TRA-227 — minimal markdown→HTML renderer for the QuantTrader research-body
 * surface. Handles the syntax the routine actually produces: ATX headings,
 * blockquotes, ordered/unordered lists, paragraphs, and inline `**bold**`
 * `*italic*` `` `code` `` and `[text](url)` links. HTML entities are escaped
 * BEFORE markdown transforms apply so any user-influenced content can't inject
 * raw HTML; only the markdown-derived tags reach the DOM. Anchor URLs are
 * scheme-validated (http/https/relative) so a malicious `javascript:` link in
 * a payload can't ride into an `href`.
 *
 * Kept inline rather than pulling react-markdown / marked because the surface
 * is small and the risk of bringing a sizable parser into the desktop bundle
 * outweighs the savings.
 */
export function renderResearchMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const inline = (s: string): string => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
      const safe = /^(https?:\/\/|\/)/i.test(href) ? href : '#';
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

  // Re-decode `&gt;` at line start so blockquote/heading parsers see the
  // original markdown markers without re-introducing HTML elsewhere.
  const lines = escaped.replace(/^&gt;/gm, '>').split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
  const isBlockquote = (l: string) => /^>\s?/.test(l);
  const isUnordered = (l: string) => /^[-*]\s+/.test(l);
  const isOrdered = (l: string) => /^\d+\.\s+/.test(l);
  const isBlockStart = (l: string) =>
    isHeading(l) || isBlockquote(l) || isUnordered(l) || isOrdered(l);

  while (i < lines.length) {
    const line = lines[i];

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++; continue;
    }

    if (isBlockquote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    if (isUnordered(line)) {
      const buf: string[] = [];
      while (i < lines.length && isUnordered(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }

    if (isOrdered(line)) {
      const buf: string[] = [];
      while (i < lines.length && isOrdered(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('');
}
