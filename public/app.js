import { Engine } from './engine.js';
import { Valley, localHour, skyAt } from './valley.js';
import { makeCanvas } from './pixel.js';
import { avatarSprite } from './avatar.js';
import { LOOK, REACTIONS, FURNITURE, defaultLook, hash32 } from '/shared/world.js';
import { resolveConfig, defaultConfig, slug } from '/shared/config.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TOKEN_KEY = 'mergeLounge.token';
const LOGIN_KEY = 'mergeLounge.login';
const CHALLENGE_KEY = 'mergeLounge.challenge'; // survives a reload while someone is off making their gist
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '');

function toast(text, ms = 3200) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}

// =================================================================== lounge config
// Everything project-specific (names, links, the sign) comes from GET /api/config. If that fails the
// page still works with the built-in defaults.
let CFG = defaultConfig();
async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout?.(5000) });
    if (res.ok) CFG = resolveConfig(await res.json()).config;
  } catch { /* keep the defaults */ }
  applyConfig();
}
const githubUrl = () => (CFG.repo ? `https://github.com/${CFG.repo}` : CFG.project.url);
const prsUrl = (login) => `${githubUrl()}/pulls?q=is%3Apr+is%3Amerged+author%3A${encodeURIComponent(login)}`;
function setLink(a, href, text) {
  if (href) a.href = href; else a.removeAttribute('href');
  if (text !== undefined) a.textContent = text;
}
function applyConfig() {
  const c = CFG, proj = c.project.name;
  document.title = `${c.loungeName} · ${proj}`;
  $('meta[name="description"]')?.setAttribute('content', `A pixel hangout for everyone with a merged PR in ${proj}.`);
  if (/^#[0-9a-f]{6}$/i.test(c.theme.accent)) document.documentElement.style.setProperty('--accent', c.theme.accent);
  const [w1, ...rest] = c.loungeName.toUpperCase().split(/\s+/);
  $('#landTitle').setAttribute('aria-label', c.loungeName);
  $('#landT1').textContent = w1;
  $('#landT2').textContent = rest.join(' ');
  $('#brandName').textContent = c.loungeName.toUpperCase();
  for (const el of $$('.cfg-project')) el.textContent = proj;
  for (const el of $$('.cfg-city')) el.textContent = c.skyline.city;
  for (const a of $$('a.cfg-repo')) setLink(a, c.project.url, proj);
  setLink($('#findIssue'), githubUrl() ? `${githubUrl()}/issues` : '');
  const onGitHub = /^https:\/\/github\.com\//i.test(c.project.url);
  for (const a of $$('a.cfg-home')) setLink(a, c.project.url, onGitHub ? `${proj} on GitHub` : `${proj} ↗`);
}
const botName = () => CFG.bot.name;
const rackLabel = (f) => `${botName().toUpperCase()}-${String(f?.label || '').match(/\d+$/)?.[0] || '01'}`;

async function api(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  let j = {};
  try { j = await res.json(); } catch { /* not json */ }
  return { status: res.status, ...j };
}

// =================================================================== landing
let heroStop = null;
function startHero() {
  const cv = $('#hero');
  const ctx = cv.getContext('2d');
  const valley = new Valley(7331, { names: CFG.skyline.names, billboards: CFG.skyline.billboards, blimp: CFG.blimp, timezone: CFG.timezone });
  const [buf, bg] = makeCanvas(2, 2);
  let running = true;
  const frame = () => {
    if (!running) return;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const Wd = Math.max(2, Math.round(r.width * dpr)), Hd = Math.max(2, Math.round(r.height * dpr));
    if (cv.width !== Wd || cv.height !== Hd) { cv.width = Wd; cv.height = Hd; }
    // scale by the short side so phones get a wide slice of the city, anchored to the bottom
    const s = Math.max(2, Math.round(Math.min(Hd / 200, Wd / 150)));
    const bw = Math.ceil(Wd / s), fullH = Math.ceil(Hd / s);
    const bh = Math.min(fullH, Math.max(150, Math.round(bw * 0.95)));
    if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; bg.imageSmoothingEnabled = false; }
    const hour = localHour(CFG.timezone);
    valley.render(bg, bw, bh, Date.now(), { speed: 10, hour });
    ctx.imageSmoothingEnabled = false;
    const top = (fullH - bh) * s;
    if (top > 0) { ctx.fillStyle = skyAt(hour).top; ctx.fillRect(0, 0, Wd, top + s); }
    ctx.drawImage(buf, 0, top, bw * s, bh * s);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => { running = false; };
}

function showLanding(message) {
  $('#room').hidden = true;
  $('#landing').hidden = false;
  if (!heroStop) heroStop = startHero();
  showStep('step1');
  const saved = ls.get(LOGIN_KEY);
  if (saved && !$('#gh').value) $('#gh').value = saved;
  if (message) $('#err1').textContent = message;
  refreshLive();
}

async function refreshLive() {
  try {
    const s = await api('/api/status');
    $('#liveOnline').textContent = fmt(s.online);
    $('#liveContrib').textContent = fmt(s.contributors);
    $('#livePRs').textContent = fmt(s.mergedPRs);
  } catch { /* offline */ }
}

function showStep(id) {
  for (const s of ['step1', 'step2', 'stepNo']) $('#' + s).hidden = s !== id;
}

let challenge = null;
$('#step1').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('#gh').value.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
  if (!raw) return;
  $('#err1').textContent = '';
  const btn = $('#checkBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    let prev = null;
    try { prev = JSON.parse(ls.get(CHALLENGE_KEY) || 'null'); } catch { /* ignore */ }
    const nonce = prev && String(prev.login).toLowerCase() === raw.toLowerCase() ? prev.nonce : undefined;
    const r = await api('/api/auth/start', { login: raw, nonce });
    if (r.ok) {
      challenge = r;
      ls.set(LOGIN_KEY, r.login);
      ls.set(CHALLENGE_KEY, JSON.stringify({ login: r.login, nonce: r.nonce }));
      $('#foundLogin').textContent = '@' + r.login;
      $('#foundCount').textContent = `${fmt(r.merged)} merged PR${r.merged === 1 ? '' : 's'}`;
      $('#code').textContent = r.code;
      $('#cli').textContent = `echo ${r.code} | gh gist create --public -d ${r.code} -f ${slug(CFG.loungeName) || 'lounge'}.txt -`;
      $('#status2').textContent = '';
      $('#status2').className = 'status';
      showStep('step2');
    } else if (r.reason === 'not-contributor') {
      $('#noLogin').textContent = '@' + (r.login || raw);
      showStep('stepNo');
    } else if (r.reason === 'bad-login') {
      $('#err1').textContent = "That doesn't look like a GitHub username.";
    } else if (r.reason === 'banned') {
      $('#err1').textContent = "This account can't check in.";
    } else if (r.reason === 'slow-down') {
      $('#err1').textContent = 'Easy — too many tries. Give it a minute.';
    } else {
      $('#err1').textContent = "GitHub didn't answer just now. Try again in a minute.";
    }
  } catch {
    $('#err1').textContent = "Couldn't reach the lounge. Check your connection.";
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check in';
  }
});

