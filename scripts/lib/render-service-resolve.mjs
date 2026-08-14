// render-service-resolve.mjs — TRA-3743
//
// ONE implementation of "which Render service is this script talking to", shared by
// render-redeploy.mjs and render-deploy-status.mjs. They each carried their own copy of
// the name lookup, and therefore each carried the same dead default string.
//
// ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────────
// Both scripts defaulted `RENDER_SERVICE_NAME` to `tradingai-bqb1`, then did:
//     GET /v1/services?name=tradingai-bqb1                       ->  []
//     fail(2, 'no service named "tradingai-bqb1" visible to this API key.')
//
// The money host's Render `name` is `TradingAI-`. `tradingai-bqb1` is its **slug**, and
// the slug is what the HOSTNAME tracks (`https://tradingai-bqb1.onrender.com`). Third
// instance of the same drift: TRA-3719 (`buildCommand`), TRA-3736 (`render.yaml` `name:`).
//
// It FAILS CLOSED, and that is not the bug. Render's `?name=` filter is exact and
// case-sensitive — MEASURED 2026-08-14 against the live account:
//
//     ?name=TradingAI-    -> TradingAI-      ?name=TradingAI   -> []
//     ?name=tradingai-bqb1-> []              ?name=tradingai   -> []
//                                            ?name=TRADINGAI-  -> []
//
// so a dead name cannot silently resolve to the WRONG service. The defect is the
// **message**: it asserts an API-key PERMISSION problem while holding evidence of
// nothing but an empty name filter. An operator without `RENDER_SERVICE_ID` set reads
// that and goes rotating or re-scoping a Render key to fix a string constant.
//
// ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────────
//   1. exact `?name=` filter, as before — cheap, Render-side, and unambiguous;
//   2. on empty, ENUMERATE what the key can actually see and match on `name` again
//      (in case the filter ever changes shape) and then on `slug` — because every other
//      reference in this repo and in docs/runbook.md names this host by its slug /
//      hostname, so the slug is the string an operator will actually type. `name` is
//      checked before `slug` on purpose: one service's slug must never shadow another
//      service's name.
//   3. that enumeration is ALSO the evidence the old message did not have:
//        0 visible  -> the key IS the problem (revoked, or scoped to another owner)
//        N visible  -> the key is fine and the NAME is wrong; the N are printed.
//
// A 401/403 never reaches the ambiguity above: the caller's `api()` exits on `!r.ok`
// with the HTTP status, which is an unambiguous key signal on its own. This module only
// has to disambiguate the case where both calls SUCCEEDED and returned nothing useful.
//
// ⛔ Do NOT "fix" the drift by renaming the live service. Same ruling as TRA-3736: the
// live host is the fact, `slug` (and therefore the onrender hostname) does NOT track a
// rename, and re-tidying the money host's identity during go-live week is the wrong risk
// trade. This module accepts BOTH strings instead, which removes the drift structurally.

// The go-live host, with its three identity strings kept apart on purpose. Reading any
// one of these as if it were another is the whole TRA-3719/3736/3743 class.
export const BQB1 = Object.freeze({
  id: 'srv-d7mb7rr7uimc73ev0chg', //           the only binding that cannot drift
  name: 'TradingAI-', //                       Render `service.name` — what `?name=` filters on
  slug: 'tradingai-bqb1', //                   Render `service.slug` — what the HOSTNAME tracks
  host: 'https://tradingai-bqb1.onrender.com',
});

// Default for `RENDER_SERVICE_NAME`. It is the `name`, not the slug — but `resolveServiceByName`
// accepts either, so an operator who types the hostname they know still resolves.
export const DEFAULT_SERVICE_NAME = BQB1.name;

// Render's list endpoints return `[{ cursor, service }]`; the single-service GET returns the
// service bare. Tolerate both, and drop anything that is not an object rather than letting a
// `null` reach a `.name` read.
export function unwrapServices(list) {
  if (!Array.isArray(list)) return [];
  return list.map(x => x?.service ?? x).filter(s => s && typeof s === 'object');
}

export function describeService(s) {
  return `${s?.id ?? '?'} (name=${JSON.stringify(s?.name ?? null)} slug=${JSON.stringify(s?.slug ?? null)})`;
}

/**
 * Resolve a service by its Render `name` or its `slug`.
 *
 * `get(path)` is injected so the whole decision is testable without the network — same
 * idiom as `authSecretGateState`'s injected probe in render-redeploy.mjs.
 *
 * Returns `{ service, matchedOn, visible, candidates }`:
 *   service    the resolved service, or `null`
 *   matchedOn  'name' | 'slug' | null — printed by the caller, because resolving the money
 *              host via its SLUG is worth one line of output rather than being silent
 *   visible    every service the key can see, or `null` when the filter hit on the first
 *              call (we never paid for the enumeration, so we must not claim to know)
 *   candidates the slug matches, so an ambiguous slug can be reported as ambiguous rather
 *              than as absent
 */
export async function resolveServiceByName(wanted, get) {
  const filtered = unwrapServices(await get(`/services?name=${encodeURIComponent(wanted)}&limit=20`));
  const byName = filtered.find(s => s.name === wanted);
  if (byName) return { service: byName, matchedOn: 'name', visible: null, candidates: [byName] };

  const visible = unwrapServices(await get('/services?limit=100'));

  const byNameListed = visible.find(s => s.name === wanted);
  if (byNameListed) return { service: byNameListed, matchedOn: 'name', visible, candidates: [byNameListed] };

  const bySlug = visible.filter(s => s.slug === wanted);
  if (bySlug.length === 1) return { service: bySlug[0], matchedOn: 'slug', visible, candidates: bySlug };

  return { service: null, matchedOn: null, visible, candidates: bySlug };
}

/**
 * The message for an unresolved name. It only ever says what the two reads actually
 * witnessed — that is the entire ticket.
 */
export function explainUnresolved(wanted, { visible = [], candidates = [] } = {}) {
  if (candidates.length > 1) {
    return (
      `"${wanted}" is AMBIGUOUS — ${candidates.length} services share that slug: ` +
      `${candidates.map(describeService).join(', ')}. ` +
      `Set RENDER_SERVICE_ID=srv-… to bind exactly one.`
    );
  }
  if (visible.length === 0) {
    return (
      `this API key can see NO services at all, so "${wanted}" could not be resolved against ` +
      `anything. That is a KEY problem — revoked, or scoped to a different Render owner — NOT a ` +
      `name problem. Fix the key, or set RENDER_SERVICE_ID=srv-… (an id read is a different ` +
      `endpoint and will report its own 401/403).`
    );
  }
  return (
    `no service is named or slugged "${wanted}". This is a NAME problem, NOT a key-permission ` +
    `problem: the key CAN see ${visible.length} service(s) — ${visible.map(describeService).join(', ')}. ` +
    `The go-live host's Render name is "${BQB1.name}" while its SLUG is "${BQB1.slug}" (the slug is ` +
    `what ${BQB1.host} tracks); either string resolves here. Set RENDER_SERVICE_ID=${BQB1.id} to ` +
    `bind by id and skip name resolution entirely.`
  );
}
