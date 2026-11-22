// Smaller collections: extensions, reading list, open tabs per device, and
// send-tab-to-device.

import { Adapter, newId } from './base.js';
import * as db from '../lib/db.js';
import { opaqueId } from '../lib/crypto.js';

// ---------------------------------------------------------------------------
// Extensions
//
// Record "ext/<HMAC(extensionId)>": { ext, n: name, e: enabled, ty: type, h: homepage }
// Extensions cannot install other extensions, so ones missing on this device
// are listed in the popup with a link to their store page. Model entries add
// `local` (installed here).

const STORE_TYPES = new Set(['extension', 'theme']);

export class Extensions extends Adapter {
  constructor() {
    super('ext');
    this.ridCache = new Map();
  }

  async rid(extId) {
    if (!this.ridCache.has(extId)) this.ridCache.set(extId, await opaqueId(this.engine.keys, 'ext:' + extId));
    return this.ridCache.get(extId);
  }

  async installed() {
    const all = await chrome.management.getAll();
    const self = chrome.runtime.id;
    return all.filter((x) => x.id !== self && x.installType === 'normal' && STORE_TYPES.has(x.type));
  }

  async doScan() {
    const local = await this.installed();
    const seen = new Set();
    const puts = [];
    const dels = [];
    for (const x of local) {
      const id = await this.rid(x.id);
      seen.add(id);
      const prev = this.model.get(id);
      const next = { id, ext: x.id, n: x.name, e: !!x.enabled, ty: x.type, h: x.homepageUrl || '', local: true, seq: prev?.seq || 0 };
      const same = prev && prev.ext === next.ext && prev.n === next.n && prev.e === next.e;
      if (!same) this.engine.write('ext', id, { ext: next.ext, n: next.n, e: next.e, ty: next.ty, h: next.h });
      if (!same || !prev.local) {
        this.model.set(id, next);
        puts.push(next);
      }
    }
    for (const e of [...this.model.values()]) {
      if (e.local && !seen.has(e.id)) {
        // Uninstalled here.
        this.model.delete(e.id);
        dels.push(e.id);
        this.engine.remove('ext', e.id);
      }
    }
    await this.persist(puts, dels);
  }

  async doApply(records) {
    const local = new Map((await chrome.management.getAll()).map((x) => [x.id, x]));
    const puts = [];
    const dels = [];
    const removedElsewhere = new Set((await db.kvGet('ext:removed')) || []);
    for (const r of records) {
      if (r.deleted) {
        const cur = this.model.get(r.id);
        if (cur) {
          if (cur.local) removedElsewhere.add(cur.ext);
          this.model.delete(r.id);
          dels.push(r.id);
        }
        continue;
      }
      const d = r.data || {};
      if (typeof d.ext !== 'string' || !/^[a-p]{32}$/.test(d.ext)) continue;
      const here = local.get(d.ext);
      const e = { id: r.id, ext: d.ext, n: String(d.n || d.ext), e: !!d.e, ty: d.ty || 'extension', h: String(d.h || ''), local: !!here, seq: r.seq };
      removedElsewhere.delete(d.ext);
      if (here && this.init && here.enabled !== e.e) {
        await chrome.management.setEnabled(d.ext, e.e).catch(() => {
          e.e = here.enabled; // e.g. needs new permissions; keep local state
        });
      }
      this.model.set(r.id, e);
      puts.push(e);
    }
    await db.kvSet('ext:removed', [...removedElsewhere]);
    await this.persist(puts, dels);
  }

  async initialMerge() {
    await this.doScan();
  }

  /** Extensions synced from other devices that are not installed here. */
  missing() {
    return [...this.model.values()].filter((e) => !e.local).map((e) => ({ id: e.ext, name: e.n, type: e.ty }));
  }

  async removedElsewhere() {
    const ids = (await db.kvGet('ext:removed')) || [];
    const local = new Map((await chrome.management.getAll()).map((x) => [x.id, x]));
    return ids.filter((id) => local.has(id)).map((id) => ({ id, name: local.get(id).name }));
  }

  async dismissRemoved(id) {
    const ids = ((await db.kvGet('ext:removed')) || []).filter((x) => x !== id);
    await db.kvSet('ext:removed', ids);
  }

  /** Stops offering an extension: forgets it on every device. */
  async forget(extId) {
    return this.exclusive(async () => {
      const id = await this.rid(extId);
      if (!this.model.has(id)) return;
      this.model.delete(id);
      await this.persist([], [id]);
      this.engine.remove('ext', id);
    });
  }
}

// ---------------------------------------------------------------------------
// Reading list
//
// Record "rl/<HMAC(url)>": { u, t: title, r: read, a: added (ms) }

export class ReadingList extends Adapter {
  constructor() {
    super('rl');
  }

  static supported() {
    return !!chrome.readingList;
  }

  async doScan() {
    const entries = await chrome.readingList.query({});
    const seen = new Set();
    const puts = [];
    const dels = [];
    for (const x of entries) {
      const id = await opaqueId(this.engine.keys, 'rl:' + x.url);
      seen.add(id);
      const prev = this.model.get(id);
      const next = { id, u: x.url, t: x.title, r: !!x.hasBeenRead, a: Math.round(x.creationTime || Date.now()), seq: prev?.seq || 0 };
      if (!prev || prev.t !== next.t || prev.r !== next.r || prev.u !== next.u) {
        this.model.set(id, next);
        puts.push(next);
        this.engine.write('rl', id, { u: next.u, t: next.t, r: next.r, a: next.a });
      }
    }
    for (const e of [...this.model.values()]) {
      if (!seen.has(e.id) && e.here !== false) {
        this.model.delete(e.id);
        dels.push(e.id);
        this.engine.remove('rl', e.id, { u: e.u });
      }
    }
    await this.persist(puts, dels);
  }

