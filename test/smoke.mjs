// End-to-end smoke test. Starts its own server (temp state folder, free port, a test config and a tiny
// fake contributor snapshot), mints test-* sessions, then checks HTTP, check-in and the room.
// OFFLINE=1 skips only the checks that need GitHub. Exit code 1 if anything fails.
//
//   node test/smoke.mjs
//   SMOKE_REPO / SMOKE_MEMBER / SMOKE_STRANGER override the GitHub-backed checks (default: the repo and
//   first admin from lounge.config.json, and torvalds as someone who isn't a contributor).
import {
  OFFLINE, sleep, committedConfig, makeState, startServer, getJson, postJson, Client, recorder, cleanup,
} from './helpers.mjs';

const R = recorder('smoke test');
const { ok, skip } = R;
const committed = committedConfig();
const REPO = process.env.SMOKE_REPO || committed.repo || 'octocat/hello-world';
const MEMBER = process.env.SMOKE_MEMBER || (committed.admins || [])[0] || '';
const STRANGER = process.env.SMOKE_STRANGER || 'torvalds';
const BOT = 'lobby-bot';
const MENTIONS = ['beep from the test config.', 'boop from the test config.'];
const testConfig = {
  repo: REPO,
  loungeName: 'Smoke Lounge',
  project: { name: 'smoke-project', tagline: 'a project for testing' },
  admins: ['config-admin'], // ADMINS=test-admin overrides this
  neon: { top: 'SMOKE', bottom: 'TEST' },
  blimp: 'SMOKE',
  codePrefix: 'smoke-lounge',
  bot: {
    name: BOT,
    greet: ['hi @{login}, {merged:merged PR} on file.'],
    mention: MENTIONS,
    gong: ['gong line from the test config.'],
  },
  allow: ['test-guest'],
  minMergedPRs: 2,
};
const snapshot = {
  repo: REPO, generated: new Date().toISOString(), total_merged_prs: 42,
  contributors: [
    { login: 'test-member', merged: 7, first: '2026-01-02', last: '2026-03-04' },
    { login: 'test-solo', merged: 1, first: '2026-02-02', last: '2026-02-02' },
  ],
};
const names = ['test-ada', 'test-bob', 'test-cy'];
const st = makeState({ config: testConfig, snapshot, testLogins: [...names, 'test-admin', 'test-dee'] });
const tokens = st.tokens;
const srv = await startServer({ stateDir: st.stateDir, configPath: st.configPath, env: { ADMINS: 'test-admin' } });
const BASE = srv.base;
const clients = [];
const client = (login) => { const c = new Client(srv.ws, tokens[login]); clients.push(c); return c; };

