// Lounge settings: the defaults, how a lounge.config.json is merged over them, and the checks.
// Imported by the server (Node) and the browser, so it has no imports of its own.
//
// A config that only sets `repo` gives a complete, generic lounge: the sign, the blimp, the
// project name and the check-in code prefix are all worked out from the repo name.

export const DEFAULTS = {
  repo: '',
  loungeName: 'Merge Lounge',
  project: { name: '', url: '', tagline: '' },
  admins: [],
  timezone: 'America/Los_Angeles',
  neon: { top: '', bottom: '' },
  blimp: '',
  skyline: {
    city: '',
    // Each rooftop sign walks this list in order as it "rebrands" (the old name glitches into the next), so
    // the list reads as one startup's life story on a loop: stealth, waitlist, … acquihire, stealth again.
    names: [
      'STEALTH', 'WAITLIST', 'DEMOWARE', 'PRE-REV', 'SERIES A', 'GPU BARN', 'WRAPPER', 'PLATFORM',
      'AGENTIC', '10X-ISH', 'MONOREPO', 'YOLO OPS', 'HOTFIX', 'TECH DEBT', 'LGTM CAP', 'FLAKY CI',
      'SERIES Z', 'BURN RATE', 'PIVOT 9', 'AI AI AI', 'OPEN-ISH', 'AGI SOON', 'DOWNROUND', 'ACQUIHIRE',
    ],
    // Five freeway billboards show at a time; every 45 s they move on to the next five pairs (valley.js),
    // so the whole list comes round.
    billboards: [
      ['HIRING: 10X', 'PROMPTER'], ['CODE REVIEW', 'IN 6-8 WEEKS'], ['ZERO-SHOT', 'ZERO SLEEP'],
      ['NOW WITH', 'AGENTS'], ['OPEN WEIGHTS.', 'CLOSED DOORS.'], ['$1B VALUATION', '$0 REVENUE'],
      ['MERGED >', 'PERFECT'], ['WORKS GREAT', 'IN THE DEMO'], ['AGI BY Q3', '(MAYBE)'],
      ['TESTS', 'PASSING*'], ['100% ACCURATE', 'SOURCE: ME'], ['NOW HIRING:', 'ONE HUMAN'],
    ],
  },
  ticker: [
    '{contributors} MERGED CONTRIBUTORS',
    '{mergedPRs} PRS MERGED',
    'WAITLIST NOW HAS A WAITLIST',
    '{online} IN THE LOUNGE',
    'STEALTH ANNOUNCES IT IS STILL IN STEALTH',
    '{gongs:GONG} TODAY',
    'LGTM CAP APPROVES DEAL WITHOUT OPENING IT',
    '{deploys:DEPLOY} TO PROD TODAY',
    'PIVOT 9 PIVOTS TO PIVOT 10',
    'WELCOME TO THE {loungeName}',
  ],
  bot: {
    // chat history refers to the bot as bot:<name>, so a running lounge should keep the name it started with
    name: 'doorbot',
    // greet and welcomeBack must read right for anyone: an `allow`-listed guest has 0 merged PRs.
    greet: [
      'welcome in, @{login} — {merged:merged PR}. make yourself at home.',
      '@{login} just walked in. {merged:merged PR} and counting.',
      'new face: @{login} ({merged:merged PR}). pick a beanbag.',
    ],
    welcomeBack: [
      'welcome back, @{login}. last seen {ago}.',
      '@{login} is back. your beanbag missed you.',
    ],
    mention: [
      'beep. still here.',
      'noted.',
      "i've read every merged PR in this repo. yes, even that one.",
      'try /stats if you want the receipts.',
      'my opinions are a config file.',
      "you rang? that's the gong's job.",
      "i'd help, but my whole job is standing near the beanbags.",
      'ask me again after the next release.',
    ],
    idle: [
      'tip: tap the fridge for a kombucha, or the bar for a cold brew.',
      'tip: tap anyone to see their merged PRs.',
      'tip: the gong is for merges. ring responsibly.',
      'tip: /dance exists.',
      'tip: the wall of fame (left wall) lists every merged contributor.',
      'tip: whisper with /w @someone your message.',
      "tip: the big red button deploys to prod. it doesn't.",
    ],
    gong: [
      '🔔 shipped. noted.',
      'merge energy detected.',
      'another one in the books.',
      'LGTM, retroactively.',
      "somebody's PR just became everybody's problem.",
    ],
    deploy: [
      'rolling back… jk.',
      'on-call has been paged. (it is you.)',
      'no tests were harmed in this deploy. none were run.',
      'deploy complete. rollback plan: vibes.',
      'ship it. ship it all.',
    ],
  },
  codePrefix: '',
  theme: { accent: '#f26b3a' },
  allow: [],
  minMergedPRs: 1,
};

