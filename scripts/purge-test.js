// Remove every trace of "test-*" visitors (their sessions, profiles and chat lines) and reset today's
// counters. Run it with the server stopped: a running server could write its copy back over these files.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.STATE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'state');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const wr = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
const isTest = (s) => /^test-/.test(String(s || '').toLowerCase());
const sessions = rd('sessions.json', {});
for (const [k, s] of Object.entries(sessions)) if (s.test || isTest(s.login)) delete sessions[k];
wr('sessions.json', sessions);
const profiles = rd('profiles.json', {});
for (const k of Object.keys(profiles)) if (isTest(k) || profiles[k].test) delete profiles[k];
wr('profiles.json', profiles);
const chat = rd('chat.json', { seq: 0, items: [] });
const before = chat.items.length;
chat.items = chat.items.filter((e) => !isTest(e.login) && !/@test-/.test(e.text || ''));
wr('chat.json', chat);
const daily = rd('daily.json', null);
if (daily) {
  daily.visitors = (daily.visitors || []).filter((v) => !isTest(v));
  daily.messages = 0; daily.gongs = 0; daily.deploys = 0;
  wr('daily.json', daily);
}
console.log(`purged: ${before - chat.items.length} test messages; sessions/profiles cleaned`);
