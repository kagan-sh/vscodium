import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobs, parseOpenArgs } from '../jobs.js';

/**
 * @param {object} [overrides]
 */
function setup(overrides = {}) {
  const calls = { opened: [], panels: [], environments: [], resolved: [] };
  const answer = createJobs({
    openFor: async (threadId, request) => {
      calls.opened.push({ threadId, request });
      return 'Opened src/a.ts:4.';
    },
    showPanel: async (props) => {
      calls.panels.push(props);
    },
    environmentPath: async (id) => {
      calls.environments.push(id);
      return '/w/b';
    },
    resolvePath: async (path) => {
      calls.resolved.push(path);
      return path === '/missing' ? null : path;
    },
    ...overrides,
  });
  return { answer, calls };
}

/** @param {object} fields */
const job = (fields) => /** @type {any} */ ({ id: 'job_1', ...fields });

test('editor_open opens through the seam and reports what it did', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'tool', name: 'editor_open', threadId: 'thr_a', input: { path: 'src/a.ts', line: 4 } }));

  assert.deepEqual(result, { text: 'Opened src/a.ts:4.', isError: false });
  assert.deepEqual(world.calls.opened, [{ threadId: 'thr_a', request: { path: 'src/a.ts', line: 4 } }]);
});

test('editor_open without a thread is an error and does not open anything', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'tool', name: 'editor_open', input: { path: 'src/a.ts' } }));

  assert.equal(result.isError, true);
  assert.match(result.text, /needs a thread/);
  assert.deepEqual(world.calls.opened, []);
});

test('editor_open turns a refusal into an error the agent can read', async () => {
  const world = setup({ openFor: async () => { throw new Error("/w/a/src/a.ts is outside this thread's folder."); } });
  const result = await world.answer(job({ kind: 'tool', name: 'editor_open', threadId: 'thr_a', input: {} }));

  assert.equal(result.isError, true);
  assert.match(result.text, /outside this thread's folder/);
});

test('editor_open names a denied power instead of the raw message', async () => {
  const world = setup({ openFor: async () => { throw new Error('program realpath is not granted for run'); } });
  const result = await world.answer(job({ kind: 'tool', name: 'editor_open', threadId: 'thr_a', input: {} }));

  assert.equal(result.isError, true);
  assert.match(result.text, /permission/);
  assert.doesNotMatch(result.text, /not granted/);
});

test('an unknown tool or job is a failure, not a silent no-op', async () => {
  const world = setup();
  await assert.rejects(world.answer(job({ kind: 'tool', name: 'editor_delete' })), /Unknown tool/);
  await assert.rejects(world.answer(job({ kind: 'event', type: 'thread.idle' })), /Unknown job/);
  await assert.rejects(world.answer(job({ kind: 'command', command: 'close' })), /Unknown command/);
});

test('the open command shows the panel for the thread on screen', async () => {
  const world = setup();
  assert.equal(await world.answer(job({ kind: 'command', command: 'open' })), null);
  assert.deepEqual(world.calls.panels, [undefined]);
});

test('kg vscodium open shows the thread on screen when it names nothing', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'cli', command: 'open', argv: [] }));

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /thread on screen/);
  assert.deepEqual(world.calls.panels, [undefined]);
});

test('kg vscodium open <folder> opens that folder, once it resolves', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'cli', command: 'open', argv: ['/w/b'] }));

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Opened \/w\/b in VSCodium/);
  assert.equal(world.calls.panels.length, 1);
  assert.equal(world.calls.panels[0].path, '/w/b');
  assert.match(world.calls.panels[0].request, /^[0-9a-f]{16}$/);
});

test('kg vscodium open --environment opens the environment folder', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'cli', command: 'open', argv: ['--environment', 'env_1'] }));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(world.calls.environments, ['env_1']);
  assert.equal(world.calls.panels[0].path, '/w/b');
});

test('a folder that is not on this computer is refused before anything opens', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'cli', command: 'open', argv: ['/missing'] }));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /is not a folder on this computer/);
  assert.deepEqual(world.calls.panels, []);
});

test('an environment with no folder is refused before anything opens', async () => {
  const world = setup({ environmentPath: async () => null });
  const result = await world.answer(job({ kind: 'cli', command: 'open', argv: ['--environment', 'env_x'] }));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /has no folder/);
  assert.deepEqual(world.calls.panels, []);
});

test('a bad command line prints the usage and exits 2', async () => {
  const world = setup();
  const result = await world.answer(job({ kind: 'cli', command: 'open', argv: ['--environment'] }));

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /usage: kg vscodium open/);
  assert.deepEqual(world.calls.panels, []);
});

test('an unknown CLI command exits 2, and a host failure exits 1', async () => {
  const world = setup();
  assert.equal((await world.answer(job({ kind: 'cli', command: 'nope', argv: [] }))).exitCode, 2);

  const failing = setup({ showPanel: async () => { throw new Error('this window has no VSCodium panel'); } });
  const result = await failing.answer(job({ kind: 'cli', command: 'open', argv: [] }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no VSCodium panel/);
});

test('kg vscodium open takes a folder or an environment, and nothing else', () => {
  assert.deepEqual(parseOpenArgs([]), {});
  assert.deepEqual(parseOpenArgs(['/w/b']), { folder: '/w/b' });
  assert.deepEqual(parseOpenArgs(['--environment', 'env_1']), { environmentId: 'env_1' });
  assert.deepEqual(parseOpenArgs(['--environment', 'env_1', '--environment', 'env_2']), { usage: 'Name one environment.' });
  assert.deepEqual(parseOpenArgs(['--environment']), { usage: '--environment needs an environment id.' });
  assert.deepEqual(parseOpenArgs(['--environment', '--x']), { usage: '--environment needs an environment id.' });
  assert.deepEqual(parseOpenArgs(['/w/a', '/w/b']), { usage: 'Name one folder.' });
  assert.deepEqual(parseOpenArgs(['/w/a', '--environment', 'env_1']), { usage: 'Give a folder or --environment, not both.' });
  assert.deepEqual(parseOpenArgs(['--verbose']), { usage: 'Unknown option --verbose.' });
});
