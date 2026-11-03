// @ts-check
import { v_flex } from 'gpui-base';
import { View, div } from 'gpui-kit';
import * as gpuiComponent from 'gpui-component';
import { Input, InputState, KgButton } from 'gpui-component';
import { context, onContextChanged, threadOnScreen } from 'kagan/host';
import { run } from 'kagan/process';
import { next, reply, fail } from 'kagan/jobs';
import { environment, get, project } from 'kagan/threads';
import {
  FILE_FIELD_LABEL,
  PENDING_MS,
  beginToolLaunch,
  codiumArgs,
  codiumWorkspaceArgs,
  createPending,
  endToolLaunch,
  fileFieldPath,
  laterText,
  notFoundText,
  resolveOpenPath,
  worktreePaths,
} from './editor.js';

const STARTING = 'Starting VSCodium on this Mac…';
const PREPARING = 'Preparing VSCodium';
const PAGE_MISSING =
  'VSCodium\'s page is not running on this Mac. This panel can show a local page, and it cannot start that server.';

/**
 * @typedef {{ args: string[], where: string }} Parked
 */

/** @type {OpenPanel | null} */
let panel = null;

/** @type {{ put(threadId: string, value: Parked): void, take(threadId: string): Parked | null }} */
const pending = createPending(PENDING_MS);