$('#backBtn').addEventListener('click', () => { verifying = false; showStep('step1'); $('#gh').focus(); });
$('#noBack').addEventListener('click', () => { showStep('step1'); $('#gh').select(); });
for (const t of $$('.tab')) {
  t.addEventListener('click', () => {
    for (const x of $$('.tab')) { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); }
    $('#tab-cli').hidden = t.dataset.tab !== 'cli';
    $('#tab-web').hidden = t.dataset.tab !== 'web';
  });
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = $('#' + b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
  catch {
    const r = document.createRange(); r.selectNodeContents($('#' + b.dataset.copy));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    b.textContent = 'Selected — copy it';
  }
  setTimeout(() => { b.textContent = b.dataset.copy === 'cli' ? 'Copy command' : 'Copy'; }, 1800);
});

let verifying = false;
$('#verifyBtn').addEventListener('click', async () => {
  if (!challenge || verifying) return;
  verifying = true;
  const btn = $('#verifyBtn'), st = $('#status2');
  btn.disabled = true;
  st.className = 'status';
  try {
    for (let i = 0; i < 16 && verifying; i++) {
      st.textContent = i === 0 ? 'Looking for your gist…' : `Not visible yet — GitHub can take up to a minute. Still looking (${i})…`;
      const r = await api('/api/auth/verify', { login: challenge.login, nonce: challenge.nonce });
      if (r.ok && r.token) {
        st.textContent = "You're in. (You can delete that gist now.)";
        st.className = 'status good';
        ls.set(TOKEN_KEY, r.token);
        ls.del(CHALLENGE_KEY);
        await sleep(500);
        enterRoom(r.token);
        return;
      }
      if (r.reason && r.reason !== 'not-found-yet') {
        st.className = 'status bad';
        st.textContent = r.reason === 'no-challenge' ? 'That code expired — go back and check in again.' : r.reason === 'too-many-tries' ? 'Too many tries. Go back and start over.' : r.reason === 'banned' ? "This account can't check in." : r.reason === 'not-contributor' ? `GitHub doesn't show merged ${CFG.project.name} PRs for this account right now.` : 'Something went sideways. Try again.';
        return;
      }
      await sleep(i < 3 ? 4000 : 6000);
    }
    if (verifying) {
      st.className = 'status bad';
      st.textContent = "Still not seeing it. Make sure the gist is public and has the code in it, then tap the button again.";
    }
  } catch {
    st.className = 'status bad';
    st.textContent = "Couldn't reach the lounge. Check your connection and try again.";
  } finally {
    verifying = false;
    btn.disabled = false;
  }
});

