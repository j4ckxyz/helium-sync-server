import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startPages, launch, waitFor, waitLive, syncedTabs, sleep } from './harness.js';

let server, pages, A, B;
const creds = { username: 'e2e', password: 'correct horse battery staple' };

before(async () => {
  server = await startServer();
  pages = await startPages();
  [A, B] = await Promise.all([launch('A', null, { warmup: pages.page('warmup') }), launch('B', null, { warmup: pages.page('warmup') })]);
  await A.call('register', { server: server.url, ...creds, deviceName: 'Device A' });
  await waitLive(A);
  await B.call('login', { server: server.url, ...creds, deviceName: 'Device B' });
  await waitLive(B);
  if (process.env.HS_TRACE) for (const X of [A, B]) await X.run(installTrace);
});

// Opt-in tracing (HS_TRACE=1) of live-tab writes, incoming records and applies.
function installTrace() {
  self.trace = [];
  const lt = self.heliumSync.adapters.liveTabs;
  const eng = self.heliumSync.engine;
  const short = (id) => id.slice(0, 4);
  const ow = eng.write.bind(eng);
  eng.write = (c, id, d) => {
    if (c === 'lt' || c === 'lg') self.trace.push(['W', c, short(id), JSON.stringify(d)]);
    return ow(c, id, d);
  };
  const ar = lt.applyRemote.bind(lt);
  lt.applyRemote = (recs) => {
    self.trace.push(['IN', JSON.stringify(recs.map((r) => [r.coll, short(r.id), r.seq, eng.isPending(r.coll, r.id), r.data]))]);
    return ar(recs);
  };
  const layout = async () => {
    if (lt.win == null) return '';
    const ts = await chrome.tabs.query({ windowId: lt.win });
    return ts.sort((a, b) => a.index - b.index).map((t) => `${t.id % 1000}:${(t.pendingUrl || t.url).split('/').pop().slice(0, 6)}${t.pinned ? '^' : ''}${t.groupId !== -1 ? '*' + (t.groupId % 100) : ''}`).join(' ');
  };
  for (const fn of ['ungroup', 'group', 'move', 'update']) {
    const o = chrome.tabs[fn];
    chrome.tabs[fn] = async function (...a) {
      const before = await layout();
      const r = await o.apply(this, a);
      self.trace.push(['API', fn, JSON.stringify(a).replace(/\d{6,}/g, (m) => String(Number(m) % 1000)), before, '=>', await layout()]);
      return r;
    };
  }
}

async function dumpTrace() {
  if (!process.env.HS_TRACE) return;
  for (const X of [A, B]) {
    console.log(`--- ${X.name} trace`);
    for (const t of await X.run(() => self.trace)) console.log(' ', X.name, JSON.stringify(t).slice(0, 300));
    console.log(X.name, 'tabs', JSON.stringify(await syncedTabs(X)));
    console.log(X.name, 'model', JSON.stringify(await X.run(() => [...self.heliumSync.adapters.liveTabs.model.values()].map((e) => [e.id.slice(0, 4), e.u.slice(-8), e.pin, e.g && e.g.slice(0, 4), e.o]))));
  }
}

after(async () => {
  await Promise.allSettled([A?.wipe(), B?.wipe()]);
  await server?.stop();
  await pages?.close();
});

/** Once settled, no device may keep writing (no echo or ping-pong loops). */
async function assertQuiet(ms = 4000) {
  const seq = () => A.run(() => self.heliumSync.engine.cursor);
  await waitFor(async () => {
    const before = await seq();
    await sleep(3500); // longer than the history/open-tabs debounce
    return (await seq()) === before;
  }, { message: 'writes to settle', timeout: 30000 });
  const before = await seq();
  const t0 = Date.now();
  await sleep(ms);
  const after = await seq();
  if (after !== before) {
    for (const X of [A, B]) {
      const w = await X.run((t0) => (self.heliumSync.engine.recent || []).filter((r) => r.at >= t0), t0);
      console.log(X.name, 'idle writes:', JSON.stringify(w));
    }
  }
  assert.equal(after, before, `server saw ${after - before} writes while idle`);
}

async function bookmarkTree(b) {
  return b.run(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const bar = root.children.find((c) => c.folderType === 'bookmarks-bar' || c.id === '1');
    const dump = (n) => (n.url ? `${n.title}<${n.url}>` : { [n.title]: (n.children || []).map(dump) });
    return (bar.children || []).map(dump);
  });
}

