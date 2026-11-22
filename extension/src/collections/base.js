// Base class for state-based collection adapters.
//
// An adapter keeps a model: the last state it agreed on with the server, one
// entry per record ({ id, seq, ...fields, plus local bookkeeping such as the
// browser's own id for the object}). Syncing is then two operations, always
// run one at a time under the adapter's lock:
//
//   scan()   read the browser state, diff it against the model, queue the
//            differences as writes and update the model
//   apply()  take remote records into the model and make the browser match
//
// Because apply() makes the browser equal to the model, the browser events it
// triggers lead to a scan that finds nothing to send: no echo, regardless of
// the order in which browser events and API callbacks arrive.
//
// Conflicts: every field carries its own version (a hybrid logical clock
// stamp plus device id, in `v`). Merging takes, per field, the value with the
// highest version, so concurrent edits of different fields both survive,
// merges commute, and a record written by a device that had not yet seen a
// newer change can never roll that change back. When a merge keeps newer
// local fields, the merged record is re-sent so the server converges too.

import * as db from '../lib/db.js';
import { b64url, randomBytes } from '../lib/crypto.js';

export function newId() {
  return b64url(randomBytes(16));
}

export class Adapter {
  constructor(coll, extraColls = []) {
    this.coll = coll;
    this.colls = [coll, ...extraColls];
    this.engine = null;
    this.model = new Map();
    this.init = false; // initial merge done
    this.enabled = false;
    this.lockp = Promise.resolve();
    this.timer = null;
    this.due = 0;
    this.dirty = [];
    this.loaded = null;
  }

  async load(engine) {
    this.engine = engine;
    this.enabled = true;
    this.loaded = (async () => {
      this.model = await db.modelLoad(this.coll);
      this.init = !!(await db.kvGet(this.coll + ':init'));
      await this.onLoad?.();
    })();
    await this.loaded;
  }

  /** Runs fn exclusively with other scans and applies. */
  exclusive(fn) {
    const p = this.lockp.then(fn);
    this.lockp = p.catch(() => {});
    return p;
  }

