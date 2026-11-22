// History.
//
// Record "h/<HMAC(url)>": { u: url, t: title, v: last visit (ms), n: visit count }
// Record "h/clear": { before: ms } — "clear all history" on some device.
// Tombstones carry { u } so other devices know which URL to delete.
//
// Chromium's extension API can only add a visit "now" (history.addUrl takes
// no title or time), so visits from other devices are added to local history
// only while they are fresh. Everything synced is kept in an encrypted-at-rest
// archive (IndexedDB) that the extension's History page searches.

import * as db from '../lib/db.js';
import { opaqueId } from '../lib/crypto.js';

const FRESH_MS = 30 * 60 * 1000;
const BACKFILL_DAYS = 90;
const SYNCABLE = /^(https?|ftp):/;

export class History {
  constructor() {
    this.coll = 'h';
    this.colls = ['h'];
    this.enabled = false;
    this.suppressAdd = new Map(); // url -> until
    this.suppressDel = new Map();
    this.pending = new Map(); // url -> HistoryItem
    this.timer = null;
  }

  async load(engine) {
    this.engine = engine;
    this.enabled = true;
    this.init = !!(await db.kvGet('h:init'));
    this.lastClear = (await db.kvGet('h:clear')) || 0;
  }

  status() {
    return { backfilled: this.init };
  }

  /**
   * Visits we add for other devices come back as onVisited events; how many
   * and when differs between Chromium versions, so ignore every visit to such
   * a URL for a while instead of exactly one event.
   */
  echoing(map, url) {
    const until = map.get(url);
    if (until && until > Date.now()) return true;
    if (until) map.delete(url);
    if (map.size > 5000) for (const [k, t] of map) if (t <= Date.now()) map.delete(k);
    return false;
  }

  onVisited(item) {
    if (!this.enabled || !SYNCABLE.test(item.url)) return;
    if (this.echoing(this.suppressAdd, item.url)) return;
    this.pending.set(item.url, item);
    // Give the page a moment to set its title.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushVisits(), 2500);
  }

  async flushVisits() {
    const items = [...this.pending.values()];
    this.pending.clear();
    if (!items.length || !this.enabled) return;
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const titles = new Map(tabs.map((t) => [t.url, t.title]));
    for (const it of items) {
      if (this.echoing(this.suppressAdd, it.url)) continue;
      const id = await opaqueId(this.engine.keys, 'h:' + it.url);
      this.engine.write('h', id, { u: it.url, t: it.title || titles.get(it.url) || '', v: Math.round(it.lastVisitTime || Date.now()), n: it.visitCount || 1 });
    }
  }

  async onVisitRemoved(removed) {
    if (!this.enabled) return;
    if (removed.allHistory) {
      if (this.echoing(this.suppressDel, '*')) return;
      const before = Date.now();
      this.lastClear = before;
      await db.kvSet('h:clear', before);
      this.engine.write('h', 'clear', { before });
      return;
    }
    for (const url of removed.urls || []) {
      if (this.echoing(this.suppressDel, url)) continue;
      if (!SYNCABLE.test(url)) continue;
      const id = await opaqueId(this.engine.keys, 'h:' + url);
      this.engine.remove('h', id, { u: url });
      await db.histDelete([id]);
    }
  }

  async applyRemote(records) {
    if (!this.enabled) return;
    const archive = [];
    const gone = [];
    for (const r of records) {
      if (this.engine.isPending('h', r.id)) continue;
      const d = r.data || {};
      if (r.id === 'clear') {
        const before = Number(d.before) || 0;
        if (before > this.lastClear) {
          this.lastClear = before;
          await db.kvSet('h:clear', before);
          this.suppressDel.set('*', Date.now() + 30_000);
          await chrome.history.deleteRange({ startTime: 0, endTime: before }).catch(() => {});
          await db.histClear(before);
        }
        continue;
      }
      if (typeof d.u !== 'string') continue;
      if (r.deleted) {
        gone.push(r.id);
        this.suppressDel.set(d.u, Date.now() + 30_000);
        await chrome.history.deleteUrl({ url: d.u }).catch(() => {});
        continue;
      }
      const v = Number(d.v) || 0;
      if (v <= this.lastClear) continue;
      archive.push({ id: r.id, u: d.u, t: String(d.t || ''), v, dv: r.device || '' });
      if (r.device !== this.engine.deviceId && Date.now() - v < FRESH_MS && SYNCABLE.test(d.u)) {
        this.suppressAdd.set(d.u, Date.now() + 30_000);
        await chrome.history.addUrl({ url: d.u }).catch(() => {});
      }
    }
    await db.histPut(archive);
    await db.histDelete(gone);
  }

  async onCaughtUp() {
    if (this.init || this.backfilling) return;
    // Upload recent local history once, in the background, without flooding
    // the outbox.
    this.backfilling = (async () => {
      const items = await chrome.history.search({ text: '', startTime: Date.now() - BACKFILL_DAYS * 864e5, maxResults: 100_000 });
      for (let i = 0; i < items.length && this.enabled; i++) {
        const it = items[i];
        if (!SYNCABLE.test(it.url)) continue;
        while (this.engine.outboxSize() > 2000 && this.enabled) await new Promise((r) => setTimeout(r, 200));
        const id = await opaqueId(this.engine.keys, 'h:' + it.url);
        if (!this.engine.isPending('h', id)) this.engine.write('h', id, { u: it.url, t: it.title || '', v: Math.round(it.lastVisitTime || 0), n: it.visitCount || 1 });
      }
      if (this.enabled) {
        this.init = true;
        await db.kvSet('h:init', true);
      }
    })().finally(() => {
      this.backfilling = null;
    });
  }

  onAck() {}

  async reset() {
    this.init = false;
    await db.kvDelete('h:init');
  }

  async disable() {
    this.enabled = false;
    await db.kvDelete('h:init');
    await db.histClear();
  }

  stop() {
    this.enabled = false;
  }
}
