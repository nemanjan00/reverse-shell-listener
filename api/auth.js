import crypto from "node:crypto";
import config from "../config.js";

const COOKIE = "rsl_session";
const TTL_MS = 12 * 60 * 60 * 1000; // 12h sessions

// A per-process secret unless one is pinned via AUTH_SECRET. Pinning keeps
// sessions valid across restarts; otherwise a restart logs everyone out.
const SECRET = config.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

function safeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // Constant-time against the shorter length; still leaks the length, which
    // is unavoidable with fixed credentials, but never early-returns mid-compare.
    const len = Math.min(ba.length, bb.length);
    crypto.timingSafeEqual(ba.subarray(0, len), bb.subarray(0, len));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function authEnabled() {
  return Boolean(config.AUTH_USER && config.AUTH_PASS);
}

// Validate the login form credentials (constant-time).
export function checkCredentials(user, pass) {
  return (
    safeEqual(String(user), config.AUTH_USER) &&
    safeEqual(String(pass), config.AUTH_PASS)
  );
}

function parsePayload(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed.exp !== "number" || Date.now() >= parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Stateless signed session token: base64url(payload).hmac
export function issueToken(user) {
  const csrf = crypto.randomBytes(16).toString("base64url");
  const payload = base64url(JSON.stringify({ u: user, exp: Date.now() + TTL_MS, c: csrf }));
  return { token: `${payload}.${sign(payload)}`, csrf };
}

function sign(data) {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}
function base64url(s) {
  return Buffer.from(s, "utf8").toString("base64url");
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// True when the request carries a valid session cookie. Used by both the HTTP
// middleware and the WebSocket handlers (browsers send cookies on same-origin
// WS handshakes automatically). Auth is enforced at startup, so this is only
// ever called when AUTH_USER/AUTH_PASS are set.
export function authorized(req) {
  const payload = getTokenPayload(req);
  return payload !== null && Boolean(payload.c);
}

export function getTokenPayload(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return parsePayload(cookies[COOKIE]);
}

// True when the request carries the single shared API token. API tokens are
// meant for automation/scripts, not browsers, so they bypass CSRF and the
// session-cookie flow on /api/* REST routes.
export function apiAuthorized(req) {
  if (!config.API_TOKEN) return false;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const header = req.headers["x-api-token"] || bearer;
  return safeEqual(String(header), config.API_TOKEN);
}

export function sessionCookie(token, secure) {
  const attrs = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// CSRF protection: mutating requests must include an X-CSRF-Token header that
// matches the `c` claim stored in the signed session token. The dashboard reads
// this value from a GET /api/csrf endpoint instead of a cookie, so it works
// behind reverse proxies that might block or mishandle non-HttpOnly cookies.
// API-token clients are not cookie-based, so CSRF does not apply to them.
export function csrf(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (apiAuthorized(req)) return next();
  const payload = getTokenPayload(req);
  const header = req.headers["x-csrf-token"];
  if (!payload || !header || header !== payload.c) {
    return res.status(403).json({ error: "invalid csrf token" });
  }
  next();
}

// Middleware guarding the dashboard, REST API and static files. NOTE:
// express-ws upgrades bypass app.use(), so WS handlers call authorized() too.
export function requireAuth() {
  if (!authEnabled()) {
    console.error(
      "[auth] FATAL: AUTH_USER/AUTH_PASS not set. Refusing to start without " +
        "operator credentials. Set both env vars (e.g. in a .env file or your " +
        "process manager) and restart."
    );
    process.exit(1);
  }

  console.log("[auth] dashboard protected by session login");

  return (req, res, next) => {
    if (authorized(req)) return next();
    // API tokens grant access to /api/* REST routes only.
    if (req.path.startsWith("/api") && apiAuthorized(req)) return next();
    // XHR/fetch and JSON clients get a 401; browsers navigating get the login page.
    const wantsJson =
      req.path.startsWith("/api") ||
      (req.headers.accept || "").includes("application/json") ||
      req.headers["x-requested-with"] === "fetch";
    if (wantsJson) return res.status(401).json({ error: "unauthorized" });
    if (req.path === "/login") return next();
    res.redirect("/login");
  };
}