  async doApply(records) {
    const puts = [];
    const dels = [];
    for (const r of records) {
      const d = r.data || {};
      if (r.deleted) {
        const cur = this.model.get(r.id);
        const url = cur?.u || d.u;
        this.model.delete(r.id);
        dels.push(r.id);
        if (url && this.init) await chrome.readingList.removeEntry({ url }).catch(() => {});
        continue;
      }
      if (typeof d.u !== 'string') continue;
      const e = { id: r.id, u: d.u, t: String(d.t || d.u), r: !!d.r, a: Number(d.a) || Date.now(), seq: r.seq };
      this.model.set(r.id, e);
      puts.push(e);
      if (this.init) await this.materializeOne(e);
    }
    await this.persist(puts, dels);
  }

  async materializeOne(e) {
    const [cur] = await chrome.readingList.query({ url: e.u });
    try {
      if (!cur) await chrome.readingList.addEntry({ url: e.u, title: e.t, hasBeenRead: e.r });
      else if (cur.title !== e.t || cur.hasBeenRead !== e.r) await chrome.readingList.updateEntry({ url: e.u, title: e.t, hasBeenRead: e.r });
    } catch (err) {
      console.warn('helium-sync: reading list', err.message);
    }
  }

  async initialMerge() {
    for (const e of this.model.values()) await this.materializeOne(e);
    await this.doScan();
  }
}

// ---------------------------------------------------------------------------
// Open tabs on each device (like Chrome's "Tabs from other devices").
//
// Record "dev/<deviceId>": { n: device name, ts, w: [{ tabs: [{ u, t, p }] }] }

const SESSION_URL = /^(https?|ftp|file):/;

export class Sessions {
  constructor() {
    this.coll = 'dev';
    this.colls = ['dev'];
    this.enabled = false;
    this.devices = new Map();
    this.timer = null;
    this.lastJson = '';
  }

  async load(engine) {
    this.engine = engine;
    this.enabled = true;
    this.devices = await db.modelLoad('dev');
  }

  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.publish().catch(() => {}), 2000);
  }

  async publish() {
    if (!this.enabled || !this.engine.deviceId) return;
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const w = wins
      .filter((x) => !x.incognito)
      .map((x) => ({
        tabs: x.tabs
          .filter((t) => SESSION_URL.test(t.url || t.pendingUrl || ''))
          .slice(0, 300)
          .map((t) => ({ u: t.url || t.pendingUrl, t: (t.title || '').slice(0, 300), p: t.pinned || undefined })),
      }))
      .filter((x) => x.tabs.length);
    const json = JSON.stringify(w);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.engine.write('dev', this.engine.deviceId, { n: this.engine.session.deviceName, ts: Date.now(), w });
  }

  async applyRemote(records) {
    const puts = [];
    const dels = [];
    for (const r of records) {
      if (r.id === this.engine.deviceId) continue;
      if (r.deleted) {
        this.devices.delete(r.id);
        dels.push(r.id);
      } else if (r.data) {
        const e = { id: r.id, ...r.data, seq: r.seq };
        this.devices.set(r.id, e);
        puts.push(e);
      }
    }
    await db.modelWrite('dev', puts, dels);
  }

  onCaughtUp() {
    this.lastJson = '';
    this.schedule();
  }

  onAck() {}

  list() {
    return [...this.devices.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  async disable() {
    this.enabled = false;
    if (this.engine?.deviceId) this.engine.remove('dev', this.engine.deviceId);
    await db.modelClear('dev');
    this.devices.clear();
  }

  stop() {
    this.enabled = false;
  }
}

// ---------------------------------------------------------------------------
// Send tab to device
//
// Record "st/<random>": { to: deviceId, u, t, from: device name, ts }
// The receiving device opens the tab and deletes the record.

const SEND_TTL = 7 * 864e5;

export class SendTab {
  constructor() {
    this.coll = 'st';
    this.colls = ['st'];
    this.enabled = false;
    this.handled = new Set();
  }

  async load(engine) {
    this.engine = engine;
    this.enabled = true;
  }

  async applyRemote(records) {
    for (const r of records) {
      if (r.deleted || !r.data || this.handled.has(r.id)) continue;
      const d = r.data;
      if (d.to !== this.engine.deviceId) continue;
      this.handled.add(r.id);
      this.engine.remove('st', r.id);
      if (Date.now() - (d.ts || 0) > SEND_TTL || typeof d.u !== 'string' || !/^(https?|ftp):/.test(d.u)) continue;
      const tab = await chrome.tabs.create({ url: d.u, active: false }).catch(() => null);
      if (tab) {
        chrome.notifications
          ?.create('st:' + tab.id, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
            title: `Tab from ${d.from || 'another device'}`,
            message: d.t || d.u,
            contextMessage: new URL(d.u).host,
          })
          .catch?.(() => {});
      }
    }
  }

  send(to, url, title) {
    this.engine.write('st', newId(), { to, u: url, t: title || '', from: this.engine.session.deviceName, ts: Date.now() });
  }

  onAck() {}
  onCaughtUp() {}
  async disable() {
    this.enabled = false;
  }
  stop() {
    this.enabled = false;
  }
}
