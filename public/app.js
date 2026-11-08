// The browser side of the lounge. Two screens:
// - the landing page and check-in: username → one-time code → public gist → a session token kept in
//   localStorage (the server does the checking; see /api/auth/* in server.js);
// - the room: everything around the canvas (the chat feed, top bar, sheets for people, the wall of
//   fame, the wardrobe, profiles and help, notices and modals) plus the WebSocket that keeps it live.
// engine.js draws the room; this file owns its render loop and writes the people and chat into it.
// Lounge-specific words (names, links, the sign) come from GET /api/config, never from this file.
import { Engine } from './engine.js';
import { Valley, localHour, skyAt } from './valley.js';
import { makeCanvas } from './pixel.js';
import { avatarSprite } from './avatar.js';
import { LOOK, REACTIONS, FURNITURE, defaultLook, hash32 } from '/shared/world.js';
import { resolveConfig, defaultConfig, slug, accentInk } from '/shared/config.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TOKEN_KEY = 'mergeLounge.token';
const LOGIN_KEY = 'mergeLounge.login';
const CHALLENGE_KEY = 'mergeLounge.challenge'; // survives a reload while someone is off making their gist
const HINT_KEY = 'mergeLounge.hintDone'; // the first-visit "tap the floor" tip was seen
const NUDGE_KEY = 'mergeLounge.lookNudgeDone'; // the "pick your look" nudge was used or dismissed
const CHAT_COLLAPSED_KEY = 'mergeLounge.chatCollapsed'; // wide screens: the chat sidebar is hidden
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const asText = (s) => String(s ?? ''); // plain text for textContent and DOM text nodes. NOT an HTML escape: never use it with innerHTML
const coarseMQ = matchMedia('(pointer: coarse)');
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
const shortMQ = matchMedia('(max-height: 520px)'); // the mini feed shows 2 lines instead of 3 (style.css)
const onMQ = (mq, fn) => (mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn));
// The pinned sidebar needs width AND height: a big phone on its side (932x430) gets the phone layout.
// A short desktop window (1280x590) still gets the sidebar: a mouse-driven screen 480px+ tall has room.
// Two plain queries rather than one with "or", so older browsers read it too; `change` fires once per flip.
const wideMQ = (() => {
  const qs = [matchMedia('(min-width: 900px) and (min-height: 600px)'),
    matchMedia('(min-width: 900px) and (min-height: 480px) and (hover: hover) and (pointer: fine)')];
  const now = () => qs.some((q) => q.matches);
  let was = now();
  const fns = [];
  for (const q of qs) onMQ(q, () => { const m = now(); if (m === was) return; was = m; for (const fn of fns) fn(); });
  return { get matches() { return now(); }, addEventListener: (_type, fn) => fns.push(fn) };
})();

// Focus the app moves by itself (a modal opening, the landing note after a kick, a panel opening) shows
// the focus ring only to keyboard users. Browsers guess from what had focus before, and a text box
// always counts as "keyboard", so after typing in the chat a tap on OK lit up a big ring. Instead: how
// did the person last drive the page? A pointer (mouse, finger, pen) or the keyboard. Typing into a
// text box doesn't count (on a phone that's the on-screen keyboard), except Tab.
let lastInput = 'pointer';
const typingIn = (el) => !!el && ((el.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(el.type))
  || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
addEventListener('keydown', (ev) => {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(ev.key)) return;
  if (ev.key !== 'Tab' && typingIn(ev.target)) return;
  lastInput = 'key';
  // browsers without the focusVisible option: the class was hiding the ring, the keyboard brings it back
  if (ev.key !== 'Tab') document.activeElement?.classList?.remove('quiet-focus');
}, true);
document.addEventListener('focusout', (ev) => ev.target.classList?.remove('quiet-focus'), true);
// Screen readers follow focus either way; only the ring differs. `quiet-focus` (style.css) is the
// fallback for browsers that ignore { focusVisible }.
function moveFocus(el) {
  if (!el) return;
  if (lastInput === 'key') { el.focus({ preventScroll: true, focusVisible: true }); return; }
  el.classList.add('quiet-focus');
  el.focus({ preventScroll: true, focusVisible: false });
}
// Tab where focus can't go anywhere else (a one-button dialog): after a quiet focus, show the ring now
function showRing(el) {
  if (!el?.classList.contains('quiet-focus')) return;
  el.classList.remove('quiet-focus');
  el.blur();
  el.focus({ preventScroll: true, focusVisible: true });
}
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

// Toasts: at most three, and the same text never twice at once (a repeat just stays up longer).
// quiet: the same words were already read out from the chat (readOut), so screen readers don't hear them twice.
// offline: a notice about the connection, dropped as soon as the room is back (setOffline)
function toast(text, ms = 3200, { quiet = false, offline = false } = {}) {
  const box = $('#toasts');
  if (!box) return;
  for (const el of box.children) {
    if (el.textContent === text && !el.classList.contains('out')) {
      clearTimeout(el._t);
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
      el._t = setTimeout(() => dropToast(el), ms);
      return;
    }
  }
  const el = document.createElement('div');
  el.className = 'toast';
  if (quiet) el.setAttribute('aria-hidden', 'true');
  if (offline) el.dataset.offline = '';
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  el._t = setTimeout(() => dropToast(el), ms);
}
function dropToast(el) { el.classList.add('out'); setTimeout(() => el.remove(), 260); }

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
  $('meta[name="description"]')?.setAttribute('content', `A pixel-art lounge for everyone who's merged a PR into ${proj}.`);
  if (/^#[0-9a-f]{6}$/i.test(c.theme.accent)) {
    document.documentElement.style.setProperty('--accent', c.theme.accent);
    document.documentElement.style.setProperty('--accent-ink', accentInk(c.theme.accent)); // readable on any accent
  }
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
  // the "not yet" card: someone under minMergedPRs may have some merged PRs, just not enough
  const several = c.minMergedPRs > 1;
  for (const el of $$('.cfg-need')) el.textContent = needPRs();
  for (const el of $$('.cfg-need-none')) el.textContent = several ? 'Not enough merged PRs for' : 'No merged PRs found for';
  for (const el of $$('.cfg-need-then')) el.textContent = several ? 'Come back when you have them' : 'Get one merged and come back';
}
// what it takes to get in, in words: "a merged PR" or "3 merged PRs"
const needPRs = () => (CFG.minMergedPRs > 1 ? `${fmt(CFG.minMergedPRs)} merged PRs` : 'a merged PR');
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
  let running = true, raf = 0, last = -1e9;
  const draw = (still) => {
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
    valley.render(bg, bw, bh, Date.now(), { speed: still ? 0 : 10, hour });
    ctx.imageSmoothingEnabled = false;
    const top = (fullH - bh) * s;
    if (top > 0) { ctx.fillStyle = skyAt(hour).top; ctx.fillRect(0, 0, Wd, top + s); }
    ctx.drawImage(buf, 0, top, bw * s, bh * s);
  };
  // reduced motion: a still skyline, redrawn once a second (lights, the hour); hidden tab: nothing at all
  const frame = (t) => {
    raf = 0;
    if (!running || document.hidden) return;
    const still = reduceMQ.matches;
    if (!still || t - last > 1000) { last = t; draw(still); }
    raf = requestAnimationFrame(frame);
  };
  const kick = () => { if (running && !raf && !document.hidden) raf = requestAnimationFrame(frame); };
  document.addEventListener('visibilitychange', kick);
  kick();
  return () => { running = false; cancelAnimationFrame(raf); raf = 0; document.removeEventListener('visibilitychange', kick); };
}

// A short note above the check-in form: logged out, session expired, removed by an admin.
// { text, back, until }: text may be a function of "still waiting?"; with `until`, the "Back to the
// lounge" button stays disabled until then and the text keeps its countdown current.
const landNote = { timer: 0, until: 0 };
function setLandNote(note) {
  clearInterval(landNote.timer);
  landNote.timer = 0;
  landNote.until = 0;
  const box = $('#landNote');
  if (!note) { box.hidden = true; return; }
  const n = typeof note === 'string' ? { text: note } : note;
  const p = $('#landNoteText'), btn = $('#landNoteBtn');
  landNote.until = Number(n.until) || 0;
  const paint = () => {
    const waiting = landNote.until > Date.now();
    const text = typeof n.text === 'function' ? n.text(waiting) : n.text;
    if (p.textContent !== text) p.textContent = text; // the note is a status: only real changes get read out
    btn.hidden = !(n.back && ls.get(TOKEN_KEY));
    btn.disabled = waiting;
    if (!waiting && landNote.timer) { clearInterval(landNote.timer); landNote.timer = 0; }
  };
  paint();
  if (landNote.until > Date.now()) landNote.timer = setInterval(paint, 1000);
  box.hidden = false;
}

