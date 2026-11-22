import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startPages, launch, waitFor, waitLive, syncedTabs, sleep } from './harness.js';

let server, pages;
const creds = { username: 'life', password: 'correct horse battery staple' };
const opened = [];

before(async () => {
  server = await startServer();
  pages = await startPages();
});

after(async () => {
  await Promise.allSettled(opened.map((b) => b.wipe()));
  await server?.stop();
  await pages?.close();
});

async function open(name, args) {
  const b = await launch(name, null, { warmup: pages.page('warmup'), args });
  opened.push(b);
  return b;
}

const barOf = (b) =>
  b.run(async () => {
    const [root] = await chrome.bookmarks.getTree();
    const bar = root.children.find((c) => c.folderType === 'bookmarks-bar' || c.id === '1');
    const dump = (n) => (n.url ? `${n.title}<${n.url}>` : { [n.title]: (n.children || []).map(dump) });
    return JSON.stringify((bar.children || []).map(dump));
  });

const seedBookmarks = (b, extra) =>
  b.run(async (extra) => {
    const f = await chrome.bookmarks.create({ parentId: '1', title: 'Shared' });
    for (const n of ['a', 'b', 'c']) await chrome.bookmarks.create({ parentId: f.id, title: n.toUpperCase(), url: `https://${n}.example.com/` });
    if (extra) await chrome.bookmarks.create({ parentId: '1', title: extra, url: `https://${extra}.example.com/` });
  }, extra);

let A, B, C;

test('first sync merges identical bookmarks instead of duplicating them', async () => {
  A = await open('A', ['--restore-last-session']);
  B = await open('B', ['--restore-last-session']);
  await seedBookmarks(A, 'onlyA');
  await seedBookmarks(B, 'onlyB');
  await A.call('register', { server: server.url, ...creds, deviceName: 'A' });
  await waitLive(A);
  await B.call('login', { server: server.url, ...creds, deviceName: 'B' });
  await waitLive(B);
  const want = (bar) => {
    const v = JSON.parse(bar);
    const shared = v.filter((x) => typeof x === 'object' && x.Shared);
    return shared.length === 1 && shared[0].Shared.length === 3 && bar.includes('onlyA') && bar.includes('onlyB');
  };
  await waitFor(async () => want(await barOf(B)) && want(await barOf(A)), { message: 'merged bookmarks on both', timeout: 20000 });
  assert.equal(await barOf(A), await barOf(B));
});

test('edits made while the server is down sync once it is back', async () => {
  await server.halt();
  await waitFor(() => A.run(() => self.heliumSync.engine.status.state !== 'live'), { message: 'A notices outage' });
  await A.run(async () => {
    const [onlyA] = await chrome.bookmarks.search({ title: 'onlyA' });
    await chrome.bookmarks.update(onlyA.id, { title: 'renamed offline' });
  });
  await sleep(500);
  const pending = await A.run(() => self.heliumSync.engine.outboxSize());
  assert.ok(pending >= 1, 'change waits in the outbox');
  await server.resume();
  await A.run(() => self.heliumSync.engine.kick());
  await B.run(() => self.heliumSync.engine.kick());
  await waitFor(async () => (await barOf(B)).includes('renamed offline'), { message: 'offline edit reaches B', timeout: 30000 });
});

test('a device that restarts re-attaches to its tabs without duplicating them', async () => {
  const urls = (tabs) => tabs.map((t) => t.u).filter((u) => u.startsWith(pages.base));
  await waitFor(async () => (await syncedTabs(A)) && (await syncedTabs(B)), { message: 'attached' });
  await A.run(async ([x, y]) => {
    await chrome.tabs.create({ url: x, active: false });
    await chrome.tabs.create({ url: y, active: false });
  }, [pages.page('x'), pages.page('y')]);
  await waitFor(async () => urls(await syncedTabs(B)).length === 2, { message: 'B has x and y' });
  await sleep(1500); // let B persist its state

  // B goes away; meanwhile A closes y and opens z.
  await B.close();
  await A.run(async ([y, z]) => {
    const [t] = await chrome.tabs.query({ url: y });
    await chrome.tabs.remove(t.id);
    await chrome.tabs.create({ url: z, active: false });
  }, [pages.page('y'), pages.page('z')]);
  await waitFor(async () => JSON.stringify(urls(await syncedTabs(A))) === JSON.stringify([pages.page('x'), pages.page('z')]), { message: 'A has x, z' });

  // B comes back with its old session restored.
  await B.restart({ warmup: pages.page('warmup'), args: ['--restore-last-session'] });
  await waitLive(B);
  await waitFor(async () => {
    const t = await syncedTabs(B);
    return t && JSON.stringify(urls(t)) === JSON.stringify([pages.page('x'), pages.page('z')]);
  }, { message: 'B converged to x, z without duplicates', timeout: 30000 }).catch(async (e) => {
    console.log('B tabs', JSON.stringify(await syncedTabs(B)));
    console.log('B all', JSON.stringify(await B.run(async () => (await chrome.tabs.query({})).map((t) => [t.windowId, t.index, t.pendingUrl || t.url]))));
    console.log('B lt', JSON.stringify(await B.run(() => ({ win: self.heliumSync.adapters.liveTabs.win, needs: self.heliumSync.adapters.liveTabs.needsAttach, model: [...self.heliumSync.adapters.liveTabs.model.values()].map((e) => e.u), map: [...self.heliumSync.adapters.liveTabs.tabUid] }))));
    console.log('A tabs', JSON.stringify(await syncedTabs(A)));
    throw e;
  });
  await sleep(2000);
  assert.deepEqual(urls(await syncedTabs(A)), [pages.page('x'), pages.page('z')], 'A unchanged by B restart');
  assert.deepEqual(urls(await syncedTabs(B)), [pages.page('x'), pages.page('z')]);
});

test('a third device joins and catches up quickly', async () => {
  C = await open('C');
  const t0 = Date.now();
  await C.call('login', { server: server.url, ...creds, deviceName: 'C' });
  await waitLive(C);
  await waitFor(async () => (await barOf(C)) === (await barOf(A)), { message: 'C bookmarks', timeout: 20000 });
  console.log(`  third device fully synced in ${Date.now() - t0} ms (includes key derivation)`);
});
