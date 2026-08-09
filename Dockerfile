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
WORKDIR /client
COPY client/go.mod client/go.sum ./
RUN go mod download
COPY client ./ 
COPY proto ./../proto
RUN CGO_ENABLED=0 go build -o /rsl-client ./cmd

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
    PATH=/usr/local/go/bin:/root/go/bin:$PATH
COPY --from=go /usr/local/go /usr/local/go

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
EXPOSE 8080 1337 1338

# Required at runtime; pass via `docker run -e AUTH_USER=... -e AUTH_PASS=...`.
CMD ["node", "server.js"]