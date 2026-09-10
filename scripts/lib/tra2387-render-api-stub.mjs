// tra2387-render-api-stub.mjs — TEST ONLY. Preloaded with `node --import`.
//
// Replaces globalThis.fetch with a canned Render API so render-redeploy.mjs's REAL main()
// can be exercised end-to-end, offline, with no key and no possibility of POSTing a deploy.
//
// WHY THIS EXISTS RATHER THAN JUST UNIT-TESTING THE PREDICATE. TRA-2387's whole subject is
// a correct predicate that NOTHING INVOKED: `scripts/tra2296-auth-secret-check.mjs` read the
// live value with the right test and no deploy path called it. A suite that only exercises
// authSecretGateState() reproduces exactly that failure one level up — it would stay green
// if somebody deleted the call site out of main(), which is the only thing that makes the
// gate real (cf. TRA-2262: verify the EDGE, not the node).
//
// Config comes in as JSON on TRA2387_STUB:
//   { service: {id, name, branch}, envVars: [{key, value}] | null, envVarsStatus?: number }
// envVars: null + envVarsStatus → the env-var read fails, i.e. the BLIND arm.
// TRA-4535 adds two OPTIONAL keys, for the cadence gate's call-site arms:
//   deploys: [{deploy, cursor}] | null, deploysStatus?: number — GET /services/{id}/deploys
//   health:  {commit, startedAt, …}                                 — GET …/api/health/version
// When a key is absent its route throws "unstubbed" as it always has, so no existing arm changes shape.
//
// It refuses to serve a deploy POST at all, so a stubbed run cannot become a real one even
// if --dry-run were dropped from the command.

const cfg = JSON.parse(process.env.TRA2387_STUB ?? '{}');
const service = cfg.service ?? { id: 'srv-stub', name: 'stub-service', branch: 'main' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init?.method ?? 'GET').toUpperCase();

  if (method === 'POST') {
    throw new Error(`[tra2387-stub] refusing to serve a ${method} to ${u} — this stub is read-only by design.`);
  }
  if (/\/services\?name=/.test(u)) return json([{ service }]);
  if (/\/services\/[^/]+\/env-vars/.test(u)) {
    if (cfg.envVars === null || cfg.envVars === undefined) {
      return new Response('stubbed env-var read failure', { status: cfg.envVarsStatus ?? 500 });
    }
    return json(cfg.envVars.map(v => ({ envVar: v, cursor: null })));
  }
  if (/\/services\/[^/]+\/deploys/.test(u) && ('deploys' in cfg || 'deploysStatus' in cfg)) {
    if (!Array.isArray(cfg.deploys)) {
      return new Response('stubbed deploy-list read failure', { status: cfg.deploysStatus ?? 500 });
    }
    return json(cfg.deploys);
  }
  if (/\/api\/health\/version/.test(u) && cfg.health) return json(cfg.health);
  if (/\/services\/[^/]+$/.test(u)) return json(service);

  throw new Error(`[tra2387-stub] unstubbed request: ${method} ${u}`);
};
