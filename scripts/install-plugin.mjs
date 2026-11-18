import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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
if (!Object.hasOwn(commands, host)) {
  console.error('Usage: pnpm plugin <' + Object.keys(commands).join('|') + '>');
  process.exit(2);
}
await packagePlugins();
for (const [program, ...args] of commands[host]) {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
