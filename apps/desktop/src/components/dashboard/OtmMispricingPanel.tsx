// TRA-161 — "Mispriced OTM" panel. Read-only surface over the OTM mispricing
// scanner: for one symbol's auto-picked in-window expiration, the contracts
// whose mark diverges most from the Black-Scholes theo built on the market's
// own vol surface.
//
// DATA CONTRACT
//   GET /api/options/otm-mispricing?symbol=&limit=&minMispricing=&minDelta=
//        -> OtmMispricingScanResponse   (requireAuth)
//   GET /api/health/options-mispricing  -> ScannerDiagnostics   (unauthenticated)
//
// HISTORY WORTH KNOWING: the scan route in this ticket's description shipped
// with TRA-158, was deleted by TRA-191 (which swapped in the relative-value
// scanner), and was restored for THIS panel over the surviving `scanOtm()`
// engine path. The health route kept its name throughout — it reports the
// shared Tradier scanner's diagnostics, which is exactly what this panel needs
// (same client, same breaker, same chain cache).
//
// STRICTLY INFORMATIONAL. There is no order-entry control here and there must
// not be one until TRA-159 lands — the ticket is explicit about that, and the
// server route has no entry path to call anyway.
//
// House pattern: the contract types are mirrored locally (as in HealthPanel /
// AiOptionsIdeasPanel / VersionChip) rather than imported from
// @trading-app/shared, which does not carry the scanner shapes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { fmt, fmtPrice } from '../../lib/format';

// ── Contract ───────────────────────────────────────────────────────────────

/**
 * Why a scan produced no candidates. Mirrors the server's `OtmScanReason`.
 * `unavailable` is the pre-TRA-161 catch-all: a server that predates the
 * discriminated reasons still sends it, and it must render as "we don't know
 * why" rather than being silently mapped onto one of the specific causes.
 */
type ScanReason =
  | 'ok'
  | 'no_credentials'
  | 'breaker_open'
  | 'no_spot'
  | 'no_expirations'
  | 'no_chain'
  | 'fetch_error'
  | 'unavailable';

interface OtmCandidate {
  optionSymbol: string;
  underlying: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
  daysToExpiration: number;
  /** Mid of the two-sided book, per share. */
  mark: number;
  /** Black-Scholes price at the market's own σ (smvVol, else smoothed midIv). */
  theo: number;
  /**
   * (mark − theo) / theo. A RATIO, not a percent — 0.18 means 18%. Multiply for
   * display. Positive → the market is paying up vs. model (expensive);
   * negative → cheap.
   */
  mispricingPct: number;
  classification: 'expensive' | 'cheap' | 'fair';
  bid: number;
  ask: number;
  /** (ask − bid) / mark. Also a RATIO. */
  spreadPct: number;
  openInterest: number;
  volume: number;
  ivUsed: number;
  /** Sign-adjusted BS delta — negative for puts. */
  delta: number;
}

interface ScannerDiagnostics {
  configured: boolean;
  breakerOpen: boolean;
  breakerOpenedAtMs: number | null;
  cacheSize: number;
  expirationsCacheSize: number;
}

/**
 * TRA-2341 — what the server's denominator guard removed from this scan.
 *
 * Far OTM, Black-Scholes theo decays toward zero much faster than the market's
 * bid, which stays pinned near a penny by the minimum tick. `(mark − theo)/theo`
 * then reports the TICK SIZE, not a disagreement with the vol surface — live
 * SPY showed mark 0.095 over theo 0.000128 as +74215.7%, and because the
 * scanner ranks by |mispricingPct| those rows filled the entire default panel.
 * The route now drops candidates whose theo is below one tick BEFORE slicing to
 * the limit, and reports what it dropped here.
 *
 * OPTIONAL on purpose: a server build predating TRA-2341 omits the block
 * entirely, which is precisely how this panel can tell the guard is deployed
 * rather than assuming it. Absent ⇒ render nothing, never a fabricated zero.
 */
