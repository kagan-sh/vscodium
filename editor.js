// Pure helpers with no kagan imports, so `node --test` can run them.

/** How long an off-screen editor_open is kept. */
export const PENDING_MS = 10 * 60 * 1000;

/** How long `codium serve-web` is kept. Unload kills it sooner. */
export const HOLD_MS = 365 * 24 * 60 * 60 * 1000;

/** Pause between checks that the page is answering. */
export const POLL_MS = 300;

/** First port to try. The last one that worked is tried first, when it is in range. */
export const FIRST_PORT = 47321;

/**
 * How many ports to try. Each one is listed in kagan.json as a local fetch power,
 * and the host allows at most eight local entries.
 */
export const PORT_SPAN = 3;

/** The host shows this when the page cannot be drawn. */
export const ONLY_MACOS = 'This page works on macOS only for now.';

const STARTING = 'Starting VSCodium. The first start can take a few minutes.';

/** How long a started server may take to answer before the panel gives up on it. */
export const START_DEADLINE_MS = 4 * 60 * 1000;

/** The panel says this when the server does not answer in time. */
export const STARTUP_TIMEOUT_TEXT = 'VSCodium took too long to start. Press Try again.';

/**
 * @param {number} startedAt
 * @param {number} now
 * @param {number} [limitMs]
 * @returns {boolean}
 */
export function startExpired(startedAt, now, limitMs = START_DEADLINE_MS) {
  return now - startedAt >= limitMs;
}