try {
  // ---------------------------------------------------------------- HTTP
  const s0 = await getJson(BASE, '/api/status');
  ok('status has numbers', s0.j?.contributors === 2 && s0.j?.mergedPRs >= 42, JSON.stringify(s0.j));
  ok('status: snapshot ready', s0.j?.snapshot === 'ready', s0.j?.snapshot);

  const cfgRes = await fetch(BASE + '/api/config');
  const cfgText = await cfgRes.text();
  let cfg = {};
  try { cfg = JSON.parse(cfgText); } catch { /* checked below */ }
  ok('/api/config serves the lounge config', cfgRes.status === 200 && cfg.repo === REPO && cfg.loungeName === 'Smoke Lounge'
    && cfg.bot?.name === BOT && cfg.codePrefix === 'smoke-lounge' && cfg.neon?.top === 'SMOKE' && cfg.project?.name === 'smoke-project', cfgText.slice(0, 160));
  ok('/api/config leaks no admins or allow list', !('admins' in cfg) && !('allow' in cfg) && !/test-admin|config-admin|test-guest/.test(cfgText));
  ok('/api/config leaks no bot script', !cfgText.includes(MENTIONS[0]) && !('mention' in (cfg.bot || {})));

  const idx = await fetch(BASE + '/');
  const idxHtml = await idx.text();
  ok('index served with CSP', idx.status === 200 && /script-src 'self'/.test(idx.headers.get('content-security-policy') || ''));
  ok('config is not inlined into the page', !idxHtml.includes('smoke-project') && !/<script>(?!<\/script>)/.test(idxHtml));
  for (const f of ['/app.js', '/engine.js', '/style.css', '/favicon.svg', '/fonts/silkscreen-latin-400-normal.woff2', '/shared/world.js', '/shared/config.js']) {
    const r = await fetch(BASE + f);
    ok('serves ' + f, r.status === 200, r.headers.get('content-type'));
  }
  const sharedCfg = await (await fetch(BASE + '/shared/config.js')).text();
  ok('/shared/config.js is browser-safe (no imports)', /^export const DEFAULTS/m.test(sharedCfg) && !/^import /m.test(sharedCfg), 'content-type javascript');
  const trav = await fetch(BASE + '/../server.js');
  ok('no path traversal', trav.status !== 200 || !(await trav.text()).includes('GITHUB_TOKEN'));
  const trav2 = await fetch(BASE + '/%2e%2e/server.js');
  ok('no encoded traversal', trav2.status !== 200 || !(await trav2.text()).includes('GITHUB_TOKEN'));
  const trav3 = await fetch(BASE + '/shared/%2e%2e/server.js');
  ok('no traversal via /shared/', trav3.status !== 200 || !(await trav3.text()).includes('GITHUB_TOKEN'));
  const fameNoAuth = await fetch(BASE + '/api/fame');
  ok('fame needs auth', fameNoAuth.status === 401, String(fameNoAuth.status));

  // ---------------------------------------------------------------- check-in
  const a1 = await postJson(BASE, '/api/auth/start', { login: 'test-member' });
  ok('start: snapshot contributor gets a code with the config prefix', a1.j?.ok && /^smoke-lounge-[A-Z2-9]{6}$/.test(a1.j.code) && a1.j.merged === 7, JSON.stringify(a1.j));
  const a2 = await postJson(BASE, '/api/auth/start', { login: 'https://github.com/TEST-member' });
  ok('start: accepts a profile URL, any case', a2.j?.ok && a2.j.login === 'test-member', JSON.stringify(a2.j));
  const a3 = await postJson(BASE, '/api/auth/start', { login: 'test-solo' });
  ok('start: under minMergedPRs is turned away', a3.status === 403 && a3.j?.reason === 'not-contributor', JSON.stringify(a3.j));
  const a4 = await postJson(BASE, '/api/auth/start', { login: '@test-guest' });
  ok('start: allow-listed login gets a code', a4.j?.ok && a4.j.login === 'test-guest' && a4.j.merged === 0, JSON.stringify(a4.j));
  const a5 = await postJson(BASE, '/api/auth/start', { login: 'bad login!!' });
  ok('start: bad login rejected', a5.status === 400 && a5.j?.reason === 'bad-login', JSON.stringify(a5.j));
  const v2 = await postJson(BASE, '/api/auth/verify', { login: 'test-member' });
  ok('verify: someone without the nonce is refused', v2.j && !v2.j.token && v2.j.reason === 'no-challenge', JSON.stringify(v2.j));
  const v3 = await postJson(BASE, '/api/auth/verify', { login: 'test-guest', nonce: a2.j?.nonce });
  ok('verify: a nonce only works for its own login', v3.j && v3.j.reason === 'no-challenge', JSON.stringify(v3.j));
  const a6 = await postJson(BASE, '/api/auth/start', { login: 'test-member', nonce: a2.j?.nonce });
  ok('start: same browser keeps the same code', a6.j?.code === a2.j?.code && a6.j?.nonce === a2.j?.nonce);
  const a7 = await postJson(BASE, '/api/auth/start', { login: 'test-member' });
  ok('start: another browser gets a different code', a7.j?.ok && a7.j.code !== a2.j?.code);
  if (OFFLINE || !MEMBER) {
    for (const n of ['start: real contributor gets a code (live GitHub lookup)', 'start: non-contributor is turned away (live lookup)', 'verify: no gist yet means no token']) skip(n, OFFLINE ? 'needs GitHub' : 'no SMOKE_MEMBER');
  } else {
    const g1 = await postJson(BASE, '/api/auth/start', { login: MEMBER });
    ok('start: real contributor gets a code (live GitHub lookup)', g1.j?.ok && /^smoke-lounge-/.test(g1.j.code) && g1.j.merged >= 2, JSON.stringify(g1.j));
    const g2 = await postJson(BASE, '/api/auth/start', { login: STRANGER });
    ok('start: non-contributor is turned away (live lookup)', g2.j && !g2.j.ok && g2.j.reason === 'not-contributor', JSON.stringify(g2.j));
    const g3 = await postJson(BASE, '/api/auth/verify', { login: 'test-member', nonce: a2.j?.nonce });
    ok('verify: no gist yet means no token', g3.j && !g3.j.token && g3.j.reason === 'not-found-yet', JSON.stringify(g3.j));
  }

  // ---------------------------------------------------------------- the room
  const bad = new Client(srv.ws, 'x'.repeat(32));
  const badRes = await bad.open();
  ok('bad token refused', badRes.t === 'auth' && badRes.ok === false);

  const [A, B, C] = names.map(client);
  const wA = await A.open();
  ok('A welcome', wA.t === 'welcome' && wA.you.id === names[0], JSON.stringify(wA.you));
  ok('the bot is in the room under its config name', wA.users?.some((u) => u.npc && u.login === BOT));
  const wB = await B.open();
  const wC = await C.open();
  ok('B, C welcome', wB.t === 'welcome' && wC.t === 'welcome');
  ok('A sees B join', !!(await A.wait((m) => m.t === 'join' && m.user.id === names[1])));
  ok('A sees C join', !!(await A.wait((m) => m.t === 'join' && m.user.id === names[2])));
  ok('walk-in from the door', !!(await B.wait((m) => m.t === 'path' && m.id === names[0], 3000)));
  const greet = await A.wait((m) => m.t === 'chat' && m.login === BOT && /^hi @test-ada/.test(m.text || ''), 5000);
  ok('bot greets first-timers with the config line', greet?.text === 'hi @test-ada, 0 merged PRs on file.', greet?.text);

  await sleep(1500);
  A.send({ t: 'move', x: 8, y: 6 });
  const pth = await C.wait((m) => m.t === 'path' && m.id === names[0] && m.path?.some?.(([x, y]) => x === 8 && y === 6));
  ok('A walks, C sees path to (8,6)', !!pth, pth ? JSON.stringify(pth.path) : '');
  A.send({ t: 'move', x: 99, y: 99 });

  A.send({ t: 'typing', on: true });
  ok('typing indicator reaches B', !!(await B.wait((m) => m.t === 'typing' && m.id === names[0] && m.on)));
  A.send({ t: 'chat', text: 'hello from the smoke test ‮ evil' });
  const ch = await B.wait((m) => m.t === 'chat' && m.login === names[0] && /hello from the smoke test/.test(m.text));
  ok('chat reaches B', !!ch, ch?.text);
  ok('bidi control stripped', ch && !/‮/.test(ch.text));
  ok('chat reaches C', !!(await C.wait((m) => m.t === 'chat' && m.login === names[0])));

  B.send({ t: 'chat', text: '/w @' + names[0] + ' psst secret' });
  ok('whisper reaches A', !!(await A.wait((m) => m.t === 'chat' && m.kind === 'whisper' && /psst/.test(m.text))));
  ok('whisper echoes to B', !!(await B.wait((m) => m.t === 'chat' && m.kind === 'whisper' && /psst/.test(m.text))));
  await sleep(600);
  ok('whisper hidden from C', !C.has((m) => m.t === 'chat' && /psst/.test(m.text || '')));

  C.send({ t: 'chat', text: '/me tests the lounge' });
  ok('/me works', !!(await A.wait((m) => m.t === 'chat' && m.kind === 'me' && /tests the lounge/.test(m.text))));
  C.send({ t: 'chat', text: '/who' });
  const who = await C.wait((m) => m.t === 'notice' && /inside:/.test(m.text));
  ok('/who lists 3', !!who && (who.text.match(/@/g) || []).length === 3, who?.text);
  C.send({ t: 'chat', text: '/stats' });
  const sts = await C.wait((m) => m.t === 'chat' && m.login === BOT && /merged contributors/.test(m.text || ''), 8000);
  ok('/stats answered by the bot', !!sts, sts?.text);
  await sleep(4500);
  const mark = B.msgs.length;
  B.send({ t: 'chat', text: `hey ${BOT}, you there?` });
  const ans = await B.wait((m) => m.t === 'chat' && m.npc && m.login === BOT && !/^hi @|merged/.test(m.text), 7000, mark);
  ok('bot answers a mention with a config line', !!ans && MENTIONS.includes(ans.text), ans?.text);

  B.send({ t: 'react', r: '🔥' });
  ok('reaction broadcast', !!(await A.wait((m) => m.t === 'react' && m.id === names[1] && m.r === '🔥')));
  B.send({ t: 'react', r: 'not-an-emoji' });
  B.send({ t: 'emote', e: 'wave' });
  ok('wave gesture', !!(await A.wait((m) => m.t === 'gesture' && m.id === names[1] && m.g === 'wave')));
  B.send({ t: 'emote', e: 'dance' });
  ok('dance pose', !!(await A.wait((m) => m.t === 'state' && m.id === names[1] && m.pose === 'dance', 4000)));

  C.send({ t: 'chat', text: '/gong' });
  const fx = await A.wait((m) => m.t === 'fx' && m.kind === 'gong', 15000);
  ok('/gong walks over and rings for everyone', !!fx);

  C.send({ t: 'use', fid: 'fridge' });
  await sleep(200);
  A.send({ t: 'look', look: { hair: 'nope', top: 1234, bot: true } });
  const lk = await B.wait((m) => m.t === 'look' && m.id === names[0]);
  ok('look sanitized broadcast', !!lk && !lk.look.bot, JSON.stringify(lk?.look));

  A.send({ t: 'ping', ts: 42 });
  ok('ping/pong', !!(await A.wait((m) => m.t === 'pong' && m.ts === 42)));

  // ---------------------------------------------------------------- admin
  const D = client('test-admin');
  const wD = await D.open();
  ok('ADMINS env makes test-admin an admin', wD.t === 'welcome' && wD.you?.admin === true, JSON.stringify(wD.you));
  D.send({ t: 'chat', text: '/ban __proto__' });
  ok('/ban __proto__ refused', !!(await D.wait((m) => m.t === 'notice' && /cannot ban/.test(m.text))));
  D.send({ t: 'chat', text: '/mute __proto__ 60' });
  ok('/mute __proto__ refused', !!(await D.wait((m) => m.t === 'notice' && /no such visitor/.test(m.text))));
  D.send({ t: 'chat', text: '/purge' });
  ok('/purge with no name refused', !!(await D.wait((m) => m.t === 'notice' && /purge whom/.test(m.text))));
  D.send({ t: 'chat', text: '/announce lounge closes at nine' });
  ok('/announce reaches everyone', !!(await A.wait((m) => m.t === 'chat' && m.kind === 'announce' && /closes at nine/.test(m.text))));
  C.send({ t: 'chat', text: '/announce i am not an admin' });
  ok('non-admin /announce refused', !!(await C.wait((m) => m.t === 'notice' && /unknown command/.test(m.text))));
  await sleep(300);
  C.send({ t: 'chat', text: 'still allowed to talk' });
  ok('others can still talk', !!(await D.wait((m) => m.t === 'chat' && /still allowed/.test(m.text || ''))));

  // ---------------------------------------------------------------- limits, tabs, fame, leaving
  for (let i = 0; i < 9; i++) A.send({ t: 'chat', text: 'spam ' + i });
  ok('chat rate limit kicks in', !!(await A.wait((m) => m.t === 'notice' && /slow down/.test(m.text), 3000)));

  const A2 = client('test-ada');
  await A2.open();
  ok('second tab replaces the first', !!(await A.wait((m) => m.t === 'replaced', 3000)));

  const fame = await getJson(BASE, '/api/fame', { Authorization: 'Bearer ' + tokens[names[1]] });
  const logins = (fame.j?.list || []).map((c) => c.login);
  ok('fame list with auth', fame.status === 200 && logins.includes('test-member') && logins.includes('test-solo') && fame.j.total >= 42, logins.join(','));

  const W1 = client('test-dee');
  await W1.open();
  await D.wait((m) => m.t === 'join' && m.user.id === 'test-dee', 3000);
  W1.close();
  await sleep(800);
  const W2 = client('test-dee');
  await W2.open();
  await sleep(800);
  const joins = D.msgs.filter((m) => m.t === 'join' && m.user.id === 'test-dee').length;
  const leaves = D.msgs.filter((m) => m.t === 'leave' && m.id === 'test-dee').length;
  ok('reconnect within grace shows one join', joins === 1 && leaves === 0, `joins=${joins} leaves=${leaves}`);
  W2.send({ t: 'move', x: '3', y: 3 }); W2.send({ t: 'move', x: { toString: 1 }, y: 1 }); W2.send({ t: 'move', x: 1.5, y: 2 });
  await sleep(300);
  W2.send({ t: 'move', x: 8, y: 7 });
  ok('valid move after junk still works', !!(await D.wait((m) => m.t === 'path' && m.id === 'test-dee' && m.path.some(([a, b]) => a === 8 && b === 7), 4000)));

  B.close();
  ok('leave broadcast after grace', !!(await C.wait((m) => m.t === 'leave' && m.id === names[1], 9000)));
  const st1 = await getJson(BASE, '/api/status');
  ok('server still answering after the room checks', st1.status === 200 && srv.alive());
} catch (e) {
  ok('smoke test ran to the end', false, e.stack || e.message);
} finally {
  for (const c of clients) c.close();
  await srv.stop();
  cleanup(st.dir);
}

