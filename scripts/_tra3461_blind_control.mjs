// TRA-3461 — BOTH-DIRECTIONS CONTROL for the new `unreadable > 0 => exit 3` gate
// in `tra2634-continuity-archive-check.mjs`. Scratch: not part of the suite.
//
// Stands up a host that logs in cleanly and then FAILS the report route, which is
// exactly the world bqb1 was in at 2026-08-13T02:35Z (restarting, token dead, 101
// of 218 responses unreadable) — the world in which the OLD code printed PASS.
//
//   RED  : every report response 503        => expect exit 3 (BLIND)
//   GREEN: every report response 404        => a real negative, no unreadable,
//                                              expect exit 3 for the OTHER reason
//                                              (no gradeable pair), proving the
//                                              gate is not what fired.
//
// The discriminator is the MESSAGE, not just the code — both are HOLDs, and a
// control that cannot tell them apart proves nothing.
import http from 'node:http';

const MODE = process.argv[2] ?? '503';
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/auth/login')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'control-token' }));
    return;
  }
  if (MODE === '404') { res.writeHead(404).end('{}'); return; }
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'service restarting' }));
});
server.listen(4399, '127.0.0.1', () => console.error(`control server up, mode=${MODE}`));
