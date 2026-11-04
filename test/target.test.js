import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelRequest, pinState } from '../target.js';

test('a panel request names a folder and its own token', () => {
  assert.deepEqual(panelRequest({ path: '/w/b', request: 'r1' }), { path: '/w/b', request: 'r1' });
  assert.equal(panelRequest({ path: '/w/b' }), null, 'a folder without a token is not a request');
  assert.equal(panelRequest({ request: 'r1' }), null);
  assert.equal(panelRequest({ path: 'relative', request: 'r1' }), null);
  assert.equal(panelRequest(null), null);
  assert.equal(panelRequest('r1'), null);
});

test('a new panel request pins its folder, and the same request is honoured once', () => {
  const state = { pin: null, honoured: '' };
  const request = { path: '/w/b', request: 'r1' };
  const pinned = pinState(state, request, 'thr_a');
  assert.deepEqual(pinned, { pin: { folder: '/w/b', threadId: 'thr_a' }, honoured: 'r1' });

  const again = pinState(pinned, request, 'thr_a');
  assert.equal(again, pinned, 'the same request changes nothing');
});

test('the pinned folder lasts while the thread on screen is the same, then the panel follows threads', () => {
  const pinned = { pin: { folder: '/w/b', threadId: 'thr_a' }, honoured: 'r1' };
  assert.equal(pinState(pinned, null, 'thr_a'), pinned);
  assert.deepEqual(pinState(pinned, null, 'thr_b'), { pin: null, honoured: 'r1' });
  assert.deepEqual(pinState({ pin: null, honoured: '' }, null, null), { pin: null, honoured: '' });
});

test('a newer request replaces the pin even on the same thread', () => {
  const pinned = { pin: { folder: '/w/b', threadId: 'thr_a' }, honoured: 'r1' };
  assert.deepEqual(pinState(pinned, { request: 'r2', path: '/w/c' }, 'thr_a'), {
    pin: { folder: '/w/c', threadId: 'thr_a' },
    honoured: 'r2',
  });
});
