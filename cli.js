#!/usr/bin/env node
import blessed from "blessed";
import { WebSocket } from "ws";
import { URL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import notifier from "node-notifier";

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

// tmux-like remote operator TUI.
//
// Usage:
//   RSL_URL=https://rsl.example.com RSL_TOKEN=... node cli.js
//   node cli.js --url https://rsl.example.com --token ...
//
// Keys:
//   Ctrl+b c / s   open host/session chooser (new shell window)
//   Ctrl+b f       open host chooser (new file-manager window)
//   Ctrl+b n / p   next / previous window
//   Ctrl+b 0-9     switch to window
//   Ctrl+b &       close current window
//   Ctrl+b d / q   detach / quit
//   Ctrl+b Ctrl+b  send literal Ctrl+b to the shell

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

// Force a 256-color terminal name so remote apps use full colors.
process.env.TERM = process.env.TERM || "xterm-256color";

const notifyEnabled = process.env.RSL_NOTIFY !== "0";
function notify(title, message) {
  if (!notifyEnabled) return;
  try {
    notifier.notify({ title, message, timeout: 5 });
  } catch {
    // notifications are best-effort; ignore missing dbus / notify-send
  }
}

const parsed = new URL(baseUrl);
const wsScheme = parsed.protocol === "https:" ? "wss" : "ws";
const wsOrigin = `${wsScheme}://${parsed.host}`;
const apiHeaders = { "X-API-Token": apiToken };
const wsHeaders = apiHeaders;

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

const mainBox = blessed.box({
  parent: screen,
  top: 1,
  left: 0,
  width: "100%",
  height: "100%-2",
  label: " shell ",
  border: { type: "line" },
  style: { border: { fg: DRACULA.comment } },
});

const bottomBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  style: { fg: DRACULA.fg, bg: DRACULA.selection },
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
    fg: DRACULA.fg,
    bg: DRACULA.bg,
    border: { fg: DRACULA.purple },
    selected: { fg: DRACULA.bg, bg: DRACULA.pink },
  },
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

function setStatus(text) {
  renderTopBar(text);
}

const sessions = new Map();
const hosts = new Map();
const windows = []; // { id, title, type, term?, shellWs?, fm?, fsWs?, fileWs?, hostId?, path?, entries? ... }
let activeWindowIndex = -1;
let prefixMode = false;
let prefixTimer = null;
let choosing = false;
let chooserMode = "shell"; // "shell" | "files"
let chooserData = []; // parallel array for chooser item metadata
const pendingShells = new Map();
let fsRequestSeq = 1;
let fileTransferSeq = 1;

function isPrefix(data) {
  if (Buffer.isBuffer(data)) {
    return data.length === 1 && data[0] === 0x02;
  }
  return data === "\x02";
}

function activeWindowIsShell() {
  const win = windows[activeWindowIndex];
  return win && win.type === "shell";
}

function updateBottomBar() {
  const parts = [];
  for (let i = 0; i < windows.length; i++) {
    const marker = i === activeWindowIndex ? "*" : " ";
    const icon = windows[i].type === "files" ? "📁" : "🐚";
    parts.push(`[${i}]${marker}${icon}${windows[i].title}`);
  }
  let text = parts.join("  ");
  if (prefixMode) {
    text += "  {inverse} PREFIX {/inverse}";
  } else {
    text += "  ^B s=list  c=shell  f=files";
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
      handleShellPrefixCommand(data);
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

function runGlobalCommand(ch) {
  switch (ch) {
    case "c":
    case "s":
      openChooser("shell");
      break;
    case "f":
      openChooser("files");
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
  }
}

function handleShellPrefixCommand(data) {
  exitPrefixMode();
  if (isPrefix(data)) {
    // Prefix pressed twice: send it through to the shell.
    const term = activeWindowIndex >= 0 ? windows[activeWindowIndex].term : null;
    if (term) term._onData(data);
    return;
  }
  const ch = Buffer.isBuffer(data) ? String.fromCharCode(data[0]) : data;
  runGlobalCommand(ch);
}

function closeWindow(idx) {
  const win = windows[idx];
  if (!win) return;
  try {
    if (win.shellWs) win.shellWs.close();
    if (win.fsWs) win.fsWs.close();
    if (win.fileWs) win.fileWs.close();
  } catch {
    /* ignore */
  }
  if (win.term) win.term.destroy();
  if (win.fm) win.fm.destroy();
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
      if (win.type === "shell") {
        win.term.show();
        win.term.setFront();
        win.term.focus();
        mainBox.setLabel(` shell — ${win.title} `);
        sendResize(win.term, win.shellWs);
      } else {
        win.fm.show();
        win.fm.setFront();
        win.fm.focus();
        mainBox.setLabel(` files — ${win.title} `);
      }
    } else {
      if (win.term) win.term.hide();
      if (win.fm) win.fm.hide();
    }
  }
  if (activeWindowIndex < 0) {
    mainBox.setLabel(" rsl-cli ");
    const alive = [...hosts.values()].filter((h) => h.alive).length;
    mainBox.setContent(
      `{center}{bold}rsl-cli{/bold}\n\n` +
        `${alive} host(s) online\n\n` +
        `^B s  list hosts\n` +
        `^B c  new terminal\n` +
        `^B f  file manager\n` +
        `^B d  detach{/center}`
    );
  }
  updateBottomBar();
  screen.render();
}

