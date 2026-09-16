# `viewMode` persistence on a live-armed operator account — decision

**Ticket:** TRA-4502 (acceptance 3) · **Parent:** TRA-4284 · **Ancestor:** TRA-4277
**Decided:** 2026-09-16 · **Owner:** CFO · **Status:** ratified, in force

## The question

TRA-4284 asked it in one line: *"Decide and document whether `viewMode: demo` should
persist across sessions on a live-armed operator account at all. This one has been
persisted, not set for a session."*

## Decision

**`viewMode` persists, unchanged — indefinitely, across sessions, across restarts. It is
not session-scoped, not expired on a clock, and not cleared at boot or at login.**

The control that makes the persistence safe is **disclosure**, shipped by this ticket:

| Surface | Condition | What it says |
| --- | --- | --- |
| Header chip (TRA-3910, extended) | **every frame** an override is set | `Viewing DEMO book · engine is LIVE · 3 open LIVE rows ($358.00) · 3 breached, 3 unactionable` |
| `HiddenBookBanner` | `hiddenBookNeedsBanner()` | banner-level alert beside `HaltBanner` / `LiveCredentialsBanner`, naming the breach, the inert **reason**, and the release horizon |

Both read one payload — `EngineState.hiddenBookExposure`, folded server-side from the
**existing** TRA-3822/TRA-3839 stop census and the existing `openPremiumAtRiskForMode`
exposure fold — and it rides the same `/api/state` frame the panels render from, so the
disclosure cannot drift out of sync with the book it is describing.

## Why persistence stays

1. **The defect was silence, not persistence.** On 2026-09-01 the breach was visible in
   the *same* session the view was set in. A session-scoped override would have reset the
   *view* on the next login and still said nothing about the *exposure* while the session
   ran. Disclosure closes the defect in every session; expiry closes it in none.

2. **An auto-clearing view is a silent write in the other direction.** TRA-3809 and
   TRA-3910 are both about a UI asserting an account state nobody verified. A boot-time
   view reset manufactures precisely that: the operator left the dashboard on DEMO,
   returns to LIVE rows on screen, and nothing on the screen can say why they moved. We
   would have traded "it does not tell you what it hides" for "it changes what it shows
   with no event you can point at" — the same class of surprise, on the same surface, at
   the same stakes.

3. **An expiry puts a clock inside a real-money display.** Two operators reading the same
   dashboard either side of a boundary would see different books with no state change
   between them, and any screenshot would need its timestamp decoded before it could be
   read. Clock-dependent display state is how a "quiet day" gets attributed to the wrong
   session (cf. TRA-4342: a window change that `git` could not date).

4. **The pinned operator has no other lever.** `viewMode` exists because the TRA-2649 arm
   re-converges a `mode` write, so for the pinned live operator the account toggle cannot
   change the book at all (two Demo presses on 2026-08-20 landed as
   `bootArmRepairLedger` repairs and reverted). A session-scoped view would make that
   operator re-set it every single session — the friction that gets worked around rather
   than lived with.

5. **The feature was ratified.** TRA-4284 acceptance 4 is explicit: *do not fix this by
   removing the view override*. Expiring it is removing it slowly.

## What was explicitly rejected

- **Remove the override.** Refused by the parent's acceptance 4.
- **Expire it (session / N hours / at boot / at market open).** Rejected on 2, 3 and 4 above.
- **Force the view to LIVE when the hidden book breaches.** Rejected: it moves the screen
  under the operator's hands during an incident — every panel and every row index changes
  between the moment they decide to click and the moment they click. The banner *tells*
  them and the toggle is two inches away; the decision stays theirs.
- **A write control on the banner itself.** Rejected: TRA-3910 deliberately routed every
  view change through one route and one control so there is one place to audit. A second
  write site on a real-money view control is not worth one saved click.

## Conditions on this decision — re-take it if any of these change

- **The banner becomes dismissible, snoozable, or suppressible by any preference.** The
  persistence is paid for by an alert the operator cannot turn off. If that changes, the
  payment stops and this decision is void.
- **A surface starts rendering the hidden book's exposure from anything other than
  `EngineState.hiddenBookExposure`.** One payload, one threshold
  (`hiddenBookNeedsBanner`, in `@trading-app/shared` so server and client cannot disagree).
  A second, hand-derived copy re-opens the two-surfaces-one-fact shape this ticket closed.
- **The stop census stops being the one the exit pass is graded by.** The banner's
  authority is that `breached` / `inert` / `unacted` are the *same* numbers
  `/api/health/options-live` publishes and the same walk `checkExits` performs. A private
  detector written for the UI would be a second opinion about real money.
- **`viewMode` gains any reader that is not a display surface.** It is a view field: the
  arm never reads it, the router never reads it, `PUT /api/account/view-mode` 400s on any
  body key but `viewMode`. If something starts *routing* off it, the persistence question
  is a different question and this answer does not cover it.

## Related

- TRA-3910 — the view/routing split and the chip that states the routing fact.
- TRA-3822 / TRA-3839 — `liveStopActionability`: the breach census and its cadence join.
- TRA-4284 — the parent defect, as measured on bqb1 build `092d087775dc`.
- Sibling: `/api/options/alerts` ignores `viewMode` entirely, which is currently the only
  reason the breach leaked into the demo view at all. That is its own ticket and is **not**
  fixed here; this ticket does not depend on it and does not change it.