// ---------------------------------------------------------------- snapshots for another repo are never used
for (const [label, snap] of [
  ['snapshot for another repo', { ...snapshot, repo: 'someone-else/other-repo' }],
  ['snapshot with no repo field', { generated: snapshot.generated, total_merged_prs: 42, contributors: snapshot.contributors }],
]) {
  const st2 = makeState({ config: testConfig, snapshot: snap });
  let srv2;
  try {
    srv2 = await startServer({ stateDir: st2.stateDir, configPath: st2.configPath, env: { ADMINS: 'test-admin' } });
    const s = await getJson(srv2.base, '/api/status');
    ok(`${label}: status says it is rebuilding, not ready`, ['building', 'missing'].includes(s.j?.snapshot) && s.j?.contributors === 0, JSON.stringify(s.j));
    const r = await postJson(srv2.base, '/api/auth/start', { login: 'test-member' });
    ok(`${label}: its people are not let in from it`, r.j && r.j.ok !== true, `${r.status} ${JSON.stringify(r.j)}`);
    await sleep(300);
    ok(`${label}: a background rebuild was started`, /rebuilding the snapshot for/.test(srv2.log.join('')), srv2.log.join('').split('\n').filter((l) => /contributors:/.test(l)).slice(0, 2).join(' | '));
  } catch (e) {
    ok(`${label}: ran`, false, e.message);
  } finally {
    await srv2?.stop();
    cleanup(st2.dir);
  }
}

const fails = R.report();
process.exit(fails ? 1 : 0);
