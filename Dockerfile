# --- Build stage: frontend bundle -------------------------------------------
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY build.js ./
COPY src ./src
COPY public ./public
RUN node build.js

# --- Build stage: Go client (mux implant) ------------------------------------
FROM golang:1.23-alpine AS go

# Build in the same path the runtime will use so the Go build cache is valid
# after copying it to the runtime image.
WORKDIR /app/client
COPY client/go.mod client/go.sum ./
RUN go mod download
COPY client ./ 
COPY proto ./../proto

# Pre-build common targets to warm the module + build caches. This makes the
# first /api/build or /dl request for these targets fast; other targets still
# benefit from the shared module cache.
RUN CGO_ENABLED=0 go build -o /rsl-client ./cmd && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /tmp/rsl-client-linux-arm64 ./cmd && \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o /tmp/rsl-client-windows-amd64.exe ./cmd && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o /tmp/rsl-client-darwin-amd64 ./cmd && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o /tmp/rsl-client-darwin-arm64 ./cmd

# --- Runtime stage -----------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

# openssl is needed for the self-signed TLS cert the TLS transport generates
# on first start. Already present in alpine, but make it explicit.
RUN apk add --no-cache openssl

# Go toolchain: copied from the golang builder so the dashboard can cross-compile
# the mux client on demand (see /api/build). Keep GOROOT/GOPATH stable.
ENV GOROOT=/usr/local/go \
    GOPATH=/root/go \
    GOCACHE=/root/.cache/go-build \
    PATH=/usr/local/go/bin:/root/go/bin:$PATH
COPY --from=go /usr/local/go /usr/local/go

# Pre-warmed Go caches so /api/build and /dl don't re-download deps and can
# reuse compiled packages from the build above. Cross-compiles for other OS/arch
# targets still compile from scratch, but the module cache is shared.
COPY --from=go /go/pkg/mod /root/go/pkg/mod
COPY --from=go /root/.cache/go-build /root/.cache/go-build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=web /app/public/dist ./public/dist
COPY api ./api
COPY core ./core
COPY proto ./proto
COPY tls ./tls
COPY transports ./transports
COPY public/index.html ./public/index.html
COPY server.js config.js ./

# Client source tree so /api/build can run `go build` against it at runtime.
COPY client ./client

# The Go client binary, for operators who want to grab it from the image.
COPY --from=go /rsl-client /usr/local/bin/rsl-client

# Container ports:
#   8080 — dashboard + REST + WebSocket + /mux + /webshell
#   1337 — raw TCP reverse-shell listener
#   1338 — TLS reverse-shell listener
#   3128 — HTTP CONNECT proxy (only when PROXY_PORT=3128)
EXPOSE 8080 1337 1338 3128

# Required at runtime; pass via `docker run -e AUTH_USER=... -e AUTH_PASS=...`.
CMD ["node", "server.js"]