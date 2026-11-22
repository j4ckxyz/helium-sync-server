import { $, ago, h, send, stateChip } from './common.js';

const TYPES = [
  ['bookmarks', 'Bookmarks', 'Folders and order included'],
  ['history', 'History', 'Visits from your other devices, plus a searchable archive'],
  ['liveTabs', 'Live tabs', 'Real-time tab mirroring between devices'],
  ['openTabs', 'Open tabs', 'See and open the tabs on your other devices'],
  ['extensions', 'Extensions', 'Installed list and on/off state'],
  ['readingList', 'Reading list', ''],
  ['sendTab', 'Send tab to device', 'Right-click a page or link'],
];

let mode = 'login';
let current = null;
let serverInfo = null;

async function render() {
  current = await send('status');
  $('#version').textContent = 'v' + chrome.runtime.getManifest().version;
  if (!current.signedIn) return renderSetup();
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderApp();
}

// ---------------------------------------------------------------------------
// Setup

function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === m));
  for (const el of document.querySelectorAll('.register-only')) el.classList.toggle('hidden', m !== 'register' || (el.id === 'invite-field' && serverInfo?.registration === 'open'));
  $('#auth-submit').textContent = m === 'register' ? 'Create account' : 'Sign in';
  $('#password').autocomplete = m === 'register' ? 'new-password' : 'current-password';
  $('#auth-error').classList.add('hidden');
}

async function checkServer() {
  const value = $('#server').value.trim();
  const warn = $('#auth-warning');
  warn.classList.add('hidden');
  serverInfo = null;
  if (!value) return;
  try {
    serverInfo = await send('serverInfo', { server: value });
    if (serverInfo.insecure) {
      warn.textContent = 'This server uses plain HTTP. Your data stays end-to-end encrypted, but your sign-in token could be intercepted. Use HTTPS unless this is a private network.';
      warn.classList.remove('hidden');
    }
    if (serverInfo.registration === 'closed' && mode === 'register') {
      warn.textContent = 'This server does not allow new accounts.';
      warn.classList.remove('hidden');
    }
    setMode(mode);
  } catch {
    /* reported on submit */
  }
}

function renderSetup() {
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  const preset = current.config?.serverUrl || current.session?.server || '';
  if (preset && !$('#server').value) {
    $('#server').value = preset;
    $('#server-fixed-url').textContent = preset.replace(/^https?:\/\//, '');
    $('#server-fixed').classList.remove('hidden');
    $('#server-field').classList.add('hidden');
  }
  if (current.session?.username) $('#username').value = current.session.username;
  if (current.session) {
    $('#setup-title').textContent = 'Sign in again';
  }
  checkServer();
}

$('#server-change').addEventListener('click', () => {
  $('#server-fixed').classList.add('hidden');
  $('#server-field').classList.remove('hidden');
  $('#server').focus();
});
$('#server').addEventListener('change', checkServer);
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setMode(b.dataset.mode));

$('#auth-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#auth-error');
  err.classList.add('hidden');
  const password = $('#password').value;
  if (mode === 'register') {
    if (password.length < 10) return showError('Use at least 10 characters. This password protects all your synced data.');
    if (password !== $('#password2').value) return showError('The passwords do not match.');
  }
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-progress').classList.remove('hidden');
  $('#auth-progress-text').textContent = mode === 'register' ? 'Creating encryption keys…' : 'Unlocking your data…';
  try {
    await send(mode, {
      server: $('#server').value,
      username: $('#username').value.trim(),
      password,
      invite: $('#invite').value.trim(),
      deviceName: $('#device-name').value.trim(),
    });
    $('#password').value = '';
    $('#password2').value = '';
    await render();
  } catch (e) {
    showError(e.kind === 'invalid_credentials' ? 'Wrong username or password.' : e.message);
  } finally {
    btn.disabled = false;
    $('#auth-progress').classList.add('hidden');
  }
  function showError(msg) {
    err.textContent = msg;
    err.classList.remove('hidden');
  }
});

// ---------------------------------------------------------------------------
// Signed in

