// Shared bits for the end-to-end tests: start a throwaway server with its own state folder, mint
// test sessions for it, talk to it over HTTP and WebSocket, and shut it down again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OFFLINE = process.env.OFFLINE === '1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The repo's own config (for the GitHub-backed checks: its repo and first admin are real).
export function committedConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'lounge.config.json'), 'utf8')); } catch { return {}; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
// A free port. TEST_PORTS=8401-8409 keeps the tests inside a range.
export async function freePort() {
  const m = /^(\d+)-(\d+)$/.exec(process.env.TEST_PORTS || '');
  if (m) {
    for (let p = Number(m[1]); p <= Number(m[2]); p++) if (await portFree(p)) return p;
    throw new Error(`no free port in TEST_PORTS=${process.env.TEST_PORTS}`);
  }
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Make a state folder: optional config file, optional snapshot, and test-* sessions minted before the
// server starts (so a pending server save can't overwrite them).
export function makeState({ config, snapshot, testLogins = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lounge-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  let configPath = '';
  if (config) { configPath = path.join(dir, 'lounge.config.json'); fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); }
  if (snapshot) fs.writeFileSync(path.join(stateDir, 'contributors.json'), JSON.stringify(snapshot));
  let tokens = {};
  if (testLogins.length) {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'mint-session.js'), ...testLogins], {
      env: { ...process.env, STATE_DIR: stateDir }, encoding: 'utf8',
    });
    tokens = JSON.parse(out.trim().split('\n').pop());
  }
  return { dir, stateDir, configPath, tokens };
}

export async function startServer({ stateDir, configPath, env = {} }) {
  const port = await freePort();
  const childEnv = { ...process.env, PORT: String(port), STATE_DIR: stateDir, ...env };
  delete childEnv.REPO; // the test config decides the repo
  delete childEnv.REFRESH_ON_START;
  delete childEnv.CLIENT_IP_HEADER;
  if (configPath) childEnv.CONFIG_PATH = configPath;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => log.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const srv = {
    port, base, child, log,
    ws: `ws://127.0.0.1:${port}/ws`,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      if (srv.alive()) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([gone, sleep(5000)]);
        if (srv.alive()) child.kill('SIGKILL');
      }
    },
  };
  for (let i = 0; i < 100; i++) {
    if (!srv.alive()) throw new Error(`server exited early:\n${log.join('')}`);
    try { const r = await fetch(base + '/api/status'); if (r.ok) return srv; } catch { /* not up yet */ }
    await sleep(100);
  }
  await srv.stop();
  throw new Error(`server did not start:\n${log.join('')}`);
}

export async function getJson(base, p, headers = {}) {
  const r = await fetch(base + p, { headers });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j, headers: r.headers };
}
export async function postJson(base, p, body, headers = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, j };
}

export class Client {
  constructor(url, token) { this.url = url; this.token = token; this.msgs = []; }
  open() {
    return new Promise((resolve) => {
      const ws = this.ws = new WebSocket(this.url);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: this.token }));
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        this.msgs.push(m);
        if (m.t === 'welcome' || m.t === 'auth' || m.t === 'kicked') resolve(m);
      };
      ws.onerror = () => resolve({ t: 'error' });
      ws.onclose = (ev) => { this.closed = ev.code; resolve({ t: 'closed', code: ev.code }); };
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* closed */ } }
  async wait(pred, ms = 8000, from = 0) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = this.msgs.slice(from).find(pred); if (m) return m; await sleep(40); }
    return null;
  }
  has(pred) { return this.msgs.some(pred); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// A small pass/fail recorder that prints a summary and sets the exit code.
export function recorder(title) {
  const results = [];
  const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); return !!cond; };
  const skip = (name, why) => results.push(['SKIP', name, why]);
  const report = () => {
    console.log(`\n${title}`);
    for (const r of results) console.log(r[0], '·', r[1], r[2] ? '· ' + String(r[2]).slice(0, 200) : '');
    const fails = results.filter((r) => r[0] === 'FAIL').length;
    const passes = results.filter((r) => r[0] === 'PASS').length;
    const skips = results.length - fails - passes;
    console.log(`${passes} passed, ${fails} failed${skips ? `, ${skips} skipped (OFFLINE=1)` : ''}`);
    return fails;
  };
  return { ok, skip, report, results };
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
