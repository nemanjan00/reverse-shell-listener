import { EventEmitter } from "node:events";
import { Session } from "./session.js";

// Central registry of every session across all transports. Emits list-level
// events for the dashboard's session stream:
//   "add"    (session)
//   "remove" (session)
//   "update" (session)   metadata changed (exit, upgrade, resize)
class Registry extends EventEmitter {
  constructor() {
    super();
    this._sessions = new Map();
    this._seq = 0;
  }

  create({ transport, remote, backend }) {
    const id = `s${++this._seq}`;
    const session = new Session({ id, transport, remote, backend });
    this._sessions.set(id, session);

    const onUpdate = () => this.emit("update", session);
    session.on("meta", onUpdate);
    session.on("data", onUpdate); // output updates lastActivity/scrollback metadata
    session.on("exit", () => {
      onUpdate();
      // Keep dead sessions around (with their scrollback) so they show in the
      // "offline" list; they are only dropped when explicitly removed.
    });

    this.emit("add", session);
    return session;
  }

  get(id) {
    return this._sessions.get(id);
  }

  list() {
    return [...this._sessions.values()];
  }

  remove(id) {
    const session = this._sessions.get(id);
    if (!session) return;
    session.close();
    this._sessions.delete(id);
    this.emit("remove", session);
  }
}

export const registry = new Registry();
