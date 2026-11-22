// Live tabs: Arc-style realtime mirroring of one window per device.
//
// Records:
//   lt/<uid>   { u: url, t: title, pin: bool, g: groupUid|null, o: order key }
//   lt/_cfg    { mode: 'all' | 'arc' }   account-wide: 'all' mirrors every tab
//              of the synced window, 'arc' only pinned and grouped tabs
//   lg/<uid>   { t: title, c: color, x: collapsed }
// A tab tombstone with data { k: 1 } means "stop syncing, leave it open".
//
// Each device mirrors exactly one normal window (the synced window). Browser
// tab ids do not survive restarts, so tab<->record mappings live in
// chrome.storage.session; after a restart tabs are matched again by URL once
// session restore has settled. A window closing (or the browser quitting)
// detaches the device instead of deleting tabs.

import { Adapter, extras, newId } from './base.js';
import { compareOrder, keyBetween, lis, reorder } from '../lib/order.js';
import * as db from '../lib/db.js';

const CFG = '_cfg';
// Group colours this browser supports (the enum grows over Chromium versions).
const COLORS = new Set(Object.values(globalThis.chrome?.tabGroups?.Color || {}).length ? Object.values(chrome.tabGroups.Color) : ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
// Blank and New Tab pages are not synced until they navigate somewhere.
const SYNCABLE = /^(https?|ftp|file):|^chrome:\/\/(history|bookmarks|settings|downloads|extensions)\b/;
const GUARD_MS = 30_000;

// Optional in some Chromium builds/forks: without them live tabs still work,
// just without groups or lazy loading.
const hasGroups = () => !!(chrome.tabGroups?.query && chrome.tabs.group);

// Chromium major version (the reduced user agent still carries it).
export const CHROMIUM = Number((globalThis.navigator?.userAgent || '').match(/Chrome\/(\d+)/)?.[1]) || 0;
// Discarding a freshly loaded background tab brings the whole browser down
// on Chromium <= 155 (tested 120-155); fine from 156 (tested 156-159). Lazy
// loading is only used where it is known to be safe.
export const canDiscard = () => !!chrome.tabs.discard && CHROMIUM >= 156;
const queryGroups = (windowId) => (hasGroups() ? chrome.tabGroups.query({ windowId }).catch(() => []) : Promise.resolve([]));

function rawUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

export class LiveTabs extends Adapter {
  constructor() {
    super('lt', ['lg']);
    this.groups = new Map(); // group model
    this.mode = 'all';
    this.lazy = true;
    this.win = null;
    this.tabUid = new Map(); // tabId -> uid
    this.groupUid = new Map(); // groupId -> uid
    this.alias = new Map(); // tabId -> url it landed on after we navigated it
    this.guard = new Map(); // tabId -> { url, until } while our navigation loads
    this.applied = new Map(); // tabId -> record URL we last navigated it to
    this.discardQueue = new Set();
    this.removedIds = new Set(); // tab ids reported closed by tabs.onRemoved
    this.vanished = new Map(); // tabId -> time it disappeared without onRemoved
    this.unmatched = new Map(); // tabId -> first time seen without a mapping
    this.healTries = new Map(); // uid -> { n, at } re-apply attempts
    // What each synced tab looked like right after the last sync (apply or
    // scan). A user edit is a difference from this, not from the model: the
    // model may hold state this browser could not apply yet (e.g. a group
    // whose record has not arrived), which must not be mistaken for an edit.
    this.seen = new Map(); // uid -> { u, pin, g }
    // Tabs whose current URL was opened on this device. Only they report
    // titles, so devices never fight over titles (loading placeholders,
    // unread counts…).
    this.authored = new Set();
    this.closing = false;
    this.attaching = null;
    this.needsAttach = false;
  }

  entry(coll, id) {
    return coll === 'lg' ? this.groups.get(id) : this.model.get(id);
  }

  mergeFields(coll) {
    return coll === 'lg' ? ['t', 'c', 'x'] : ['u', 't', 'pin', 'g', 'o'];
  }

  async onLoad() {
    this.groups = await db.modelLoad('lg');
    // Tabs deleted remotely; a restored session may bring them back.
    this.graveyard = (await db.kvGet('lt:graveyard')) || [];
    const cfg = this.model.get(CFG);
    if (cfg) {
      this.mode = cfg.mode === 'arc' ? 'arc' : 'all';
      this.model.delete(CFG);
      this.cfgSeq = cfg.seq;
    }
    const { lazy } = (await chrome.storage.local.get('liveTabsLazy')) || {};
    this.lazy = lazy !== false;
    const { liveTabs } = await chrome.storage.session.get('liveTabs');
    if (liveTabs?.win != null) {
      try {
        const w = await chrome.windows.get(liveTabs.win);
        if (w) {
          this.win = liveTabs.win;
          this.tabUid = new Map(liveTabs.tabUid);
          this.groupUid = new Map(liveTabs.groupUid);
          this.alias = new Map(liveTabs.alias || []);
          this.seen = new Map(liveTabs.seen || []);
          this.authored = new Set(liveTabs.authored || []);
        }
      } catch {
        /* window gone */
      }
    }
    // No mapping in this browser session (fresh start): attach once session
    // restore has finished opening tabs.
    this.needsAttach = this.win == null && !liveTabs?.detached;
    if (this.needsAttach && this.init) {
      this.startupAttach().catch((e) => console.error('helium-sync: attach', e));
    }
  }

  async saveSession(extra = {}) {
    await chrome.storage.session.set({
      liveTabs: { win: this.win, tabUid: [...this.tabUid], groupUid: [...this.groupUid], alias: [...this.alias], seen: [...this.seen], authored: [...this.authored], ...extra },
    });
  }

  status() {
    return { win: this.win, mode: this.mode, tabs: this.model.size, groups: this.groups.size, lazy: this.lazy && canDiscard(), lazyAvailable: canDiscard(), chromium: CHROMIUM };
  }

  // -------------------------------------------------------------------------
  // Which tabs are synced

  syncable(tab) {
    if (tab.incognito) return false;
    const u = rawUrl(tab);
    // Unloaded tabs can have an empty URL; they stay synced if mapped.
    return u === '' ? this.tabUid.has(tab.id) : SYNCABLE.test(u);
  }

  inSet(tab) {
    return tab.windowId === this.win && this.syncable(tab) && (this.mode === 'all' || tab.pinned || tab.groupId !== -1);
  }

  /**
   * The URL to sync for a tab. After we navigate a tab to a record's URL,
   * the page may redirect elsewhere (login pages, locale redirects…); that
   * must not be synced back, or devices would fight. Redirects are told apart
   * from user navigation with webNavigation's transition qualifiers.
   */
  effectiveUrl(tab, uid) {
    const raw = rawUrl(tab);
    const e = uid ? this.model.get(uid) : null;
    if (!e) return raw;
    const g = this.guard.get(tab.id);
    if (g) {
      if (Date.now() < g.until) return e.u;
      this.guard.delete(tab.id);
    }
    if (!raw || raw === this.alias.get(tab.id)) return e.u;
    this.alias.delete(tab.id);
    return raw;
  }

  onCommitted(d) {
    const g = this.guard.get(d.tabId);
    if (!g) return;
    const redirect = (d.transitionQualifiers || []).some((q) => q === 'server_redirect' || q === 'client_redirect');
    if (d.url === g.url) {
      // Our navigation landed; watch briefly for a client-side redirect.
      g.until = Date.now() + 3000;
    } else if (redirect) {
      this.alias.set(d.tabId, d.url);
      g.until = Math.max(g.until, Date.now() + 3000);
    } else {
      // The user went somewhere else: sync it.
      this.guard.delete(d.tabId);
      this.alias.delete(d.tabId);
      this.schedule(60);
    }
  }

  // -------------------------------------------------------------------------
  // Browser events (forwarded from background.js)

  onTabRemoved(tabId, info) {
    this.removedIds.add(tabId);
    if (info?.isWindowClosing && info.windowId === this.win) {
      // Closing the window is not the same as closing its tabs.
      this.closing = true;
      setTimeout(() => {
        this.closing = false;
      }, 5000);
      return;
    }
    this.schedule(25);
  }

  onTabReplaced(added, removed) {
    this.unmatched.delete(added);
    for (const m of [this.tabUid, this.alias, this.guard, this.applied]) {
      if (m.has(removed)) {
        m.set(added, m.get(removed));
        m.delete(removed);
      }
    }
    this.schedule(60);
  }

  onTabUpdated(tabId, change, tab) {
    // Discard lazily created tabs once their URL has committed (discarding
    // earlier loses the URL).
    if (this.discardQueue.has(tabId) && !this.materializing) this.tryDiscard(tab);
    if ('title' in change && Object.keys(change).length <= 2) this.schedule(1500);
    else if ('url' in change || 'pinned' in change || 'groupId' in change || change.status === 'complete') this.schedule(25);
  }

  tryDiscard(tab) {
    if (!canDiscard() || !tab.url || tab.pendingUrl || tab.active || tab.status === 'unloaded') return;
    this.discardQueue.delete(tab.id);
    chrome.tabs
      .discard(tab.id)
      .then((nt) => nt && nt.id !== tab.id && this.onTabReplaced(nt.id, tab.id))
      .catch(() => {});
  }

  onWindowRemoved(windowId) {
    if (windowId !== this.win) return;
    this.exclusive(async () => {
      this.detach();
      await this.saveSession({ detached: true });
    });
  }

  async onWindowCreated(win) {
    if (this.win != null || !this.enabled || !this.init || win.type !== 'normal' || win.incognito) return;
    // Re-attach automatically only when this is the only normal window, so
    // opening a second window never fills it with synced tabs.
    const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (all.filter((w) => !w.incognito).length === 1) {
      // restart: Helium re-creates pins in new windows at their pinned URL.
      setTimeout(() => this.attachTo(win.id, { restart: true }), 1500);
    }
  }

  detach() {
    this.win = null;
    this.seen.clear();
    this.applied.clear();
    this.tabUid.clear();
    this.groupUid.clear();
    this.alias.clear();
    this.guard.clear();
    this.closing = false;
  }

  // -------------------------------------------------------------------------
  // Attaching a window

  /** Waits for session restore to stop opening tabs, then attaches. */
  async startupAttach() {
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      let last = Date.now();
      const bump = () => {
        last = Date.now();
      };
      chrome.tabs.onCreated.addListener(bump);
      const started = Date.now();
      while (Date.now() - last < 1500 && Date.now() - started < 8000) await sleep(250);
      chrome.tabs.onCreated.removeListener(bump);
      // Prefer the restored window. If none of our tabs is open anywhere yet
      // (restore still running, or a window opened before it), wait a while
      // rather than attach to an unrelated window.
      let pick = await this.pickWindow();
      while (this.model.size && pick && !pick.matches && Date.now() - started < 20000) {
        await sleep(500);
        pick = await this.pickWindow();
      }
      if (pick) await this.attachTo(pick.id, { restart: true });
    })().finally(() => {
      this.attaching = null;
    });
    return this.attaching;
  }

  /** The normal window whose tabs best match the model. */
  async pickWindow() {
    const wins = (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter((w) => !w.incognito);
    if (!wins.length) return null;
    const urls = new Set([...this.model.values()].map((e) => e.u));
    let best = null;
    let score = -1;
    for (const w of wins) {
      const matches = w.tabs.filter((t) => urls.has(rawUrl(t))).length;
      const s = matches * 10 + (w.focused ? 1 : 0);
      if (s > score) {
        score = s;
        best = { ...w, matches };
      }
    }
    return best;
  }

  attachTo(windowId, { restart = false } = {}) {
    return this.exclusive(async () => {
      if (!this.enabled) return;
      this.needsAttach = false;
      await this.attach(windowId, { restart });
      if (this.init) {
        // Before catch-up the model may be stale; creating its tabs waits
        // until afterCaughtUp().
        if (this.engine.live) await this.materialize();
        await this.doScan();
      }
    });
  }

  /** Maps the window's tabs to model records. Does not change any tab. */
  async attach(windowId, { restart }) {
    this.detach();
    this.win = windowId;
    const tabs = (await chrome.tabs.query({ windowId })).filter((t) => this.inSet(t));
    const free = [...this.model.values()].sort(compareOrder);
    const take = (pred) => {
      for (const t of tabs) {
        if (this.tabUid.has(t.id)) continue;
        const i = free.findIndex((e) => pred(t, e));
        if (i >= 0) {
          this.tabUid.set(t.id, free[i].id);
          free.splice(i, 1);
        }
      }
    };
    take((t, e) => e.u === rawUrl(t) && !!e.pin === t.pinned);
    take((t, e) => e.u === rawUrl(t));
    if (restart) {
      // Restored pins may come back at their original address rather than
      // where they had navigated to; pair the remaining pins by position.
      take((t, e) => t.pinned && e.pin);
      // Tabs restored from the last session whose records were deleted on
      // another device while this one was off are closed, not re-uploaded.
      const close = [];
      for (const t of tabs) {
        if (this.tabUid.has(t.id)) continue;
        const i = this.graveyard.findIndex((g) => g.u === rawUrl(t) && g.pin === !!t.pinned);
        if (i >= 0) {
          this.graveyard.splice(i, 1);
          close.push(t);
        }
      }
      for (const t of close) {
        if (t.pinned) await chrome.tabs.update(t.id, { pinned: false }).catch(() => {});
        await chrome.tabs.remove(t.id).catch(() => {});
        tabs.splice(tabs.indexOf(t), 1);
      }
      if (close.length) await db.kvSet('lt:graveyard', this.graveyard);
    }
    // Groups: by title and colour, else by what their tabs map to.
    const groups = await queryGroups(windowId);
    const freeGroups = [...this.groups.values()];
    for (const g of groups) {
      let i = freeGroups.findIndex((e) => e.t === g.title && e.c === g.color);
      if (i < 0) {
        const votes = new Map();
        for (const t of tabs) if (t.groupId === g.id) {
          const e = this.model.get(this.tabUid.get(t.id));
          if (e?.g) votes.set(e.g, (votes.get(e.g) || 0) + 1);
        }
        const best = [...votes].sort((a, b) => b[1] - a[1])[0];
        i = best ? freeGroups.findIndex((e) => e.id === best[0]) : -1;
      }
      if (i >= 0) {
        this.groupUid.set(g.id, freeGroups[i].id);
        freeGroups.splice(i, 1);
      }
    }
    // Restored or pre-existing state of matched tabs is not a user edit: the
    // model (and whatever changed remotely meanwhile) wins for them.
    for (const t of tabs) {
      const uid = this.tabUid.get(t.id);
      if (uid) this.seen.set(uid, this.observe(t, uid));
    }
    await this.saveSession();
  }

  // -------------------------------------------------------------------------
  // Scan: browser -> model

  async doScan() {
    if (this.win == null || this.closing) return;
    let win;
    try {
      win = await chrome.windows.get(this.win, { populate: true });
    } catch {
      this.detach();
      await this.saveSession({ detached: true });
      return;
    }
    const tabs = (win.tabs || []).sort((a, b) => a.index - b.index);
    const localGroups = await queryGroups(this.win);

    // Groups present locally.
    const liveGroupIds = new Set(localGroups.map((g) => g.id));
    for (const gid of [...this.groupUid.keys()]) if (!liveGroupIds.has(gid)) this.groupUid.delete(gid);
    const mappedGroupUids = new Set(this.groupUid.values());
    for (const g of localGroups) {
      if (this.groupUid.has(g.id)) continue;
      const match = [...this.groups.values()].find((e) => !mappedGroupUids.has(e.id) && e.t === g.title && e.c === g.color);
      const uid = match ? match.id : newId();
      this.groupUid.set(g.id, uid);
      mappedGroupUids.add(uid);
    }

    // Tabs.
    const synced = tabs.filter((t) => this.inSet(t));
    const syncedIds = new Set(synced.map((t) => t.id));
    const taken = new Set(); // uids mapped to a live synced tab
    for (const [tabId, uid] of this.tabUid) if (syncedIds.has(tabId)) taken.add(uid);
    const waiting = new Set();
    for (const t of synced) {
      if (this.tabUid.has(t.id)) continue;
      // An unmapped tab may be one we just created, or a tab replaced
      // (discarded/prerendered) under a new id: match a record whose tab is gone.
      const url = rawUrl(t);
      const match = url && [...this.model.values()].find((e) => !taken.has(e.id) && e.u === url && !!e.pin === t.pinned);
      if (!match && url && [...this.model.values()].some((e) => e.u === url)) {
        // Same URL as a tab we track: probably a replacement whose old tab
        // has not gone yet. Give tabs.onReplaced a moment before treating it
        // as new.
        const since = this.unmatched.get(t.id) ?? Date.now();
        this.unmatched.set(t.id, since);
        if (Date.now() - since < 1500) {
          waiting.add(t.id);
          this.schedule(300);
          continue;
        }
      }
      this.unmatched.delete(t.id);
      const uid = match ? match.id : newId();
      if (match) for (const [tid, u] of [...this.tabUid]) if (u === uid) this.tabUid.delete(tid);
      this.tabUid.set(t.id, uid);
      taken.add(uid);
    }
    if (waiting.size) {
      for (let i = synced.length - 1; i >= 0; i--) if (waiting.has(synced[i].id)) synced.splice(i, 1);
    }
    if (this.unmatched.size > 200) this.unmatched.clear();

    const heal = new Set();
    // Tabs whose model key does not fit the local order get new keys; the
    // rest keep theirs. Every device applies the same constraints (pinned
    // first, groups contiguous), so this converges after one round.
    const order = reorder(synced.map((t) => ({ id: this.tabUid.get(t.id), o: this.model.get(this.tabUid.get(t.id))?.o })));
    const puts = [];
    const dels = [];
    const usedGroups = new Set();
    for (const t of synced) {
      const uid = this.tabUid.get(t.id);
      const prev = this.model.get(uid);
      const lg = !t.pinned && t.groupId !== -1 ? this.groupUid.get(t.groupId) || null : null;
      if (lg) usedGroups.add(t.groupId);
      const local = { u: this.effectiveUrl(t, uid), pin: !!t.pinned, g: lg };
      if (!local.u && !prev) continue; // nothing known yet
      const seen = this.seen.get(uid);
      // Unchanged since the last sync: keep the model's value.
      const pick = (f) => (prev && (!local[f] && f === 'u' ? true : seen && seen[f] === local[f]) ? prev[f] : local[f]);
      const u = pick('u');
      const pin = pick('pin');
      const g = pick('g');
      // The browser differs from the model without a user edit: something we
      // applied did not take (e.g. the tab was replaced mid-apply, or its
      // group arrived later). Re-apply it, a few times at most.
      if (prev && local.u && (pin !== local.pin || (g ?? null) !== (local.g ?? null))) heal.add(uid);
      this.seen.set(uid, local);
      const urlChanged = !prev || u !== prev.u;
      if (urlChanged) this.authored.add(uid);
      // Titles of loading, unloaded or just-navigated tabs are placeholders.
      const settled = t.status === 'complete' && !t.discarded && !(this.guard.get(t.id)?.until > Date.now());
      let title = prev?.t ?? '';
      if (urlChanged) title = settled ? t.title || '' : '';
      else if (this.authored.has(uid) && settled && t.title) title = t.title;
      const next = { id: uid, u, t: title, pin, g, o: order.get(uid) ?? prev?.o, seq: prev?.seq || 0, xtra: prev?.xtra };
      if (!next.o) next.o = keyAfterLast(this.model);
      if (!prev || prev.u !== next.u || prev.t !== next.t || !!prev.pin !== next.pin || (prev.g ?? null) !== next.g || prev.o !== next.o) {
        next.v = this.stamp('lt', prev, next);
        this.model.set(uid, next);
        puts.push(next);
        this.engine.write('lt', uid, this.recordData('lt', next));
      }
    }
    // Mapped tabs that are gone or left the set (closed, moved to another
    // window, unpinned/ungrouped in arc mode) are deleted everywhere. A tab
    // that vanished without tabs.onRemoved was replaced (discarded or
    // prerendered) and its successor is matched above, or shortly.
    const inWindow = new Set(tabs.map((t) => t.id));
    for (const [tabId, uid] of [...this.tabUid]) {
      if (syncedIds.has(tabId)) continue;
      if (!inWindow.has(tabId) && !this.removedIds.has(tabId) && !taken.has(uid)) {
        const exists = await chrome.tabs.get(tabId).then(() => true, () => false);
        if (!exists) {
          const since = this.vanished.get(tabId) ?? Date.now();
          this.vanished.set(tabId, since);
          if (Date.now() - since < 3000) {
            this.schedule(500);
            continue;
          }
        }
      }
      this.vanished.delete(tabId);
      this.removedIds.delete(tabId);
      this.tabUid.delete(tabId);
      if (!taken.has(uid) && this.model.has(uid)) {
        this.model.delete(uid);
        dels.push(uid);
        this.removeRecord('lt', uid);
      }
    }
    if (this.removedIds.size > 1000) this.removedIds.clear();
    await this.persist(puts, dels);

    // Groups that hold synced tabs.
    const gputs = [];
    const gdels = [];
    const usedUids = new Set();
    for (const g of localGroups) {
      if (!usedGroups.has(g.id)) continue;
      const uid = this.groupUid.get(g.id);
      usedUids.add(uid);
      const prev = this.groups.get(uid);
      // Shown as grey because this browser lacks the colour: not an edit.
      const color = g.color === 'grey' && prev && !COLORS.has(prev.c) ? prev.c : g.color;
      const next = { id: uid, t: g.title || '', c: color, x: !!g.collapsed, seq: prev?.seq || 0, xtra: prev?.xtra };
      if (!prev || prev.t !== next.t || prev.c !== next.c || !!prev.x !== next.x) {
        next.v = this.stamp('lg', prev, next);
        this.groups.set(uid, next);
        gputs.push(next);
        this.engine.write('lg', uid, this.recordData('lg', next));
      }
    }
    for (const e of [...this.groups.values()]) {
      const referenced = [...this.model.values()].some((t) => t.g === e.id);
      if (!usedUids.has(e.id) && !referenced) {
        this.groups.delete(e.id);
        gdels.push(e.id);
        this.removeRecord('lg', e.id);
      }
    }
    await this.persist(gputs, gdels, 'lg');
    await this.saveSession();
    if (heal.size) {
      const now = Date.now();
      const due = new Map();
      for (const uid of heal) {
        const h = this.healTries.get(uid) || { n: 0, at: 0 };
        if (now - h.at > 30_000) h.n = 0;
        if (h.n >= 3) continue;
        this.healTries.set(uid, { n: h.n + 1, at: now });
        due.set(uid, new Set(['pin', 'g', 'o']));
      }
      if (due.size) await this.materialize({ tabs: due, groups: new Set(), heal: true });
    }
  }

  // -------------------------------------------------------------------------
  // Apply: model -> browser

  async doApply(records) {
    const puts = [];
    const dels = [];
    const gputs = [];
    const gdels = [];
    const keepOpen = new Set();
    const touched = new Map(); // uid -> Set of fields the remote changed
    const touchedGroups = new Set();
    for (const r of records) {
      if (r.coll === 'lt' && r.id === CFG) {
        const mode = r.data?.mode === 'arc' ? 'arc' : 'all';
        this.cfgSeq = r.seq;
        await this.persist([{ id: CFG, mode, seq: r.seq }]);
        if (mode !== this.mode) await this.switchMode(mode, false);
        continue;
      }
      if (r.coll === 'lg') {
        if (r.deleted) {
          if (this.groups.delete(r.id)) gdels.push(r.id);
        } else {
          const d = r.data || {};
          // Unknown colours (added in newer Chromium) are kept; applying one
          // the local browser lacks falls back to grey.
          const e = { id: r.id, t: String(d.t ?? ''), c: typeof d.c === 'string' && d.c ? d.c : 'grey', x: !!d.x, v: d.v || {}, xtra: extras(d, ['t', 'c', 'x']), seq: r.seq };
          this.groups.set(r.id, e);
          gputs.push(e);
          touchedGroups.add(r.id);
        }
        continue;
      }
      if (r.deleted) {
        if (r.data?.k) keepOpen.add(r.id);
        const gone = this.model.get(r.id);
        if (gone && !r.data?.k) this.graveyard.push({ u: gone.u, pin: !!gone.pin, at: Date.now() });
        if (this.model.delete(r.id)) dels.push(r.id);
      } else {
        const d = r.data || {};
        if (typeof d.u !== 'string' || !SYNCABLE.test(d.u)) continue;
        const e = { id: r.id, u: d.u, t: String(d.t ?? ''), pin: !!d.pin, g: d.g || null, o: d.o, v: d.v || {}, xtra: extras(d, ['u', 't', 'pin', 'g', 'o']), seq: r.seq };
        // Three-way merge: only fields the remote actually changed (relative
        // to our last agreed state) are applied to the browser.
        const prev = touched.has(r.id) ? null : this.model.get(r.id);
        const fields = touched.get(r.id) || new Set();
        for (const f of ['u', 'pin', 'g', 'o']) if (!prev || (prev[f] ?? null) !== (e[f] ?? null)) fields.add(f);
        if (fields.has('u')) this.authored.delete(r.id);
        touched.set(r.id, fields);
        this.model.set(r.id, e);
        puts.push(e);
      }
    }
    await this.persist(puts, dels);
    await this.persist(gputs, gdels, 'lg');
    if (dels.length) {
      const cutoff = Date.now() - 30 * 864e5;
      this.graveyard = this.graveyard.filter((g) => g.at > cutoff).slice(-300);
      await db.kvSet('lt:graveyard', this.graveyard);
    }
    if (keepOpen.size) {
      for (const [tabId, uid] of [...this.tabUid]) if (keepOpen.has(uid)) this.tabUid.delete(tabId);
    }
    if (this.init && this.win != null) await this.materialize({ tabs: touched, groups: touchedGroups });
  }

  /** Desired tab order: model order, pinned first, groups contiguous. */
  desired() {
    const all = [...this.model.values()].sort(compareOrder);
    const pinned = all.filter((e) => e.pin);
    const rest = all.filter((e) => !e.pin);
    const out = [...pinned];
    const emitted = new Set();
    for (const e of rest) {
      if (emitted.has(e.id)) continue;
      if (e.g && this.groups.has(e.g)) {
        for (const m of rest) if (m.g === e.g && !emitted.has(m.id)) {
          out.push(m);
          emitted.add(m.id);
        }
      } else {
        out.push(e);
        emitted.add(e.id);
      }
    }
    return out;
  }

  /**
   * Makes the synced window match the model. With `only`, applies just the
   * records changed remotely ({ tabs, groups } uid sets) and leaves other
   * tabs alone: a local edit made since the last scan must not be undone;
   * the next scan sends it instead.
   */
  async materialize(only = null) {
    if (this.win == null || this.closing) return;
    // Discarding replaces tab ids; never do it underneath an apply.
    this.materializing = true;
    try {
      await this.materializeInner(only);
    } finally {
      this.materializing = false;
      for (const id of [...this.discardQueue]) {
        chrome.tabs.get(id).then((t) => this.tryDiscard(t), () => this.discardQueue.delete(id));
      }
    }
  }

  async materializeInner(only) {
    const changed = (e, f) => !only || only.tabs.get(e.id)?.has(f) || (f === 'g' && e.g && only.groups.has(e.g));
    const isTouched = (e) => !only || only.tabs.has(e.id) || (e.g && only.groups.has(e.g));
    let tabs;
    try {
      tabs = await chrome.tabs.query({ windowId: this.win });
    } catch {
      return;
    }
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const lidOf = new Map();
    for (const [tabId, uid] of this.tabUid) if (byId.has(tabId)) lidOf.set(uid, tabId);
    // What we set on each tab. Becomes `seen` at the end; recording intent
    // rather than observing the result keeps a concurrent user edit visible
    // to the next scan.
    const intended = new Map();
    const intend = (uid, patch) => intended.set(uid, { ...(intended.get(uid) || {}), ...patch });

    // 1. Close tabs whose record is gone.
    const close = [];
    for (const [tabId, uid] of [...this.tabUid]) {
      if (!this.model.has(uid)) {
        this.tabUid.delete(tabId);
        if (byId.has(tabId)) close.push(tabId);
      }
    }
    if (close.length) {
      if (close.length >= tabs.length) {
        // Keep the window open.
        await chrome.tabs.create({ windowId: this.win, active: true });
      }
      // Helium keeps closed pins as hibernated tabs; unpin first so they
      // really close.
      for (const id of close) if (byId.get(id)?.pinned) await chrome.tabs.update(id, { pinned: false }).catch(() => {});
      await chrome.tabs.remove(close).catch(() => {});
    }

    // 2. Create and update tabs.
    const want = this.desired();
    const focus = new Set(); // tab uids whose position/group we may change
    for (const e of want) {
      const tabId = lidOf.get(e.id);
      const tab = tabId != null ? byId.get(tabId) : null;
      if (!tab || changed(e, 'o') || changed(e, 'g') || changed(e, 'pin')) focus.add(e.id);
      if (tab && !isTouched(e)) continue;
      if (!tab) {
        // A tab being replaced (discard/prerender) shows up under a new,
        // unmapped id with the same URL: adopt it rather than duplicate it.
        const mapped = new Set(this.tabUid.keys());
        const twin = tabs.find((t) => !mapped.has(t.id) && rawUrl(t) === e.u && !!t.pinned === !!e.pin);
        if (twin) {
          this.tabUid.set(twin.id, e.id);
          lidOf.set(e.id, twin.id);
          byId.set(twin.id, twin);
          continue;
        }
        if (only?.heal) continue;
        try {
          const t = await chrome.tabs.create({ windowId: this.win, url: e.u, pinned: e.pin, active: false });
          this.tabUid.set(t.id, e.id);
          lidOf.set(e.id, t.id);
          intend(e.id, { u: e.u, pin: !!e.pin, g: null });
          this.applied.set(t.id, e.u);
          this.guard.set(t.id, { url: e.u, until: Date.now() + GUARD_MS });
          if (this.lazy && canDiscard()) this.discardQueue.add(t.id);
        } catch (err) {
          console.warn('helium-sync: create tab', e.u, err.message);
        }
        continue;
      }
      const upd = {};
      if (changed(e, 'pin') && !!e.pin !== tab.pinned) upd.pinned = !!e.pin;
      // Navigate unless the tab already shows this URL, or we already sent it
      // there (it may have redirected).
      if (changed(e, 'u') && rawUrl(tab) !== e.u && this.applied.get(tab.id) !== e.u) upd.url = e.u;
      if (Object.keys(upd).length) {
        try {
          await chrome.tabs.update(tab.id, upd);
          if ('pinned' in upd) intend(e.id, { pin: upd.pinned });
          if (upd.url) {
            intend(e.id, { u: e.u });
            this.applied.set(tab.id, e.u);
            this.alias.delete(tab.id);
            this.guard.set(tab.id, { url: e.u, until: Date.now() + GUARD_MS });
          }
        } catch (err) {
          console.warn('helium-sync: update tab', err.message);
        }
      }
    }

    // 3. Group membership first, then order: a grouped tab moved within its
    //    group's span stays grouped, so moves do not undo grouping. Repeat
    //    while Chromium's own adjustments (pinned first, contiguous groups)
    //    leave something to fix.
    for (let pass = 0; pass < 3; pass++) {
      const regrouped = await this.applyGroups(want, lidOf, only ? focus : null, only?.groups, intend);
      const moved = await this.applyOrder(want, lidOf, only ? focus : null);
      if (!moved && !regrouped) break;
    }
    // 4. Remember what we did. Tabs we moved or regrouped are re-observed:
    //    Chromium may have adjusted them as a side effect, which is not a
    //    user edit. Other tabs get exactly what we set, so a concurrent user
    //    edit to them still shows up in the next scan.
    const now = new Map((await chrome.tabs.query({ windowId: this.win })).map((t) => [t.id, t]));
    for (const uid of focus) {
      const tab = now.get(lidOf.get(uid));
      if (tab) this.seen.set(uid, this.observe(tab, uid));
    }
    for (const [uid, patch] of intended) {
      if (focus.has(uid)) continue;
      const tab = byId.get(lidOf.get(uid));
      const before = this.seen.get(uid) || (tab ? this.observe(tab, uid) : { u: null, pin: false, g: null });
      this.seen.set(uid, { ...before, ...patch });
    }
    await this.saveSession();
  }

  observe(t, uid) {
    return { u: this.effectiveUrl(t, uid), pin: !!t.pinned, g: !t.pinned && t.groupId !== -1 ? this.groupUid.get(t.groupId) || null : null };
  }

  async applyOrder(want, lidOf, focus) {
    const tabs = await chrome.tabs.query({ windowId: this.win });
    tabs.sort((a, b) => a.index - b.index);
    const current = tabs.map((t) => t.id);
    const desired = want.filter((e) => current.includes(lidOf.get(e.id)));
    const desiredIds = desired.map((e) => lidOf.get(e.id));
    const pos = new Map(current.map((id, i) => [id, i]));
    let keep;
    if (focus) {
      // Only touched tabs move; everything else is an anchor.
      keep = new Set(desired.filter((e) => !focus.has(e.id)).map((e) => lidOf.get(e.id)));
    } else {
      keep = new Set(lis(desiredIds.map((id) => pos.get(id))).map((i) => desiredIds[i]));
    }
    let moved = false;
    for (let i = 0; i < desiredIds.length; i++) {
      const id = desiredIds[i];
      if (keep.has(id)) continue;
      const from = current.indexOf(id);
      const e = desired[i];
      const prevSameGroup = i > 0 && desired[i - 1].g === e.g;
      const nextSameGroup = i + 1 < desired.length && e.g && desired[i + 1].g === e.g;
      let to;
      if ((e.g && !prevSameGroup && nextSameGroup) || i === 0) {
        // First of its group (or of the window): go right before the next
        // tab, which keeps it inside its group's span even when unsynced
        // tabs sit in between.
        const next = nextSameGroup ? desiredIds[i + 1] : desiredIds.find((x, j) => j > i && keep.has(x));
        to = next != null ? current.indexOf(next) : from;
        if (to > from) to--;
      } else {
        to = current.indexOf(desiredIds[i - 1]) + (current.indexOf(desiredIds[i - 1]) < from ? 1 : 0);
      }
      if (to === from || to < 0) continue;
      current.splice(from, 1);
      current.splice(to, 0, id);
      try {
        await chrome.tabs.move(id, { index: to });
        moved = true;
      } catch (err) {
        console.warn('helium-sync: move tab', err.message);
      }
    }
    return moved;
  }

  async applyGroups(want, lidOf, focus, touchedGroups, intend) {
    if (!hasGroups()) return false;
    const tabs = await chrome.tabs.query({ windowId: this.win });
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const lidOfGroup = new Map();
    for (const [gid, uid] of this.groupUid) lidOfGroup.set(uid, gid);
    let changed = false;
    // Ungroup synced tabs that should not be in their current group.
    const ungroup = [];
    for (const e of want) {
      if (focus && !focus.has(e.id)) continue;
      const t = byId.get(lidOf.get(e.id));
      if (!t || t.groupId === -1) continue;
      const wantGid = e.g && !e.pin ? lidOfGroup.get(e.g) : undefined;
      if (t.groupId !== wantGid) ungroup.push(t.id);
    }
    if (ungroup.length) {
      await chrome.tabs.ungroup(ungroup).catch(() => {});
      for (const e of want) if (ungroup.includes(lidOf.get(e.id))) intend(e.id, { g: null });
      changed = true;
    }
    // Group members.
    const members = new Map();
    for (const e of want) {
      if (!e.g || e.pin || !this.groups.has(e.g)) continue;
      if (focus && !focus.has(e.id) && !touchedGroups?.has(e.g)) continue;
      const t = byId.get(lidOf.get(e.id));
      if (!t) continue;
      if (!members.has(e.g)) members.set(e.g, []);
      members.get(e.g).push(t);
    }
    for (const [guid, list] of members) {
      const g = this.groups.get(guid);
      let gid = lidOfGroup.get(guid);
      const missing = list.filter((t) => t.groupId !== gid || gid == null || ungroup.includes(t.id)).map((t) => t.id);
      try {
        if (gid == null) {
          gid = await chrome.tabs.group({ tabIds: missing, createProperties: { windowId: this.win } });
          this.groupUid.set(gid, guid);
          lidOfGroup.set(guid, gid);
          changed = true;
        } else if (missing.length) {
          await chrome.tabs.group({ groupId: gid, tabIds: missing });
          changed = true;
        }
        for (const e of want) if (missing.includes(lidOf.get(e.id))) intend(e.id, { g: guid });
        const cur = await chrome.tabGroups.get(gid);
        const upd = {};
        if (cur.title !== g.t) upd.title = g.t;
        if (cur.color !== g.c && !(cur.color === 'grey' && !COLORS.has(g.c))) upd.color = g.c;
        if (cur.collapsed !== !!g.x) upd.collapsed = !!g.x;
        if (Object.keys(upd).length) {
          await chrome.tabGroups.update(gid, upd).catch(async () => {
            // A colour this browser does not have (from a newer Chromium).
            if (upd.color) await chrome.tabGroups.update(gid, { ...upd, color: 'grey' }).catch(() => {});
          });
        }
      } catch (err) {
        console.warn('helium-sync: group tabs', err.message);
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // Initial merge and mode

  async initialMerge() {
    // Record this device's view of the mode so a fresh account gets one.
    if (this.cfgSeq == null) this.engine.write('lt', CFG, { mode: this.mode });
    const win = (await this.pickWindow()) || null;
    if (!win) return; // attached later when a window opens
    await this.attach(win.id, { restart: false });
    this.init = true; // materialize/scan check init
    await this.materialize();
    await this.doScan();
  }

  async afterCaughtUp() {
    if (this.win != null) await this.materialize();
    else if (this.needsAttach && !this.attaching) {
      // Run outside the lock: attachTo takes it.
      setTimeout(() => this.startupAttach().catch((e) => console.error('helium-sync: attach', e)), 0);
    }
  }

  /** Switches between mirroring all tabs and only pinned/grouped ones. */
  async switchMode(mode, local) {
    this.mode = mode;
    if (local) this.engine.write('lt', CFG, { mode });
    if (mode === 'arc') {
      // Tabs that are neither pinned nor grouped stop syncing but stay open.
      for (const e of [...this.model.values()]) {
        if (!e.pin && !e.g) {
          this.model.delete(e.id);
          await this.persist([], [e.id]);
          if (local) this.removeRecord('lt', e.id, { k: 1 });
          for (const [tabId, uid] of [...this.tabUid]) if (uid === e.id) this.tabUid.delete(tabId);
        }
      }
    }
    await this.saveSession();
  }

  setMode(mode) {
    return this.exclusive(async () => {
      if (mode === this.mode) return;
      await this.switchMode(mode, true);
      await this.doScan();
    });
  }

  async setLazy(lazy) {
    this.lazy = lazy;
    await chrome.storage.local.set({ liveTabsLazy: lazy });
  }

  /** Make the given window the synced window. */
  useWindow(windowId) {
    return this.attachTo(windowId, { restart: false });
  }

  async onDisable() {
    this.detach();
    await this.saveSession();
  }
}

function keyAfterLast(model) {
  let max = null;
  for (const e of model.values()) if (e.o && (max === null || e.o > max)) max = e.o;
  return keyBetween(max, null);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
