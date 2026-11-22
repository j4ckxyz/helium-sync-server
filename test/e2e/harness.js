// End-to-end harness: a real helium-sync server and real browsers (Helium if
// HELIUM is set, otherwise Chrome for Testing / Chromium via BROWSER) running
// the unpacked extension.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const EXT = path.join(ROOT, 'extension');

/** Helium's bundled uBlock Origin needs a warm-up; plain Chromium does not. */
function isHelium() {
  const p = browserPath();
  return /helium/i.test(path.basename(p)) || /helium-[\d.]+-/i.test(p) || fs.existsSync(path.join(path.dirname(p), 'helium'));
}

export function browserPath() {
  const p = process.env.HELIUM || process.env.BROWSER;
  if (!p) throw new Error('Set HELIUM (path to Helium/Chromium binary) or BROWSER to run e2e tests');
  return p;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer() {
  const bin = path.join(os.tmpdir(), `helium-sync-e2e-${process.pid}`);
  execFileSync(process.env.GO || 'go', ['build', '-o', bin, './cmd/helium-sync'], { cwd: ROOT, stdio: 'inherit' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-data-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let proc;
  const run = async () => {
    proc = spawn(bin, ['serve', '--addr', `127.0.0.1:${port}`, '--data', dir, '--registration', 'open', '--log-level', 'warn'], { stdio: ['ignore', 'inherit', 'inherit'] });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(url + '/healthz')).ok) break;
      } catch {}
      await sleep(100);
    }
  };
  const halt = async () => {
    if (proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
  };
  await run();
  // Never leave a server behind if the test run is interrupted.
  const reap = () => {
    try {
      proc.kill('SIGKILL');
    } catch {}
  };
  process.once('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (reap(), process.exit(130)));
  return {
    url,
    dir,
    bin,
    /** Stops the server process but keeps its data (simulates an outage). */
    halt,
    resume: run,
    async stop() {
      await halt();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(bin, { force: true });
    },
  };
}

export async function launch(name, profileDir, { warmup, args = [] } = {}) {
  if (warmup) process.env.HS_WARMUP_URL = warmup;
  const dir = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), `hs-${name}-`));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: browserPath(),
    // "New" headless runs extensions; before Chromium 132 plain --headless
    // meant the old mode, which does not.
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', ...args, ...(process.env.HS_EXTRA_ARGS ? process.env.HS_EXTRA_ARGS.split(' ') : [])],
    viewport: { width: 1000, height: 700 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  ctx._heliumSyncId = new URL(sw.url()).host;
  // The worker target can appear before its modules have finished loading.
  for (let i = 0; i < 100; i++) {
    if (await sw.evaluate(() => !!self.heliumSync).catch(() => false)) break;
    await sleep(100);
  }
  // Helium's built-in uBlock Origin holds all network requests for several
  // seconds while it starts, a few seconds after launch. Wait until that
  // stall has happened (or clearly is not going to) before testing.
  const warm = await ctx.newPage();
  if (process.env.HS_WARMUP_URL) {
    const start = Date.now();
    for (let i = 0; Date.now() - start < 25000; i++) {
      const t = Date.now();
      await warm.goto(process.env.HS_WARMUP_URL + '?' + i, { timeout: 30000 }).catch(() => {});
      if (Date.now() - t > 1500) break;
      if (!isHelium()) break;
      await sleep(250);
    }
  }
  await warm.close();
  const b = {
    name,
    dir,
    ctx,
    sw,
    restarts: 0,
    /**
     * Runs fn in the extension service worker. MV3 browsers stop and restart
     * the worker whenever they like; follow it to its new instance (the
     * extension must cope with that, and the tests exercise it).
     */
    async run(fn, arg) {
      for (let i = 0; ; i++) {
        try {
          return await b.sw.evaluate(fn, arg);
        } catch (e) {
          if (i >= 3 || !/closed|destroyed|Target/i.test(e.message)) throw e;
          b.sw = await currentWorker(b.ctx);
          b.restarts++;
          for (let j = 0; j < 100; j++) {
            if (await b.sw.evaluate(() => !!self.heliumSync).catch(() => false)) break;
            await sleep(100);
          }
        }
      }
    },
    async call(type, payload = {}) {
      return b.run(async ([type, payload]) => {
        await self.heliumSync.ready();
        return self.heliumSync.handlers[type](payload);
      }, [type, payload]);
    },
    async close() {
      await b.ctx.close();
    },
    /** Closes the browser and starts it again on the same profile. */
    async restart(opts = {}) {
      await b.ctx.close().catch(() => {});
      const nb = await launch(name, dir, opts);
      Object.assign(b, { ctx: nb.ctx, sw: nb.sw });
      return b;
    },
    async wipe() {
      await b.ctx.close().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return b;
}

/** The extension's live service worker, waking it if it is stopped. */
async function currentWorker(ctx) {
  const live = ctx.serviceWorkers().filter((w) => w.url().startsWith('chrome-extension://'));
  if (live.length) return live[live.length - 1];
  const next = ctx.waitForEvent('serviceworker', { timeout: 15000 });
  // Opening an extension page starts the worker again.
  const id = ctx._heliumSyncId;
  if (id) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${id}/ui/popup.html`).catch(() => {});
    setTimeout(() => p.close().catch(() => {}), 2000);
  }
  return next;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls fn until it returns a truthy value. */
export async function waitFor(fn, { timeout = 10000, interval = 25, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${message}; last: ${JSON.stringify(last instanceof Error ? last.message : last)}`);
}

export async function waitLive(b) {
  return waitFor(() => b.run(() => self.heliumSync.engine?.status.state === 'live'), { message: `${b.name} live`, timeout: 20000 });
}

/** Tabs of a browser's synced window, in order. */
export function syncedTabs(b) {
  return b.run(async () => {
    const lt = self.heliumSync.adapters.liveTabs;
    if (lt.win == null) return null;
    const tabs = await chrome.tabs.query({ windowId: lt.win });
    const groups = await chrome.tabGroups.query({ windowId: lt.win });
    const gname = new Map(groups.map((g) => [g.id, `${g.title}/${g.color}`]));
    return tabs
      .sort((a, b) => a.index - b.index)
      .filter((t) => !/^(chrome-extension:|about:blank|chrome:\/\/newtab)/.test(t.pendingUrl || t.url)) // unsynced tabs
      .map((t) => ({ u: t.pendingUrl || t.url, pin: t.pinned, g: t.groupId === -1 ? null : gname.get(t.groupId) }));
  });
}

/** A tiny local site so tests do not depend on the internet. */
export async function startPages() {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/redirect/')) {
      res.writeHead(302, { Location: '/p/' + u.pathname.slice(10) + '-landed' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>Page ${u.pathname.slice(3)}</title><h1>${u.pathname}</h1>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, page: (n) => `${base}/p/${n}`, close: () => new Promise((r) => srv.close(r)) };
}
