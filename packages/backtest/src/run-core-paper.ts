/**
 * CORE paper runner — trades the frozen CORE put-credit-spread rules on the
 * Tradier SANDBOX account, once a day, so real (paper) multileg fills can be
 * compared with the backtest model before any live capital is considered.
 *
 *   node packages/backtest/dist/run-core-paper.js                 # dry run: print the plan, place nothing
 *   node packages/backtest/dist/run-core-paper.js --execute       # place sandbox orders
 *   node packages/backtest/dist/run-core-paper.js --summary       # paper results vs the 40-trade gate
 *   node packages/backtest/dist/run-core-paper.js --check-account # read-only: can the LIVE account trade CORE?
 *
 * Run it once per trading day around 15:30 ET (e.g. a cron / Render cron job).
 *
 * Safety, by construction:
 *  - ORDERS ONLY EVER GO TO SANDBOX. The order client is built with env
 *    'sandbox' and TRADIER_SANDBOX_API_TOKEN / TRADIER_SANDBOX_ACCOUNT_ID; there
 *    is no flag that points it at production.
 *  - Market data (chains, quotes) comes from production when
 *    TRADIER_MARKET_DATA_TOKEN is set — real-time, unlike sandbox's 15-min
 *    delay — and from sandbox otherwise (with a warning).
 *  - Default is a dry run. Every order is a DAY limit order; one that has not
 *    filled within --fill-wait seconds is canceled so state never drifts.
 *  - --check-account only reads balances and the user profile.
 *
 * Options:
 *   --symbol SPY          underlying (default SPY)
 *   --state <path>        state file (default $DATA_DIR/core-paper-state.json or ./core-paper-state.json)
 *   --fill-wait <s>       seconds to wait for a fill before canceling (default 60)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TradierOptionsClient, tradierBaseUrl } from '@trading-app/engine';
import {
  EMPTY_STATE,
  assessCoreAccountFit,
  closeLimitDebit,
  decideCoreExit,
  pickCoreExpiration,
  planCoreEntry,
  summarizeCorePaper,
  type CorePaperPosition,
  type CorePaperState,
} from './core-paper.js';
import { CORE_RULES } from './put-spread-core.js';

interface Args {
  execute: boolean;
  summary: boolean;
  checkAccount: boolean;
  symbol: string;
  statePath: string;
  fillWaitMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = new Set(['--execute', '--summary', '--check-account', '--symbol', '--state', '--fill-wait', '--dry-run']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown flag ${a}`);
    if (['--symbol', '--state', '--fill-wait'].includes(a)) i += 1;
  }
  const dataDir = process.env['DATA_DIR'];
  return {
    execute: argv.includes('--execute'),
    summary: argv.includes('--summary'),
    checkAccount: argv.includes('--check-account'),
    symbol: (get('--symbol') ?? 'SPY').toUpperCase(),
    statePath: resolve(get('--state') ?? (dataDir ? join(dataDir, 'core-paper-state.json') : 'core-paper-state.json')),
    fillWaitMs: Math.max(5, Number(get('--fill-wait') ?? 60)) * 1000,
  };
}

function loadState(path: string): CorePaperState {
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  const s = JSON.parse(readFileSync(path, 'utf8')) as CorePaperState;
  if (s.version !== 1 || !Array.isArray(s.positions)) throw new Error(`unrecognised state file ${path}`);
  return s;
}

function saveState(path: string, state: CorePaperState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path); // atomic replace: a crash mid-write never truncates the ledger
}

function requireEnv(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const fmt = (n: number | null | undefined, d = 2): string => (n == null ? '—' : n.toFixed(d));

async function spotOf(client: TradierOptionsClient, symbol: string): Promise<number | null> {
  // The option-quote reader is a plain /markets/quotes call; it works for equities too.
  const q = await client.getOptionQuote(symbol);
  if (!q) return null;
  if (typeof q.bid === 'number' && typeof q.ask === 'number' && q.bid > 0 && q.ask >= q.bid) return (q.bid + q.ask) / 2;
  return typeof q.last === 'number' && q.last > 0 ? q.last : null;
}

/** Wait for a terminal state; cancel if still working when the wait ends. */
async function settle(
  orders: TradierOptionsClient,
  orderId: number,
  waitMs: number,
): Promise<{ filled: boolean; avgFillPrice: number | null; status: string }> {
  const detail = await orders.waitForOrderTerminalStatus(orderId, { timeoutMs: waitMs, intervalMs: 2000 });
  if (detail && detail.status === 'filled') {
    return { filled: true, avgFillPrice: detail.avg_fill_price ?? null, status: 'filled' };
  }
  if (!detail || !['canceled', 'rejected', 'expired'].includes(detail.status)) {
    const c = await orders.cancelOrderConfirmed(orderId);
    // A fill can land between the last poll and the cancel; the confirmed cancel reports it.
    const after = await orders.getOrderStatus(orderId);
    if (after?.status === 'filled') return { filled: true, avgFillPrice: after.avg_fill_price ?? null, status: 'filled' };
    return { filled: false, avgFillPrice: null, status: `canceled_after_wait (${JSON.stringify(c)})` };
  }
  return { filled: false, avgFillPrice: null, status: detail.status };
}

