import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strFromU8, unzipSync } from 'fflate';
import { out, packagePlugins } from '../scripts/package-plugins.mjs';

test.before(packagePlugins);

test('Codex and VS Code packages include their declared plugin icon', async () => {
  const icon = await readFile(new URL('../plugins/icon.png', import.meta.url));
  const codex = join(out, 'marketplace/plugins/codex');
  const manifest = JSON.parse(await readFile(join(codex, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.interface.logo, manifest.interface.composerIcon);
  assert.deepEqual(await readFile(join(codex, manifest.interface.logo)), icon);

  const files = unzipSync(await readFile(join(out, 'contactsheet.vsix')));
  const extension = JSON.parse(strFromU8(files['extension/package.json']));
  const path = 'extension/' + extension.icon;
  assert.deepEqual(Buffer.from(files[path]), icon);
  assert.ok(strFromU8(files['extension.vsixmanifest']).includes(`<Icon>${path}</Icon>`));
  assert.ok(strFromU8(files['[Content_Types].xml']).includes('Extension="png" ContentType="image/png"'));
});

test('packaged Pi tools index, search and read from the same workspace', async () => {
  const { default: register } = await import('../dist/plugins/pi/index.mjs');
  const tools = new Map();
  register({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  const cwd = await mkdtemp(join(tmpdir(), 'contactsheet-plugin-test-'));
  const call = async (name, args) => {
    const reply = await tools.get(name).execute('test', args, undefined, undefined, { cwd });
    return JSON.parse(reply.content[0].text);
  };
  try {
    assert.equal((await call('context_coding', { level: 'ultra' })).level, 'ultra');
    assert.match((await call('context_coding', { action: 'review' })).workflow, /diff/);
    const receipt = await call('context_index', { text: 'fixture diagnostic' });
    const hits = await call('context_search', { query: 'diagnostic' });
    assert.match(JSON.stringify(hits), new RegExp(receipt.id));
    const page = await call('context_read', { id: receipt.id });
    assert.equal(page.text, 'fixture diagnostic');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('packaged VS Code hook and MCP server share an archive across restarts', {
  skip: process.platform === 'win32',
}, async t => {
  const files = unzipSync(await readFile(join(out, 'contactsheet.vsix')));
  const base = 'extension/plugin/';
  const config = name => JSON.parse(strFromU8(files[base + name]));
  const { contactsheet } = config('mcp.json').mcpServers;
  const [hook] = config('com.github.copilot/hooks/hooks.json').hooks.preToolUse;

  const tmp = await mkdtemp(join(tmpdir(), 'contactsheet-vscode-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const plugin = join(tmp, 'installed plugin');
  const data = join(tmp, 'plugin data');
  const workspace = join(tmp, 'workspace');
  await Promise.all([mkdir(plugin), mkdir(workspace)]);
  const diagnostic = 'FAIL contactsheet fixture diagnostic';
  await Promise.all([
    writeFile(join(plugin, 'contactsheet.mjs'), files[base + 'contactsheet.mjs']),
    writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'node fixture.mjs' } })),
    writeFile(join(workspace, 'fixture.mjs'), [
      'console.log("x".repeat(9000));',
      'console.log(' + JSON.stringify(diagnostic) + ');',
      'process.exitCode = 1;',
    ].join('\n')),
  ]);
  const env = {
    ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
    PLUGIN_ROOT: plugin, COPILOT_PLUGIN_DATA: data, CONTACTSHEET_PASSTHROUGH_BYTES: '8192',
  };
  const rewritten = spawnSync('bash', ['-c', hook.bash], {
    cwd: workspace, env, encoding: 'utf8',
    input: JSON.stringify({
      toolName: 'bash', toolArgs: JSON.stringify({ command: 'npm run build' }),
      sessionId: 'vscode-test',
    }),
  });
  assert.equal(rewritten.status, 0, rewritten.stderr);
  const { modifiedArgs } = JSON.parse(rewritten.stdout);
  const captured = spawnSync('bash', ['-c', modifiedArgs.command], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal(captured.status, 1, captured.stderr || captured.stdout);
  const { id } = JSON.parse(captured.stdout);
  assert.match(id, /^ctx_/);

  const args = contactsheet.args.map(arg => arg.replace('${PLUGIN_ROOT}', plugin).replace('${PLUGIN_DATA}', data));
  for (let launch = 0; launch < 2; launch++) {
    const client = new Client({ name: 'vscode-package-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: contactsheet.command, args, cwd: plugin, env }));
      const search = await client.callTool({ name: 'context_search', arguments: { query: diagnostic, id } });
      assert.equal(search.isError, undefined, JSON.stringify(search.content));
      const [hit] = search.structuredContent.hits;
      assert.equal(hit.id, id);
      const page = await client.callTool({
        name: 'context_read', arguments: { id, line: hit.line, count: 1 },
      });
      assert.equal(JSON.parse(page.content[0].text).text, diagnostic + '\n');
    } finally {
      await client.close();
    }
  }
});

test('IntelliJ installer writes a project registration and protects existing settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contactsheet download '));
  const project = join(dir, 'idea project');
  const file = join(project, '.junie/mcp/mcp.json');
  const run = () => spawnSync(process.execPath, ['install.mjs', 'intellij', project],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, CONTEXT_DB: '.context/archive.sqlite' } });
  try {
    await mkdir(project);
    await mkdir(join(dir, 'pi'));
    await copyFile(join(out, 'install.mjs'), join(dir, 'install.mjs'));
    await copyFile(join(out, 'pi/contactsheet.mjs'), join(dir, 'pi/contactsheet.mjs'));
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const config = JSON.parse(first.stdout);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), config);
    assert.equal(config.mcpServers.contactsheet.args[0], await realpath(join(dir, 'pi/contactsheet.mjs')));
    assert.equal(config.mcpServers.contactsheet.args.at(-1), join(project, '.context/archive.sqlite'));
    assert.equal(run().status, 0);
    const other = '{"mcpServers":{"other":{"command":"example"}}}';
    await writeFile(file, other);
    assert.equal(run().status, 1);
    assert.equal(await readFile(file, 'utf8'), other);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
