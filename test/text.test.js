import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_THREAD, ONLY_MACOS, STARTING, pageOnThisSystem, panelText, plainError } from '../text.js';

test('the panel shows plain recovery text for every failure, never raw output', () => {
  for (const kind of ['start', 'missing', 'denied', 'port', 'timeout', 'stopped', 'folder']) {
    const text = panelText(/** @type {any} */ (kind));
    assert.match(text, /Try again/, kind);
    assert.doesNotMatch(text, /exit code|stderr|stdout|ENOENT|EADDRINUSE|Error|tkn|\/Users|\/private|\/tmp/, kind);
  }
  assert.match(panelText('missing'), /Shell Command/);
});

test('the panel says when there is no thread and when the system is unsupported', () => {
  assert.match(NO_THREAD, /Open a thread first/);
  assert.match(ONLY_MACOS, /macOS only/);
  assert.match(STARTING, /first start/);
});

test('the page is drawn on macOS only', () => {
  assert.equal(pageOnThisSystem('darwin'), true);
  assert.equal(pageOnThisSystem('macos'), true);
  assert.equal(pageOnThisSystem('linux'), false);
  assert.equal(pageOnThisSystem('win32'), false);
});

test('a denied power names the permission to approve, other errors keep their message', () => {
  const denied = plainError(new Error('program realpath is not granted for run'));
  assert.match(denied, /permission/);
  assert.doesNotMatch(denied, /not granted/);
  assert.equal(plainError(new Error('/work/a.ts is outside this thread\'s folder.')), '/work/a.ts is outside this thread\'s folder.');
  assert.equal(plainError('boom'), 'boom');
});