function showLanding(note) {
  $('#room').hidden = true;
  $('#landing').hidden = false;
  if (!heroStop) heroStop = startHero();
  showStep('step1');
  $('#err1').textContent = '';
  setLandNote(note);
  const saved = ls.get(LOGIN_KEY);
  if (saved && !$('#gh').value) $('#gh').value = saved;
  refreshLive();
  // back from making the gist (or a reload partway through): go straight to step 2 with the same code
  const prev = savedChallenge();
  if (prev && prev.login) startCheckIn(String(prev.login), { resume: true });
}

async function refreshLive() {
  try {
    const s = await api('/api/status');
    $('#liveOnline').textContent = fmt(s.online);
    $('#liveContrib').textContent = fmt(s.contributors);
    $('#livePRs').textContent = fmt(s.mergedPRs);
  } catch { /* offline */ }
}

// The first card rises in with the page. After that, steps swap in place quickly (.swap), so the code or
// the "no merged PRs" card isn't blank for a second while someone reads it.
let stepShown = false;
function showStep(id) {
  for (const s of ['step1', 'step2', 'stepNo']) {
    const el = $('#' + s);
    el.hidden = s !== id;
    el.classList.toggle('swap', stepShown);
  }
  stepShown = true;
}
function savedChallenge() {
  try { return JSON.parse(ls.get(CHALLENGE_KEY) || 'null'); } catch { return null; }
}

let challenge = null;
async function startCheckIn(raw, { resume = false } = {}) {
  $('#err1').textContent = '';
  const btn = $('#checkBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const prev = savedChallenge();
    const nonce = prev && String(prev.login).toLowerCase() === raw.toLowerCase() ? prev.nonce : undefined;
    const r = await api('/api/auth/start', { login: raw, nonce });
    if (r.ok) {
      challenge = r;
      ls.set(LOGIN_KEY, r.login);
      ls.set(CHALLENGE_KEY, JSON.stringify({ login: r.login, nonce: r.nonce }));
      $('#foundLogin').textContent = '@' + r.login;
      $('#foundCount').textContent = `${fmt(r.merged)} merged PR${r.merged === 1 ? '' : 's'}`;
      $('#code').textContent = r.code;
      setCommand($('#cli'), `echo ${r.code} | gh gist create --public -d ${r.code} -f ${slug(CFG.loungeName) || 'lounge'}.txt -`);
      const st = $('#status2');
      st.className = 'status';
      const sameCode = !!(resume && nonce && r.nonce === nonce);
      st.textContent = !resume ? '' : sameCode ? 'Picked up where you left off. Same code as before.' : 'Your last code ran out, so here is a fresh one.';
      gist.opened = sameCode; // back from GitHub with the same code: "let me in" is the next step
      showStep('step2');
      selectTab(coarseMQ.matches || window.innerWidth < 640 ? 'web' : 'cli');
      if (!resume) $('#step2').querySelector('[data-copy="code"]')?.focus({ preventScroll: true });
    } else if (resume) {
      ls.del(CHALLENGE_KEY); // nothing to pick up any more: stay on step 1, quietly
    } else if (r.reason === 'not-contributor') {
      $('#noLogin').textContent = '@' + (r.login || raw);
      showStep('stepNo');
    } else if (r.reason === 'bad-login') {
      $('#err1').textContent = "That doesn't look like a GitHub username.";
    } else if (r.reason === 'banned') {
      $('#err1').textContent = "This account can't check in.";
    } else if (r.reason === 'slow-down') {
      $('#err1').textContent = 'Too many tries just now. Give it a minute, then try again.';
    } else {
      $('#err1').textContent = "GitHub didn't answer just now. Try again in a minute.";
    }
  } catch {
    if (!resume) $('#err1').textContent = "Couldn't reach the lounge. Check your connection.";
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check in';
  }
}
$('#step1').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('#gh').value.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
  if (raw) startCheckIn(raw);
});

$('#backBtn').addEventListener('click', () => { verifying = false; challenge = null; ls.del(CHALLENGE_KEY); showStep('step1'); $('#gh').focus(); });
$('#noBack').addEventListener('click', () => { showStep('step1'); $('#gh').select(); });
$('#landNoteBtn').addEventListener('click', () => {
  if (landNote.until > Date.now()) return; // still bounced: the server would only send them back here
  const t = ls.get(TOKEN_KEY);
  if (t) enterRoom(t); else setLandNote(null);
});

// Terminal / Browser tabs (phones start on Browser: they can't run the command)
function selectTab(name, focus = false) {
  for (const x of $$('.tab')) {
    const on = x.dataset.tab === name;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on ? 'true' : 'false');
    x.tabIndex = on ? 0 : -1;
    if (on && focus) x.focus();
  }
  $('#tab-cli').hidden = name !== 'cli';
  $('#tab-web').hidden = name !== 'web';
  paintGistButtons();
}
// One primary button at a time: on the Browser tab, "open gist.github.com" until it's been used, then
// "let me in". (The Terminal tab has nothing else competing.)
const gist = { opened: false };
function paintGistButtons() {
  const first = !$('#tab-web').hidden && !gist.opened;
  $('#gistOpen').classList.toggle('primary', first);
  $('#gistOpen').classList.toggle('ghost', !first);
  $('#verifyBtn').classList.toggle('primary', !first);
  $('#verifyBtn').classList.toggle('ghost', first);
}
// The command shown in Terminal: each word in a no-wrap span, so lines break only at spaces (never
// after the hyphens in "-f" or the code). textContent, which is what gets copied, stays the plain command.
function setCommand(pre, cmd) {
  pre.replaceChildren();
  cmd.split(' ').forEach((word, i) => {
    if (i) pre.append(' ');
    const s = document.createElement('span');
    s.className = 'w';
    s.textContent = word;
    pre.append(s);
  });
}
for (const t of $$('.tab')) {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
  t.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    selectTab(t.dataset.tab === 'cli' ? 'web' : 'cli', true);
  });
}
// the Browser path: one button copies the code and opens GitHub in a new tab
$('#gistOpen').addEventListener('click', () => {
  const code = $('#code').textContent;
  const st = $('#status2');
  gist.opened = true;
  paintGistButtons();
  navigator.clipboard?.writeText(code).then(() => {
    st.className = 'status';
    st.textContent = 'Code copied. Paste it into the gist, then come back here.';
  }, () => {
    st.className = 'status';
    st.textContent = `Copy this code into the gist: ${code}`;
  });
});
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
        const why = {
          'no-challenge': 'That code expired — go back and check in again.',
          'too-many-tries': 'Too many tries. Go back and start over.',
          'slow-down': 'Too many tries just now. Give it a minute, then try the button again.',
          banned: "This account can't check in.",
          'not-contributor': `GitHub doesn't show ${needPRs()} in ${CFG.project.name} for this account right now.`,
        };
        st.textContent = Object.hasOwn(why, r.reason) ? why[r.reason] : 'Something went wrong. Try the button again.';
        return;
      }
      await sleep(i < 3 ? 4000 : 6000);
    }
    if (verifying) {
      st.className = 'status bad';
      st.textContent = "Still not seeing it. Check that the gist is public (a secret gist won't show up) and has the code in it, then try the button again.";
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
  offline: false,
  noReconnect: false,
  retries: 0,
  joined: false, // this page has had a welcome since entering (coach tips start once)
  fame: null,
  fameAt: 0,
  unread: 0,
  typing: false,
  typingTimer: null,
};
const ui = { panelOpen: false, collapsed: ls.get(CHAT_COLLAPSED_KEY) === '1', nudgeT: 0, peopleRaf: 0 };
// The engine may skip frames when nothing changed; tell it when app.js wrote engine state directly.
const inv = () => state.engine?.invalidate?.();

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
  state.noReconnect = false;
  state.retries = 0;
  if (heroStop) { heroStop(); heroStop = null; }
  setLandNote(null);
  $('#landing').hidden = true;
  $('#room').hidden = false;
  $('#room').classList.remove('ended', 'offline');
  applyChatMode();
  try {
    await Promise.race([Promise.all([
      document.fonts.load('13px "Pixelify Sans"'), document.fonts.load('600 13px "Pixelify Sans"'), document.fonts.load('700 13px "Pixelify Sans"'),
      document.fonts.load('12px "Silkscreen"'), document.fonts.load('700 12px "Silkscreen"'),
    ]), sleep(1500)]);
  } catch { /* fine */ }
  if (!state.engine) setupRoom();
  measureInsets(true);
  startLoop();
  connect();
}

// One render loop, owned here. It stops while the tab is hidden or the room is left, and never runs twice.
const loop = { raf: 0 };
function frame(t) {
  loop.raf = requestAnimationFrame(frame);
  state.engine.render(t);
}
function startLoop() {
  if (loop.raf || !state.engine || document.hidden || $('#room').hidden) return;
  state.engine.setPaused?.(false);
  inv();
  loop.raf = requestAnimationFrame(frame);
}
function stopLoop() {
  if (loop.raf) cancelAnimationFrame(loop.raf);
  loop.raf = 0;
  state.engine?.setPaused?.(true);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopLoop(); else startLoop(); });

