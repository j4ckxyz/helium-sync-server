// Helium Sync service worker.
//
// Browser event listeners are registered synchronously at the top level (an
// MV3 requirement for waking the worker) and forwarded to the adapters.

import { Engine } from './engine.js';
import * as api from './lib/api.js';
import * as c from './lib/crypto.js';
import * as db from './lib/db.js';
import { Bookmarks } from './collections/bookmarks.js';
import { History } from './collections/history.js';
import { LiveTabs } from './collections/livetabs.js';
import { Extensions, ReadingList, Sessions, SendTab } from './collections/misc.js';

const DEFAULT_TYPES = { bookmarks: true, history: true, liveTabs: true, openTabs: true, extensions: true, readingList: true, sendTab: true };

const adapters = {
  bookmarks: new Bookmarks(),
  history: new History(),
  liveTabs: new LiveTabs(),
  openTabs: new Sessions(),
  extensions: new Extensions(),
  readingList: new ReadingList(),
  sendTab: new SendTab(),
};

let engine = null;
let booted = null;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { types: { ...DEFAULT_TYPES, ...(settings?.types || {}) } };
}

// Browser APIs each data type needs; a type whose APIs this browser lacks is
// simply not offered.
const REQUIRES = {
  bookmarks: ['bookmarks'],
  history: ['history'],
  liveTabs: ['tabs', 'windows'],
  openTabs: ['tabs', 'windows'],
  extensions: ['management'],
  readingList: ['readingList'],
  sendTab: ['tabs'],
};

function supported(name) {
  return (REQUIRES[name] || []).every((api) => !!chrome[api]);
}

function enabledAdapters(settings) {
  return Object.entries(adapters)
    .filter(([name]) => settings.types[name] && supported(name))
    .map(([, a]) => a);
}

async function boot() {
  const { session } = await chrome.storage.local.get('session');
  const keys = await db.kvGet('keys');
  if (!session?.token || !keys) {
    updateBadge({ state: 'signed-out' });
    return;
  }
  engine = new Engine();
  engine.onStatus((s) => {
    updateBadge(s);
    chrome.runtime.sendMessage({ type: 'status-changed' }).catch(() => {});
  });
  await engine.start(session, keys, enabledAdapters(await getSettings()));
  refreshMenus();
}

function ready() {
  if (!booted) booted = boot().catch((e) => console.error('helium-sync: boot', e));
  return booted;
}

