import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.resolve(here, "..", "certs");
const CRT = path.join(CERT_DIR, "server.crt");
const KEY = path.join(CERT_DIR, "server.key");

// Ensure a self-signed cert/key pair exists, generating one with openssl on
// first run. An operator can also drop their own pair at certs/server.{crt,key}.
export function ensureCert() {
  if (!fs.existsSync(CRT) || !fs.existsSync(KEY)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    try {
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes",
          "-keyout", KEY, "-out", CRT,
          "-days", "3650", "-subj", "/CN=reverse-shell-listener",
        ],
        { stdio: "ignore" }
      );
    } catch (err) {
      throw new Error(
        "Could not generate a TLS cert: openssl failed or is missing " +
          `(${err.message}). Install openssl, drop your own pair at ` +
          "certs/server.crt + certs/server.key, or set ENABLE_TLS=false."
      );
    }
    console.log("[tls]  generated self-signed cert (certs/server.crt)");
  }

  const cert = fs.readFileSync(CRT);
  const key = fs.readFileSync(KEY);
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  return { cert, key, fingerprint };
}