function setupRoom() {
  const engine = state.engine = new Engine($('#stage'), { config: CFG });
  engine.setReducedMotion?.(reduceMQ.matches);
  onMQ(reduceMQ, () => state.engine?.setReducedMotion?.(reduceMQ.matches));
  window.addEventListener('resize', () => measureInsets());
  window.visualViewport?.addEventListener('resize', () => measureInsets());
  window.visualViewport?.addEventListener('scroll', () => measureInsets());
  // the stage changes size when the chat sidebar opens or closes; the chat changes what it covers
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => measureInsets());
    for (const sel of ['#stage', '#chat', '#topbar']) ro.observe($(sel));
  }
  onMQ(wideMQ, () => { ui.panelOpen = false; applyChatMode(); });
  setupInput();
  setupDock();
  setupChat();
  setupSheets();
  setupWardrobe();
  setupCoach();
}

// Insets: how much of the stage (CSS px, relative to the stage box) the top bar and the chat cover.
let lastMeasure = '';
function measureInsets(force = false) {
  const e = state.engine;
  const room = $('#room');
  if (!e || room.hidden) return;
  const chat = $('#chat');
  // keep the chat above the on-screen keyboard (iOS doesn't resize the layout for us)
  const vv = window.visualViewport;
  const kbRaw = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
  const kb = kbRaw > 40 ? Math.round(kbRaw) : 0;
  chat.style.bottom = kb ? kb + 'px' : '';
  room.style.setProperty('--kb', kb + 'px');
  const st = $('#stage').getBoundingClientRect();
  const top = Math.max(0, Math.round($('#topbar').getBoundingClientRect().bottom - st.top));
  const bottom = room.dataset.chat === 'side' ? 0 : Math.max(0, Math.round(st.bottom - chat.getBoundingClientRect().top));
  room.style.setProperty('--inset-b', bottom + 'px');
  const key = `${st.width}x${st.height}@${window.devicePixelRatio}|${top},${bottom}`;
  if (!force && key === lastMeasure) return;
  lastMeasure = key;
  e.insets = { top, bottom };
  e.resize();
  inv();
}

// ------------------------------------------------------------------ chat layout
// wide (>= 900px): 'side' = pinned sidebar, 'dock' = sidebar hidden, composer floats at the foot.
// narrow: 'mini' = last three lines above the composer, 'panel' = half-height panel with the composer.
function chatMode() { return wideMQ.matches ? (ui.collapsed ? 'dock' : 'side') : (ui.panelOpen ? 'panel' : 'mini'); }
function fullFeed() { const m = chatMode(); return m === 'side' || m === 'panel'; }
// can the person see new feed lines right now? (if not, notices also pop up as toasts)
function feedShowing() {
  const m = chatMode();
  if (m === 'dock') return false;
  return wideMQ.matches || !anySheetOpen();
}
function applyChatMode() {
  const room = $('#room');
  const m = chatMode();
  const changed = room.dataset.chat !== m;
  room.dataset.chat = m;
  room.classList.toggle('wide', wideMQ.matches);
  syncSheetModality();
  $('#btnLog').setAttribute('aria-expanded', String(m === 'side'));
  $('#chatExpand').setAttribute('aria-expanded', String(m === 'panel'));
  const close = $('#chatClose');
  close.setAttribute('aria-label', m === 'panel' ? 'Close the chat' : 'Hide chat');
  close.title = m === 'panel' ? 'Close the chat' : 'Hide chat';
  const log = $('#log');
  if (m === 'side' || m === 'panel') log.setAttribute('tabindex', '0'); else log.removeAttribute('tabindex');
  state.engine?.setBubblesHidden?.(m === 'panel'); // the panel shows the same lines; don't draw them twice
  hideBubblesFallback();
  inv();
  if (fullFeed()) { clearUnread(); scrollLogToEnd(); }
  renderBadges();
  if (changed) requestAnimationFrame(() => measureInsets());
}
function setCollapsed(v) { ui.collapsed = v; ls.set(CHAT_COLLAPSED_KEY, v ? '1' : '0'); applyChatMode(); }
function setPanel(open) { ui.panelOpen = open; applyChatMode(); }
function scrollLogToEnd() { requestAnimationFrame(() => { const ol = $('#log'); ol.scrollTop = ol.scrollHeight; }); }
function setupChat() {
  $('#btnLog').addEventListener('click', () => setCollapsed(!ui.collapsed));
  $('#chatClose').addEventListener('click', () => {
    if (wideMQ.matches) { setCollapsed(true); moveFocus($('#btnLog')); }
    else { setPanel(false); moveFocus($('#chatExpand')); }
  });
  $('#chatExpand').addEventListener('click', () => {
    setPanel(true);
    requestAnimationFrame(() => moveFocus($('#chatClose')));
  });
}
// Wide + hidden chat: the Chat button counts everything unread. Phone mini feed: only the unread lines
// that already scrolled out of its three visible lines ("+2" = two more above).
// The count is whatever is still marked unread in the log, so lines dropped by the 300-line cap,
// /purge or /clear stop counting with them.
function renderBadges() {
  const n = state.unread = $$('#log li.unread').length, cap = (v) => (v > 99 ? '99+' : String(v));
  const lb = $('#logBadge');
  lb.hidden = !n;
  lb.textContent = cap(n);
  const ol = $('#log');
  let hidden = 0;
  if (n) for (let i = 0, end = ol.children.length - (shortMQ.matches ? 2 : 3); i < end; i++) if (ol.children[i].classList.contains('unread')) hidden++;
  const mb = $('#miniBadge');
  mb.hidden = !hidden;
  mb.textContent = '+' + cap(hidden);
  $('#btnLog').setAttribute('aria-label', n ? `Chat, ${n} unread` : 'Chat');
  $('#chatExpand').setAttribute('aria-label', hidden ? `Open the chat, ${hidden} more unread above` : 'Open the chat');
}
function clearUnread() {
  const lines = $$('#log li.unread');
  if (!lines.length && !state.unread) return;
  for (const li of lines) li.classList.remove('unread');
  renderBadges();
}
// Hiding room bubbles while the phone panel is open is the engine's job (setBubblesHidden). Until an
// engine has it, empty the bubble list instead (the panel shows the same lines).
function hideBubblesFallback() {
  const e = state.engine;
  if (e && !e.setBubblesHidden && chatMode() === 'panel' && e.bubbles.length) { e.bubbles = []; inv(); }
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
    onServerMessage(m);
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.connected = false;
    if (state.noReconnect) return;
    setOffline(true);
    const wait = Math.min(15000, 800 * 2 ** Math.min(5, state.retries++)) + Math.random() * 400;
    setTimeout(() => { if (!state.noReconnect) connect(); }, wait);
  };
  ws.onerror = () => {};
}
function send(m) {
  if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(m)); return true; }
  return false;
}
setInterval(() => send({ t: 'ping', ts: Date.now() }), 20000);

// Offline: the room dims, Send says so, and whatever was typed stays in the box. Send is only
// aria-disabled (not disabled), so Enter or a tap still reaches submit and gets told why nothing went.
function setOffline(on) {
  state.offline = on;
  $('#room').classList.toggle('offline', on);
  $('#conn').hidden = !on;
  const sb = $('#sendBtn');
  sb.setAttribute('aria-disabled', on ? 'true' : 'false');
  sb.textContent = on ? 'Offline' : 'Send';
  $('#chatInput').placeholder = on ? 'Offline — your text waits here' : 'Say something…';
  if (!on) for (const el of $$('#toasts [data-offline]')) { clearTimeout(el._t); dropToast(el); }
}

// Back to the landing page: stop the room completely (socket, loop) and say why.
function leaveRoom(note) {
  state.noReconnect = true;
  const ws = state.ws;
  state.ws = null;
  state.connected = false;
  try { ws?.close(); } catch { /* ignore */ }
  stopLoop();
  closeAllSheets(false);
  closeMenu(false);
  hideModal(false);
  ui.panelOpen = false;
  setOffline(false);
  $('#room').classList.remove('ended');
  hideCoach();
  state.joined = false;
  clearUnread();
  showLanding(note);
  // focus was in the room, which is gone now: put it on the note that says what happened
  if (note && !$('#landNote').hidden) moveFocus($('#landNote'));
}

function whenText(t) {
  const mins = Math.max(1, Math.round((t - Date.now()) / 60000));
  return `at ${timeFmt.format(new Date(t))} (in about ${mins} minute${mins === 1 ? '' : 's'})`;
}

