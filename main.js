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
  POLL_MS,
  STARTING,
  connectionToken,
  editorPageUrl,
  failureText,
  laterText,
  notFoundText,
  openPosition,
  openedWhere,
  openingText,
  pageOnThisSystem,
  portBusy,
  portOrder,
  resolveOpenPath,
  scrub,
  serverFolders,
  serveWebArgs,
  versionReady,
  versionUrl,
  createPending,
  PENDING_MS,
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
    /** @type {{ threadId: string, spec: OpenSpec } | null} */
    this.wanted = null;
    cx.spawn(async () => {
      await this.sync();
      for (;;) {
        await onContextChanged();
        await this.sync();
      }
    });
  }

  /** @param {OpenSpec} spec */
  reveal(spec) {
    const threadId = context().threadId;
    if (!threadId) return;
    this.wanted = { threadId, spec };
    this.cx.spawn(() => this.sync());
  }

  /** @param {string} text */
  showFailure(text) {
    log('error', text);
    this.page = '';
    this.shown = null;
    this.failed = true;
    this.busy = false;
    this.status = text;
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
      this.showFailure(sentence(error));
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
      const queued = pending.take(current);
      let spec = queued;
      if (this.wanted?.threadId === current) {
        spec = this.wanted.spec;
        this.wanted = null;
      }
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
      this.showFailure(sentence(error));
    }
  }

  render() {
    if (this.page) return new WebView('editor').url(this.page);
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

class PortInUse extends Error {
  constructor() {
    super('That port is already in use.');
    this.name = 'PortInUse';
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
  const token = connectionToken(new Uint8Array(randomBytes(24)));
  const saved = Number(localStorage.getItem('port'));
  let last = 'VSCodium did not start.';
  for (const port of portOrder(Number.isInteger(saved) ? saved : null)) {
    if (await answering(port)) {
      last = 'VSCodium did not start. That port is already in use.';
      continue;
    }
    const promise = run('codium', serveWebArgs({ port, token, dataDir: dirs.dataDir, cliDir: dirs.cliDir }), { timeoutMs: HOLD_MS });
    /** @type {Server} */
    const attempt = { port, token, promise };
    try {
      await waitReady(cx, attempt);
      localStorage.setItem('port', String(port));
      watch(attempt);
      return attempt;
    } catch (error) {
      if (error instanceof PortInUse) {
        last = `VSCodium did not start. ${error.message}`;
        continue;
      }
      throw error;
    }
  }
  throw new Error(last);
}

/**
 * The listener is ours only when it was down before this process, and this process is still up.
 * `/version` does not ask for the connection token.
 * @param {import('gpui-kit').AsyncContext} cx
 * @param {Server} attempt
 */
async function waitReady(cx, attempt) {
  /** @type {{ result?: { exitCode: number | null, stdout: string, stderr: string }, error?: unknown } | null} */
  let settled = null;
  attempt.promise.then(
    (result) => {
      settled = { result };
    },
    (error) => {
      settled = { error };
    },
  );
  for (;;) {
    if (settled?.error) throw new Error(startError(settled.error, attempt.token));
    if (settled?.result) {
      const output = `${settled.result.stdout}\n${settled.result.stderr}`;
      if (portBusy(output)) throw new PortInUse();
      throw new Error(failureText(output, settled.result.exitCode, attempt.token));
    }
    if (await answering(attempt.port)) return;
    await sleep(cx, POLL_MS);
  }
}

/** @param {Server} attempt */
function watch(attempt) {
  attempt.promise.then(
    (result) => {
      if (running !== attempt) return;
      running = null;
      panel?.showFailure(failureText(`${result.stdout}\n${result.stderr}`, result.exitCode, attempt.token));
    },
    (error) => {
      if (running !== attempt) return;
      running = null;
      const message = sentence(error);
      if (/unloaded/.test(message)) return;
      panel?.showFailure(scrub(message, attempt.token));
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
    const message = sentence(error);
    if (/not granted/i.test(message)) throw error;
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
 * @param {string} token
 */
function startError(error, token) {
  const message = sentence(error);
  if (/not found/i.test(message)) return notFoundText(error);
  return scrub(message, token);
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
  panel?.reveal(spec);
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
