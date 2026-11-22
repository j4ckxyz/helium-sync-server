// The sync engine: moves encrypted records between collection adapters and
// the server.
//
// Rules that keep devices convergent:
//  1. Local changes go to the outbox (coalesced per record) and are pushed
//     once the connection is caught up. Entries stay until acknowledged.
//  2. An incoming change for a record with a pending local change is
//     skipped: the local write reaches the server later, so it wins there
//     too (last writer to the server wins).
//  3. Adapters scan local state *before* applying remote changes, so an
//     unscanned local edit is captured (rule 2) rather than overwritten.
//  4. Frames are handled strictly in order (connection.js) and the server
//     never sends a change older than one already delivered.

import { Connection } from './lib/connection.js';
import * as c from './lib/crypto.js';
import * as db from './lib/db.js';

const PUSH_BATCH = 500;
export const PROTOCOL = 1;

export class Engine {
  constructor() {
    this.adapters = []; // enabled adapters
    this.byColl = new Map();
    this.outbox = new Map(); // key -> { c, id, data, del, gen }
    this.pendingAcks = new Map(); // push request id -> [{ k, gen }]
    this.gen = 0;
    this.cursor = 0;
    this.live = false;
    this.conn = null;
    this.session = null;
    this.keys = null;
    this.online = [];
    this.listeners = new Set();
    this.flushTimer = null;
    this.persistTimer = null;
    this.status = { state: 'signed-out', error: null, lastSync: 0 };
    this.catchingUp = null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** session: { server, token, deviceId, username, deviceName } */
  async start(session, keys, adapters) {
    this.session = session;
    this.keys = keys;
    this.cursor = (await db.kvGet('cursor')) || 0;
    // Records skipped because a newer extension wrote them in a format this
    // version could not read: once updated, fetch them again.
    const skipped = await db.kvGet('skipped');
    if (skipped && skipped.format < c.SUPPORTED_FORMAT) {
      this.cursor = Math.min(this.cursor, skipped.seq - 1);
      await db.kvSet('cursor', this.cursor);
      await db.kvDelete('skipped');
    }
    const saved = (await db.kvGet('outbox')) || [];
    for (const e of saved) this.outbox.set(key(e.c, e.id), { ...e, gen: ++this.gen });
    this.setAdapters(await this.loadAll(adapters));
    this.connect();
  }

  /**
   * Loads adapters one by one; one that fails (e.g. a browser API that
   * changed or is missing in this browser version) is left out instead of
   * stopping sync for everything else.
   */
  async loadAll(adapters) {
    const ok = [];
    this.failed = [];
    for (const a of adapters) {
      try {
        await a.load(this);
        ok.push(a);
      } catch (e) {
        console.error('helium-sync: cannot start', a.coll, e);
        this.failed.push({ coll: a.coll, error: String(e.message || e) });
      }
    }
    return ok;
  }

  setAdapters(adapters) {
    this.adapters = adapters;
    this.byColl = new Map();
    for (const a of adapters) for (const coll of a.colls) this.byColl.set(coll, a);
  }

  colls() {
    return [...this.byColl.keys()];
  }

  connect() {
    if (this.conn) this.conn.stop();
    this.live = false;
    this.conn = new Connection({
      server: this.session.server,
      token: this.session.token,
      colls: this.colls(),
      hello: { proto: PROTOCOL, ext: chrome.runtime.getManifest?.().version, formats: c.SUPPORTED_FORMAT },
      handler: (m) => this.handle(m),
      onState: (state, error) => {
        // 'syncing' (socket ready) becomes 'live' once catch-up finishes.
        if (state !== 'syncing') this.live = false;
        this.setStatus({ state, error });
      },
    });
    this.conn.start();
  }

  /** Re-subscribe after collections were enabled or disabled. */
  async reconfigure(adapters) {
    const before = new Set(this.adapters);
    for (const a of this.adapters) if (!adapters.includes(a)) await a.disable?.().catch?.(() => {});
    const added = await this.loadAll(adapters.filter((a) => !before.has(a)));
    this.setAdapters(adapters.filter((a) => before.has(a) || added.includes(a)));
    // Drop queued writes for collections that are no longer synced.
    for (const [k, e] of this.outbox) if (!this.byColl.has(e.c)) this.outbox.delete(k);
    this.persistOutbox();
    this.connect();
  }

  async stop() {
    this.conn?.stop();
    this.conn = null;
    this.live = false;
    clearTimeout(this.flushTimer);
    for (const a of this.adapters) await a.stop?.();
    this.adapters = [];
    this.byColl = new Map();
    this.outbox.clear();
    this.setStatus({ state: 'signed-out', error: null });
  }

  kick() {
    this.conn?.kick();
  }

  // -------------------------------------------------------------------------
  // Status

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) {
      try {
        fn(this.status);
      } catch {}
    }
  }

  onStatus(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -------------------------------------------------------------------------
  // Outgoing

  isPending(coll, id) {
    return this.outbox.has(key(coll, id));
  }

  /** Queues an upsert. */
  write(coll, id, data) {
    this.queue(coll, id, data, false);
  }

  /** Queues a deletion; data (optional) travels encrypted in the tombstone. */
  remove(coll, id, data = null) {
    this.queue(coll, id, data, true);
  }

  queue(coll, id, data, del) {
    const k = key(coll, id);
    // Deletions are final and cannot loop by themselves: never hold them.
    this.outbox.set(k, { c: coll, id, data, del, gen: ++this.gen, hold: del ? 0 : this.loopGuard(k) });
    this.note(coll, id, del);
    this.changed();
  }

  /**
   * Loop breaker. Real use rarely rewrites one record more than twice a
   * second for a whole minute (a site rewriting its URL on every keystroke
   * comes close). If something does — e.g. a browser version emitting events
   * differently, making devices echo each other — that record is sent at
   * most every 5 seconds (the outbox keeps only its latest state) instead of
   * flooding the server.
   */
  loopGuard(k) {
    const now = Date.now();
    this.rates = this.rates || new Map();
    let r = this.rates.get(k);
    if (!r || now - r.since > 60_000) r = { since: now, n: 0 };
    r.n++;
    this.rates.set(k, r);
    if (this.rates.size > 10_000) this.rates.clear();
    if (r.n <= 120) return 0;
    if (r.n === 121) console.warn('helium-sync: record rewritten too often, throttling', k);
    return now + 5_000;
  }

  // Recent local writes, for diagnostics.
  note(coll, id, del) {
    this.recent = this.recent || [];
    this.recent.push({ c: coll, id, del, at: Date.now() });
    if (this.recent.length > 100) this.recent.shift();
  }

  outboxSize() {
    return this.outbox.size;
  }

  changed() {
    this.persistOutbox();
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 0);
  }

  persistOutbox() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const list = [...this.outbox.values()].map(({ gen, sent, hold, ...e }) => e);
      db.kvSet('outbox', list).catch((e) => console.warn('helium-sync: persist outbox', e));
    }, 500);
  }

  async flush() {
    this.flushTimer = null;
    if (!this.live || !this.conn?.open) return;
    const batch = [];
    let held = 0;
    for (const [k, e] of this.outbox) {
      if (e.sent === e.gen) continue; // already in flight in this version
      if (e.hold && e.hold > Date.now()) {
        held = Math.max(held, e.hold);
        continue;
      }
      batch.push([k, e]);
      if (batch.length >= PUSH_BATCH) break;
    }
    if (held) this.flushTimer = setTimeout(() => this.flush(), held - Date.now() + 10);
    if (!batch.length) return;
    let writes;
    try {
      writes = await Promise.all(
        batch.map(async ([, e]) => {
          const w = { c: e.c, id: e.id };
          if (e.del) w.x = true;
          if (e.data != null) w.d = c.b64encode(await c.encryptRecord(this.keys, e.c, e.id, e.data));
          return w;
        }),
      );
    } catch (err) {
      console.error('helium-sync: encrypt', err);
      return;
    }
    for (const [, e] of batch) e.sent = e.gen;
    const sent = batch.map(([k, e]) => ({ k, gen: e.gen }));
    const req = this.conn.push(writes);
    // The ack itself is processed in order by handle().
    this.pendingAcks.set(req.id, sent);
    req.catch((err) => {
        for (const { k, gen } of sent) {
          const e = this.outbox.get(k);
          if (e && e.sent === gen) delete e.sent;
        }
        this.pendingAcks.delete(req.id);
        if (err.kind === 'quota_exceeded') this.setStatus({ error: 'Your server storage quota is full.' });
        else if (err.kind) console.warn('helium-sync: push rejected', err.kind, err.message);
      });
    // More to send? Keep going without waiting for the ack.
    if (this.outbox.size > batch.length) this.flushTimer = setTimeout(() => this.flush(), 0);
  }

  // -------------------------------------------------------------------------
  // Incoming

  async handle(msg) {
    switch (msg.t) {
      case 'ready':
        this.deviceId = msg.device;
        this.server = { proto: msg.proto || 1, version: msg.version || '' };
        this.online = msg.online || [];
        if (msg.gc > this.cursor && this.cursor > 0) {
          // Deletions we never saw were purged: rebuild from scratch.
          this.cursor = 0;
          for (const a of this.adapters) await a.reset?.();
        }
        // Must not be awaited: catch-up waits for replies that are queued
        // behind this frame.
        this.catchingUp = this.catchUp().catch((e) => {
          console.warn('helium-sync: catch-up failed', e);
        });
        return;
      case 'pulled':
        await this.applyRecords(msg.records);
        return;
      case 'changes':
        await this.applyRecords(msg.records);
        if (this.live) this.setCursor(msg.seq);
        this.setStatus({ lastSync: Date.now() });
        return;
      case 'ack': {
        const sent = this.pendingAcks.get(msg.id);
        this.pendingAcks.delete(msg.id);
        if (sent) {
          for (const { k, gen } of sent) {
            const e = this.outbox.get(k);
            if (e && e.gen === gen) this.outbox.delete(k);
          }
          this.persistOutbox();
          const byAdapter = new Map();
          sent.forEach(({ k }, i) => {
            const [coll, id] = k.split('\u0000');
            const a = this.byColl.get(coll);
            if (!a || !msg.seqs?.[i]) return;
            if (!byAdapter.has(a)) byAdapter.set(a, []);
            byAdapter.get(a).push({ coll, id, seq: msg.seqs[i], final: !this.outbox.has(k) });
          });
          for (const [a, list] of byAdapter) await a.onAck(list);
        }
        if (this.live) this.setCursor(msg.seq);
        this.setStatus({ lastSync: Date.now() });
        return;
      }
      case 'error': {
        const sent = this.pendingAcks.get(msg.id);
        this.pendingAcks.delete(msg.id);
        if (sent) {
          for (const { k, gen } of sent) {
            const e = this.outbox.get(k);
            if (e && e.gen === gen) delete e.sent;
          }
        }
        return;
      }
      case 'presence':
        this.online = msg.online || [];
        for (const a of this.adapters) a.onPresence?.(this.online);
        this.setStatus({});
        return;
    }
  }

  setCursor(seq) {
    if (typeof seq !== 'number' || seq <= this.cursor) return;
    this.cursor = seq;
    clearTimeout(this.cursorTimer);
    this.cursorTimer = setTimeout(() => db.kvSet('cursor', this.cursor), 300);
  }

  async catchUp() {
    const conn = this.conn;
    this.setStatus({ state: 'syncing' });
    // Collections enabled since the last sync need their full history.
    const known = new Set((await db.kvGet('syncedColls')) || []);
    const fresh = this.colls().filter((x) => !known.has(x));
    if (fresh.length && this.cursor > 0) {
      let since = 0;
      for (;;) {
        const page = await conn.pull(since, { colls: fresh });
        if (!page.more || page.seq <= since) break;
        since = page.seq;
      }
    }
    let since = this.cursor;
    for (;;) {
      const page = await conn.pull(since, { sub: true });
      if (conn !== this.conn) return;
      this.setCursor(page.seq);
      if (!page.more) break;
      since = page.seq;
    }
    await db.kvSet('syncedColls', this.colls());
    this.live = true;
    for (const a of this.adapters) {
      try {
        await a.onCaughtUp?.();
      } catch (e) {
        console.error('helium-sync: initial merge', a.colls, e);
      }
    }
    this.setStatus({ state: 'live', error: null, lastSync: Date.now() });
    this.flush();
  }

  async applyRecords(records) {
    if (!records?.length) return;
    const groups = new Map();
    let newer = Infinity;
    await Promise.all(
      records.map(async (r) => {
        const a = this.byColl.get(r.c);
        if (!a) return;
        let data = null;
        if (r.d) {
          try {
            data = await c.decryptRecord(this.keys, r.c, r.id, c.b64decode(r.d));
          } catch (e) {
            if (e instanceof c.UnsupportedFormat) newer = Math.min(newer, r.s);
            else console.warn('helium-sync: cannot decrypt', r.c, r.id, e.message);
            return;
          }
        }
        r.data = data;
      }),
    );
    if (newer < Infinity) {
      const prev = await db.kvGet('skipped');
      await db.kvSet('skipped', { seq: Math.min(newer, prev?.seq ?? Infinity), format: c.SUPPORTED_FORMAT });
      this.setStatus({ error: 'Another device runs a newer Helium Sync. This one updates itself from your server shortly.' });
    }
    for (const r of records) {
      const a = this.byColl.get(r.c);
      if (!a || (r.d && r.data === undefined)) continue;
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push({ coll: r.c, id: r.id, seq: r.s, deleted: !!r.x, data: r.data ?? null, device: r.dv });
    }
    for (const [a, list] of groups) {
      try {
        await a.applyRemote(list);
      } catch (e) {
        console.error('helium-sync: apply', a.colls, e);
      }
    }
  }
}

export function key(coll, id) {
  return coll + '\u0000' + id;
}
