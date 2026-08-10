import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function waitForServer(baseUrl, timeout = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryFetch = async () => {
      try {
        const res = await fetch(`${baseUrl}/login`);
        if (res.status === 200) return resolve();
      } catch {}
      if (Date.now() - start > timeout) return reject(new Error("server did not start"));
      setTimeout(tryFetch, 100);
    };
    tryFetch();
  });
}

async function login(baseUrl, user, pass) {
  const res = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: user, password: pass }),
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie") || "";
  const match = cookie.match(/rsl_session=([^;]+)/);
  if (!match) throw new Error("login did not set session cookie");
  return decodeURIComponent(match[1]);
}

async function getCsrf(baseUrl, sessionCookie) {
  const res = await fetch(`${baseUrl}/api/csrf`, {
    headers: { cookie: `rsl_session=${encodeURIComponent(sessionCookie)}` },
  });
  const body = await res.json();
  return body.csrf;
}

function openWs(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), timeoutMs);
    const onMsg = (data) => {
      clearTimeout(timer);
      ws.off("message", onMsg);
      resolve(data.toString());
    };
    ws.on("message", onMsg);
  });
}

function nextClose(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket close timeout")), timeoutMs);
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason ? reason.toString() : "" });
    });
  });
}

async function assertRejectsWs(url, headers, label) {
  const ws = new WebSocket(url, { headers });
  const result = await Promise.race([
    nextMessage(ws, 2000).then((msg) => ({ ok: true, msg })),
    nextClose(ws, 2000).then((close) => ({ ok: false, close })),
  ]);
  if (result.ok) {
    throw new Error(`${label}: expected rejection but got message: ${result.msg.slice(0, 200)}`);
  }
  // Server sends 1008, but the client sometimes sees 1005 if the close frame
  // is lost during the abrupt teardown. Both mean "rejected".
  assert.ok(
    result.close.code === 1008 || result.close.code === 1005,
    `${label}: expected close code 1008 or 1005, got ${result.close.code}`
  );
}

describe("integration", () => {
  let server;
  let baseUrl;
  let session;
  let csrfToken;

  before(async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn("node", ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        TCP_PORT: String(port + 1),
        TLS_PORT: String(port + 2),
        AUTH_USER: "admin",
        AUTH_PASS: "admin",
        AUTH_SECRET: "test-secret-for-deterministic-tokens",
        BUILD_TOKEN: "buildtok",
        PROXY_TOKEN: "proxytok",
        PROXY_PORT: "0",
        API_TOKEN: "apitok",
        ENABLE_TCP: "false",
        ENABLE_TLS: "false",
        ENABLE_WEBSHELL: "false",
        ENABLE_MUX: "false",
      },
      stdio: "pipe",
    });
    server.stdout.on("data", () => {});
    server.stderr.on("data", () => {});
    await waitForServer(baseUrl, 15000);
    session = await login(baseUrl, "admin", "admin");
    csrfToken = await getCsrf(baseUrl, session);
  });

  after(() => {
    if (server) server.kill("SIGTERM");
  });

  it("sets security headers on responses", async () => {
    const res = await fetch(`${baseUrl}/login`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.ok(res.headers.get("content-security-policy"));
  });

  it("redirects unauthenticated dashboard requests to /login", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
  });

  it("returns 401 for unauthenticated API requests", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(res.status, 401);
  });

  it("returns sessions list for authenticated requests", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { cookie: `rsl_session=${encodeURIComponent(session)}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("rejects mutating API requests without CSRF token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/clear-dead`, {
      method: "POST",
      headers: { cookie: `rsl_session=${encodeURIComponent(session)}` },
    });
    assert.equal(res.status, 403);
  });

  it("accepts mutating API requests with valid CSRF token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/clear-dead`, {
      method: "POST",
      headers: {
        cookie: `rsl_session=${encodeURIComponent(session)}`,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("exposes runtime config to authenticated dashboard", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      headers: { cookie: `rsl_session=${encodeURIComponent(session)}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.proxy_enabled, true);
    assert.equal(body.proxy_token, "proxytok");
    assert.equal(body.build_token, "buildtok");
  });

  it("rejects /dl without build token", async () => {
    const res = await fetch(`${baseUrl}/dl?os=linux&arch=amd64`, { redirect: "manual" });
    assert.equal(res.status, 403);
  });

  it("allows API token access to /api/sessions without a session cookie", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { "x-api-token": "apitok" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("allows API token mutating requests without CSRF token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/clear-dead`, {
      method: "POST",
      headers: { "x-api-token": "apitok" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("rejects API requests with a wrong API token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { "x-api-token": "wrong" },
    });
    assert.equal(res.status, 401);
  });

  it("rejects self-destruct for non-existent host", async () => {
    const res = await fetch(`${baseUrl}/api/hosts/h999/self-destruct`, {
      method: "POST",
      headers: {
        cookie: `rsl_session=${encodeURIComponent(session)}`,
        "x-csrf-token": csrfToken,
      },
    });
    assert.equal(res.status, 404);
  });

  it("allows self-destruct via API token without CSRF", async () => {
    const res = await fetch(`${baseUrl}/api/hosts/h999/self-destruct`, {
      method: "POST",
      headers: { "x-api-token": "apitok" },
    });
    assert.equal(res.status, 404);
  });

  it("allows API token access to /api/ws/sessions", async () => {
    const ws = await openWs(`${baseUrl.replace("http", "ws")}/api/ws/sessions`, {
      "x-api-token": "apitok",
    });
    const msg = await nextMessage(ws);
    const body = JSON.parse(msg);
    assert.equal(body.type, "snapshot");
    assert.ok(Array.isArray(body.sessions));
    assert.ok(Array.isArray(body.hosts));
    ws.close();
  });

  it("rejects /api/ws/sessions without auth", async () => {
    await assertRejectsWs(`${baseUrl.replace("http", "ws")}/api/ws/sessions`, {}, "no auth");
  });

  it("rejects /api/ws/sessions with a wrong API token", async () => {
    await assertRejectsWs(
      `${baseUrl.replace("http", "ws")}/api/ws/sessions`,
      { "x-api-token": "wrong" },
      "bad token"
    );
  });

  it("allows API token access to /api/ws/log", async () => {
    const ws = await openWs(`${baseUrl.replace("http", "ws")}/api/ws/log`, {
      "x-api-token": "apitok",
    });
    // The log may be empty if no events have occurred; just verify the
    // connection stays open without being rejected.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      ws.on("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`/api/ws/log closed unexpectedly with code ${code}`));
      });
    });
    ws.close();
  });

  it("rejects /api/ws/host/:id/file for missing host even with API token", async () => {
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws/host/h999/file`, {
      headers: { "x-api-token": "apitok" },
    });
    const close = await nextClose(ws);
    assert.equal(close.code, 1008);
  });
});
