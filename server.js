// Starting, checking and describing the local `codium serve-web` process.
// Pure helpers with no kagan imports, so `node --test` can run them.

/** How long `codium serve-web` may run. Unloading the plugin stops it sooner. */
export const HOLD_MS = 365 * 24 * 60 * 60 * 1000;

export const POLL_MS = 300;

/** First port to try. */
export const FIRST_PORT = 47321;

/**
 * How many ports to try. Each one is listed in kagan.json as a local fetch power,
 * and the host allows at most eight local entries.
 */
export const PORT_SPAN = 3;

export const START_DEADLINE_MS = 4 * 60 * 1000;

/**
 * @param {number} startedAt
 * @param {number} now
 * @param {number} [limitMs]
 * @returns {boolean}
 */
export function startExpired(startedAt, now, limitMs = START_DEADLINE_MS) {
  return now - startedAt >= limitMs;
}

/** A failed start. `kind` picks the panel text. `detail` goes to the log only. */
export class StartFailure extends Error {
  /** @param {FailureKind} kind @param {string} detail */
  constructor(kind, detail) {
    super(kind);
    this.name = 'StartFailure';
    this.kind = kind;
    this.detail = detail;
  }
}

/** The panel message a failure picks. @typedef {'start'|'missing'|'denied'|'port'|'timeout'|'stopped'|'folder'} FailureKind */

/**
 * @typedef {{ port: number, token: string, promise: Promise<{ exitCode: number | null, stdout: string, stderr: string }> }} StartAttempt
 * @typedef {{ result: { exitCode: number | null, stdout: string, stderr: string } } | { error: unknown }} Ended
 * @typedef {{
 *   now: () => number,
 *   sleep: (ms: number) => Promise<void>,
 *   listening: (port: number) => Promise<boolean>,
 *   ended: (attempt: StartAttempt) => Ended | null,
 * }} StartClock
 */

/**
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
 * @param {StartAttempt} attempt
 * @param {Ended} ended
 * @returns {StartFailure}
 */
export function endedFailure(attempt, ended) {
  if ('error' in ended) {
    const raw = ended.error instanceof Error ? ended.error.message : String(ended.error);
    if (isNotGranted(ended.error)) return new StartFailure('denied', raw);
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
 * Pass the raw error here. A message that has already been made plain no longer says "not granted".
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNotGranted(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not granted/i.test(message);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 * @throws when there are fewer than 16 bytes to make a token from
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
 * @throws when the port, token or a data folder is unusable
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
  /**
   * @param {string} flag
   * @param {unknown} value
   * @param {string} label
   */
  const addDir = (flag, value, label) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw new Error(`The ${label} folder must be an absolute path.`);
    }
    args.push(flag, value);
  };
  addDir('--server-data-dir', dataDir, 'server data');
  addDir('--cli-data-dir', cliDir, 'CLI data');
  return args;
}

/**
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
 * @param {unknown} dataDir
 * @returns {{ dataDir: string, cliDir: string }}
 * @throws when the plugin data folder is missing
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
 * @param {number} status
 * @returns {boolean}
 */
export function versionReady(status) {
  return status === 200;
}

/**
 * codium reports a busy port in its output and still exits 0, so the output is checked, not the exit code.
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
 * @param {unknown} error
 * @returns {string}
 */
export function notFoundDetail(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not start codium: ${reason}`;
}

/**
 * What the log keeps about a start that ended: the exit code and the output, with the token removed.
 * @param {string} output
 * @param {number | null | undefined} exitCode
 * @param {string} token
 * @returns {string}
 */
export function failureDetail(output, exitCode, token) {
  return `exit code ${exitCode ?? 'none'}\n${scrub(output || '', token)}`;
}
