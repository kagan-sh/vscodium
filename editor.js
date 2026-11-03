// Pure helpers with no kagan imports, so `node --test` can run them.

/** How long an off-screen editor_open is kept. */
export const PENDING_MS = 10 * 60 * 1000;

export const FILE_FIELD_LABEL = 'File on this Mac';

/**
 * Turns a request into the arguments for `codium`.
 * The path is passed as one argument, never through a shell.
 * @param {{ path?: unknown, line?: unknown }} request
 * @returns {string[]}
 */
export function codiumArgs(request) {
  const { path, line } = request;
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('Give an absolute path that starts with "/".');
  }
  if (/[\0\r\n]/.test(path)) {
    throw new Error('The path has a line break or a NUL character.');
  }
  let target = path;
  if (line !== undefined && line !== null) {
    if (!Number.isInteger(line) || /** @type {number} */ (line) < 1) {
      throw new Error('The line must be a whole number, 1 or more.');
    }
    target = `${path}:${line}`;
  }
  return ['--reuse-window', '--goto', target];
}

/**
 * Opens a folder as the VSCodium workspace.
 * @param {string} folder
 * @returns {string[]}
 */
export function codiumWorkspaceArgs(folder) {
  if (typeof folder !== 'string' || !folder.startsWith('/')) {
    throw new Error('This thread has no workspace folder yet.');
  }
  return ['--reuse-window', folder];
}

/**
 * Says what to do when `codium` cannot be started at all.
 * @param {unknown} error
 * @returns {string}
 */
export function notFoundText(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not start codium (${reason}). Install VSCodium, then in VSCodium run "Shell Command: Install 'codium' command in PATH".`;
}

/**
 * The file field. An empty box stays empty: the placeholder is not a path.
 * A trailing :line uses the line support in `codiumArgs`.
 * @param {unknown} raw
 * @returns {{ empty: true } | { empty: false, path: string, line?: number }}
 */
export function fileFieldPath(raw) {
  if (typeof raw !== 'string') return { empty: true };
  const text = raw.trim();
  if (text === '' || text === FILE_FIELD_LABEL) return { empty: true };
  const withColumn = /^(.*):([1-9]\d*):([1-9]\d*)$/.exec(text);
  if (withColumn && withColumn[1] !== '') return { empty: false, path: withColumn[1], line: Number(withColumn[2]) };
  const match = /^(.*):([1-9]\d*)$/.exec(text);
  if (!match || match[1] === '') return { empty: false, path: text };
  return { empty: false, path: match[1], line: Number(match[2]) };
}

/**
 * Folders `git worktree list --porcelain` names.
 * @param {string} porcelain
 * @returns {string[]}
 */
export function worktreePaths(porcelain) {
  return porcelain.split('\n').flatMap((line) => {
    if (!line.startsWith('worktree ')) return [];
    const folder = line.slice('worktree '.length).trim();
    return folder ? [folder] : [];
  });
}

/**
 * @param {string} folder
 * @param {string} file
 * @returns {string | null}
 */
export function insideFolder(folder, file) {
  if (!folder.startsWith('/')) return null;
  const full = resolvePath(folder, file);
  const inside = relativePath(folder, full);
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('/')) return null;
  return full;
}

/**
 * A relative path stays in the workspace.
 * An absolute path may sit in the workspace, the thread environment, or a git worktree of that repo.
 * @param {string} workspace
 * @param {string | null} environment
 * @param {readonly string[]} worktrees
 * @param {unknown} file
 * @param {string | null} [gitError]
 * @returns {string}
 */
export function resolveOpenPath(workspace, environment, worktrees, file, gitError = null) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('The path is empty.');
  }
  if (/[\0\r\n]/.test(file)) {
    throw new Error('The path has a line break or a NUL character.');
  }
  const path = file.trim();
  if (!workspace.startsWith('/')) {
    throw new Error('This thread has no workspace folder yet.');
  }
  if (!path.startsWith('/')) {
    const full = insideFolder(workspace, path);
    if (!full) {
      throw new Error(`${path} leaves the thread workspace, and a relative path has to stay inside it.`);
    }
    return full;
  }
  const roots = [];
  for (const root of [workspace, environment, ...worktrees]) {
    if (typeof root !== 'string' || !root.startsWith('/')) continue;
    const full = resolvePath(root);
    if (!roots.includes(full)) roots.push(full);
  }
  for (const root of roots) {
    const full = insideFolder(root, path);
    if (full) return full;
  }
  if (gitError) {
    throw new Error(
      `${path} is outside the thread workspace and its environment. Git could not list this repo's other worktrees: ${gitError}`,
    );
  }
  throw new Error(
    `${path} is outside the thread workspace, its environment, and this repo's other git worktrees.`,
  );
}

/**
 * @param {string} where
 * @returns {string}
 */
export function laterText(where) {
  return `This thread is not on screen. ${where} will open in VSCodium the next time this panel is shown. That request is kept for 10 minutes, and a newer editor_open replaces it.`;
}

/**
 * Holds the latest request per thread until the panel is shown, or it gets too old.
 * @template T
 * @param {number} ttlMs
 * @param {() => number} [now]
 */
export function createPending(ttlMs, now = Date.now) {
  /** @type {Map<string, { value: T, at: number }>} */
  const entries = new Map();
  const sweep = () => {
    for (const [threadId, entry] of entries) {
      if (now() - entry.at > ttlMs) entries.delete(threadId);
    }
  };
  return {
    /**
     * @param {string} threadId
     * @param {T} value
     */
    put(threadId, value) {
      sweep();
      entries.set(threadId, { value, at: now() });
    },
    /**
     * @param {string} threadId
     * @returns {T | null}
     */
    take(threadId) {
      sweep();
      const entry = entries.get(threadId);
      entries.delete(threadId);
      return entry?.value ?? null;
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}

/**
 * A tool launch owns the panel's busy flag.
 * Moving the panel does not clear it and does not drop the launch.
 * @param {string | null} visible
 * @param {string} threadId
 * @returns {{ busy: boolean, visible: string | null, owner: string }}
 */
export function beginToolLaunch(visible, threadId) {
  return { busy: true, visible, owner: threadId };
}

/**
 * @param {{ busy: boolean, visible: string | null, owner: string | null }} face
 * @param {string | null} visible
 * @returns {{ busy: boolean, visible: string | null, owner: string | null }}
 */
export function movePanel(face, visible) {
  return { busy: face.busy, visible, owner: face.owner };
}

/**
 * The launch is over. Busy is cleared even when the visible thread is no longer the owner.
 * The saved request for the thread now on screen is the one that opens.
 * @template T
 * @param {{ busy: boolean, visible: string | null, owner: string | null }} face
 * @param {{ take(threadId: string): T | null }} pending
 * @returns {{ busy: boolean, open: T | null }}
 */
export function endToolLaunch(face, pending) {
  const open = face.visible ? pending.take(face.visible) : null;
  return { busy: false, open };
}

/**
 * @param {...string} parts
 * @returns {string}
 */
function resolvePath(...parts) {
  /** @type {string[]} */
  const segments = [];
  for (const part of parts) {
    if (part.startsWith('/')) segments.length = 0;
    for (const segment of part.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
  }
  return `/${segments.join('/')}`;
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relativePath(from, to) {
  const left = resolvePath(from).split('/').filter(Boolean);
  const right = resolvePath(to).split('/').filter(Boolean);
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  const up = Array(left.length - index).fill('..');
  return [...up, ...right.slice(index)].join('/');
}
