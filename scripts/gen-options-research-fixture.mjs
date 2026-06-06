// TRA-599 — one-shot generator for the recorded chain-snapshot fixture used by
// options-research-input.test.ts. Builds a realistic AAPL chain (call + put
// skew across strikes for a single ~39-DTE expiration), prices every row to its
// smvVol-implied fair value, then deliberately marks two OTM contracts rich so
// the real OTM scanner flags them as `expensive`. Verifies both scanners run,
// then writes the fixture JSON. Re-run only if the chain needs regenerating.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  blackScholesPrice,
  findMispricedOtmContracts,
  findRelativeValueOpportunities,
} from '../packages/engine/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYMBOL = 'AAPL';
const SPOT = 195;
const EXPIRATION = '2026-07-17';
const RECORDED_AT = Date.parse('2026-06-08T13:30:00Z'); // 39 days to expiry
const T = (Date.parse(`${EXPIRATION}T20:00:00Z`) - RECORDED_AT) / (365 * 24 * 3600 * 1000);
const R = 0.045;

const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

// Mild vol smile: cheapest near ATM, richer in the wings.
function ivForStrike(strike, optionType) {
  const moneyness = (strike - SPOT) / SPOT;
  return round(0.26 + 0.9 * moneyness * moneyness + (optionType === 'put' ? 0.02 : 0), 4);
}

const strikes = [];
for (let k = 170; k <= 220; k += 2.5) strikes.push(k);

const rows = [];
for (const optionType of ['call', 'put']) {
  for (const strike of strikes) {
    const iv = ivForStrike(strike, optionType);
    const fair = blackScholesPrice({
      spot: SPOT, strike, timeToExpiryYears: T, riskFreeRate: R, volatility: iv, optionType,
    });
    if (fair < 0.4) continue; // below the scanners' mark floor — skip thin wings
    let mark = fair;
    // Make two specific OTM contracts richly priced so the OTM scanner flags them.
    const richCall = optionType === 'call' && strike === 205;
    const richPut = optionType === 'put' && strike === 185;
    if (richCall || richPut) mark = fair * 1.28; // +28% over theo → > 15% threshold
    const half = Math.max(0.02, mark * 0.02); // 4%-wide tight market
    rows.push({
      optionSymbol: `${SYMBOL}${EXPIRATION.replace(/-/g, '').slice(2)}${optionType === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
      underlying: SYMBOL,
      optionType,
      strike,
      expiration: EXPIRATION,
      bid: round(mark - half),
      ask: round(mark + half),
      last: round(mark),
      volume: 1200,
      openInterest: 4000,
      midIv: iv,
      smvVol: iv,
    });
  }
}

const snapshot = {
  symbol: SYMBOL,
  spot: SPOT,
  recordedAt: RECORDED_AT,
  expirations: [EXPIRATION],
  rows,
};

// Sanity: confirm the scanners actually surface flagged candidates.
const otm = findMispricedOtmContracts(rows, SPOT, { now: RECORDED_AT });
const rv = findRelativeValueOpportunities(rows, SPOT, { now: RECORDED_AT });
const flaggedOtm = otm.filter((c) => c.classification !== 'fair');
console.log(`rows=${rows.length} otmFlagged=${flaggedOtm.length} rvCandidates=${rv.length}`);
console.log('flagged OTM:', flaggedOtm.map((c) => `${c.optionType}${c.strike} ${c.classification} ${round(c.mispricingPct * 100)}%`));
if (flaggedOtm.length === 0) {
  console.error('FIXTURE INVALID: no flagged OTM candidates — adjust perturbation');
  process.exit(1);
}

const outDir = join(__dirname, '..', 'packages', 'server', 'src', '__fixtures__');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'options-chain-snapshot.json');
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
console.log('wrote', outPath);
