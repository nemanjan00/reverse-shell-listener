#!/usr/bin/env node
import blessed from "blessed";
import { WebSocket } from "ws";
import { URL } from "node:url";

// Remote operator TUI. Connects to the listener's WebSocket endpoints with an
// API token and gives a tmux-like session list + shell interface.
//
// Usage:
//   RSL_URL=https://rsl.example.com RSL_API_TOKEN=... node cli.js
//   node cli.js --url https://rsl.example.com --token ...

let baseUrl = process.env.RSL_URL || "";
let apiToken = process.env.RSL_API_TOKEN || "";

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
      console.log(`usage: node cli.js [--url URL] [--token TOKEN]`);
      process.exit(0);
  }
}

if (!baseUrl) {
  console.error("Error: --url or RSL_URL required");
  process.exit(1);
}
if (!apiToken) {
  console.error("Error: --token or RSL_API_TOKEN required");
  process.exit(1);
}

const parsed = new URL(baseUrl);
const wsScheme = parsed.protocol === "https:" ? "wss" : "ws";
const wsOrigin = `${wsScheme}://${parsed.host}`;

const wsHeaders = { "X-API-Token": apiToken };

const screen = blessed.screen({
  smartCSR: true,
  title: "rsl-cli",
  fullUnicode: true,
});

const statusBar = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: "black", bg: "cyan" },
  content: ` rsl-cli — ${parsed.host}`,
  tags: true,
});

const sidebar = blessed.list({
  parent: screen,
  top: 1,
  left: 0,
  width: 32,
  height: "100%-2",
  label: " hosts / sessions ",
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "black",
    border: { fg: "cyan" },
    selected: { fg: "black", bg: "cyan" },
  },
  keys: true,
  vi: true,
  tags: true,
});

const mainBox = blessed.box({
  parent: screen,
  top: 1,
  left: 32,
  width: "100%-32",
  height: "100%-2",
  label: " shell ",
  border: { type: "line" },
  style: { border: { fg: "cyan" } },
  content: " select a host/session and press Enter ",
  align: "center",
  valign: "middle",
});

const hintBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: "white", bg: "blue" },
  content: " Enter=open  F12=focus list/shell  Ctrl+Q=quit ",
  tags: true,
});

function setStatus(text) {
  statusBar.setContent(` rsl-cli — ${parsed.host} — ${text}`);
  screen.render();
}

const sessions = new Map(); // id -> meta
const hosts = new Map(); // id -> meta
let activeTerm = null;
let activeWs = null;
let pendingShells = new Map(); // hostId -> { channelId, resolve }

function itemLabel(item) {
  const alive = item.alive ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
  if (item.kind === "host") {
    const who = item.hostname ? `${item.username || "?"}@${item.hostname}` : item.remote;
    return `${alive} [H] ${who} ${item.os || ""}/${item.arch || ""}`;
  }
  const remote = item.remote || "unknown";
  return `${alive} [S] ${remote}`;
}

function rebuildList() {
  const selected = sidebar.selected;
  const items = [];
  for (const h of hosts.values()) {
    items.push({ id: h.id, meta: h });
  }
  for (const s of sessions.values()) {
    items.push({ id: s.id, meta: s });
  }
  sidebar.setItems(items.map((i) => ({ text: itemLabel(i.meta), data: i })));
  if (selected != null && selected < items.length) {
    sidebar.select(selected);
  }
  screen.render();
}

function sendResize(term, ws) {
  const cols = Math.max(1, term.width - term.iwidth);
  const rows = Math.max(1, term.height - term.iheight);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

function openShellForHost(hostId) {
  return new Promise((resolve, reject) => {
    fetch(`${baseUrl.replace(/\/$/, "")}/api/hosts/${hostId}/shells`, {
      method: "POST",
      headers: { "X-API-Token": apiToken, "Content-Type": "application/json" },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text();
          return reject(new Error(`HTTP ${res.status}: ${body}`));
        }
        const json = await res.json();
        pendingShells.set(hostId, { channelId: json.channelId, resolve });
      })
      .catch(reject);
  });
}

