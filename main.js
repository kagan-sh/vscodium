// @ts-check
import { v_flex } from 'gpui-base';
import { View, div } from 'gpui-kit';
import { KgButton, WebView } from 'gpui-component';
import { randomBytes } from 'crypto';
import { mkdir } from 'fs/promises';
import proc from 'process';
import { context, log, onContextChanged, openPanel, threadOnScreen } from 'kagan/host';
import { run } from 'kagan/process';
import { next, reply, fail } from 'kagan/jobs';
import { environment, get, project } from 'kagan/threads';
import {
  HOLD_MS,
  ONLY_MACOS,
  STARTING,
  connectionToken,
  isNotGranted,
  editorPageUrl,
  failureDetail,
  panelText,
  laterText,
  openPosition,
  openedWhere,
  openingText,
  pageOnThisSystem,
  portOrder,
  resolveOpenPath,
  scrub,
  serverFolders,
  serveWebArgs,
  versionReady,
  versionUrl,
  createPending,
  PENDING_MS,
  requestForScreen,
  START_DEADLINE_MS,
  bringUp,
  StartFailure,
} from './editor.js';

const NO_THREAD = 'Open a thread first. There is no workspace to open.';

/**
 * @typedef {{ path: string, line?: number, column?: number }} OpenSpec
 * @typedef {{ port: number, token: string, promise: Promise<{ exitCode: number | null, stdout: string, stderr: string }> }} Server
 */

/** @type {OpenPanel | null} */
let panel = null;

/** @type {import('gpui-kit').AsyncContext | null} */
let pluginCx = null;

/** @type {Server | null} */
let running = null;

/** @type {Promise<Server> | null} */
let starting = null;

/** A start that timed out. Its process still runs, and the next start waits on it. @type {Server | null} */
let stuck = null;

/** @type {Map<Server, { result?: { exitCode: number | null, stdout: string, stderr: string }, error?: unknown }>} */
const ended = new Map();

/** Every token this process has made, so the log can hide them. */
/** @type {string[]} */
const tokens = [];

/** @type {{ put(threadId: string, value: OpenSpec): void, take(threadId: string): OpenSpec | null }} */
const pending = createPending(PENDING_MS);

export default class Plugin extends View {
  /** @param {import('gpui-shell').Props | undefined} _props @param {import('gpui-kit').AsyncContext} cx */
  init(_props, cx) {
    pluginCx = cx;
    cx.spawn(async () => {
      for (;;) {
        const job = await next();
        handle(job).then(
          (value) => reply(job.id, value),
          (error) => fail(job.id, String(error)),
        );
      }
    });
  }
}

export class OpenPanel extends View {
  /** @param {import('gpui-shell').Props | undefined} _props @param {import('gpui-kit').AsyncContext} cx */
  init(_props, cx) {
    panel = this;
    /** @type {import('gpui-kit').AsyncContext} */
    this.cx = cx;
    this.status = STARTING;
    this.page = '';
    this.failed = false;
    this.busy = false;
    this.generation = 0;
    /** @type {{ threadId: string, folder: string, url: string } | null} */
    this.shown = null;
    cx.spawn(async () => {
      await this.sync();
      for (;;) {
        await onContextChanged();
        await this.sync();
      }
    });
  }

  reveal() {
    this.cx.spawn(() => this.sync());
  }

  /** @param {string} kind @param {string} detail */
  showFailure(kind, detail) {
    log('error', logged(detail || kind));
    this.page = '';
    this.shown = null;
    this.failed = true;
    this.busy = false;
    this.status = panelText(kind);
    this.cx.notify();
  }

  /** @param {import('gpui-kit').Context} cx */
  tryAgain(cx) {
    if (this.busy) return;
    this.failed = false;
    this.page = '';
    this.shown = null;
    this.status = STARTING;
    cx.spawn(() => this.sync());
  }

  async sync() {
    const turn = ++this.generation;
    const fresh = () => turn === this.generation;
    if (!pageOnThisSystem(proc.platform)) {
      this.page = '';
      this.failed = false;
      this.busy = false;
      this.status = ONLY_MACOS;
      this.cx.notify();
      return;
    }
    const threadId = context().threadId;
    if (!threadId) {
      this.page = '';
      this.failed = false;
      this.busy = false;
      this.status = NO_THREAD;
      this.cx.notify();
      return;
    }
    this.failed = false;
    if (!this.page) {
      this.busy = true;
      this.status = STARTING;
      this.cx.notify();
    }
    let server;
    try {
      server = await ensureServer();
    } catch (error) {
      if (!fresh()) return;
      this.showFailure(kindOf(error), detailOf(error));
      return;
    }
    if (!fresh()) return;
    const current = context().threadId;
    if (!current) {
      this.page = '';
      this.busy = false;
      this.status = NO_THREAD;
      this.cx.notify();
      return;
    }
    try {
      const folder = (await workspaceOf(current)).workspace;
      if (!fresh()) return;
      const spec = requestForScreen(pending, current);
      const shown = this.shown;
      const same = shown !== null && shown.threadId === current && shown.folder === folder && !spec;
      const url = same
        ? shown.url
        : editorPageUrl({
          port: server.port,
          token: server.token,
          folder,
          file: spec?.path,
          line: spec?.line,
          column: spec?.column,
        });
      this.shown = { threadId: current, folder, url };
      this.page = url;
      this.failed = false;
      this.busy = false;
      this.status = '';
      this.cx.notify();
    } catch (error) {
      if (!fresh()) return;
      this.showFailure('folder', rawMessage(error));
    }
  }