// Every message the server sends over the WebSocket, by type (`t`). The protocol is additive: a type
// this page doesn't know is ignored, and newer optional fields are read only when present.
function onServerMessage(m) {
  const e = state.engine;
  switch (m.t) {
    case 'auth':
      if (!m.ok) {
        ls.del(TOKEN_KEY);
        leaveRoom('Your session expired — check in again.');
      }
      return;
    case 'welcome': {
      state.connected = true;
      state.retries = 0;
      setOffline(false);
      state.me = m.you;
      e.selfId = m.you.id;
      e.users.clear();
      for (const p of m.users) e.users.set(p.id, userFromServer(p));
      setStats(m.stats);
      // the history is a rebuild, not news: busy while it's filled, and none of it is read out
      const log = $('#log');
      log.setAttribute('aria-busy', 'true');
      log.replaceChildren();
      for (const h of m.history) addLog(h, false);
      if (!m.history.length) emptyLog();
      log.setAttribute('aria-busy', 'false');
      renderBadges();
      $('#chatSub').textContent = Number.isFinite(m.historyLimit) ? `up to the last ${m.historyLimit} messages` : 'recent messages';
      e.joinedAt = performance.now();
      const meU = e.users.get(m.you.id);
      if (meU) e.snapTo(meU.x, meU.y);
      e.follow = true;
      inv();
      if (!state.joined) { state.joined = true; startCoach(); }
      schedulePeople();
      loadFame();
      return;
    }
    case 'join': {
      e.users.set(m.user.id, userFromServer(m.user));
      inv();
      addLog({ kind: 'event', text: `${m.user.login} walked in`, ts: Date.now() }, false);
      schedulePeople();
      return;
    }
    case 'leave': {
      const u = e.users.get(m.id);
      e.users.delete(m.id);
      inv();
      if (u) addLog({ kind: 'event', text: `${u.login} headed out`, ts: Date.now() }, false);
      schedulePeople();
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
      inv();
      return;
    }
    case 'state': {
      const u = e.users.get(m.id);
      if (!u) return;
      const patch = { pose: m.pose, dir: m.dir };
      if ('item' in m) patch.item = m.item;
      if (u.move) u.pendingState = { ...(u.pendingState || {}), ...patch };
      else { Object.assign(u, patch); if (Number.isInteger(m.x)) { u.x = m.x; u.y = m.y; } }
      inv();
      schedulePeople();
      return;
    }
    case 'typing': { const u = e.users.get(m.id); if (u) { u.typing = m.on; inv(); } return; }
    case 'afk': { const u = e.users.get(m.id); if (u) { u.afk = m.afk; inv(); schedulePeople(); } return; }
    case 'look': {
      const u = e.users.get(m.id);
      if (u) { u.look = m.look; inv(); schedulePeople(); }
      if (m.id === state.me?.id) state.me.look = m.look;
      return;
    }
    case 'gesture': { const u = e.users.get(m.id); if (u) { u.gesture = { g: m.g, t0: performance.now() }; inv(); } return; }
    case 'react': e.addReact(m.id, m.r); return;
    case 'chat': {
      addLog(m, true);
      if (m.kind === 'say' || m.kind === 'me' || m.kind === 'whisper') {
        e.addBubble(m.uid, m.text, m.kind, { npc: !!m.npc, to: m.to });
        const u = e.users.get(m.uid);
        if (u) u.typing = false;
        hideBubblesFallback();
        inv();
      } else if (m.kind === 'announce') {
        showAnnouncement(m.login, m.text);
      } else if (m.kind === 'system' && m.id && !feedShowing()) {
        toast(m.text, 2600, { quiet: true });
      }
      return;
    }
    case 'fx':
      e.addFx(m.kind, { by: m.by });
      if (m.kind === 'deploy') e.addReact(m.by, '🚨');
      return;
    case 'stats': setStats(m.stats); return;
    case 'merged': { // someone's merged-PR count changed (a fresh contributor list landed)
      const u = e.users.get(m.id);
      if (u && Number.isFinite(m.merged)) { u.merged = m.merged; inv(); schedulePeople(); }
      if (m.id === state.me?.id && Number.isFinite(m.merged)) state.me.merged = m.merged;
      return;
    }
    case 'notice': notify(m.text); return;
    case 'kicked': {
      state.noReconnect = true;
      const banned = m.reason === 'banned';
      if (banned) ls.del(TOKEN_KEY);
      $('#room').classList.add('ended');
      // retryIn (ms from now) doesn't care whose clock is wrong; `until` is the fallback for older servers
      const retryIn = Number(m.retryIn);
      const until = retryIn > 0 && retryIn < 864e5 ? Date.now() + retryIn : Number(m.until) > Date.now() ? Number(m.until) : Date.now() + 2 * 60_000;
      // the modal has a title to say who; the note on the landing page afterwards stands alone
      const bannedText = "An admin banned this account from the lounge, so it can't come back in.";
      const later = (waiting) => (waiting ? `An admin removed you from the lounge. You can come back ${whenText(until)}.`
        : 'An admin removed you from the lounge for a bit. You can come back now.');
      const out = () => leaveRoom(banned ? { text: bannedText } : { text: later, back: true, until });
      showModal(banned ? 'Banned' : 'Removed by an admin', banned ? bannedText : `You can come back ${whenText(until)}.`,
        [{ text: 'OK', primary: true, fn: out }], out);
      return;
    }
    case 'replaced': {
      state.noReconnect = true;
      $('#room').classList.add('ended');
      const back = () => { hideModal(); $('#room').classList.remove('ended'); state.noReconnect = false; connect(); };
      showModal('Opened somewhere else', 'You checked in from another tab or device, so this one stepped out.', [
        { text: 'Use this tab', primary: true, fn: back },
      ]);
      return;
    }
    case 'purge': {
      // newer servers send the person's uid; never touch the bot's lines (a person may share its name)
      const uid = typeof m.uid === 'string' ? m.uid : null;
      const login = String(m.login || '').toLowerCase();
      for (const li of $$('#log li')) {
        const d = li.dataset;
        const hit = uid ? (d.uid === uid && !d.npc) || (d.kind === 'announce' && !d.uid && d.login === login) : d.login === login && !d.npc;
        if (hit) li.remove();
      }
      e.bubbles = e.bubbles.filter((b) => (b.npc ? true : uid ? b.uid !== uid : (b.login || '').toLowerCase() !== login));
      if (!$('#log').children.length) emptyLog();
      renderBadges(); // some of those may have been unread
      inv();
      return;
    }
    case 'clear': $('#log').replaceChildren(); emptyLog(); renderBadges(); e.bubbles = []; inv(); return;
  }
}

function setStats(s) {
  if (!s) return;
  state.engine.stats = s;
  inv();
  const n = Number(s.online) || 0;
  $('#onlineCount').textContent = fmt(n);
  $('#onlinePill').setAttribute('aria-label', `${fmt(n)} here — see who's inside`);
}

