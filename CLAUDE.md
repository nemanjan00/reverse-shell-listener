# CLAUDE.md

Project: reverse-shell-listener. A single-host, multi-transport reverse-shell
catcher with a browser dashboard. Node 22 ESM + Express 5 + express-ws on the
server, qrp + xterm.js in the browser, a Go client for the mux transport.

## Layout

```
api/           HTTP/WS endpoints (auth, REST, browser WS, build/download)
core/          session registry, host registry, session model, event log
transports/    inbound shell transports: tcp, tls, webshell, mux, HTTP CONNECT proxy
tls/           self-signed cert generation for the TLS transport
proto/         mux.proto — the protobuf schema for the mux transport
client/        Go mux client (cmd/main.go, client.go, pty/, muxpb/)
src/           dashboard frontend (qrp + xterm.js, Dracula theme)
public/        static dashboard shell (index.html); bundle output in public/dist/
build.js       esbuild bundler config (src/ -> public/dist/)
server.js      process entrypoint: wires the Express app, listeners, auth
config.js      env-driven config
Dockerfile     3-stage build: web bundle -> Go client -> node:22-alpine runtime
```

## Commands

```bash
npm install              # install deps
npm run build           # esbuild: bundle src/ -> public/dist/app.{js,css}
npm run watch           # rebuild on change
npm start               # build + run server.js (requires AUTH_USER / AUTH_PASS)
npm run dev             # build + node --watch server.js
node build.js           # one-shot dev build (unminified)
NODE_ENV=production node build.js  # minified build

# Go client
cd client && go build -o rsl-client ./cmd
./rsl-client -s ws://HOST:8080/mux -t tag

# Regenerate Go protobuf bindings after editing proto/mux.proto
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
protoc --go_out=client --go_opt=module=github.com/nemanjan00/reverse-shell-listener/client proto/mux.proto

# Docker
docker build -t reverse-shell-listener .
docker run -p 8080:8080 -p 1337:1337 -p 1338:1338 \
  -e AUTH_USER=admin -e AUTH_PASS=s3cr3t reverse-shell-listener

# With HTTP CONNECT proxy on a dedicated port (recommended behind reverse proxies)
docker run -p 8080:8080 -p 1337:1337 -p 1338:1338 -p 3128:3128 \
  -e AUTH_USER=admin -e AUTH_PASS=s3cr3t \
  -e PROXY_TOKEN=... -e PROXY_PORT=3128 reverse-shell-listener
```

No lint, typecheck, or test scripts are defined in package.json. After
changing frontend code, rebuild with `npm run build` (or `npm run watch`)
before running the server.

## Auth model (important)

Auth is **mandatory**. `api/auth.js:requireAuth()` calls `process.exit(1)` if
`AUTH_USER` / `AUTH_PASS` are unset. Never re-introduce the "no-auth fallback"
path — the server must refuse to start without operator credentials.

Authentication is via a signed `rsl_session` cookie (HMAC-SHA256, 12h TTL,
`HttpOnly`, `SameSite=Strict`) issued at `POST /login`. The cookie gates:

- the dashboard + static assets (via `requireAuth` middleware),
- all `/api/*` REST routes (mounted after `requireAuth`),
- the browser WS endpoints `/api/ws/sessions`, `/api/ws/session/:id`, and
  `/api/ws/log` — express-ws upgrades **bypass** `app.use()` middleware, so each
  handler re-checks the cookie via `authorized(req)` and closes the socket with
  `1008` on failure.

Mutating REST endpoints also require a double-submit CSRF token: login sets a
non-`HttpOnly` `rsl_csrf` cookie, and the frontend must send its value in the
`X-CSRF-Token` header on `POST`/`DELETE`/etc.

Implant-facing endpoints cannot use operator session cookies, so they are gated
by the shared `BUILD_TOKEN` when it is set: `/mux`, `/dl`, `/dl/s`, and
`/webshell/*`. `/webshell/register` accepts the token via `?token=` or
`X-RSL-Token`; poll and output require it on every request. The raw TCP and TLS
reverse-shell listeners are unauthenticated by definition.

