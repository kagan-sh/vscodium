// What one editor_open asks for, and what happens to it: open now, queue for the panel, or refuse.
// Pure helpers with no kagan imports.

import { resolveOpenPath } from './paths.js';
import { PENDING_MS } from './pending.js';

/** @typedef {{ path: string, line?: number, column?: number }} OpenSpec */

/** How long a queued request waits, in whole minutes, for the panel to be shown. */
const KEPT_MINUTES = Math.round(PENDING_MS / 60000);

/**
 * @param {unknown} line
 * @param {unknown} column
 * @returns {{ line?: number, column?: number }}
 * @throws when a line or column is not a whole number from 1, or a column has no line
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
  return `Opening ${where}. The first start can take a few minutes.`;
}

/**
 * @param {string} where
 * @returns {string}
 */
export function laterText(where) {
  return `This thread is not on screen. ${where} will open in VSCodium the next time this panel is shown. That request is kept for ${KEPT_MINUTES} minutes, and a newer editor_open replaces it.`;
}

/**
 * The one request behind one editor_open. `show` opens the panel and may fail; the request is
 * queued either way, so a panel that cannot open now still shows the file when it next can.
 * @param {{
 *   threadId: string,
 *   request: { path?: unknown, line?: unknown, column?: unknown },
 *   folder: string,
 *   otherFolders: () => Promise<string[]>,
 *   realpathOf: (path: string) => Promise<string | null>,
 *   onScreen: (threadId: string) => boolean,
 *   show: () => Promise<void>,
 *   queue: { put(threadId: string, value: OpenSpec): void },
 *   ready: boolean,
 * }} env
 * @returns {Promise<string>} what to tell the agent
 * @throws when the path or position is refused, or the panel cannot be opened
 */
export async function openFile(env) {
  const asks = typeof env.request.path === 'string' && env.request.path.trim().startsWith('/');
  const file = await resolveOpenPath(env.folder, env.request.path, env.realpathOf, asks ? await env.otherFolders() : []);
  const position = openPosition(env.request.line, env.request.column);
  const where = openedWhere(file, position.line, position.column);
  env.queue.put(env.threadId, { path: file, ...position });
  if (!env.onScreen(env.threadId)) return laterText(where);
  await env.show();
  if (!env.onScreen(env.threadId)) return laterText(where);
  return openingText(where, env.ready);
}