// ------------------------------------------------------------------ chat feed
const BOT_COLOR = '#ff9466';
function colorFor(m) {
  if (m.npc) return BOT_COLOR;
  const u = m.uid ? state.engine?.users.get(m.uid) : null;
  if (u && !u.npc && u.look && !u.look.bot && LOOK.topColor[u.look.topColor]) return LOOK.topColor[u.look.topColor];
  return LOOK.topColor[defaultLook(m.login || 'x').topColor];
}
function emptyLog() {
  const li = document.createElement('li');
  const s = document.createElement('span');
  s.className = 'empty';
  s.textContent = 'Quiet in here. Say hi 👋';
  li.append(s);
  $('#log').appendChild(li);
}
// http(s) links only, built with DOM nodes (never HTML), opening in a new tab without a referrer.
// CJK and full-width punctuation (U+3000-303F, U+FF00-FFEF) ends a link, so "…/a。thanks" links only "…/a".
const URL_RE = /\bhttps?:\/\/[^\s<>"'`　-〿＀-￯]+/gi;
const CLOSERS = { ')': '(', ']': '[', '}': '{' };
const count = (s, ch) => s.split(ch).length - 1;
function linkify(parent, text) {
  let last = 0;
  for (const mt of text.matchAll(URL_RE)) {
    let raw = mt[0];
    // trailing punctuation belongs to the sentence, except a bracket that closes one opened in the URL
    while (/[.,!?;:'"\])}]$/.test(raw)) {
      const end = raw.at(-1);
      if (CLOSERS[end] && count(raw, CLOSERS[end]) >= count(raw, end)) break;
      raw = raw.slice(0, -1);
    }
    let url = null;
    try { url = new URL(raw); } catch { /* not a URL */ }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) continue;
    // "https://github.com@evil.example/" goes to evil.example: a URL with a user name stays plain text
    if (url.username || url.password) continue;
    if (mt.index > last) parent.append(text.slice(last, mt.index));
    const a = document.createElement('a');
    a.href = url.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // a non-ASCII host (a Cyrillic "і" in "gіthub.com") is shown the way the browser will really go: punycode
    a.textContent = /(^|\.)xn--/i.test(url.hostname) ? raw.replace(/^(https?:\/\/)[^/?#]*/i, (_, s) => s + url.host) : raw;
    parent.append(a);
    last = mt.index + raw.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
// Screen readers hear new lines from this hidden live region, not from the log itself: the log is
// rebuilt from history on every (re)connect and is hidden while the sidebar is collapsed. Join and
// leave lines stay out of it.
function readOut(text) {
  const box = $('#chatLive');
  if (!box || !text) return;
  const p = document.createElement('p');
  p.textContent = text;
  box.append(p);
  while (box.children.length > 20) box.firstChild.remove(); // removals aren't read (aria-relevant=additions)
}
function spoken(m, text) {
  const who = asText(m.login) + (m.npc ? ' (bot)' : '');
  switch (m.kind) {
    case 'say': return `${who}: ${text}`;
    case 'me': return `${who} ${text}`;
    case 'whisper': return `${who} whispers to ${asText(m.to)}: ${text}`;
    case 'announce': return `Announcement from ${asText(m.login)}: ${text}`;
    case 'event': return '';
    default: return text;
  }
}
function countsAsUnread(m) {
  if (!['say', 'me', 'whisper', 'announce'].includes(m.kind) || m.npc) return false; // no bot, system or join lines
  const me = state.me;
  if (me && (m.uid === me.id || String(m.login || '').toLowerCase() === String(me.login || '').toLowerCase())) return false; // your own
  return true;
}
function addLog(m, live) {
  const ol = $('#log');
  ol.querySelector('.empty')?.closest('li')?.remove();
  const text = asText(m.text);
  // the same notice twice in a row (rate limits, cooldowns) is one line with a count
  if (m.kind === 'notice') {
    const last = ol.lastElementChild;
    if (last && last.dataset.kind === 'notice' && last.dataset.text === text) {
      const n = (Number(last.dataset.n) || 1) + 1;
      last.dataset.n = String(n);
      let x = last.querySelector('.x');
      if (!x) { x = document.createElement('span'); x.className = 'x'; last.querySelector('.notice').append(x); }
      x.textContent = '×' + n;
      last.querySelector('time').textContent = timeFmt.format(new Date());
      if (live) readOut(text);
      return;
    }
  }
  const li = document.createElement('li');
  li.dataset.kind = m.kind || 'system';
  if (m.login) li.dataset.login = String(m.login).toLowerCase();
  if (m.uid) li.dataset.uid = String(m.uid);
  if (m.npc) li.dataset.npc = '1';
  if (m.kind === 'notice') li.dataset.text = text;
  const ts = new Date(m.ts || Date.now());
  const time = document.createElement('time');
  time.dateTime = ts.toISOString();
  time.textContent = timeFmt.format(ts);
  const body = document.createElement('span');
  const who = () => {
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.setAttribute('aria-hidden', 'true');
    sw.style.setProperty('--sw', colorFor(m));
    const b = document.createElement('b');
    b.className = 'who';
    b.textContent = asText(m.login);
    const out = [sw, b];
    if (m.npc) { const tg = document.createElement('span'); tg.className = 'tag'; tg.textContent = 'bot'; out.push(tg); }
    return out;
  };
  const colon = () => { const s = document.createElement('span'); s.className = 'sr-only'; s.textContent = ':'; return s; };
  switch (m.kind) {
    case 'say': body.className = 'say'; body.append(...who(), colon(), ' '); linkify(body, text); break;
    case 'me': body.className = 'me'; body.append(...who(), ' '); linkify(body, text); break;
    case 'whisper': body.className = 'wh'; body.append(...who(), ` → ${asText(m.to)}: `); linkify(body, text); break;
    case 'announce': body.className = 'ann'; body.append('📣 '); linkify(body, text); break;
    case 'event': body.className = 'ev'; body.textContent = text; break;
    case 'notice': body.className = 'notice'; body.textContent = text; break;
    default: body.className = 'sys'; linkify(body, text);
  }
  li.append(time, body);
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  ol.appendChild(li);
  while (ol.children.length > 300) ol.firstChild.remove();
  if (atBottom || !live) ol.scrollTop = ol.scrollHeight;
  if (live) readOut(spoken(m, text));
  const unread = live && !fullFeed() && countsAsUnread(m);
  if (unread) li.classList.add('unread');
  if (unread || state.unread) renderBadges(); // the cap above may have dropped unread lines
}
// A line just for you (command results, rate limits, "X waved at you"): into the feed, and a toast
// only when the feed can't be seen (quiet: readOut already said it).
function notify(text) {
  addLog({ kind: 'notice', text, ts: Date.now() }, true);
  if (!feedShowing()) toast(text, 3200, { quiet: true });
}

function showAnnouncement(login, text) {
  const el = $('#announce');
  el.replaceChildren();
  const s = document.createElement('small');
  s.textContent = `ANNOUNCEMENT · @${login}`;
  el.append(s, document.createTextNode(text));
  el.hidden = false;
  clearTimeout(showAnnouncement.t);
  showAnnouncement.t = setTimeout(() => { el.hidden = true; }, 12000);
}

// ------------------------------------------------------------------ first-visit tips
function setupCoach() {
  $('#hintClose').addEventListener('click', () => hintDone());
  opensSheet($('#lookNudgeGo'), () => openWardrobe(true), $('#btnWardrobe')); // the nudge is gone by then
  $('#lookNudgeClose').addEventListener('click', () => nudgeDone());
}
function startCoach() {
  if (!ls.get(HINT_KEY)) $('#hint').hidden = false;
  else maybeNudge(3500);
}
function hintDone() {
  const showing = !$('#hint').hidden;
  $('#hint').hidden = true;
  if (!ls.get(HINT_KEY)) ls.set(HINT_KEY, '1');
  if (showing) maybeNudge(1800);
}
// the wardrobe never opens by itself: a small nudge instead, gone for good once used or dismissed
function maybeNudge(ms) {
  clearTimeout(ui.nudgeT);
  if (state.me?.customized || ls.get(NUDGE_KEY)) return;
  ui.nudgeT = setTimeout(() => {
    if (!$('#room').hidden && !state.me?.customized && !ls.get(NUDGE_KEY) && !isOpen('sheetWardrobe')) $('#lookNudge').hidden = false;
  }, ms);
}
function nudgeDone() { clearTimeout(ui.nudgeT); $('#lookNudge').hidden = true; ls.set(NUDGE_KEY, '1'); }
function hideCoach() { clearTimeout(ui.nudgeT); $('#hint').hidden = true; $('#lookNudge').hidden = true; }

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
  cv.addEventListener('pointerleave', () => { e.hoverTile = null; e.hoverLabel = null; inv(); });
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
    if ($('#room').hidden) return;
    if (ev.key === 'Escape') { onEscape(ev); return; }
    if (ev.key === 'Tab') { trapTab(ev); return; }
    if (ev.key !== 'Enter' && ev.key !== '/') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // Enter or / jumps to the chat box only from "nowhere" (the page itself or the room), never from a
    // button, link or field: there Enter has to do what it normally does.
    const ae = document.activeElement;
    const idle = !ae || ae === document.body || ae === document.documentElement || ae === cv;
    if (!idle || activeDialog()) return;
    ev.preventDefault();
    const input = $('#chatInput');
    input.focus();
    if (ev.key === '/' && !input.value) input.value = '/';
  });
}
function onEscape(ev) {
  if (!$('#modal').hidden) { modal.escape?.(); return; }
  // Esc in a search box that has text clears the text (and only that); the next Esc closes the panel
  const t = ev?.target;
  if (t?.matches?.('input[type="search"]') && t.value) {
    ev.preventDefault();
    t.value = '';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (!$('#menu').hidden) { closeMenu(true); return; }
  if (anySheetOpen()) { closeAllSheets(); return; }
  if (!$('#tray').hidden) { setTray(false); $('#trayBtn').focus(); return; }
  if (ui.panelOpen) { setPanel(false); $('#chatExpand').focus(); return; }
  if (document.activeElement === $('#chatInput')) $('#chatInput').blur();
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
  if (hit) {
    if (hit.type === 'tile') e.hoverTile = hit;
    else if (hit.type === 'user') { pointer = true; const u = e.users.get(hit.id); if (u) e.hoverLabel = { text: u.npc ? `${u.login} · the lounge bot` : `@${u.login} · ${fmt(u.merged)} merged`, dx: x * e.dpr, dy: y * e.dpr }; }
    else if (hit.type === 'furn') {
      const l = typeof LABELS[hit.f.kind] === 'function' ? LABELS[hit.f.kind]() : LABELS[hit.f.kind];
      if (l) { pointer = true; e.hoverLabel = { text: l, dx: x * e.dpr, dy: y * e.dpr }; }
    } else if (hit.type === 'wall' && hit.w.id === 'fame') { pointer = true; e.hoverLabel = { text: 'wall of fame', dx: x * e.dpr, dy: y * e.dpr }; }
  }
  inv();
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
      inv();
      hintDone();
      return;
    }
    if (f.kind === 'rack') return toast(`${rackLabel(f)}: humming along. ${fmt(e.stats.mergedPRs)} merged PRs indexed.`);
    if (f.kind === 'arcade') return toast(f.hue === 'pink' ? 'PONG.AI — insert token. (you have plenty.)' : 'CONTEXT INVADERS — high score: whoever merged last.');
    if (f.kind === 'plant') return toast('🪴 well watered. unlike the test suite.');
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
    inv();
    hintDone();
  }
}

// ------------------------------------------------------------------ dock: chat + tray
function setupDock() {
  const input = $('#chatInput');
  $('#chatForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (text === '/help') { input.value = ''; openSheet('sheetHelp'); return; }
    // offline or still connecting: nothing is sent and nothing is lost; the text stays in the box
    if (!state.connected || !send({ t: 'chat', text })) {
      toast(state.offline ? "You're offline. Your message is still in the box — send it again once you're back." : 'Still connecting — try again in a moment.', 3200, { offline: true });
      return;
    }
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
  $('#trayBtn').addEventListener('click', () => setTray($('#tray').hidden));
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
function setTray(open) {
  $('#tray').hidden = !open;
  $('#trayBtn').setAttribute('aria-expanded', String(open));
  requestAnimationFrame(() => measureInsets());
}
function setTyping(on) {
  if (on === state.typing) return;
  state.typing = on;
  send({ t: 'typing', on });
}

// ------------------------------------------------------------------ sheets (dialogs) & the menu
const SHEETS = ['sheetPeople', 'sheetFame', 'sheetWardrobe', 'sheetProfile', 'sheetHelp'];
// trigger: where focus goes back when the sheets close. opener: the button being clicked right now, if it
// opens a sheet (see opensSheet).
const dlg = { trigger: null, opener: null };
function isOpen(id) { return !$('#' + id).hidden; }
function anySheetOpen() { return SHEETS.some(isOpen); }
// Phones: a sheet covers the room and the chat, so it's a modal dialog and Tab stays inside it. Wide
// screens: it sits beside the pinned chat, which stays usable, so it's a non-modal dialog (no Tab trap).
const sheetsModal = () => !wideMQ.matches;
function syncSheetModality() { for (const s of SHEETS) $('#' + s).setAttribute('aria-modal', String(sheetsModal())); }
function activeDialog() {
  if (!$('#modal').hidden) return $('#modal .modal-card');
  const id = sheetsModal() ? SHEETS.find(isOpen) : null;
  return id ? $('#' + id) : null;
}
// where focus goes when what had it is gone: the room itself (Enter or / from there jumps to the chat box)
function focusRoom() { moveFocus($('#stage')); }
function rememberFocus() {
  const a = document.activeElement;
  if (!a || a === document.body || a === $('#stage')) return null;
  if (a.closest('#menu')) return $('#btnMenu');
  if (coarseMQ.matches && a.matches('input')) return null; // don't pop the keyboard back up on close
  return a;
}
function openSheet(id) {
  if (dlg.opener) dlg.trigger = dlg.opener;
  else if (!anySheetOpen()) dlg.trigger = rememberFocus();
  if (id !== 'sheetWardrobe' && isOpen('sheetWardrobe')) cancelWardrobe();
  for (const s of SHEETS) $('#' + s).hidden = s !== id;
  closeMenu(false);
  $('#room').classList.toggle('sheet-open', true);
  const el = $('#' + id);
  $('#room').classList.toggle('tall-sheet', !el.classList.contains('small')); // wide: notices move left of it
  requestAnimationFrame(() => { if (!el.hidden) moveFocus(el); });
}
function closeAllSheets(restore = true) {
  const was = anySheetOpen();
  // Focus goes back to what opened the sheet, wherever it is now (on wide screens Tab can leave the sheet,
  // which isn't modal there), except from a text box beside it: someone typing in the chat stays put.
  const ae = document.activeElement;
  const typing = typingIn(ae) && !SHEETS.some((s) => $('#' + s).contains(ae));
  if (isOpen('sheetWardrobe')) cancelWardrobe();
  for (const s of SHEETS) $('#' + s).hidden = true;
  $('#room').classList.remove('sheet-open', 'tall-sheet');
  const t = dlg.trigger;
  dlg.trigger = null;
  if (!was || !restore || typing) return;
  if (t && t.isConnected && t.getClientRects().length) moveFocus(t);
  else focusRoom();
}
function closeFloating() {
  closeMenu(false);
  if (isOpen('sheetProfile')) closeAllSheets(false);
}
function focusables(box) {
  return [...box.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.getClientRects().length > 0);
}
// Tab and Shift+Tab stay inside an open dialog
function trapTab(ev) {
  const box = activeDialog();
  if (!box) { menuTab(ev); return; }
  const f = focusables(box);
  if (!f.length) { ev.preventDefault(); box.focus(); return; }
  const first = f[0], last = f[f.length - 1], ae = document.activeElement;
  const go = (el) => { ev.preventDefault(); if (el === ae) showRing(el); else el.focus(); };
  if (!box.contains(ae)) go(ev.shiftKey ? last : first);
  else if (ev.shiftKey && (ae === first || ae === box)) go(last);
  else if (!ev.shiftKey && ae === last) go(first);
}
function menuItems() { return [...$('#menu').querySelectorAll('button, a[href]')]; }
function openMenu() {
  $('#menu').hidden = false;
  $('#btnMenu').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => moveFocus(menuItems()[0]));
}
function closeMenu(focusBtn) {
  if ($('#menu').hidden) return;
  $('#menu').hidden = true;
  $('#btnMenu').setAttribute('aria-expanded', 'false');
  if (focusBtn) moveFocus($('#btnMenu'));
}
// tabbing off either end of the menu closes it
function menuTab(ev) {
  if ($('#menu').hidden || !$('#menu').contains(document.activeElement)) return;
  const items = menuItems();
  if ((!ev.shiftKey && document.activeElement === items[items.length - 1]) || (ev.shiftKey && document.activeElement === items[0])) closeMenu(false);
}

const modal = { escape: null, trigger: null };
function showModal(title, text, buttons, onEscape) {
  if ($('#modal').hidden) modal.trigger = anySheetOpen() ? dlg.trigger : rememberFocus();
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  const box = $('#modalBtns');
  box.replaceChildren();
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + (b.primary ? 'primary' : 'ghost');
    el.textContent = b.text;
    el.addEventListener('click', b.fn);
    box.appendChild(el);
  }
  modal.escape = onEscape || null;
  closeAllSheets(false);
  closeMenu(false);
  $('#modal').hidden = false;
  moveFocus($('#modalBtns .primary') || $('#modal .modal-card')); // now, not a frame later
}
// restore: focus goes back where it was before the modal (or to the room). leaveRoom passes false.
function hideModal(restore = true) {
  const was = !$('#modal').hidden;
  $('#modal').hidden = true;
  modal.escape = null;
  const t = modal.trigger;
  modal.trigger = null;
  if (!was || !restore || $('#room').hidden) return;
  if (t && t.isConnected && t.getClientRects().length) moveFocus(t);
  else focusRoom();
}

// A button that opens a sheet is where focus returns when it closes. It's handed over here rather than read
// from document.activeElement, because a click doesn't focus a button in every browser (Safari on a Mac).
function opensSheet(btn, fn, returnTo = btn) {
  btn.addEventListener('click', (ev) => {
    dlg.opener = returnTo;
    try { fn(ev); } finally { dlg.opener = null; }
  });
}
function setupSheets() {
  opensSheet($('#btnFame'), () => (isOpen('sheetFame') ? closeAllSheets() : openFame()));
  opensSheet($('#btnWardrobe'), () => (isOpen('sheetWardrobe') ? closeAllSheets() : openWardrobe(false)));
  opensSheet($('#btnHelp'), () => (isOpen('sheetHelp') ? closeAllSheets() : openSheet('sheetHelp')));
  opensSheet($('#onlinePill'), () => (isOpen('sheetPeople') ? closeAllSheets() : openPeople()));
  $('#btnMenu').addEventListener('click', (ev) => { ev.stopPropagation(); if ($('#menu').hidden) openMenu(); else closeMenu(false); });
  $('#menu').addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const items = menuItems();
    const i = items.indexOf(document.activeElement);
    items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });
  for (const c of $$('[data-close]')) c.addEventListener('click', () => closeAllSheets());
  opensSheet($('#mHelp'), () => openSheet('sheetHelp'), $('#btnMenu')); // the menu closes; its button stays
  $('#mLogout').addEventListener('click', async () => {
    closeMenu(false);
    const tok = state.token;
    ls.del(TOKEN_KEY);
    state.token = null;
    leaveRoom("You're logged out. Check in again any time.");
    try { await api('/api/logout', {}, tok); } catch { /* ignore */ }
  });
  document.addEventListener('click', (ev) => {
    if (!$('#menu').hidden && !ev.target.closest('#menu') && !ev.target.closest('#btnMenu')) closeMenu(false);
  });
  $('#fameSearch').addEventListener('input', renderFame);
}