interface TheoFloorReport {
  /** The floor the server applied, in dollars. 0 ⇒ the guard was disabled. */
  applied: number;
  /** How many candidates it removed. */
  suppressed: number;
  /** Largest |mispricingPct| among the removed rows — a RATIO. Null if none. */
  maxSuppressedMispricingPct: number | null;
}

/**
 * TRA-2388 — what the server's |delta| floor removed from this scan.
 *
 * The TRA-2341 theo floor fixed the pathological end of the same problem but not
 * its shape: ranking by a RATIO always returns the far tail. Just above the theo
 * floor the model price is still a rounding error next to a bid pinned at the
 * minimum tick, so the ratio still measures the tick — live SPY still topped out
 * at 1510.9% with the theo floor deployed. `|delta|` is the axis that does not
 * degrade as theo shrinks, and the TRA-2354 decision set the panel floor at 0.02.
 *
 * Same shape and same OPTIONALITY rule as {@link TheoFloorReport}: a server build
 * predating TRA-2388 omits the block, which is how this panel can tell the floor
 * is deployed rather than assuming it. Absent ⇒ render nothing, never a
 * fabricated zero.
 *
 * `applied` is a |delta|, NOT a dollar amount — do not render it with `fmtPrice`.
 */
interface DeltaFloorReport {
  /** The |delta| floor the server applied. 0 ⇒ the guard was disabled. */
  applied: number;
  /**
   * How many candidates it removed — counted over the rows that already cleared
   * the theo floor, since the server applies the two in sequence. So this is not
   * a partition of the same population as `theoFloor.suppressed`.
   */
  suppressed: number;
  /** Largest |mispricingPct| among the removed rows — a RATIO. Null if none. */
  maxSuppressedMispricingPct: number | null;
}

interface OtmMispricingScanResponse {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  candidates: OtmCandidate[];
  reason?: ScanReason;
  errorMessage?: string;
  theoFloor?: TheoFloorReport;
  deltaFloor?: DeltaFloorReport;
  diagnostics?: ScannerDiagnostics;
}

// ── Tuning ─────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 20_000;
/**
 * The diagnostics chip polls; the SCAN does not. A scan is a Tradier chain
 * fetch behind a 60s cache, so an idle panel left open on a desk would burn
 * upstream budget on a symbol nobody is looking at. Scans are therefore driven
 * by an explicit user action (symbol change / Refresh) only. Diagnostics are a
 * pure in-process read with no upstream cost, so the breaker/credential chip
 * stays live on its own cadence — which matters, because "the breaker just
 * opened" is precisely the thing you want to see WITHOUT re-poking upstream.
 */
const DIAGNOSTICS_POLL_MS = 30_000;
const DEFAULT_LIMIT = 15;

/** Contracts whose |mispricing| clears this are labelled cheap/expensive. */
const MISPRICING_BANDS = [0.1, 0.15, 0.2, 0.3] as const;

// ── Empty-state copy ───────────────────────────────────────────────────────

/**
 * One friendly line per reason, so QA can read WHY a scan came back empty
 * straight off the panel instead of going to the server logs — the explicit
 * ask in TRA-161's notes. Keyed on the server's reason, never inferred from
 * "candidates.length === 0", because a healthy scan of a quiet chain is also
 * empty and must not read as a fault.
 */
