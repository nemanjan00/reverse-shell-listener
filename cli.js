#!/usr/bin/env node
// rsl-cli — tmux-based remote operator console.
//
// Usage:
//   RSL_URL=https://rsl.example.com RSL_TOKEN=... node cli.js
//
// The first invocation starts a tmux session named "rsl-cli" and attaches you
// to it. Inside tmux you see a Blessed dashboard listing hosts/sessions.
//
// Keys in the dashboard:
//   Enter      open a shell window for the selected host/session
//   f          open a file-manager window for the selected host
//   r          refresh
//   q          quit dashboard (other tmux windows stay open)
//
// Use normal tmux keys to switch/close shell windows.

import blessed from "blessed";
import { WebSocket } from "ws";
import { URL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import notifier from "node-notifier";

let baseUrl = process.env.RSL_URL || "";
let apiToken = process.env.RSL_TOKEN || process.env.RSL_API_TOKEN || "";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--url":
    case "-u":
      baseUrl = args[++i] || "";
      break;
    case "--token":
    case "-t":
      apiToken = args[++i] || "";
      break;
    case "--help":
    case "-h":
      console.log("usage: node cli.js [--url URL] [--token TOKEN]");
      process.exit(0);
  }
}

if (!baseUrl) {
  console.error("Error: --url or RSL_URL required");
  process.exit(1);
}
if (!apiToken) {
  console.error("Error: --token or RSL_TOKEN required");
  process.exit(1);
}

const notifyEnabled = process.env.RSL_NOTIFY !== "0";
function notify(title, message) {
  if (!notifyEnabled) return;
  try {
    notifier.notify({ title, message, timeout: 5 });
  } catch {
    /* ignore missing notification service */
  }
}

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

const parsed = new URL(baseUrl);
const wsScheme = parsed.protocol === "https:" ? "wss" : "ws";
const wsOrigin = `${wsScheme}://${parsed.host}`;
const apiHeaders = { "X-API-Token": apiToken };
const wsHeaders = apiHeaders;

const tmuxSocket = process.env.RSL_TMUX_SOCKET || path.join(os.homedir(), ".rsl-cli", "tmux.sock");
const here = new URL(import.meta.url).pathname;
const relayPath = path.resolve(here, "..", "cli", "relay.js");
const fileManagerPath = path.resolve(here, "..", "cli", "file-manager.js");

function tmux(args, stdio = "pipe") {
  return spawnSync("tmux", ["-S", tmuxSocket, ...args], { encoding: "utf-8", stdio });
}

function tmuxSpawn(args) {
  return spawn("tmux", ["-S", tmuxSocket, ...args], { detached: true, stdio: "ignore" });
}

// If we are not already inside tmux, bootstrap a tmux session with the
// dashboard and attach the user to it. The dashboard then runs inside tmux.
if (!process.env.TMUX) {
  try {
    fs.mkdirSync(path.dirname(tmuxSocket), { recursive: true });
  } catch {
    // ignore
  }

  const has = tmux(["has-session", "-t", "rsl-cli"]);
  if (has.status !== 0) {
    tmux([
      "new-session",
      "-d",
      "-s",
      "rsl-cli",
      "-n",
      "dashboard",
      "sh",
      "-c",
      `RSL_TMUX_SOCKET=${tmuxSocket} exec node ${JSON.stringify(here)}`,
    ]);
  }
  tmux(["set-option", "-t", "rsl-cli", "mouse", "on"]);

  const attach = spawn("tmux", ["-S", tmuxSocket, "attach", "-t", "rsl-cli"], {
    stdio: "inherit",
  });
  attach.on("exit", (code) => process.exit(code ?? 0));
  // Keep the bootstrap alive until attach finishes.
  await new Promise(() => {});
}

// --- Dashboard inside tmux --------------------------------------------------

const screen = blessed.screen({
  smartCSR: true,
  title: "rsl-cli",
  fullUnicode: true,
  mouse: true,
});

const topBar = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: DRACULA.bg, bg: DRACULA.purple },
  content: ` rsl-cli — ${parsed.host}`,
  tags: true,
});

const list = blessed.list({
  parent: screen,
  top: 1,
  left: 0,
  width: "100%",
  height: "100%-2",
  label: " hosts / sessions ",
  border: { type: "line" },
  keys: true,
  vi: true,
  style: {
    fg: DRACULA.fg,
    bg: DRACULA.bg,
    border: { fg: DRACULA.comment },
    selected: { fg: DRACULA.bg, bg: DRACULA.pink },
  },
  tags: true,
});

const bottomBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: DRACULA.fg, bg: DRACULA.selection },
  content: " Enter=shell  f=files  r=refresh  q=quit ",
  tags: true,
});

function renderTopBar(msg = "") {
  const alive = [...hosts.values()].filter((h) => h.alive).length;
  const total = hosts.size;
  let text = ` rsl-cli — ${parsed.host} — ${alive}/${total} hosts`;
  if (msg) text += ` — ${msg}`;
  topBar.setContent(text);
  screen.render();
}

const sessions = new Map();
const hosts = new Map();
let listData = [];
let pendingShells = new Map();