// =================================================================== the room
const state = {
  token: null,
  me: null,
  ws: null,
  engine: null,
  connected: false,
  noReconnect: false,
  retries: 0,
  fame: null,
  fameAt: 0,
  unread: 0,
  typing: false,
  typingTimer: null,
  log: [],
};

function userFromServer(p) {
  const u = {
    id: p.id, login: p.login, look: p.look, npc: p.npc, admin: p.admin, merged: p.merged,
    x: p.x, y: p.y, dir: p.dir, pose: p.pose, item: p.item, afk: p.afk, typing: p.typing,
    move: null, corr: null, pendingState: null, gesture: null,
  };
  if (p.path && p.path.length && p.from) u.move = { nodes: [p.from, ...p.path], t0: performance.now(), el: p.elapsed || 0 };
  return u;
}

async function enterRoom(token) {
  state.token = token;
  if (heroStop) { heroStop(); heroStop = null; }
  $('#landing').hidden = true;
  $('#room').hidden = false;
  try { await Promise.race([Promise.all([document.fonts.load('13px "Pixelify Sans"'), document.fonts.load('700 13px "Pixelify Sans"'), document.fonts.load('12px "Silkscreen"')]), sleep(1500)]); } catch { /* fine */ }
  if (!state.engine) setupRoom();
  measureInsets();
  connect();
}

function setupRoom() {
  const engine = state.engine = new Engine($('#stage'), { config: CFG });
  const loop = (t) => { engine.render(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.addEventListener('resize', () => { measureInsets(); });
  window.visualViewport?.addEventListener('resize', () => { measureInsets(); });
  window.visualViewport?.addEventListener('scroll', () => { measureInsets(); });
  setupInput();
  setupDock();
  setupSheets();
  setupWardrobe();
}

function measureInsets() {
  const e = state.engine;
  if (!e) return;
  // keep the chat box above the on-screen keyboard (iOS doesn't resize the layout for us)
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
  $('#dock').style.bottom = kb > 40 ? kb + 'px' : '';
  const top = $('#topbar').getBoundingClientRect().bottom;
  const dock = $('#dock').getBoundingClientRect();
  const h = $('#stage').getBoundingClientRect().height;
  e.insets = { top: Math.max(0, top), bottom: Math.max(0, h - dock.top) };
  e.resize();
}

// ------------------------------------------------------------------ network
function connect() {
  if (state.ws && state.ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host + '/ws');
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', token: state.token }));
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    if (state.noReconnect) return;
    $('#conn').hidden = false;
    const wait = Math.min(15000, 800 * 2 ** Math.min(5, state.retries++)) + Math.random() * 400;
    setTimeout(connect, wait);
  };
  ws.onerror = () => {};
}
function send(m) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(m)); }
setInterval(() => send({ t: 'ping', ts: Date.now() }), 20000);

