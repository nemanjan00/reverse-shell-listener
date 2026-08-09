import { registry } from "../core/registry.js";
import { hosts } from "../core/hosts.js";
import { authorized } from "./auth.js";

// WebSocket endpoints, registered on the shared express-ws app:
//   /api/ws/sessions       session-list event stream (JSON)
//   /api/ws/session/:id    one session's terminal channel (binary bytes +
//                          JSON control frames)
//
// express-ws upgrade requests bypass app.use() middleware, so each handler
// authenticates itself.
export function registerWs(app) {
  // --- session list stream -------------------------------------------------
  app.ws("/api/ws/sessions", (ws, req) => {
    if (!authorized(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    const send = (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    send({
      type: "snapshot",
      sessions: registry.list().map((s) => s.meta()),
      hosts: hosts.list().map((h) => h.meta()),
    });

    const onHostAdd = (h) => send({ type: "host_add", host: h.meta() });
    const onHostUpdate = (h) => send({ type: "host_update", host: h.meta() });
    const onHostRemove = (h) => send({ type: "host_remove", host: h.meta() });

    const onAdd = (s) => send({ type: "add", session: s.meta() });
    const onUpdate = (s) => send({ type: "update", session: s.meta() });
    const onRemove = (s) => send({ type: "remove", session: s.meta() });

    registry.on("add", onAdd);
    registry.on("update", onUpdate);
    registry.on("remove", onRemove);
    hosts.on("add", onHostAdd);
    hosts.on("update", onHostUpdate);
    hosts.on("remove", onHostRemove);

    ws.on("close", () => {
      registry.off("add", onAdd);
      registry.off("update", onUpdate);
      registry.off("remove", onRemove);
      hosts.off("add", onHostAdd);
      hosts.off("update", onHostUpdate);
      hosts.off("remove", onHostRemove);
    });
  });

  // --- terminal channel ----------------------------------------------------
  app.ws("/api/ws/session/:id", (ws, req) => {
    if (!authorized(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    const session = registry.get(req.params.id);
    if (!session) {
      ws.close();
      return;
    }

    const sendBinary = (buf) => {
      try {
        ws.send(buf, { binary: true });
      } catch {
        /* ignore */
      }
    };
    const sendControl = (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    // Replay history so a late/second viewer sees the full session.
    const history = session.scrollback();
    if (history.length) sendBinary(history);
    sendControl({ type: "meta", session: session.meta() });
    if (!session.alive) sendControl({ type: "exit" });

    const onData = (buf) => sendBinary(buf);
    const onExit = () => sendControl({ type: "exit" });
    const onMeta = () => sendControl({ type: "meta", session: session.meta() });

    session.on("data", onData);
    session.on("exit", onExit);
    session.on("meta", onMeta);

    ws.on("message", (data, isBinary) => {
      // Text frames (ws@7 delivers them as strings) are JSON control; binary
      // frames are raw stdin. Keeping them separate keeps the byte stream clean.
      if (typeof data === "string") return handleControl(data);
      if (isBinary === false) return handleControl(data.toString());
      session.write(data); // Buffer of stdin bytes
    });

    function handleControl(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.type === "resize") session.resize(msg.cols, msg.rows);
      else if (msg.type === "upgrade") session.upgrade();
      else if (msg.type === "stdin" && typeof msg.data === "string") {
        session.write(Buffer.from(msg.data, "utf8"));
      }
    }

    ws.on("close", () => {
      session.off("data", onData);
      session.off("exit", onExit);
      session.off("meta", onMeta);
    });
  });
}
