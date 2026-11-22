// Realtime connection to the sync server.
//
// Every incoming frame is handed to `handler` strictly in arrival order, one
// at a time, and replies to pull/push requests resolve only after their frame
// was handled. The server sends frames in sequence-number order, so this
// keeps the client's view consistent (see internal/server/hub.go).

const PING_MS = 20_000; // also keeps the MV3 service worker alive
const DEAD_MS = 50_000;

export class Connection {
  constructor({ server, token, colls, hello, handler, onState }) {
    this.helloExtra = hello || {};
    this.url = server.replace(/^http/, 'ws') + '/api/v1/ws';
    this.token = token;
    this.colls = colls;
    this.handler = handler;
    this.onState = onState || (() => {});
    this.ws = null;
    this.state = 'offline';
    this.stopped = true;
    this.pending = new Map();
    this.nextId = 1;
    this.inbox = [];
    this.draining = false;
    this.backoff = 1000;
    this.retryTimer = null;
    this.pingTimer = null;
    this.lastFrame = 0;
    this.error = null;
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.onState(state, error);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      try {
        this.ws.close(1000, 'stopped');
      } catch {}
    }
    this.ws = null;
    this.failPending(new Error('connection stopped'));
    this.setState('offline');
  }

  /** Reconnect immediately (e.g. the network came back). */
  kick() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.retryTimer);
    this.backoff = 1000;
    this.connect();
  }

  failPending(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setState('error', String(e.message || e));
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.lastFrame = Date.now();
      ws.send(JSON.stringify({ ...this.helloExtra, t: 'hello', token: this.token, colls: this.colls }));
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (ev) => {
      this.lastFrame = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') return;
      this.inbox.push(msg);
      if (!this.draining) this.drain();
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.inbox = [];
      this.failPending(new Error('connection closed'));
      if (ev.code === 4001) {
        this.stopped = true;
        this.setState('auth', 'This device was signed out. Sign in again.');
        return;
      }
      if (this.stopped) return;
      this.setState('offline', ev.reason || null);
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  /**
   * Handles queued frames one at a time. When the handler falls behind,
   * consecutive "changes" frames are merged into one, so a burst of small
   * updates is applied in a single pass.
   */
  async drain() {
    this.draining = true;
    try {
      while (this.inbox.length) {
        let msg = this.inbox.shift();
        if (msg.t === 'changes') {
          while (this.inbox[0]?.t === 'changes') {
            const next = this.inbox.shift();
            msg = { t: 'changes', records: msg.records.concat(next.records), seq: next.seq };
          }
        }
        await this.dispatch(msg);
      }
    } finally {
      this.draining = false;
    }
  }

  async dispatch(msg) {
    const waiter = msg.id && (msg.t === 'pulled' || msg.t === 'ack' || msg.t === 'error') ? this.pending.get(msg.id) : null;
    try {
      if (msg.t === 'ready') {
        this.backoff = 1000;
        this.setState('syncing');
      }
      await this.handler(msg);
      if (waiter) {
        this.pending.delete(msg.id);
        if (msg.t === 'error') waiter.reject(Object.assign(new Error(msg.message || msg.error), { kind: msg.error }));
        else waiter.resolve(msg);
      }
    } catch (e) {
      console.error('helium-sync: handling', msg.t, e);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter.reject(e);
      }
    }
  }

  scheduleRetry() {
    if (this.stopped) return;
    const delay = Math.min(this.backoff, 60_000) * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  ping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastFrame > DEAD_MS) {
      // Half-open connection (e.g. laptop resumed from sleep).
      try {
        this.ws.close(4000, 'timeout');
      } catch {}
      this.ws.onclose({ code: 4000, reason: 'timeout' });
      return;
    }
    this.ws.send('{"t":"ping"}');
  }

  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  request(msg) {
    if (!this.open) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...msg, id }));
    });
    p.id = id;
    return p;
  }

  pull(since, { limit = 1000, colls, sub = false } = {}) {
    return this.request({ t: 'pull', since, limit, colls, sub });
  }

  push(writes) {
    return this.request({ t: 'push', writes });
  }
}