test('bookmarks: create, nest, rename, reorder and delete propagate', async () => {
  await A.run(async () => {
    const f = await chrome.bookmarks.create({ parentId: '1', title: 'Work' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Docs', url: 'https://docs.example.com/' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Mail', url: 'https://mail.example.com/' });
    await chrome.bookmarks.create({ parentId: '1', title: 'News', url: 'https://news.example.com/' });
  });
  const want = [{ Work: ['Docs<https://docs.example.com/>', 'Mail<https://mail.example.com/>'] }, 'News<https://news.example.com/>'];
  await waitFor(async () => JSON.stringify(await bookmarkTree(B)) === JSON.stringify(want), { message: 'B has A bookmarks' });

  // Edit on B: rename + reorder; A follows.
  await B.run(async () => {
    const [mail] = await chrome.bookmarks.search({ url: 'https://mail.example.com/' });
    await chrome.bookmarks.update(mail.id, { title: 'Inbox' });
    await chrome.bookmarks.move(mail.id, { parentId: mail.parentId, index: 0 });
  });
  const want2 = [{ Work: ['Inbox<https://mail.example.com/>', 'Docs<https://docs.example.com/>'] }, 'News<https://news.example.com/>'];
  await waitFor(async () => JSON.stringify(await bookmarkTree(A)) === JSON.stringify(want2), { message: 'A has B edits' });

  // Move a bookmark out of the folder and delete the folder on A.
  await A.run(async () => {
    const [docs] = await chrome.bookmarks.search({ url: 'https://docs.example.com/' });
    await chrome.bookmarks.move(docs.id, { parentId: '1', index: 0 });
    const [work] = await chrome.bookmarks.search({ title: 'Work' });
    await chrome.bookmarks.removeTree(work.id);
  });
  const want3 = ['Docs<https://docs.example.com/>', 'News<https://news.example.com/>'];
  await waitFor(async () => JSON.stringify(await bookmarkTree(B)) === JSON.stringify(want3), { message: 'B mirrors delete' });
  await assertQuiet(2000);
  assert.deepEqual(await bookmarkTree(A), want3, 'no echo changes on A');
  assert.deepEqual(await bookmarkTree(B), want3);
});

test('live tabs: open, navigate, pin, group, reorder and close mirror in real time', async () => {
  try {
    await liveTabsScenario();
  } catch (e) {
    await dumpTrace();
    throw e;
  }
});

/** Runs a test action, retrying if a tab was replaced (lazy discard) under it. */
async function act(b, fn, arg) {
  for (let i = 0; ; i++) {
    try {
      return await b.run(fn, arg);
    } catch (e) {
      if (i < 5 && /No tab with id/.test(e.message)) {
        await sleep(200);
        continue;
      }
      throw e;
    }
  }
}

async function liveTabsScenario() {
  await waitFor(async () => (await syncedTabs(A)) && (await syncedTabs(B)), { message: 'both attached' });
  const urlsOf = (tabs) => tabs.map((t) => t.u);

  // Open on A.
  const t0 = Date.now();
  await act(A, (u) => chrome.tabs.create({ url: u, active: false }), pages.page('one'));
  await waitFor(async () => urlsOf(await syncedTabs(B)).includes(pages.page('one')), { message: 'tab on B' });
  const latency = Date.now() - t0;
  console.log(`  open-tab propagation: ${latency} ms`);

  // Both windows converge to the same list.
  await waitFor(async () => JSON.stringify(urlsOf(await syncedTabs(A))) === JSON.stringify(urlsOf(await syncedTabs(B))), { message: 'same tab list' });

  // Navigate on B.
  await act(B, async ([from, to]) => {
    const [t] = await chrome.tabs.query({ url: from });
    await chrome.tabs.update(t.id, { url: to });
  }, [pages.page('one'), pages.page('two')]);
  await waitFor(async () => urlsOf(await syncedTabs(A)).includes(pages.page('two')), { message: 'navigation on A' });

  // Pin on A; open two more and group them with a title and colour.
  await act(A, async ([two, three, four]) => {
    const [t] = await chrome.tabs.query({ url: two });
    await chrome.tabs.update(t.id, { pinned: true });
    const a = await chrome.tabs.create({ url: three, active: false });
    const b = await chrome.tabs.create({ url: four, active: false });
    const g = await chrome.tabs.group({ tabIds: [a.id, b.id] });
    await chrome.tabGroups.update(g, { title: 'Research', color: 'green' });
  }, [pages.page('two'), pages.page('three'), pages.page('four')]);
  const check = async () => {
    const tabs = await syncedTabs(B);
    const two = tabs.find((t) => t.u === pages.page('two'));
    const g3 = tabs.find((t) => t.u === pages.page('three'))?.g;
    const g4 = tabs.find((t) => t.u === pages.page('four'))?.g;
    return two?.pin && g3 === 'Research/green' && g4 === 'Research/green';
  };
  await waitFor(check, { message: 'pin + group on B', timeout: 15000 });

  // Reorder on B: move "four" before "three" (inside the group).
  await act(B, async ([three, four]) => {
    const [t3] = await chrome.tabs.query({ url: three });
    const [t4] = await chrome.tabs.query({ url: four });
    await chrome.tabs.move(t4.id, { index: t3.index });
  }, [pages.page('three'), pages.page('four')]);
  await waitFor(async () => {
    const u = urlsOf(await syncedTabs(A));
    return u.indexOf(pages.page('four')) >= 0 && u.indexOf(pages.page('four')) < u.indexOf(pages.page('three'));
  }, { message: 'reorder on A' });

  // Close on A.
  await act(A, async (three) => {
    const [t] = await chrome.tabs.query({ url: three });
    await chrome.tabs.remove(t.id);
  }, pages.page('three'));
  await waitFor(async () => !urlsOf(await syncedTabs(B)).includes(pages.page('three')), { message: 'close on B' });

  // Settled state is identical and stable (no ping-pong).
  await waitFor(async () => JSON.stringify(await syncedTabs(A)) === JSON.stringify(await syncedTabs(B)), { message: 'identical windows' });
  const a = await syncedTabs(A);
  await assertQuiet();
  assert.deepEqual(await syncedTabs(A), a, 'A stable');
  assert.deepEqual(await syncedTabs(B), a, 'B stable');
}

test('history: a visit on A shows up in B history and archive', async () => {
  const url = pages.page('history-visit');
  // A separate window is not live-synced, so B only learns of the visit
  // through history sync.
  await A.run((u) => chrome.windows.create({ url: u, focused: false }), url);
  await waitFor(async () => (await B.run((u) => chrome.history.search({ text: '', startTime: 0, maxResults: 1000 }).then((r) => r.some((h) => h.url === u)), url)), { message: 'visit in B history', timeout: 15000 });
  const archive = await B.call('searchHistory', { text: 'history-visit' });
  assert.ok(archive.remote.some((e) => e.u === url && e.t), 'archived with title');
});

test('open tabs and send-tab between devices', async () => {
  await waitFor(async () => {
    const { devices } = await B.call('devicesTabs');
    return devices.some((d) => d.n === 'Device A' && d.w.some((w) => w.tabs.length));
  }, { message: 'B sees A open tabs', timeout: 15000 });

  const bId = await B.run(() => self.heliumSync.engine.deviceId);
  const url = pages.page('sent');
  await A.call('sendTab', { to: bId, url, title: 'Sent page' });
  await waitFor(async () => (await B.run((u) => chrome.tabs.query({}).then((ts) => ts.some((t) => (t.pendingUrl || t.url) === u)), url)), { message: 'tab opened on B' });
});

test('live tabs: a redirect on one device is not synced back', async () => {
  const from = pages.base + '/redirect/r1';
  const landed = pages.page('r1-landed');
  // Simulate a record from another device whose URL redirects here.
  await B.run(async (u) => {
    const lt = self.heliumSync.adapters.liveTabs;
    await lt.setLazy(false);
    await lt.applyRemote([{ coll: 'lt', id: 'redirecttest00000000000', seq: 0, data: { u, t: 'Redirect', pin: false, g: null, o: 'a0' } }]);
  }, from);
  await waitFor(async () => (await B.run((u) => chrome.tabs.query({}).then((ts) => ts.some((t) => t.url === u && t.status === 'complete')), landed)), { message: 'B landed after redirect' });
  await sleep(800);
  const entry = await B.run(() => self.heliumSync.adapters.liveTabs.model.get('redirecttest00000000000'));
  assert.equal(entry?.u, from, 'model keeps the original URL');
  const pending = await B.run(() => [...self.heliumSync.engine.outbox.values()].filter((e) => e.c === 'lt' && e.data?.u?.includes('landed')).length);
  assert.equal(pending, 0, 'landed URL not queued');
  await B.run(() => self.heliumSync.adapters.liveTabs.setLazy(true));
});
