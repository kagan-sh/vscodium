import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathInside, resolveOpenPath, worktreeFolders } from '../paths.js';

const workspace = '/bb/worktrees/thr_a/frontend';
const platform = '/bb/worktrees/thr_b/platform';
const sibling = '/bb/worktrees/thr_a/frontend-257';

test('pathInside keeps a path in its folder and refuses anything that climbs out', () => {
  assert.equal(pathInside(workspace, 'src/a.ts'), `${workspace}/src/a.ts`);
  assert.equal(pathInside(workspace, `${workspace}/src/a.ts`), `${workspace}/src/a.ts`);
  assert.equal(pathInside(workspace, 'src/../src/a.ts'), `${workspace}/src/a.ts`);
  assert.equal(pathInside(`${workspace}/`, 'src/a.ts'), `${workspace}/src/a.ts`);
  assert.equal(pathInside(workspace, '.'), workspace);
  assert.equal(pathInside(workspace, '..hidden'), `${workspace}/..hidden`);
  assert.equal(pathInside(workspace, '../thr_b/platform/src/a.ts'), null);
  assert.equal(pathInside(workspace, '/etc/passwd'), null);
  assert.equal(pathInside(workspace, `${workspace}-other/src/a.ts`), null);
  assert.equal(pathInside('relative', 'src/a.ts'), null);
});

const disk = (entries) => async (file) => (file in entries ? entries[file] : null);
const tree = disk({
  [workspace]: workspace,
  [`${workspace}/src`]: `${workspace}/src`,
  [`${workspace}/src/a.ts`]: `${workspace}/src/a.ts`,
  [`${workspace}/link`]: '/etc',
  [`${workspace}/link/passwd`]: '/etc/passwd',
  [`${workspace}/out`]: sibling,
  [`${workspace}/out/x.ts`]: `${sibling}/x.ts`,
  [sibling]: sibling,
  [`${sibling}/src/x.ts`]: `${sibling}/src/x.ts`,
  [platform]: platform,
  [`${platform}/src/x.ts`]: `${platform}/src/x.ts`,
});

test('a relative path opens inside the thread folder', async () => {
  assert.equal(await resolveOpenPath(workspace, 'src/a.ts', tree), `${workspace}/src/a.ts`);
});

test('a file that does not exist is refused, because nothing can be checked behind it', async () => {
  await assert.rejects(resolveOpenPath(workspace, 'src/new.ts', tree), /cannot be opened/);
});

test('a relative path cannot climb out, even into a sibling worktree', async () => {
  await assert.rejects(resolveOpenPath(workspace, '../frontend-257/src/a.ts', tree), /leaves this thread's folder/);
});

test('a relative path cannot climb into another local environment', async () => {
  await assert.rejects(resolveOpenPath(workspace, '../thr_b/platform/src/x.ts', tree, [platform]), /leaves this thread's folder/);
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

test('an absolute path in another local environment opens', async () => {
  assert.equal(
    await resolveOpenPath(workspace, `${platform}/src/x.ts`, tree, [platform]),
    `${platform}/src/x.ts`,
  );
});

test('a link that leads out of every allowed folder is refused, even from another environment', async () => {
  const linked = disk({
    [workspace]: workspace,
    [platform]: platform,
    [`${platform}/src`]: `${platform}/src`,
    [`${platform}/src/x.ts`]: `${platform}/src/x.ts`,
    [`${platform}/link`]: '/etc',
    [`${platform}/link/passwd`]: '/etc/passwd',
  });
  await assert.rejects(resolveOpenPath(workspace, `${platform}/link/passwd`, linked, [platform]), /is outside this thread's folder/);
  assert.equal(await resolveOpenPath(workspace, `${platform}/src/x.ts`, linked, [platform]), `${platform}/src/x.ts`);
});

test('a thread folder that cannot be read refuses every path', async () => {
  await assert.rejects(resolveOpenPath('/gone', 'a.ts', disk({})), /cannot be read/);
});

test('an empty path is refused', async () => {
  await assert.rejects(resolveOpenPath(workspace, '', tree), /The path is empty/);
  await assert.rejects(resolveOpenPath(workspace, '   ', tree), /The path is empty/);
});

function realpathProgram(target) {
  return new Promise((resolve, reject) => {
    execFile('realpath', [target], (error, stdout) => {
      if (!error) resolve(stdout.trim());
      else if (typeof error.code === 'number') resolve(null);
      else reject(error);
    });
  });
}

test('a real dangling link to a missing outside folder is refused, even after that folder appears', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'vsc-dangling-'));
  try {
    const thread = path.join(base, 'thread');
    const outside = path.join(base, 'outside', 'missing');
    await mkdir(thread);
    await mkdir(path.join(base, 'outside'));
    await symlink(outside, path.join(thread, 'link'));
    await assert.rejects(resolveOpenPath(thread, 'link/new.txt', realpathProgram), /cannot be opened/);
    await mkdir(outside);
    await writeFile(path.join(outside, 'new.txt'), 'outside');
    await assert.rejects(resolveOpenPath(thread, 'link/new.txt', realpathProgram), /is outside this thread's folder/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a real existing file inside the thread folder opens', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'vsc-inside-'));
  try {
    const thread = path.join(base, 'thread');
    await mkdir(path.join(thread, 'src'), { recursive: true });
    await writeFile(path.join(thread, 'src', 'a.ts'), 'export {};\n');
    assert.equal(await resolveOpenPath(thread, 'src/a.ts', realpathProgram), path.join(thread, 'src', 'a.ts'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

const porcelain = (...folders) =>
  folders.map((folder) => `worktree ${folder}\nHEAD 0123abcd\nbranch refs/heads/main\n`).join('\n');

test('git worktrees of every folder are listed, and folders git fails on are skipped', async () => {
  const git = async (folder) => {
    if (folder === '/bb/personal-workspaces/env_x') throw new Error('fatal: not a git repository');
    return porcelain(folder, `${folder}-257`);
  };

  assert.deepEqual(await worktreeFolders([platform, '/bb/personal-workspaces/env_x', workspace], git), [
    platform,
    `${platform}-257`,
    workspace,
    `${workspace}-257`,
  ]);
});

test('a path inside a git worktree of another environment opens; escapes stay refused', async () => {
  const worktrees = await worktreeFolders([platform], async () => porcelain(platform, '/bb/worktrees/thr_c/platform-257'));
  const worktreeDisk = disk({
    [workspace]: workspace,
    '/bb/worktrees/thr_c/platform-257': '/bb/worktrees/thr_c/platform-257',
    '/bb/worktrees/thr_c/platform-257/src/x.ts': '/bb/worktrees/thr_c/platform-257/src/x.ts',
  });

  assert.equal(
    await resolveOpenPath(workspace, '/bb/worktrees/thr_c/platform-257/src/x.ts', worktreeDisk, worktrees),
    '/bb/worktrees/thr_c/platform-257/src/x.ts',
  );
  await assert.rejects(
    resolveOpenPath(workspace, '/bb/worktrees/thr_c/platform-257/../../../../etc/passwd', worktreeDisk, worktrees),
    /is outside this thread's folder/,
  );
});
