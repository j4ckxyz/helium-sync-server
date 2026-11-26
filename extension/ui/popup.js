import { $, ago, favicon, h, host, safeUrl, send, stateChip } from './common.js';

let status = null;

function openPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

$('#open-settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});
$('#open-history').addEventListener('click', (e) => {
  e.preventDefault();
  openPage('ui/history.html');
});
$('#setup').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('#sync-now').addEventListener('click', async () => {
  status = await send('syncNow');
  render();
});
$('#live-here').addEventListener('click', async () => {
  const win = await chrome.windows.getCurrent();
  $('#live-here').disabled = true;
  status = await send('liveTabsUseWindow', { windowId: win.id });
  render();
});

async function render() {
  status = status || (await send('status'));
  $('#state').replaceChildren(stateChip(status.signedIn ? status.status.state : 'signed-out'));
  $('#signed-out').classList.toggle('hidden', status.signedIn);
  $('#main').classList.toggle('hidden', !status.signedIn);
  $('#sync-now').classList.toggle('hidden', !status.signedIn);
  $('#open-history').classList.toggle('hidden', !status.signedIn);
  if (!status.signedIn) return;

  const alert = $('#alert');
  const st = status.status;
  if (st.state === 'auth') {
    alert.className = 'notice error';
    alert.replaceChildren('This device was signed out. ', h('a', { href: '#', onclick: () => chrome.runtime.openOptionsPage() }, 'Sign in again'));
  } else if (st.error && st.state !== 'live') {
    alert.className = 'notice warn';
    alert.textContent = st.error;
  } else alert.className = 'notice hidden';

  // Live tabs
  const live = status.liveTabs;
  $('#live').classList.toggle('hidden', !live);
  if (live) {
    const win = await chrome.windows.getCurrent();
    const here = live.win === win.id;
    const what = live.mode === 'arc' ? 'pinned & grouped tabs' : 'all tabs';
    $('#live-desc').textContent = here
      ? `This window is live · ${live.tabs} tab${live.tabs === 1 ? '' : 's'} (${what})`
      : live.win != null
        ? `Another window is live · ${what}`
        : `Paused — no window is synced`;
    $('#live-here').classList.toggle('hidden', here);
    $('#live-here').disabled = false;
  }

  renderSend();
  renderExtensions();
  renderDevices();
}

async function renderSend() {
  if (!status.settings.types.sendTab) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^(https?|ftp):/.test(tab.url || '')) return;
  const targets = await send('sendTargets').catch(() => []);
  $('#send').classList.toggle('hidden', !targets.length);
  $('#send-targets').replaceChildren(
    ...targets.map((d) => {
      const b = h('button', { title: d.online ? 'Online' : 'Opens next time it is online' }, h('span', { class: `dot ${d.online ? 'on' : ''}` }), d.name);
      b.addEventListener('click', async () => {
        await send('sendTab', { to: d.id, url: tab.url, title: tab.title });
        b.classList.add('sent');
        b.lastChild.textContent = `${d.name} ✓`;
        b.disabled = true;
      });
      return b;
    }),
  );
}

async function renderExtensions() {
  const { missing, removed } = await send('extensions').catch(() => ({ missing: [], removed: [] }));
  $('#ext').classList.toggle('hidden', !missing.length && !removed.length);
  $('#ext-list').replaceChildren(
    ...missing.map((x) =>
      h(
        'div',
        { class: 'item' },
        h('span', { class: 'grow ellipsis' }, x.name),
        h('button', { class: 'small primary', onclick: () => chrome.tabs.create({ url: `https://chromewebstore.google.com/detail/${x.id}` }) }, 'Install'),
        h('button', { class: 'small', title: 'Stop syncing this extension on all devices', onclick: () => send('forgetExtension', { id: x.id }).then(renderExtensions) }, 'Forget'),
      ),
    ),
    ...removed.map((x) =>
      h(
        'div',
        { class: 'item' },
        h('span', { class: 'grow ellipsis' }, x.name, h('span', { class: 'muted small' }, ' · removed elsewhere')),
        h('button', { class: 'small danger', onclick: () => chrome.management.uninstall(x.id, { showConfirmDialog: true }).then(renderExtensions).catch(() => {}) }, 'Remove'),
        h('button', { class: 'small', onclick: () => send('dismissRemovedExtension', { id: x.id }).then(renderExtensions) }, 'Keep'),
      ),
    ),
  );
}

async function renderDevices() {
  const { devices, online } = await send('devicesTabs').catch(() => ({ devices: [], online: [] }));
  const list = devices.filter((d) => d.w?.some((w) => w.tabs.length));
  $('#devices').classList.toggle('hidden', !list.length);
  $('#device-list').replaceChildren(
    ...list.map((d, i) => {
      const tabs = d.w.flatMap((w) => w.tabs).filter((t) => safeUrl(t.u));
      return h(
        'details',
        { class: 'device', open: i === 0 },
        h('summary', {}, h('span', { class: `dot ${online.includes(d.id) ? 'on' : ''}` }), h('span', { class: 'grow ellipsis' }, d.n || 'Device'), h('span', { class: 'muted small' }, `${tabs.length} · ${ago(d.ts)}`)),
        ...tabs.slice(0, 60).map((t) =>
          h(
            'a',
            {
              class: 'tab',
              href: t.u,
              title: t.u,
              onclick: (e) => {
                e.preventDefault();
                chrome.tabs.create({ url: t.u, active: !e.metaKey && !e.ctrlKey });
              },
            },
            h('img', { class: 'fav', src: favicon(t.u), alt: '' }),
            h('span', { class: 'grow ellipsis' }, t.t || host(t.u)),
            t.p ? h('span', { class: 'pin' }, 'Pinned') : null,
          ),
        ),
      );
    }),
  );
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'status-changed') {
    send('status').then((s) => {
      status = s;
      $('#state').replaceChildren(stateChip(s.signedIn ? s.status.state : 'signed-out'));
    });
  }
});

render();
