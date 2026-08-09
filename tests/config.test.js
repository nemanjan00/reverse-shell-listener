import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Config is environment-driven and loaded once. These tests verify the helper
// behavior by re-importing the module with a clean process.env in a subprocess.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config.js");

function loadConfig(env) {
  const script = `
    import config from ${JSON.stringify(configPath)};
    console.log(JSON.stringify(config));
  `;
  const out = execSync("node --input-type=module", {
    env: { ...process.env, ...env },
    input: script,
    encoding: "utf8",
  });
  return JSON.parse(out.trim());
}

describe("config", () => {
  it("applies defaults when env vars are missing", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.PORT, 8080);
    assert.equal(cfg.HOST, "0.0.0.0");
    assert.equal(cfg.TCP_PORT, 1337);
    assert.equal(cfg.TLS_PORT, 1338);
    assert.equal(cfg.ENABLE_TCP, true);
    assert.equal(cfg.ENABLE_TLS, true);
    assert.equal(cfg.ENABLE_WEBSHELL, true);
    assert.equal(cfg.ENABLE_MUX, true);
    assert.equal(cfg.MUX_PING_MS, 20000);
    assert.equal(cfg.SCROLLBACK_BYTES, 1024 * 1024);
    assert.equal(cfg.WEBSHELL_POLL_MS, 25000);
    assert.equal(cfg.WEBSHELL_TIMEOUT, 30000);
    assert.equal(cfg.PROXY_PORT, 0);
  });

  it("reads overridden values from env", () => {
    const cfg = loadConfig({
      PORT: "9000",
      TCP_PORT: "9001",
      AUTH_USER: "u",
      AUTH_PASS: "p",
      BUILD_TOKEN: "tok",
      PROXY_TOKEN: "ptok",
      PROXY_PORT: "3128",
      SCROLLBACK_BYTES: "2048",
    });
    assert.equal(cfg.PORT, 9000);
    assert.equal(cfg.TCP_PORT, 9001);
    assert.equal(cfg.AUTH_USER, "u");
    assert.equal(cfg.AUTH_PASS, "p");
    assert.equal(cfg.BUILD_TOKEN, "tok");
    assert.equal(cfg.PROXY_TOKEN, "ptok");
    assert.equal(cfg.PROXY_PORT, 3128);
    assert.equal(cfg.SCROLLBACK_BYTES, 2048);
  });

  it("disables booleans for falsey strings", () => {
    const cfg = loadConfig({
      ENABLE_TCP: "false",
      ENABLE_TLS: "0",
      ENABLE_WEBSHELL: "no",
      ENABLE_MUX: "off",
    });
    assert.equal(cfg.ENABLE_TCP, false);
    assert.equal(cfg.ENABLE_TLS, false);
    assert.equal(cfg.ENABLE_WEBSHELL, false);
    assert.equal(cfg.ENABLE_MUX, false);
  });
});
