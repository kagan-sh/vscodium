import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_MS, createPending } from '../pending.js';

test('only the latest request per thread is kept, and old ones are dropped', () => {
  const clock = { now: 0 };
  const queue = createPending(PENDING_MS, () => clock.now);
  queue.put('thr_1', 'open a.ts');
  queue.put('thr_1', 'open b.ts');
  queue.put('thr_2', 'open c.ts');
  assert.equal(queue.take('thr_1'), 'open b.ts');
  assert.equal(queue.take('thr_1'), null);
  assert.equal(queue.take('thr_2'), 'open c.ts');

  queue.put('thr_1', 'open a.ts');
  clock.now = PENDING_MS + 1;
  queue.put('thr_2', 'open d.ts');
  assert.equal(queue.size(), 1);
  assert.equal(queue.take('thr_1'), null);
});

test('a request is kept for ten minutes', () => {
  assert.equal(PENDING_MS, 10 * 60 * 1000);
});

test('a file request opens only on the thread that made it, and waits while another thread is on screen', () => {
  const queue = createPending(PENDING_MS);
  queue.put('thr_a', { path: '/w/a/src/a.ts', line: 3 });
  assert.equal(queue.take('thr_b'), null);
  assert.equal(queue.size(), 1);
  assert.deepEqual(queue.take('thr_a'), { path: '/w/a/src/a.ts', line: 3 });
  assert.equal(queue.size(), 0);
});
