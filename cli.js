#!/usr/bin/env node
import blessed from "blessed";
import { WebSocket } from "ws";
import { URL } from "node:url";

// tmux-like remote operator TUI.
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
      console.log("usage: node cli.js [--url URL] [--token TOKEN]");
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

// Force a 256-color terminal name so remote apps use full colors.
process.env.TERM = process.env.TERM || "xterm-256color";

const parsed = new URL(baseUrl);
const wsScheme = parsed.protocol === "https:" ? "wss" : "ws";
const wsOrigin = `${wsScheme}://${parsed.host}`;
const apiHeaders = { "X-API-Token": apiToken };
const wsHeaders = apiHeaders;

const screen = blessed.screen({
  smartCSR: true,
  title: "rsl-cli",
  fullUnicode: true,
});

const topBar = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: "black", bg: "cyan" },
  content: ` rsl-cli — ${parsed.host}`,
  tags: true,
});

const mainBox = blessed.box({
  parent: screen,
  top: 1,
  left: 0,
  width: "100%",
  height: "100%-2",
  label: " shell ",
  border: { type: "line" },
  style: { border: { fg: "cyan" } },
});

const bottomBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: "white", bg: "blue" },
  content: "",
  tags: true,
});

const chooser = blessed.list({
  parent: screen,
  top: "center",
  left: "center",
  width: "50%",
  height: "50%",
  label: " select host/session ",
  border: { type: "line" },
  hidden: true,
  keys: true,
  vi: true,
  style: {
    fg: "white",
    bg: "black",
    border: { fg: "magenta" },
    selected: { fg: "black", bg: "magenta" },
  },
  tags: true,
});

function setStatus(text) {
  topBar.setContent(` rsl-cli — ${parsed.host} — ${text}`);
  screen.render();
}

const sessions = new Map();
const hosts = new Map();
const windows = []; // { id, title, term, ws, hostId?, sessionId? }
let activeWindowIndex = -1;
let prefixMode = false;
let prefixTimer = null;
let choosing = false;
const pendingShells = new Map();

function isPrefix(data) {
  if (Buffer.isBuffer(data)) {
    return data.length === 1 && data[0] === 0x02;
  }
  return data === "\x02";
}

function updateBottomBar() {
  const parts = [];
  for (let i = 0; i < windows.length; i++) {
    const marker = i === activeWindowIndex ? "*" : " ";
    parts.push(`[${i}]${marker}${windows[i].title}`);
  }
  let text = parts.join("  ");
  if (prefixMode) {
    text += "  {inverse} PREFIX {/inverse}";
  } else {
    text += "  ^B=prefix";
  }
  bottomBar.setContent(text);
  screen.render();
}

function sendResize(term, ws) {
  const cols = Math.max(1, term.width - term.iwidth);
  const rows = Math.max(1, term.height - term.iheight);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

function wrapTerminalInput(term) {
  const original = term._onData;
  screen.program.input.removeListener("data", original);
  const handler = (data) => {
    if (choosing) return;
    if (screen.focused !== term) return;
    if (prefixMode) {
      handlePrefixCommand(data);
      return;
    }
    if (isPrefix(data)) {
      enterPrefixMode();
      return;
    }
    original.call(term, data);
  };
  screen.program.input.on("data", handler);
  term._onData = handler;
}

function enterPrefixMode() {
  prefixMode = true;
  updateBottomBar();
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = setTimeout(() => {
    prefixMode = false;
    updateBottomBar();
  }, 3000);
}

function exitPrefixMode() {
  prefixMode = false;
  if (prefixTimer) clearTimeout(prefixTimer);
  updateBottomBar();
}

function closeWindow(idx) {
  const win = windows[idx];
  if (!win) return;
  try {
    win.ws.close();
  } catch {
    /* ignore */
  }
  win.term.destroy();
  windows.splice(idx, 1);
  if (activeWindowIndex === idx) {
    activeWindowIndex = windows.length ? Math.min(idx, windows.length - 1) : -1;
  } else if (activeWindowIndex > idx) {
    activeWindowIndex--;
  }
  showActiveWindow();
}

function showActiveWindow() {
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    if (i === activeWindowIndex) {
      win.term.show();
      win.term.setFront();
      win.term.focus();
      mainBox.setLabel(` shell — ${win.title} `);
      sendResize(win.term, win.ws);
    } else {
      win.term.hide();
    }
  }
  if (activeWindowIndex < 0) {
    mainBox.setLabel(" shell ");
    mainBox.setContent("{center}no windows — ^B c to open a shell{/center}");
  }
  updateBottomBar();
  screen.render();
}

