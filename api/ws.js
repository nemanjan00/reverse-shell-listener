import { registry } from "../core/registry.js";
import { hosts } from "../core/hosts.js";
import { log } from "../core/log.js";
import { authorized, apiAuthorized } from "./auth.js";


// Convert a JSON file frame from the dashboard into a protobuf Frame object.
// Returns null for unrecognized or incomplete messages.
function jsonToFileFrame(msg) {
  if (!msg || !msg.type || typeof msg.transfer_id !== "number") return null;
  switch (msg.type) {
    case "file_request":
      return {
        fileRequest: { transferId: msg.transfer_id, path: String(msg.path || "") },
      };
    case "file_start":
      return {
        fileStart: {
          transferId: msg.transfer_id,
          path: String(msg.path || ""),
          size: msg.size || 0,
        },
      };
    case "file_chunk":
      return {
        fileChunk: {
          transferId: msg.transfer_id,
          data: Buffer.from(msg.data || "", "base64"),
        },
      };
    case "file_done":
      return {
        fileDone: {
          transferId: msg.transfer_id,
          error: String(msg.error || ""),
        },
      };
    default:
      return null;
  }
}

function jsonToFsFrame(msg) {
  if (!msg || !msg.type || typeof msg.request_id !== "number") return null;
  switch (msg.type) {
    case "fs_list":
      return {
        fsList: { requestId: msg.request_id, path: String(msg.path || ".") },
      };
    case "fs_stat":
      return {
        fsStat: { requestId: msg.request_id, path: String(msg.path || ".") },
      };
    default:
      return null;
  }
}

// WebSocket endpoints, registered on the shared express-ws app:
//   /api/ws/sessions       session-list event stream (JSON)
//   /api/ws/session/:id    one session's terminal channel (binary bytes +
//                          JSON control frames)
//   /api/ws/log            live event log stream (JSON)
//
// express-ws upgrade requests bypass app.use() middleware, so each handler
// authenticates itself.
export function registerWs(app) {
  // --- session list stream -------------------------------------------------
  app.ws("/api/ws/sessions", (ws, req) => {
    if (!authorized(req) && !apiAuthorized(req)) {
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
    if (!authorized(req) && !apiAuthorized(req)) {
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

  // --- file transfer relay -------------------------------------------------
  // Dashboard opens this host-scoped WebSocket and exchanges JSON-encoded
  // file frames. The server translates them to/from protobuf and relays them
  // over the host's mux WebSocket.
  app.ws("/api/ws/host/:id/file", (ws, req) => {
    if (!authorized(req) && !apiAuthorized(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    const host = hosts.get(req.params.id);
    if (!host || !host.alive) {
      ws.close(1008, "no such host");
      return;
    }

    ws.binaryType = "arraybuffer";
    host.addFileSocket(ws);

    ws.on("message", (data, isBinary) => {
      let msg;
      try {
        const text = typeof data === "string" ? data : data.toString();
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const frame = jsonToFileFrame(msg);
      if (!frame) return;
      host.send(frame);
    });

    ws.on("close", () => host._fileSockets.delete(ws));
  });

  // --- file-system browser relay --------------------------------------------
  // Dashboard opens this host-scoped WebSocket to list/stat directories using
  // the Go client's native os package. JSON on the wire, protobuf to the host.
  app.ws("/api/ws/host/:id/fs", (ws, req) => {
    if (!authorized(req) && !apiAuthorized(req)) {
      ws.close(1008, "unauthorized");
      return;
    }
    const host = hosts.get(req.params.id);
    if (!host || !host.alive) {
      ws.close(1008, "no such host");
      return;
    }

    ws.binaryType = "arraybuffer";
    host.addFsSocket(ws);

    ws.on("message", (data, isBinary) => {
      let msg;
      try {
        const text = typeof data === "string" ? data : data.toString();
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const frame = jsonToFsFrame(msg);
      if (!frame) return;
      host.send(frame);
    });

    ws.on("close", () => host._fsSockets.delete(ws));
  });

  // --- event log stream -----------------------------------------------------
  app.ws("/api/ws/log", (ws, req) => {
    if (!authorized(req) && !apiAuthorized(req)) {
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
    // Replay history, then stream live entries. A `since` timestamp lets a
    // reconnecting client skip entries it already received.
    const since = Number(req.query.since) || 0;
    for (const entry of log.list(since)) send(entry);
    const onEntry = (entry) => send(entry);
    log.on("entry", onEntry);
    ws.on("close", () => log.off("entry", onEntry));
  });
}
