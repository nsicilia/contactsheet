import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { route } from '../apps/cli/dist/hooks.js';

const cli = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "contact sheet's "));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const db = join(cwd, 'store.sqlite');
  const run = (args, input) => execFileSync(process.execPath, [cli, ...args, '--db', db], { cwd, input });
  return { cwd, db, run };
}
const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: "session's trial" };
for (const agent of ['claude', 'codex']) {
  test(agent + ' pre-execution capture, failing exit status and MCP recall', async t => {
    const { cwd, run } = fixture(t);
    const lines = Array.from({ length: 3600 }, (_, i) => 'processing item ' + i + ' for the checkout test suite\r\n');
    lines[500] = 'warehouse diagnostic tag amber-914\r\n';
    lines[2511] = 'ERROR missing warehouse inventory\r\n';
    const log = lines.join('');
    writeFileSync(join(cwd, 'expected'), log);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    writeFileSync(join(cwd, 'build.cjs'), [
      "const fs = require('node:fs'); fs.appendFileSync('calls','1');",
      "const b = fs.readFileSync('expected'); fs.writeSync(1,b.subarray(0,1234)); fs.writeSync(2,b.subarray(1234));",
      'process.exitCode = 23;',
    ].join('\n'));
    const config = JSON.parse(run(['hook-config', agent]));
    const hook = config.hooks.PreToolUse[0];
    assert.ok(new RegExp(hook.matcher).test('Bash'));
    const input = { command: 'npm run build --silent', description: 'Build checkout', timeout: 30000 };
    const reply = JSON.parse(execFileSync('/bin/sh', ['-c', hook.hooks[0].command], {
      cwd, input: JSON.stringify({ ...event, tool_input: input }),
    })).hookSpecificOutput;
    assert.equal(reply.permissionDecision, agent === 'claude' ? undefined : 'allow');
    assert.equal(reply.updatedInput.timeout, input.timeout);
    const shell = spawnSync('/bin/bash', ['-c', reply.updatedInput.command], { cwd, encoding: 'utf8' });
    assert.equal(shell.status, 23, shell.stderr);
    assert.equal(readFileSync(join(cwd, 'calls'), 'utf8'), '1');
    assert.equal(shell.stderr, '');
    assert.ok(Buffer.byteLength(shell.stdout) < 2048);
    assert.ok(!shell.stdout.includes('amber-914'));
    const receipt = JSON.parse(shell.stdout);
    assert.match(receipt.preview, /ERROR missing warehouse inventory/);
    assert.equal(receipt.bytes, Buffer.byteLength(log));
    const configMcp = JSON.parse(run(['init'])).mcpServers.contactsheet;
    const client = new Client({ name: 'capture-test', version: '1' });
    await client.connect(new StdioClientTransport(configMcp));
    t.after(() => client.close());
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: { ...args, id: receipt.id } });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const hits = await call('context_search', { query: 'amber 914' });
    assert.equal(hits[0].line, 501);
    assert.equal((await call('context_read', { line: hits[0].line, count: 1 })).text, lines[500]);
    let all = '';
    let next = { line: 1, offset: 0 };
    while (next) {
      const page = await call('context_read', { ...next, count: 200 });
      all += page.text;
      next = page.next;
    }
    assert.equal(all, log);
    t.diagnostic(`${receipt.bytes} bytes captured, ${Buffer.byteLength(shell.stdout)} bytes returned, exit 23`);
  });
}

test('short results pass through byte-for-byte without creating an archive', t => {
  const { run, cwd } = fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 10]), Buffer.alloc(4096, 65)]) {
    assert.deepEqual(run(['capture'], bytes), bytes);
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test('unindexable output is retained losslessly on disk with a bounded reply', t => {
  const { run } = fixture(t);
  for (const raw of [Buffer.alloc(4097, 255), Buffer.alloc(8 * 1024 * 1024 + 1), Buffer.alloc(100001, 10)]) {
    const result = JSON.parse(run(['capture'], raw));
    assert.equal(result.indexed, false);
    assert.deepEqual(readFileSync(result.rawFile), raw);
  }
});

test('unrelated tools, shell programs, background jobs and already routed commands pass through', () => {
  const apply = (tool_input, extra = {}) => route('claude', { ...event, tool_input, ...extra }, cli, '/tmp/a');
  for (const command of ['git status', 'pnpm test && pwd', 'pnpm test | head', 'pnpm test\necho hi',
    'pnpm test --watch', 'pnpm test:watch', 'pnpm test > results', 'npm test $(pwd)']) {
    assert.deepEqual(apply({ command }), {});
  }
  assert.deepEqual(apply({ command: 'npm test', run_in_background: true }), {});
  assert.deepEqual(apply({ command: 'npm test', tty: true }), {});
  assert.deepEqual(apply({ command: 'npm test' }, { tool_name: 'Read' }), {});
  assert.deepEqual(apply({ command: 'npm test' }, { hook_event_name: 'PostToolUse' }), {});
  const rewritten = apply({ command: 'pnpm test' }).hookSpecificOutput.updatedInput;
  assert.deepEqual(apply(rewritten), {});
});
