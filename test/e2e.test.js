// @ts-check
// End to end: the real editor, loaded through this plugin's page URL, puts the cursor
// on the line and column the tool asked for.
// Run with `npm run test:e2e`. It needs `codium` and a Chromium on this machine, and
// skips itself (rather than passing) when either is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { editorPageUrl } from '../page.js';
import { connectionToken, serveWebArgs } from '../server.js';

const LINE = 12;
const COLUMN = 3;

test('the editor opens the file at the line and column the tool asked for', {
  timeout: 180_000,
  skip: process.env.KG_E2E ? false : 'set KG_E2E=1 to run it, or use npm run test:e2e',
}, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('no Chromium on this machine');
  const codium = which('codium');
  if (!codium) return t.skip('codium is not on PATH');

  const root = await mkdtemp(join(tmpdir(), 'vscodium-e2e-'));
  const folder = join(root, 'workspace');
  const file = join(folder, 'sample.js');
  const lines = Array.from({ length: 40 }, (_, index) => `const value${index + 1} = ${index + 1};`);
  lines[LINE - 1] = 'const marked = "this is the line";';
  await mkdir(folder, { recursive: true });
  await writeFile(file, lines.join('\n'));
  const token = connectionToken(new Uint8Array(randomBytes(24)));
  const port = await freePort();
  // The same command the plugin runs, so the test proves the real arguments.
  const server = spawn(
    codium,
    serveWebArgs({ port, token, dataDir: join(root, 'server'), cliDir: join(root, 'cli') }),
    { stdio: 'ignore', detached: true },
  );
  /** @type {import('node:child_process').ChildProcess | null} */
  let chrome = null;
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/version`)).ok;
      } catch {
        return false;
      }
    }, 60_000, 'VSCodium serve-web did not start');

    const url = editorPageUrl({ port, token, folder, file, line: LINE, column: COLUMN });
    const profile = join(root, 'browser');
    chrome = spawn(browser, headlessArgs(profile, url), { stdio: 'ignore', detached: true });
    const debugPort = await waitFor(async () => {
      const [first] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      return Number(first) || null;
    }, 30_000, 'The browser did not open a debugging port');

    const page = await pageTarget(debugPort);
    const client = await connect(page);
    try {
      const text = await waitFor(async () => {
        const shown = await client.evaluate('document.body.innerText');
        return /Ln \d+, Col \d+/.test(shown) ? shown : null;
      }, 90_000, 'The editor did not finish loading');
      assert.match(text, /sample\.js/, 'the editor did not show the file');
      assert.match(text, new RegExp(`Ln ${LINE}, Col ${COLUMN}`), `the cursor is not at line ${LINE}, column ${COLUMN}`);
    } finally {
      client.close();
    }
  } finally {
    // `codium` is a shell script that starts the real server as a child, so killing it
    // alone leaves the server on its port. The whole group goes.
    killGroup(chrome);
    killGroup(server);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Kills a process and everything it started.
 * @param {import('node:child_process').ChildProcess | null} child
 */
function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Polls until `probe` answers something truthy, then returns it.
 * @template T
 * @param {() => Promise<T | null | false>} probe
 * @param {number} ms
 * @param {string} failure
 * @returns {Promise<T>}
 */
async function waitFor(probe, ms, failure) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await probe().catch(() => null);
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The browser the test drives: CHROME, then PATH, then Playwright's download cache.
 * @returns {Promise<string | null>}
 */
async function findBrowser() {
  const named = [process.env.CHROME, which('chromium'), which('google-chrome'), which('chrome')];
  for (const candidate of named) {
    if (!candidate) continue;
    const exists = await access(candidate).then(() => true, () => false);
    if (exists) return /** @type {string} */ (candidate);
  }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const entries = await readdir(cache).catch(() => []);
  for (const entry of entries.sort().reverse()) {
    for (const path of [
      join(cache, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
      join(cache, entry, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
      join(cache, entry, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cache, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ]) {
      const exists = await access(path).then(() => true, () => false);
      if (exists) return path;
    }
  }
  return null;
}

/**
 * The first executable named `program` on PATH, or null.
 * @param {string} program
 * @returns {string | null}
 */
function which(program) {
  for (const folder of (process.env.PATH ?? '').split(':')) {
    if (!folder) continue;
    const path = join(folder, program);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * @param {string} profile
 * @param {string} url
 * @returns {string[]}
 */
function headlessArgs(profile, url) {
  return [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    url,
  ];
}

/**
 * @param {number} port
 * @returns {Promise<{ webSocketDebuggerUrl: string }>}
 */
async function pageTarget(port) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null;
  }, 30_000, 'The browser did not open a page');
}

/**
 * A small Chrome DevTools client: one call at a time, answers by id.
 * @param {{ webSocketDebuggerUrl: string }} target
 */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(undefined));
    socket.addEventListener('error', () => reject(new Error('The browser did not answer.')));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  return {
    /**
     * @param {string} expression
     * @returns {Promise<string>}
     */
    async evaluate(expression) {
      await ready;
      const id = ++nextId;
      const call = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      const result = await call;
      return String(result?.result?.value ?? '');
    },
    close() {
      socket.close();
    },
  };
}
