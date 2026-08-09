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

// Stateless signed session token: base64url(payload).hmac
export function issueToken(user) {
  const payload = base64url(JSON.stringify({ u: user, exp: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
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

// True when auth is off, or the request carries a valid session cookie. Used by
// both the HTTP middleware and the WebSocket handlers (browsers send cookies on
// same-origin WS handshakes automatically).
export function authorized(req) {
  if (!authEnabled()) return true;
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return verifyToken(cookies[COOKIE]);
}

export function sessionCookie(token, secure) {
  const attrs = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Middleware guarding the dashboard, REST API and static files. NOTE:
// express-ws upgrades bypass app.use(), so WS handlers call authorized() too.
export function requireAuth() {
  if (!authEnabled()) {
    console.warn(
      "[auth] WARNING: no AUTH_USER/AUTH_PASS set — dashboard is UNAUTHENTICATED. " +
        "Set both env vars, and never expose this to an untrusted network."
    );
    return (req, res, next) => next();
  }

  console.log("[auth] dashboard protected by session login");

  return (req, res, next) => {
    if (authorized(req)) return next();
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
