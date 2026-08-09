import { EventEmitter } from "node:events";
import config from "../config.js";

// The PTY-upgrade sequence: try python3, then python, then a script(1)
// fallback, then push our terminal size so full-screen apps line up. Sent as
// one blob to the remote shell.
function upgradeCommand(cols, rows) {
  return (
    "python3 -c 'import pty; pty.spawn(\"/bin/bash\")' 2>/dev/null || " +
    "python -c 'import pty; pty.spawn(\"/bin/bash\")' 2>/dev/null || " +
    "script -qc /bin/bash /dev/null\n" +
    `stty rows ${rows} cols ${cols} 2>/dev/null\n`
  );
}

// One reverse-shell connection, transport-agnostic. Transports construct it,
// wire a backend (write/resize/close) and feed inbound bytes via push().
export class Session extends EventEmitter {
  constructor({ id, transport, remote, backend }) {
    super();
    this.id = id;
    this.transport = transport; // "tcp" | "tls" | "webshell"
    this.remote = remote;
    this.createdAt = Date.now();
    this.alive = true;
    this.cols = 80;
    this.rows = 24;
    this.upgraded = false;
    this.lastActivityAt = this.createdAt;

    this._backend = backend; // { write(buf), resize?(c,r), close() }
    this._scrollback = [];
    this._scrollbackBytes = 0;
  }

  // Inbound bytes from the remote shell.
  push(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    this._scrollback.push(buf);
    this._scrollbackBytes += buf.length;
    while (this._scrollbackBytes > config.SCROLLBACK_BYTES && this._scrollback.length > 1) {
      this._scrollbackBytes -= this._scrollback.shift().length;
    }
    this.lastActivityAt = Date.now();
    this.emit("data", buf);
  }

  scrollback() {
    return Buffer.concat(this._scrollback);
  }

  // Outbound stdin from a dashboard viewer.
  write(buf) {
    if (!this.alive) return;
    try {
      this._backend.write(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch {
      this.markExit();
    }
  }

  resize(cols, rows) {
    cols = Number(cols) | 0;
    rows = Number(rows) | 0;
    if (!cols || !rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.alive && typeof this._backend.resize === "function") {
      try {
        this._backend.resize(cols, rows);
      } catch {
        /* best effort */
      }
    }
  }

  // Ask the remote dumb shell to become a PTY-backed bash.
  upgrade() {
    if (!this.alive) return;
    this.upgraded = true;
    this.write(Buffer.from(upgradeCommand(this.cols, this.rows)));
    this.emit("meta");
  }

  close() {
    try {
      this._backend.close();
    } catch {
      /* ignore */
    }
    this.markExit();
  }

  markExit() {
    if (!this.alive) return;
    this.alive = false;
    this.emit("exit");
  }

  meta() {
    return {
      id: this.id,
      transport: this.transport,
      remote: this.remote,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      alive: this.alive,
      cols: this.cols,
      rows: this.rows,
      upgraded: this.upgraded,
    };
  }
}
