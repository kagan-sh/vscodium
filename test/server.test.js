import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_PORT,
  PORT_SPAN,
  START_DEADLINE_MS,
  bringUp,
  connectionToken,
  endedFailure,
  failureDetail,
  isNotGranted,
  notFoundDetail,
  portBusy,
  portOrder,
  scrub,
  serveWebArgs,
  serverFolders,
  startExpired,
  versionReady,
  versionUrl,
} from '../server.js';
import { STARTUP_TIMEOUT } from '../text.js';

const token = 'ab'.repeat(16);

test('serve-web listens on this machine with a connection token', () => {
  assert.deepEqual(serveWebArgs({ port: 47321, token, dataDir: '/tmp/editor-data', cliDir: '/tmp/editor-cli' }), [
    'serve-web',
    '--host', '127.0.0.1',
    '--port', '47321',
    '--connection-token', token,
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--log', 'off',
    '--server-data-dir', '/tmp/editor-data',
    '--cli-data-dir', '/tmp/editor-cli',
  ]);
});

test('a bad port or token is refused', () => {
  assert.throws(() => serveWebArgs({ port: 0, token }), /port/);
  assert.throws(() => serveWebArgs({ port: 47321, token: 'short' }), /token/);
  assert.throws(() => serveWebArgs({ port: 47321, token, dataDir: 'relative' }), /server data folder/);
  assert.throws(() => serveWebArgs({ port: 47321, token, cliDir: 'relative' }), /CLI data folder/);
});

test('the connection token is hex from the random bytes', () => {
  const bytes = new Uint8Array(16);
  bytes[0] = 0x0a;
  bytes[15] = 0xff;
  assert.equal(connectionToken(bytes), '0a0000000000000000000000000000ff');
  assert.throws(() => connectionToken(new Uint8Array(8)), /16 random bytes/);
});

test('server files stay in the plugin data folder', () => {
  assert.deepEqual(serverFolders('/data/plugins/vscodium/data/'), {
    dataDir: '/data/plugins/vscodium/data/server',
    cliDir: '/data/plugins/vscodium/data/cli',
  });
  assert.throws(() => serverFolders(undefined), /data folder is missing/);
});

test('the saved port is tried first when it is granted, then the rest once each', () => {
  assert.deepEqual(portOrder(FIRST_PORT + 2), [FIRST_PORT + 2, FIRST_PORT, FIRST_PORT + 1]);
  assert.equal(portOrder(FIRST_PORT).length, PORT_SPAN);
  assert.deepEqual(portOrder('nope'), [FIRST_PORT, FIRST_PORT + 1, FIRST_PORT + 2]);
  assert.deepEqual(portOrder(FIRST_PORT + 99), [FIRST_PORT, FIRST_PORT + 1, FIRST_PORT + 2]);
});

test('a server that has not answered by the deadline is given up on, with a plain message', () => {
  assert.ok(START_DEADLINE_MS >= 2 * 60 * 1000 && START_DEADLINE_MS <= 10 * 60 * 1000);
  assert.equal(startExpired(1000, 1000 + START_DEADLINE_MS - 1), false);
  assert.equal(startExpired(1000, 1000 + START_DEADLINE_MS), true);
  assert.match(STARTUP_TIMEOUT, /Try again/);
  assert.doesNotMatch(STARTUP_TIMEOUT, /\bport\b|exit|stderr|stdout/);
});

test('a missing permission is recognised from the raw message, before anything makes it plain', () => {
  assert.equal(isNotGranted(new Error('fetch to http://127.0.0.1:47321/version is not granted')), true);
  assert.equal(isNotGranted(new Error('connection refused')), false);
  assert.equal(isNotGranted('not granted'), true);
});

test('the version check answers only for a running server', () => {
  assert.equal(versionUrl(47321), 'http://127.0.0.1:47321/version');
  assert.equal(versionReady(200), true);
  assert.equal(versionReady(403), false);
});

