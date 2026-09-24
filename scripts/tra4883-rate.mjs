// TRA-4883 AC1 (part 2) — bytes/row and a rate-stability check across the file's life.
// Samples a handful of single trading days spread over the 92-day span and reconstructs
// the on-disk line bytes each one costs, so the headline bytes/day is not resting on a
// single total/span division.
const HOST = process.env.TRA4883_HOST ?? 'https://tradingai-bqb1.onrender.com';
const countIn = async (from, to) => {
  const u = new URL(`${HOST}/api/health/reversal-shadow-signals`);
  u.searchParams.set('from', String(from));
  u.searchParams.set('to', String(to));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`probe ${r.status}`);
  return r.json();
};

// One ET trading day, 13:30Z..21:00Z-ish — take the whole UTC day to be safe.
const day = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return [t, t + 86400000 - 1];
};

const SAMPLES = ['2026-06-25', '2026-07-15', '2026-08-05', '2026-08-26', '2026-09-16', '2026-09-23'];
let sumBytes = 0, sumRows = 0;
for (const d of SAMPLES) {
  const [from, to] = day(d);
  const j = await countIn(from, to);
  // Reconstruct the exact on-disk lines this day's records cost.
  let bytes = 0, resolved = 0;
  for (const r of j.signals) {
    const { outcome, realizedR, barsToResolution, resolvedAt, ...open } = r;
    bytes += Buffer.byteLength(JSON.stringify({ kind: 'open', rec: open })) + 1;
    if (outcome !== 'OPEN') {
      resolved++;
      bytes += Buffer.byteLength(JSON.stringify({
        kind: 'resolve', id: r.id,
        res: { outcome, realizedR, barsToResolution }, resolvedAt,
      })) + 1;
    }
  }
  const perRow = j.count > 0 ? bytes / j.count : 0;
  console.log(`${d}  rows=${String(j.count).padStart(5)}  resolved=${String(resolved).padStart(5)}  bytes=${String(bytes).padStart(9)}  bytes/row=${perRow.toFixed(1)}`);
  if (j.count > 0) { sumBytes += bytes; sumRows += j.count; }
}
console.log(`\nsampled trading days=${SAMPLES.length}  rows=${sumRows}  bytes=${sumBytes}  mean bytes/row=${(sumBytes / sumRows).toFixed(1)}  mean bytes/trading-day=${Math.round(sumBytes / SAMPLES.length)}`);
