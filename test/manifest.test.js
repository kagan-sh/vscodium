// The manifest is what kagan reads before any plugin code runs, so a typo in it is an install
// failure rather than a failing test. These checks keep it in step with the files beside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobs } from '../jobs.js';
import { FIRST_PORT, portOrder } from '../server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'kagan.json'), 'utf8'));

/** @type {any} */
const job = (fields) => ({ id: 'job_1', ...fields });

test('the manifest names a real entry file and a reverse-DNS id', () => {
  assert.match(manifest.id, /^dev\.kagan\.[a-z0-9-]+$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.entry, 'main.js');
  assert.equal(manifest.ui.panels[0].view, 'OpenPanel');
});

test('every declared tool has a schema that matches its name and takes an object', async () => {
  for (const tool of manifest.tools) {
    assert.match(tool.name, /^[a-z0-9_-]{1,64}$/);
    assert.equal(tool.input, `schemas/${tool.name}.json`);
    const schema = JSON.parse(await readFile(join(root, tool.input), 'utf8'));
    assert.equal(schema.type, 'object', tool.name);
    assert.ok(Array.isArray(schema.required), tool.name);
    assert.equal(schema.additionalProperties, false, tool.name);
    assert.match(tool.scope, /^(all|tagged)$/);
  }
});

test('the entry exports the view the manifest declares', async () => {
  const source = await readFile(join(root, manifest.entry), 'utf8');
  for (const panel of manifest.ui.panels) {
    assert.match(source, new RegExp(`export \\{[^}]*\\b${panel.view}\\b[^}]*\\}`), panel.view);
  }
});

test('every command, CLI command and tool the manifest declares reaches a handler', async () => {
  const answer = createJobs({
    openFor: async () => 'Opened.',
    showPanel: async () => {},
    environmentPath: async () => '/w/b',
    resolvePath: async (path) => path,
  });
  for (const command of manifest.commands) {
    assert.ok(['always', 'thread', 'project'].includes(command.when), command.when);
    assert.equal(await answer(job({ kind: 'command', command: command.id })), null, command.id);
  }
  for (const group of manifest.cli) {
    for (const command of group.commands) {
      const result = /** @type {{ exitCode: number }} */ (await answer(job({ kind: 'cli', command: command.name, argv: [] })));
      assert.equal(result.exitCode, 0, command.name);
    }
  }
  for (const tool of manifest.tools) {
    const result = await answer(job({ kind: 'tool', name: tool.name, threadId: 'thr_1', input: { path: 'a.js' } }));
    assert.equal(/** @type {{ isError: boolean }} */ (result).isError, false, tool.name);
  }
});

test('the manifest fetches exactly the ports the server tries', () => {
  const ports = manifest.powers.fetch.map((/** @type {{ host: string }} */ entry) => Number(new URL(entry.host).port));
  assert.deepEqual(ports, portOrder(null));
  assert.equal(FIRST_PORT, ports[0]);
  for (const entry of manifest.powers.fetch) {
    assert.equal(new URL(entry.host).hostname, '127.0.0.1');
    assert.deepEqual(entry.methods, ['GET']);
  }
});

test('the powers name plain programs on PATH, and the areas exist', () => {
  for (const entry of manifest.powers.run) {
    assert.match(entry.program, /^[a-z0-9_.-]+$/i, 'a run power is a program on PATH, not a path');
  }
  assert.deepEqual(manifest.powers.areas, ['process', 'threads']);
});