// ------------------------------------------------------------------ people here
function openPeople() { openSheet('sheetPeople'); renderPeople(); }
function schedulePeople() {
  if (ui.peopleRaf || !isOpen('sheetPeople')) return;
  ui.peopleRaf = requestAnimationFrame(() => { ui.peopleRaf = 0; renderPeople(); });
}
function statusLine(u) {
  if (u.npc) return 'the lounge bot';
  const bits = [`${fmt(u.merged)} merged`];
  if (u.admin) bits.push('admin');
  if (u.afk) bits.push('away');
  else if (u.pose === 'sit' || u.pose === 'sitf') bits.push('sitting');
  else if (u.pose === 'dance') bits.push('dancing');
  return bits.join(' · ');
}
function renderPeople() {
  if (!isOpen('sheetPeople') || !state.engine) return;
  const meId = state.me?.id;
  const list = [...state.engine.users.values()].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : (Number(!!a.npc) - Number(!!b.npc)) || a.login.localeCompare(b.login)));
  const humans = list.filter((u) => !u.npc).length;
  $('#peopleSub').textContent = `${humans} ${humans === 1 ? 'person' : 'people'} inside`;
  const focused = document.activeElement?.closest?.('#peopleList [data-id]');
  const keep = focused ? [focused.dataset.id, focused.dataset.act] : null;
  const ul = $('#peopleList');
  ul.replaceChildren();
  for (const u of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'person';
    b.dataset.id = u.id;
    b.dataset.act = 'profile';
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.setAttribute('aria-hidden', 'true');
    sw.style.setProperty('--sw', colorFor({ uid: u.id, login: u.login, npc: u.npc }));
    const nm = document.createElement('span');
    nm.className = 'nm';
    const name = document.createElement('b');
    name.textContent = (u.npc ? u.login : '@' + u.login) + (u.id === meId ? ' (you)' : '');
    const sm = document.createElement('small');
    sm.textContent = statusLine(u);
    nm.append(name, sm);
    b.append(sw, nm);
    b.addEventListener('click', () => openProfile(u.id, { back: 'sheetPeople' }));
    li.append(b);
    if (!u.npc && u.id !== meId) {
      const w = document.createElement('button');
      w.type = 'button';
      w.className = 'btn ghost small';
      w.textContent = 'Whisper';
      w.dataset.id = u.id;
      w.dataset.act = 'whisper';
      w.setAttribute('aria-label', `Whisper to @${u.login}`);
      w.addEventListener('click', () => startWhisper(u.login));
      li.append(w);
    }
    ul.append(li);
  }
  if (keep) ul.querySelector(`[data-id="${CSS.escape(keep[0])}"][data-act="${keep[1]}"]`)?.focus();
}
function startWhisper(login) {
  closeAllSheets(false);
  const i = $('#chatInput');
  i.value = `/w @${login} `;
  i.focus();
  i.setSelectionRange(i.value.length, i.value.length);
}

