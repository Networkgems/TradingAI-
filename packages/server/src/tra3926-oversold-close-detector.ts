// ---------------------------------------------------------------------------
// TRA-3926 — DID THE ENGINE SELL MORE THAN IT BOUGHT?
//
// On 2026-08-21T13:48:04Z, on the real-money production account, it did:
//
//     08-20 13:35:30Z  buy_to_open   ct=1  @1.08  origin=fill            oid=142603071
//     08-20 17:00:00Z  buy_to_open   ct=1  @0.85  origin=history_import  oid=null
//     08-21 13:48:04Z  sell_to_close ct=2  @1.01  origin=fill            oid=142806015
//
// and NOTHING ALARMED. The only trace anywhere in the system was a `no-lot`
// rejection inside `autoReconcile.lastGainLossRejections` — "the ledger holds 2
// contract(s), the fetched lots hold 0" — which reads as a DATA-FRESHNESS
// complaint about the P&L reconciler, not as "the engine disposed of somebody
// else's contract". A condition that has already fired on real money and left no
// alarm needs a detector that names it, independent of the fix.
//
// ── Why this cannot be folded into the exit-path fix ────────────────────────
// {@link boundExitContractsToEngineShare} prevents the NEXT one; it says nothing
// about the ones already in the tape, and it lives in the process that would
// have to be running correctly for its own counters to be trustworthy. This
// walks the durable fill ledger from the outside and re-derives the question
// from the rows. If the bound is ever reverted, mis-wired, or bypassed by a
// path nobody enumerated, this still fires. That is the whole point of keeping
// a detector after shipping the remedy (TRA-3879's line, and TRA-3881's: a fix
// that retires its own detector removes the evidence too).
//
// ── The discriminator, and it is the same one ──────────────────────────────
// `origin`. A `sell_to_close` written `history_import` with `orderId: null` is
// the RECONCILE's reconstruction of a close the broker reports and no chokepoint
// of ours recorded (TRA-2959) — that is the desk closing its own leg, and it is
// none of our business how much of it they sell. A close written `fill` with a
// broker order id went through OUR chokepoint: this engine submitted it, and an
// order cannot fill for more than it was submitted for.
//
// Likewise on the BUY side: `history_import` opens are evidence about the
// ACCOUNT, never evidence that this engine placed the order. They are counted
// separately (`importedContracts`) and never as ours — the exact confusion that
// un-fixed TRA-3913 overnight with no deploy.
//
// ── Three verdicts, and `blind` is not `clean` ──────────────────────────────
// The ledger retains 30 days. A close whose opens aged out looks IDENTICAL to a
// close of contracts we never bought, and reporting that as a finding would
// manufacture an alarm every time retention rolled. Those closes are counted as
// BLIND and named, not folded into either verdict — the same three-valued
// discipline `recordedOpenFillCount` exists to enforce one level down.
// ---------------------------------------------------------------------------

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';

/** One `sell_to_close` this engine submitted for more than its own opens cover. */
export interface OversoldCloseFinding {
  optionSymbol: string;
  /** Fill time of the close, ms epoch. */
  ts: number;
  /** ET calendar day of the close. */
  etDay: string;
  /** The broker order id of the close. Present by construction: an engine close carries one. */
  orderId: number | null;
  /** Contracts the close sold. */
  soldContracts: number;
  /**
   * Contracts this engine's own (`origin !== 'history_import'`) opens still had
   * outstanding on this OCC when the close landed.
   */
  engineOpenContracts: number;
  /**
   * Contracts outstanding on this OCC whose only evidence is a `history_import`
   * row — i.e. the broker says they exist and nothing says we placed them. On
   * the 2026-08-21 event this is the desk's XLF contract, and it is exactly what
   * the excess was taken out of.
   */
  importedOpenContracts: number;
  /** `soldContracts − engineOpenContracts`, always `> 0` on a finding. */
  excessContracts: number;
  /**
   * WHICH positive statement this accusation rests on. Both are positive; they
   * are not equally strong, and folding them into one number would hide that.
   *
   * `outstanding` — the engine held recorded opens on this OCC AT THE MOMENT of
   * the close and sold past them. The 2026-08-21 XLF event, and the 2026-08-05
   * QQQ one.
   *
   * `exhausted` — the engine held recorded opens on this OCC EARLIER in this
   * tape and had already consumed every one of them with its OWN prior closes,
   * so `engineOpenContracts` is 0 and every outstanding contract is the desk's.
   * See {@link BlindClose.import_only} for why a running balance of 0 is not on
   * its own enough to accuse, and why a LIFETIME count of 0 still is not.
   */
  basis: 'outstanding' | 'exhausted';
  /**
   * Contracts the engine's OWN `buy_to_open` rows account for on this OCC over
   * the whole tape, up to and including this close. The witness the `exhausted`
   * basis rests on: `> 0` on every finding, of either basis.
   */
  engineOpensSeenContracts: number;
  /** Contracts the engine's own PRIOR closes on this OCC already consumed. */
  engineClosesSeenContracts: number;
}

