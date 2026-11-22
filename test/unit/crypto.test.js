import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../extension/src/lib/crypto.js';

test('account keys are deterministic and independent', async () => {
  const salt = c.randomBytes(16);
  const a = await c.deriveAccountKeys('correct horse', salt, 1000);
  const b = await c.deriveAccountKeys('correct horse', salt, 1000);
  const d = await c.deriveAccountKeys('correct horsf', salt, 1000);
  assert.deepEqual(a.authKey, b.authKey);
  assert.notDeepEqual(a.authKey, d.authKey);
  assert.equal(a.authKey.length, 32);

  // The kek from the same password unwraps; a different password does not.
  const dataKey = c.randomBytes(32);
  const wrapped = await c.wrapDataKey(a.kek, dataKey);
  assert.deepEqual(await c.unwrapDataKey(b.kek, wrapped), dataKey);
  await assert.rejects(c.unwrapDataKey(d.kek, wrapped), /password/);
});

test('NFKC normalisation makes equivalent passwords match', async () => {
  const salt = c.randomBytes(16);
  const a = await c.deriveAccountKeys('café', salt, 1000);
  const b = await c.deriveAccountKeys('café', salt, 1000);
  assert.deepEqual(a.authKey, b.authKey);
});

test('records round-trip and are bound to their id', async () => {
  const keys = await c.deriveDataKeys(c.randomBytes(32));
  const obj = { u: 'https://example.com/ü', t: 'Example', n: [1, 2] };
  const ct = await c.encryptRecord(keys, 'bm', 'abc', obj);
  assert.equal(ct[0], 1, 'small records stay plain JSON');
  assert.deepEqual(await c.decryptRecord(keys, 'bm', 'abc', ct), obj);
  await assert.rejects(c.decryptRecord(keys, 'bm', 'abd', ct));
  await assert.rejects(c.decryptRecord(keys, 'h', 'abc', ct));
  const ct2 = await c.encryptRecord(keys, 'bm', 'abc', obj);
  assert.notDeepEqual(ct, ct2, 'fresh IV per encryption');
  const other = await c.deriveDataKeys(c.randomBytes(32));
  await assert.rejects(c.decryptRecord(other, 'bm', 'abc', ct));
});

test('opaque ids are stable, url-safe and key-dependent', async () => {
  const dk = c.randomBytes(32);
  const k1 = await c.deriveDataKeys(dk);
  const k2 = await c.deriveDataKeys(dk);
  const k3 = await c.deriveDataKeys(c.randomBytes(32));
  const id = await c.opaqueId(k1, 'h:https://example.com/');
  assert.equal(id, await c.opaqueId(k2, 'h:https://example.com/'));
  assert.notEqual(id, await c.opaqueId(k3, 'h:https://example.com/'));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
});

test('base64 helpers handle large buffers', () => {
  const big = c.randomBytes(200000);
  assert.deepEqual(c.b64decode(c.b64encode(big)), big);
});

test('large records are compressed and still round-trip', async () => {
  const keys = await c.deriveDataKeys(c.randomBytes(32));
  const obj = { w: [{ tabs: Array.from({ length: 50 }, (_, i) => ({ u: `https://example.com/page/${i}`, t: `Example page number ${i}` })) }] };
  const plain = new TextEncoder().encode(JSON.stringify(obj)).length;
  const ct = await c.encryptRecord(keys, 'dev', 'x', obj);
  assert.equal(ct[0], 2);
  assert.ok(ct.length < plain / 2, `${ct.length} bytes vs ${plain} plain`);
  assert.deepEqual(await c.decryptRecord(keys, 'dev', 'x', ct), obj);
});

test('records from a newer format are rejected as unsupported, not misread', async () => {
  const keys = await c.deriveDataKeys(c.randomBytes(32));
  const ct = await c.encryptRecord(keys, 'bm', 'a', { t: 'x' });
  ct[0] = 9;
  await assert.rejects(c.decryptRecord(keys, 'bm', 'a', ct), c.UnsupportedFormat);
});