/** A failed start. `kind` picks the panel copy; `detail` is for the log only. */
export class StartFailure extends Error {
  /** @param {string} kind @param {string} detail */
  constructor(kind, detail) {
    super(kind);
    this.name = 'StartFailure';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * @typedef {{ port: number, token: string, promise: Promise<unknown> }} StartAttempt
 * @typedef {{ result: { exitCode: number | null, stdout: string, stderr: string } } | { error: unknown }} Ended
 * @typedef {{
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   listening: (port: number) => Promise<boolean>,
 *   ended: (attempt: StartAttempt) => Ended | null,
 * }} StartClock
 */

/**
 * Waits for one started process to answer, to end, or to run out of time.
 * @param {StartAttempt} attempt
 * @param {StartClock} clock
 * @param {number} deadlineMs
 * @returns {Promise<{ outcome: 'ready' } | { outcome: 'timeout' } | { outcome: 'ended', ended: Ended }>}
 */
export async function awaitStart(attempt, clock, deadlineMs) {
  const startedAt = clock.now();
  for (;;) {
    const ended = clock.ended(attempt);
    if (ended) return { outcome: 'ended', ended };
    if (await clock.listening(attempt.port)) return { outcome: 'ready' };
    if (startExpired(startedAt, clock.now(), deadlineMs)) return { outcome: 'timeout' };
    await clock.sleep(POLL_MS);
  }
}

/**
 * What the panel says, and what the log keeps, for a process that ended before it answered.
 * @param {StartAttempt} attempt
 * @param {Ended} ended
 * @returns {StartFailure}
 */
export function endedFailure(attempt, ended) {
  if ('error' in ended) {
    const raw = ended.error instanceof Error ? ended.error.message : String(ended.error);
    if (/not found/i.test(raw)) return new StartFailure('missing', notFoundDetail(ended.error));
    return new StartFailure('start', raw);
  }
  const output = `${ended.result.stdout}\n${ended.result.stderr}`;
  if (portBusy(output)) return new StartFailure('port', 'another listener answers on the port');
  return new StartFailure('start', failureDetail(output, ended.result.exitCode, attempt.token));
}

/**
 * Brings up exactly one server. A start that timed out is kept, and the next start waits on that same process.
 * A new process is launched only after the kept one has ended, so two servers are never alive together.
 * @param {{ stuck: StartAttempt | null, ports: number[], launch: (port: number) => StartAttempt, clock: StartClock, deadlineMs: number }} env
 * @returns {Promise<{ server: StartAttempt } | { stuck: StartAttempt }>} `server` answers; `stuck` timed out and still runs
 */
export async function bringUp(env) {
  const { clock, deadlineMs } = env;
  if (env.stuck) {
    const kept = await awaitStart(env.stuck, clock, deadlineMs);
    if (kept.outcome === 'ready') return { server: env.stuck };
    if (kept.outcome === 'timeout') return { stuck: env.stuck };
  }
  /** @type {StartFailure} */
  let last = new StartFailure('start', 'no port answered');
  for (const port of env.ports) {
    if (await clock.listening(port)) {
      last = new StartFailure('port', 'another listener answers on the port');
      continue;
    }
    const attempt = env.launch(port);
    const ran = await awaitStart(attempt, clock, deadlineMs);
    if (ran.outcome === 'ready') return { server: attempt };
    if (ran.outcome === 'timeout') return { stuck: attempt };
    const failure = endedFailure(attempt, ran.ended);
    if (failure.kind !== 'port') throw failure;
    last = failure;
  }
  throw last;
}

/**
 * Check this on the raw error. A message that has already been made plain no longer says "not granted".
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNotGranted(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not granted/i.test(message);
}

/**
 * @param {string} platform
 * @returns {boolean}
 */
export function pageOnThisSystem(platform) {
  // Node says darwin. This runtime says macos.
  return platform === 'darwin' || platform === 'macos';
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
 * The saved port first when it is one of the granted ports, then the rest, with no duplicates.
 * @param {unknown} saved
 * @returns {number[]}
 */
export function portOrder(saved) {
  /** @type {number[]} */
  const ports = [];
  for (let offset = 0; offset < PORT_SPAN; offset += 1) ports.push(FIRST_PORT + offset);
  if (ports.includes(/** @type {number} */ (saved))) {
    return [/** @type {number} */ (saved), ...ports.filter((port) => port !== saved)];
  }
  return ports;
}

/**
 * Server files stay in the plugin data folder, which the host names.
 * @param {unknown} dataDir
 * @returns {{ dataDir: string, cliDir: string }}
 */
export function serverFolders(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.startsWith('/')) {
    throw new Error('The plugin data folder is missing.');
  }
  const base = dataDir.replace(/\/+$/, '');
  return {
    dataDir: `${base}/server`,
    cliDir: `${base}/cli`,
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
 * What the panel says for each kind of failure. Raw process output never appears here; it goes to the log.
 * @type {Record<string, string>}
 */
const PANEL_TEXT = {
  start: 'VSCodium did not start. Press Try again.',
  missing: 'VSCodium was not found on this computer. Install VSCodium, then in VSCodium run "Shell Command: Install \'codium\' command in PATH". Then press Try again.',
  denied: "VSCodium cannot reach its own page yet. Approve this plugin's permissions, then press Try again.",
  port: 'Another program is using a port VSCodium needs. Close it, then press Try again.',
  timeout: STARTUP_TIMEOUT_TEXT,
  stopped: 'VSCodium stopped. Press Try again.',
  folder: "VSCodium could not open this thread's folder. Press Try again.",
};

/**
 * @param {string} kind
 * @returns {string}
 */
export function panelText(kind) {
  return PANEL_TEXT[kind] ?? PANEL_TEXT.start;
}

/**
 * The full process output for the log, with the connection token removed.
 * @param {string} output
 * @param {number | null | undefined} exitCode
 * @param {string} token
 * @returns {string}
 */
export function failureDetail(output, exitCode, token) {
  return `exit code ${exitCode ?? 'none'}\n${scrub(output || '', token)}`;
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
    // Each segment is encoded alone, so # and ? stay part of the name and / keeps its place.
    let target = file.split('/').map((segment) => encodeURIComponent(segment)).join('/');
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
    const payload = [['openFile', `vscode-remote://127.0.0.1:${port}${target}`]];
    if (line !== undefined) payload.push(['gotoLineMode', 'true']);
    url.searchParams.set('payload', JSON.stringify(payload));
  }
  return url.toString();
}

/**
 * The reason `codium` could not start, for the log.
 * @param {unknown} error
 * @returns {string}
 */
export function notFoundDetail(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not start codium: ${reason}`;
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
 * A file opens only when its real location is inside the thread's own folder, so symbolic links cannot lead out.
 * @param {string} folder the thread's folder: its environment when it has one, else its project folder
 * @param {unknown} file
 * @param {(path: string) => Promise<string | null>} realpathOf answers null when the path does not resolve
 * @returns {Promise<string>}
 */
export async function resolveOpenPath(folder, file, realpathOf) {
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
  const full = insideFolder(folder, path);
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
  if (insideFolder(realFolder, real) === null) {
    throw new Error(`${path} is outside this thread's folder.`);
  }
  return full;
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
 * A saved request opens only on the thread that made it. While another thread is on screen it stays queued.
 * @template T
 * @param {{ take(threadId: string): T | null }} queue
 * @param {string | null} screenThreadId
 * @returns {T | null}
 */
export function requestForScreen(queue, screenThreadId) {
  if (!screenThreadId) return null;
  return queue.take(screenThreadId);
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