// Limits that keep the lettering inside the room art.
export const LIMITS = { neonTop: 11, neonBottom: 11, blimp: 7, skylineName: 10, billboardLine: 14, tickerLine: 80, botLine: 240 };

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const BOT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,18}[A-Za-z0-9])?$/;
const PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const KNOWN = new Set(Object.keys(DEFAULTS));

const NESTED = ['project', 'neon', 'skyline', 'bot', 'theme'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const sameRepo = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
const isNote = (k) => k.startsWith('$') || k.startsWith('_'); // "$comment"-style keys are left alone

// "https://github.com/owner/name(.git)(/anything)" → "owner/name", anything else → ''
export function githubRepoOf(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/?#]|$)/i.exec(str(url));
  return m ? `${m[1]}/${m[2]}` : '';
}

// Text colour for buttons painted in the accent colour: dark or light, whichever reads better (WCAG contrast).
export const ACCENT_INK = { dark: '#1b1007', light: '#fff8ef' };
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
export function accentInk(accent) {
  if (!/^#[0-9a-f]{6}$/i.test(str(accent))) return ACCENT_INK.dark;
  return contrast(accent, ACCENT_INK.dark) >= contrast(accent, ACCENT_INK.light) ? ACCENT_INK.dark : ACCENT_INK.light;
}

// "hello-world" → ['HELLO', 'WORLD'], "fastAPI_tools" → ['FAST', 'API', 'TOOLS']
export function splitWords(name) {
  return str(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

export function slug(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Neon sign: two lines. "hello-world" → HELLO / WORLD. One-word names go on the top line.
export function deriveNeon(name) {
  const w = splitWords(name);
  if (!w.length) return { top: 'MERGE', bottom: 'LGTM' };
  if (w.length === 1) return w[0].length <= 4 ? { top: '', bottom: w[0] } : { top: w[0].slice(0, LIMITS.neonTop), bottom: 'LGTM' };
  // the top line takes as many leading words as fit, whole
  let top = '';
  for (const x of w.slice(0, -1)) {
    const next = top ? `${top} ${x}` : x;
    if (next.length > LIMITS.neonTop) break;
    top = next;
  }
  return { top: top || w[0].slice(0, LIMITS.neonTop), bottom: w[w.length - 1].slice(0, LIMITS.neonBottom) };
}

// Blimp: up to 7 letters. "hello-world" → HWORLD, "pi-hole" → PIHOLE, "slugify" → SLUGIFY, "react-native-web" → RNWEB.
export function deriveBlimp(name) {
  const w = splitWords(name);
  if (!w.length) return 'LGTM';
  const whole = w.join('');
  if (whole.length <= LIMITS.blimp) return whole;
  const abbr = w.slice(0, -1).map((x) => x[0]).join('') + w[w.length - 1];
  if (abbr.length <= LIMITS.blimp) return abbr;
  return w.map((x) => x[0]).join('').slice(0, LIMITS.blimp);
}

// "America/Los_Angeles" → "Los Angeles"
export function cityFromTimezone(tz) {
  const last = str(tz).split('/').pop() || '';
  return last.replace(/_/g, ' ') || 'local';
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Fill "{name}" with a number or text and "{name:word}" with "N word(s)" (an all-caps word gets a capital S).
export function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)(?::([^{}]+))?\}/g, (whole, key, word) => {
    if (!Object.hasOwn(vars, key)) return whole;
    const v = vars[key];
    const shown = typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
    if (word === undefined) return shown;
    const caps = word === word.toUpperCase() && /[A-Z]/.test(word);
    return `${shown} ${word}${v === 1 ? '' : caps ? 'S' : 's'}`;
  });
}

function strings(v, max, maxLen, fallback) {
  if (!Array.isArray(v)) return fallback;
  const out = v.map(str).filter(Boolean).map((s) => s.slice(0, maxLen)).slice(0, max);
  return out.length ? out : fallback;
}
function logins(v, warn, field) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = str(x).replace(/^@/, '');
    if (LOGIN_RE.test(s)) out.push(s);
    else warn(`${field}: "${x}" is not a GitHub username, skipped`);
  }
  return out;
}

