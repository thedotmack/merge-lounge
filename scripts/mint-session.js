// Testing only: mint sessions for throwaway "test-*" visitors without a gist.
// Usage: node scripts/mint-session.js test-ada test-bob
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = process.env.STATE_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'state');
const file = path.join(dir, 'sessions.json');
let data = {};
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const out = {};
for (const login of process.argv.slice(2)) {
  if (!/^test-[a-z0-9-]+$/.test(login)) { console.error('test logins only (test-*)'); process.exit(1); }
  const token = crypto.randomBytes(24).toString('base64url');
  data[crypto.createHash('sha256').update(token).digest('hex')] = { login, created: Date.now(), lastUsed: Date.now(), test: true };
  out[login] = token;
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file + '.tmp', JSON.stringify(data));
fs.renameSync(file + '.tmp', file);
console.log(JSON.stringify(out));