function createShellWindow({ sessionId, title }) {
  const winIndex = windows.length;
  const ws = new WebSocket(`${wsOrigin}/api/ws/session/${sessionId}`, { headers: wsHeaders });

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
    mouse: true,
    handler: (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8"));
      }
    },
    style: { fg: DRACULA.fg, bg: DRACULA.bg },
    hidden: winIndex !== activeWindowIndex,
  });
  wrapTerminalInput(term);

  const win = { id: sessionId, title, type: "shell", term, shellWs: ws };
  windows.push(win);

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
        if (msg.type === "exit") {
          term.write("\r\n[session exited]\r\n");
          notify("rsl-cli session exited", title);
        }
      } catch {
        // ignore non-JSON text
      }
      return;
    }
    // blessed.term.js expects a string, not a Buffer.
    term.write(Buffer.isBuffer(data) ? data.toString("utf-8") : data);
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

function createFileWindow({ hostId, title }) {
  const winIndex = windows.length;
  const fm = blessed.list({
    parent: mainBox,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    label: ` files — ${title} `,
    border: { type: "line" },
    keys: true,
    vi: true,
    hidden: winIndex !== activeWindowIndex,
    style: {
      fg: DRACULA.fg,
      bg: DRACULA.bg,
      border: { fg: DRACULA.purple },
      selected: { fg: DRACULA.bg, bg: DRACULA.pink },
    },
    tags: true,
  });

  const host = hosts.get(hostId);
  const pathModule = host && host.os === "windows" ? path.win32 : path.posix;
  const sep = pathModule.sep;

  const fsWs = new WebSocket(`${wsOrigin}/api/ws/host/${hostId}/fs`, { headers: wsHeaders });
  const fileWs = new WebSocket(`${wsOrigin}/api/ws/host/${hostId}/file`, { headers: wsHeaders });

  const win = {
    id: hostId,
    title,
    type: "files",
    fm,
    fmData: [],
    fsWs,
    fileWs,
    hostId,
    path: ".",
    pathModule,
    sep,
    entries: [],
    fsPending: new Map(),
    fileTransfers: new Map(),
  };
  windows.push(win);

  fm.on("select", () => navigateFile(win));

  fm.key(["h", "backspace"], () => navigateFileUp(win));
  fm.key(["r"], () => refreshFileList(win));
  fm.key(["d"], () => downloadSelectedFile(win));
  fm.key(["q"], () => {
    const idx = windows.indexOf(win);
    if (idx >= 0) closeWindow(idx);
  });

  fsWs.on("open", () => refreshFileList(win));

  fsWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleFsMessage(win, msg);
    } catch (err) {
      setStatus(`fs parse error: ${err.message}`);
    }
  });

  fileWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleFileMessage(win, msg);
    } catch (err) {
      setStatus(`file parse error: ${err.message}`);
    }
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
  if (chooserMode === "shell") {
    for (const s of sessions.values()) {
      const alive = s.alive ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
      items.push({
        text: `${alive} [S] ${s.remote || s.id}`,
        kind: "session",
        id: s.id,
      });
    }
  }
  chooserData = items;
  chooser.setItems(items.map((it) => it.text));
}

function openChooser(mode) {
  chooserMode = mode;
  chooser.setLabel(mode === "files" ? " select host " : " select host/session ");
  populateChooser();
  choosing = true;
  chooser.show();
  chooser.focus();
  screen.render();
}

function closeChooser() {
  choosing = false;
  chooser.hide();
  showActiveWindow();
}

chooser.on("select", () => {
  const data = chooserData[chooser.selected];
  closeChooser();
  if (!data) return;
  if (chooserMode === "files") {
    if (data.kind !== "host") return;
    const host = hosts.get(data.id);
    const title = host ? (host.hostname || host.remote || data.id) : data.id;
    createFileWindow({ hostId: data.id, title });
    return;
  }
  if (data.kind === "host") {
    const host = hosts.get(data.id);
    const title = host ? (host.hostname || host.remote || data.id) : data.id;
    setStatus(`opening shell on ${title}...`);
    openHostShell(data.id).then((sessionId) => {
      createShellWindow({ sessionId, title });
    }).catch((err) => {
      setStatus(`open shell failed: ${err.message}`);
    });
  } else {
    const s = sessions.get(data.id);
    const title = s ? (s.remote || data.id) : data.id;
    createShellWindow({ sessionId: data.id, title });
  }
});

screen.key(["escape"], () => {
  if (choosing) closeChooser();
});

// Prefix handling for non-shell windows (shell windows handle it in raw input).
screen.key(["C-b"], () => {
  if (!activeWindowIsShell()) enterPrefixMode();
});