/**
 * A `sell_to_close` the walk could not judge. NOT a finding and NOT clean.
 *
 * `no_open_record` — the engine closed an OCC the ledger holds no outstanding
 * open for, from either party. Retention aged the opens out, or the ledger was
 * never hydrated. The close may have been perfectly correct.
 *
 * `unusable_quantity` — a row carrying a `contracts` value that is not a
 * positive finite number. `contracts` is not validated on hydrate, so a corrupt
 * on-disk row reaches this walk, and netting `NaN` reads as a number until
 * something compares it (TRA-3486).
 *
 * `import_only` — everything outstanding on this OCC is a `history_import`, so
 * the engine closed a position whose OPEN leg our chokepoint never recorded.
 * ⚠ THIS IS NOT EVIDENCE OF AN OVER-SELL AND IT WAS THE FIRST THING THIS
 * DETECTOR GOT WRONG. Run against the live 49-row tape on 2026-08-21 it called
 * four of these findings — including `SPY260807P00760000 sold 4 / ours 0` — and
 * the importer exists precisely because our chokepoint has demonstrably missed
 * OUR OWN fills (TRA-2959: 7 of 11 filled orders never reached the ledger). An
 * engine buy the chokepoint missed is imported from broker history and then
 * closed by us with `origin: 'fill'`, which is byte-identical to the desk's
 * contract being sold by the engine. Same ambiguity `oracle_import_only` names
 * one level down, same answer: counted, named, and NOT accused.
 *
 * ⛔ AND IT IS A RUNNING BALANCE, WHICH IS THE SECOND THING THIS DETECTOR GOT
 * WRONG — measured live, on real money, 2026-08-24T19:31:08Z, order 143160792:
 *
 *     BAC260925C00063000  08-20 13:36:23Z  buy_to_open   1 @1.65  origin=fill
 *                         08-20 17:00:00Z  buy_to_open   1 @1.17  origin=history_import
 *                         08-21 17:05:10Z  sell_to_close 1 @0.91  origin=fill
 *                         08-24 19:31:08Z  sell_to_close 1 @1.14  origin=fill   ← this one
 *
 * At the last close the engine's running balance IS 0 and everything
 * outstanding IS a `history_import` — so the branch above fired and filed it
 * BLIND. But the reason the balance is 0 is that the engine's own 08-21 close
 * consumed its own lot, which this tape states POSITIVELY. "Our chokepoint may
 * have missed our buy" is not the modal explanation for a symbol whose engine
 * buys the chokepoint demonstrably DID record. The discriminator is therefore
 * LIFETIME engine opens on the OCC, not the balance:
 *
 *   • lifetime engine opens 0  ⇒ genuinely ambiguous  ⇒ BLIND, unchanged. The
 *     four symbols above (SPY/QQQ/PLTR) all sit here and still do.
 *   • lifetime engine opens > 0, all consumed by our own closes ⇒ the residual
 *     is positively the desk's and we just sold it ⇒ FINDING, basis
 *     `exhausted`.
 *
 * ⚠ SAY WHAT THAT COSTS. This is a WEAKER refusal than the balance test, and it
 * has a false-accusation shape of its own: engine buys 1 (recorded) + engine
 * buys 1 (chokepoint missed, imported) then sells twice would be charged here,
 * and both contracts were genuinely ours. That is why the basis is carried on
 * every finding instead of being averaged into one count — a reader can weigh
 * `exhausted` differently from `outstanding` without re-deriving the tape. It
 * is not why the branch exists: AC5 requires the condition that ALREADY FIRED
 * to raise, and `import_only` files it as an unanswered question instead.
 */
export interface BlindClose {
  optionSymbol: string;
  ts: number;
  reason: 'no_open_record' | 'unusable_quantity' | 'import_only';
  /** Contracts the close sold. Present so a blind row is still legible. */
  soldContracts: number;
  /** Outstanding contracts whose only evidence is a `history_import` row. */
  importedOpenContracts: number;
}