function handle(m) {
  const e = state.engine;
  switch (m.t) {
    case 'auth':
      if (!m.ok) {
        state.noReconnect = true;
        ls.del(TOKEN_KEY);
        state.ws?.close();
        showLanding('Your session ended — check in again.');
      }
      return;
    case 'welcome': {
      state.connected = true;
      state.retries = 0;
      $('#conn').hidden = true;
      state.me = m.you;
      e.selfId = m.you.id;
      e.users.clear();
      for (const p of m.users) e.users.set(p.id, userFromServer(p));
      setStats(m.stats);
      state.log = [];
      $('#log').innerHTML = '';
      for (const h of m.history) addLog(h, false);
      if (!m.history.length) emptyLog();
      e.joinedAt = performance.now();
      const meU = e.users.get(m.you.id);
      if (meU) e.snapTo(meU.x, meU.y);
      e.follow = true;
      if (!m.you.customized && !state.wardrobeShown) { state.wardrobeShown = true; setTimeout(() => openWardrobe(true), 900); }
      loadFame();
      return;
    }
    case 'join': {
      e.users.set(m.user.id, userFromServer(m.user));
      addLog({ kind: 'event', text: `${m.user.login} walked in`, ts: Date.now() }, false);
      return;
    }
    case 'leave': {
      const u = e.users.get(m.id);
      e.users.delete(m.id);
      if (u) addLog({ kind: 'event', text: `${u.login} headed out`, ts: Date.now() }, false);
      return;
    }
    case 'path': {
      const u = e.users.get(m.id);
      if (!u) return;
      const now = performance.now();
      const before = e.posOf(u, now);
      u.move = { nodes: [m.from, ...m.path], t0: now, el: m.elapsed || 0 };
      u.pose = 'stand';
      u.pendingState = null;
      u.corr = null;
      const after = e.posOf(u, now);
      const dx = before.gx - after.gx, dy = before.gy - after.gy;
      if (Math.abs(dx) + Math.abs(dy) > 0.01 && Math.abs(dx) + Math.abs(dy) < 2.5) u.corr = { dx, dy, t0: now };
      return;
    }
    case 'state': {
      const u = e.users.get(m.id);
      if (!u) return;
      const patch = { pose: m.pose, dir: m.dir };
      if ('item' in m) patch.item = m.item;
      if (u.move) u.pendingState = { ...(u.pendingState || {}), ...patch };
      else { Object.assign(u, patch); if (Number.isInteger(m.x)) { u.x = m.x; u.y = m.y; } }
      return;
    }
    case 'typing': { const u = e.users.get(m.id); if (u) u.typing = m.on; return; }
    case 'afk': { const u = e.users.get(m.id); if (u) u.afk = m.afk; return; }
    case 'look': {
      const u = e.users.get(m.id);
      if (u) u.look = m.look;
      if (m.id === state.me?.id) state.me.look = m.look;
      return;
    }
    case 'gesture': { const u = e.users.get(m.id); if (u) u.gesture = { g: m.g, t0: performance.now() }; return; }
    case 'react': e.addReact(m.id, m.r); return;
    case 'chat': {
      addLog(m, true);
      if (m.kind === 'say' || m.kind === 'me' || m.kind === 'whisper') {
        e.addBubble(m.uid, m.text, m.kind, { npc: !!m.npc, to: m.to });
        const u = e.users.get(m.uid);
        if (u) u.typing = false;
      } else if (m.kind === 'announce') {
        showAnnounce(m.login, m.text);
      } else if (m.kind === 'system' && m.id) {
        toast(m.text, 2600);
      }
      return;
    }
    case 'fx':
      e.addFx(m.kind, { by: m.by });
      if (m.kind === 'deploy') e.addReact(m.by, '🚨');
      return;
    case 'stats': setStats(m.stats); return;
    case 'notice': toast(m.text); return;
    case 'kicked':
      state.noReconnect = true;
      showModal('You got bounced', m.reason || 'An admin removed you from the lounge.', [{ text: 'OK', primary: true, fn: () => hideModal() }]);
      return;
    case 'replaced':
      state.noReconnect = true;
      showModal('Opened somewhere else', 'You checked in from another tab or device, so this one stepped out.', [
        { text: 'Use this tab', primary: true, fn: () => { hideModal(); state.noReconnect = false; connect(); } },
      ]);
      return;
    case 'purge': {
      for (const li of $$('#log li')) if (li.dataset.login === m.login) li.remove();
      e.bubbles = e.bubbles.filter((b) => (b.login || '').toLowerCase() !== m.login);
      return;
    }
    case 'clear': $('#log').innerHTML = ''; emptyLog(); e.bubbles = []; return;
  }
}

function setStats(s) {
  if (!s) return;
  state.engine.stats = s;
  $('#onlineCount').textContent = fmt(s.online);
}

// ------------------------------------------------------------------ chat log
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function colorFor(login) {
  const u = [...state.engine.users.values()].find((x) => x.login === login);
  if (u && u.look && !u.look.bot) return LOOK.topColor[u.look.topColor];
  if (login === botName()) return '#ff9466';
  const look = defaultLook(login || 'x');
  return LOOK.topColor[look.topColor];
}
function emptyLog() {
  const li = document.createElement('li');
  li.innerHTML = '<span class="empty">Quiet in here. Say hi 👋</span>';
  $('#log').appendChild(li);
}
function addLog(m, live) {
  const ol = $('#log');
  ol.querySelector('.empty')?.parentElement.remove();
  const li = document.createElement('li');
  if (m.login) li.dataset.login = String(m.login).toLowerCase();
  const time = document.createElement('time');
  time.textContent = timeFmt.format(new Date(m.ts || Date.now()));
  const body = document.createElement('span');
  const who = (name) => { const b = document.createElement('b'); b.className = 'who'; b.style.setProperty('--c', colorFor(name)); b.textContent = name; return b; };
  if (m.kind === 'say') { body.append(who(m.login), document.createTextNode(' ' + esc(m.text))); }
  else if (m.kind === 'me') { body.className = 'me'; body.append(who(m.login), document.createTextNode(' ' + esc(m.text))); }
  else if (m.kind === 'whisper') { body.className = 'wh'; body.append(who(m.login), document.createTextNode(` → ${m.to}: ${esc(m.text)}`)); }
  else if (m.kind === 'announce') { body.className = 'ann'; body.append(document.createTextNode('📣 ' + esc(m.text))); }
  else if (m.kind === 'event') { body.className = 'ev'; body.textContent = esc(m.text); }
  else { body.className = 'sys'; body.textContent = esc(m.text); }
  li.append(time, body);
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  ol.appendChild(li);
  while (ol.children.length > 300) ol.firstChild.remove();
  if (atBottom || !live) ol.scrollTop = ol.scrollHeight;
  if (live && $('#sheetLog').hidden && (m.kind === 'say' || m.kind === 'me' || m.kind === 'whisper' || m.kind === 'announce')) {
    state.unread++;
    $('#logBadge').hidden = false;
    $('#logBadge').textContent = state.unread > 99 ? '99+' : String(state.unread);
  }
}

