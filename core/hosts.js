import { EventEmitter } from "node:events";

// Registry of mux "hosts": each is one multiplexed WebSocket connection from a
// Go client, carrying many shell channels. Emits add / update / remove so the
// dashboard can list hosts and offer "open a new shell".
class Hosts extends EventEmitter {
  constructor() {
    super();
    this._map = new Map();
    this._seq = 0;
  }

  add(host) {
    host.id = `h${++this._seq}`;
    this._map.set(host.id, host);
    this.emit("add", host);
    return host.id;
  }

  get(id) {
    return this._map.get(id);
  }

  list() {
    return [...this._map.values()];
  }

  update(host) {
    if (this._map.has(host.id)) this.emit("update", host);
  }

  remove(id) {
    const host = this._map.get(id);
    if (!host) return;
    this._map.delete(id);
    this.emit("remove", host);
  }
}

export const hosts = new Hosts();
