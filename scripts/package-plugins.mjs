import { build } from 'esbuild';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const out = resolve(root, 'dist/plugins');
const { version } = JSON.parse(await readFile(join(root, 'apps/cli/package.json')));
const name = 'contactsheet';
const description = 'Archive build output locally and retrieve exact original lines.';
const author = { name: 'ContactSheet contributors' };
const meta = { name, version, description, author, license: 'MIT' };
const skill = await readFile(join(root, 'plugins/SKILL.md'));
const license = await readFile(join(root, 'LICENSE'));
const json = value => JSON.stringify(value, null, 2) + '\n';
const put = async (path, bytes) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
};
const jsonFile = (dir, path, data) => put(join(dir, path), json(data));
const schema = 'https://agent-plugins.org/schemas/1.0.0/';
const notices = new Map();

async function bundle(entry) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], write: false, bundle: true, platform: 'node',
    target: 'node24', format: 'esm', metafile: true, minify: true,
    banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const i = input.lastIndexOf('node_modules/');
    if (i === -1) continue;
    const tail = input.slice(i + 13).split('/');
    const pkg = tail.slice(0, tail[0].startsWith('@') ? 2 : 1).join('/');
    const dir = resolve(root, input.slice(0, i + 13), pkg);
    if (notices.has(dir)) continue;
    const files = (await readdir(dir)).filter(f => /^(license|licence|notice)(\.|$)/i.test(f)).sort();
    if (!files.length) throw new Error('Missing bundled license for ' + pkg);
    const texts = await Promise.all(files.map(f => readFile(join(dir, f), 'utf8')));
    notices.set(dir, pkg + '\n\n' + texts.join('\n'));
  }
  return result.outputFiles[0].contents;
}

function stdio(base) {
  return { mcpServers: { contactsheet: { type: 'stdio', command: 'node', args: [base + '/contactsheet.mjs', 'serve'] } } };
}

function pre(event, tool, base, agent) {
  const command = 'node "' + base + '/contactsheet.mjs" hook ' + agent;
  return { hooks: { [event]: [{ matcher: '^' + tool + '$', hooks: [{ type: 'command', command }] }] } };
}

async function vsix(dir) {
  const publisher = 'nsicilia';
  const extension = { ...meta, publisher, displayName: 'ContactSheet', engines: { vscode: '^1.143.0' },
    contributes: { chatPlugins: [{ path: './plugin' }] } };
  const files = {
    'extension/package.json': strToU8(json(extension)),
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="mjs" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'),
    'extension.vsixmanifest': strToU8(`<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="contactsheet" Version="${version}" Publisher="${publisher}"/><DisplayName>ContactSheet</DisplayName><Description>${description}</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.143.0"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`),
  };
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    files['extension/plugin/' + relative(dir, file).split('\\').join('/')] = await readFile(file);
  }
  await put(join(out, 'contactsheet.vsix'), zipSync(files, { level: 6 }));
}

export async function packagePlugins() {
  const cli = await bundle('apps/cli/dist/index.js');
  const piAdapter = await bundle('plugins/src/pi.mjs');
  const openAdapter = await bundle('plugins/src/opencode.mjs');
  const thirdParty = [...notices.values()].sort().join('\n\n-----\n\n');
  async function plugin(path) {
    const dir = join(out, path);
    await put(join(dir, 'contactsheet.mjs'), cli);
    await put(join(dir, 'LICENSE.txt'), license);
    await put(join(dir, 'THIRD-PARTY.txt'), thirdParty);
    await put(join(dir, 'skills/contactsheet/SKILL.md'), skill);
    return dir;
  }

  const market = join(out, 'marketplace');
  const codex = await plugin('marketplace/plugins/codex');
  await jsonFile(market, '.agents/plugins/marketplace.json', { name, plugins: [{
    name, source: { source: 'local', path: './plugins/codex' }, category: 'Productivity',
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  }] });
  await jsonFile(codex, '.codex-plugin/plugin.json', { ...meta, mcpServers: './.mcp.json', skills: './skills/' });
  await jsonFile(codex, '.mcp.json', stdio('${PLUGIN_ROOT}'));
  await jsonFile(codex, 'hooks/hooks.json', pre('PreToolUse', 'Bash', '${PLUGIN_ROOT}', 'codex'));

  const zcode = await plugin('marketplace/plugins/zcode');
  const catalog = { name, owner: author, plugins: [{ name, source: './plugins/zcode', description, version }] };
  await jsonFile(market, '.claude-plugin/marketplace.json', catalog);
  await jsonFile(market, 'marketplace.json', catalog);
  await jsonFile(zcode, '.claude-plugin/plugin.json', meta);
  await jsonFile(zcode, '.mcp.json', stdio('${CLAUDE_PLUGIN_ROOT}'));
  await jsonFile(zcode, 'hooks/hooks.json', pre('PreToolUse', 'Bash', '${CLAUDE_PLUGIN_ROOT}', 'zcode'));

  for (const agent of ['gemini', 'qwen']) {
    const dir = await plugin(agent);
    const { mcpServers } = stdio('${extensionPath}');
    delete mcpServers.contactsheet.type;
    await jsonFile(dir, agent + '-extension.json', { name, version, description, mcpServers,
      ...(agent === 'qwen' ? { hooks: 'hooks/hooks.json' } : {}) });
    await jsonFile(dir, 'hooks/hooks.json', pre(agent === 'gemini' ? 'BeforeTool' : 'PreToolUse', 'run_shell_command', '${extensionPath}', agent));
  }

  const portable = await plugin('portable');
  await jsonFile(portable, 'plugin.json', { $schema: schema + 'plugin.schema.json', ...meta, keywords: ['build', 'test', 'logs', 'archive'] });
  await jsonFile(portable, 'mcp.json', { $schema: schema + 'mcp.schema.json', ...stdio('${PLUGIN_ROOT}') });
  await jsonFile(portable, 'com.github.copilot/hooks/hooks.json', { version: 1, hooks: { preToolUse: [
    { type: 'command', bash: 'node "$PLUGIN_ROOT/contactsheet.mjs" hook copilot' },
  ] } });
  await vsix(portable);

  const open = await plugin('opencode');
  await put(join(open, 'index.mjs'), openAdapter);
  await jsonFile(open, 'package.json', { ...meta, type: 'module', main: './index.mjs', exports: { '.': './index.mjs', './server': './index.mjs' } });

  const pi = await plugin('pi');
  const resources = { extensions: ['./index.mjs'], skills: ['./skills'] };
  await jsonFile(pi, 'package.json', { ...meta, type: 'module', keywords: ['pi-package'], pi: resources, omp: resources });
  await put(join(pi, 'index.mjs'), piAdapter);
  const tmp = await mkdtemp(join(tmpdir(), 'contactsheet-tools-'));
  const client = new Client({ name: 'contactsheet-package', version });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(pi, 'contactsheet.mjs'), 'serve'], cwd: tmp }));
    await jsonFile(pi, 'tools.json', (await client.listTools()).tools);
  } finally {
    await client.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await packagePlugins();
  console.log(out);
}