async function checkAccount(): Promise<void> {
  const token = requireEnv('TRADIER_API_TOKEN');
  const accountId = requireEnv('TRADIER_ACCOUNT_ID');
  const base = tradierBaseUrl('production');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const [bal, prof] = await Promise.all([
    fetch(`${base}/accounts/${encodeURIComponent(accountId)}/balances`, { headers }),
    fetch(`${base}/user/profile`, { headers }),
  ]);
  if (!bal.ok) throw new Error(`balances HTTP ${bal.status}`);
  const b = ((await bal.json()) as { balances?: Record<string, unknown> }).balances ?? {};
  let optionLevel: number | null = null;
  if (prof.ok) {
    const p = (await prof.json()) as { profile?: { account?: unknown } };
    const accts = Array.isArray(p.profile?.account) ? p.profile!.account : [p.profile?.account];
    const mine = (accts as Array<Record<string, unknown>>).find((a) => a && String(a['account_number']) === accountId);
    const lvl = Number(mine?.['option_level']);
    optionLevel = Number.isFinite(lvl) ? lvl : null;
  }
  const accountType = typeof b['account_type'] === 'string' ? (b['account_type'] as string) : null;
  const totalEquity = typeof b['total_equity'] === 'number' ? (b['total_equity'] as number) : null;
  const fit = assessCoreAccountFit({ accountType, totalEquity, optionLevel });
  console.log(`[core-paper] live account: type=${accountType ?? '?'} equity=$${fmt(totalEquity)} optionLevel=${optionLevel ?? '?'}`);
  console.log(`[core-paper] CORE live-ready: ${fit.verdict.toUpperCase()}`);
  for (const r of fit.reasons) console.log(`  - ${r}`);
  if (fit.verdict !== 'ready') {
    console.log('  Paper-trade on sandbox meanwhile; live needs a margin account, ≥ $2,000 and spread approval.');
  }
}

