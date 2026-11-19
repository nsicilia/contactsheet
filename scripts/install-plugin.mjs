import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mcpConfig } from '../apps/cli/dist/hooks.js';
import { join, resolve } from 'node:path';
import { out, packagePlugins } from './package-plugins.mjs';

const market = join(out, 'marketplace');
const commands = {
  codex: [['codex', 'plugin', 'marketplace', 'add', market], ['codex', 'plugin', 'add', 'contactsheet@contactsheet']],
  gemini: [['gemini', 'extensions', 'link', join(out, 'gemini')]],
  qwen: [['qwen', 'extensions', 'link', join(out, 'qwen')]],
  pi: [['pi', 'install', join(out, 'pi')]],
  omp: [['omp', 'plugin', 'link', join(out, 'pi')]],
  opencode: [['opencode', 'plugin', 'add', join(out, 'opencode')]],
  copilot: [['copilot', 'plugin', 'install', join(out, 'portable')]],
  kiro: [['kiro-cli', 'powers', 'install', join(out, 'portable')]],
  vscode: [['code', '--install-extension', join(out, 'contactsheet.vsix')]],
  zcode: [['zcode', 'plugins', 'marketplace', 'add', market], ['zcode', 'plugins', 'install', 'contactsheet@contactsheet']],
};
const host = process.argv[2];
if (host === 'intellij') {
  const project = resolve(process.argv[3] ?? '.');
  if (process.argv.length > 4 || !(await stat(project)).isDirectory()) {
    throw new Error('Usage: pnpm plugin intellij [project-directory]');
  }
  const cli = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
  const config = mcpConfig(cli, resolve(project, process.env.CONTEXT_DB ?? '.context/archive.sqlite'));
  const json = JSON.stringify(config, null, 2);
  const dir = join(project, '.junie', 'mcp');
  const file = join(dir, 'mcp.json');
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(file, json + '\n', { flag: 'wx', mode: 0o600 });
    console.error('Registered ContactSheet for Junie in ' + file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(file, 'utf8')).mcpServers?.contactsheet;
    if (existing?.command !== config.mcpServers.contactsheet.command ||
        JSON.stringify(existing?.args) !== JSON.stringify(config.mcpServers.contactsheet.args)) {
      console.error('Merge the contactsheet entry below into the existing ' + file);
      process.exitCode = 1;
    }
  }
  console.error('For AI Assistant, paste this JSON in Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → STDIO.');
  console.log(json);
} else if (!Object.hasOwn(commands, host)) {
  console.error('Usage: pnpm plugin <' + [...Object.keys(commands), 'intellij'].join('|') + '>');
  process.exit(2);
} else {
  await packagePlugins();
  for (const [program, ...args] of commands[host]) {
    let result = spawnSync(program, args, { stdio: 'inherit' });
    if (program === 'codex' && result.error?.code === 'ENOENT' && process.platform === 'darwin') {
      for (const bundled of [
        '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
        '/Applications/Codex.app/Contents/Resources/codex',
      ]) {
        result = spawnSync(bundled, args, { stdio: 'inherit' });
        if (result.error?.code !== 'ENOENT') break;
      }
    }
    if (result.error?.code === 'ENOENT') {
      console.error(`Could not locate ${program}. Add its CLI executable to PATH and rerun pnpm plugin ${host}.`);
      process.exit(1);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
