import { EventEmitter } from "node:events";

// In-memory ring buffer of operational events: connections, rejections,
// autoexec results, auth events, etc. Surfaced to the dashboard via
// /api/log (REST snapshot) and /api/ws/log (live stream).
const MAX_ENTRIES = 500;

class Log extends EventEmitter {
  constructor() {
    super();
    this._entries = [];
  }

  push(level, message, meta = {}) {
    const entry = {
      ts: Date.now(),
      level,
      message,
      ...meta,
    };
    this._entries.push(entry);
    if (this._entries.length > MAX_ENTRIES) this._entries.shift();
    this.emit("entry", entry);
  }

  info(message, meta) {
    this.push("info", message, meta);
  }
  warn(message, meta) {
    this.push("warn", message, meta);
  }
  error(message, meta) {
    this.push("error", message, meta);
  }

  list(since = 0) {
    return since ? this._entries.filter((e) => e.ts > since) : [...this._entries];
  }
}

export const log = new Log();