function printSummary(state: CorePaperState): void {
  const s = summarizeCorePaper(state);
  const open = state.positions.filter((p) => p.status === 'open');
  console.log(`[core-paper] closed ${s.closed}/${s.gateTrades} toward the paper gate · open ${open.length}`);
  console.log(
    `  win rate ${s.winRate == null ? '—' : (s.winRate * 100).toFixed(0) + '%'} · P&L $${fmt(s.totalPnlUsd)} · ` +
      `mean return-on-risk ${s.meanReturnOnRisk == null ? '—' : (s.meanReturnOnRisk * 100).toFixed(2) + '%'} · ` +
      `entry fill vs model ${fmt(s.meanEntrySlippage, 3)}/sh`,
  );
  for (const p of open) {
    console.log(`  open ${p.underlying} ${p.expiration} ${p.shortStrike}/${p.longStrike}P credit ${fmt(p.fillCredit ?? p.modelCredit)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkAccount) return checkAccount();
  const state = loadState(args.statePath);
  if (args.summary) return printSummary(state);

  const mdToken = (process.env['TRADIER_MARKET_DATA_TOKEN'] ?? '').trim();
  const sbxToken = requireEnv('TRADIER_SANDBOX_API_TOKEN');
  const sbxAccount = requireEnv('TRADIER_SANDBOX_ACCOUNT_ID');
  // ORDERS: sandbox, always.
  const orders = new TradierOptionsClient(sbxToken, sbxAccount, 'sandbox');
  // DATA: production when a market-data token is present.
  const data = mdToken ? new TradierOptionsClient(mdToken, 'market-data-only', 'production') : orders;
  if (!mdToken) {
    console.warn('[core-paper] TRADIER_MARKET_DATA_TOKEN not set — using SANDBOX market data (15-min delayed).');
  }
  const now = Date.now();
  const mode = args.execute ? 'EXECUTE (sandbox orders)' : 'DRY RUN (no orders)';
  console.log(`[core-paper] ${new Date(now).toISOString()} · ${args.symbol} · ${mode} · state ${args.statePath}`);

  const spot = await spotOf(data, args.symbol);
  if (spot == null) throw new Error(`no spot for ${args.symbol}`);
  console.log(`[core-paper] spot ${fmt(spot)}`);

  // ── exits first ──
  for (const p of state.positions.filter((x) => x.status === 'open')) {
    const [sq, lq] = await Promise.all([data.getOptionQuote(p.shortSymbol), data.getOptionQuote(p.longSymbol)]);
    const ok = (q: typeof sq) => q && typeof q.bid === 'number' && typeof q.ask === 'number' && q.ask >= q.bid && q.ask > 0;
    if (!ok(sq) || !ok(lq)) {
      console.warn(`[core-paper] ${p.id}: no two-sided quote on a leg — holding`);
      continue;
    }
    const midDebit = (sq!.bid! + sq!.ask!) / 2 - (lq!.bid! + lq!.ask!) / 2;
    const naturalDebit = sq!.ask! - lq!.bid!;
    const reason = decideCoreExit(p, Math.max(0, midDebit), now);
    console.log(`[core-paper] ${p.id}: debit to close mid ${fmt(midDebit)} (natural ${fmt(naturalDebit)}) → ${reason ?? 'hold'}`);
    if (!reason) continue;
    const limit = closeLimitDebit(Math.max(0, midDebit), naturalDebit, reason);
    if (!args.execute) {
      console.log(`  would BUY TO CLOSE ${p.shortStrike}/${p.longStrike}P for ≤ ${fmt(limit)} debit`);
      continue;
    }
    const resp = await orders.submitMultilegOrder(
      p.underlying,
      [
        { optionSymbol: p.shortSymbol, side: 'buy_to_close', quantity: 1 },
        { optionSymbol: p.longSymbol, side: 'sell_to_close', quantity: 1 },
      ],
      { type: 'debit', price: limit, duration: 'day' },
    );
    p.closeOrderId = String(resp.id);
    const r = await settle(orders, resp.id, args.fillWaitMs);
    console.log(`  close order ${resp.id}: ${r.status}${r.avgFillPrice != null ? ` @ ${fmt(r.avgFillPrice)}` : ''}`);
    if (r.filled) {
      p.status = 'closed';
      p.closeReason = reason;
      p.closeDebit = Math.abs(r.avgFillPrice ?? limit);
      p.closedAt = Date.now();
    }
    saveState(args.statePath, state);
  }

  // ── entry ──
  const expirations = await data.getExpirations(args.symbol);
  const expiration = pickCoreExpiration(expirations, now);
  const chain = expiration ? await data.getChainSnapshot(args.symbol, expiration) : [];
  const decision = planCoreEntry({ state, expiration, chain, spot, now });
  if (!decision.ok) {
    console.log(`[core-paper] no entry: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ''}`);
  } else {
    const pl = decision.plan;
    console.log(
      `[core-paper] entry: SELL ${args.symbol} ${pl.expiration} ${pl.short.strike}/${pl.long.strike}P · ` +
        `short |Δ| ${fmt(pl.shortDelta, 3)} IV ${fmt(pl.shortIv * 100, 1)}% · credit mid ${fmt(pl.midCredit)} ` +
        `natural ${fmt(pl.naturalCredit)} → limit ${fmt(pl.limitCredit)} · max loss $${fmt((CORE_RULES.width - pl.limitCredit) * 100)}`,
    );
    if (args.execute) {
      const resp = await orders.submitMultilegOrder(
        args.symbol,
        [
          { optionSymbol: pl.short.optionSymbol, side: 'sell_to_open', quantity: 1 },
          { optionSymbol: pl.long.optionSymbol, side: 'buy_to_open', quantity: 1 },
        ],
        { type: 'credit', price: pl.limitCredit, duration: 'day' },
      );
      const position: CorePaperPosition = {
        id: `${args.symbol}-${pl.expiration}-${pl.short.strike}-${now}`,
        underlying: args.symbol,
        expiration: pl.expiration,
        shortSymbol: pl.short.optionSymbol,
        longSymbol: pl.long.optionSymbol,
        shortStrike: pl.short.strike,
        longStrike: pl.long.strike,
        modelCredit: pl.midCredit,
        limitCredit: pl.limitCredit,
        fillCredit: null,
        openOrderId: String(resp.id),
        closeOrderId: null,
        closeReason: null,
        closeDebit: null,
        status: 'pending_open',
        openedAt: now,
        closedAt: null,
      };
      state.positions.push(position);
      saveState(args.statePath, state);
      const r = await settle(orders, resp.id, args.fillWaitMs);
      console.log(`  open order ${resp.id}: ${r.status}${r.avgFillPrice != null ? ` @ ${fmt(r.avgFillPrice)}` : ''}`);
      if (r.filled) {
        position.status = 'open';
        position.fillCredit = Math.abs(r.avgFillPrice ?? pl.limitCredit);
        state.lastEntryAt = now;
      } else {
        position.status = 'canceled';
      }
      saveState(args.statePath, state);
    }
  }
  printSummary(state);
}

main().catch((err) => {
  console.error(`[core-paper] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