const REASON_COPY: Record<Exclude<ScanReason, 'ok'>, { title: string; detail: string }> = {
  no_credentials: {
    title: 'Scanner not configured',
    detail:
      'No Tradier credentials on the server, so no option chain can be fetched. Set TRADIER_API_TOKEN and TRADIER_ACCOUNT_ID in the server environment and redeploy.',
  },
  breaker_open: {
    title: 'Circuit breaker open',
    detail:
      'A recent Tradier request failed, so the scanner is in cooldown and is deliberately not retrying yet (~90s after a rate-limit, ~5min after other upstream errors). It reopens on its own — try again shortly.',
  },
  no_spot: {
    title: 'No underlying price',
    detail:
      'The quote feed returned no usable spot price for this symbol, so there is nothing to price the chain against. Usually a rate-limited or unknown ticker.',
  },
  no_expirations: {
    title: 'No expiration in the DTE window',
    detail:
      'This symbol lists no expiration inside the scanner window (21–60 days, targeting 35). Weeklies-only or non-optionable tickers land here.',
  },
  no_chain: {
    title: 'Empty option chain',
    detail:
      'The expiration was picked but the chain came back with no rows. Typically a symbol with no listed options at that expiration.',
  },
  fetch_error: {
    title: 'Upstream fetch failed',
    detail:
      'The scanner could not reach the market-data provider for this scan. The breaker may now be in cooldown.',
  },
  unavailable: {
    title: 'Scan unavailable',
    detail:
      'The server reported a generic failure without saying which precondition failed. This is the legacy catch-all reason — a server build from before the reasons were split will always report it.',
  },
};

// ── Small pieces ───────────────────────────────────────────────────────────