function itemLabel(item) {
  const alive = item.alive ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
  if (item.kind === "host") {
    const who = item.hostname ? `${item.username || "?"}@${item.hostname}` : item.remote;
    return `${alive} [H] ${who} ${item.os || ""}/${item.arch || ""}`;
  }
  return `${alive} [S] ${item.remote || item.id}`;
}

function renderList() {
  const items = [];
  for (const h of hosts.values()) {
    items.push({ kind: "host", id: h.id, meta: h });
  }
  for (const s of sessions.values()) {
    items.push({ kind: "session", id: s.id, meta: s });
  }
  listData = items;
  list.setItems(items.map((it) => itemLabel(it.meta)));
  screen.render();
}

function openShellWindow(sessionId, title) {
  tmuxSpawn([
    "new-window",
    "-t",
    "rsl-cli",
    "-n",
    title.slice(0, 30),
    "sh",
    "-c",
    `RSL_URL=${JSON.stringify(baseUrl)} RSL_TOKEN=${JSON.stringify(apiToken)} exec node ${JSON.stringify(relayPath)} ${sessionId}`,
  ]);
}

function openFileManagerWindow(hostId, title) {
  tmuxSpawn([
    "new-window",
    "-t",
    "rsl-cli",
    "-n",
    `files:${title.slice(0, 24)}`,
    "sh",
    "-c",
    `RSL_URL=${JSON.stringify(baseUrl)} RSL_TOKEN=${JSON.stringify(apiToken)} exec node ${JSON.stringify(fileManagerPath)} ${hostId}`,
  ]);
}

async function openHostShell(hostId) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/hosts/${hostId}/shells`, {
    method: "POST",
    headers: { ...apiHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  return new Promise((resolve, reject) => {
    pendingShells.set(hostId, { channelId: json.channelId, resolve, reject });
    setTimeout(() => {
      if (pendingShells.has(hostId)) {
        pendingShells.delete(hostId);
        reject(new Error("timeout waiting for session"));
      }
    }, 5000);
  });
}

list.on("select", async () => {
  const data = listData[list.selected];
  if (!data) return;
  if (data.kind === "host") {
    const meta = data.meta;
    const title = meta.hostname || meta.remote || meta.id;
    try {
      const sessionId = await openHostShell(meta.id);
      openShellWindow(sessionId, title);
    } catch (err) {
      renderTopBar(`open shell failed: ${err.message}`);
    }
  } else {
    const meta = data.meta;
    openShellWindow(meta.id, meta.remote || meta.id);
  }
});

list.key(["f"], () => {
  const data = listData[list.selected];
  if (!data || data.kind !== "host") return;
  const meta = data.meta;
  openFileManagerWindow(meta.id, meta.hostname || meta.remote || meta.id);
});

list.key(["r"], renderList);
list.key(["q"], () => process.exit(0));
screen.key(["q"], () => process.exit(0));

function handleEvent(msg) {
  switch (msg.type) {
    case "snapshot":
      sessions.clear();
      hosts.clear();
      for (const s of msg.sessions || []) sessions.set(s.id, s);
      for (const h of msg.hosts || []) {
        hosts.set(h.id, h);
        notify("rsl-cli host connected", `${h.hostname || h.remote || h.id} (${h.os || "?"}/${h.arch || "?"})`);
      }
      break;
    case "add":
      if (msg.session) sessions.set(msg.session.id, msg.session);
      break;
    case "update":
      if (msg.session) sessions.set(msg.session.id, msg.session);
      break;
    case "remove":
      if (msg.session) sessions.delete(msg.session.id);
      break;
    case "host_add":
      if (msg.host) {
        hosts.set(msg.host.id, msg.host);
        notify("rsl-cli host connected", `${msg.host.hostname || msg.host.remote || msg.host.id} (${msg.host.os || "?"}/${msg.host.arch || "?"})`);
      }
      break;
    case "host_update":
      if (msg.host) hosts.set(msg.host.id, msg.host);
      break;
    case "host_remove": {
      const h = msg.host ? hosts.get(msg.host.id) : null;
      const who = h?.hostname || h?.remote || msg.host?.id || "unknown";
      if (msg.host) hosts.delete(msg.host.id);
      notify("rsl-cli host disconnected", who);
      break;
    }
  }

  for (const [hostId, pending] of pendingShells.entries()) {
    const match = [...sessions.values()].find(
      (s) => s.alive && s.transport === "mux" && s.remote.endsWith(` ch#${pending.channelId}`)
    );
    if (match) {
      pending.resolve(match.id);
      pendingShells.delete(hostId);
    }
  }

  renderList();
  renderTopBar();
}

const listWs = new WebSocket(`${wsOrigin}/api/ws/sessions`, { headers: wsHeaders });

listWs.on("open", () => renderTopBar("connected"));
listWs.on("message", (data) => {
  try {
    handleEvent(JSON.parse(data.toString()));
  } catch (err) {
    renderTopBar(`bad message: ${err.message}`);
  }
});
listWs.on("close", (code, reason) => renderTopBar(`disconnected ${code} ${reason}`));
listWs.on("error", (err) => renderTopBar(`list error: ${err.message}`));

list.focus();
renderList();
renderTopBar();
