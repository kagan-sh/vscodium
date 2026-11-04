import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFile, openPosition, openedWhere, openingText, laterText } from '../open.js';
import { PENDING_MS } from '../pending.js';

test('a line and a column have to be whole numbers, and a column needs a line', () => {
  assert.deepEqual(openPosition(null, null), {});
  assert.deepEqual(openPosition(4, undefined), { line: 4 });
  assert.throws(() => openPosition(0, undefined), /line/);
  assert.throws(() => openPosition(undefined, 2), /column needs a line/);
  assert.equal(openedWhere('/a.js', 4, 2), '/a.js:4:2');
  assert.equal(openingText('/a.js:4', true), 'Opened /a.js:4.');
  assert.match(openingText('/a.js:4', false), /first start/);
});

test('an off-screen open says how long it waits, from the same limit the queue uses', () => {
  const text = laterText('/work/a.js:4');
  assert.match(text, /not on screen/);
  assert.match(text, /next time this panel is shown/);
  assert.match(text, new RegExp(`${PENDING_MS / 60000} minutes`));
  assert.match(text, /newer editor_open replaces it/);
});

function setup(options = {}) {
  const screen = new Set(options.screen ?? ['thr_a']);
  const disk = {
    '/w/a': '/w/a',
    '/w/a/src/a.ts': '/w/a/src/a.ts',
    '/w/b': '/w/b',
    '/w/b/src/b.ts': '/w/b/src/b.ts',
    ...(options.disk ?? {}),
  };
  const queued = new Map();
  const state = { shown: 0 };
  return {
    screen,
    queued,
    state,
    env: (overrides = {}) => ({
      threadId: 'thr_a',
      request: { path: 'src/a.ts' },
      folder: '/w/a',
      otherFolders: async () => ['/w/b'],
      realpathOf: async (path) => disk[path] ?? null,
      onScreen: (id) => screen.has(id),
      show: async () => {
        state.shown += 1;
      },
      queue: { put: (id, value) => queued.set(id, value) },
      ready: true,
      ...overrides,
    }),
  };
}

test('a file opens now when the thread is on screen, and is queued for the panel', async () => {
  const world = setup();
  const text = await openFile(world.env({ request: { path: 'src/a.ts', line: 4, column: 2 } }));

  assert.equal(text, 'Opened /w/a/src/a.ts:4:2.');
  assert.equal(world.state.shown, 1);
  assert.deepEqual(world.queued.get('thr_a'), { path: '/w/a/src/a.ts', line: 4, column: 2 });
});

test('a file for a thread off screen is queued and the panel is not opened', async () => {
  const world = setup({ screen: [] });
  const text = await openFile(world.env());

  assert.match(text, /not on screen/);
  assert.equal(world.state.shown, 0);
  assert.deepEqual(world.queued.get('thr_a'), { path: '/w/a/src/a.ts' });
});

test('a panel that cannot open fails the open, and the request stays queued for the next view', async () => {
  const world = setup();
  await assert.rejects(
    openFile(world.env({ show: async () => { throw new Error('This window has no panel.'); } })),
    /no panel/,
  );
  assert.deepEqual(world.queued.get('thr_a'), { path: '/w/a/src/a.ts' });
});

test('a panel that opens but leaves the thread off screen says the file waits', async () => {
  const world = setup();
  const text = await openFile(world.env({
    show: async () => {
      world.screen.clear();
    },
  }));

  assert.match(text, /not on screen/);
});

test('an absolute path in another local environment opens there', async () => {
  const world = setup();
  const text = await openFile(world.env({ request: { path: '/w/b/src/b.ts' } }));

  assert.equal(text, 'Opened /w/b/src/b.ts.');
  assert.deepEqual(world.queued.get('thr_a'), { path: '/w/b/src/b.ts' });
});

test('a relative path never consults the other local folders', async () => {
  const world = setup();
  const text = await openFile(world.env({ otherFolders: async () => { throw new Error('should not be asked'); } }));

  assert.equal(text, 'Opened /w/a/src/a.ts.');
});

test('a path outside every folder is refused, and nothing is shown or queued', async () => {
  const world = setup();
  await assert.rejects(openFile(world.env({ request: { path: '/etc/passwd' } })), /is outside this thread's folder/);

  assert.equal(world.state.shown, 0);
  assert.equal(world.queued.size, 0);
});

test('the open reports whether the server was already running', async () => {
  const world = setup();
  const text = await openFile(world.env({ ready: false }));

  assert.match(text, /first start/);
});
