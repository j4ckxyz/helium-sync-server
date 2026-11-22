// Records the README demo: two real Helium windows side by side on an X
// display, synced through a local server, with every action's measured
// propagation time.
//
//   DISPLAY=:77 HELIUM=/path/to/helium node test/demo/record.mjs OUT_DIR
//
// Needs an X server (e.g. Xvfb :77 -screen 0 1600x900x24) and ffmpeg. Writes
// OUT_DIR/raw.mp4, OUT_DIR/timeline.json (caption timings) and screenshots.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, sleep, waitFor, EXT } from '../e2e/harness.js';

const OUT = path.resolve(process.argv[2] || 'demo-out');
fs.mkdirSync(OUT, { recursive: true });
const W = 800;
const H = 900;

// --- a small demo website -------------------------------------------------
const SITES = {
  docs: ['Project docs', '#2563eb', 'D'],
  weather: ['Weather · Lisbon', '#0891b2', 'W'],
  recipes: ['Recipes · Pasta', '#ea580c', 'R'],
  calendar: ['Calendar', '#16a34a', 'C'],
  music: ['Music', '#c026d3', 'M'],
  news: ['Morning news', '#dc2626', 'N'],
};
function page(key) {
  const [title, color, letter] = SITES[key] || [key, '#475569', '?'];
  const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="${icon}">
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1f2937;background:#f8fafc}
header{background:linear-gradient(135deg,${color},${color}cc);color:#fff;padding:56px 40px}
h1{margin:0;font-size:34px}p{margin:8px 0 0;opacity:.9}main{padding:28px 40px;display:grid;gap:14px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;height:70px}</style></head>
<body><header><h1>${title}</h1><p>${key}.example — demo page</p></header><main><div class="card"></div><div class="card"></div><div class="card"></div></main></body></html>`;
}
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page(req.url.slice(1).split('?')[0]));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const url = (k) => `${base}/${k}`;

// --- browsers ---------------------------------------------------------------
async function open(name, x) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hs-demo-${name}-`));
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ bookmark_bar: { show_on_all_tabs: true } }));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: process.env.HELIUM,
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--test-type', // hides the --no-sandbox warning bar
      `--window-position=${x},0`,
      `--window-size=${W},${H}`,
      '--force-device-scale-factor=1',
      '--hide-crash-restore-bubble',
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  for (let i = 0; i < 100 && !(await sw.evaluate(() => !!self.heliumSync).catch(() => false)); i++) await sleep(100);
  const b = { name, dir, ctx, sw, run: (fn, arg) => b.sw.evaluate(fn, arg) };
  b.call = (type, payload = {}) => b.run(async ([t, p]) => (await self.heliumSync.ready(), self.heliumSync.handlers[t](p)), [type, payload]);
  return b;
}

const server = await startServer();
const [A, B] = await Promise.all([open('A', 0), open('B', W)]);
const creds = { username: 'demo', password: 'correct horse battery staple' };

// Wait out Helium's uBlock start-up network pause before filming.
for (const X of [A, B]) {
  const p = await X.ctx.newPage();
  const start = Date.now();
  for (let i = 0; Date.now() - start < 25000; i++) {
    const t = Date.now();
    await p.goto(url('docs') + '?warm' + i, { timeout: 30000 }).catch(() => {});
    if (Date.now() - t > 1500) break;
    await sleep(250);
  }
  await p.close();
}

await A.call('register', { server: server.url, ...creds, deviceName: 'MacBook Pro' });
await waitFor(() => A.run(() => self.heliumSync.engine?.status.state === 'live'), { timeout: 30000 });
await B.call('login', { server: server.url, ...creds, deviceName: 'Linux desktop' });
await waitFor(() => B.run(() => self.heliumSync.engine?.status.state === 'live'), { timeout: 30000 });
for (const X of [A, B]) await X.run(() => self.heliumSync.adapters.liveTabs.setLazy(false));

// Tidy each window: one synced start tab, no setup page.
const tabsOf = (X) =>
  X.run(async () => {
    const lt = self.heliumSync.adapters.liveTabs;
    const tabs = await chrome.tabs.query({ windowId: lt.win });
    const groups = await chrome.tabGroups.query({ windowId: lt.win });
    const gname = new Map(groups.map((g) => [g.id, g.title]));
    return tabs.sort((a, b) => a.index - b.index).map((t) => ({ u: t.pendingUrl || t.url, pin: t.pinned, g: gname.get(t.groupId) || null }));
  });
