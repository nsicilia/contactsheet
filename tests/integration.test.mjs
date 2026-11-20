import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    ['context_coding', 'context_decision_list', 'context_decision_read', 'context_decision_save', 'context_decision_search',
      'context_index', 'context_read', 'context_search']);
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

test('MCP clients search current decisions across revisions and archive upgrades', async t => {
  const { run, db } = workspace(t);
  const firstEvidence = run(['index'], 'Build exceeded the initial deadline.\n');
  const laterEvidence = run(['index'], 'The slow shard now completes within 90 seconds.\n');
  const server = run(['init']).mcpServers.contactsheet;
  async function connect(name) {
    const client = new Client({ name, version: '1' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport(server));
    return client;
  }
  async function call(client, name, args) {
    const reply = await client.callTool({ name, arguments: args });
    assert.ok(!reply.isError, reply.content[0]?.text);
    return JSON.parse(reply.content[0].text);
  }

  const author = await connect('decision-author');
  const key = 'build-timeout';
  const draft = { key, text: 'Allow 120 seconds until we measure the slow shard.', archiveId: firstEvidence.id, line: 1 };
  const first = await call(author, 'context_decision_save', { ...draft, expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.deepEqual(await call(author, 'context_decision_search', { query: 'deadline' }), []);
  await author.close();

  const reviewer = await connect('decision-reviewer');
  assert.deepEqual(await call(reviewer, 'context_decision_list', {}),
    { decisions: [{ key, revision: 1 }], next: null });
  assert.deepEqual(await call(reviewer, 'context_decision_read', { key }), first);
  const initial = await call(reviewer, 'context_decision_search', { query: '120 seconds' });
  assert.deepEqual(initial, [{ key, revision: 1, archiveId: firstEvidence.id, line: 1, excerpt: draft.text }]);
  const other = await call(reviewer, 'context_decision_save', {
    key: 'ci-build-timeout', text: 'Configure the interactive CI job.', archiveId: firstEvidence.id, line: 1, expectedRevision: 0,
  });
  const write = (client, args) => client.callTool({ name: 'context_decision_save', arguments: args });
  const update = { ...draft, text: 'Set the timeout to 90 seconds based on the shard measurement.',
    archiveId: laterEvidence.id, expectedRevision: first.revision };
  for (const invalid of [{ ...update, line: 2 }, { ...update, archiveId: 'ctx_' + '0'.repeat(64) }]) {
    const reply = await write(reviewer, invalid);
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /evidence/i);
  }

  const observer = await connect('decision-observer');
  const outcomes = await Promise.all([write(reviewer, update), write(observer, update)]);
  assert.equal(outcomes.filter(reply => !reply.isError).length, 1);
  assert.match(outcomes.find(reply => reply.isError).content[0].text, /revision conflict/i);
  const current = await call(observer, 'context_decision_read', { key });
  assert.equal(current.revision, 2);
  assert.equal(current.text, update.text);
  const original = await call(observer, 'context_decision_read', { key, revision: 1 });
  assert.deepEqual(original, first);
  for (const [decision, text] of [[original, 'Build exceeded the initial deadline.\n'],
    [current, 'The slow shard now completes within 90 seconds.\n']]) {
    const page = await call(observer, 'context_read', { id: decision.archiveId, line: decision.line, count: 1 });
    assert.equal(page.text, text);
  }
  assert.deepEqual(await call(reviewer, 'context_decision_search', { query: '120 seconds' }), []);
  const keyMatches = await call(reviewer, 'context_decision_search', { query: 'BUILD TIMEOUT' });
  assert.deepEqual(keyMatches.map(({ key, revision }) => [key, revision]).sort(),
    [[current.key, 2], [other.key, 1]]);
  assert.deepEqual(await call(reviewer, 'context_decision_search', { query: 'build timeout', limit: 1 }), keyMatches.slice(0, 1));
  await Promise.all([reviewer.close(), observer.close()]);

  // Keep the decisions and evidence in the format an older archive used without a search index.
  const existing = new DatabaseSync(db);
  try {
    existing.exec('DROP TRIGGER index_decision; DROP TABLE decision_terms');
  } finally {
    existing.close();
  }
  const fresh = await connect('decision-searcher');
  assert.deepEqual(await call(fresh, 'context_decision_search', { query: '120 seconds' }), []);
  const found = await call(fresh, 'context_decision_search', { query: '"shard measurement?"' });
  assert.deepEqual(found, [{
    key, revision: 2, archiveId: laterEvidence.id, line: 1, excerpt: current.text,
  }]);
  const [hit] = found;
  const page = await call(fresh, 'context_read', { id: hit.archiveId, line: hit.line, count: 1 });
  assert.equal(page.text, 'The slow shard now completes within 90 seconds.\n');
  const invalidQuery = await fresh.callTool({ name: 'context_decision_search', arguments: { query: '?!' } });
  assert.equal(invalidQuery.isError, true);
});

test('coding settings persist across CLI and MCP and invalid changes are atomic', async t => {
  const { run } = workspace(t);
  assert.equal(run(['coding', 'off']).instructions, '');
  const client = new Client({ name: 'coding-test', version: '1' });
  await client.connect(new StdioClientTransport(run(['init']).mcpServers.contactsheet));
  t.after(() => client.close());
  assert.match(client.getInstructions(), /mode: off/);
  assert.match(client.getInstructions(), /asks about a past project decision.*first call context_decision_search/);
  assert.match(client.getInstructions(), /Use context_read with the evidence archive ID and line.*Quote the supporting archive line verbatim/);
  const call = args => client.callTool({ name: 'context_coding', arguments: args });
  assert.equal((await call({ level: 'ultra', action: 'unknown' })).isError, true);
  assert.equal(run(['coding']).level, 'off');
  await call({ level: 'lite' });
  assert.equal(run(['coding']).level, 'lite');
  for (const action of ['review','audit','debt','gain','help']) {
    const reply = await call({ action });
    assert.deepEqual(JSON.parse(reply.content[0].text), run(['coding', action]));
  }
});

test('benchmark comparison and session board use observed local measurements', t => {
  const { run, cwd, db } = workspace(t);
  const measure = (file, lines) => writeFileSync(join(cwd, file), JSON.stringify({ task: 'fixture', passed: true, lines }));
  measure('before.json', 8);
  measure('after.json', 6);
  assert.equal(run(['compare', 'before.json', 'after.json']).metrics.lines.percentSaved, 25);
  const message = { type: 'assistant', message: { id: 'one', usage: { input_tokens: 13, output_tokens: 3 } } };
  writeFileSync(join(cwd, 'session.jsonl'), [message, message, { type: 'result', total_cost_usd: 0.01 }].map(v => JSON.stringify(v)).join('\n'));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(run(['board','import','--from',cwd]).totals, { sessions: 1, tokens: 16, reportedCostUSD: 0.01, reportedApiMs: null });
  }
  const status = () => execFileSync(process.execPath, [cli, 'statusline', '--db', db], { input: '{"cost":{"total_cost_usd":2.5}}', encoding: 'utf8' });
  assert.match(status(), /\$2\.50/);
  run(['board','off']);
  assert.equal(status(), '');
});
