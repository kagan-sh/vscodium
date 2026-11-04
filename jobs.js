// @ts-check
// One job from kagan: the agent tool, the open command and the CLI. The host calls a job needs
// come in as seams, so every branch here runs under node --test.

import { randomBytes } from 'crypto';
import { plainError } from './text.js';

export const USAGE = 'usage: kg vscodium open [--environment <id>] [<folder>]';

/** @typedef {{ path?: unknown, line?: unknown, column?: unknown }} OpenRequest */
/**
 * @typedef {{
 *   openFor: (threadId: string, request: OpenRequest) => Promise<string>,
 *   showPanel: (props?: { path: string, request: string }) => Promise<void>,
 *   environmentPath: (id: string) => Promise<string | null>,
 *   resolvePath: (path: string) => Promise<string | null>,
 * }} Seams
 */

/**
 * @param {Seams} seams
 * @returns {(job: import('kagan/jobs').Job) => Promise<unknown>}
 */
export function createJobs(seams) {
  /**
   * @param {import('kagan/jobs').Job} job
   */
  return async function answer(job) {
    if (job.kind === 'tool') {
      if (job.name !== 'editor_open') throw new Error(`Unknown tool ${job.name}`);
      return editorOpen(job);
    }
    if (job.kind === 'command') {
      if (job.command !== 'open') throw new Error(`Unknown command ${job.command}`);
      await seams.showPanel();
      return null;
    }
    if (job.kind === 'cli') return cli(job);
    throw new Error(`Unknown job ${job.kind}`);
  };

  /**
   * @param {import('kagan/jobs').Job} job
   * @returns {Promise<{ text: string, isError: boolean }>}
   */
  async function editorOpen(job) {
    const threadId = typeof job.threadId === 'string' ? job.threadId : '';
    if (!threadId) return { text: 'editor_open needs a thread.', isError: true };
    const input = job.input !== null && typeof job.input === 'object'
      ? /** @type {OpenRequest} */ (job.input)
      : {};
    try {
      return { text: await seams.openFor(threadId, input), isError: false };
    } catch (error) {
      return { text: plainError(error), isError: true };
    }
  }

  /**
   * @param {import('kagan/jobs').Job} job
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
   */
  async function cli(job) {
    const argv = Array.isArray(job.argv) ? job.argv.map(String) : [];
    const parsed = job.command === 'open' ? parseOpenArgs(argv) : { usage: `Unknown command ${job.command}.` };
    if ('usage' in parsed) return { exitCode: 2, stdout: '', stderr: `${parsed.usage}\n${USAGE}\n` };
    try {
      const opened = await openFolder(parsed);
      if ('error' in opened) return { exitCode: 1, stdout: '', stderr: `${opened.error}\n` };
      await seams.showPanel(opened.path ? { path: opened.path, request: randomBytes(8).toString('hex') } : undefined);
      const what = opened.path ? `Opened ${opened.path}` : 'Opened the thread on screen';
      return { exitCode: 0, stdout: `${what} in VSCodium.\n`, stderr: '' };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: `${plainError(error)}\n` };
    }
  }

  /**
   * The folder the CLI names, checked to exist the same way either form is.
   * @param {{ environmentId?: string, folder?: string }} parsed
   * @returns {Promise<{ path: string | null } | { error: string }>}
   */
  async function openFolder(parsed) {
    let path = null;
    if (parsed.environmentId) {
      path = await seams.environmentPath(parsed.environmentId);
      if (!path) return { error: `Environment ${parsed.environmentId} has no folder.` };
    } else if (parsed.folder) {
      path = parsed.folder;
    }
    if (path === null) return { path: null };
    const real = await seams.resolvePath(path);
    if (!real) return { error: `${path} is not a folder on this computer.` };
    return { path: real };
  }
}

/**
 * `kg vscodium open [--environment <id>] [<folder>]`, as a job's argv.
 * @param {string[]} argv
 * @returns {{ usage: string } | { environmentId?: string, folder?: string }}
 */
export function parseOpenArgs(argv) {
  /** @type {{ environmentId?: string, folder?: string }} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--environment') {
      const id = argv[index + 1];
      if (!id || id.startsWith('-')) return { usage: '--environment needs an environment id.' };
      if (parsed.environmentId !== undefined) return { usage: 'Name one environment.' };
      parsed.environmentId = id;
      index += 1;
    } else if (value.startsWith('-')) {
      return { usage: `Unknown option ${value}.` };
    } else {
      if (parsed.folder !== undefined) return { usage: 'Name one folder.' };
      parsed.folder = value;
    }
  }
  if (parsed.environmentId !== undefined && parsed.folder !== undefined) {
    return { usage: 'Give a folder or --environment, not both.' };
  }
  return parsed;
}
