// TRA-4502 (parent TRA-4284) — the book you are NOT looking at, said out loud.
//
// TRA-3910 put a chip in the header reading `Viewing DEMO book · engine is
// LIVE`. That chip is TRUE and it stays: it is a statement about ROUTING, and
// its job is to stop a demo VIEW reading as "the live arm was stood down".
//
// It is not a statement about EXPOSURE, and on 2026-09-01 that was the whole
// defect. The live-armed operator account carried `viewMode: "demo"` PERSISTED,
// so every panel — Options (0), Positions (0), no Greeks, the demo Calendar —
// rendered the empty paper book while three real-money rows sat breached and
// inert in the book that was not on screen. An operator could read the chip,
// correctly conclude nothing was disarmed, and still have no idea the money
// book was in trouble, because every surface that would have told them was
// rendering the other book.
//
// So: the chip gains the COUNT (every frame, breach or no breach — see
// `hiddenBookChipSuffix`), and anything the operator must not miss escalates
// to this banner, beside `HaltBanner` / `LiveCredentialsBanner`.
//
// ⚠️ This component performs NO WRITES. It names the exposure and points at the
// header toggle, which is the ONE control that changes the view (TRA-3910
// routed every view change through `PUT /api/account/view-mode` precisely so
// there is one place to audit). A second write site on a real-money view
// control is the shape of TRA-3809 and TRA-3910 themselves; a banner about a
// hidden money book is not worth re-opening it for one saved click.
import type { HiddenBookExposure } from '@trading-app/shared';
import { hiddenBookNeedsBanner } from '@trading-app/shared';
import { fmt } from '../../lib/format';

function usd(n: number): string {
  return `$${fmt(n)}`;
}

function rows(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`;
}

/**
 * TRA-4502 — the census, as one line an operator can act on. `null` when there
 * is no census to describe (a demo hidden book), so the caller renders nothing
 * rather than an empty clause.
 */
export function hiddenBookStopLine(exposure: HiddenBookExposure): string | null {
  const s = exposure.stops;
  if (s === null) {
    return exposure.book === 'live' && exposure.openOptionRows > 0
      // BLIND is not CLEAN. Say which one this is.
      ? `The stop census for the hidden LIVE book is unavailable (${exposure.stopsUnavailableReason ?? 'no reason given'})`
        + ` — treat its ${rows(exposure.openOptionRows)} as UNVERIFIED.`
      : null;
  }
  const parts = [`${s.breached} past their stop`];
  // TRA-3839 — `unacted`, not `inert`: a breached row is equally unattended
  // when a row gate refused it and when no exit pass reaches the book at all.
  if (s.unacted > 0) parts.push(`${s.unacted} the engine will NOT act on`);
  if (s.inFlight > 0) parts.push(`${s.inFlight} with an exit working at the broker`);
  if (s.inertReasons.length > 0) {
    parts.push(s.inertReasons.map(r => `${r.reason} ×${r.count}`).join(', '));
  }
  if (s.exitPassBlockedBy !== null) parts.push(`no exit pass reaches this book (${s.exitPassBlockedBy})`);
  if (s.indefinite > 0) parts.push(`${s.indefinite} need a human — they do not clear on a clock`);
  else if (s.releasesAt !== null) parts.push(`earliest automatic release ${s.releasesAt}`);
  return `${parts.join(' · ')}.`;
}

/**
 * TRA-4502 — what the TRA-3910 header chip appends, EVERY frame an override is
 * set, breach or no breach. Acceptance 1 is a count, not an alarm: "3 open live
 * rows" on a quiet day is what makes "3 breached" legible on a bad one.
 *
 * `null` ⇒ nothing to append (no override, or a hidden demo book holding
 * nothing). A hidden DEMO book with rows still gets a count — it is paper
 * money, so it never reaches the banner, but the operator asked to see one book
 * and is being shown another either way.
 */
export function hiddenBookChipSuffix(exposure: HiddenBookExposure | null | undefined): string | null {
  if (!exposure) return null;
  if (exposure.openOptionRows === 0) {
    // A flat hidden book is worth saying on the LIVE side: "0 open live rows"
    // is the reassurance the chip could not give before. On the demo side it is
    // noise.
    return exposure.book === 'live' ? '0 open LIVE rows' : null;
  }
  const head = `${exposure.openOptionRows} open ${exposure.book.toUpperCase()} ${exposure.openOptionRows === 1 ? 'row' : 'rows'}`
    + ` (${usd(exposure.openPremiumUsd)})`;
  const s = exposure.stops;
  if (s === null) {
    return exposure.book === 'live' ? `${head} · stop census UNAVAILABLE` : head;
  }
  const flags: string[] = [];
  if (s.breached > 0) flags.push(`${s.breached} breached`);
  if (s.unacted > 0) flags.push(`${s.unacted} unactionable`);
  return flags.length > 0 ? `${head} · ${flags.join(', ')}` : head;
}

/**
 * TRA-4502 — acceptance 2: a breach in the hidden book is a BANNER, not a chip.
 *
 * Renders nothing unless {@link hiddenBookNeedsBanner} says so — the threshold
 * is shared with the server so the two cannot drift. A quiet hidden live book
 * is deliberately chip-only: a banner this operator sees every day is a banner
 * they will not see on the day it matters.
 */
export function HiddenBookBanner({ exposure }: { exposure: HiddenBookExposure | null | undefined }) {
  if (!exposure || !hiddenBookNeedsBanner(exposure)) return null;
  const stopLine = hiddenBookStopLine(exposure);
  const breached = exposure.stops?.breached ?? null;
  return (
    <div
      role="alert"
      data-testid="hidden-book-banner"
      className="hidden-book-banner"
      style={{
        background: 'var(--red-soft)',
        border: '1px solid var(--red)',
        color: 'var(--red-strong)',
        padding: '0.75rem 1rem',
        margin: '0.5rem 1rem',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.6rem',
        fontWeight: 600,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '1.1rem', lineHeight: 1.3 }}>⚠️</span>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <span data-testid="hidden-book-banner-headline">
          {breached !== null && breached > 0
            ? `${rows(breached)} past their stop in the ${exposure.book.toUpperCase()} book — which this dashboard is not showing.`
            : `Real money is open in the ${exposure.book.toUpperCase()} book — which this dashboard is not showing.`}
        </span>
        <span style={{ fontWeight: 400 }} data-testid="hidden-book-banner-detail">
          You are viewing the {exposure.shownBook.toUpperCase()} book. The engine routes to the{' '}
          {exposure.book.toUpperCase()} account, and that book holds {rows(exposure.openOptionRows)}{' '}
          ({usd(exposure.openPremiumUsd)} premium
          {exposure.unpricedRows > 0
            ? `, ${exposure.unpricedRows} unpriced — the dollar figure UNDERSTATES`
            : ''}
          ).
          {stopLine ? ` ${stopLine}` : ''}
        </span>
        {/* No control here on purpose — see the module header. The DEMO/LIVE
            toggle in the header is the one view write, and it is two inches
            away. */}
        <span style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.9 }}>
          Switch the header toggle to {exposure.book.toUpperCase()} to see these rows. That changes
          only what is DISPLAYED — the engine is already routing to this account and nothing is armed
          or disarmed by looking.
        </span>
      </div>
    </div>
  );
}
