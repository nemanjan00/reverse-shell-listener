import express from "express";
import { registry } from "../core/registry.js";
import { hosts } from "../core/hosts.js";
import { log } from "../core/log.js";
import config from "../config.js";
import { getTokenPayload } from "./auth.js";
import { buildRouter } from "./build.js";

// REST API for the dashboard. Shares the one Express app / port with everything
// else. Mounted at /api.
export function restRouter() {
  const router = express.Router();

  router.get("/csrf", (req, res) => {
    const payload = getTokenPayload(req);
    res.json({ csrf: payload && payload.c ? payload.c : "" });
  });

  router.get("/sessions", (req, res) => {
    res.json(registry.list().map((s) => s.meta()));
  });

  router.get("/sessions/:id", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    res.json(s.meta());
  });

  // Download the session's in-memory scrollback as raw bytes.
  router.get("/sessions/:id/scrollback", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    const buf = s.scrollback();
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="scrollback-${s.id}.bin"`);
    res.send(buf);
  });

  // Kill the connection but keep the session (and scrollback) in the offline
  // list.
  router.post("/sessions/:id/kill", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    log.info("session killed", { sessionId: s.id, transport: s.transport, remote: s.remote });
    s.close();
    res.json(s.meta());
  });

  // Drop a session from the registry entirely.
  router.delete("/sessions/:id", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    log.info("session deleted", { sessionId: s.id, transport: s.transport, remote: s.remote });
    registry.remove(req.params.id);
    res.json({ ok: true });
  });

  // Drop every dead (offline) session in one shot.
  router.post("/sessions/clear-dead", (req, res) => {
    let removed = 0;
    for (const s of registry.list()) {
      if (!s.alive) {
        registry.remove(s.id);
        removed++;
      }
    }
    if (removed) {
      log.info("dead sessions cleared", { removed });
    }
    res.json({ ok: true, removed });
  });

  // Inject the dumb-shell -> PTY bash upgrade sequence.
  router.post("/sessions/:id/upgrade", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    log.info("session upgraded", { sessionId: s.id, transport: s.transport, remote: s.remote });
    s.upgrade();
    res.json(s.meta());
  });

  // Resize a session (used by the dashboard and by direct API callers).
  router.post("/sessions/:id/resize", express.json(), (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    const cols = Number(req.body.cols) || 80;
    const rows = Number(req.body.rows) || 24;
    s.resize(cols, rows);
    res.json(s.meta());
  });

  // --- Host management (mux transport) -------------------------------------

  router.get("/hosts", (req, res) => {
    res.json(hosts.list().map((h) => h.meta()));
  });

  router.get("/hosts/:id", (req, res) => {
    const h = hosts.get(req.params.id);
    if (!h) return res.status(404).json({ error: "no such host" });
    res.json(h.meta());
  });

  // Ask a mux host to open a new PTY-backed shell channel.
  router.post("/hosts/:id/shells", express.json(), (req, res) => {
    const h = hosts.get(req.params.id);
    if (!h || !h.alive) return res.status(404).json({ error: "no such host" });
    const cols = Number(req.body.cols) || 80;
    const rows = Number(req.body.rows) || 24;
    const command = typeof req.body.command === "string" ? req.body.command : "";
    log.info("host shell requested", { hostId: h.id, label: h.label(), command: command || "default shell", cols, rows });
    const channelId = h.openChannel({ command, cols, rows });
    if (channelId == null) {
      return res.status(503).json({ error: "could not open channel" });
    }
    res.json({ ok: true, channelId, host: h.meta() });
  });

  // --- Build (cross-compile Go client from the dashboard) -------------------
  router.use("/build", buildRouter());

  // --- Runtime config exposed to the authenticated dashboard -----------------
  router.get("/config", (req, res) => {
    const proto = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    // Use the same host:port the dashboard is accessed on, since the proxy now
    // shares the API server. Reverse proxies can override via X-Forwarded-Host.
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const proxyEnabled = Boolean(config.PROXY_TOKEN);
    res.json({
      proxy_url: proxyEnabled && host ? `${proto}://${host}` : "",
      proxy_enabled: proxyEnabled,
      proxy_token: config.PROXY_TOKEN || "",
      build_token: config.BUILD_TOKEN || "",
    });
  });

  // --- Log (in-memory event log) --------------------------------------------
  router.get("/log", (req, res) => {
    const since = Number(req.query.since) || 0;
    res.json(log.list(since));
  });

  return router;
}
