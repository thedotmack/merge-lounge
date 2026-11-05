# Merge Lounge

A pixel-art hangout for everyone with a merged PR in [claude-mem](https://github.com/thedotmack/claude-mem).
Walk around an isometric dev lounge, chat, sit on the beanbags, grab a kombucha, ring the merge gong,
and watch the AI-valley skyline rebrand itself out the window (it runs on San Francisco time).

- One Node process: static files + a small JSON API + one WebSocket room. Only dependency: `ws`.
- No database. State is a few JSON files in `STATE_DIR`.
- All art is drawn in code (no image assets). Fonts: Silkscreen, Pixelify Sans, IBM Plex Mono (OFL, in `public/fonts`).

## How people get in

1. Type a GitHub username. The server checks it against `data/contributors.json`, or live against GitHub search
   for anyone who merged after the snapshot.
2. They get a one-time code like `cmem-lounge-7KQ2PX` and put it in a **public gist**
   (`echo CODE | gh gist create --public -d CODE -f merge-lounge.txt -`, or by hand on gist.github.com).
3. The server spots the code in their public gist feed and hands that browser a session.
   The code is tied to the browser that asked for it, so nobody else can use someone's gist.
   No OAuth app and no GitHub permissions needed. People can delete the gist afterwards.

## Run it

```bash
npm install
PORT=8080 STATE_DIR=./state ADMINS=thedotmack node server.js
```

| env | default | what |
| --- | --- | --- |
| `PORT` | `8080` | HTTP + WebSocket port |
| `STATE_DIR` | `./state` | profiles, sessions, chat history, daily counters |
| `ADMINS` | `thedotmack` | comma-separated GitHub logins with admin commands |
| `REPO` | `thedotmack/claude-mem` | the repo whose merged PRs count |
| `GITHUB_TOKEN` | — | optional; only raises GitHub API rate limits |
| `REFRESH_ON_START` | — | `1` = rebuild the contributor snapshot a few seconds after starting |

## Chat commands

Everyone: `/wave` `/dance` `/sit` `/stand` `/me …` `/w @user …` (whisper) `/who` `/stats` `/gong` `/afk` `/help`

Admins: `/announce …` · `/mute user [minutes]` · `/unmute user` · `/kick user` (2-minute cool-off) ·
`/ban user` · `/unban user` · `/purge user` (delete their chat history) · `/clear` (wipe chat history)

## Scripts

- `node scripts/fetch-contributors.js` — rebuild the contributor snapshot from GitHub (takes a few minutes without a token).
  The server also does this by itself once a day around 4am San Francisco time, and at startup if `REFRESH_ON_START=1`.
- `node scripts/mint-session.js test-ada test-bob` — testing only: sessions for throwaway `test-*` users
  (run it while the room is idle or the server is stopped, or a pending save can overwrite it).
- `node scripts/purge-test.js` — remove every trace of `test-*` users (stop the server first).

## Where it runs now

On the Sprite `cmem-lounge` (Fly.io Sprites):

- app: `/home/sprite/lounge`, state: `/home/sprite/lounge-state`
- service `lounge` runs `start.sh` (sets the env above) and restarts with the Sprite
- URL: https://cmem-lounge-xreb.sprites.app — private until someone with access runs
  `sprite config update -s cmem-lounge --url-auth public`

Debug view for local testing: add `?debug=1` (exposes `window.__lounge`) and `?tod=21` (force the skyline's hour).