export default class Plugin extends View {
  init(_props, cx) {
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
  /** @param {import("gpui-shell").Props | undefined} _props @param {import("gpui-kit").AsyncContext} cx */
  init(_props, cx) {
    panel = this;
    /** @type {import("gpui-kit").AsyncContext} */
    this.cx = cx;
    this.path = InputState.new(FILE_FIELD_LABEL, '');
    this.path.on('submit', (_event, ctx) => this.openFile(ctx));
    this.status = PREPARING;
    this.page = '';
    this.pageMissing = false;
    this.busy = false;
    this.hold = 0;
    cx.spawn(async () => {
      await this.consumePending();
      this.settlePage();
      for (;;) {
        await onContextChanged();
        await this.consumePending();
        this.settlePage();
      }
    });
  }

  settlePage() {
    if (this.busy || this.page || (this.status && this.status !== PREPARING)) return;
    this.pageMissing = true;
    this.apply(PAGE_MISSING, false);
  }

  /** @param {import("gpui-kit").Context} _cx */
  tryAgain(_cx) {
    if (this.busy) return;
    this.page = '';
    this.pageMissing = false;
    this.status = PREPARING;
    this.settlePage();
  }

  /** @param {string} text @param {boolean} busy */
  apply(text, busy) {
    this.status = text;
    this.busy = busy;
    this.cx.notify();
  }

  async consumePending() {
    if (this.busy) return;
    const threadId = context().threadId;
    if (!threadId) return;
    const parked = pending.take(threadId);
    if (!parked) return;
    this.apply(STARTING, true);
    const outcome = await launch(parked.args);
    this.apply(outcome.text, false);
  }

  /** @param {import("gpui-kit").Context} cx */
  openWorkspace(cx) {
    if (this.busy) return;
    const threadId = context().threadId;
    if (!threadId) {
      this.apply('Open a thread first. There is no workspace to open.', false);
      return;
    }
    this.hold += 1;
    this.apply('Finding this thread\'s workspace.', true);
    cx.spawn(async () => {
      try {
        const roots = await threadRoots(threadId);
        this.apply(STARTING, true);
        const outcome = await launch(codiumWorkspaceArgs(roots.workspace));
        this.apply(outcome.text, false);
      } catch (error) {
        this.apply(sentence(error), false);
      } finally {
        this.hold -= 1;
        await this.consumePending();
      }
    });
  }

  /** @param {import("gpui-kit").Context} cx */
  openFile(cx) {
    if (this.busy) return;
    const field = fileFieldPath(this.path.value());
    if (field.empty) {
      this.apply('The file field is empty.', false);
      return;
    }
    const threadId = context().threadId;
    if (!threadId) {
      this.apply('Open a thread first. A file opens inside that thread\'s workspace.', false);
      return;
    }
    this.hold += 1;
    this.apply('Finding this thread\'s workspace.', true);
    cx.spawn(async () => {
      try {
        const outcome = await openFile(threadId, { path: field.path, line: field.line }, true);
        this.apply(outcome.text, false);
      } catch (error) {
        this.apply(sentence(error), false);
      } finally {
        this.hold -= 1;
        await this.consumePending();
      }
    });
  }

  render() {
    const page = this.page ? editorPage(this.page) : null;
    if (page) return page;
    const column = v_flex()
      .id('vscodium-open')
      .size_full()
      .items_center()
      .justify_center()
      .p_4()
      .gap_3()
      .child(div().w_full().text_center().child(this.status || PREPARING));
    if (this.pageMissing) {
      column.child(
        new KgButton('try-again')
          .label('Try again')
          .disabled(this.busy)
          .on_click((_event, cx) => this.tryAgain(cx)),
      );
    }
    return column
      .child(
        new KgButton('open-workspace')
          .label('Open workspace in VSCodium')
          .primary()
          .disabled(this.busy)
          .on_click((_event, cx) => this.openWorkspace(cx)),
      )
      .child(FILE_FIELD_LABEL)
      .child('Put :42 on the end of the path to open at that line.')
      .child(div().w_full().child(new Input(this.path).aria_label(FILE_FIELD_LABEL)))
      .child(
        new KgButton('open-file')
          .label('Open this file')
          .disabled(this.busy)
          .on_click((_event, cx) => this.openFile(cx)),
      );
  }
}

// The running app may not export WebView yet. A static import would fail the whole panel.
/**
 * @param {string} url
 * @returns {import("gpui-kit").Element | null}
 */
function editorPage(url) {
  const host = /** @type {Record<string, { new (id: string): { url(url: string): import("gpui-kit").Element } } | undefined>} */ (
    /** @type {unknown} */ (gpuiComponent)
  );
  const WebView = host.WebView;
  if (!WebView) return null;
  return new WebView('editor').url(url);
}

/**
 * @param {string} threadId
 * @param {string} text
 */
function showStatus(threadId, text) {
  if (!panel) return;
  const face = beginToolLaunch(context().threadId ?? null, threadId);
  if (face.visible !== face.owner) return;
  if (panel.hold > 0) {
    panel.status = text;
    panel.cx.notify();
    return;
  }
  panel.apply(text, face.busy);
}

/**
 * @param {string} threadId
 * @param {string} text
 */
async function finishToolLaunch(threadId, text) {
  if (!panel) return;
  const visible = context().threadId ?? null;
  if (panel.hold > 0) {
    if (visible === threadId) {
      panel.status = text;
      panel.cx.notify();
    }
    return;
  }
  const step = endToolLaunch({ busy: panel.busy, visible, owner: threadId }, pending);
  if (step.open) {
    panel.apply(STARTING, true);
    const outcome = await launch(step.open.args);
    await finishToolLaunch(visible, outcome.text);
    return;
  }
  if (visible === threadId) {
    panel.apply(text, false);
    return;
  }
  panel.pageMissing = true;
  panel.apply(PAGE_MISSING, false);
}

/**
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function launch(args) {
  const target = args[args.length - 1];
  let result;
  try {
    result = await run('codium', args, { timeoutMs: 15000 });
  } catch (error) {
    return { ok: false, text: notFoundText(error) };
  }
  if (result.exitCode === 0) {
    const text = args.includes('--goto') ? `Opened ${target}.` : `Opened the workspace ${target}.`;
    return { ok: true, text };
  }
  const detail = firstLine(result.stderr) || `exit code ${result.exitCode ?? 'none'}`;
  return { ok: false, text: `VSCodium did not open it: ${detail}` };
}

/**
 * @param {string} threadId
 * @param {{ path?: unknown, line?: unknown }} request
 * @param {boolean} fromPanel
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function openFile(threadId, request, fromPanel) {
  const roots = await threadRoots(threadId);
  const path = resolveOpenPath(roots.workspace, roots.environment, roots.worktrees, request.path, roots.gitError);
  const args = codiumArgs({ path, line: request.line });
  const where = args[args.length - 1];
  if (!fromPanel && !threadOnScreen(threadId)) {
    pending.put(threadId, { args, where });
    return { ok: true, text: laterText(where) };
  }
  if (!fromPanel) pending.take(threadId);
  showStatus(threadId, STARTING);
  const outcome = await launch(args);
  if (!fromPanel) await finishToolLaunch(threadId, outcome.text);
  return outcome;
}

/**
 * @param {string} threadId
 * @returns {Promise<{ workspace: string, environment: string | null, worktrees: string[], gitError: string | null }>}
 */
async function threadRoots(threadId) {
  const thread = await get(threadId);
  /** @type {string | null} */
  let environmentPath = null;
  if (thread.environmentId) {
    const folder = (await environment(thread.environmentId)).path;
    if (folder) environmentPath = folder;
  }
  const workspace = environmentPath || (await project(thread.projectId)).path;
  if (!workspace) throw new Error('This thread has no workspace folder yet.');
  const listed = await listWorktrees(workspace);
  return { workspace, environment: environmentPath, worktrees: listed.paths, gitError: listed.error };
}

/**
 * @param {string} folder
 * @returns {Promise<{ paths: string[], error: string | null }>}
 */
async function listWorktrees(folder) {
  try {
    const result = await run('git', ['worktree', 'list', '--porcelain'], { cwd: folder, timeoutMs: 5000 });
    if (result.exitCode !== 0) {
      const detail = firstLine(result.stderr) || `exit code ${result.exitCode ?? 'none'}`;
      if (/not a git repository/i.test(detail)) return { paths: [], error: null };
      return { paths: [], error: detail };
    }
    return { paths: worktreePaths(result.stdout), error: null };
  } catch (error) {
    return { paths: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function sentence(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} text */
function firstLine(text) {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * @param {import("kagan/jobs").Job} job
 */
async function handle(job) {
  if (job.kind === 'tool' && job.name === 'editor_open') {
    const threadId = typeof job.threadId === 'string' ? job.threadId : '';
    if (!threadId) return { text: 'editor_open needs a thread.', isError: true };
    const input = job.input !== null && typeof job.input === 'object' ? /** @type {{ path?: unknown, line?: unknown }} */ (job.input) : {};
    try {
      const outcome = await openFile(threadId, input, false);
      return { text: outcome.text, isError: !outcome.ok };
    } catch (error) {
      return { text: sentence(error), isError: true };
    }
  }
  throw new Error(`Unknown job ${job.kind}: ${job.name ?? ''}`);
}
