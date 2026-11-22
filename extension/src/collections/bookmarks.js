// Bookmarks.
//
// Record "bm/<uid>": { p: parentUid, t: title, u?: url (absent for folders), o: order key }
// The permanent folders have the fixed uids "bar", "other" and "mobile" and are
// never written. Model entries add lid (the local bookmark id, or null while a
// record cannot be materialised yet, e.g. its parent has not arrived).

import { Adapter, extras, newId } from './base.js';
import { compareOrder, lis, reorder } from '../lib/order.js';

const ROOTS = { 'bookmarks-bar': 'bar', other: 'other', mobile: 'mobile' };
const LEGACY_ROOTS = { 1: 'bar', 2: 'other', 3: 'mobile' };

function rootUid(node) {
  if (node.folderType) return ROOTS[node.folderType] || null; // skips "managed"
  if (node.unmodifiable) return null;
  return LEGACY_ROOTS[node.id] || null;
}

function isRoot(uid) {
  return uid === 'bar' || uid === 'other' || uid === 'mobile';
}

async function readLocal() {
  const [root] = await chrome.bookmarks.getTree();
  const roots = new Map(); // uid -> lid
  const rootLids = new Map(); // lid -> uid
  const nodes = []; // parents before children, siblings in order
  const walk = (children, parentLid) => {
    for (const n of children || []) {
      nodes.push({ lid: n.id, parentLid, title: n.title || '', url: n.url, index: n.index });
      if (!n.url) walk(n.children, n.id);
    }
  };
  // Newer Chromium may list a permanent folder twice (local and account
  // storage, the latter with syncing: true). Use the local one; skip unknown
  // folder types added in future versions.
  const tops = [...(root.children || [])].sort((a, b) => (a.syncing === true) - (b.syncing === true));
  for (const top of tops) {
    const uid = rootUid(top);
    if (!uid || roots.has(uid)) continue;
    roots.set(uid, top.id);
    rootLids.set(top.id, uid);
    walk(top.children, top.id);
  }
  return { roots, rootLids, nodes };
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function dataOf(e) {
  const d = { p: e.p, t: e.t, o: e.o };
  if (e.u != null) d.u = e.u;
  return d;
}

function differs(a, b) {
  return a.p !== b.p || a.t !== b.t || (a.u ?? null) !== (b.u ?? null) || a.o !== b.o;
}

export class Bookmarks extends Adapter {
  constructor() {
    super('bm');
  }

  mergeFields() {
    return ['p', 't', 'u', 'o'];
  }

  schedule(delay) {
    this.events = (this.events || 0) + 1;
    super.schedule(delay);
  }

  async doScan() {
    const snapshot = await readLocal();
    // The apply that usually follows a scan can reuse this snapshot, as
    // long as no bookmark event arrived in between.
    this.snapshot = { ...snapshot, events: this.events };
    const { rootLids, nodes } = snapshot;
    const uidByLid = new Map();
    for (const e of this.model.values()) if (e.lid) uidByLid.set(e.lid, e.id);
    const present = new Set();
    const local = []; // { uid, lid, p, t, u }
    const siblings = new Map(); // parentUid -> [{ id, o }]
    for (const n of nodes) {
      const p = rootLids.get(n.parentLid) || uidByLid.get(n.parentLid);
      if (!p) continue; // inside an unsynced folder (cannot happen, defensive)
      let uid = uidByLid.get(n.lid);
      if (!uid) {
        uid = newId();
        uidByLid.set(n.lid, uid);
      }
      present.add(uid);
      local.push({ uid, lid: n.lid, p, t: n.title, u: n.url });
      if (!siblings.has(p)) siblings.set(p, []);
      const prev = this.model.get(uid);
      siblings.get(p).push({ id: uid, o: prev?.o });
    }
    const keys = new Map();
    for (const list of siblings.values()) {
      const changed = reorder(list);
      for (const it of list) keys.set(it.id, changed.get(it.id) ?? it.o);
    }

    const puts = [];
    const dels = [];
    for (const n of local) {
      const prev = this.model.get(n.uid);
      const next = { id: n.uid, lid: n.lid, p: n.p, t: n.t, u: n.u, o: keys.get(n.uid), seq: prev?.seq || 0, xtra: prev?.xtra };
      if (!prev || differs(prev, next) || prev.lid !== n.lid) {
        next.v = this.stamp('bm', prev, next);
        if (!prev || differs(prev, next)) this.engine.write('bm', n.uid, this.recordData('bm', next));
        this.model.set(n.uid, next);
        puts.push(next);
      }
    }
    for (const e of this.model.values()) {
      // Entries without a local node (lid null) were never materialised here.
      if (e.lid && !present.has(e.id)) {
        this.removeRecord('bm', e.id);
        dels.push(e.id);
      }
    }
    for (const id of dels) this.model.delete(id);
    await this.persist(puts, dels);
  }

  async doApply(records) {
    const removed = [];
    const puts = [];
    const dels = [];
    const touched = new Map(); // uid -> Set of fields the remote changed
    for (const r of records) {
      if (isRoot(r.id)) continue;
      const cur = this.model.get(r.id);
      if (r.deleted) {
        if (cur) {
          removed.push(cur);
          this.model.delete(r.id);
          dels.push(r.id);
        }
        continue;
      }
      const d = r.data || {};
      const e = { id: r.id, lid: cur?.lid ?? null, p: String(d.p || 'other'), t: String(d.t ?? ''), u: d.u == null ? undefined : String(d.u), o: d.o, v: d.v || {}, xtra: extras(d, ['p', 't', 'u', 'o']), seq: r.seq };
      const fields = touched.get(r.id) || new Set();
      for (const f of ['p', 't', 'u', 'o']) if (!cur || (cur[f] ?? null) !== (e[f] ?? null)) fields.add(f);
      touched.set(r.id, fields);
      this.model.set(r.id, e);
      puts.push(e);
    }
    await this.persist(puts, dels);
    if (this.init) await this.materialize(removed, touched);
  }

  /**
   * Makes the local tree match the model for the given records (all when
   * touched is null), plus any not yet materialised.
   */
  async materialize(removed = [], touched = null) {
    const fresh = this.snapshot && this.snapshot.events === this.events ? this.snapshot : null;
    this.snapshot = null;
    const { roots, nodes } = fresh || (await readLocal());
    const local = new Map(nodes.map((n) => [n.lid, n]));
    const done = new Map(); // uid -> lid (resolved this pass)
    const touchedParents = new Set();
    const changed = [];
    const visiting = new Set();

    const ensure = async (uid) => {
      if (roots.has(uid)) return roots.get(uid);
      if (done.has(uid)) return done.get(uid);
      const e = this.model.get(uid);
      if (!e || visiting.has(uid)) return null; // unknown parent or a cycle
      visiting.add(uid);
      const parentLid = await ensure(e.p);
      visiting.delete(uid);
      if (!parentLid) {
        done.set(uid, e.lid && local.has(e.lid) ? e.lid : null);
        return done.get(uid);
      }
      let node = e.lid ? local.get(e.lid) : null;
      const isFolder = e.u == null;
      if (node && !!node.url === isFolder) {
        // Type changed (bookmark <-> folder): recreate.
        await chrome.bookmarks.removeTree(node.lid).catch(() => {});
        local.delete(node.lid);
        node = null;
      }
      if (!node) {
        try {
          const created = await chrome.bookmarks.create({ parentId: parentLid, title: e.t, ...(isFolder ? {} : { url: e.u }) });
          e.lid = created.id;
          if (!isFolder) e.u = created.url; // keep Chromium's normalised form
          local.set(created.id, { lid: created.id, parentLid, title: created.title, url: created.url, index: created.index });
        } catch (err) {
          console.warn('helium-sync: create bookmark', e, err.message);
          e.lid = null;
        }
        changed.push(e);
      } else {
        // Three-way merge: apply only fields the remote changed; local edits
        // to other fields survive and are sent by the next scan.
        const fields = touched?.get(uid);
        const want = (f) => !touched || !!fields?.has(f);
        const upd = {};
        if (want('t') && node.title !== e.t) upd.title = e.t;
        if (want('u') && !isFolder && node.url !== e.u) upd.url = e.u;
        if (Object.keys(upd).length) {
          try {
            const res = await chrome.bookmarks.update(node.lid, upd);
            if (!isFolder) e.u = res.url;
            changed.push(e);
          } catch (err) {
            console.warn('helium-sync: update bookmark', err.message);
          }
        }
        if (want('p') && node.parentLid !== parentLid) {
          try {
            await chrome.bookmarks.move(node.lid, { parentId: parentLid });
            touchedParents.add(node.parentLid);
            node.parentLid = parentLid;
          } catch (err) {
            console.warn('helium-sync: move bookmark', err.message);
          }
        }
      }
      if (e.lid) touchedParents.add(parentLid);
      done.set(uid, e.lid);
      return e.lid;
    };

    const targets = [...this.model.values()].filter((e) => !touched || touched.has(e.id) || !e.lid);

    // Fast path for new bookmarks (initial sync, imports): create them wave
    // by wave (parents first), different folders in parallel and each
    // folder's children in order, so no reordering is needed afterwards.
    const exists = (e) => !!e.lid && local.has(e.lid);
    const created = new Map(); // uid -> lid
    const lidOf = (uid) => {
      if (roots.has(uid)) return roots.get(uid);
      if (created.has(uid)) return created.get(uid);
      const e = this.model.get(uid);
      return e && exists(e) ? e.lid : null;
    };
    let pending = targets.filter((e) => !exists(e));
    while (pending.length) {
      const ready = pending.filter((e) => lidOf(e.p));
      if (!ready.length) break; // orphans or cycles: left to ensure() below
      const byParent = new Map();
      for (const e of ready) {
        if (!byParent.has(e.p)) byParent.set(e.p, []);
        byParent.get(e.p).push(e);
      }
      await pool([...byParent], 16, async ([p, children]) => {
        const parentLid = lidOf(p);
        for (const e of children.sort(compareOrder)) {
          const isFolder = e.u == null;
          try {
            const node = await chrome.bookmarks.create({ parentId: parentLid, title: e.t, ...(isFolder ? {} : { url: e.u }) });
            e.lid = node.id;
            if (!isFolder) e.u = node.url; // keep Chromium's normalised form
            local.set(node.id, { lid: node.id, parentLid, title: node.title, url: node.url, index: node.index });
          } catch (err) {
            console.warn('helium-sync: create bookmark', err.message);
            e.lid = null;
          }
          created.set(e.id, e.lid);
          done.set(e.id, e.lid);
          changed.push(e);
        }
        touchedParents.add(parentLid);
      });
      const readySet = new Set(ready);
      pending = pending.filter((e) => !readySet.has(e));
    }

    for (const e of targets) await ensure(e.id);

    // Deletions after upserts, so children moved out of a deleted folder
    // survive.
    for (const e of removed) {
      if (!e.lid || !local.has(e.lid)) continue;
      const n = local.get(e.lid);
      try {
        if (n.url) await chrome.bookmarks.remove(e.lid);
        else await chrome.bookmarks.removeTree(e.lid);
      } catch {
        /* already gone */
      }
      touchedParents.add(n.parentLid);
    }

    // Only reposition what changed remotely, so a concurrent local move is
    // not undone (the next scan sends it).
    const focus = touched
      ? new Set([...touched].filter(([, f]) => f.has('o') || f.has('p')).map(([id]) => this.model.get(id)?.lid).filter(Boolean))
      : null;
    for (const parentLid of touchedParents) await this.order(parentLid, focus);
    // Entries whose node vanished (e.g. inside a deleted folder) are dropped
    // by the next scan, which also sends their tombstones.
    await this.persist(changed);
  }

  /** Reorders a folder's children to match the model's order keys. */
  async order(parentLid, focus = null) {
    let children;
    try {
      children = await chrome.bookmarks.getChildren(parentLid);
    } catch {
      return;
    }
    const byLid = new Map();
    for (const e of this.model.values()) if (e.lid) byLid.set(e.lid, e);
    const mapped = children.filter((c) => byLid.has(c.id)).map((c) => byLid.get(c.id));
    const desired = [...mapped].sort(compareOrder).map((e) => e.lid);
    const current = children.map((c) => c.id);
    const pos = new Map(current.map((lid, i) => [lid, i]));
    const keep = focus
      ? new Set(desired.filter((lid) => !focus.has(lid)))
      : new Set(lis(desired.map((lid) => pos.get(lid))).map((i) => desired[i]));
    for (let i = 0; i < desired.length; i++) {
      const lid = desired[i];
      if (keep.has(lid)) continue;
      // Place right after the previous desired item (or first).
      const from = current.indexOf(lid);
      current.splice(from, 1);
      const to = i === 0 ? 0 : current.indexOf(desired[i - 1]) + 1;
      current.splice(to, 0, lid);
      // bookmarks.move counts the index before removing the node.
      const index = from < to ? to + 1 : to;
      try {
        await chrome.bookmarks.move(lid, { parentId: parentLid, index });
      } catch (err) {
        console.warn('helium-sync: reorder bookmark', err.message);
      }
    }
  }

  /**
   * First sync on this device: match local bookmarks to records already on
   * the server by position in the tree (same parent, same title and URL), so
   * the same bookmarks on two devices are not duplicated. Unmatched local
   * bookmarks are uploaded; unmatched remote ones are created locally.
   */
  async initialMerge() {
    const { rootLids, nodes } = await readLocal();
    const remoteChildren = new Map(); // parentUid -> entries
    for (const e of this.model.values()) {
      e.lid = null;
      if (!remoteChildren.has(e.p)) remoteChildren.set(e.p, []);
      remoteChildren.get(e.p).push(e);
    }
    const claimed = new Set();
    const uidByLid = new Map();
    for (const n of nodes) {
      const p = rootLids.get(n.parentLid) || uidByLid.get(n.parentLid);
      if (!p) continue;
      const candidates = remoteChildren.get(p) || [];
      const match = candidates.find((e) => !claimed.has(e.id) && e.t === n.title && (e.u ?? null) === (n.url ?? null));
      if (match) {
        claimed.add(match.id);
        match.lid = n.lid;
        uidByLid.set(n.lid, match.id);
      } else {
        // A new local node: give it a uid now so its children can match
        // under it; the scan below uploads it.
        const uid = newId();
        uidByLid.set(n.lid, uid);
        const e = { id: uid, lid: n.lid, p, t: n.title, u: n.url, o: undefined, seq: 0, fresh: true };
        this.model.set(uid, e);
      }
    }
    // New local nodes go into the model only through the scan, which
    // assigns order keys relative to their (possibly remote) siblings.
    for (const [uid, e] of this.model) if (e.fresh) this.model.delete(uid);
    await this.persist([...this.model.values()]);
    // Create remote-only bookmarks locally, then fix order.
    await this.materialize();
    // Upload local-only bookmarks (and any order changes they cause).
    await this.doScanWithIds(uidByLid);
  }

  async doScanWithIds(uidByLid) {
    // Reuse uids picked during the merge so parents and children agree.
    const known = new Set([...this.model.values()].map((e) => e.lid));
    for (const [lid, uid] of uidByLid) {
      if (!known.has(lid) && !this.model.has(uid)) this.model.set(uid, { id: uid, lid, p: null, t: null, u: null, o: undefined, seq: 0 });
    }
    await this.doScan();
  }
}
