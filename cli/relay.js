#!/usr/bin/env node
// Relay a remote rsl session to stdin/stdout. Intended to run inside a tmux
// window spawned by cli.js.
//
// Env:
//   RSL_URL      listener URL (e.g. https://rsl.example.com/)
//   RSL_TOKEN    API token
//
// Arg:
//   <sessionId>

import { WebSocket } from "ws";
import { URL } from "node:url";

const sessionId = process.argv[2];
const baseUrl = process.env.RSL_URL || "";
const token = process.env.RSL_TOKEN || process.env.RSL_API_TOKEN || "";

if (!baseUrl || !token || !sessionId) {
  console.error("usage: RSL_URL=... RSL_TOKEN=... node cli/relay.js <sessionId>");
  process.exit(1);
}

const parsed = new URL(baseUrl);
const wsScheme = parsed.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsScheme}://${parsed.host}/api/ws/session/${sessionId}`;

const ws = new WebSocket(wsUrl, { headers: { "X-API-Token": token } });

function sendResize() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

ws.on("open", () => {
  sendResize();
});

ws.on("message", (data, isBinary) => {
  // Control frames are JSON text; shell output is binary. Try parsing
  // everything first, just in case a frame arrives as binary in some ws
  // configurations.
  const text = Buffer.isBuffer(data) ? data.toString("utf-8") : data;
  try {
    const msg = JSON.parse(text);
    if (msg.type === "exit") {
      process.stdout.write("\r\n[session exited]\r\n");
      process.exit(0);
    }
    return;
  } catch {
    // not JSON: treat as shell output
  }
  if (!isBinary) return; // stray text frame that isn't JSON
  process.stdout.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
});

ws.on("close", () => {
  process.stdout.write("\r\n[disconnected]\r\n");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("relay error:", err.message);
  process.exit(1);
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(chunk);
  }
});

process.stdout.on("resize", sendResize);

process.on("exit", () => {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore
  }
});
