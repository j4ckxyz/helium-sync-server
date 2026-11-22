import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBetween, keysBetween, lis, reorder, compareOrder } from '../../extension/src/lib/order.js';

test('keyBetween produces keys strictly between bounds', () => {
  const ks = keysBetween(null, null, 20);
  const cases = [[null, null], [ks[0], null], [null, ks[0]], [ks[3], ks[4]], [ks[3], keyBetween(ks[3], ks[4])], ['a0', 'a1'], ['Zz', 'a0'], ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null]];
  for (const [a, b] of cases) {
    const k = keyBetween(a, b);
    if (a !== null) assert.ok(k > a, `${k} > ${a}`);
    if (b !== null) assert.ok(k < b, `${k} < ${b}`);
  }
});

test('invalid or tied keys from other devices do not throw', () => {
  for (const [a, b] of [['V', null], ['!!', 'a0'], ['a1', 'a1'], ['a2', 'a1'], [null, 'a10']]) {
    const k = keyBetween(a, b);
    assert.equal(typeof k, 'string');
  }
});

test('repeated appends and prepends stay short', () => {
  let k = null;
  for (let i = 0; i < 5000; i++) {
    const n = keyBetween(k, null);
    assert.ok(k === null || n > k);
    k = n;
  }
  assert.ok(k.length <= 4, `append key length ${k.length}`);
  k = null;
  for (let i = 0; i < 5000; i++) {
    const n = keyBetween(null, k);
    assert.ok(k === null || n < k);
    k = n;
  }
  assert.ok(k.length <= 4, `prepend key length ${k.length}`);
});

test('repeated inserts at the same spot stay ordered', () => {
  let lo = 'a0';
  const hi = 'a1';
  const keys = [];
  for (let i = 0; i < 100; i++) {
    lo = keyBetween(lo, hi);
    keys.push(lo);
  }
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.every((k) => k > 'a0' && k < 'a1'));
});

test('keysBetween is ordered, unique and short for bulk inserts', () => {
  for (const [a, b] of [[null, null], ['a5', null], ['a5', 'a6'], [null, 'a0']]) {
    const ks = keysBetween(a, b, 1000);
    assert.equal(ks.length, 1000);
    for (let i = 1; i < ks.length; i++) assert.ok(ks[i - 1] < ks[i], `${ks[i - 1]} < ${ks[i]}`);
    if (a) assert.ok(ks[0] > a);
    if (b) assert.ok(ks.at(-1) < b);
    assert.ok(Math.max(...ks.map((k) => k.length)) <= 6, `bulk keys stay short: ${Math.max(...ks.map((k) => k.length))}`);
  }
});

test('lis finds a longest increasing subsequence', () => {
  assert.deepEqual(lis([]), []);
  const seq = [3, 1, 2, 5, 4, 6];
  const out = lis(seq).map((i) => seq[i]);
  assert.equal(out.length, 4);
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1] < out[i]);
});

test('reorder only rekeys moved and new items', () => {
  const ks = keysBetween(null, null, 5); // a b c d e
  const items = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, o: ks[i] }));
  // Move e to the front, insert x after c.
  const local = [items[4], items[0], items[1], items[2], { id: 'x' }, items[3]];
  const changed = reorder(local);
  assert.deepEqual([...changed.keys()].sort(), ['e', 'x']);
  const final = local.map((it) => ({ id: it.id, o: changed.get(it.id) ?? it.o }));
  const sorted = [...final].sort(compareOrder).map((it) => it.id);
  assert.deepEqual(sorted, ['e', 'a', 'b', 'c', 'x', 'd']);
});

test('reorder keys a fresh list in order', () => {
  const local = Array.from({ length: 50 }, (_, i) => ({ id: 'n' + i }));
  const changed = reorder(local);
  assert.equal(changed.size, 50);
  const keys = local.map((it) => changed.get(it.id));
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
});