// ------------------------------------------------------------------ wall of fame
async function loadFame(force) {
  if (!force && state.fame && Date.now() - state.fameAt < 60_000) return state.fame;
  try {
    const r = await api('/api/fame', null, state.token);
    if (r.list) {
      state.fame = r;
      state.fameAt = Date.now();
      state.engine.setFame(r.list);
      inv();
    }
  } catch { /* ignore */ }
  return state.fame;
}
async function openFame() {
  openSheet('sheetFame');
  if (!state.fame) $('#fameSub').textContent = 'loading…';
  await loadFame(true);
  if (!state.fame) {
    $('#fameSub').textContent = '';
    const em = $('#fameEmpty');
    em.textContent = "Couldn't load the wall just now. Try again in a moment.";
    em.hidden = false;
    return;
  }
  renderFame();
}
function renderFame() {
  const f = state.fame;
  if (!f) return;
  const raw = $('#fameSearch').value.trim();
  const q = raw.toLowerCase();
  const visited = f.list.filter((x) => x.visited).length;
  $('#fameSub').textContent = `${fmt(f.list.length)} merged contributors · ${fmt(f.total)} PRs · ${fmt(visited)} have visited`;
  const ol = $('#fameList');
  ol.replaceChildren();
  const frag = document.createDocumentFragment();
  let shown = 0;
  f.list.forEach((c, i) => {
    if (q && !c.login.toLowerCase().includes(q)) return;
    shown++;
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fame-row';
    b.setAttribute('aria-label', `#${i + 1} @${c.login}, ${fmt(c.merged)} merged PR${c.merged === 1 ? '' : 's'}${c.online ? ', in the lounge now' : ''}`);
    const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = '#' + (i + 1);
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = `https://avatars.githubusercontent.com/${encodeURIComponent(c.login)}?s=64`;
    img.width = 32; img.height = 32;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.login;
    const sm = document.createElement('small');
    sm.textContent = c.online ? '' : c.visited ? `visited · first merge ${c.first}` : `first merge ${c.first}`;
    if (c.online) { const on = document.createElement('span'); on.className = 'on'; on.textContent = '● in the lounge'; sm.appendChild(on); }
    nm.appendChild(sm);
    const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = fmt(c.merged);
    b.append(rank, img, nm, ct);
    b.addEventListener('click', () => openFameEntry(c));
    li.appendChild(b);
    frag.appendChild(li);
  });
  ol.appendChild(frag);
  ol.hidden = shown === 0;
  const em = $('#fameEmpty');
  if (!f.list.length) { em.textContent = 'The contributor list is still being put together. Check back in a few minutes.'; em.hidden = false; }
  else if (!shown) { em.textContent = `No contributors match “${raw}”.`; em.hidden = false; }
  else em.hidden = true;
}

// ------------------------------------------------------------------ profile card
function drawSpriteTo(canvas, look, view = 'front', flip = false, pose = 'stand', frame = 0) {
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.drawImage(avatarSprite(look, { view, pose, frame, flip }), 0, 0);
}
function profileButtons() {
  const actions = $('#pfActions');
  actions.replaceChildren();
  return (text, cls, fn, href) => {
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'btn ' + cls;
    el.textContent = text;
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    else { el.type = 'button'; el.addEventListener('click', fn); }
    actions.appendChild(el);
    return el;
  };
}
const BACK_TO = { sheetFame: 'Back to the wall of fame', sheetPeople: 'Back to people here' };
function addBack(btn, back) {
  if (!BACK_TO[back]) return;
  const el = btn(`← ${BACK_TO[back]}`, 'small back', () => {
    if (back === 'sheetFame') { openSheet('sheetFame'); renderFame(); } else openPeople();
  });
  el.classList.remove('btn');
  el.classList.add('link');
}
function openProfile(id, { back } = {}) {
  const e = state.engine;
  const u = e.users.get(id);
  if (!u) return;
  openSheet('sheetProfile');
  $('#sheetProfile .profile').classList.remove('offline-card');
  $('#pfSprite').hidden = false;
  drawSpriteTo($('#pfSprite'), u.look);
  const img = $('#pfImg');
  const btn = profileButtons();
  if (u.npc) {
    img.hidden = true;
    $('#pfName').textContent = u.login;
    $('#pfLine1').textContent = "The lounge's resident bot. It watches, takes notes, and greets people at the door.";
    $('#pfLine2').textContent = `Say "${u.login}" in chat and it might answer.`;
    btn('Ask for /stats', 'ghost', () => { send({ t: 'chat', text: '/stats' }); closeAllSheets(); });
    addBack(btn, back);
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
    btn('Wave 👋', 'primary', () => {
      // everyone sees the wave; the person gets "@you waved at you", at most once per 10 s per pair.
      // ack: the server says "You waved at @x" only when that ping really went out (not muted, not
      // inside the 10 s), so this feed never claims a ping that was blocked.
      closeAllSheets();
      if (!send({ t: 'emote', e: 'wave', to: u.login, ack: true })) notify(`You're offline, so @${u.login} didn't see your wave.`);
    });
    btn('Whisper', 'ghost', () => startWhisper(u.login));
    btn('Their PRs ↗', 'ghost', null, prs);
    btn('GitHub ↗', 'ghost', null, `https://github.com/${encodeURIComponent(u.login)}`);
  }
  addBack(btn, back);
}
// a wall-of-fame entry: their card in the lounge first, GitHub second
function openFameEntry(c) {
  const id = c.login.toLowerCase();
  const u = state.engine.users.get(id);
  if (u && !u.npc) return openProfile(id, { back: 'sheetFame' });
  openSheet('sheetProfile');
  $('#sheetProfile .profile').classList.add('offline-card');
  $('#pfSprite').hidden = true;
  const img = $('#pfImg');
  img.hidden = false;
  img.src = `https://avatars.githubusercontent.com/${encodeURIComponent(c.login)}?s=136`;
  $('#pfName').textContent = '@' + c.login;
  $('#pfLine1').textContent = `${fmt(c.merged)} merged PR${c.merged === 1 ? '' : 's'} in ${CFG.project.name}`;
  const dates = [c.first && `first merge ${c.first}`, c.last && `latest ${c.last}`].filter(Boolean).join(' · ');
  $('#pfLine2').textContent = [dates, c.visited ? 'has visited the lounge' : "hasn't visited yet"].filter(Boolean).join(' · ');
  const btn = profileButtons();
  btn('Their PRs ↗', 'ghost', null, prsUrl(c.login));
  btn('GitHub ↗', 'ghost', null, `https://github.com/${encodeURIComponent(c.login)}`);
  addBack(btn, 'sheetFame');
}

