import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));

function project(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'contactsheet setup ')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const { CONTEXT_DB, ...env } = process.env;
  const invoke = args => execFileSync(process.execPath, [cli, 'setup', ...args], { cwd, env, encoding: 'utf8' });
  return { cwd, env, invoke, codex: join(cwd, '.codex/config.toml'), claude: join(cwd, '.mcp.json') };
}

test('setup registers both clients with one project archive and is idempotent', t => {
  const { cwd, invoke, codex, claude } = project(t);
  const archive = join(cwd, '.context/archive.sqlite');
  const first = JSON.parse(invoke([]));
  assert.deepEqual(first, {
    archive, codex: { config: codex, status: 'configured' }, claude: { config: claude, status: 'configured' },
  });
  const toml = readFileSync(codex, 'utf8');
  const json = readFileSync(claude, 'utf8');
  const { contactsheet } = JSON.parse(json).mcpServers;
  assert.deepEqual(contactsheet, { type: 'stdio', command: process.execPath, args: [cli, 'serve', '--db', archive] });
  assert.match(toml, /^\[mcp_servers\.contactsheet\]/);
  assert.deepEqual(JSON.parse(toml.split('\n').find(line => line.startsWith('args = ')).slice(7)), contactsheet.args);
  const repeat = JSON.parse(invoke([cwd]));
  assert.equal(repeat.codex.status, 'already-configured');
  assert.equal(repeat.claude.status, 'already-configured');
  assert.equal(readFileSync(codex, 'utf8'), toml);
  assert.equal(readFileSync(claude, 'utf8'), json);
  rmSync(claude);
  const recovered = JSON.parse(invoke([]));
  assert.equal(recovered.codex.status, 'already-configured');
  assert.equal(recovered.claude.status, 'configured');
  assert.equal(readFileSync(claude, 'utf8'), json);
});

test('setup preserves existing configuration and rejects a conflict before writing either file', t => {
  const { cwd, env, invoke, codex, claude } = project(t);
  const codexOriginal = '# Keep this comment\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n';
  const docs = { type: 'http', url: 'https://example.com/mcp' };
  const conflictingJson = JSON.stringify({ mcpServers: { contactsheet: { command: 'other' }, docs } });
  mkdirSync(join(cwd, '.codex'));
  writeFileSync(codex, codexOriginal);
  writeFileSync(claude, conflictingJson);
  const rejected = spawnSync(process.execPath, [cli, 'setup', cwd], { env, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /conflicts.*\.mcp\.json/);
  assert.equal(readFileSync(codex, 'utf8'), codexOriginal);
  assert.equal(readFileSync(claude, 'utf8'), conflictingJson);
  writeFileSync(claude, JSON.stringify({ mcpServers: { docs } }));
  const result = JSON.parse(invoke([cwd, '--db', 'data/shared.sqlite']));
  assert.equal(result.archive, join(cwd, 'data/shared.sqlite'));
  assert.ok(readFileSync(codex, 'utf8').startsWith(codexOriginal));
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')).mcpServers.docs, docs);
});

test('competing setup commands leave both clients on one archive', async t => {
  const { cwd, env, codex, claude } = project(t);
  mkdirSync(join(cwd, '.codex'));
  writeFileSync(codex, '# Existing Codex settings\n');
  writeFileSync(claude, '{}');
  const outcomes = await Promise.allSettled(['first.sqlite', 'second.sqlite'].map(file =>
    promisify(execFile)(process.execPath, [cli, 'setup', cwd, '--db', file], { env })));
  const successes = outcomes.filter(result => result.status === 'fulfilled');
  assert.equal(successes.length, 1);
  const { archive } = JSON.parse(successes[0].value.stdout);
  const toml = readFileSync(codex, 'utf8');
  assert.equal(JSON.parse(toml.split('\n').find(line => line.startsWith('args = ')).slice(7)).at(-1), archive);
  assert.equal(JSON.parse(readFileSync(claude, 'utf8')).mcpServers.contactsheet.args.at(-1), archive);
});
