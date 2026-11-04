import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  FIRST_PORT,
  PENDING_MS,
  PORT_SPAN,
  beginToolLaunch,
  connectionToken,
  createPending,
  editorPageUrl,
  endToolLaunch,
  failureText,
  insideFolder,
  laterText,
  movePanel,
  notFoundText,
  openPosition,
  openedWhere,
  openingText,
  pageOnThisSystem,
  portBusy,
  portOrder,
  requestForScreen,
  resolveOpenPath,
  serverFolders,
  scrub,
  serveWebArgs,
  versionReady,
  versionUrl,
} from './editor.js';

const token = 'ab'.repeat(16);

test('serve-web listens on this machine with a connection token', () => {
  assert.deepEqual(serveWebArgs({ port: 47321, token, dataDir: '/tmp/editor-data', cliDir: '/tmp/editor-cli' }), [
    'serve-web',
    '--host', '127.0.0.1',
    '--port', '47321',
    '--connection-token', token,
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--log', 'off',
    '--server-data-dir', '/tmp/editor-data',
    '--cli-data-dir', '/tmp/editor-cli',
  ]);
});

test('a bad port or token is refused', () => {
  assert.throws(() => serveWebArgs({ port: 0, token }), /port/);
  assert.throws(() => serveWebArgs({ port: 47321, token: 'short' }), /token/);
  assert.throws(() => serveWebArgs({ port: 47321, token, dataDir: 'relative' }), /absolute path/);
});

test('the connection token is hex from the random bytes', () => {
  const bytes = new Uint8Array(16);
  bytes[0] = 0x0a;
  bytes[15] = 0xff;
  assert.equal(connectionToken(bytes), '0a0000000000000000000000000000ff');
  assert.throws(() => connectionToken(new Uint8Array(8)), /16 random bytes/);
});

test('server files stay in the plugin data folder', () => {
  assert.deepEqual(serverFolders('/data/plugins/vscodium/data/'), {
    dataDir: '/data/plugins/vscodium/data/server',
    cliDir: '/data/plugins/vscodium/data/cli',
  });
  assert.throws(() => serverFolders(undefined), /data folder is missing/);
});

test('the saved port is tried first when it is granted, then the rest once each', () => {
  assert.deepEqual(portOrder(FIRST_PORT + 2), [FIRST_PORT + 2, FIRST_PORT, FIRST_PORT + 1]);
  assert.equal(portOrder(FIRST_PORT).length, PORT_SPAN);
  assert.deepEqual(portOrder('nope'), [FIRST_PORT, FIRST_PORT + 1, FIRST_PORT + 2]);
  assert.deepEqual(portOrder(FIRST_PORT + 99), [FIRST_PORT, FIRST_PORT + 1, FIRST_PORT + 2]);
});

