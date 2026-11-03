// Pure helpers with no kagan imports, so `node --test` can run them.
import path from 'node:path';

/** How long an off-screen editor_open is kept. */
export const PENDING_MS = 10 * 60 * 1000;

/** How long `codium serve-web` is kept. Unload kills it sooner. */
export const HOLD_MS = 365 * 24 * 60 * 60 * 1000;

/** Pause between checks that the page is answering. */
export const POLL_MS = 300;

/** First port to try. The last one that worked is tried before this. */
export const FIRST_PORT = 47321;

/** How many ports to try after the saved one. */
export const PORT_SPAN = 32;

/** The host shows this when the page cannot be drawn. */
export const ONLY_MACOS = 'This page works on macOS only for now.';

const STARTING = 'Starting VSCodium. The first start can take a few minutes.';

/**
 * @param {string} platform
 * @returns {boolean}
 */
export function pageOnThisSystem(platform) {
  return platform === 'darwin';
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function connectionToken(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    throw new Error('The connection token needs at least 16 random bytes.');
  }
  let token = '';
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
  return token;
}

/**
 * Arguments for one long-lived `codium serve-web`. The folder is in the page address, not here.
 * @param {{ port: number, token: string, dataDir?: string | null, cliDir?: string | null }} options
 * @returns {string[]}
 */
export function serveWebArgs(options) {
  const { port, token, dataDir, cliDir } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The port must be a whole number from 1 to 65535.');
  }
  if (typeof token !== 'string' || !/^[0-9a-f]{32,}$/.test(token)) {
    throw new Error('The connection token is missing.');
  }
  const args = [
    'serve-web',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--connection-token', token,
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--log', 'off',
  ];
  if (dataDir !== undefined && dataDir !== null && dataDir !== '') {
    if (typeof dataDir !== 'string' || !dataDir.startsWith('/')) {
      throw new Error('The server data folder must be an absolute path.');
    }
    args.push('--server-data-dir', dataDir);
  }
  if (cliDir !== undefined && cliDir !== null && cliDir !== '') {
    if (typeof cliDir !== 'string' || !cliDir.startsWith('/')) {
      throw new Error('The server data folder must be an absolute path.');
    }
    args.push('--cli-data-dir', cliDir);
  }
  return args;
}

/**
 * Saved port first, then a fixed range, with no duplicates.
 * @param {unknown} saved
 * @returns {number[]}
 */
export function portOrder(saved) {
  /** @type {number[]} */
  const ports = [];
  const push = (/** @type {unknown} */ port) => {
    if (!Number.isInteger(port) || /** @type {number} */ (port) < 1 || /** @type {number} */ (port) > 65535) return;
    if (!ports.includes(/** @type {number} */ (port))) ports.push(/** @type {number} */ (port));
  };
  push(saved);
  for (let offset = 0; offset < PORT_SPAN; offset += 1) push(FIRST_PORT + offset);
  return ports;
}

/**
 * Server files stay in the plugin data folder when the host names one.
 * Otherwise they stay under the temporary folder, away from the editor's own profile.
 * @param {string | null | undefined} dataDir
 * @param {string} fallbackDir
 * @returns {{ dataDir: string, cliDir: string }}
 */
export function serverFolders(dataDir, fallbackDir) {
  const base = typeof dataDir === 'string' && dataDir.startsWith('/')
    ? dataDir
    : path.join(fallbackDir, 'kagan-vscodium');
  return {
    dataDir: path.join(base, 'server'),
    cliDir: path.join(base, 'cli'),
  };
}

/**
 * `/version` answers before the connection token is checked.
 * @param {number} port
 * @returns {string}
 */
export function versionUrl(port) {
  return `http://127.0.0.1:${port}/version`;
}

/**
 * A listener that is already up is not the one we are about to start.
 * @param {number} status
 * @returns {boolean}
 */
export function versionReady(status) {
  return status === 200;
}

/**
 * The editor reports a busy port on stdout and still exits 0.
 * @param {string} output
 * @returns {boolean}
 */
export function portBusy(output) {
  return /eaddrinuse|address already in use|os error 48/i.test(output || '');
}

/**
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
export function scrub(text, token) {
  if (!token) return text;
  return text.split(token).join('…');
}

/**
 * @param {string} output
 * @param {number | null | undefined} exitCode
 * @param {string} token
 * @returns {string}
 */
export function failureText(output, exitCode, token) {
  const clean = scrub(output || '', token);
  const detail = clean.split('\n').map((line) => line.trim()).find(Boolean) || `exit code ${exitCode ?? 'none'}`;
  return `VSCodium did not start. ${detail}`;
}

/**
 * @param {unknown} line
 * @param {unknown} column
 * @returns {{ line?: number, column?: number }}
 */
export function openPosition(line, column) {
  /** @type {{ line?: number, column?: number }} */
  const position = {};
  if (line !== undefined && line !== null) {
    if (!Number.isInteger(line) || /** @type {number} */ (line) < 1) {
      throw new Error('The line must be a whole number, 1 or more.');
    }
    position.line = /** @type {number} */ (line);
  }
  if (column !== undefined && column !== null) {
    if (!position.line) throw new Error('A column needs a line.');
    if (!Number.isInteger(column) || /** @type {number} */ (column) < 1) {
      throw new Error('The column must be a whole number, 1 or more.');
    }
    position.column = /** @type {number} */ (column);
  }
  return position;
}

/**
 * @param {string} path
 * @param {number | undefined} line
 * @param {number | undefined} column
 * @returns {string}
 */
export function openedWhere(path, line, column) {
  if (!line) return path;
  if (!column) return `${path}:${line}`;
  return `${path}:${line}:${column}`;
}

/**
 * @param {string} where
 * @param {boolean} ready
 * @returns {string}
 */
export function openingText(where, ready) {
  if (ready) return `Opened ${where}.`;
  return `Opening ${where}. ${STARTING}`;
}

export { STARTING };

/**
 * The page reads `folder` and `payload` once, at startup.
 * `gotoLineMode` makes it take `:line:column` off the file path.
 * The file address uses the same host and port the page was served from.
 * @param {{ port: number, token: string, folder: string, file?: string | null, line?: number, column?: number }} options
 * @returns {string}
 */
export function editorPageUrl(options) {
  const { port, token, folder, file, line, column } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('The port must be a whole number from 1 to 65535.');
  }
  if (typeof token !== 'string' || token === '') throw new Error('The connection token is missing.');
  if (typeof folder !== 'string' || !folder.startsWith('/')) {
    throw new Error('This thread has no workspace folder yet.');
  }
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set('tkn', token);
  url.searchParams.set('folder', folder);
  if (file !== undefined && file !== null && file !== '') {
    if (typeof file !== 'string' || !file.startsWith('/')) {
      throw new Error('Give an absolute path that starts with "/".');
    }
    let target = file;
    if (line !== undefined) {
      if (!Number.isInteger(line) || line < 1) throw new Error('The line must be a whole number, 1 or more.');
      target += `:${line}`;
      if (column !== undefined) {
        if (!Number.isInteger(column) || column < 1) {
          throw new Error('The column must be a whole number, 1 or more.');
        }
        target += `:${column}`;
      }
    }
    /** @type {[string, string][]} */
    const payload = [['openFile', `vscode-remote://127.0.0.1:${port}${encodeURI(target)}`]];
    if (line !== undefined) payload.push(['gotoLineMode', 'true']);
    url.searchParams.set('payload', JSON.stringify(payload));
  }
  return url.toString();
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