for (const key of ["c", "s", "f", "n", "p", "&", "d", "q", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
  screen.key([key], () => {
    if (!prefixMode) return;
    if (activeWindowIsShell()) return; // shell raw input handles it
    exitPrefixMode();
    runGlobalCommand(key);
  });
}

// --- File manager helpers ---------------------------------------------------

function refreshFileList(win) {
  const reqId = fsRequestSeq++;
  win.fsPending.set(reqId, { path: win.path });
  if (win.fsWs.readyState === WebSocket.OPEN) {
    win.fsWs.send(JSON.stringify({ type: "fs_list", request_id: reqId, path: win.path }));
  }
}

function renderFileList(win) {
  const items = [];
  if (win.path !== "." && win.path !== win.sep && !win.path.endsWith(":")) {
    items.push({ text: "../", kind: "dir", name: ".." });
  }
  for (const e of win.entries) {
    const icon = e.is_dir ? "📁" : "📄";
    const size = e.is_dir ? "" : ` ${formatBytes(e.size || 0)}`;
    items.push({ text: `${icon} ${e.name}${size}`, kind: e.is_dir ? "dir" : "file", name: e.name });
  }
  win.fmData = items;
  win.fm.setItems(items.map((it) => it.text));
  win.fm.setLabel(` files — ${win.title}:${win.path} `);
  screen.render();
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function navigateFile(win) {
  const data = win.fmData[win.fm.selected];
  if (!data) return;
  if (data.kind === "dir") {
    if (data.name === "..") {
      navigateFileUp(win);
    } else {
      win.path = win.pathModule.join(win.path, data.name);
      refreshFileList(win);
    }
  }
}

function navigateFileUp(win) {
  const parent = win.pathModule.dirname(win.path);
  if (parent === win.path) return;
  win.path = parent || ".";
  refreshFileList(win);
}

function downloadSelectedFile(win) {
  const data = win.fmData[win.fm.selected];
  if (!data || data.kind !== "file") return;
  const fileName = data.name;
  const remotePath = win.pathModule.join(win.path, fileName);
  const transferId = fileTransferSeq++;
  const localPath = path.join(process.cwd(), fileName);
  const fd = fs.openSync(localPath, "w");
  win.fileTransfers.set(transferId, { fd, path: localPath, received: 0 });
  if (win.fileWs.readyState === WebSocket.OPEN) {
    win.fileWs.send(JSON.stringify({ type: "file_request", transfer_id: transferId, path: remotePath }));
    setStatus(`downloading ${fileName}...`);
  }
}

function handleFsMessage(win, msg) {
  if (msg.type !== "fs_list_result") return;
  const pending = win.fsPending.get(msg.request_id);
  if (pending) win.fsPending.delete(msg.request_id);
  if (msg.error) {
    setStatus(`fs error: ${msg.error}`);
    return;
  }
  win.path = msg.absolute_path || pending?.path || win.path;
  win.entries = msg.entries || [];
  renderFileList(win);
}

function handleFileMessage(win, msg) {
  switch (msg.type) {
    case "file_start": {
      const tx = win.fileTransfers.get(msg.transfer_id);
      if (!tx) return;
      tx.size = msg.size || 0;
      break;
    }
    case "file_chunk": {
      const tx = win.fileTransfers.get(msg.transfer_id);
      if (!tx) return;
      const buf = Buffer.from(msg.data || "", "base64");
      fs.writeSync(tx.fd, buf);
      tx.received += buf.length;
      break;
    }
    case "file_done": {
      const tx = win.fileTransfers.get(msg.transfer_id);
      if (!tx) return;
      win.fileTransfers.delete(msg.transfer_id);
      fs.closeSync(tx.fd);
      if (msg.error) {
        setStatus(`download failed: ${msg.error}`);
        try { fs.unlinkSync(tx.path); } catch {}
      } else {
        const name = path.basename(tx.path);
        setStatus(`downloaded ${name} (${formatBytes(tx.received)})`);
        notify("rsl-cli download complete", name);
      }
      break;
    }
  }
}

// --- Live session/host list -------------------------------------------------

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
      if (msg.host) {
        hosts.set(msg.host.id, msg.host);
        const who = msg.host.hostname || msg.host.remote || msg.host.id;
        notify("rsl-cli host connected", `${who} (${msg.host.os || "?"}/${msg.host.arch || "?"})`);
      }
      break;
    case "host_update":
      if (msg.host) hosts.set(msg.host.id, msg.host);
      break;
    case "host_remove":
      if (msg.host) {
        const removed = hosts.get(msg.host.id);
        const who = removed?.hostname || removed?.remote || msg.host.id;
        hosts.delete(msg.host.id);
        notify("rsl-cli host disconnected", who);
      }
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

listWs.on("open", () => renderTopBar("connected"));

listWs.on("message", (data) => {
  try {
    handleEvent(JSON.parse(data.toString()));
    renderTopBar();
  } catch (err) {
    renderTopBar(`bad message: ${err.message}`);
  }
});

listWs.on("close", (code, reason) => renderTopBar(`disconnected ${code} ${reason}`));
listWs.on("error", (err) => renderTopBar(`list error: ${err.message}`));

updateBottomBar();
screen.render();
