FROM node:22-alpine

WORKDIR /app

# openssl is needed for the self-signed TLS cert the TLS transport generates
# on first start. go is needed so the dashboard can cross-compile the mux
# client on demand (see /api/build and /dl).
RUN apk add --no-cache go openssl

ENV GOPATH=/root/go \
    GOCACHE=/root/.cache/go-build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Bundle the frontend into public/dist/.
RUN node build.js

# Pre-download Go modules so runtime builds don't re-fetch dependencies.
RUN cd client && go mod download

# Warm the Go build cache for the most common client targets. The output
# binaries are deleted immediately; only the module and build caches remain,
# so /dl and /api/build can link a fresh binary quickly at runtime.
RUN cd client && \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tmp/rsl-client-linux-amd64 ./cmd && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o /tmp/rsl-client-linux-arm64 ./cmd && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /tmp/rsl-client-windows-amd64.exe ./cmd && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o /tmp/rsl-client-darwin-amd64 ./cmd && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o /tmp/rsl-client-darwin-arm64 ./cmd && \
    rm -f /tmp/rsl-client-*

# Remove frontend build-time dependencies; the runtime only needs express etc.
RUN npm prune --omit=dev

# Container ports:
#   8080 — dashboard + REST + WebSocket + /mux + /webshell
#   1337 — raw TCP reverse-shell listener
#   1338 — TLS reverse-shell listener
#   3128 — HTTP CONNECT proxy (only when PROXY_PORT=3128)
EXPOSE 8080 1337 1338 3128

# Required at runtime; pass via `docker run -e AUTH_USER=... -e AUTH_PASS=...`.
CMD ["node", "server.js"]