function showAnnounce(login, text) {
  const el = $('#announce');
  el.innerHTML = '';
  const s = document.createElement('small');
  s.textContent = `ANNOUNCEMENT · @${login}`;
  el.append(s, document.createTextNode(text));
  el.hidden = false;
  clearTimeout(showAnnounce.t);
  showAnnounce.t = setTimeout(() => { el.hidden = true; }, 12000);
}

// ------------------------------------------------------------------ input on the stage
function setupInput() {
  const cv = $('#stage');
  const e = state.engine;
  const pointers = new Map();
  let drag = null, pinch = null;
  const pos = (ev) => { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  cv.addEventListener('pointerdown', (ev) => {
    cv.setPointerCapture(ev.pointerId);
    const [x, y] = pos(ev);
    pointers.set(ev.pointerId, { x, y });
    if (pointers.size === 1) drag = { x0: x, y0: y, x, y, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null;
    }
    closeFloating();
  });
  cv.addEventListener('pointermove', (ev) => {
    const [x, y] = pos(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x, y });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2 * e.dpr, my = (a.y + b.y) / 2 * e.dpr;
      if (d / pinch.d > 1.3) { e.zoomBy(1, mx, my); pinch.d = d; }
      else if (d / pinch.d < 0.77) { e.zoomBy(-1, mx, my); pinch.d = d; }
      return;
    }
    if (drag && pointers.size === 1) {
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > 8) { drag.moved = true; cv.classList.add('grabbing'); }
      if (drag.moved) e.panBy(dx, dy);
      drag.x = x; drag.y = y;
      return;
    }
    if (ev.pointerType === 'mouse') hover(x, y);
  });
  const end = (ev) => {
    pointers.delete(ev.pointerId);
    cv.classList.remove('grabbing');
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && ev.type === 'pointerup') {
      const [x, y] = pos(ev);
      tap(x, y);
    }
    if (pointers.size === 0) drag = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { e.hoverTile = null; e.hoverLabel = null; });
  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [x, y] = pos(ev);
    wheelAcc += ev.deltaY;
    if (Math.abs(wheelAcc) > 60) { e.zoomBy(wheelAcc < 0 ? 1 : -1, x * e.dpr, y * e.dpr); wheelAcc = 0; }
  }, { passive: false });
  let wheelAcc = 0;
  $('#zoomIn').addEventListener('click', () => e.zoomBy(1));
  $('#zoomOut').addEventListener('click', () => e.zoomBy(-1));
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { closeAllSheets(); closeFloating(); return; }
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (ev.key === 'Enter' || ev.key === '/') { if (!$('#room').hidden) { ev.preventDefault(); $('#chatInput').focus(); if (ev.key === '/') $('#chatInput').value = '/'; } }
  });
}

const LABELS = {
  fridge: 'grab a kombucha', bar: 'grab a cold brew', gong: 'ring the merge gong', button: 'deploy to prod',
  rack: () => rackLabel(), arcade: 'arcade', chair: 'sit', stool: 'sit', sofa: 'sit', beanbag: 'sit', armchair: 'sit',
};
function hover(x, y) {
  const e = state.engine;
  const hit = e.pick(x * e.dpr, y * e.dpr);
  const cv = $('#stage');
  e.hoverTile = null;
  e.hoverLabel = null;
  let pointer = false;
  if (!hit) { cv.classList.remove('pointer'); return; }
  if (hit.type === 'tile') e.hoverTile = hit;
  else if (hit.type === 'user') { pointer = true; const u = e.users.get(hit.id); if (u) e.hoverLabel = { text: u.npc ? `${u.login} · the lounge bot` : `@${u.login} · ${fmt(u.merged)} merged`, dx: x * e.dpr, dy: y * e.dpr }; }
  else if (hit.type === 'furn') {
    const l = typeof LABELS[hit.f.kind] === 'function' ? LABELS[hit.f.kind]() : LABELS[hit.f.kind];
    if (l) { pointer = true; e.hoverLabel = { text: l, dx: x * e.dpr, dy: y * e.dpr }; }
  } else if (hit.type === 'wall' && hit.w.id === 'fame') { pointer = true; e.hoverLabel = { text: 'wall of fame', dx: x * e.dpr, dy: y * e.dpr }; }
  cv.classList.toggle('pointer', pointer);
}

