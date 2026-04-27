/**
 * Stooq fallback feed for stock quotes.
 *
 * Stooq exposes a free, key-less CSV endpoint that returns the last OHLCV
 * print for a symbol. We use it as a backstop for `yahoo-feed.fetchQuote`
 * so that the EOD report and watchlist can still surface non-zero prices
 * when Yahoo Finance fails or rate-limits us (TRA-136).
 *
 * Stooq data is delayed ~15 minutes and the CSV does not include the
 * previous close, so we approximate `change` / `changePct` from the
 * intraday open. This is degraded but usable for top-mover ranking.
 */
export interface QuoteData {
  price: number;
  volume: number;
  change: number;
  changePct: number;
}

const STOOQ_CALL_TIMEOUT_MS = 6_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Map a Yahoo-style symbol to Stooq's URL-encoded form.
 * Stooq uses lower-case + market suffix (`.us` for US equities & ETFs).
 * Class shares like `BRK.B` become `brk-b.us`; existing dashes are preserved.
 */
export function toStooqSymbol(symbol: string): string {
  return symbol.toLowerCase().replace(/\./g, '-') + '.us';
}

/**
 * Parse a single Stooq quote CSV body.
 *
 * Returns null when the row is the "N/D" sentinel that Stooq uses for
 * unknown symbols, or when fields are missing/non-numeric.
 *
 * Expected header: `Symbol,Date,Time,Open,High,Low,Close,Volume`
 */
export function parseStooqCsv(csv: string): QuoteData | null {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  if (cols.length < 8) return null;
  const [, , , openStr, , , closeStr, volumeStr] = cols;
  if (openStr === 'N/D' || closeStr === 'N/D') return null;
  const open = Number(openStr);
  const close = Number(closeStr);
  const volume = Number(volumeStr);
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) return null;
  const change = close - open;
  const changePct = (change / open) * 100;
  return {
    price: close,
    volume: Number.isFinite(volume) ? volume : 0,
    change,
    changePct,
  };
}

/** Fetch a single quote from Stooq. Returns null on any failure. */
export async function fetchStooqQuote(symbol: string): Promise<QuoteData | null> {
  const stooqSym = toStooqSymbol(symbol);
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
  try {
    const resp = await withTimeout(fetch(url), STOOQ_CALL_TIMEOUT_MS, `stooq(${symbol})`);
    if (!resp.ok) {
      console.warn(`[stooq-feed] ${symbol}: HTTP ${resp.status}`);
      return null;
    }
    const csv = await resp.text();
    const parsed = parseStooqCsv(csv);
    if (!parsed) {
      console.warn(`[stooq-feed] ${symbol}: unparseable CSV (likely unknown symbol)`);
    }
    return parsed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[stooq-feed] ${symbol} failed: ${msg}`);
    return null;
  }
}