await waitFor(async () => (await A.run(() => self.heliumSync.adapters.liveTabs.win)) != null && (await B.run(() => self.heliumSync.adapters.liveTabs.win)) != null, { timeout: 30000 });
await A.run(async (u) => {
  const t = await chrome.tabs.create({ url: u, active: true });
  const others = (await chrome.tabs.query({ windowId: t.windowId })).filter((x) => x.id !== t.id);
  await chrome.tabs.remove(others.map((x) => x.id));
}, url('docs'));
await waitFor(async () => (await tabsOf(B)).some((t) => t.u === url('docs')), { timeout: 15000 });
await B.run(async (u) => {
  const all = await chrome.tabs.query({ currentWindow: true });
  const docs = all.find((t) => (t.pendingUrl || t.url) === u);
  await chrome.tabs.update(docs.id, { active: true });
  await chrome.tabs.remove(all.filter((t) => t.id !== docs.id).map((t) => t.id));
}, url('docs'));
await sleep(2500);

// --- record -----------------------------------------------------------------
const display = process.env.DISPLAY || ':77';
const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', `${2 * W}x${H}`, '-i', display, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', path.join(OUT, 'raw.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
await sleep(700);
const t0 = Date.now();
const timeline = [];

async function step(caption, actor, action, arg, seen) {
  const other = actor === A ? B : A;
  const start = Date.now();
  await actor.run(action, arg);
  await waitFor(async () => seen(await tabsOf(other), other), { interval: 5, timeout: 10000 });
  const ms = Date.now() - start;
  const from = actor === A ? 'Left' : 'Right';
  const to = actor === A ? 'right' : 'left';
  timeline.push({ at: (start - t0) / 1000, ms, text: `${from}: ${caption}  →  on the ${to} in ${ms} ms` });
  console.log(timeline.at(-1).text);
  await sleep(1800);
}

await sleep(1200);
await step('open a tab', A, (u) => chrome.tabs.create({ url: u, active: true }), url('weather'), (t) => t.some((x) => x.u === url('weather')));
await step('open a tab', A, (u) => chrome.tabs.create({ url: u, active: true }), url('recipes'), (t) => t.some((x) => x.u === url('recipes')));
await step('open a tab', B, (u) => chrome.tabs.create({ url: u, active: true }), url('calendar'), (t) => t.some((x) => x.u === url('calendar')));
await step('navigate', B, async (u) => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.update(t.id, { url: u });
}, url('music'), (t) => t.some((x) => x.u === url('music')));
await step('pin a tab', A, async (u) => {
  const [t] = await chrome.tabs.query({ url: u + '*' });
  await chrome.tabs.update(t.id, { pinned: true });
}, url('docs'), (t) => t.find((x) => x.u === url('docs'))?.pin);
await step('group two tabs', B, async ([w, r]) => {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const ids = tabs.filter((t) => [w, r].includes(t.pendingUrl || t.url)).map((t) => t.id);
  const g = await chrome.tabs.group({ tabIds: ids });
  await chrome.tabGroups.update(g, { title: 'Trip', color: 'green' });
}, [url('weather'), url('recipes')], (t) => t.filter((x) => x.g === 'Trip').length === 2);
await step('close a tab', A, async (u) => {
  const [t] = await chrome.tabs.query({ url: u + '*' });
  await chrome.tabs.remove(t.id);
}, url('recipes'), (t) => !t.some((x) => x.u === url('recipes')));
await step('bookmark a page', A, (u) => chrome.bookmarks.create({ parentId: '1', title: 'Pasta recipes', url: u }), url('recipes'), async (t, other) =>
  other.run(async () => (await chrome.bookmarks.search({ title: 'Pasta recipes' })).length > 0));
await sleep(800);

ffmpeg.stdin.write('q');
await new Promise((r) => ffmpeg.on('exit', r));
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2));

// Screenshots of the final state.
spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${2 * W}x${H}`, '-i', display, '-frames:v', '1', path.join(OUT, 'final.png')]).on('exit', async () => {
  const pg = await A.ctx.newPage();
  await pg.setViewportSize({ width: 360, height: 560 });
  await pg.goto(`chrome-extension://${new URL(A.sw.url()).host}/ui/popup.html`);
  await sleep(1500);
  await pg.screenshot({ path: path.join(OUT, 'popup.png') });
  await A.ctx.close();
  await B.ctx.close();
  await server.stop();
  site.close();
  for (const X of [A, B]) fs.rmSync(X.dir, { recursive: true, force: true });
  console.log('done', OUT);
});
