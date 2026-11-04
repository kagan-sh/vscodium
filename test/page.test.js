import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorPageUrl } from '../page.js';

const token = 'ab'.repeat(16);

test('the page address stays on this machine and names the folder', () => {
  const url = new URL(editorPageUrl({ port: 47321, token, folder: '/work/app' }));
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '47321');
  assert.equal(url.searchParams.get('tkn'), token);
  assert.equal(url.searchParams.get('folder'), '/work/app');
  assert.equal(url.searchParams.get('payload'), null);
});

test('a file open asks the page to jump to the line and column', () => {
  const url = new URL(editorPageUrl({
    port: 47321,
    token,
    folder: '/work/app',
    file: '/work/app/src/a.js',
    line: 42,
    column: 7,
  }));
  const payload = JSON.parse(url.searchParams.get('payload') ?? '');
  assert.deepEqual(payload, [
    ['openFile', 'vscode-remote://127.0.0.1:47321/work/app/src/a.js:42:7'],
    ['gotoLineMode', 'true'],
  ]);
});

test('a file name with # ? % or : stays part of the file name', () => {
  const file = '/work/app/notes #1?/50%: draft.md';
  const url = new URL(editorPageUrl({ port: 47321, token, folder: '/work/app', file, line: 3 }));
  const [[, address]] = JSON.parse(url.searchParams.get('payload') ?? '');
  assert.equal(address, 'vscode-remote://127.0.0.1:47321/work/app/notes%20%231%3F/50%25%3A%20draft.md:3');
  assert.equal(new URL(address).hash, '');
  assert.equal(new URL(address).search, '');
});

test('a page with no workspace is refused', () => {
  assert.throws(() => editorPageUrl({ port: 47321, token, folder: '' }), /no workspace folder/);
});

test('a bad line or column is refused', () => {
  assert.throws(() => editorPageUrl({ port: 47321, token, folder: '/work/app', file: '/work/app/a.js', line: 0 }), /line/);
  assert.throws(
    () => editorPageUrl({ port: 47321, token, folder: '/work/app', file: '/work/app/a.js', line: 1, column: 0 }),
    /column/,
  );
  assert.throws(
    () => editorPageUrl({ port: 47321, token, folder: '/work/app', file: '/work/app/a.js', column: 2 }),
    /column needs a line/,
  );
});
