import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { mcpConfig } from './hooks.js';

function readConfig(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile()) throw new Error('Expected a regular configuration file at ' + path);
  return { bytes: readFileSync(path), mode: info.mode & 0o777 };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a configuration table for ' + label);
  }
  return value as Record<string, unknown>;
}

type Server = ReturnType<typeof mcpConfig>['mcpServers']['contactsheet'];

function alreadyConfigured(servers: Record<string, unknown>, server: Server, path: string) {
  if (!Object.hasOwn(servers, 'contactsheet')) return false;
  const entry = record(servers.contactsheet, path + ' contactsheet');
  if (entry.command !== server.command || !isDeepStrictEqual(entry.args, server.args) ||
      entry.enabled === false || (entry.type !== undefined && entry.type !== 'stdio') ||
      entry.url !== undefined) {
    throw new Error('An existing ContactSheet registration conflicts with this setup in ' + path);
  }
  return true;
}

export function setup(directory: string, cli: string, database: string) {
  const project = realpathSync(directory);
  if (!statSync(project).isDirectory()) throw new Error('Expected a project directory at ' + project);
  const archive = resolve(project, database);
  const { contactsheet } = mcpConfig(cli, archive).mcpServers;
  const codexDir = join(project, '.codex');
  const codexInfo = lstatSync(codexDir, { throwIfNoEntry: false });
  if (codexInfo && !codexInfo.isDirectory()) throw new Error('Expected a configuration directory at ' + codexDir);
  const codex = join(codexDir, 'config.toml');
  const claude = join(project, '.mcp.json');
  const oldCodex = readConfig(codex);
  const oldClaude = readConfig(claude);
  const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const toml = oldCodex ? decode.decode(oldCodex.bytes) : '';
  const json = oldClaude ? decode.decode(oldClaude.bytes) : '{}';
  let codexConfig: Record<string, unknown>;
  let claudeConfig: Record<string, unknown>;
  try {
    codexConfig = parse(toml.replace(/^\uFEFF/, ''), { integersAsBigInt: 'asNeeded' });
  } catch {
    throw new Error('Invalid TOML in ' + codex);
  }
  try {
    claudeConfig = record(JSON.parse(json.replace(/^\uFEFF/, '')), claude);
  } catch {
    throw new Error('Expected a JSON configuration object in ' + claude);
  }
  const codexServers = record(codexConfig.mcp_servers === undefined ? {} : codexConfig.mcp_servers, codex + ' mcp_servers');
  const claudeServers = record(claudeConfig.mcpServers === undefined ? {} : claudeConfig.mcpServers, claude + ' mcpServers');
  const hasCodex = alreadyConfigured(codexServers, contactsheet, codex);
  const hasClaude = alreadyConfigured(claudeServers, contactsheet, claude);
  const separator = toml.length && !toml.endsWith('\n') ? '\n\n' : toml.length ? '\n' : '';
  const updatedToml = toml + separator + '[mcp_servers.contactsheet]\n' + stringify(contactsheet).trimEnd() + '\n';
  if (!hasCodex) {
    try {
      parse(updatedToml.replace(/^\uFEFF/, ''), { integersAsBigInt: 'asNeeded' });
    } catch {
      // shortcut: preserve inline TOML tables as written until a source-preserving editor can expand them.
      throw new Error('Cannot extend the MCP table in ' + codex + '. Use a standard [mcp_servers] table.');
    }
  }
  const updatedJson = JSON.stringify({
    ...claudeConfig, mcpServers: { ...claudeServers, contactsheet: { type: 'stdio', ...contactsheet } },
  }, null, 2) + '\n';
  const files = [
    { path: codex, before: oldCodex, text: hasCodex ? undefined : updatedToml },
    { path: claude, before: oldClaude, text: hasClaude ? undefined : updatedJson },
  ];

  if (!hasCodex || !hasClaude) {
    mkdirSync(codexDir, { recursive: true, mode: 0o700 });
    const lock = join(codexDir, '.contactsheet-setup.lock');
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('Setup is locked at ' + lock + '. If no setup is running, remove the lock and retry.');
    }
    const staged: string[] = [];
    try {
      const writes = files.flatMap(({ path, before, text }) => {
        if (text === undefined) return [];
        const tempDir = mkdtempSync(join(dirname(path), '.contactsheet-setup-'));
        staged.push(tempDir);
        const temp = join(tempDir, 'config');
        writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
        if (before) chmodSync(temp, before.mode);
        return [{ path, before, temp }];
      });
      for (const { path, before } of files) {
        if (!isDeepStrictEqual(readConfig(path), before)) {
          throw new Error('Configuration changed during setup at ' + path + '. Retry setup.');
        }
      }
      for (const { path, before, temp } of writes) {
        if (before) renameSync(temp, path);
        else linkSync(temp, path);
      }
    } finally {
      for (const tempDir of staged) rmSync(tempDir, { recursive: true, force: true });
      rmSync(lock, { force: true });
    }
  }
  return {
    archive,
    codex: { config: codex, status: hasCodex ? 'already-configured' : 'configured' },
    claude: { config: claude, status: hasClaude ? 'already-configured' : 'configured' },
  };
}
