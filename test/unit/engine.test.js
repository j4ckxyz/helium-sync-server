import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../../extension/src/engine.js';

function engine() {
  const e = new Engine();
  e.persistOutbox = () => {};
  e.changed = () => {};
  return e;
}

test('loop breaker leaves normal editing alone and throttles runaway records', () => {
  const e = engine();
  for (let i = 0; i < 120; i++) e.write('lt', 'tab', { i });
  assert.equal(e.outbox.get('lt\u0000tab').hold, 0, '120 writes in a minute are fine');
  e.write('lt', 'tab', { i: 121 });
  assert.ok(e.outbox.get('lt\u0000tab').hold > Date.now(), 'the 121st is held back');
  assert.equal(e.outbox.size, 1, 'only the latest state is kept');
  e.write('lt', 'other', { x: 1 });
  assert.equal(e.outbox.get('lt\u0000other').hold, 0, 'other records are unaffected');
});

test('deletions are never held back', () => {
  const e = engine();
  for (let i = 0; i < 200; i++) e.write('lt', 'tab', { i });
  e.remove('lt', 'tab');
  const entry = e.outbox.get('lt\u0000tab');
  assert.equal(entry.del, true);
  assert.equal(entry.hold, 0);
});
