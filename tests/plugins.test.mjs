import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packagePlugins } from '../scripts/package-plugins.mjs';

test('packaged Pi tools index, search and read from the same workspace', async () => {
  await packagePlugins();
  const { default: register } = await import('../dist/plugins/pi/index.mjs');
  const tools = new Map();
  register({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  const cwd = await mkdtemp(join(tmpdir(), 'contactsheet-plugin-test-'));
  const call = async (name, args) => {
    const reply = await tools.get(name).execute('test', args, undefined, undefined, { cwd });
    return JSON.parse(reply.content[0].text);
  };
  try {
    const receipt = await call('context_index', { text: 'fixture diagnostic' });
    const hits = await call('context_search', { query: 'diagnostic' });
    assert.match(JSON.stringify(hits), new RegExp(receipt.id));
    const page = await call('context_read', { id: receipt.id });
    assert.equal(page.text, 'fixture diagnostic');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