function createWindow({ sessionId, title }) {
  const winIndex = windows.length;
  const term = blessed.terminal({
    parent: mainBox,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    terminal: "xterm-256color",
    cursor: "block",
    cursorBlink: true,
    screenKeys: false,
    style: { fg: "white", bg: "black" },
    hidden: winIndex !== activeWindowIndex,
  });
  wrapTerminalInput(term);

  const ws = new WebSocket(`${wsOrigin}/api/ws/session/${sessionId}`, { headers: wsHeaders });
  const win = { id: sessionId, title, term, ws };
  windows.push(win);

  term.handler = (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  term.on("resize", () => {
    if (windows[activeWindowIndex] === win) sendResize(term, ws);
  });

  ws.on("open", () => {
    setStatus(`connected to ${title}`);
    sendResize(term, ws);
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary && typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "exit") term.write("\r\n[session exited]\r\n");
      } catch {
        // ignore non-JSON text
      }
      return;
    }
    term.write(data);
  });

  ws.on("close", () => {
    term.write("\r\n[disconnected]\r\n");
  });

  ws.on("error", (err) => {
    setStatus(`ws error: ${err.message}`);
  });

  activeWindowIndex = winIndex;
  showActiveWindow();
  return win;
}

function switchWindow(idx) {
  if (idx < 0 || idx >= windows.length) return;
  activeWindowIndex = idx;
  showActiveWindow();
}

function openHostShell(hostId) {
  return new Promise((resolve, reject) => {
    fetch(`${baseUrl.replace(/\/$/, "")}/api/hosts/${hostId}/shells`, {
      method: "POST",
      headers: { ...apiHeaders, "Content-Type": "application/json" },
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

function populateChooser() {
  const items = [];
  for (const h of hosts.values()) {
    const who = h.hostname ? `${h.username || "?"}@${h.hostname}` : h.remote;
    const alive = h.alive ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
    items.push({
      text: `${alive} [H] ${who} ${h.os || ""}/${h.arch || ""}`,
      kind: "host",
      id: h.id,
    });
  }
  for (const s of sessions.values()) {
    const alive = s.alive ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
    items.push({
      text: `${alive} [S] ${s.remote || s.id}`,
      kind: "session",
      id: s.id,
    });
  }
  chooser.setItems(items.map((it, idx) => ({ text: it.text, data: it, index: idx })));
}

function openChooser() {
  populateChooser();
  choosing = true;
  chooser.show();
  chooser.focus();
  screen.render();
}

function closeChooser() {
  choosing = false;
  chooser.hide();
  if (activeWindowIndex >= 0) {
    windows[activeWindowIndex].term.focus();
  }
  screen.render();
}

chooser.on("select", (item) => {
  const data = item ? item.data : null;
  closeChooser();
  if (!data) return;
  if (data.kind === "host") {
    const host = hosts.get(data.id);
    const title = host ? (host.hostname || host.remote || data.id) : data.id;
    setStatus(`opening shell on ${title}...`);
    openHostShell(data.id).then((sessionId) => {
      createWindow({ sessionId, title });
    }).catch((err) => {
      setStatus(`open shell failed: ${err.message}`);
    });
  } else {
    const s = sessions.get(data.id);
    const title = s ? (s.remote || data.id) : data.id;
    createWindow({ sessionId: data.id, title });
  }
});

screen.key(["escape"], () => {
  if (choosing) closeChooser();
});

function handlePrefixCommand(data) {
  exitPrefixMode();
  if (isPrefix(data)) {
    // Prefix pressed twice: send it through to the shell.
    const term = activeWindowIndex >= 0 ? windows[activeWindowIndex].term : null;
    if (term) term._onData(data);
    return;
  }
  const ch = Buffer.isBuffer(data) ? String.fromCharCode(data[0]) : data;
  switch (ch) {
    case "c":
    case "s":
      openChooser();
      break;
    case "n":
      switchWindow(activeWindowIndex + 1);
      break;
    case "p":
      switchWindow(activeWindowIndex - 1);
      break;
    case "0":
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
      switchWindow(Number(ch));
      break;
    case "&":
      if (activeWindowIndex >= 0) closeWindow(activeWindowIndex);
      break;
    case "d":
    case "q":
      process.exit(0);
      break;
    default:
      // unknown prefix command: ignore
      break;
  }
}

function applySnapshot(snapshot) {
  sessions.clear();
  hosts.clear();
  for (const s of snapshot.sessions || []) sessions.set(s.id, s);
  for (const h of snapshot.hosts || []) hosts.set(h.id, h);
  if (choosing) populateChooser();
}

function handleEvent(msg) {
  switch (msg.type) {
    case "snapshot":
      applySnapshot(msg);
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
      if (msg.host) hosts.set(msg.host.id, msg.host);
      break;
    case "host_update":
      if (msg.host) hosts.set(msg.host.id, msg.host);
      break;
    case "host_remove":
      if (msg.host) hosts.delete(msg.host.id);
      break;
  }
  if (choosing) populateChooser();

  // Resolve pending shell-open promises.
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
    handleEvent(JSON.parse(data.toString()));
  } catch (err) {
    setStatus(`bad message: ${err.message}`);
  }
});

listWs.on("close", () => setStatus("disconnected"));
listWs.on("error", (err) => setStatus(`list error: ${err.message}`));

updateBottomBar();
screen.render();