export interface OversoldCloseCensus {
  /**
   * `oversold` — at least one finding. **This is the alarm.**
   * `clean`    — judged at least one engine close and every one was covered.
   * `vacuous`  — NO engine close was judgeable. Not a pass: a detector with an
   *              empty denominator has proved nothing. Read `blindCloses`.
   */
  status: 'oversold' | 'clean' | 'vacuous';
  /** `sell_to_close` rows this engine submitted (`origin !== 'history_import'`). */
  engineCloses: number;
  /** Of those, the ones the walk could judge. The DENOMINATOR. */
  judgedCloses: number;
  /** `sell_to_close` rows attributed to the desk by `origin`, skipped by design. */
  importedCloses: number;
  /** Contracts sold beyond the engine's own opens, summed over `findings`. */
  excessContracts: number;
  findings: OversoldCloseFinding[];
  blindCloses: BlindClose[];
}

/**
 * TRA-3926 (AC5) — walk the live fill ledger and raise on any `sell_to_close`
 * THIS ENGINE submitted for more contracts than its own recorded opens covered.
 *
 * Pure over the input, so it grades a hand-built tape in a test exactly as it
 * grades the live ledger on the health route. Records may arrive in any order;
 * the walk sorts oldest-first itself (stable, so same-`ts` rows keep append
 * order — which is the order they actually filled in).
 *
 * ⚠ A FINDING REQUIRES A POSITIVE STATEMENT, NOT JUST A SHORTFALL. The engine
 * must have SOME recorded open of its own on the OCC in this tape
 * (`engineOpensSeenContracts > 0`) before a shortfall is charged to it. Where
 * the whole open leg is a `history_import` and the engine has never bought this
 * OCC at all, the close reads BLIND — see `BlindClose.import_only`, which is the
 * branch the first version of this function got wrong against the live tape.
 *
 * ⛔ THE POSITIVE STATEMENT IS A LIFETIME COUNT, NOT THE RUNNING BALANCE, and
 * the difference is `basis: 'exhausted'` — the branch the 2026-08-24 BAC close
 * needed and did not have. `BlindClose.import_only` carries that measurement.
 *
 * ⛔ The netting is deliberately NOT `openEpisodeWindow`'s. That walk REFUSES
 * the whole symbol on an `unmatched_close` — which is the correct answer to
 * "what do we hold now" and the wrong one here, because an over-sized close is
 * itself an unmatched close and refusing it would swallow the very event this
 * detector exists to name. Here the two sides are netted SEPARATELY (ours and
 * the desk's), and an excess is charged against the desk's outstanding
 * contracts, because that is where it came from.
 */
