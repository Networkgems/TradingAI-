// TRA-1989 — FINNHUB_API_TOKEN provisioning verifier.
//
// A one-command gate that answers the *only* question TRA-1989 exists to answer:
// once a token is set in the runtime, does `EarningsCalendarClient.fetchWindow`
// actually return **historical** earnings for the OOS universe across the real
// walk-forward span — or does the provisioned key 403 / come back empty?
//
// Why a standalone probe rather than just `run-tra1968-earnings-gate.ts --execute`:
//   • It isolates the *credential/tier* check from the grade. No Yahoo bars, no
//     walk-forward compute — just the earnings round-trip, so a bad key fails in
//     seconds instead of after a full run.
//   • It encodes the TRA-1989 acceptance criteria as explicit, machine-checkable
//     assertions, and specifically catches the **free-tier trap**: TRA-148 /
//     TRA-154 / TRA-155 established that Finnhub's free tier 403s (or silently
//     empties) on historical data. The approval summary (96e8cec6) assumed a free
//     key suffices; this probe settles that with evidence, not assumption.
//
// It mirrors the harness window/universe by value (same convention the harness
// itself uses for the D1 thresholds) so the two never need a shared-export dep.
// If `run-tra1968-earnings-gate.ts` changes its window or universe, update the
// three constants below to match.
//
// Run:
//   FINNHUB_API_TOKEN=… pnpm --filter @trading-app/backtest verify:finnhub-token
//
// Exit codes (so an operator / CI can branch on the outcome):
//   0  PASS — token set, historical earnings returned spanning the OOS window.
//   2  token unset.
//   3  HTTP error from Finnhub (e.g. 401/403 — wrong or free-tier key).
//   4  token works but returns no historical earnings for the universe (empty),
//      or only recent/live earnings that do not span the backtest window.

import { EarningsCalendarClient, type EarningsEvent } from '@trading-app/engine';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Mirror of run-tra1968-earnings-gate.ts (keep in sync) ────────────────────
const WINDOW_START_MS = Date.UTC(2023, 0, 1); // 2023-01-01
const WINDOW_END_MS = Date.UTC(2026, 0, 1); // 2026-01-01
const SWING_MAX_DAYS = 10;
const UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX'];
// ─────────────────────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main(): Promise<number> {
  const token = (process.env['FINNHUB_API_TOKEN'] ?? '').trim();
  if (!token) {
    console.error(
      '[tra1989] FINNHUB_API_TOKEN is NOT set in this runtime.\n' +
        '          Set a valid token in the runtime that runs the TRA-1973 --execute grade, then re-run:\n' +
        '            FINNHUB_API_TOKEN=… pnpm --filter @trading-app/backtest verify:finnhub-token',
    );
    return 2;
  }

  // The exact backdated window the harness uses: one fetch covering the whole OOS
  // span plus swing-threshold slack on both ends.
  const spanDays = Math.ceil((WINDOW_END_MS - WINDOW_START_MS) / DAY_MS) + SWING_MAX_DAYS * 2;
  const asOf = WINDOW_START_MS - SWING_MAX_DAYS * DAY_MS;
  const fromIso = iso(asOf);
  const toIso = iso(asOf + spanDays * DAY_MS);

  console.log(
    `[tra1989] token set (prefix ${token.slice(0, 4)}…). Probing historical earnings ` +
      `${fromIso} → ${toIso} for ${UNIVERSE.join(',')} …`,
  );

  const client = new EarningsCalendarClient(token);
  let events: EarningsEvent[];
  try {
    events = await client.fetchWindow({ asOf, fromDays: 0, toDays: spanDays });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[tra1989] FAIL — Finnhub fetchWindow errored: ${msg}\n` +
        '          A 401/403 here means the key is invalid or its tier does not serve the historical\n' +
        '          earnings calendar (the free-tier trap from TRA-148/154/155). A paid/higher tier is\n' +
        '          required, or a different provider must back the OOS grade.',
    );
    return 3;
  }

  const want = new Set(UNIVERSE.map((s) => s.toUpperCase()));
  const universeEvents = events.filter((e) => want.has(e.symbol));
  const bySymbol = new Map<string, string[]>();
  for (const e of universeEvents) {
    let list = bySymbol.get(e.symbol);
    if (!list) {
      list = [];
      bySymbol.set(e.symbol, list);
    }
    list.push(e.date);
  }

  const dates = universeEvents.map((e) => e.date).sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];
  // Guard the "not just live/next-earnings" acceptance clause: the returned set
  // must actually span the historical window, not just cluster near "now".
  const spansHistory =
    earliest !== undefined &&
    latest !== undefined &&
    Date.parse(`${earliest}T00:00:00Z`) <= WINDOW_START_MS + 120 * DAY_MS && // an event early in the span
    Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`) >= 365 * DAY_MS; // > 1yr of coverage

  console.log(
    `[tra1989] returned ${events.length} total calendar rows; ${universeEvents.length} for the ` +
      `${UNIVERSE.length}-symbol universe across ${bySymbol.size} symbols.`,
  );
  for (const sym of UNIVERSE) {
    const ds = (bySymbol.get(sym) ?? []).sort();
    console.log(
      `           ${sym.padEnd(6)} ${ds.length} events` +
        (ds.length ? `  [${ds[0]} … ${ds[ds.length - 1]}]` : '  (none)'),
    );
  }

  if (universeEvents.length === 0) {
    console.error(
      '[tra1989] FAIL — token authenticated but returned ZERO historical earnings for the universe.\n' +
        '          The key likely does not serve backdated ranges (free-tier historical restriction).',
    );
    return 4;
  }
  if (!spansHistory) {
    console.error(
      `[tra1989] FAIL — returned earnings do not span the OOS window (earliest ${earliest}, latest ` +
        `${latest}). The tier appears to serve only recent/live earnings, not the historical range the\n` +
        '          point-in-time gate needs. This is the exact "not just live/next-earnings" failure the\n' +
        '          TRA-1989 acceptance criteria calls out.',
    );
    return 4;
  }

  console.log(
    `[tra1989] PASS — historical earnings reachable and span the OOS window (${earliest} … ${latest}).\n` +
      '          The TRA-1973 --execute grade is unblocked in this runtime. Hand off to QuantTrader.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[tra1989] unexpected error', err);
    process.exit(1);
  });
