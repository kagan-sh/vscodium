// @ts-check
// The plugin entry: the job loop and the host calls a job cannot make itself.
// The panel is panel.js; the editor server is runtime.js; the open policy is open.js.

import { View } from 'gpui-kit';
import { log, openPanel, threadOnScreen } from 'kagan/host';
import { next, reply, fail } from 'kagan/jobs';
import { run } from 'kagan/process';
import { environment } from 'kagan/threads';
import { createJobs } from './jobs.js';
import { openFile } from './open.js';
import { currentPanel } from './panel.js';
import { pending, serverRunning, setContext } from './runtime.js';
import { plainError } from './text.js';
import { otherFolders, threadFolder } from './workspace.js';

export { OpenPanel } from './panel.js';

export default class Plugin extends View {
  /** @param {import('gpui-shell').Props | undefined} _props @param {import('gpui-kit').AsyncContext} cx */
  init(_props, cx) {
    setContext(cx);
    const answer = createJobs({
      openFor,
      showPanel: (props) => openPanel('open', props),
      environmentPath: (id) => environment(id).then((entry) => entry.path || null),
      resolvePath: realpathOf,
    });
    cx.spawn(async () => {
      for (;;) {
        const job = await next();
        answer(job).then(
          (value) => reply(job.id, value),
          (error) => {
            log('error', error instanceof Error ? error.message : String(error));
            fail(job.id, plainError(error));
          },
        );
      }
    });
  }

  // The entry draws nothing; its panel view does.
  render() {
    return '';
  }
}

/**
 * @param {string} threadId
 * @param {{ path?: unknown, line?: unknown, column?: unknown }} request
 * @returns {Promise<string>}
 */
async function openFor(threadId, request) {
  return openFile({
    threadId,
    request,
    folder: await threadFolder(threadId),
    otherFolders,
    realpathOf,
    onScreen: threadOnScreen,
    show: () => showEditor(threadId),
    queue: pending,
    ready: serverRunning(),
  });
}

/**
 * Opens the panel for a thread and lets the view that is showing it look at the queue again.
 * @param {string} threadId
 */
async function showEditor(threadId) {
  await openPanel('open');
  if (threadOnScreen(threadId)) currentPanel()?.reveal();
}

/**
 * The real location of a path, or null when it does not exist. Uses the `realpath` program the plugin is granted.
 * A failure is logged with the program's own reason, which is the only place a permission or loop error shows.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function realpathOf(path) {
  const result = await run('realpath', [path], { timeoutMs: 5000 });
  if (result.exitCode !== 0) {
    log('debug', `realpath ${path}: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`);
    return null;
  }
  return firstLine(result.stdout) || null;
}

/** @param {string} text */
function firstLine(text) {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}