function Chip({
  tone,
  label,
  title,
}: {
  tone: 'good' | 'bad' | 'warn' | 'idle';
  label: string;
  title?: string;
}) {
  const colors: Record<typeof tone, { bg: string; fg: string }> = {
    good: { bg: 'rgba(34,197,94,0.14)', fg: 'var(--green)' },
    bad: { bg: 'rgba(239,68,68,0.14)', fg: 'var(--red)' },
    warn: { bg: 'rgba(234,179,8,0.16)', fg: 'var(--orange)' },
    idle: { bg: 'var(--bg-hover)', fg: 'var(--muted)' },
  };
  const c = colors[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        background: c.bg,
        color: c.fg,
        borderRadius: '999px',
        padding: '0.15rem 0.6rem',
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

/**
 * The diagnostics chip row. `configured` and `breakerOpen` come straight off
 * the health route; the cache counts are shown because a warm cache is the
 * difference between a scan that costs an upstream call and one that doesn't.
 */
function DiagnosticsChips({ diag }: { diag: ScannerDiagnostics | null }) {
  if (!diag) {
    return <Chip tone="idle" label="diagnostics —" title="Scanner diagnostics not loaded yet." />;
  }
  return (
    <>
      <Chip
        tone={diag.configured ? 'good' : 'bad'}
        label={diag.configured ? '✓ configured' : '✗ not configured'}
        title={
          diag.configured
            ? 'The server has Tradier credentials and can fetch option chains.'
            : 'No Tradier credentials on the server — every scan will return no_credentials.'
        }
      />
      <Chip
        tone={diag.breakerOpen ? 'bad' : 'good'}
        label={diag.breakerOpen ? '⚠ breaker OPEN' : '✓ breaker closed'}
        title={
          diag.breakerOpen
            ? `Cooldown after an upstream failure${
                diag.breakerOpenedAtMs
                  ? ` — opened ${new Date(diag.breakerOpenedAtMs).toLocaleTimeString()}`
                  : ''
              }. Scans short-circuit until it closes.`
            : 'No upstream failure cooldown in effect.'
        }
      />
      <Chip
        tone="idle"
        label={`cache ${diag.cacheSize}/${diag.expirationsCacheSize}`}
        title="Cached chain snapshots / cached expiration lists. A warm cache means a scan costs no upstream call."
      />
    </>
  );
}

function classificationStyle(c: OtmCandidate['classification']): {
  color: string;
  label: string;
} {
  // Green = cheap (mark below model), red = expensive (mark above model), per
  // the ticket's colour spec. Deliberately NOT the P&L convention — nothing
  // here is a position, so green/red read as "cheap/rich vs. theo".
  if (c === 'cheap') return { color: 'var(--green)', label: 'cheap' };
  if (c === 'expensive') return { color: 'var(--red)', label: 'rich' };
  return { color: 'var(--muted)', label: 'fair' };
}

// ── Panel ──────────────────────────────────────────────────────────────────

export function OtmMispricingPanel({
  token,
  symbols,
}: {
  token: string;
  /** The live watchlist rows — only `.symbol` is used. */
  symbols: { symbol: string }[];
}) {
  const watchSymbols = useMemo(
    () => symbols.map((s) => s.symbol).filter(Boolean),
    [symbols],
  );

  const [selected, setSelected] = useState<string>('');
  const [customSymbol, setCustomSymbol] = useState('');
  const [minMispricing, setMinMispricing] = useState<number>(0.15);
  /**
   * TRA-2388 — the |delta| floor override, held as the RAW STRING the user typed.
   *
   * Blank (the default) means "send no `minDelta`", which is what makes the
   * SERVER's floor the one in force — the panel deliberately does not carry its
   * own literal, so a desk running an older build sees that build's behaviour and
   * the missing `deltaFloor` block says so. `0` is the research escape hatch: the
   * raw far tail, pre-TRA-2388.
   *
   * A string, not a number, because `0` and "blank" must stay distinguishable and
   * `Number('')` is 0 — the exact confusion that would silently disable the floor
   * for every user.
   */
  const [minDeltaInput, setMinDeltaInput] = useState<string>('');
  /**
   * The same value, mirrored into a ref so `runScan` can READ it without taking
   * it as a dependency.
   *
   * This is load-bearing, not a style choice. `minMispricing` is a <select>, so
   * one change is one user action and re-scanning on it is right. A text box
   * fires per KEYSTROKE — typing "0.05" through a dependency would be four
   * upstream Tradier chain fetches. The panel's contract is that a scan happens
   * only on an explicit action (symbol change / Enter / Refresh); see
   * DIAGNOSTICS_POLL_MS. Reading a ref at call time also means Refresh always
   * uses what is currently in the box, with no commit-on-blur race.
   */
  const minDeltaRef = useRef('');
  const [scan, setScan] = useState<OtmMispricingScanResponse | null>(null);
  const [diag, setDiag] = useState<ScannerDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);

  // Adopt the first watchlist symbol once one arrives, but never stomp a
  // choice the user has already made (including a custom ticker).
  const touchedRef = useRef(false);
  useEffect(() => {
    if (touchedRef.current) return;
    if (!selected && watchSymbols.length > 0) setSelected(watchSymbols[0]!);
  }, [watchSymbols, selected]);

  // Diagnostics chip — independent of the scan, so the panel can tell you the
  // scanner is unconfigured or breakered before you ask it for anything.
  useEffect(() => {
    let cancelled = false;
    async function loadDiag() {
      try {
        const r = await fetch(`${HTTP_URL}/api/health/options-mispricing`);
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as ScannerDiagnostics;
        if (!cancelled) setDiag(d);
      } catch (err) {
        // A failed diagnostics poll is not worth a UI error — the chip simply
        // stays on its last value (or "—"). The scan has its own error path.
        logger.warn('otm-mispricing', 'diagnostics poll failed', err);
      }
    }
    loadDiag();
    const id = setInterval(loadDiag, DIAGNOSTICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const runScan = useCallback(
    async (symbol: string) => {
      if (!symbol) return;
      setLoading(true);
      setError(null);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const qs = new URLSearchParams({
          symbol,
          limit: String(DEFAULT_LIMIT),
          minMispricing: String(minMispricing),
        });
        // TRA-2388 — only sent when the user typed something. Omitting the key
        // is what selects the server's floor; sending `0` is what escapes it.
        const deltaOverride = minDeltaRef.current.trim();
        if (deltaOverride.length > 0) qs.set('minDelta', deltaOverride);
        const r = await fetch(`${HTTP_URL}/api/options/otm-mispricing?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!r.ok) {
          // A 404 here means the server predates the restored route (TRA-161).
          // Say so precisely — "endpoint missing" and "scan found nothing" are
          // the two things this panel most needs to keep apart.
          setError(
            r.status === 404
              ? 'This server build does not expose /api/options/otm-mispricing. It was restored in TRA-161 — the deployed build is older than that.'
              : r.status === 401
                ? 'Your session has expired. Sign in again to run a scan.'
                : `The scanner returned an error (HTTP ${r.status}).`,
          );
          setScan(null);
          return;
        }
        const data = (await r.json()) as OtmMispricingScanResponse;
        setScan(data);
        setScannedAt(Date.now());
        if (data.diagnostics) setDiag(data.diagnostics);
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        logger.warn('otm-mispricing', aborted ? 'scan timed out' : 'scan failed', err);
        setError(
          aborted
            ? 'The scan took too long to respond. The chain fetch may be slow — try again.'
            : 'Could not reach the scanner. Check your connection and try again.',
        );
        setScan(null);
      } finally {
        clearTimeout(timer);
        setLoading(false);
      }
    },
    [token, minMispricing],
  );

  // Scan when the chosen symbol (or band) changes. No interval — see
  // DIAGNOSTICS_POLL_MS on why the scan is user-driven.
  useEffect(() => {
    if (selected) void runScan(selected);
  }, [selected, runScan]);

  function chooseSymbol(sym: string) {
    touchedRef.current = true;
    setSelected(sym.trim().toUpperCase());
  }

  function submitCustom(e: React.FormEvent) {
    e.preventDefault();
    const sym = customSymbol.trim().toUpperCase();
    if (sym) {
      chooseSymbol(sym);
      setCustomSymbol('');
    }
  }

  const reason: ScanReason | undefined = scan?.reason;
  const candidates = scan?.candidates ?? [];
  // A non-ok reason is a FAULT (explain it). An 'ok' scan with no rows is a
  // legitimately quiet chain and gets its own, non-alarming copy.
  const faultCopy = reason && reason !== 'ok' ? REASON_COPY[reason] : null;
  // TRA-2341 — only meaningful when the server actually removed something.
  // `applied === 0` means the guard ran but was disabled (?minTheo=0), and an
  // absent block means the server predates the guard: neither is a suppression.
  const floorReport = scan?.theoFloor;
  const suppressed = floorReport && floorReport.suppressed > 0 ? floorReport : null;
  // TRA-2388 — same rule on the delta axis, and the same three-way distinction:
  // absent block = the server predates the floor, `applied === 0` = escaped via
  // `?minDelta=0`, `suppressed === 0` = it ran and was a no-op (the healthy case
  // on NVDA / QQQ / AAPL). Only the third-and-nonzero case is a suppression.
  const deltaReport = scan?.deltaFloor;
  const deltaSuppressed = deltaReport && deltaReport.suppressed > 0 ? deltaReport : null;

  return (
    <div className="otm-mispricing-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Mispriced OTM</h3>
        <span className="muted">
          out-of-the-money contracts ranked by |mark − theo| ÷ theo · read-only research surface
        </span>
      </div>

      {/* Diagnostics chips — GET /api/health/options-mispricing */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
        <DiagnosticsChips diag={diag} />
        {scannedAt && (
          <span className="muted">scanned {new Date(scannedAt).toLocaleTimeString()}</span>
        )}
      </div>

      {/* Symbol selector — watchlist chips + a free-text box for anything else */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        {watchSymbols.length === 0 ? (
          <span className="muted">Watchlist empty — enter a symbol to scan.</span>
        ) : (
          watchSymbols.map((sym) => (
            <button
              key={sym}
              type="button"
              className={sym === selected ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              onClick={() => chooseSymbol(sym)}
              aria-pressed={sym === selected}
            >
              {sym}
            </button>
          ))
        )}
        <form onSubmit={submitCustom} style={{ display: 'flex', gap: '0.35rem' }}>
          <input
            type="text"
            value={customSymbol}
            onChange={(e) => setCustomSymbol(e.target.value)}
            placeholder="Symbol…"
            aria-label="Scan a custom symbol"
            style={{ width: '6.5rem', textTransform: 'uppercase' }}
          />
          <button type="submit" className="btn-secondary btn-sm" disabled={!customSymbol.trim()}>
            Scan
          </button>
        </form>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem' }}>
          <span className="muted">Band</span>
          <select
            value={minMispricing}
            onChange={(e) => setMinMispricing(Number(e.target.value))}
            aria-label="Mispricing band"
            title="|mark − theo| ÷ theo above which a contract is labelled cheap or rich. Does not filter rows — it moves the cheap/rich/fair cutoff."
          >
            {MISPRICING_BANDS.map((b) => (
              <option key={b} value={b}>
                ±{Math.round(b * 100)}%
              </option>
            ))}
          </select>
        </label>
        {/*
          TRA-2388 — the |delta| floor override. Blank sends no `minDelta` at all,
          which leaves the SERVER's floor in force; that is the default on purpose,
          so this control never becomes a second place the constant lives. `0`
          restores the raw far tail for research.
        */}
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem' }}>
          <span className="muted">|Δ| floor</span>
          <input
            type="text"
            inputMode="decimal"
            value={minDeltaInput}
            onChange={(e) => {
              setMinDeltaInput(e.target.value);
              minDeltaRef.current = e.target.value;
            }}
            onKeyDown={(e) => {
              // Enter applies it. Typing alone must not scan — each scan is an
              // upstream chain fetch (see DIAGNOSTICS_POLL_MS).
              if (e.key === 'Enter') {
                e.preventDefault();
                if (selected && !loading) void runScan(selected);
              }
            }}
            placeholder="server"
            aria-label="Minimum absolute delta"
            title="Drops contracts whose |delta| is below this before the top-N slice — ranking by a ratio otherwise returns the far tail, where (mark − theo) / theo measures the minimum tick. Blank uses the server's floor; 0 shows the raw tail. Press Enter to apply."
            style={{ width: '4.5rem' }}
          />
        </label>
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={() => selected && void runScan(selected)}
          disabled={!selected || loading}
        >
          {loading ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      {/* Scan context line */}
      {scan && reason === 'ok' && (
        <div className="muted">
          {scan.symbol} spot {fmtPrice(scan.spot)} · expiration {scan.expiration ?? '—'}
          {candidates[0] ? ` · ${candidates[0].daysToExpiration}d to expiry` : ''}
        </div>
      )}

      {error && (
        <div className="empty" style={{ borderColor: 'var(--red)' }}>
          <strong>{error}</strong>
          <div style={{ marginTop: '0.5rem' }}>
            <button type="button" className="btn-secondary btn-sm" onClick={() => selected && void runScan(selected)}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!error && loading && !scan && <div className="empty">Scanning {selected}…</div>}

      {!error && !loading && !scan && !selected && (
        <div className="empty">Pick a symbol above to scan its option chain.</div>
      )}

      {/* Reason-specific empty state — the TRA-161 ask: QA sees WHY, not just nothing. */}
      {!error && faultCopy && (
        <div className="empty">
          <strong>{faultCopy.title}</strong>
          <div style={{ marginTop: '0.35rem', maxWidth: '46rem', marginInline: 'auto' }}>
            {faultCopy.detail}
          </div>
          <div className="muted" style={{ marginTop: '0.5rem' }}>
            server reason: <code>{reason}</code>
            {scan?.errorMessage ? ` — ${scan.errorMessage}` : ''}
          </div>
        </div>
      )}

      {/*
        TRA-2341 — an all-suppressed scan must NOT fall through to the "thin
        chain" copy below. Live SPY produced 15 usable-looking rows that were
        all theo underflow; telling the desk "nothing passed the liquidity
        filters" would be a flat lie about a chain that is anything but thin.
      */}
      {!error && reason === 'ok' && candidates.length === 0 && suppressed && (
        <div className="empty">
          <strong>All candidates were below the theo floor</strong>
          <div style={{ marginTop: '0.35rem', maxWidth: '46rem', marginInline: 'auto' }}>
            {suppressed.suppressed} contract{suppressed.suppressed === 1 ? '' : 's'} cleared the
            liquidity gates for {scan?.symbol}, but every one priced below{' '}
            {fmtPrice(suppressed.applied)} on the model — so its mispricing ratio measures the
            minimum tick, not a disagreement with the vol surface. This is a real chain with no
            reliable read at this expiration, not an empty one.
          </div>
          <div className="muted" style={{ marginTop: '0.5rem' }}>
            largest suppressed divergence:{' '}
            {suppressed.maxSuppressedMispricingPct === null
              ? '—'
              : `${fmt(suppressed.maxSuppressedMispricingPct * 100, 1)}%`}
            {/* TRA-2388 — when BOTH axes fired, do not let this branch swallow
                the delta count just because it won the render. */}
            {deltaSuppressed
              ? ` · a further ${deltaSuppressed.suppressed} below |delta| ${fmt(deltaSuppressed.applied, 3)}`
              : ''}
          </div>
        </div>
      )}

      {/*
        TRA-2388 — the same trap on the delta axis, and it is NOT covered by the
        branch above: the theo floor can suppress nothing (`suppressed: 0`) while
        the delta floor removes every remaining row. Without this branch that lands
        on the thin-chain copy below and reports a healthy scan of a liquid chain.
      */}
      {!error && reason === 'ok' && candidates.length === 0 && !suppressed && deltaSuppressed && (
        <div className="empty">
          <strong>Every candidate was in the far tail</strong>
          <div style={{ marginTop: '0.35rem', maxWidth: '46rem', marginInline: 'auto' }}>
            {deltaSuppressed.suppressed} contract{deltaSuppressed.suppressed === 1 ? '' : 's'}{' '}
            cleared the liquidity gates for {scan?.symbol}, but every one sits below |delta|{' '}
            {fmt(deltaSuppressed.applied, 3)} — far enough out that (mark − theo) / theo measures
            the minimum tick rather than a disagreement with the vol surface. This is a real chain
            with no near-money read at this expiration, not an empty one.
          </div>
          <div className="muted" style={{ marginTop: '0.5rem' }}>
            largest suppressed divergence:{' '}
            {deltaSuppressed.maxSuppressedMispricingPct === null
              ? '—'
              : `${fmt(deltaSuppressed.maxSuppressedMispricingPct * 100, 1)}%`}{' '}
            · set the |Δ| floor to 0 to see them
          </div>
        </div>
      )}

      {!error && reason === 'ok' && candidates.length === 0 && !suppressed && !deltaSuppressed && (
        <div className="empty">
          No OTM contracts passed the liquidity filters for {scan?.symbol} at{' '}
          {scan?.expiration ?? 'this expiration'}. The scanner drops contracts under 50 open
          interest, wider than a 20% spread, or marked below $0.05 — a thin chain legitimately
          yields nothing. This is a clean scan, not a fault.
        </div>
      )}

      {!error && reason === 'ok' && candidates.length > 0 && (
        <div className="options-table">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Type</th>
                <th>Strike</th>
                <th>Expiry</th>
                <th>Mark</th>
                <th>Theo</th>
                <th>Mispricing</th>
                <th>Delta</th>
                <th>OI</th>
                <th>Spread %</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => {
                const cls = classificationStyle(c.classification);
                return (
                  <tr key={c.optionSymbol}>
                    <td className="symbol" title={c.optionSymbol}>
                      {c.optionSymbol}
                    </td>
                    <td className={c.optionType === 'call' ? 'green' : 'red'}>
                      {c.optionType.toUpperCase()}
                    </td>
                    <td>{fmtPrice(c.strike)}</td>
                    <td className="muted">
                      {c.expiration} <span className="muted">({c.daysToExpiration}d)</span>
                    </td>
                    <td title={`bid ${fmt(c.bid)} / ask ${fmt(c.ask)}`}>{fmtPrice(c.mark)}</td>
                    <td title={`σ used: ${fmt(c.ivUsed * 100, 1)}%`}>{fmtPrice(c.theo)}</td>
                    {/* mispricingPct is a RATIO — ×100 for display. */}
                    <td style={{ color: cls.color, fontWeight: 600 }}>
                      {c.mispricingPct >= 0 ? '+' : '−'}
                      {fmt(Math.abs(c.mispricingPct) * 100, 1)}%{' '}
                      <span style={{ fontWeight: 400, fontSize: '0.75rem' }}>{cls.label}</span>
                    </td>
                    <td>{fmt(c.delta, 3)}</td>
                    <td>{c.openInterest.toLocaleString('en-US')}</td>
                    {/* spreadPct is a RATIO too. */}
                    <td className={c.spreadPct > 0.15 ? 'red' : ''}>
                      {fmt(c.spreadPct * 100, 1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/*
        TRA-2341 — a filter that drops rows silently turns "15 artifacts" into
        "nothing found", which reads exactly like a thin chain. Always say what
        was removed, and only when something actually was.
      */}
      {!error && reason === 'ok' && candidates.length > 0 && suppressed && (
        <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          {suppressed.suppressed} higher-ranked contract
          {suppressed.suppressed === 1 ? ' was' : 's were'} hidden: model price below{' '}
          {fmtPrice(suppressed.applied)} (under one tick), where (mark − theo) / theo measures the
          minimum tick rather than a disagreement with the surface
          {suppressed.maxSuppressedMispricingPct === null
            ? ''
            : ` — the worst read ${fmt(suppressed.maxSuppressedMispricingPct * 100, 1)}%`}
          . Append <code>&amp;minTheo=0</code> to the scan URL to see them.
        </p>
      )}

      {/*
        TRA-2388 — the delta-axis note, next to the theo one. Rendered whenever the
        floor removed something, INDEPENDENTLY of the theo footnote: the two axes
        catch different rows and neither subsumes the other.
      */}
      {!error && reason === 'ok' && candidates.length > 0 && deltaSuppressed && (
        <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          {deltaSuppressed.suppressed} higher-ranked contract
          {deltaSuppressed.suppressed === 1 ? ' was' : 's were'} hidden: |delta| below{' '}
          {fmt(deltaSuppressed.applied, 3)}, the far tail where ranking by (mark − theo) / theo
          returns the minimum tick rather than a view on the surface
          {deltaSuppressed.maxSuppressedMispricingPct === null
            ? ''
            : ` — the worst read ${fmt(deltaSuppressed.maxSuppressedMispricingPct * 100, 1)}%`}
          . Set the |Δ| floor above to <code>0</code> to see them.
        </p>
      )}

      {/*
        The floor is in force and clean — worth SAYING, because "the floor ran and
        found nothing to drop" and "this build has no floor" render identically if
        you only ever show suppressions. The absent block is the deploy detector.
      */}
      {!error && reason === 'ok' && candidates.length > 0 && deltaReport && !deltaSuppressed && (
        <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          {deltaReport.applied > 0
            ? `|Δ| floor ${fmt(deltaReport.applied, 3)} in force — nothing to suppress on this chain.`
            : '|Δ| floor disabled — showing the raw far tail, where the mispricing ratio can measure the minimum tick.'}
        </p>
      )}

      <p className="muted" style={{ margin: 0 }}>
        Research only — no order entry from this panel. “Theo” is Black-Scholes at the market’s own
        implied vol, so a divergence is a disagreement with the surface, not a free edge: it prices
        in no skew, no event premium and no borrow. Entry off this scan is TRA-159 and is not wired.
      </p>
    </div>
  );
}
