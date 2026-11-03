import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  FILE_FIELD_LABEL,
  PENDING_MS,
  codiumArgs,
  codiumWorkspaceArgs,
  beginToolLaunch,
  createPending,
  endToolLaunch,
  fileFieldPath,
  movePanel,
  insideFolder,
  laterText,
  notFoundText,
  resolveOpenPath,
  worktreePaths,
} from './editor.js';

test('path only opens the file in the last window', () => {
  assert.deepEqual(codiumArgs({ path: '/Users/me/app.js' }), [
    '--reuse-window',
    '--goto',
    '/Users/me/app.js',
  ]);
});

test('a line number is added after the path', () => {
  assert.deepEqual(codiumArgs({ path: '/Users/me/app.js', line: 42 }), [
    '--reuse-window',
    '--goto',
    '/Users/me/app.js:42',
  ]);
});

test('a null line is the same as no line', () => {
  assert.deepEqual(codiumArgs({ path: '/a.js', line: null }), ['--reuse-window', '--goto', '/a.js']);
});

test('relative and missing paths are refused', () => {
  assert.throws(() => codiumArgs({ path: 'src/app.js' }), /absolute path/);
  assert.throws(() => codiumArgs({}), /absolute path/);
  assert.throws(() => codiumArgs({ path: 42 }), /absolute path/);
});

test('a path with a line break or NUL is refused', () => {
  assert.throws(() => codiumArgs({ path: '/a\nb.js' }), /line break/);
  assert.throws(() => codiumArgs({ path: '/a\0b.js' }), /line break/);
});

test('a bad line number is refused', () => {
  for (const line of [0, -3, 1.5, '3', NaN]) {
    assert.throws(() => codiumArgs({ path: '/a.js', line }), /whole number/, `line ${String(line)}`);
  }
});

test('a missing codium command says how to install it', () => {
  const text = notFoundText(new Error('spawn codium ENOENT'));
  assert.match(text, /Could not start codium/);
  assert.match(text, /Shell Command/);
});

const workspace = '/bb/worktrees/thr_a/frontend';
const environment = '/bb/worktrees/thr_a/frontend';
const sibling = '/bb/worktrees/thr_a/frontend-257';

test('a workspace open reuses the window on that folder', () => {
  assert.deepEqual(codiumWorkspaceArgs(workspace), ['--reuse-window', workspace]);
});

test('a missing workspace is refused', () => {
  assert.throws(() => codiumWorkspaceArgs(''), /no workspace folder/);
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

test('a relative path opens inside the thread workspace', () => {
  assert.equal(resolveOpenPath(workspace, environment, [sibling], 'src/a.ts'), `${workspace}/src/a.ts`);
});

test('a relative path cannot climb out, even into a sibling worktree', () => {
  assert.throws(
    () => resolveOpenPath(workspace, environment, [sibling], '../frontend-257/src/a.ts'),
    /leaves the thread workspace/,
  );
});

test('an absolute path opens inside the workspace, the environment, or a sibling worktree', () => {
  assert.equal(
    resolveOpenPath(workspace, environment, [sibling], `${workspace}/src/a.ts`),
    `${workspace}/src/a.ts`,
  );
  assert.equal(
    resolveOpenPath(workspace, '/bb/env/checkout', [], '/bb/env/checkout/notes.txt'),
    '/bb/env/checkout/notes.txt',
  );
  assert.equal(
    resolveOpenPath(workspace, environment, [sibling], `${sibling}/src/x.ts`),
    `${sibling}/src/x.ts`,
  );
});

test('an absolute path outside those roots is refused, and the sentence says why', () => {
  assert.throws(
    () => resolveOpenPath(workspace, environment, [sibling], '/etc/passwd'),
    /outside the thread workspace, its environment, and this repo's other git worktrees/,
  );
  assert.throws(
    () => resolveOpenPath(workspace, environment, [sibling], `${workspace}-other/x.ts`),
    /outside the thread workspace/,
  );
  assert.throws(
    () => resolveOpenPath(workspace, environment, [sibling], `${sibling}/../../../../etc/passwd`),
    /outside the thread workspace/,
  );
});

test('when git cannot list worktrees, the refusal says so', () => {
  assert.throws(
    () => resolveOpenPath(workspace, null, [], '/etc/passwd', 'git failed'),
    /Git could not list this repo's other worktrees: git failed/,
  );
});

test('an empty path is refused and is not the file-field label', () => {
  assert.throws(() => resolveOpenPath(workspace, environment, [], ''), /The path is empty/);
  assert.throws(() => resolveOpenPath(workspace, environment, [], '   '), /The path is empty/);
  assert.deepEqual(fileFieldPath(''), { empty: true });
  assert.deepEqual(fileFieldPath('   '), { empty: true });
  assert.deepEqual(fileFieldPath(FILE_FIELD_LABEL), { empty: true });
  assert.deepEqual(fileFieldPath(`${workspace}/a.js:42`), { empty: false, path: `${workspace}/a.js`, line: 42 });
  assert.deepEqual(fileFieldPath(`${workspace}/a.js:42:7`), { empty: false, path: `${workspace}/a.js`, line: 42 });
});

test('git worktree porcelain lists every worktree folder', () => {
  const porcelain = [`worktree ${workspace}`, 'HEAD abc', 'branch refs/heads/main', '', `worktree ${sibling}`, 'HEAD def', ''].join('\n');
  assert.deepEqual(worktreePaths(porcelain), [workspace, sibling]);
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
