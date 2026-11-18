import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'ctx-cli-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const db = join(cwd, 'context.sqlite');
  const run = (args, input) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--db', db], { cwd, input }));
  return { cwd, db, run };
}

test('CLI bootstrap, stdin and file ingestion, search and exact read', t => {
  const { run, cwd, db } = workspace(t);
  const config = run(['init']);
  assert.deepEqual(run(['init']), config);
  const text = '\uFEFFPASS first\r\nFAIL second 🐈\n';
  const { id } = run(['index', '--source', 'suite'], text);
  const filename = join(cwd, 'suite.log');
  writeFileSync(filename, text);
  assert.equal(run(['index', filename, '--source', 'suite']).id, id);
  assert.equal(run(['search', 'second'])[0].line, 2);
  assert.deepEqual(run(['read', id, '--line', '2']), { text: 'FAIL second 🐈\n', next: null });
  const invalid = spawnSync(process.execPath, [cli, 'index', '--db', db], { input: Buffer.from([255]) });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr.toString(), /encoded data/);
});

test('stdio MCP and CLI share the archive and recover every line of a large log', async t => {
  const { run } = workspace(t);
  const server = run(['init']).mcpServers['contactsheet'];
  const client = new Client({ name: 'archive-integration-test', version: '1' });
  await client.connect(new StdioClientTransport(server));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
    ['context_index', 'context_read', 'context_search']);
  async function call(name, args) {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, reply.content[0]?.text);
    return JSON.parse(reply.content[0].text);
  }
  const lines = Array.from({ length: 3000 }, (_, i) => `PASS worker ${i} completed regression example\r\n`);
  const errors = [17, 303, 1111, 1920, 2581];
  for (const i of errors) lines[i] = `ERROR deadline exceeded on shard ${i}\r\n`;
  lines.push('Test suites: 2995 passed, 5 failed\n');
  const log = lines.join('');
  const receipt = run(['index', '--source', 'suite'], log);
  const indexed = await call('context_index', { text: log, source: 'suite' });
  assert.deepEqual(indexed, receipt);
  assert.ok(receipt.bytes > 100 * 1024 && receipt.preview.length <= 1200);
  for (const i of errors) assert.ok(receipt.preview.includes(`shard ${i}`));
  const hits = await call('context_search', { id: receipt.id, query: 'deadline 1111' });
  assert.equal(hits[0].line, 1112);
  assert.equal((await call('context_read', { id: receipt.id, line: hits[0].line, count: 1 })).text, lines[1111]);
  let cursor = { line: 1, offset: 0 };
  let recovered = '';
  do {
    const page = await call('context_read', { id: receipt.id, count: 200, ...cursor });
    recovered += page.text;
    cursor = page.next;
  } while (cursor);
  assert.equal(recovered, log);
  assert.equal((await client.callTool({ name: 'context_read', arguments: { id: receipt.id, line: 0 } })).isError, true);
  t.diagnostic(`${receipt.bytes} original UTF-8 bytes, ${Buffer.byteLength(receipt.preview)} preview bytes; 5/5 failures surfaced, exact recovery`);
});