function tap(x, y) {
  const e = state.engine;
  const hit = e.pick(x * e.dpr, y * e.dpr);
  if (!hit) return;
  if (hit.type === 'user') return openProfile(hit.id);
  if (hit.type === 'furn') {
    const f = hit.f;
    if (f.seat || f.use) {
      send(f.seat ? { t: 'move', x: f.x, y: f.y } : { t: 'use', fid: f.id });
      e.follow = true;
      return;
    }
    if (f.kind === 'rack') return toast(`${rackLabel(f)}: humming along. ${fmt(e.stats.mergedPRs)} merged PRs indexed.`);
    if (f.kind === 'arcade') return toast(f.hue === 'pink' ? 'PONG.AI — insert token. (you have plenty.)' : 'CONTEXT INVADERS — high score: whoever merged last.');
    if (f.kind === 'plant') return toast('🪴 well watered. unlike your test suite.');
    if (f.kind === 'lavalamp') return toast('it just vibes.');
    if (f.kind === 'pingpong') return toast('🏓 first to 11. loser writes the changelog.');
    if (f.kind === 'table') return toast("someone's laptop. it's mid-rebase. don't touch it.");
    if (f.kind === 'desk') return toast('an ultrawide, a mechanical keyboard, and a cold mug. classic.');
    return;
  }
  if (hit.type === 'wall') {
    if (hit.w.id === 'fame') return openFame();
    if (hit.w.id === 'door') return toast("the door's always open.");
    if (hit.w.id === 'poster') return toast('MERGED. LGTM.');
    if (hit.w.id === 'neon') return toast(CFG.project.tagline ? `${CFG.project.name} · ${CFG.project.tagline}` : CFG.project.name);
    return;
  }
  if (hit.type === 'tile' && hit.ok) {
    send({ t: 'move', x: hit.x, y: hit.y });
    e.target = { x: hit.x, y: hit.y, t: performance.now() };
    e.follow = true;
  }
}

// ------------------------------------------------------------------ dock: chat + tray
function setupDock() {
  const input = $('#chatInput');
  $('#chatForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (text === '/help') { openSheet('sheetHelp'); input.value = ''; return; }
    send({ t: 'chat', text });
    input.value = '';
    setTyping(false);
  });
  input.addEventListener('input', () => {
    const v = input.value.trim();
    setTyping(!!v && !v.startsWith('/'));
    clearTimeout(state.typingTimer);
    if (v) state.typingTimer = setTimeout(() => setTyping(false), 5000);
  });
  input.addEventListener('blur', () => setTyping(false));
  input.addEventListener('focus', () => { closeFloating(); });
  const tray = $('#tray');
  $('#trayBtn').addEventListener('click', () => {
    tray.hidden = !tray.hidden;
    $('#trayBtn').setAttribute('aria-expanded', String(!tray.hidden));
    requestAnimationFrame(measureInsets);
  });
  const reacts = $('#reacts');
  for (const r of REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r;
    b.setAttribute('aria-label', 'react ' + r);
    b.addEventListener('click', () => send({ t: 'react', r }));
    reacts.appendChild(b);
  }
  for (const b of $$('[data-emote]')) b.addEventListener('click', () => send({ t: 'emote', e: b.dataset.emote }));
  for (const b of $$('[data-cmd]')) b.addEventListener('click', () => send({ t: 'chat', text: b.dataset.cmd }));
}
function setTyping(on) {
  if (on === state.typing) return;
  state.typing = on;
  send({ t: 'typing', on });
}

