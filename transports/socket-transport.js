import { registry } from "../core/registry.js";
import { log } from "../core/log.js";

// Shared logic for the raw TCP and TLS transports: both hand us a duplex socket,
// only the server that produced it differs. Adapts a socket to a Session.
export function handleSocket(socket, transport) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;

  // `session` is assigned just below; the backend closes over it lazily so
  // resize can consult session.upgraded at call time.
  let session;
  const backend = {
    write: (buf) => socket.write(buf),
    resize: (cols, rows) => {
      // A raw socket has no SIGWINCH channel; only meaningful once the remote
      // is a real PTY (after upgrade), where stty takes effect.
      if (session && session.upgraded) {
        socket.write(Buffer.from(`stty rows ${rows} cols ${cols} 2>/dev/null\n`));
      }
    },
    close: () => socket.destroy(),
  };

  session = registry.create({ transport, remote, backend });
  log.info(`${transport} session connected`, { sessionId: session.id, remote });

  socket.on("data", (data) => session.push(data));
  socket.on("error", () => session.markExit());
  socket.on("close", () => {
    if (session.alive) {
      log.info(`${transport} session closed`, { sessionId: session.id, remote });
    }
    session.markExit();
  });
  socket.on("end", () => session.markExit());
  socket.on("timeout", () => session.markExit());

  return session;
}
