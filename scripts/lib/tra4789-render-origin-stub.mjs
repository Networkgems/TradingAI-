// tra4789-render-origin-stub.mjs — TEST ONLY. Preloaded with `node --import`.
//
// Replaces globalThis.fetch with a canned Render API + health route so the REAL main() of
// `scripts/check-deploy-origin.mjs` can be exercised end to end, offline, with no key.
//
// WHY A SPAWNED main() AND NOT JUST grade(). TRA-4420's lesson, one level up: the defect
// there was never a wrong predicate, it was the ABSENCE OF A CALL SITE. A suite that only
// tables `grade()` stays green if somebody deletes the call out of main(), or stops
// binding the history, or stops loading the acks. These arms run the shipped bytes.
//
// Config arrives as JSON on TRA4789_STUB:
//   { deploys:     [{deploy, cursor}] | null      GET /services/{id}/deploys  (one page)
//     deployPages: [[{deploy,cursor}], …]         …or several, for the paging arms
//     deploysStatus?: number                      …or a failure, when deploys is null
//     events:      [{event, cursor}] | null       GET /services/{id}/events
//     eventsStatus?: number
//     health:      {commit, …} | null             GET …/api/health/version
//     healthStatus?: number }
//
// Every route absent from the config THROWS "unstubbed" rather than returning something
// plausible — a stub that invents a quiet answer is the same silent-green bug the script
// under test exists to catch.
//
// It refuses every non-GET outright, so a stubbed run cannot become a real one.

const cfg = JSON.parse(process.env.TRA4789_STUB ?? '{}');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function pageOf(pages, url) {
  const m = /[?&]cursor=([^&]+)/.exec(url);
  const cursor = m ? decodeURIComponent(m[1]) : null;
  if (!cursor) return pages[0] ?? [];
  const idx = pages.findIndex((p) => p.length && p[p.length - 1]?.cursor === cursor);
  return idx >= 0 ? pages[idx + 1] ?? [] : [];
}

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw new Error(`[tra4789-stub] refusing a ${method} to ${u} — this stub is read-only by design.`);
  }

  if (/\/services\/[^/]+\/deploys/.test(u)) {
    if (Array.isArray(cfg.deployPages)) return json(pageOf(cfg.deployPages, u));
    if (!Array.isArray(cfg.deploys)) return new Response('stubbed deploy-list read failure', { status: cfg.deploysStatus ?? 500 });
    return json(cfg.deploys);
  }
  if (/\/services\/[^/]+\/events/.test(u)) {
    if (!Array.isArray(cfg.events)) return new Response('stubbed events read failure', { status: cfg.eventsStatus ?? 500 });
    return json(cfg.events);
  }
  if (/\/api\/health\/version/.test(u)) {
    if (!cfg.health) return new Response('stubbed health failure', { status: cfg.healthStatus ?? 503 });
    return json(cfg.health);
  }

  throw new Error(`[tra4789-stub] unstubbed request: ${method} ${u}`);
};