  /** Requests a scan within `delay` ms (earlier requests win). */
  schedule(delay = 100) {
    if (!this.enabled || !this.init) return;
    const due = Date.now() + delay;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scan().catch((e) => console.error('helium-sync: scan', this.coll, e));
    }, delay);
  }

  scan() {
    return this.exclusive(async () => {
      if (!this.enabled || !this.init) return;
      await this.doScan();
    });
  }

  applyRemote(records) {
    return this.exclusive(async () => {
      if (!this.enabled) return;
      if (this.init) await this.doScan();
      const accepted = [];
      const resend = [];
      for (const r of records) {
        for (const ver of Object.values(r.data?.v || {})) this.observe(ver);
        if (r.data?.dv) this.observe(r.data.dv);
        const cur = this.entry(r.coll, r.id);
        if (cur && r.seq && cur.seq && r.seq <= cur.seq) continue;
        const fields = this.mergeFields(r.coll);
        if (!fields) {
          if (this.engine.isPending(r.coll, r.id)) continue; // local wins
          accepted.push(r);
          continue;
        }
        if (r.deleted) {
          // A deletion loses against local edits made after it.
          if (cur && maxVersion(cur.v) > (r.data?.dv || '')) {
            resend.push([r.coll, r.id]);
            continue;
          }
          accepted.push(r);
          continue;
        }
        if (!cur) {
          accepted.push(r);
          continue;
        }
        const d = r.data || {};
        const out = {};
        const v = {};
        let remoteNewer = false;
        let localNewer = false;
        for (const f of fields) {
          const rv = d.v?.[f] || '';
          const lv = cur.v?.[f] || '';
          if (rv > lv) {
            out[f] = d[f];
            v[f] = rv;
            remoteNewer = true;
          } else {
            out[f] = cur[f];
            v[f] = lv;
            if (lv > rv) localNewer = true;
          }
        }
        if (localNewer) resend.push([r.coll, r.id]);
        if (remoteNewer) accepted.push({ ...r, data: { ...d, ...out, v } });
        else {
          cur.seq = r.seq;
          await this.persist([cur], [], r.coll);
        }
      }
      if (accepted.length) await this.doApply(accepted);
      for (const [coll, id] of resend) {
        const e = this.entry(coll, id);
        if (e && !this.engine.isPending(coll, id)) this.engine.write(coll, id, this.recordData(coll, e));
      }
    });
  }

  /** Fields with their own versions, per collection (null: whole-record). */
  mergeFields(coll) {
    return null;
  }

  /** The wire data of a model entry, including field versions. */
  recordData(coll, e) {
    // Fields from newer extension versions travel along untouched.
    const out = { ...(e.xtra || {}) };
    for (const f of this.mergeFields(coll) || []) if (e[f] !== undefined && e[f] !== null) out[f] = e[f];
    out.v = e.v || {};
    return out;
  }

  /** A new version stamp (hybrid logical clock). */
  tick() {
    const now = Date.now();
    this.clock = Math.max(now, (this.clock || 0) + 1);
    return this.clock.toString(36).padStart(9, '0') + '.' + (this.engine?.deviceId || this.engine?.session?.deviceId || '').slice(0, 8);
  }

  observe(ver) {
    const t = parseInt(String(ver).split('.')[0], 36);
    if (t > (this.clock || 0) && t < Date.now() + 864e5) this.clock = t;
  }

  /** Versions for `next`: fields that changed since `prev` get a new stamp. */
  stamp(coll, prev, next) {
    const v = { ...(prev?.v || {}) }; // keeps versions of fields we do not know
    for (const f of this.mergeFields(coll) || []) {
      const changed = !prev || (prev[f] ?? null) !== (next[f] ?? null);
      v[f] = changed ? this.tick() : prev.v?.[f] || '';
    }
    return v;
  }

  /** Queues a tombstone stamped so later local edits can win over it. */
  removeRecord(coll, id, extra = {}) {
    this.engine.remove(coll, id, { ...extra, dv: this.tick() });
  }

  onCaughtUp() {
    return this.exclusive(async () => {
      if (!this.enabled) return;
      if (!this.init) {
        await this.initialMerge();
        this.init = true;
        await db.kvSet(this.coll + ':init', true);
      } else {
        await this.doScan();
      }
      await this.afterCaughtUp?.();
    });
  }

  /** Model entry lookup; adapters with several collections override. */
  entry(coll, id) {
    return this.model.get(id);
  }

  /** Records the server sequence numbers of acknowledged writes. */
  onAck(list) {
    return this.exclusive(async () => {
      const byColl = new Map();
      for (const { coll, id, seq } of list) {
        const e = this.entry(coll, id);
        if (!e) continue;
        e.seq = seq;
        if (!byColl.has(coll)) byColl.set(coll, []);
        byColl.get(coll).push(e);
      }
      for (const [coll, puts] of byColl) await this.persist(puts, [], coll);
    });
  }

  async persist(puts, deletes = [], coll = this.coll) {
    await db.modelWrite(coll, puts, deletes);
  }

  async reset() {
    this.model.clear();
    this.init = false;
    await db.modelClear(this.coll);
    await db.kvDelete(this.coll + ':init');
  }

  async disable() {
    this.enabled = false;
    clearTimeout(this.timer);
    await this.exclusive(async () => {
      await this.onDisable?.();
      for (const c of this.colls) await db.modelClear(c);
      await db.kvDelete(this.coll + ':init');
      this.model.clear();
      this.init = false;
    });
  }

  stop() {
    this.enabled = false;
    clearTimeout(this.timer);
  }

  // Subclasses implement: doScan(), doApply(records), initialMerge()
}

/** Record fields this version does not know (written by newer versions). */
export function extras(d, known) {
  let out = null;
  for (const k of Object.keys(d || {})) {
    if (known.includes(k) || k === 'v') continue;
    (out ||= {})[k] = d[k];
  }
  return out;
}

export function maxVersion(v) {
  let m = '';
  for (const x of Object.values(v || {})) if (x > m) m = x;
  return m;
}

export function sameData(a, b, fields) {
  for (const f of fields) if ((a?.[f] ?? null) !== (b?.[f] ?? null)) return false;
  return true;
}