test('the page address stays on this machine and names the folder', () => {
  const url = new URL(editorPageUrl({ port: 47321, token, folder: '/work/app' }));
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '47321');
  assert.equal(url.searchParams.get('tkn'), token);
  assert.equal(url.searchParams.get('folder'), '/work/app');
  assert.equal(url.searchParams.get('payload'), null);
  assert.equal(versionUrl(47321), 'http://127.0.0.1:47321/version');
  assert.equal(versionReady(200), true);
  assert.equal(versionReady(403), false);
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

test('a line and a column have to be whole numbers, and a column needs a line', () => {
  assert.deepEqual(openPosition(null, null), {});
  assert.deepEqual(openPosition(4, undefined), { line: 4 });
  assert.throws(() => openPosition(0, undefined), /line/);
  assert.throws(() => openPosition(undefined, 2), /column needs a line/);
  assert.equal(openedWhere('/a.js', 4, 2), '/a.js:4:2');
  assert.equal(openingText('/a.js:4', true), 'Opened /a.js:4.');
  assert.match(openingText('/a.js:4', false), /first start/);
});

test('a busy port is not a missing editor', () => {
  assert.equal(portBusy('could not start server on the given host/port: Address already in use (os error 48)'), true);
  assert.equal(portBusy('Error: listen EADDRINUSE: address already in use 127.0.0.1:47321'), true);
  assert.equal(portBusy('Web UI available at http://127.0.0.1:47321'), false);
});

test('a failure hides the connection token', () => {
  const text = failureText(`refused token ${token}`, 1, token);
  assert.match(text, /did not start/);
  assert.equal(text.includes(token), false);
  assert.equal(scrub(`see ${token}`, token).includes(token), false);
});

test('the page is drawn on macOS only', () => {
  assert.equal(pageOnThisSystem('darwin'), true);
  assert.equal(pageOnThisSystem('macos'), true);
  assert.equal(pageOnThisSystem('linux'), false);
  assert.equal(pageOnThisSystem('win32'), false);
});

test('a missing codium command says how to install it', () => {
  const text = notFoundText(new Error('spawn codium ENOENT'));
  assert.match(text, /Could not start codium/);
  assert.match(text, /Shell Command/);
});

const workspace = '/bb/worktrees/thr_a/frontend';
const environment = '/bb/worktrees/thr_a/frontend';
const sibling = '/bb/worktrees/thr_a/frontend-257';

test('a page with no workspace is refused', () => {
  assert.throws(() => editorPageUrl({ port: 47321, token, folder: '' }), /no workspace folder/);
});

test('insideFolder matches Node for ordinary paths', () => {
  const cases = [
    [workspace, 'src/a.ts'],
    [workspace, '../thr_b/platform/src/a.ts'],
    [workspace, `${workspace}/src/a.ts`],
    [workspace, '/etc/passwd'],
    [workspace, `${workspace}-other/src/a.ts`],
    [workspace, 'src/../src/a.ts'],
    [`${workspace}/`, 'src/a.ts'],
    [workspace, '.'],
    [workspace, '..hidden'],
  ];
  for (const [folder, file] of cases) {
    const full = path.resolve(folder, file);
    const inside = path.relative(folder, full);
    const expected = inside === '..' || inside.startsWith('../') || path.isAbsolute(inside) ? null : full;
    assert.equal(insideFolder(folder, file), expected, `${folder} + ${file}`);
  }
});

const disk = (entries) => async (file) => (file in entries ? entries[file] : null);
const tree = disk({
  [workspace]: workspace,
  [`${workspace}/src`]: `${workspace}/src`,
  [`${workspace}/src/a.ts`]: `${workspace}/src/a.ts`,
  [`${workspace}/link`]: '/etc',
  [`${workspace}/out`]: sibling,
  [sibling]: sibling,
  [`${sibling}/src/x.ts`]: `${sibling}/src/x.ts`,
});

test('a relative path opens inside the thread folder', async () => {
  assert.equal(await resolveOpenPath(workspace, 'src/a.ts', tree), `${workspace}/src/a.ts`);
});

test('a file that does not exist yet opens inside the thread folder', async () => {
  assert.equal(await resolveOpenPath(workspace, 'src/new.ts', tree), `${workspace}/src/new.ts`);
});

test('a relative path cannot climb out, even into a sibling worktree', async () => {
  await assert.rejects(resolveOpenPath(workspace, '../frontend-257/src/a.ts', tree), /leaves this thread's folder/);
});

test('a sibling worktree is outside the thread folder', async () => {
  await assert.rejects(resolveOpenPath(workspace, `${sibling}/src/x.ts`, tree), /is outside this thread's folder/);
});

test('a symbolic link inside the folder that points outside is refused', async () => {
  await assert.rejects(resolveOpenPath(workspace, 'link/passwd', tree), /is outside this thread's folder/);
});

test('a folder in the thread that links to a sibling worktree is refused', async () => {
  await assert.rejects(resolveOpenPath(workspace, 'out/x.ts', tree), /is outside this thread's folder/);
});

test('the check uses real locations, so a folder reached through a link still works', async () => {
  const linked = disk({ '/link/app': '/real/app', '/link/app/a.ts': '/real/app/a.ts' });
  assert.equal(await resolveOpenPath('/link/app', 'a.ts', linked), '/link/app/a.ts');
});

test('an absolute path inside the thread folder opens', async () => {
  assert.equal(await resolveOpenPath(workspace, `${workspace}/src/a.ts`, tree), `${workspace}/src/a.ts`);
});

test('an absolute path outside the thread folder is refused', async () => {
  await assert.rejects(resolveOpenPath(workspace, '/etc/passwd', tree), /is outside this thread's folder/);
  await assert.rejects(resolveOpenPath(workspace, `${workspace}-other/x.ts`, tree), /is outside this thread's folder/);
  await assert.rejects(resolveOpenPath(workspace, `${sibling}/../../../../etc/passwd`, tree), /is outside this thread's folder/);
});

test('a thread folder that cannot be read refuses every path', async () => {
  await assert.rejects(resolveOpenPath('/gone', 'a.ts', disk({})), /cannot be read/);
});

test('an empty path is refused', async () => {
  await assert.rejects(resolveOpenPath(workspace, '', tree), /The path is empty/);
  await assert.rejects(resolveOpenPath(workspace, '   ', tree), /The path is empty/);
});

test('an off-screen open says it waits for the panel', () => {
  const text = laterText(`${workspace}/a.js:4`);
  assert.match(text, /not on screen/);
  assert.match(text, /next time this panel is shown/);
  assert.match(text, /10 minutes/);
  assert.match(text, /newer editor_open replaces it/);
});

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

test('a file request opens only on the thread that made it, and waits while another thread is on screen', () => {
  const queue = createPending(PENDING_MS);
  queue.put('thr_a', { path: '/w/a/src/a.ts', line: 3 });
  assert.equal(requestForScreen(queue, 'thr_b'), null);
  assert.equal(queue.size(), 1);
  assert.equal(requestForScreen(queue, null), null);
  assert.equal(queue.size(), 1);
  assert.deepEqual(requestForScreen(queue, 'thr_a'), { path: '/w/a/src/a.ts', line: 3 });
  assert.equal(queue.size(), 0);
});

test('a launch starts on thread A, the panel moves to B, the launch ends, the panel is not busy, and B\'s saved request opens', () => {
  const pending = createPending(PENDING_MS, () => 0);
  const saved = { args: ['--reuse-window', '--goto', '/b.js'], where: '/b.js' };
  pending.put('B', saved);
  let face = beginToolLaunch('A', 'A');
  assert.equal(face.busy, true);
  face = movePanel(face, 'B');
  assert.equal(face.busy, true);
  assert.equal(face.owner, 'A');
  assert.equal(pending.size(), 1);
  const ended = endToolLaunch(face, pending);
  assert.equal(ended.busy, false);
  assert.deepEqual(ended.open, saved);
  assert.equal(pending.size(), 0);
});