// Merge a config file (raw) and environment overrides over the defaults.
// env: REPO and ADMINS override the file. If REPO names a different repo than the file does, the
// file describes someone else's lounge (its admins, sign and bot), so it is set aside entirely.
// opts.requireRepo: throw when there is no usable repo (the server); the browser passes false.
export function resolveConfig(raw = {}, env = {}, opts = {}) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  let src = isObj(raw) ? raw : {};
  if (!isObj(raw) && raw != null) warn('the config file is not a JSON object, ignored');
  const envRepo = str(env.REPO);
  if (envRepo && str(src.repo) && !sameRepo(envRepo, src.repo)) {
    warn(`REPO=${envRepo} is a different repo than the config file (${str(src.repo)}), so the file is ignored and defaults are used. Edit the config file instead.`);
    src = {};
  }
  for (const k of Object.keys(src)) if (!KNOWN.has(k) && !isNote(k)) warn(`unknown setting "${k}" ignored`);
  for (const k of NESTED) {
    if (src[k] === undefined) continue;
    if (!isObj(src[k])) { warn(`"${k}" should be an object ({ … }), ignored`); continue; }
    for (const n of Object.keys(src[k])) if (!Object.hasOwn(DEFAULTS[k], n) && !isNote(n)) warn(`unknown setting "${k}.${n}" ignored`);
  }

  const repo = envRepo || str(src.repo);
  if (repo && !REPO_RE.test(repo)) {
    if (opts.requireRepo) throw new Error(`repo "${repo}" should look like owner/name`);
    warn(`repo "${repo}" should look like owner/name`);
  }
  if (!repo && opts.requireRepo) throw new Error('no repo set: put "repo": "owner/name" in lounge.config.json (or set REPO)');
  const goodRepo = REPO_RE.test(repo) ? repo : '';
  const repoName = goodRepo ? goodRepo.split('/')[1] : '';

  const c = {};
  c.repo = goodRepo;
  c.loungeName = str(src.loungeName).slice(0, 40) || DEFAULTS.loungeName;

  const p = isObj(src.project) ? src.project : {};
  const url = str(p.url);
  c.project = {
    name: str(p.name).slice(0, 60) || repoName || 'this project',
    url: /^https:\/\/[^\s"<>]+$/i.test(url) ? url.slice(0, 300) : (goodRepo ? `https://github.com/${goodRepo}` : ''),
    tagline: str(p.tagline).slice(0, 120),
  };
  if (url && c.project.url !== url) warn(`project.url should start with https:// (got "${url.slice(0, 80)}"), using ${c.project.url || 'no link'}`);
  // a link to some other GitHub repo usually means the file was copied from another lounge's config
  const linked = githubRepoOf(c.project.url);
  if (goodRepo && linked && !sameRepo(linked, goodRepo)) {
    warn(`project.url points at ${linked}, but repo is ${goodRepo}. Was this config copied from another lounge? Its name, sign and bot lines may still be theirs.`);
  }

  c.admins = (str(env.ADMINS) ? logins(String(env.ADMINS).split(','), warn, 'ADMINS') : logins(src.admins, warn, 'admins')).map((s) => s.toLowerCase());

  const tz = str(src.timezone) || DEFAULTS.timezone;
  if (validTimezone(tz)) c.timezone = tz;
  else { warn(`timezone "${tz}" is not an IANA time zone name, using ${DEFAULTS.timezone}`); c.timezone = DEFAULTS.timezone; }

  const neonSrc = isObj(src.neon) ? src.neon : {};
  const derived = deriveNeon(repoName || c.loungeName);
  const hasNeon = str(neonSrc.top) || str(neonSrc.bottom);
  c.neon = {
    top: (hasNeon ? str(neonSrc.top) : derived.top).toUpperCase().slice(0, LIMITS.neonTop),
    bottom: (hasNeon ? str(neonSrc.bottom) : derived.bottom).toUpperCase().slice(0, LIMITS.neonBottom),
  };
  c.blimp = (str(src.blimp) || deriveBlimp(repoName || c.loungeName)).toUpperCase().slice(0, LIMITS.blimp);

  const sk = isObj(src.skyline) ? src.skyline : {};
  const boards = Array.isArray(sk.billboards)
    ? sk.billboards.filter((b) => Array.isArray(b) && b.length === 2 && (str(b[0]) || str(b[1])))
      .map((b) => [str(b[0]).toUpperCase().slice(0, LIMITS.billboardLine), str(b[1]).toUpperCase().slice(0, LIMITS.billboardLine)])
      .slice(0, 60)
    : [];
  c.skyline = {
    city: str(sk.city).slice(0, 30) || cityFromTimezone(c.timezone),
    names: strings(sk.names, 60, LIMITS.skylineName, DEFAULTS.skyline.names).map((s) => s.toUpperCase()),
    billboards: boards.length ? boards : DEFAULTS.skyline.billboards.map((b) => [...b]),
  };

  c.ticker = strings(src.ticker, 20, LIMITS.tickerLine, DEFAULTS.ticker);

  const b = isObj(src.bot) ? src.bot : {};
  const botName = str(b.name);
  if (botName && !BOT_RE.test(botName)) warn(`bot.name "${botName}" should be 1-20 letters, digits, - or _; using "${DEFAULTS.bot.name}"`);
  c.bot = { name: BOT_RE.test(botName) ? botName : DEFAULTS.bot.name };
  for (const k of ['greet', 'welcomeBack', 'mention', 'idle', 'gong', 'deploy']) c.bot[k] = strings(b[k], 50, LIMITS.botLine, DEFAULTS.bot[k]);

  const prefix = str(src.codePrefix).toLowerCase();
  if (prefix && !PREFIX_RE.test(prefix)) warn(`codePrefix "${prefix}" should be lowercase letters, digits and dashes (max 24)`);
  c.codePrefix = PREFIX_RE.test(prefix) ? prefix : (slug(`${c.blimp}-lounge`) || 'lounge');

  const th = isObj(src.theme) ? src.theme : {};
  const accent = str(th.accent);
  if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) warn('theme.accent should be a colour like #f26b3a');
  c.theme = { accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : DEFAULTS.theme.accent };

  c.allow = logins(src.allow, warn, 'allow');
  const min = Number(src.minMergedPRs ?? DEFAULTS.minMergedPRs);
  c.minMergedPRs = Number.isInteger(min) && min >= 1 && min <= 100000 ? min : DEFAULTS.minMergedPRs;
  if (src.minMergedPRs !== undefined && c.minMergedPRs !== min) warn('minMergedPRs should be a whole number of 1 or more');

  return { config: c, warnings };
}

// What the browser gets from GET /api/config: no admins, no allow list, no bot script.
export function publicConfig(c) {
  return {
    repo: c.repo,
    loungeName: c.loungeName,
    project: { ...c.project },
    timezone: c.timezone,
    neon: { ...c.neon },
    blimp: c.blimp,
    skyline: { city: c.skyline.city, names: [...c.skyline.names], billboards: c.skyline.billboards.map((x) => [...x]) },
    ticker: [...c.ticker],
    bot: { name: c.bot.name },
    codePrefix: c.codePrefix,
    theme: { ...c.theme },
    minMergedPRs: c.minMergedPRs,
  };
}

export const defaultConfig = () => resolveConfig({}).config;
