# Flashcards

Personal use, vibecoded, you know the drill. It's only on here to build the apk.

The app is a thin client: a small Node.js server owns the SQLite database and
the spaced repetition scheduler, and the app (Android or desktop) talks to it
over Tailscale. The server's address is asked for on first start.

## Server

Needs Node.js 24 or newer and no other dependencies (it uses the built-in
`node:sqlite` and runs the TypeScript directly).

```sh
cd server
node src/main.ts            # http://127.0.0.1:8787
node src/main.ts --help     # --db, --host, --port
```

The database lives in `~/.local/share/flashcards-server/flashcards.db` unless
`--db` / `FLASHCARDS_DB` says otherwise. Days roll over at 4am in the server's
time zone, like Anki's.

### Over Tailscale

The server listens on localhost only and has no login of its own: let
[`tailscale serve`](https://tailscale.com/kb/1312/serve) put it on your tailnet
with HTTPS, so only your devices can reach it:

```sh
tailscale serve --bg 8787
tailscale serve status      # shows https://<machine>.<tailnet>.ts.net
```

That `https://<machine>.<tailnet>.ts.net` address is what you enter in the app.
(HTTPS certificates must be enabled for the tailnet; `tailscale serve` says so
if they aren't.)

### Running it in the background

`server/flashcards-server.service` is a systemd user unit; fix the path in it,
then:

```sh
cp server/flashcards-server.service ~/.config/systemd/user/
systemctl --user enable --now flashcards-server
loginctl enable-linger "$USER"   # keep it running while logged out
```

### Moving from the local-only app

Older versions of the app kept their data on the device. The new version
notices that database on first start and offers to upload it to the server
(write-ahead log included, so nothing recent is lost). The server refuses to
overwrite existing data unless you confirm, and keeps a backup next to its
database when it does.

### API

`POST /api/<command>` with the command's arguments as a JSON object returns the
result as JSON, or `{ "error": "..." }` with a 4xx/5xx status. `GET /api/health`
says whether the server is up and empty. The commands are listed in
`server/src/commands/index.ts`.

### Tests

```sh
cd server && npm ci && npm test && npm run typecheck
```

## App

```sh
npm ci
npm run tauri dev           # desktop
npm run tauri android build # see .github/workflows/android-apk.yml
```

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE). The spaced repetition scheduler
(`server/src/srs.ts`, `server/src/rng.ts`) is ported from
[Anki](https://github.com/ankitects/anki) (Copyright Ankitects Pty Ltd and
contributors, AGPL-3.0-or-later).
