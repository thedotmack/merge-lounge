// Crash test. Starts its own server, then throws odd input at it: 234 malformed WebSocket messages
// (one connection each, after a valid hello) and a set of raw HTTP requests that once crashed or
// confused Node servers. After every case the process must still be running and /api/status must answer.
import net from 'node:net';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { sleep, makeState, startServer, recorder, cleanup } from './helpers.mjs';

const R = recorder('fuzz test');
let st, srv, port; // set up inside the try below, so a failed start still cleans up

async function healthy() {
  if (!srv?.alive()) return false;
  try { const r = await fetch(`${srv.base}/api/status`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}

// ---------------------------------------------------------------- WebSocket shapes
const vals = [
  null, true, 0, -1, 1e308, -1e308, 1.5, '', 'x', 'a'.repeat(3000), [], [1, 2], {}, { toString: 1 }, { valueOf: 1, toString: 1 },
  { __proto__: null }, JSON.parse('{"__proto__":{"x":1}}'), { constructor: 1 }, { length: 1e9 }, ['__proto__'],
];
const fields = {
  hello: ['token'], ping: ['ts'], move: ['x', 'y'], use: ['fid'], chat: ['text'], typing: ['on'],
  emote: ['e'], react: ['r'], look: ['look'],
};
const shapes = [];
for (const [t, fs] of Object.entries(fields)) for (const f of fs) for (const v of vals) shapes.push({ t, [f]: v });
for (const v of vals) shapes.push({ t: 'look', look: { skin: v, hairStyle: v, acc: v, bot: true } });
shapes.push({ t: 'move', x: { valueOf: 1 }, y: 2 });
shapes.push({ t: 'move', x: '3', y: '3' });
const raws = ['null', '1', '"s"', '[]', '[{"t":"chat"}]', '{"t":1}', '{"t":{"toString":1}}', '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"toString"}', 'not json', '\u0000'];
const wsCases = [...shapes.map((s) => JSON.stringify(s)), ...raws];

function runWsCase(payload) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let done = false;
    const fin = () => { if (!done) { done = true; try { ws.close(); } catch { /* ignore */ } resolve(); } };
    ws.onopen = () => {
      if (payload.includes('"t":"hello"')) { ws.send(payload); setTimeout(fin, 200); return; }
      ws.send(JSON.stringify({ t: 'hello', token: st.tokens['test-z'] }));
      setTimeout(() => { try { ws.send(payload); } catch { /* ignore */ } setTimeout(fin, 150); }, 120);
    };
    ws.onerror = fin;
    ws.onclose = fin;
    setTimeout(fin, 1500);
  });
}

// ---------------------------------------------------------------- raw HTTP
function raw(req, ms = 1500) {
  return new Promise((resolve) => {
    let out = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(req));
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    setTimeout(() => { s.destroy(); resolve(out); }, ms);
  });
}
const key = () => crypto.randomBytes(16).toString('base64');
const post = (p, body, extra = '') => `POST ${p} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n${body}`;
const big = JSON.stringify({ login: 'a'.repeat(10_000) });
const rawCases = [
  ['GET //[', 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ['GET /%', 'GET /% HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ['GET /%00', 'GET /%00 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ['GET /shared/%2e%2e/server.js', 'GET /shared/%2e%2e/server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ['upgrade with a bad URL', `GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key()}\r\n\r\n`],
  ['upgrade to another path', `GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key()}\r\n\r\n`],
  ['upgrade with a junk key', 'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: !!\r\n\r\n'],
  ['upgrade with a huge Fly-Client-IP', `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key()}\r\nFly-Client-IP: ${'9'.repeat(8000)}\r\n\r\n`],
  ['start with a null body', post('/api/auth/start', 'null')],
  ['start with an array body', post('/api/auth/start', '[]')],
  ['start with a string body', post('/api/auth/start', '"s"')],
  ['start with a number body', post('/api/auth/start', '123')],
  ['start with broken JSON', post('/api/auth/start', '{"login":')],
  ['start with login as an object', post('/api/auth/start', '{"login":{"toString":1}}')],
  ['start with __proto__', post('/api/auth/start', '{"__proto__":{"login":"test-member"},"login":"__proto__"}')],
  ['verify with a null body', post('/api/auth/verify', 'null')],
  ['verify with an array body', post('/api/auth/verify', '[]')],
  ['verify with nonce as an object', post('/api/auth/verify', '{"login":"test-member","nonce":{"length":1}}')],
  ['logout with a junk bearer', post('/api/logout', '{}', `Authorization: Bearer ${'x'.repeat(5000)}\r\n`)],
  ['oversized body', post('/api/auth/start', big)],
  ['body shorter than Content-Length', 'POST /api/auth/start HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"lo'],
  ['DELETE /api/config', 'DELETE /api/config HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
  ['POST to a static file', post('/index.html', '{}')],
  ['fame with a junk token', 'GET /api/fame HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ÿþ\r\nConnection: close\r\n\r\n'],
  ['header with a huge X-Forwarded-For', `GET /api/status HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${'1.2.3.4, '.repeat(800)}\r\nConnection: close\r\n\r\n`],
  ['garbage instead of HTTP', '\u0000\u0001\u0002 hello\r\n\r\n'],
];

try {
  st = makeState({
    config: { repo: 'example-org/fuzz-target', bot: { name: 'fuzzbot' } },
    snapshot: { repo: 'example-org/fuzz-target', generated: new Date().toISOString(), total_merged_prs: 3, contributors: [{ login: 'test-member', merged: 3, first: '2026-01-01', last: '2026-01-02' }] },
    testLogins: ['test-z'],
  });
  srv = await startServer({ stateDir: st.stateDir, configPath: st.configPath, env: { ADMINS: 'test-z' } });
  port = srv.port;
  ok0: {
    const before = await healthy();
    R.ok('server up before fuzzing', before);
    if (!before) break ok0;
    const wsCrashes = [];
    for (const p of wsCases) {
      await runWsCase(p);
      await sleep(40);
      if (!(await healthy())) { wsCrashes.push(p.slice(0, 120)); break; }
    }
    R.ok(`WebSocket fuzz: ${wsCases.length} shapes, 0 crashes`, wsCrashes.length === 0 && wsCases.length === 234, wsCrashes.length ? 'CRASH: ' + wsCrashes[0] : `${wsCases.length} cases`);
    for (const [name, req] of rawCases) {
      const out = await raw(req);
      const status = (/^HTTP\/1\.1 (\d{3})/.exec(out) || [])[1] || 'closed';
      const fine = await healthy();
      R.ok(`raw: ${name} (→ ${status})`, fine, fine ? '' : 'server stopped answering');
      if (!fine) break;
    }
    const leak = await raw('GET /shared/%2e%2e/server.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    R.ok('raw: no source leaks through /shared/', !leak.includes('GITHUB_TOKEN'));
    const big413 = await raw(post('/api/auth/start', big));
    R.ok('raw: oversized body gets 413', /^HTTP\/1\.1 413/.test(big413), big413.slice(0, 40));
  }
} catch (e) {
  R.ok('fuzz test ran to the end', false, e.stack || e.message);
} finally {
  R.ok('server process still running at the end', !!srv?.alive());
  await srv?.stop();
  if (st) cleanup(st.dir);
}
const fails = R.report();
if (fails && srv) console.log(srv.log.join('').slice(-2000));
process.exit(fails ? 1 : 0);
