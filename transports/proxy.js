import { Duplex } from "node:stream";

import proxinator from "proxinator";

import config from "../config.js";
import { hosts } from "../core/hosts.js";
import { log } from "../core/log.js";

// HTTP CONNECT proxy through a mux host, powered by proxinator.
// Authentication: Basic auth username = host id, password = PROXY_TOKEN.
// Disabled when PROXY_TOKEN is empty.

class MuxSocket extends Duplex {
  constructor(host, proxyId) {
    super({ allowHalfOpen: true });
    this.host = host;
    this.proxyId = proxyId;
    this._connected = false;
  }

  _write(chunk, _encoding, callback) {
    this.host.send({ proxyData: { proxyId: this.proxyId, data: chunk } });
    callback();
  }

  _read() {
    // Data is pushed into the readable buffer from the mux host.
  }

  onMuxOpen() {
    this._connected = true;
    this.emit("connect");
  }

  onMuxData(data) {
    this.push(Buffer.from(data));
  }

  onMuxError(message) {
    this.destroy(new Error(message));
  }

  onMuxClose() {
    this.push(null);
    this.destroy();
  }
}

export function startProxy() {
  if (!config.PROXY_TOKEN) return;

  const proxy = proxinator.server.forward();

  proxy.on("connection", (connection) => {
    const auth = connection.getAuth();
    if (!auth || auth.password !== config.PROXY_TOKEN) {
      connection.error(new Error("Proxy Authentication Required"), 407, {
        "Proxy-Authenticate": "Basic",
      });
      log.warn("proxy auth failed", { remote: connection.getRemoteHost() });
      return;
    }

    const host = hosts.get(auth.username);
    if (!host || !host.alive) {
      connection.error(new Error("Host Not Found"), 404);
      log.warn("proxy host not found", { hostId: auth.username });
      return;
    }

    const destination = connection.getDestination();
    const hostname = destination.hostname;
    const port = parseInt(destination.port, 10);
    if (!hostname || !port) {
      connection.error(new Error("Bad Request"), 400);
      return;
    }

    const proxyId = host.openProxy(hostname, port);
    if (proxyId == null) {
      connection.error(new Error("Service Unavailable"), 503);
      return;
    }

    log.info("proxy tunnel requested", {
      proxyId,
      hostId: host.id,
      target: `${hostname}:${port}`,
      remote: connection.getRemoteHost(),
    });

    const muxSocket = new MuxSocket(host, proxyId);

    host.setProxyHandler(proxyId, {
      onOpen: () => {
        muxSocket.onMuxOpen();
        connection.bind(muxSocket);
      },
      onOpenError: (message) => {
        log.warn("proxy tunnel open failed", { proxyId, error: message });
        connection.error(new Error(message), 502);
      },
      onData: (data) => muxSocket.onMuxData(data),
      onClose: () => muxSocket.onMuxClose(),
    });

    // Safety timeout if the client never responds.
    const timeout = setTimeout(() => {
      if (!muxSocket._connected) {
        host.deleteProxyHandler(proxyId);
        host.send({ proxyClose: { proxyId, reason: "connect timeout" } });
        connection.error(new Error("Gateway Timeout"), 504);
      }
    }, 15000);

    muxSocket.on("close", () => clearTimeout(timeout));
  });

  proxy.on("error", (error, connection) => {
    console.error("[proxy] error:", error);
    log.error("proxy error", {
      error: error.message,
      remote: connection ? connection.getRemoteHost() : null,
    });
  });

  proxy.http.listen(config.PROXY_PORT, config.HOST, () => {
    console.log(`[proxy] HTTP CONNECT proxy on ${config.HOST}:${config.PROXY_PORT}`);
  });
}