`/api/config` returns runtime values (proxy URL, `BUILD_TOKEN`, `PROXY_TOKEN`)
to the authenticated dashboard so it can build copyable scripts without the
operator typing secrets.

Security headers (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, CSP) are set on every response; HSTS is added only when the
request is detected as HTTPS (e.g., behind an HTTPS reverse proxy).

## Conventions

- ESM throughout the Node side (`"type": "module"` in package.json).
- Frontend is a single esbuild bundle; do not add a framework. qrp provides
  `state`, `el`, `list`, `when`, `mount` from `@nemanjan00/qrp`.
- The terminal controller (`termCtl` in src/app.js) is kept outside qrp's
  reactive DOM — xterm must not be re-created on every state change.
- Transports register themselves on the shared Express app / HTTP server (one
  port for everything except the raw TCP/TLS shell listeners, which have their
  own ports). The HTTP CONNECT proxy can share the API port when `PROXY_PORT=0`,
  or listen on a dedicated port when `PROXY_PORT` is set (>0). A dedicated port
  is required for reverse proxies that cannot forward raw `CONNECT` tunnels on
  an HTTP route (e.g. Traefik).
- Mux hosts advertise a `features` bitmap in `Hello` (file transfer, proxy,
  file manager). The dashboard gates related UI so older clients do not show
  unsupported controls.
- The TLS transport auto-generates a self-signed cert via `openssl` on first
  start. `certs/` is gitignored.
- `public/dist/` is gitignored — it is a build artifact, regenerated by
  `npm run build` or the Dockerfile.
- Do not add comments to code unless asked.

## Mux protocol notes

- Hosts send a `Hello` frame with hostname, user, OS, arch, tags, `BUILD_TOKEN`,
  and a `features` bitmap (`FEATURE_FILE_TRANSFER=1`, `FEATURE_PROXY=2`,
  `FEATURE_FILE_MANAGER=4`). Newer clients set all bits; the dashboard hides
  file transfer, proxy, and file-manager UI for hosts that do not advertise them.
- File transfer and file-system browser frames are relayed between the
  dashboard and the Go client as JSON over browser WebSockets and protobuf over
  the host's mux WebSocket.

## HTTP CONNECT proxy

- Enabled when `PROXY_TOKEN` is set. Basic auth username must be a valid host
  id; password must match `PROXY_TOKEN`.
- `PROXY_PORT=0` attaches the proxy handler to the dashboard/API HTTP server.
- `PROXY_PORT>0` listens on that dedicated TCP port (recommended for Traefik
  and similar reverse proxies).
- The dashboard loads `/api/config` to display the proxy URL and a copyable curl
  example per host.

## Dashboard features

- BadUSB / DuckyScript generator (`src/app.js:badUsbScript`) with OS/arch
  selector, Flipper Zero vs USB Rubber Ducky device syntax, optional VID/PID,
  and pre-payload delay. macOS defaults to Apple keyboard IDs to skip the
  Keyboard Setup Assistant.
- File transfer and native file-system browser per mux host (gated by the
  host's `Hello.features` bitmap).
- Command palette (`Ctrl+K`), browser notifications, help overlay (`?`),
  resizable panels, session scrollback download, and copyable payload examples.

## Docker image

Published to Docker Hub at `docker pull nemanjan00/reverse-shell-listener:latest`
(and `:<git-short-sha>` for pinned versions). Build context is kept lean via
`.dockerignore` (excludes node_modules, public/dist, certs, Go binaries).
After merging changes that affect the image, rebuild and push both tags:

```bash
SHA=$(git rev-parse --short HEAD)
docker build -t nemanjan00/reverse-shell-listener:latest \
             -t nemanjan00/reverse-shell-listener:$SHA .
docker push nemanjan00/reverse-shell-listener:latest
docker push nemanjan00/reverse-shell-listener:$SHA
```