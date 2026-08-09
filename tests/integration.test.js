import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
});