function renderApp() {
  const s = current;
  $('#top-status').replaceChildren(stateChip(s.status.state));
  $('#acct-title').textContent = `${s.session.username} on ${s.session.server.replace(/^https?:\/\//, '')}`;
  const pending = s.pending ? ` · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : '';
  $('#acct-sub').textContent = `This device: ${s.session.deviceName} · last synced ${ago(s.status.lastSync)}${pending}`;
  const err = $('#sync-error');
  const problems = [s.status.state !== 'live' && s.status.error, ...(s.failed || []).map((f) => `Could not start ${f.coll}: ${f.error}`)].filter(Boolean);
  err.classList.toggle('hidden', !problems.length);
  err.textContent = problems.join(' · ');

  const unsupported = new Set(s.unsupported || []);
  const failed = new Map((s.failed || []).map((f) => [f.coll, f.error]));
  const types = $('#types');
  types.replaceChildren(
    ...TYPES.map(([key, label, hint]) =>
      h(
        'div',
        { class: 'item' },
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 't' }, label),
          unsupported.has(key) ? h('small', {}, 'Not available in this browser version') : hint ? h('small', {}, hint) : null,
        ),
        h(
          'label',
          { class: 'switch' },
          h('input', {
            type: 'checkbox',
            checked: s.settings.types[key] && !unsupported.has(key),
            disabled: unsupported.has(key),
            'aria-label': label,
            onchange: async (e) => {
              e.target.disabled = true;
              current = await send('setTypes', { types: { [key]: e.target.checked } });
              renderApp();
            },
          }),
          h('span'),
        ),
      ),
    ),
  );

  const live = s.liveTabs;
  $('#live-card').classList.toggle('hidden', !live);
  if (live) {
    for (const r of document.querySelectorAll('input[name=live-mode]')) r.checked = r.value === live.mode;
    $('#live-lazy').checked = live.lazy;
    $('#live-lazy').disabled = !live.lazyAvailable;
    $('#live-lazy-note').textContent = live.lazyAvailable ? '— saves memory' : `— needs Helium on Chromium 156 or newer (this is ${live.chromium || 'older'})`;
    $('#live-window').textContent = live.win != null ? `Syncing a window on this device · ${live.tabs} tab${live.tabs === 1 ? '' : 's'}` : 'No window is synced on this device right now.';
  }
  renderDevices();
}

for (const r of document.querySelectorAll('input[name=live-mode]')) {
  r.addEventListener('change', async () => {
    current = await send('liveTabsMode', { mode: r.value });
    renderApp();
  });
}
$('#live-lazy').addEventListener('change', async (e) => {
  current = await send('liveTabsLazy', { lazy: e.target.checked });
});
$('#live-use-window').addEventListener('click', async () => {
  const win = await chrome.windows.getCurrent();
  current = await send('liveTabsUseWindow', { windowId: win.id });
  renderApp();
});

async function renderDevices() {
  const box = $('#devices');
  let acct;
  try {
    acct = await send('account');
  } catch (e) {
    box.replaceChildren(h('div', { class: 'item muted' }, 'Device list unavailable offline.'));
    return;
  }
  const self = current.session.deviceId;
  box.replaceChildren(
    ...acct.devices.map((d) => {
      const online = acct.online.includes(d.id);
      const isSelf = d.id === self;
      const name = isSelf
        ? h('input', {
            type: 'text',
            class: 'device-name-input',
            value: d.name,
            maxlength: 64,
            'aria-label': 'This device name',
            onchange: (e) => send('renameDevice', { name: e.target.value }).then(render),
          })
        : h('div', { class: 'ellipsis' }, d.name);
      return h(
        'div',
        { class: 'item' },
        h('span', { class: `dot ${online ? 'on' : ''}`, title: online ? 'Online' : 'Offline' }),
        h('div', { class: 'grow' }, name, h('div', { class: 'muted small' }, isSelf ? 'This device' : `Last seen ${ago(d.lastSeen)}`)),
        isSelf
          ? null
          : h('button', {
              class: 'small danger',
              onclick: async () => {
                if (!confirm(`Sign out "${d.name}"? It stops syncing until you sign in on it again.`)) return;
                await send('revokeDevice', { id: d.id });
                renderDevices();
              },
            }, 'Sign out'),
      );
    }),
  );
}

$('#sync-now').addEventListener('click', async () => {
  current = await send('syncNow');
  renderApp();
});

$('#signout').addEventListener('click', async () => {
  if (!confirm('Sign out of Helium Sync on this device? Your bookmarks, history and tabs stay in Helium.')) return;
  await send('logout');
  location.reload();
});

$('#pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('#pw-msg');
  msg.className = 'notice hidden';
  if ($('#pw-new').value.length < 10) return show('error', 'Use at least 10 characters.');
  if ($('#pw-new').value !== $('#pw-new2').value) return show('error', 'The new passwords do not match.');
  try {
    await send('changePassword', { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value });
    ev.target.reset();
    show('info', 'Password changed. Sign in on your other devices with the new password.');
  } catch (e) {
    show('error', e.kind === 'invalid_credentials' ? 'The current password is wrong.' : e.message);
  }
  function show(kind, text) {
    msg.className = `notice ${kind}`;
    msg.textContent = text;
  }
});

$('#del-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!confirm('Permanently delete your Helium Sync account and all synced data?')) return;
  try {
    await send('deleteAccount', { password: $('#del-pw').value });
    location.reload();
  } catch (e) {
    $('#del-msg').textContent = e.kind === 'invalid_credentials' ? 'Wrong password.' : e.message;
    $('#del-msg').classList.remove('hidden');
  }
});

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'status-changed' && current?.signedIn) {
    send('status').then((s) => {
      if (!s.signedIn) return render();
      current = s;
      $('#top-status').replaceChildren(stateChip(s.status.state));
    });
  }
});

setMode('login');
render();