  render() {
    // The editor keeps the theme and the window state in the page's storage, keyed by origin.
    // Without store(true) that storage is private and thrown away, so every open starts light.
    if (this.page) return new WebView('editor').url(this.page).store(true);
    const column = v_flex()
      .id('vscodium-open')
      .size_full()
      .items_center()
      .justify_center()
      .p_4()
      .gap_3()
      .child(div().id('vscodium-status').w_full().text_center().child(this.status || STARTING));
    if (this.failed) {
      column.child(
        new KgButton('try-again')
          .label('Try again')
          .primary()
          .disabled(this.busy)
          .on_click((_event, cx) => this.tryAgain(cx)),
      );
    }
    return column;
  }
}

function ensureServer() {
  if (running) return Promise.resolve(running);
  if (starting) return starting;
  const cx = pluginCx;
  if (!cx) return Promise.reject(new Error('VSCodium is not ready yet.'));
  starting = boot(cx).then(
    (server) => {
      running = server;
      starting = null;
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
 * @returns {Promise<Server>}
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
 * @returns {Server}
 */
function launch(port, dirs) {
  const token = connectionToken(new Uint8Array(randomBytes(24)));
  tokens.push(token);
  const promise = run('codium', serveWebArgs({ port, token, dataDir: dirs.dataDir, cliDir: dirs.cliDir }), { timeoutMs: HOLD_MS });
  /** @type {Server} */
  const attempt = { port, token, promise };
  promise.then(
    (result) => ended.set(attempt, { result }),
    (error) => ended.set(attempt, { error }),
  );
  return attempt;
}

/** @param {Server} attempt */
function watch(attempt) {
  attempt.promise.then(
    (result) => {
      if (running !== attempt) return;
      running = null;
      panel?.showFailure('stopped', failureDetail(`${result.stdout}\n${result.stderr}`, result.exitCode, attempt.token));
    },
    (error) => {
      if (running !== attempt) return;
      running = null;
      const message = rawMessage(error);
      if (/unloaded/.test(message)) return;
      panel?.showFailure('stopped', scrub(message, attempt.token));
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

/** @param {unknown} error */
function kindOf(error) {
  if (error instanceof StartFailure) return error.kind;
  return isNotGranted(error) ? 'denied' : 'start';
}

/** @param {unknown} error */
function detailOf(error) {
  return error instanceof StartFailure ? error.detail : rawMessage(error);
}

/** @param {unknown} error */
function rawMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} text */
function logged(text) {
  return tokens.reduce((clean, token) => scrub(clean, token), text);
}

/**
 * @param {string} threadId
 * @param {{ path?: unknown, line?: unknown, column?: unknown }} request
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function openFile(threadId, request) {
  const place = await workspaceOf(threadId);
  const file = await resolveOpenPath(place.workspace, request.path, realpathOf);
  const position = openPosition(request.line, request.column);
  const where = openedWhere(file, position.line, position.column);
  /** @type {OpenSpec} */
  const spec = { path: file, ...position };
  if (!threadOnScreen(threadId)) {
    pending.put(threadId, spec);
    return { ok: true, text: laterText(where) };
  }
  pending.put(threadId, spec);
  try {
    await openPanel('open');
  } catch (error) {
    if (!panel) return { ok: false, text: sentence(error) };
  }
  if (!threadOnScreen(threadId)) return { ok: true, text: laterText(where) };
  panel?.reveal();
  return { ok: true, text: openingText(where, Boolean(running)) };
}

/**
 * @param {string} threadId
 * @returns {Promise<{ workspace: string, environment: string | null }>}
 */
async function workspaceOf(threadId) {
  const thread = await get(threadId);
  /** @type {string | null} */
  let environmentPath = null;
  if (thread.environmentId) {
    const folder = (await environment(thread.environmentId)).path;
    if (folder) environmentPath = folder;
  }
  const workspace = environmentPath || (await project(thread.projectId)).path;
  if (!workspace) throw new Error('This thread has no workspace folder yet.');
  return { workspace, environment: environmentPath };
}

/**
 * The real location of a path, or null when it does not exist. Uses the `realpath` program the plugin is granted.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function realpathOf(path) {
  const result = await run('realpath', [path], { timeoutMs: 5000 });
  if (result.exitCode !== 0) return null;
  return firstLine(result.stdout) || null;
}

/** @param {string} text */
function firstLine(text) {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function sentence(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not granted/i.test(message)) {
    return 'VSCodium did not start. Checking the local page is not allowed yet.';
  }
  return message;
}

/**
 * @param {import('kagan/jobs').Job} job
 */
async function handle(job) {
  if (job.kind === 'tool' && job.name === 'editor_open') {
    const threadId = typeof job.threadId === 'string' ? job.threadId : '';
    if (!threadId) return { text: 'editor_open needs a thread.', isError: true };
    const input = job.input !== null && typeof job.input === 'object'
      ? /** @type {{ path?: unknown, line?: unknown, column?: unknown }} */ (job.input)
      : {};
    try {
      const outcome = await openFile(threadId, input);
      return { text: outcome.text, isError: !outcome.ok };
    } catch (error) {
      return { text: sentence(error), isError: true };
    }
  }
  throw new Error(`Unknown job ${job.kind}: ${job.name ?? ''}`);
}