// ------------------------------------------------------------------ sheets & menus
function setupSheets() {
  $('#btnLog').addEventListener('click', () => toggleSheet('sheetLog'));
  $('#btnFame').addEventListener('click', () => (isOpen('sheetFame') ? closeAllSheets() : openFame()));
  $('#btnWardrobe').addEventListener('click', () => (isOpen('sheetWardrobe') ? closeAllSheets() : openWardrobe(false)));
  $('#btnMenu').addEventListener('click', (ev) => { ev.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
  for (const c of $$('[data-close]')) c.addEventListener('click', () => closeAllSheets());
  $('#mHelp').addEventListener('click', () => { $('#menu').hidden = true; openSheet('sheetHelp'); });
  $('#mLogout').addEventListener('click', async () => {
    $('#menu').hidden = true;
    const tok = state.token;
    state.noReconnect = true;
    ls.del(TOKEN_KEY);
    try { state.ws?.close(); } catch { /* ignore */ }
    try { await api('/api/logout', {}, tok); } catch { /* ignore */ }
    location.reload();
  });
  document.addEventListener('click', (ev) => {
    if (!$('#menu').hidden && !ev.target.closest('#menu') && !ev.target.closest('#btnMenu')) $('#menu').hidden = true;
  });
  $('#fameSearch').addEventListener('input', renderFame);
}
const SHEETS = ['sheetLog', 'sheetFame', 'sheetWardrobe', 'sheetProfile', 'sheetHelp'];
function isOpen(id) { return !$('#' + id).hidden; }
function openSheet(id) {
  for (const s of SHEETS) $('#' + s).hidden = s !== id;
  if (id === 'sheetLog') {
    state.unread = 0;
    $('#logBadge').hidden = true;
    const ol = $('#log');
    requestAnimationFrame(() => { ol.scrollTop = ol.scrollHeight; });
  }
}
function toggleSheet(id) { if (isOpen(id)) closeAllSheets(); else openSheet(id); }
function closeAllSheets() {
  if (isOpen('sheetWardrobe')) cancelWardrobe();
  for (const s of SHEETS) $('#' + s).hidden = true;
}
function closeFloating() { $('#menu').hidden = true; if (isOpen('sheetProfile')) $('#sheetProfile').hidden = true; }

function showModal(title, text, buttons) {
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  const box = $('#modalBtns');
  box.innerHTML = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
    el.textContent = b.text;
    el.addEventListener('click', b.fn);
    box.appendChild(el);
  }
  $('#modal').hidden = false;
}
function hideModal() { $('#modal').hidden = true; }

// ------------------------------------------------------------------ wall of fame
async function loadFame(force) {
  if (!force && state.fame && Date.now() - state.fameAt < 60_000) return state.fame;
  try {
    const r = await api('/api/fame', null, state.token);
    if (r.list) {
      state.fame = r;
      state.fameAt = Date.now();
      state.engine.setFame(r.list);
    }
  } catch { /* ignore */ }
  return state.fame;
}
async function openFame() {
  openSheet('sheetFame');
  $('#fameSub').textContent = 'loading…';
  await loadFame(true);
  renderFame();
}
function renderFame() {
  const f = state.fame;
  if (!f) return;
  const q = $('#fameSearch').value.trim().toLowerCase();
  const visited = f.list.filter((x) => x.visited).length;
  $('#fameSub').textContent = `${fmt(f.list.length)} merged contributors · ${fmt(f.total)} PRs · ${fmt(visited)} have visited`;
  const ol = $('#fameList');
  ol.innerHTML = '';
  const frag = document.createDocumentFragment();
  f.list.forEach((c, i) => {
    if (q && !c.login.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = prsUrl(c.login);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = '#' + (i + 1);
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = `https://avatars.githubusercontent.com/${encodeURIComponent(c.login)}?s=64`;
    img.width = 32; img.height = 32;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.login;
    const sm = document.createElement('small');
    sm.textContent = c.online ? '' : c.visited ? `visited · first merge ${c.first}` : `first merge ${c.first}`;
    if (c.online) { const on = document.createElement('span'); on.className = 'on'; on.textContent = '● in the lounge'; sm.appendChild(on); }
    nm.appendChild(sm);
    const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = fmt(c.merged);
    a.append(rank, img, nm, ct);
    li.appendChild(a);
    frag.appendChild(li);
  });
  ol.appendChild(frag);
}

// ------------------------------------------------------------------ profile card
function drawSpriteTo(canvas, look, view = 'front', flip = false, pose = 'stand', frame = 0) {
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.drawImage(avatarSprite(look, { view, pose, frame, flip }), 0, 0);
}
function openProfile(id) {
  const e = state.engine;
  const u = e.users.get(id);
  if (!u) return;
  openSheet('sheetProfile');
  drawSpriteTo($('#pfSprite'), u.look);
  const img = $('#pfImg');
  const actions = $('#pfActions');
  actions.innerHTML = '';
  const btn = (text, cls, fn, href) => {
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'btn ' + cls;
    el.textContent = text;
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    else { el.type = 'button'; el.addEventListener('click', fn); }
    actions.appendChild(el);
  };
  if (u.npc) {
    img.hidden = true;
    $('#pfName').textContent = u.login;
    $('#pfLine1').textContent = "The lounge's resident bot. It watches, takes notes, and greets people at the door.";
    $('#pfLine2').textContent = `Say "${u.login}" in chat and it might answer.`;
    btn('Ask for /stats', 'ghost', () => { send({ t: 'chat', text: '/stats' }); closeAllSheets(); });
    return;
  }
  img.hidden = false;
  img.src = `https://avatars.githubusercontent.com/${encodeURIComponent(u.login)}?s=96`;
  $('#pfName').textContent = '@' + u.login + (u.admin ? ' ★' : '');
  $('#pfLine1').textContent = `${fmt(u.merged)} merged PR${u.merged === 1 ? '' : 's'} in ${CFG.project.name}`;
  const fc = state.fame?.list.find((x) => x.login.toLowerCase() === u.login.toLowerCase());
  $('#pfLine2').textContent = fc ? `first merge ${fc.first} · latest ${fc.last}` : (u.afk ? 'away from keyboard' : '');
  const prs = prsUrl(u.login);
  if (id === state.me?.id) {
    btn('Change look', 'primary', () => openWardrobe(false));
    btn('Dance', 'ghost', () => { send({ t: 'emote', e: 'dance' }); closeAllSheets(); });
    btn('My PRs ↗', 'ghost', null, prs);
  } else {
    btn('Wave 👋', 'primary', () => { send({ t: 'emote', e: 'wave' }); closeAllSheets(); });
    btn('Whisper', 'ghost', () => { closeAllSheets(); const i = $('#chatInput'); i.value = `/w @${u.login} `; i.focus(); });
    btn('Their PRs ↗', 'ghost', null, prs);
    btn('GitHub ↗', 'ghost', null, `https://github.com/${encodeURIComponent(u.login)}`);
  }
}

// ------------------------------------------------------------------ wardrobe
const W_GROUPS = [
  ['hairStyle', 'Hair', 'chips'], ['hairColor', 'Hair color', 'swatch'], ['skin', 'Skin', 'swatch'],
  ['top', 'Top', 'chips'], ['topColor', 'Top color', 'swatch'], ['pants', 'Pants', 'swatch'],
  ['shoes', 'Shoes', 'swatch'], ['acc', 'Extra', 'chips'],
];
const ward = { look: null, original: null, dir: 0, raf: 0 };
function setupWardrobe() {
  $('#wRotate').addEventListener('click', () => { ward.dir = (ward.dir + 1) % 4; });
  $('#wShuffle').addEventListener('click', () => {
    const l = {};
    for (const k of Object.keys(LOOK)) l[k] = Math.floor(Math.random() * LOOK[k].length);
    ward.look = l;
    renderWardrobeOpts();
  });
  $('#wSave').addEventListener('click', () => {
    send({ t: 'look', look: ward.look });
    ward.original = null;
    for (const s of SHEETS) $('#' + s).hidden = true;
    stopWardrobeAnim();
    toast('Looking sharp.');
  });
}
function openWardrobe(first) {
  const me = state.engine.users.get(state.me?.id);
  const look = me?.look || state.me?.look || defaultLook(state.me?.login || 'x');
  ward.original = { ...look };
  ward.look = { ...look };
  $('#wardrobeSub').textContent = first ? 'first time here — make yourself at home' : 'tap to try things on';
  openSheet('sheetWardrobe');
  renderWardrobeOpts();
  startWardrobeAnim();
}
function cancelWardrobe() {
  ward.original = null;
  stopWardrobeAnim();
}
function renderWardrobeOpts() {
  const box = $('#wOpts');
  box.innerHTML = '';
  for (const [key, label, kind] of W_GROUPS) {
    const sec = document.createElement('div');
    sec.className = 'opt';
    const h = document.createElement('h3');
    h.textContent = label;
    const ch = document.createElement('div');
    ch.className = 'choices';
    LOOK[key].forEach((v, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      if (kind === 'swatch') { b.className = 'swatch'; b.style.background = v; b.setAttribute('aria-label', `${label} ${i + 1}`); }
      else { b.className = 'choice'; b.textContent = v; }
      if (ward.look[key] === i) b.classList.add('on');
      b.addEventListener('click', () => { ward.look[key] = i; renderWardrobeOpts(); });
      ch.appendChild(b);
    });
    sec.append(h, ch);
    box.appendChild(sec);
  }
}
function startWardrobeAnim() {
  stopWardrobeAnim();
  const cv = $('#wPreview');
  const tick = (t) => {
    const views = [['front', false], ['front', true], ['back', true], ['back', false]];
    const [view, flip] = views[ward.dir];
    const frame = Math.floor(t / 140) % 4;
    drawSpriteTo(cv, ward.look, view, flip, 'walk', frame);
    ward.raf = requestAnimationFrame(tick);
  };
  ward.raf = requestAnimationFrame(tick);
}
function stopWardrobeAnim() { cancelAnimationFrame(ward.raf); ward.raf = 0; }

if (new URLSearchParams(location.search).has('debug')) window.__lounge = { state, send, P: null };

// =================================================================== boot
(async function boot() {
  await loadConfig();
  const token = ls.get(TOKEN_KEY);
  if (token) {
    try {
      const r = await api('/api/me', null, token);
      if (r.ok) return enterRoom(token);
      if (r.status === 401) ls.del(TOKEN_KEY);
    } catch { /* fall through to landing */ }
  }
  showLanding();
  setInterval(() => { if (!$('#landing').hidden) refreshLive(); }, 30000);
})();
