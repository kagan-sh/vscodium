// The address the panel loads: one VSCodium page for one folder, with a file to open.

import { openPosition } from './open.js';

/**
 * The page reads `folder` and `payload` once, at startup.
 * `gotoLineMode` tells it to read `:line:column` from the file path.
 * The file address uses the same host and port the page was served from.
 * @param {{ port: number, token: string, folder: string, file?: string | null, line?: number, column?: number }} options
 * @returns {string}
 * @throws when the port, token, folder or file is unusable, or the position is not a line and an optional column
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
    const position = openPosition(line, column);
    // Each segment is encoded alone, so # and ? stay part of the name and / keeps its place.
    let target = file.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    if (position.line !== undefined) {
      target += `:${position.line}`;
      if (position.column !== undefined) target += `:${position.column}`;
    }
    /** @type {[string, string][]} */
    const payload = [['openFile', `vscode-remote://127.0.0.1:${port}${target}`]];
    if (position.line !== undefined) payload.push(['gotoLineMode', 'true']);
    url.searchParams.set('payload', JSON.stringify(payload));
  }
  return url.toString();
}