export function detectOversoldEngineCloses(
  records: readonly LiveOptionFillRecord[],
): OversoldCloseCensus {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  /** Outstanding contracts per OCC, split by who the ledger says opened them. */
  const engineOpen = new Map<string, number>();
  const importedOpen = new Map<string, number>();
  /**
   * LIFETIME engine opens / engine closes per OCC — never decremented. These are
   * the `exhausted` basis's witness and they are deliberately NOT the running
   * balances above: the balance answers "what is outstanding", these answer "has
   * our chokepoint ever recorded us buying this symbol", and only the second one
   * can tell a consumed engine lot from a lot we never had. See
   * `BlindClose.import_only`.
   */
  const engineOpensSeen = new Map<string, number>();
  const engineClosesSeen = new Map<string, number>();
  const findings: OversoldCloseFinding[] = [];
  const blindCloses: BlindClose[] = [];
  let engineCloses = 0;
  let judgedCloses = 0;
  let importedCloses = 0;
  let excessContracts = 0;

  for (const f of sorted) {
    const symbol = f.optionSymbol;
    // `!(qty > 0)` rather than `qty <= 0`: the latter admits NaN into the
    // usable branch (TRA-3486).
    const qty = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
    // `!== 'history_import'` rather than `=== 'fill'`, matching
    // `recordedEngineOpenBasis`: rows written before TRA-2959 hydrate with
    // `origin: 'fill'`, and an unrecognised future origin must land on the side
    // that fails closed for a PROVENANCE reader — which is "ours".
    const enginePlaced = f.origin !== 'history_import';

    if (f.side === 'buy_to_open') {
      if (!(qty > 0)) continue;
      const book = enginePlaced ? engineOpen : importedOpen;
      book.set(symbol, (book.get(symbol) ?? 0) + qty);
      if (enginePlaced) engineOpensSeen.set(symbol, (engineOpensSeen.get(symbol) ?? 0) + qty);
      continue;
    }

    // sell_to_close
    if (!enginePlaced) {
      // The desk closing its own leg, reconstructed from broker history. Consume
      // the desk's side first and only spill onto ours if the desk's book cannot
      // cover it — a spill is not OUR over-sell and is not reported as one, but
      // it must still leave the books honest for the closes that follow.
      importedCloses += 1;
      if (!(qty > 0)) continue;
      const desk = importedOpen.get(symbol) ?? 0;
      const fromDesk = Math.min(qty, desk);
      importedOpen.set(symbol, desk - fromDesk);
      const spill = qty - fromDesk;
      if (spill > 0) {
        engineOpen.set(symbol, Math.max(0, (engineOpen.get(symbol) ?? 0) - spill));
      }
      continue;
    }

    engineCloses += 1;
    if (!(qty > 0)) {
      blindCloses.push({
        optionSymbol: symbol, ts: f.ts, reason: 'unusable_quantity',
        soldContracts: 0, importedOpenContracts: importedOpen.get(symbol) ?? 0,
      });
      continue;
    }
    const ours = engineOpen.get(symbol) ?? 0;
    const theirs = importedOpen.get(symbol) ?? 0;
    const seenOpens = engineOpensSeen.get(symbol) ?? 0;
    const seenCloses = engineClosesSeen.get(symbol) ?? 0;
    // ⛔ BOTH blind branches are gated on `seenOpens === 0`, and for the SAME
    // reason. Each one's honest case is an ABSENCE — retention aged our opens
    // out, or our chokepoint never recorded them — and an absence is refuted by
    // this very tape holding the engine's own `buy_to_open` rows for the OCC.
    // Where it does, the running balance being 0 is a POSITIVE statement that
    // our own closes consumed our own lots, and a further engine close is
    // spending somebody else's contract. TRA-3976's line, one level up: a
    // refusal backed by our own evidence binds; one that is an absence goes
    // blind.
    if (ours === 0 && theirs === 0 && seenOpens === 0) {
      // Nothing outstanding from either party. Retention, a cold ledger, or an
      // import that recovered one leg of a round trip and not the other — the
      // close may have been entirely correct and we cannot tell.
      blindCloses.push({
        optionSymbol: symbol, ts: f.ts, reason: 'no_open_record',
        soldContracts: qty, importedOpenContracts: 0,
      });
      engineClosesSeen.set(symbol, seenCloses + qty);
      continue;
    }
    if (ours === 0 && seenOpens === 0) {
      // Every outstanding contract on this OCC is a `history_import` AND our
      // chokepoint has never recorded us buying this symbol at all. See
      // `BlindClose.import_only`: our own chokepoint has demonstrably missed our
      // own fills, so this is the shape of an engine buy recovered from broker
      // history and then closed by us — indistinguishable, in these bytes, from
      // the desk's contract being sold. A finding here is a false accusation.
      blindCloses.push({
        optionSymbol: symbol, ts: f.ts, reason: 'import_only',
        soldContracts: qty, importedOpenContracts: theirs,
      });
      importedOpen.set(symbol, Math.max(0, theirs - qty));
      engineClosesSeen.set(symbol, seenCloses + qty);
      continue;
    }
    judgedCloses += 1;
    engineClosesSeen.set(symbol, seenCloses + qty);
    if (qty > ours) {
      // `ours === 0` reaches here only when `seenOpens > 0`, i.e. the engine held
      // recorded lots on this OCC and its OWN prior closes consumed them. That is
      // the `exhausted` basis and it is an accusation, not a blind — the branch
      // the 2026-08-24T19:31:08Z BAC close (order 143160792) walked through
      // unnamed on the build that was live at the time.
      const excess = qty - ours;
      excessContracts += excess;
      findings.push({
        optionSymbol: symbol,
        ts: f.ts,
        etDay: f.etDay,
        orderId: f.orderId,
        soldContracts: qty,
        engineOpenContracts: ours,
        importedOpenContracts: theirs,
        excessContracts: excess,
        basis: ours > 0 ? 'outstanding' : 'exhausted',
        engineOpensSeenContracts: seenOpens,
        engineClosesSeenContracts: seenCloses,
      });
      engineOpen.set(symbol, 0);
      importedOpen.set(symbol, Math.max(0, theirs - excess));
      continue;
    }
    engineOpen.set(symbol, ours - qty);
  }

  return {
    status: findings.length > 0 ? 'oversold' : judgedCloses > 0 ? 'clean' : 'vacuous',
    engineCloses,
    judgedCloses,
    importedCloses,
    excessContracts,
    findings,
    blindCloses,
  };
}