function controlledStarts(answering = new Set()) {
  let now = 0;
  const ended = new Map();
  const launched = [];
  let mostAlive = 0;
  const clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    listening: async (port) => answering.has(port),
    ended: (attempt) => ended.get(attempt) ?? null,
  };
  const env = (stuck) => ({
    stuck,
    ports: [FIRST_PORT, FIRST_PORT + 1],
    launch: (port) => {
      const attempt = { port, token: 'a'.repeat(32), promise: null };
      launched.push(attempt);
      mostAlive = Math.max(mostAlive, launched.filter((item) => !ended.has(item)).length);
      return attempt;
    },
    clock,
    deadlineMs: START_DEADLINE_MS,
  });
  return { answering, ended, launched, env, mostAlive: () => mostAlive };
}

test('a timed-out start is kept: later tries wait on that process, and no second server is alive with it', async () => {
  const world = controlledStarts();
  const first = await bringUp(world.env(null));
  assert.ok('stuck' in first, 'the first start times out and is kept');
  assert.equal(world.launched.length, 1);

  const second = await bringUp(world.env(first.stuck));
  assert.ok('stuck' in second);
  assert.equal(second.stuck, first.stuck);
  assert.equal(world.launched.length, 1, 'no new process while the kept one is alive');

  world.answering.add(FIRST_PORT);
  const third = await bringUp(world.env(second.stuck));
  assert.ok('server' in third);
  assert.equal(third.server, first.stuck);
  assert.equal(world.launched.length, 1);
  assert.equal(world.mostAlive(), 1);
});

test('when the kept process has ended, a new start is allowed, and still only one server is alive', async () => {
  const world = controlledStarts();
  const first = await bringUp(world.env(null));
  assert.ok('stuck' in first);
  world.ended.set(first.stuck, { result: { exitCode: 1, stdout: '', stderr: 'boom' } });

  const again = await bringUp(world.env(first.stuck));
  assert.ok('stuck' in again);
  assert.notEqual(again.stuck, first.stuck);
  assert.equal(world.launched.length, 2);
  assert.equal(world.mostAlive(), 1, 'the ended process no longer counts as alive');
});

test('an ended start says which plain kind it was, and keeps the reason for the log', () => {
  const attempt = { port: FIRST_PORT, token: 'b'.repeat(32), promise: null };
  assert.equal(endedFailure(attempt, { error: new Error('spawn codium ENOENT: not found') }).kind, 'missing');
  assert.equal(endedFailure(attempt, { error: new Error('program codium is not granted for run') }).kind, 'denied');
  assert.equal(endedFailure(attempt, { result: { exitCode: 1, stdout: '', stderr: 'EADDRINUSE 47321' } }).kind, 'port');
  const failed = endedFailure(attempt, { result: { exitCode: 2, stdout: '', stderr: `token ${'b'.repeat(32)} bad` } });
  assert.equal(failed.kind, 'start');
  assert.equal(failed.detail.includes('b'.repeat(32)), false);
});

test('a busy port is not a missing editor', () => {
  assert.equal(portBusy('could not start server on the given host/port: Address already in use (os error 48)'), true);
  assert.equal(portBusy('Error: listen EADDRINUSE: address already in use 127.0.0.1:47321'), true);
  assert.equal(portBusy('Web UI available at http://127.0.0.1:47321'), false);
});

test('raw process output and the connection token go to the log, with the token removed', () => {
  const detail = failureDetail(`refused token ${token} at /private/tmp/x\nstderr: boom`, 1, token);
  assert.match(detail, /exit code 1/);
  assert.match(detail, /stderr: boom/);
  assert.equal(detail.includes(token), false);
  assert.equal(scrub(`see ${token}`, token).includes(token), false);
});

test('a missing codium command keeps its reason in the log', () => {
  assert.match(notFoundDetail(new Error('spawn codium ENOENT')), /Could not start codium: spawn codium ENOENT/);
});
