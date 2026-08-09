// Environment-driven configuration. Every value can be overridden with an env
// var of the same name; booleans accept "false"/"0" to disable.

const num = (v, d) => (v === undefined ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : !/^(false|0|no|off)$/i.test(v));

const config = {
  // HTTP server: dashboard + REST + WebSocket + webshell transport, one port.
  PORT: num(process.env.PORT, 8080),
  HOST: process.env.HOST || "0.0.0.0",

  // Reverse-shell listeners.
  TCP_PORT: num(process.env.TCP_PORT, 1337),
  TLS_PORT: num(process.env.TLS_PORT, 1338),

  ENABLE_TCP: bool(process.env.ENABLE_TCP, true),
  ENABLE_TLS: bool(process.env.ENABLE_TLS, true),
  ENABLE_WEBSHELL: bool(process.env.ENABLE_WEBSHELL, true),
  ENABLE_MUX: bool(process.env.ENABLE_MUX, true),

  // Mux transport keepalive: server pings each host connection this often (ms).
  MUX_PING_MS: num(process.env.MUX_PING_MS, 20000),

  // Dashboard login. Required — the server refuses to start without both set.
  AUTH_USER: process.env.AUTH_USER || "",
  AUTH_PASS: process.env.AUTH_PASS || "",
  // Pin session cookies across restarts. Optional.
  AUTH_SECRET: process.env.AUTH_SECRET || "",

  // Per-session scrollback kept in memory for late/second viewers.
  SCROLLBACK_BYTES: num(process.env.SCROLLBACK_BYTES, 1024 * 1024),

  // Webshell: how long a poll is held open, and idle time before a beacon is
  // considered dead.
  WEBSHELL_POLL_MS: num(process.env.WEBSHELL_POLL_MS, 25000),
  WEBSHELL_TIMEOUT: num(process.env.WEBSHELL_TIMEOUT, 30000),

  // Token gating the public /dl endpoint (download the Go client without a
  // dashboard login — for badUSB scripts). When unset, /dl is disabled.
  BUILD_TOKEN: process.env.BUILD_TOKEN || "",

  // Single shared API token for programmatic access to /api/* REST endpoints.
  // Accepts `Authorization: Bearer <token>` or `X-API-Token: <token>`.
  // When unset, REST API access requires a session cookie + CSRF token.
  API_TOKEN: process.env.API_TOKEN || "",

  // HTTP CONNECT proxy. When PROXY_TOKEN is set, the proxy is enabled.
  // If PROXY_PORT is set (>0), the proxy listens on that dedicated TCP port.
  // If PROXY_PORT is 0/unset, the proxy handler is attached to the same HTTP
  // server as the dashboard/API. The Basic auth username must be a valid host
  // id; the password must match PROXY_TOKEN.
  PROXY_PORT: num(process.env.PROXY_PORT, 0),
  PROXY_TOKEN: process.env.PROXY_TOKEN || "",
};

export default config;
