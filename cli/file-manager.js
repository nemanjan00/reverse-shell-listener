#!/usr/bin/env node
// Standalone remote file manager for one host. Intended to run inside a tmux
// window spawned by cli.js.
//
// Env:
//   RSL_URL      listener URL
//   RSL_TOKEN    API token
//
// Arg:
//   <hostId>

import blessed from "blessed";
import { WebSocket } from "ws";
import { URL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const hostId = process.argv[2];
const baseUrl = process.env.RSL_URL || "";
const token = process.env.RSL_TOKEN || process.env.RSL_API_TOKEN || "";

if (!baseUrl || !token || !hostId) {
  console.error("usage: RSL_URL=... RSL_TOKEN=... node cli/file-manager.js <hostId>");
  process.exit(1);
}

const parsed = new URL(baseUrl);
const wsScheme = parsed.protocol === "https:" ? "wss" : "ws";
const wsOrigin = `${wsScheme}://${parsed.host}`;
const wsHeaders = { "X-API-Token": token };

const DRACULA = {
  bg: "#282a36",
  fg: "#f8f8f2",
  comment: "#6272a4",
  cyan: "#8be9fd",
  green: "#50fa7b",
  orange: "#ffb86c",
  pink: "#ff79c6",
  purple: "#bd93f9",
  red: "#ff5555",
  yellow: "#f1fa8c",
  selection: "#44475a",
};

const screen = blessed.screen({ smartCSR: true, title: `rsl-files:${hostId}`, mouse: true });

const list = blessed.list({
  parent: screen,
  top: 1,
  left: 0,
  width: "100%",
  height: "100%-1",
  label: ` files — ${hostId} `,
  border: { type: "line" },
  keys: true,
  vi: true,
  style: {
    fg: DRACULA.fg,
    bg: DRACULA.bg,
    border: { fg: DRACULA.purple },
    selected: { fg: DRACULA.bg, bg: DRACULA.pink },
  },
  tags: true,
});

const statusBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: DRACULA.fg, bg: DRACULA.selection },
  content: " connecting... ",
});

function setStatus(text) {
  statusBar.setContent(` ${text} `);
  screen.render();
}

// Fetch host meta so we know the remote OS and can pick the right path module.
let hostOs = "";
try {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/hosts/${hostId}`, {
    headers: { "X-API-Token": token },
  });
  if (res.ok) {
    const meta = await res.json();
    hostOs = meta.os || "";
    list.setLabel(` files — ${meta.hostname || meta.remote || hostId} `);
  }
} catch (err) {
  setStatus(`host lookup failed: ${err.message}`);
}

const pathModule = hostOs === "windows" ? path.win32 : path.posix;
const sep = pathModule.sep;

const fsWs = new WebSocket(`${wsOrigin}/api/ws/host/${hostId}/fs`, { headers: wsHeaders });
const fileWs = new WebSocket(`${wsOrigin}/api/ws/host/${hostId}/file`, { headers: wsHeaders });

let currentPath = ".";
let entries = [];
let fmData = [];
let fsPending = new Map();
let fsSeq = 1;
let fileSeq = 1;
const fileTransfers = new Map();

function safeDisplayName(name, max = 80) {
  let s = name.replace(/[\p{Cc}\p{Co}\p{Cn}]/gu, "?");
  s = s.replace(/[^\u0000-\uFFFF]/g, "?");
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function render() {
  const items = [];
  if (currentPath !== "." && currentPath !== sep && !currentPath.endsWith(":")) {
    items.push({ text: "📁 ../", kind: "dir", name: ".." });
  }
  for (const e of entries) {
    const icon = e.is_dir ? "📁" : "📄";
    const size = e.is_dir ? "" : ` ${formatBytes(e.size || 0)}`;
    const display = safeDisplayName(e.name);
    items.push({ text: `${icon} ${display}${size}`, kind: e.is_dir ? "dir" : "file", name: e.name });
  }
  fmData = items;
  list.setItems(items.map((it) => it.text));
  list.setLabel(` files — ${hostId}:${currentPath} `);
  screen.render();
}

function refresh() {
  const reqId = fsSeq++;
  fsPending.set(reqId, { path: currentPath });
  if (fsWs.readyState === WebSocket.OPEN) {
    fsWs.send(JSON.stringify({ type: "fs_list", request_id: reqId, path: currentPath }));
  }
}

function navigate() {
  const data = fmData[list.selected];
  if (!data) return;
  if (data.kind === "dir") {
    if (data.name === "..") {
      const parent = pathModule.dirname(currentPath);
      if (parent !== currentPath) {
        currentPath = parent || ".";
        refresh();
      }
    } else {
      currentPath = pathModule.join(currentPath, data.name);
      refresh();
    }
  }
}

function download() {
  const data = fmData[list.selected];
  if (!data || data.kind !== "file") return;
  const fileName = data.name;
  const remotePath = pathModule.join(currentPath, fileName);
  const transferId = fileSeq++;
  const localPath = path.join(process.cwd(), fileName);
  const fd = fs.openSync(localPath, "w");
  fileTransfers.set(transferId, { fd, path: localPath, received: 0 });
  if (fileWs.readyState === WebSocket.OPEN) {
    fileWs.send(JSON.stringify({ type: "file_request", transfer_id: transferId, path: remotePath }));
    setStatus(`downloading ${fileName}...`);
  }
}

list.on("select", navigate);
list.key(["h", "backspace"], () => {
  const parent = pathModule.dirname(currentPath);
  if (parent !== currentPath) {
    currentPath = parent || ".";
    refresh();
  }
});
list.key(["r"], refresh);
list.key(["d"], download);
list.key(["q"], () => process.exit(0));

screen.key(["escape", "q"], () => process.exit(0));

fsWs.on("open", refresh);
fsWs.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type !== "fs_list_result") return;
    const pending = fsPending.get(msg.request_id);
    if (pending) fsPending.delete(msg.request_id);
    if (msg.error) {
      setStatus(`fs error: ${msg.error}`);
      return;
    }
    currentPath = msg.absolute_path || pending?.path || currentPath;
    entries = msg.entries || [];
    render();
  } catch (err) {
    setStatus(`fs parse error: ${err.message}`);
  }
});
fsWs.on("close", () => setStatus("fs disconnected"));
fsWs.on("error", (err) => setStatus(`fs error: ${err.message}`));

fileWs.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case "file_start": {
        const tx = fileTransfers.get(msg.transfer_id);
        if (tx) tx.size = msg.size || 0;
        break;
      }
      case "file_chunk": {
        const tx = fileTransfers.get(msg.transfer_id);
        if (!tx) return;
        const buf = Buffer.from(msg.data || "", "base64");
        fs.writeSync(tx.fd, buf);
        tx.received += buf.length;
        break;
      }
      case "file_done": {
        const tx = fileTransfers.get(msg.transfer_id);
        if (!tx) return;
        fileTransfers.delete(msg.transfer_id);
        fs.closeSync(tx.fd);
        if (msg.error) {
          setStatus(`download failed: ${msg.error}`);
          try { fs.unlinkSync(tx.path); } catch {}
        } else {
          setStatus(`downloaded ${path.basename(tx.path)} (${formatBytes(tx.received)})`);
        }
        break;
      }
    }
  } catch (err) {
    setStatus(`file parse error: ${err.message}`);
  }
});

list.focus();
screen.render();
