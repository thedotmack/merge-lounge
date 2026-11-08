// Print the lounge.config.json reference table (Markdown) from the defaults in shared/config.js.
// The README embeds this output between config-table markers; `npm test` checks they still match.
// Usage: node scripts/config-table.js
import { pathToFileURL } from 'node:url';
import { DEFAULTS, LIMITS, resolveConfig } from '../shared/config.js';

const code = (v) => '`' + String(v).replace(/\|/g, '\\|') + '`';
const n = (a, what) => `${a.length} ${what}${a.length === 1 ? '' : 's'}`;

export function configTable() {
  const ex = resolveConfig({ repo: 'you/hello-world' }).config; // what a config with only a repo gets
  const D = DEFAULTS;
  const rows = [
    ['repo', 'required', `The GitHub repo whose merged-PR authors get in, as ${code('owner/name')}. The ${code('REPO')} env var overrides it.`],
    ['loungeName', code(D.loungeName), 'Name on the landing page, the top bar and the ticker.'],
    ['project.name', `the repo name (${code(ex.project.name)})`, 'Used in the copy: "a merged PR in …", profiles, page title.'],
    ['project.url', code(ex.project.url), 'Footer and menu link. Must start with `https://`.'],
    ['project.tagline', 'empty', 'Shown when someone taps the neon sign.'],
    ['admins', code('[]'), `GitHub logins with admin commands (${code('/announce')}, ${code('/mute')}, ${code('/kick')} …). With none, nobody has them and the server says so when it starts. The ${code('ADMINS')} env var (comma-separated) overrides it.`],
    ['timezone', code(D.timezone), 'IANA time zone for the window\'s day and night, the daily counters and the 4am contributor refresh.'],
    ['neon.top / neon.bottom', `from the repo name (${code(ex.neon.top)} / ${code(ex.neon.bottom)})`, `The neon sign. Top line up to ${LIMITS.neonTop} characters; the bottom line is drawn big at 4 characters or fewer.`],
    ['blimp', `from the repo name (${code(ex.blimp)})`, `Up to ${LIMITS.blimp} characters on the blimp.`],
    ['skyline.city', `from the time zone (${code(ex.skyline.city)})`, '"The skyline runs on … time."'],
    ['skyline.names', n(D.skyline.names, 'made-up startup'), `Rooftop signs that keep rebranding, up to ${LIMITS.skylineName} characters each.`],
    ['skyline.billboards', n(D.skyline.billboards, 'two-line billboard'), `Freeway billboards: pairs of lines, up to ${LIMITS.billboardLine} characters each. Five show at a time, and every 45 seconds the next five come up.`],
    ['ticker', n(D.ticker, 'line'), `The LED ticker. Fills in ${['{contributors}', '{mergedPRs}', '{online}', '{gongs}', '{deploys}', '{loungeName}'].map(code).join(' ')}; ${code('{gongs:GONG}')} gives "3 GONGS".`],
    ['bot.name', code(D.bot.name), 'The resident bot. Say its name in chat and it answers.'],
    ['bot.greet', n(D.bot.greet, 'line'), `First visit. Fills in ${code('{login}')} and ${code('{merged:merged PR}')}.`],
    ['bot.welcomeBack', n(D.bot.welcomeBack, 'line'), `Back after 30+ minutes. Fills in ${code('{login}')} and ${code('{ago}')}.`],
    ['bot.mention', n(D.bot.mention, 'line'), 'Replies when someone mentions the bot.'],
    ['bot.idle', n(D.bot.idle, 'line'), 'Tips it drops now and then.'],
    ['bot.gong / bot.deploy', `${n(D.bot.gong, 'line')} / ${n(D.bot.deploy, 'line')}`, 'Reactions to the gong and the big red button.'],
    ['codePrefix', `from the blimp (${code(ex.codePrefix)})`, 'Start of the one-time check-in code people put in a gist.'],
    ['theme.accent', code(D.theme.accent), 'Colour of buttons and highlights.'],
    ['allow', code('[]'), 'Extra GitHub logins let in without a merged PR.'],
    ['minMergedPRs', code(D.minMergedPRs), 'How many merged PRs it takes to get in.'],
  ];
  return ['| Setting | Default | What it does |', '| --- | --- | --- |', ...rows.map(([k, d, w]) => `| ${code(k)} | ${d} | ${w} |`)].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) console.log(configTable());
