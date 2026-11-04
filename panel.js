// The VSCodium panel: one editor page for the thread on screen, or for a folder the panel was opened for.

import { v_flex } from 'gpui-base';
import { View, div } from 'gpui-kit';
import { KgButton, WebView } from 'gpui-component';
import proc from 'process';
import { context, log, onContextChanged } from 'kagan/host';
import { editorPageUrl } from './page.js';
import { panelRequest, pinState } from './target.js';
import { NO_THREAD, ONLY_MACOS, STARTING, pageOnThisSystem, panelText, plainError } from './text.js';
import { ensureServer, detailOf, kindOf, listenServer, pending } from './runtime.js';
import { threadFolder } from './workspace.js';

/** @typedef {{ threadId: string | null, folder: string }} Target */

/** @type {OpenPanel | null} */
let shownPanel = null;

/** The panel the host last created, if any. */
export function currentPanel() {
  return shownPanel;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<{ value: T } | { error: unknown }>}
 */
async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

export class OpenPanel extends View {
  /** @param {import('gpui-shell').Props | undefined} _props @param {import('gpui-kit').AsyncContext} cx */
  init(_props, cx) {
    shownPanel = this;
    /** @type {import('gpui-kit').AsyncContext} */
    this.cx = cx;
    this.status = STARTING;
    this.page = '';
    this.failed = false;
    this.busy = false;
    this.generation = 0;
    /** @type {{ threadId: string, folder: string, url: string } | null} */
    this.shown = null;
    /** @type {import('./target.js').TargetState} */
    this.targets = { pin: null, honoured: '' };
    listenServer((event) => {
      if (event.kind === 'ready') this.reveal();
      else this.showFailure('stopped', event.detail);
    });
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

  /**
   * Shows a failure instead of the page. It takes a generation, so a sync still waiting on the
   * server cannot paint over it with a page from a process that has stopped.
   * @param {import('./server.js').FailureKind} kind
   * @param {string} detail
   */
  showFailure(kind, detail) {
    this.generation += 1;
    log('error', detail || kind);
    this.page = '';
    this.shown = null;
    this.failed = true;
    this.busy = false;
    this.status = panelText(kind);
    this.cx.notify();
  }

  /** @param {string} status */
  idle(status) {
    this.page = '';
    this.failed = false;
    this.busy = false;
    this.status = status;
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

  /**
   * The folder to show: the one this panel was opened for, while it lasts, else the shown thread's.
   * @returns {Promise<Target | null>}
   */
  async resolveTarget() {
    const threadId = context().threadId;
    this.targets = pinState(this.targets, panelRequest(context().props), threadId);
    if (this.targets.pin) return { threadId, folder: this.targets.pin.folder };
    if (!threadId) return null;
    return { threadId, folder: await threadFolder(threadId) };
  }

  /**
   * The target, or why there is none. A failure is shown here, once, for both attempts.
   * @param {{ value: Target | null } | { error: unknown }} result
   * @returns {Target | null}
   */
  settleTarget(result) {
    if ('error' in result) {
      this.showFailure('folder', plainError(result.error));
      return null;
    }
    if (result.value) return result.value;
    this.idle(NO_THREAD);
    return null;
  }

  async sync() {
    const turn = ++this.generation;
    const fresh = () => turn === this.generation;
    // The thread can change while the server starts, and a replaced view's turn is stale.
    const target = async () => {
      const result = await settle(this.resolveTarget());
      if (!fresh()) return null;
      return this.settleTarget(result);
    };
    if (!pageOnThisSystem(proc.platform)) {
      this.idle(ONLY_MACOS);
      return;
    }
    const first = await target();
    if (!first) return;
    this.failed = false;
    if (!this.page) {
      this.busy = true;
      this.status = STARTING;
      this.cx.notify();
    }
    const server = await settle(ensureServer());
    if (!fresh()) return;
    if ('error' in server) {
      this.showFailure(kindOf(server.error), detailOf(server.error));
      return;
    }
    const current = await target();
    if (!current) return;
    const threadId = current.threadId ?? '';
    // Only the thread on screen takes its request; another thread's stays queued for its own view.
    const spec = threadId ? pending.take(threadId) : null;
    let url;
    try {
      url = this.shown !== null && this.shown.threadId === threadId && this.shown.folder === current.folder && !spec
        ? this.shown.url
        : editorPageUrl({
          port: server.value.port,
          token: server.value.token,
          folder: current.folder,
          file: spec?.path,
          line: spec?.line,
          column: spec?.column,
        });
    } catch (error) {
      this.showFailure('folder', plainError(error));
      return;
    }
    this.shown = { threadId, folder: current.folder, url };
    this.page = url;
    this.failed = false;
    this.busy = false;
    this.status = '';
    this.cx.notify();
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
