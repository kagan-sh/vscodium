// Where a file really is, and whether it is allowed to open. Pure helpers with no kagan imports.

// The plugin runtime's `path` module gives join, resolve, dirname and basename only, so the
// "is this still inside that folder" check is written out here.
import { resolve } from 'path';

/**
 * The full path when `file` stays inside `folder`, else null.
 * @param {string} folder
 * @param {string} file
 * @returns {string | null}
 */
export function pathInside(folder, file) {
  if (!folder.startsWith('/')) return null;
  const full = resolve(folder, file);
  const inside = relativePath(folder, full);
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('/')) return null;
  return full;
}

/**
 * @param {string[]} folders
 * @param {string} file
 * @returns {string | null}
 */
function pathInsideAny(folders, file) {
  for (const folder of folders) {
    const full = pathInside(folder, file);
    if (full) return full;
  }
  return null;
}

/**
 * A relative path opens only inside the thread's own folder. An absolute path may also sit in
 * another project or environment the window lists, or one of their git worktrees, which is where
 * an agent reading another thread's work finds them. The real location decides, so a symbolic
 * link cannot lead out.
 * @param {string} folder the thread's folder: its environment when it has one, else its project folder
 * @param {unknown} file
 * @param {(path: string) => Promise<string | null>} realpathOf answers null when the path does not resolve
 * @param {string[]} [also] other folders an absolute path may open in
 * @returns {Promise<string>} the path to open
 * @throws when the path is empty, has a line break, is missing, or is outside every allowed folder
 */
export async function resolveOpenPath(folder, file, realpathOf, also = []) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('The path is empty.');
  }
  if (/[\0\r\n]/.test(file)) {
    throw new Error('The path has a line break or a NUL character.');
  }
  if (!folder.startsWith('/')) {
    throw new Error('This thread has no workspace folder yet.');
  }
  const path = file.trim();
  const full = pathInside(folder, path) ?? (path.startsWith('/') ? pathInsideAny(also, path) : null);
  if (!full) {
    throw new Error(path.startsWith('/')
      ? `${path} is outside this thread's folder.`
      : `${path} leaves this thread's folder. A relative path has to stay inside it.`);
  }
  const realFolder = await realpathOf(folder);
  if (realFolder === null) throw new Error("This thread's folder cannot be read.");
  // Only an existing file opens. A dangling link, or a path behind one, does not resolve, so it is refused.
  const real = await realpathOf(full);
  if (real === null) {
    throw new Error(`${path} cannot be opened. It must be an existing file inside this thread's folder.`);
  }
  const roots = await Promise.all(also.map(realpathOf));
  if (![realFolder, ...roots].some((root) => root !== null && pathInside(root, real) !== null)) {
    throw new Error(`${path} is outside this thread's folder.`);
  }
  return full;
}

/**
 * Every git worktree of the given folders; a folder git fails on (not a repo, gone) is skipped.
 * @param {string[]} folders
 * @param {(folder: string) => Promise<string>} gitWorktreeList prints `git worktree list --porcelain`
 * @returns {Promise<string[]>} the folders as git lists them, in order, with repeats kept
 */
export async function worktreeFolders(folders, gitWorktreeList) {
  const lists = await Promise.all(folders.map((folder) => gitWorktreeList(folder).catch(() => '')));
  return lists.flatMap((porcelain) =>
    porcelain.split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice('worktree '.length).trim()] : [])),
  );
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relativePath(from, to) {
  const left = resolve(from).split('/').filter(Boolean);
  const right = resolve(to).split('/').filter(Boolean);
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  const up = Array(left.length - index).fill('..');
  return [...up, ...right.slice(index)].join('/');
}
