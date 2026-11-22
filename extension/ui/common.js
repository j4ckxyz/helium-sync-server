export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from Helium Sync');
  if (!res.ok) throw Object.assign(new Error(res.error), { kind: res.kind });
  return res.data;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(ts).toLocaleDateString();
}

export const STATE = {
  live: ['ok', 'Up to date'],
  syncing: ['busy', 'Syncing…'],
  connecting: ['busy', 'Connecting…'],
  offline: ['warn', 'Offline — retrying'],
  error: ['danger', 'Error'],
  auth: ['danger', 'Signed out'],
  'signed-out': ['', 'Not set up'],
};

export function stateChip(state) {
  const [cls, label] = STATE[state] || ['', state];
  return h('span', { class: `chip ${cls}` }, label);
}

/** Only web URLs from other devices become links or tabs. */
export function safeUrl(url) {
  return typeof url === 'string' && /^(https?|ftp):\/\//i.test(url) ? url : null;
}

export function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