// ------------------------------------------------------------------ wardrobe
const W_GROUPS = [
  ['hairStyle', 'Hair', 'chips'], ['hairColor', 'Hair color', 'swatch'], ['skin', 'Skin', 'swatch'],
  ['top', 'Top', 'chips'], ['topColor', 'Top color', 'swatch'], ['pants', 'Pants', 'swatch'],
  ['shoes', 'Shoes', 'swatch'], ['acc', 'Extra', 'chips'],
];
// A plain name for a swatch colour, so screen readers say more than "Hair color 3": lightness + hue
// words worked out from the hex, so colours appended to the wardrobe later get names too.
function hslOf(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return { h, s, l, d };
}
const SKIN_WORDS = [[0.86, 'very light'], [0.78, 'light'], [0.70, 'light medium'], [0.62, 'medium'], [0.55, 'medium tan'],
  [0.48, 'tan'], [0.38, 'brown'], [0.27, 'dark brown'], [0.20, 'deep brown'], [0, 'very dark brown']];
function colorWords(hex, key) {
  const c = hslOf(hex);
  if (!c) return 'colour';
  const { h, s, l, d } = c;
  if (key === 'skin') return SKIN_WORDS.find(([min]) => l >= min)[1];
  const hair = key === 'hairColor';
  if (s < 0.12 || d < 0.06) {
    const grey = l < 0.12 ? 'black' : l < 0.24 ? 'charcoal' : l < 0.42 ? 'dark grey' : l < 0.65 ? 'grey' : l < 0.85 ? 'light grey' : l < 0.95 ? 'off-white' : 'white';
    return hair && grey === 'off-white' ? 'white' : grey;
  }
  const warm = h >= 12 && h < 68;
  if (warm && l < 0.45 && h < 50) { // the browns
    const tone = l < 0.25 ? 'dark ' : l >= 0.38 ? 'light ' : '';
    return tone + (h < 18 ? (hair ? 'auburn' : 'red-brown') : 'brown');
  }
  if (warm && s < 0.45 && l < 0.9) return hair ? (l > 0.72 ? 'light blonde' : 'dark blonde') : l >= 0.72 ? 'beige' : 'tan';
  if (l >= 0.9 && s < 0.7) return hair ? 'platinum' : 'off-white';
  let hue = h < 12 || h >= 345 ? 'red' : h < 34 ? 'orange' : h < 50 ? 'gold' : h < 68 ? 'yellow' : h < 90 ? 'yellow-green'
    : h < 155 ? 'green' : h < 190 ? 'teal' : h < 250 ? 'blue' : h < 290 ? 'purple' : 'pink';
  if (hue === 'yellow-green' && l < 0.4) hue = 'olive';
  if (hair && (hue === 'gold' || hue === 'yellow')) hue = 'blonde';
  else if (hair && hue === 'orange') hue = 'ginger';
  const tone = l < 0.22 ? 'very dark ' : l < 0.35 ? 'dark ' : l > 0.85 ? 'pale ' : l > 0.72 ? 'light ' : '';
  const muted = s < 0.3 && l >= 0.3 && l <= 0.75 ? 'greyish ' : '';
  return tone + muted + hue;
}
// Names for a whole LOOK list, unique within it: the first keeps the plain name, a later colour that
// comes out the same gets a number ("blue 2"). Works for lists of any length; cached per list contents.
const swatchNameCache = new Map();
function swatchNames(key) {
  const list = LOOK[key] || [];
  const ck = key + ':' + list.join(',');
  if (!swatchNameCache.has(ck)) {
    const seen = new Map();
    swatchNameCache.set(ck, list.map((v) => {
      const n = colorWords(v, key);
      const k = (seen.get(n) || 0) + 1;
      seen.set(n, k);
      return k === 1 ? n : `${n} ${k}`;
    }));
  }
  return swatchNameCache.get(ck);
}
const ward = { look: null, original: null, dir: 0, raf: 0, drawn: '' };
function setupWardrobe() {
  $('#wRotate').addEventListener('click', () => { ward.dir = (ward.dir + 1) % 4; drawWardrobe(); });
  onMQ(reduceMQ, () => { if (isOpen('sheetWardrobe')) startWardrobeAnim(); });
  $('#wShuffle').addEventListener('click', () => {
    const l = {};
    for (const k of Object.keys(LOOK)) l[k] = Math.floor(Math.random() * LOOK[k].length);
    ward.look = l;
    syncWardrobeOpts();
  });
  $('#wSave').addEventListener('click', () => {
    send({ t: 'look', look: ward.look });
    ward.original = null;
    if (state.me) state.me.customized = true;
    nudgeDone();
    closeAllSheets();
    toast('Looking sharp.');
  });
}
function openWardrobe(fromNudge) {
  nudgeDone(); // found it: the nudge has done its job
  const me = state.engine.users.get(state.me?.id);
  const look = me?.look || state.me?.look || defaultLook(state.me?.login || 'x');
  ward.original = { ...look };
  ward.look = { ...look };
  $('#wardrobeSub').textContent = fromNudge ? 'first time here — make yourself at home' : 'tap to try things on';
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
  box.replaceChildren();
  for (const [key, label, kind] of W_GROUPS) {
    const sec = document.createElement('div');
    sec.className = 'opt';
    sec.setAttribute('role', 'group');
    const h = document.createElement('h3');
    h.id = 'wg-' + key;
    h.textContent = label;
    sec.setAttribute('aria-labelledby', h.id);
    const ch = document.createElement('div');
    ch.className = 'choices';
    const names = kind === 'swatch' ? swatchNames(key) : null;
    LOOK[key].forEach((v, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.key = key;
      b.dataset.i = String(i);
      if (kind === 'swatch') { b.className = 'swatch'; b.style.background = v; b.setAttribute('aria-label', names[i]); b.title = names[i]; }
      else { b.className = 'choice'; b.textContent = v; }
      b.addEventListener('click', () => { ward.look[key] = i; syncWardrobeOpts(); });
      ch.appendChild(b);
    });
    sec.append(h, ch);
    box.appendChild(sec);
  }
  syncWardrobeOpts();
}
// update the pressed state in place, so keyboard focus stays on the option just picked
function syncWardrobeOpts() {
  for (const b of $$('#wOpts [data-key]')) {
    const on = ward.look?.[b.dataset.key] === Number(b.dataset.i);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  drawWardrobe();
}
// The preview walks in place; it only redraws when the picture would change (a new walk frame, a turn,
// a new pick). Reduced motion: it stands still and redraws only on a turn or a pick, with no loop at all.
const W_VIEWS = [['front', false], ['front', true], ['back', true], ['back', false]];
function drawWardrobe(t = performance.now()) {
  if (!ward.look || !isOpen('sheetWardrobe')) return;
  const still = reduceMQ.matches;
  const frame = still ? 0 : Math.floor(t / 140) % 4;
  const k = `${ward.dir}|${frame}|${still}|${JSON.stringify(ward.look)}`;
  if (k === ward.drawn) return;
  ward.drawn = k;
  const [view, flip] = W_VIEWS[ward.dir];
  drawSpriteTo($('#wPreview'), ward.look, view, flip, still ? 'stand' : 'walk', frame);
}
function startWardrobeAnim() {
  stopWardrobeAnim();
  ward.drawn = '';
  drawWardrobe();
  const tick = (t) => {
    ward.raf = 0;
    if (reduceMQ.matches || !isOpen('sheetWardrobe')) return;
    drawWardrobe(t);
    ward.raf = requestAnimationFrame(tick);
  };
  if (!reduceMQ.matches) ward.raf = requestAnimationFrame(tick);
}
function stopWardrobeAnim() { cancelAnimationFrame(ward.raf); ward.raf = 0; }

if (new URLSearchParams(location.search).has('debug')) window.__lounge = { state, send, P: null };

// =================================================================== boot
(async function boot() {
  await loadConfig();
  setInterval(() => { if (!$('#landing').hidden) refreshLive(); }, 30000);
  const token = ls.get(TOKEN_KEY);
  if (token) {
    try {
      const r = await api('/api/me', null, token);
      if (r.ok) return enterRoom(token);
      if (r.status === 401) { ls.del(TOKEN_KEY); return showLanding('Your session expired — check in again.'); }
    } catch { /* fall through to the landing page */ }
  }
  showLanding();
})();
