// HTTP API client: account creation, sign-in and account management.
// Sync traffic itself goes over the WebSocket (connection.js).

import * as c from './crypto.js';

export class ApiError extends Error {
  constructor(status, kind, message) {
    super(message || kind || `HTTP ${status}`);
    this.status = status;
    this.kind = kind;
  }
}

export function normalizeServer(url) {
  let u = (url || '').trim();
  if (!u) throw new Error('Enter your server address.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('The server address must start with https://');
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/** True for addresses where plain HTTP is acceptable (this machine / LAN / Tailscale). */
export function isPrivateHost(server) {
  const h = new URL(server).hostname;
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.ts.net') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
    h === '[::1]'
  );
}

export async function request(server, path, { method = 'GET', token, body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError(0, 'network', ctl.signal.aborted ? 'The server did not respond in time.' : `Cannot reach ${server}. Check the address and that the server is running.`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error, data?.message || `Server error (${res.status})`);
  return data;
}

export async function serverInfo(server) {
  const info = await request(server, '/api/v1/info');
  if (info?.service !== 'helium-sync') throw new Error('That address is not a Helium Sync server.');
  return info;
}

/**
 * Creates an account. Returns the session plus the raw data key, which the
 * caller turns into record keys and then discards.
 */
export async function register(server, { username, password, invite, deviceName }) {
  const salt = c.randomBytes(16);
  const iterations = c.DEFAULT_ITERATIONS;
  const { authKey, kek } = await c.deriveAccountKeys(password, salt, iterations);
  const dataKey = c.randomBytes(32);
  const wrappedKey = await c.wrapDataKey(kek, dataKey);
  const s = await request(server, '/api/v1/register', {
    method: 'POST',
    body: { username, invite, salt: c.b64encode(salt), iterations, authKey: c.b64encode(authKey), wrappedKey: c.b64encode(wrappedKey), deviceName },
  });
  return { token: s.token, deviceId: s.deviceId, username: s.username, dataKey };
}

export async function login(server, { username, password, deviceName }) {
  const pre = await request(server, '/api/v1/prelogin', { method: 'POST', body: { username } });
  const { authKey, kek } = await c.deriveAccountKeys(password, c.b64decode(pre.salt), pre.iterations);
  const s = await request(server, '/api/v1/login', { method: 'POST', body: { username, authKey: c.b64encode(authKey), deviceName } });
  const dataKey = await c.unwrapDataKey(kek, c.b64decode(s.wrappedKey));
  return { token: s.token, deviceId: s.deviceId, username: s.username, dataKey };
}

/** Re-wraps the data key under a new password. Other devices are signed out. */
export async function changePassword(server, token, { username, oldPassword, newPassword }) {
  const pre = await request(server, '/api/v1/prelogin', { method: 'POST', body: { username } });
  const old = await c.deriveAccountKeys(oldPassword, c.b64decode(pre.salt), pre.iterations);
  const acct = await request(server, '/api/v1/account', { token });
  const dataKey = await c.unwrapDataKey(old.kek, c.b64decode(acct.wrappedKey));
  const salt = c.randomBytes(16);
  const next = await c.deriveAccountKeys(newPassword, salt, c.DEFAULT_ITERATIONS);
  const wrappedKey = await c.wrapDataKey(next.kek, dataKey);
  dataKey.fill(0);
  await request(server, '/api/v1/account/password', {
    method: 'POST',
    token,
    body: {
      authKey: c.b64encode(old.authKey),
      salt: c.b64encode(salt),
      iterations: c.DEFAULT_ITERATIONS,
      newAuthKey: c.b64encode(next.authKey),
      wrappedKey: c.b64encode(wrappedKey),
    },
  });
}

export async function deleteAccount(server, token, { username, password }) {
  const pre = await request(server, '/api/v1/prelogin', { method: 'POST', body: { username } });
  const { authKey } = await c.deriveAccountKeys(password, c.b64decode(pre.salt), pre.iterations);
  await request(server, '/api/v1/account/delete', { method: 'POST', token, body: { authKey: c.b64encode(authKey) } });
}
