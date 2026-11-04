// The one editor server this plugin runs, shared by every panel, and the requests waiting for a panel.
// Server supervision is here; the view that shows the page is in panel.js.

import { randomBytes } from 'crypto';
import { mkdir } from 'fs/promises';
import proc from 'process';
import { run } from 'kagan/process';
import {
  HOLD_MS,
  START_DEADLINE_MS,
  StartFailure,
  bringUp,
  connectionToken,
  failureDetail,
  isNotGranted,
  portOrder,
  scrub,
  serveWebArgs,
  serverFolders,
  versionReady,
  versionUrl,
} from './server.js';
import { PENDING_MS, createPending } from './pending.js';

/** @typedef {import('./server.js').StartAttempt} StartAttempt */
/** @typedef {import('./server.js').Ended} Ended */

/** The latest editor_open per thread, waiting for that thread's panel. @type {import('./pending.js').Pending<import('./open.js').OpenSpec>} */
export const pending = createPending(PENDING_MS);

/** @type {StartAttempt | null} */
let running = null;

/** @type {Promise<StartAttempt> | null} */
let starting = null;

/** A start that timed out. Its process still runs, and the next start waits on it. @type {StartAttempt | null} */
let stuck = null;

/** @type {Map<StartAttempt, Ended>} */
const ended = new Map();

/** The newest panel, told when the server is ready or stops. @type {((event: { kind: 'ready' } | { kind: 'stopped', detail: string }) => void) | null} */
let listener = null;

/** The plugin's own context, for the timer a start waits on. A panel view can be replaced. @type {import('gpui-kit').AsyncContext | null} */
let pluginCx = null;

/** @param {import('gpui-kit').AsyncContext} cx */
export function setContext(cx) {
  pluginCx = cx;
}

/** @param {(event: { kind: 'ready' } | { kind: 'stopped', detail: string }) => void} notify */
export function listenServer(notify) {
  listener = notify;
}

export function serverRunning() {
  return running !== null;
}

/**
 * The one server, started on first use. The start belongs to the plugin, not to the panel that
 * asked for it, so replacing that view does not cancel the wait.
 * @returns {Promise<StartAttempt>}
 */
export function ensureServer() {
  const cx = pluginCx;
  if (!cx) return Promise.reject(new Error('VSCodium is not ready yet.'));
  if (running) return Promise.resolve(running);
  if (starting) return starting;
  starting = boot(cx).then(
    (server) => {
      running = server;
      starting = null;
      // A panel view can be replaced while this start runs, and the view that waited is
      // then gone. The newest view has to be told the server is ready, or it sits on
      // "Starting VSCodium" until something else changes the context.
      listener?.({ kind: 'ready' });
      return server;
    },
    (error) => {
      starting = null;
      throw error;
    },
  );
  return starting;
}

/**
 * @param {import('gpui-kit').AsyncContext} cx
 * @returns {Promise<StartAttempt>}
 */
async function boot(cx) {
  const dirs = await serverDirs();
  const saved = Number(localStorage.getItem('port'));
  const outcome = await bringUp({
    stuck,
    ports: portOrder(Number.isInteger(saved) ? saved : null),
    launch: (port) => launch(port, dirs),
    clock: {
      now: () => Date.now(),
      sleep: (ms) => sleep(cx, ms),
      listening: (port) => answering(port),
      ended: (attempt) => ended.get(attempt) ?? null,
    },
    deadlineMs: START_DEADLINE_MS,
  });
  if ('stuck' in outcome) {
    stuck = outcome.stuck;
    throw new StartFailure('timeout', 'no answer from the server before the deadline');
  }
  stuck = null;
  localStorage.setItem('port', String(outcome.server.port));
  watch(outcome.server);
  return outcome.server;
}

/**
 * @param {number} port
 * @param {{ dataDir: string, cliDir: string }} dirs
 * @returns {StartAttempt}
 */
function launch(port, dirs) {
  const token = connectionToken(new Uint8Array(randomBytes(24)));
  const promise = run('codium', serveWebArgs({ port, token, dataDir: dirs.dataDir, cliDir: dirs.cliDir }), { timeoutMs: HOLD_MS });
  /** @type {StartAttempt} */
  const attempt = { port, token, promise };
  promise.then(
    (result) => ended.set(attempt, { result }),
    (error) => ended.set(attempt, { error }),
  );
  return attempt;
}

/** @param {StartAttempt} attempt */
function watch(attempt) {
  attempt.promise.then(
    (result) => {
      if (running !== attempt) return;
      running = null;
      listener?.({ kind: 'stopped', detail: failureDetail(`${result.stdout}\n${result.stderr}`, result.exitCode, attempt.token) });
    },
    (error) => {
      if (running !== attempt) return;
      running = null;
      const message = error instanceof Error ? error.message : String(error);
      if (/unloaded/.test(message)) return;
      listener?.({ kind: 'stopped', detail: scrub(message, attempt.token) });
    },
  );
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function answering(port) {
  try {
    const response = await fetch(versionUrl(port));
    return versionReady(response.status);
  } catch (error) {
    if (isNotGranted(error)) throw error;
    return false;
  }
}

/**
 * @param {import('gpui-kit').AsyncContext} cx
 * @param {number} ms
 */
function sleep(cx, ms) {
  return new Promise((resolve) => {
    cx.timer.after(ms, () => resolve());
  });
}

/**
 * @returns {Promise<{ dataDir: string, cliDir: string }>}
 */
async function serverDirs() {
  const folders = serverFolders(proc.dataDir);
  await mkdir(folders.dataDir, { recursive: true });
  await mkdir(folders.cliDir, { recursive: true });
  return folders;
}

/**
 * @param {unknown} error
 * @returns {import('./server.js').FailureKind}
 */
export function kindOf(error) {
  if (error instanceof StartFailure) return error.kind;
  return isNotGranted(error) ? 'denied' : 'start';
}

/** @param {unknown} error */
export function detailOf(error) {
  return error instanceof StartFailure ? error.detail : error instanceof Error ? error.message : String(error);
}
