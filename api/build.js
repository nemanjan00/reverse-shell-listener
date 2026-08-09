import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));

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