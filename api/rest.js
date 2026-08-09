import express from "express";
import { registry } from "../core/registry.js";
import { hosts } from "../core/hosts.js";
import { buildRouter } from "./build.js";

// REST API for the dashboard. Shares the one Express app / port with everything
// else. Mounted at /api.
export function restRouter() {
  const router = express.Router();

  router.get("/sessions", (req, res) => {
    res.json(registry.list().map((s) => s.meta()));
  });

  router.get("/sessions/:id", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    res.json(s.meta());
  });

  // Kill the connection but keep the session (and scrollback) in the offline
  // list.
  router.post("/sessions/:id/kill", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
    s.close();
    res.json(s.meta());
  });

  // Drop a session from the registry entirely.
  router.delete("/sessions/:id", (req, res) => {
    if (!registry.get(req.params.id)) {
      return res.status(404).json({ error: "no such session" });
    }
    registry.remove(req.params.id);
    res.json({ ok: true });
  });

  // Inject the dumb-shell -> PTY bash upgrade sequence.
  router.post("/sessions/:id/upgrade", (req, res) => {
    const s = registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: "no such session" });
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
    const channelId = h.openChannel({ command, cols, rows });
    if (channelId == null) {
      return res.status(503).json({ error: "could not open channel" });
    }
    res.json({ ok: true, channelId, host: h.meta() });
  });

  // --- Build (cross-compile Go client from the dashboard) -------------------
  router.use("/build", buildRouter());

  return router;
}
