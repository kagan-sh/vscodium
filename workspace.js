// Where a thread's editor opens: its environment folder when it has one, else its project folder.
// The only host I/O in this file is the `threads` and `process` areas.

import { run } from 'kagan/process';
import { environment, get, project, sidebar } from 'kagan/threads';
import { worktreeFolders } from './paths.js';

/** How long one `git worktree list` may take. */
const GIT_TIMEOUT_MS = 5000;

/**
 * @param {string} threadId
 * @returns {Promise<string>}
 */
export async function threadFolder(threadId) {
  const thread = await get(threadId);
  const environmentPath = thread.environmentId ? (await environment(thread.environmentId)).path : null;
  const folder = environmentPath || (await project(thread.projectId)).path;
  if (!folder) throw new Error('This thread has no workspace folder yet.');
  return folder;
}

/**
 * The other folders an absolute path may open in: every project and environment the window lists,
 * and every git worktree of those. A folder that is gone, or not a repo, is skipped. A window that
 * cannot be read has no other folders, which still leaves a path inside the thread's own folder.
 * @returns {Promise<string[]>}
 */
export async function otherFolders() {
  try {
    const list = sidebar();
    /** @type {string[]} */
    const folders = list.projects.map((entry) => entry.path).filter(Boolean);
    for (const thread of list.threads) {
      if (!thread.environmentId) continue;
      const folder = await environment(thread.environmentId).then((entry) => entry.path, () => null);
      if (folder) folders.push(folder);
    }
    return worktreeFolders(folders, gitWorktrees);
  } catch {
    return [];
  }
}

/**
 * @param {string} folder
 * @returns {Promise<string>}
 */
async function gitWorktrees(folder) {
  const result = await run('git', ['worktree', 'list', '--porcelain'], { cwd: folder, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}
