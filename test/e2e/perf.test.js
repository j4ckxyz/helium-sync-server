// Performance checks (opt-in: HS_PERF=1). Prints timings; asserts generous
// upper bounds so regressions show up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startPages, launch, waitFor, waitLive, syncedTabs, sleep } from './harness.js';

const enabled = !!process.env.HS_PERF;
let server, pages, A, B;

before(async () => {
  if (!enabled) return;
  server = await startServer();
  pages = await startPages();
  [A, B] = await Promise.all([launch('A', null, { warmup: pages.page('w') }), launch('B', null, { warmup: pages.page('w') })]);
  await A.call('register', { server: server.url, username: 'perf', password: 'correct horse battery staple', deviceName: 'A' });
  await waitLive(A);
  await B.call('login', { server: server.url, username: 'perf', password: 'correct horse battery staple', deviceName: 'B' });
  await waitLive(B);
});

after(async () => {
  if (!enabled) return;
  await Promise.allSettled([A?.wipe(), B?.wipe()]);
  await server?.stop();
  await pages?.close();
});

const countBookmarks = (b) =>
  b.run(async () => {
    const [root] = await chrome.bookmarks.getTree();
    let n = 0;
    const walk = (x) => {
      if (x.url) n++;
      (x.children || []).forEach(walk);
    };
    walk(root);
    return n;
  });

test('5,000 bookmarks in 50 folders reach another device', { skip: !enabled }, async () => {
  const t0 = Date.now();
  await A.run(async () => {
    for (let f = 0; f < 50; f++) {
      const folder = await chrome.bookmarks.create({ parentId: '2', title: `Folder ${f}` });
      await Promise.all(Array.from({ length: 100 }, (_, i) => chrome.bookmarks.create({ parentId: folder.id, title: `Bookmark ${f}-${i}`, url: `https://example.com/${f}/${i}` })));
    }
  });
  const created = Date.now() - t0;
  await waitFor(async () => (await countBookmarks(B)) >= 5000, { timeout: 120000, interval: 250, message: 'B has 5000 bookmarks' });
  const total = Date.now() - t0;
  console.log(`  bookmarks: created locally in ${created} ms; on device B after ${total} ms (${Math.round(5000 / (total / 1000))} bookmarks/s end-to-end)`);
  assert.ok(total < 120000);
});

test('history backfill of 5,000 visits', { skip: !enabled }, async () => {
  // A fresh device: seed history, then enable history sync from scratch.
  await A.call('setTypes', { types: { history: false } });
  await A.run(async () => {
    for (let i = 0; i < 5000; i += 250) {
      await Promise.all(Array.from({ length: 250 }, (_, j) => chrome.history.addUrl({ url: `https://history.example.com/page/${i + j}` })));
    }
  });
  const t0 = Date.now();
  await A.call('setTypes', { types: { history: true } });
  await waitFor(async () => (await B.call('searchHistory', { text: 'history.example.com' })).remote.length >= 300, { timeout: 120000, interval: 500, message: 'B archive' });
  await waitFor(() => A.run(() => self.heliumSync.adapters.history.init && self.heliumSync.engine.outboxSize() === 0), { timeout: 120000, interval: 250, message: 'A uploaded' });
  console.log(`  history: 5,000 visits encrypted and uploaded in ${Date.now() - t0} ms`);
});

test('live tab propagation latency (20 samples)', { skip: !enabled }, async () => {
  await waitFor(async () => (await syncedTabs(A)) && (await syncedTabs(B)));
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const url = pages.page(`lat-${i}`);
    const t0 = Date.now();
    await A.run((u) => chrome.tabs.create({ url: u, active: false }), url);
    await waitFor(async () => (await syncedTabs(B)).some((t) => t.u === url), { interval: 5, message: 'tab on B' });
    samples.push(Date.now() - t0);
    await sleep(100);
  }
  samples.sort((a, b) => a - b);
  const p = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  console.log(`  live tabs A→B: median ${p(0.5)} ms, p90 ${p(0.9)} ms, max ${samples.at(-1)} ms`);
  assert.ok(p(0.5) < 500, 'median under 500 ms');
});