function attachSession(sessionId) {
  if (activeWs) {
    try {
      activeWs.close();
    } catch {
      /* ignore */
    }
  }
  if (activeTerm) {
    activeTerm.destroy();
    activeTerm = null;
  }

  const meta = sessions.get(sessionId);
  const label = meta ? (meta.remote || sessionId) : sessionId;
  mainBox.setLabel(` shell — ${label} `);

  const term = blessed.terminal({
    parent: mainBox,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    handler: (data) => {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(data);
      }
    },
    cursor: "block",
    cursorBlink: true,
    screenKeys: false,
    style: { fg: "white", bg: "black" },
  });

  term.on("resize", () => {
    if (activeTerm === term) sendResize(term, activeWs);
  });

  const ws = new WebSocket(`${wsOrigin}/api/ws/session/${sessionId}`, { headers: wsHeaders });
  activeWs = ws;
  activeTerm = term;

  ws.on("open", () => {
    setStatus("shell connected");
    sendResize(term, ws);
    term.focus();
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary && typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "exit") {
          setStatus("shell exited");
        }
      } catch {
        // ignore non-JSON text
      }
      return;
    }
    term.write(data);
  });

  ws.on("close", () => {
    setStatus("shell disconnected");
    if (activeTerm === term) {
      term.write("\r\n[disconnected]\r\n");
    }
  });

  ws.on("error", (err) => {
    setStatus(`shell error: ${err.message}`);
  });

  term.focus();
  screen.render();
}

async function handleSelect() {
  const item = sidebar.getItem(sidebar.selected);
  if (!item || !item.data) return;
  const { id, meta } = item.data;
  if (meta.kind === "host") {
    setStatus(`opening shell on ${meta.id}...`);
    try {
      const sessionId = await openShellForHost(id);
      attachSession(sessionId);
    } catch (err) {
      setStatus(`open shell failed: ${err.message}`);
    }
  } else {
    attachSession(id);
  }
}

function applySnapshot(snapshot) {
  sessions.clear();
  hosts.clear();
  for (const s of snapshot.sessions || []) sessions.set(s.id, s);
  for (const h of snapshot.hosts || []) hosts.set(h.id, h);
  rebuildList();
}

function handleEvent(msg) {
  switch (msg.type) {
    case "snapshot":
      applySnapshot(msg);
      break;
    case "add":
      if (msg.session) sessions.set(msg.session.id, msg.session);
      rebuildList();
      break;
    case "update":
      if (msg.session) sessions.set(msg.session.id, msg.session);
      rebuildList();
      break;
    case "remove":
      if (msg.session) sessions.delete(msg.session.id);
      rebuildList();
      break;
    case "host_add":
      if (msg.host) hosts.set(msg.host.id, msg.host);
      rebuildList();
      break;
    case "host_update":
      if (msg.host) hosts.set(msg.host.id, msg.host);
      rebuildList();
      break;
    case "host_remove":
      if (msg.host) hosts.delete(msg.host.id);
      rebuildList();
      break;
  }

  // Resolve pending shell-open promises by matching the new session's remote.
  for (const [hostId, pending] of pendingShells.entries()) {
    const match = [...sessions.values()].find(
      (s) => s.alive && s.transport === "mux" && s.remote.endsWith(` ch#${pending.channelId}`)
    );
    if (match) {
      pending.resolve(match.id);
      pendingShells.delete(hostId);
    }
  }
}

const listWs = new WebSocket(`${wsOrigin}/api/ws/sessions`, { headers: wsHeaders });

listWs.on("open", () => setStatus("connected"));

listWs.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString());
    handleEvent(msg);
  } catch (err) {
    setStatus(`bad message: ${err.message}`);
  }
});

listWs.on("close", () => setStatus("disconnected"));
listWs.on("error", (err) => setStatus(`list error: ${err.message}`));

sidebar.on("select", handleSelect);

screen.key(["enter"], () => {
  if (screen.focused === sidebar) handleSelect();
});

screen.key(["f12"], () => {
  if (screen.focused === sidebar && activeTerm) {
    activeTerm.focus();
  } else {
    sidebar.focus();
  }
});

screen.key(["C-q"], () => process.exit(0));

sidebar.focus();
screen.render();
