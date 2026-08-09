import http from "node:http";

import config from "../config.js";
import { hosts } from "../core/hosts.js";
import { log } from "../core/log.js";

// Minimal HTTP CONNECT proxy that tunnels TCP connections through a mux host.
// Authentication is Basic auth: username = host id, password = PROXY_TOKEN.
// When PROXY_TOKEN is empty, the proxy listener is disabled.

function parseBasicAuth(header) {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function parseConnectTarget(url) {
  const [hostname, portStr] = url.split(":");
  const port = parseInt(portStr, 10);
  if (!hostname || !portStr || Number.isNaN(port) || port <= 0 || port > 65535) {
    return null;
  }
  return { hostname, port };
}

export function startProxy() {
  if (!config.PROXY_TOKEN) return;

  const server = http.createServer((req, res) => {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("CONNECT only\n");
  });

  server.on("connect", (req, clientSocket, head) => {
    const auth = parseBasicAuth(req.headers["proxy-authorization"]);
    if (!auth || auth.password !== config.PROXY_TOKEN) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
      clientSocket.end();
      log.warn("proxy auth failed", { remote: clientSocket.remoteAddress });
      return;
    }

    const host = hosts.get(auth.username);
    if (!host || !host.alive) {
      clientSocket.write("HTTP/1.1 404 Host Not Found\r\n\r\n");
      clientSocket.end();
      log.warn("proxy host not found", { hostId: auth.username });
      return;
    }

    const target = parseConnectTarget(req.url);
    if (!target) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }

    const proxyId = host.openProxy(target.hostname, target.port);
    if (proxyId == null) {
      clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      clientSocket.end();
      return;
    }

    log.info("proxy tunnel requested", {
      proxyId,
      hostId: host.id,
      target: `${target.hostname}:${target.port}`,
      remote: clientSocket.remoteAddress,
    });

    let opened = false;
    let cleanup = null;

    function closeTunnel(reason) {
      if (cleanup) cleanup();
      host.deleteProxyHandler(proxyId);
      host.send({ proxyClose: { proxyId, reason } });
      if (!clientSocket.destroyed) {
        clientSocket.end();
      }
    }

    host.setProxyHandler(proxyId, {
      onOpen: () => {
        if (opened) return;
        opened = true;
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) {
          host.send({ proxyData: { proxyId, data: head } });
        }
      },
      onOpenError: (message) => {
        if (opened) return;
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
        log.warn("proxy tunnel open failed", { proxyId, error: message });
      },
      onData: (data) => {
        if (!clientSocket.destroyed) {
          clientSocket.write(data);
        }
      },
      onClose: () => {
        if (!clientSocket.destroyed) {
          clientSocket.end();
        }
      },
    });

    clientSocket.on("data", (data) => {
      if (!opened) return; // buffer until the remote side is confirmed open
      host.send({ proxyData: { proxyId, data } });
    });

    clientSocket.on("close", () => closeTunnel("client closed"));

    clientSocket.on("error", (err) => {
      log.warn("proxy client socket error", { proxyId, error: err.message });
      closeTunnel(err.message);
    });

    // Safety: if the remote side never responds, clean up.
    const connectTimeout = setTimeout(() => {
      if (!opened) {
        clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
        clientSocket.end();
        closeTunnel("connect timeout");
      }
    }, 15000);

    cleanup = () => clearTimeout(connectTimeout);
  });

  server.listen(config.PROXY_PORT, config.HOST, () => {
    console.log(`[proxy] HTTP CONNECT proxy on ${config.HOST}:${config.PROXY_PORT}`);
  });

  server.on("error", (err) => {
    console.error("[proxy] server error:", err);
    log.error("proxy server error", { error: err.message });
  });
}