function updateBadge(s) {
  const bad = s.state === 'auth' || (s.error && s.state !== 'live');
  chrome.action.setBadgeText({ text: s.state === 'signed-out' ? '' : bad ? '!' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {});
  const titles = { live: 'Helium Sync — up to date', syncing: 'Helium Sync — syncing…', connecting: 'Helium Sync — connecting…', offline: 'Helium Sync — offline, will retry', auth: 'Helium Sync — sign in again', 'signed-out': 'Helium Sync — not set up' };
  chrome.action.setTitle({ title: titles[s.state] || 'Helium Sync' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Browser events

const when = (name, fn) => (...args) => {
  ready().then(() => {
    const a = adapters[name];
    if (engine && a.enabled) fn(a, ...args);
  });
};

/**
 * Registers a listener if this browser has the event. Chromium versions and
 * forks differ in which APIs and events exist; a missing one must disable
 * only the feature that needs it, never the whole service worker.
 */
function listen(path, fn) {
  let target = chrome;
  for (const part of path.split('.')) target = target?.[part];
  if (target?.addListener) target.addListener(fn);
  else console.info('helium-sync: not available in this browser:', path);
}

for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportEnded']) {
  listen(`bookmarks.${ev}`, when('bookmarks', (a) => a.schedule(150)));
}

listen('history.onVisited', when('history', (a, item) => a.onVisited(item)));
listen('history.onVisitRemoved', when('history', (a, removed) => a.onVisitRemoved(removed)));

listen('tabs.onCreated', when('liveTabs', (a) => a.schedule(25)));
listen('tabs.onRemoved', when('liveTabs', (a, id, info) => a.onTabRemoved(id, info)));
listen('tabs.onUpdated', when('liveTabs', (a, id, change, tab) => a.onTabUpdated(id, change, tab)));
listen('tabs.onReplaced', when('liveTabs', (a, added, removed) => a.onTabReplaced(added, removed)));
for (const ev of ['onMoved', 'onAttached', 'onDetached']) listen(`tabs.${ev}`, when('liveTabs', (a) => a.schedule(25)));
for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) listen(`tabGroups.${ev}`, when('liveTabs', (a) => a.schedule(25)));
listen('windows.onRemoved', when('liveTabs', (a, id) => a.onWindowRemoved(id)));
listen('windows.onCreated', when('liveTabs', (a, w) => a.onWindowCreated(w)));
listen('webNavigation.onCommitted', when('liveTabs', (a, d) => d.frameId === 0 && a.onCommitted(d)));

const openTabsChanged = when('openTabs', (a) => a.schedule());
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached']) listen(`tabs.${ev}`, openTabsChanged);

for (const ev of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) {
  listen(`management.${ev}`, when('extensions', (a) => a.schedule(500)));
}
for (const ev of ['onEntryAdded', 'onEntryRemoved', 'onEntryUpdated']) listen(`readingList.${ev}`, when('readingList', (a) => a.schedule(300)));

listen('runtime.onStartup', () => ready());
listen('runtime.onInstalled', async (details) => {
  await ready();
  if (details.reason === 'install' && !engine) chrome.runtime.openOptionsPage();
});
// Wakes the worker to reconnect if the browser suspended it. Re-created on
// every start (idempotent) in case an update or profile reset dropped it.
chrome.alarms?.create('keepalive', { periodInMinutes: 1 });
listen('alarms.onAlarm', (alarm) => {
  if (alarm.name === 'keepalive') ready().then(() => engine?.kick());
});
self.addEventListener('online', () => engine?.kick());

listen('notifications.onClicked', (id) => {
  if (id.startsWith('st:')) {
    const tabId = Number(id.slice(3));
    chrome.tabs.update(tabId, { active: true }).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
    chrome.notifications.clear(id);
  }
});

// ---------------------------------------------------------------------------
// Send-tab context menu

let menuDevices = [];

async function refreshMenus() {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll().catch(() => {});
  if (!engine || !adapters.sendTab.enabled) return;
  try {
    const acct = await api.request(engine.session.server, '/api/v1/account', { token: engine.session.token });
    menuDevices = acct.devices.filter((d) => d.id !== engine.session.deviceId);
  } catch {
    return;
  }
  if (!menuDevices.length) return;
  chrome.contextMenus.create({ id: 'send', title: 'Send to your devices', contexts: ['page', 'link'] });
  for (const d of menuDevices) chrome.contextMenus.create({ id: 'send:' + d.id, parentId: 'send', title: d.name, contexts: ['page', 'link'] });
}

listen('contextMenus.onClicked', async (info, tab) => {
  await ready();
  if (!engine || !info.menuItemId.startsWith('send:')) return;
  const to = info.menuItemId.slice(5);
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (url) adapters.sendTab.send(to, url, info.linkUrl ? info.selectionText || url : tab?.title);
});

// ---------------------------------------------------------------------------
// Sign-in

async function signIn(kind, msg) {
  const server = api.normalizeServer(msg.server);
  await api.serverInfo(server);
  const deviceName = (msg.deviceName || '').trim() || (await defaultDeviceName());
  const s = kind === 'register' ? await api.register(server, { ...msg, deviceName }) : await api.login(server, { ...msg, deviceName });
  const keys = await c.deriveDataKeys(s.dataKey);
  s.dataKey.fill(0);

  // A different account (or server) starts from a clean slate.
  const { session: old } = await chrome.storage.local.get('session');
  if (engine) await engine.stop();
  engine = null;
  if (!old || old.server !== server || old.username?.toLowerCase() !== s.username.toLowerCase()) await db.wipe();
  else {
    for (const k of ['cursor', 'outbox', 'syncedColls']) await db.kvDelete(k);
  }
  await db.kvSet('keys', keys);
  await chrome.storage.local.set({ session: { server, token: s.token, deviceId: s.deviceId, username: s.username, deviceName } });
  booted = null;
  await ready();
  return { ok: true };
}

async function defaultDeviceName() {
  const info = await chrome.runtime.getPlatformInfo().catch(() => ({}));
  const os = { mac: 'Mac', win: 'Windows', linux: 'Linux', cros: 'ChromeOS' }[info.os] || 'Computer';
  return `Helium on ${os}`;
}

async function signOut({ revoke = true } = {}) {
  const { session } = await chrome.storage.local.get('session');
  if (engine) await engine.stop();
  engine = null;
  if (revoke && session?.token) await api.request(session.server, '/api/v1/logout', { method: 'POST', token: session.token }).catch(() => {});
  await chrome.storage.local.remove('session');
  await chrome.storage.session.clear();
  await db.wipe();
  await chrome.contextMenus?.removeAll().catch(() => {});
  booted = null;
  updateBadge({ state: 'signed-out' });
}

// ---------------------------------------------------------------------------
// UI messages

async function status() {
  await ready();
  const { session } = await chrome.storage.local.get('session');
  const settings = await getSettings();
  let config = {};
  try {
    config = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  } catch {}
  if (!engine) return { signedIn: false, session: session ? { server: session.server, username: session.username } : null, config, settings };
  return {
    signedIn: true,
    session: { server: session.server, username: session.username, deviceId: session.deviceId, deviceName: session.deviceName },
    status: engine.status,
    online: engine.online,
    pending: engine.outboxSize(),
    settings,
    config,
    liveTabs: adapters.liveTabs.enabled ? adapters.liveTabs.status() : null,
    unsupported: Object.keys(adapters).filter((n) => !supported(n)),
    failed: engine.failed || [],
    server: engine.server || null,
  };
}

const handlers = {
  status,
  register: (m) => signIn('register', m),
  login: (m) => signIn('login', m),
  logout: () => signOut(),
  async serverInfo(m) {
    const server = api.normalizeServer(m.server);
    const info = await api.serverInfo(server);
    return { ...info, server, insecure: server.startsWith('http:') && !api.isPrivateHost(server) };
  },
  async setTypes(m) {
    await ready();
    const settings = await getSettings();
    settings.types = { ...settings.types, ...m.types };
    await chrome.storage.local.set({ settings });
    if (engine) await engine.reconfigure(enabledAdapters(settings));
    refreshMenus();
    return status();
  },
  async syncNow() {
    await ready();
    if (!engine) return null;
    engine.kick();
    for (const a of engine.adapters) a.schedule?.(0);
    return status();
  },
  async account() {
    await ready();
    if (!engine) throw new Error('Not signed in');
    return api.request(engine.session.server, '/api/v1/account', { token: engine.session.token });
  },
  async revokeDevice(m) {
    await ready();
    await api.request(engine.session.server, '/api/v1/devices/' + encodeURIComponent(m.id), { method: 'DELETE', token: engine.session.token });
    refreshMenus();
    return null;
  },
  async renameDevice(m) {
    await ready();
    const name = String(m.name || '').trim();
    await api.request(engine.session.server, '/api/v1/devices/self', { method: 'PATCH', token: engine.session.token, body: { name } });
    engine.session.deviceName = name;
    const { session } = await chrome.storage.local.get('session');
    await chrome.storage.local.set({ session: { ...session, deviceName: name } });
    adapters.openTabs.schedule?.();
    return null;
  },
  async changePassword(m) {
    await ready();
    await api.changePassword(engine.session.server, engine.session.token, { username: engine.session.username, oldPassword: m.oldPassword, newPassword: m.newPassword });
    refreshMenus();
    return null;
  },
  async deleteAccount(m) {
    await ready();
    await api.deleteAccount(engine.session.server, engine.session.token, { username: engine.session.username, password: m.password });
    await signOut({ revoke: false });
    return null;
  },
  async devicesTabs() {
    await ready();
    if (!engine || !adapters.openTabs.enabled) return { devices: [], online: [] };
    return { devices: adapters.openTabs.list(), online: engine.online };
  },
  async sendTab(m) {
    await ready();
    adapters.sendTab.send(m.to, m.url, m.title);
    return null;
  },
  async sendTargets() {
    await ready();
    if (!engine) return [];
    if (!menuDevices.length) await refreshMenus();
    return menuDevices.map((d) => ({ id: d.id, name: d.name, online: engine.online.includes(d.id) }));
  },
  async liveTabsUseWindow(m) {
    await ready();
    await adapters.liveTabs.useWindow(m.windowId);
    return status();
  },
  async liveTabsMode(m) {
    await ready();
    await adapters.liveTabs.setMode(m.mode === 'arc' ? 'arc' : 'all');
    return status();
  },
  async liveTabsLazy(m) {
    await ready();
    await adapters.liveTabs.setLazy(!!m.lazy);
    return status();
  },
  async extensions() {
    await ready();
    if (!engine || !adapters.extensions.enabled) return { missing: [], removed: [] };
    return { missing: adapters.extensions.missing(), removed: await adapters.extensions.removedElsewhere() };
  },
  async forgetExtension(m) {
    await ready();
    await adapters.extensions.forget(m.id);
    return null;
  },
  async dismissRemovedExtension(m) {
    await adapters.extensions.dismissRemoved(m.id);
    return null;
  },
  async searchHistory(m) {
    await ready();
    const [remote, local] = await Promise.all([db.histSearch(m.text, 300), chrome.history.search({ text: m.text || '', maxResults: 300, startTime: 0 })]);
    return { remote, local: local.map((h) => ({ u: h.url, t: h.title, v: h.lastVisitTime })) };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only the extension's own pages may drive the service worker.
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL('')))) return false;
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(() => h(msg))
    .then((data) => reply({ ok: true, data }))
    .catch((e) => reply({ ok: false, error: e.message || String(e), kind: e.kind }));
  return true;
});

// Test hook: lets the end-to-end tests reach the engine from the worker.
self.heliumSync = { adapters, get engine() { return engine; }, ready, handlers };

ready();
